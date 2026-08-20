//! Parser for Grok Build ACP updates (`~/.grok/sessions/**/updates.jsonl`).
//!
//! `updates.jsonl` is the canonical Grok source for the usage index: it carries
//! the session id, streamed user/assistant updates, tool lifecycle, and the
//! completed-turn usage ledger. Sibling `events.jsonl` and rewind telemetry are
//! intentionally not parsed here.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::ailog::{
    metrics, parse_ts, truncate_chars, ChunkData, ResultRow, SessionChunk, ToolRow, TurnRow,
    KIND_GROK, ORIGIN_UNKNOWN,
};

/// Grok's embedded headless schema documents exact integer ticks as
/// `1 USD = 10^10 ticks`.
pub const GROK_USD_PER_TICK: f64 = 1e-10;

const FIRST_PROMPT_CHARS: usize = 300;
const AILOG_SUMMARIZER_MARKER: &str = "[mycmux-ailog-summarizer]";
const NEXT_ACTION_MARKER: &str = "[mycmux-next-action]";

/// Parse a run of complete Grok `updates.jsonl` records.
pub fn parse_chunk(text: &str, fallback_session: &str) -> ChunkData {
    let mut data = ChunkData::default();
    let mut current_model: HashMap<String, String> = HashMap::new();
    let mut active_prompt: HashMap<String, String> = HashMap::new();
    let mut pending_tool_calls: HashMap<String, i64> = HashMap::new();
    let mut call_names: HashMap<String, String> = HashMap::new();
    let mut seen_tool_results: HashSet<String> = HashSet::new();
    let mut pending_users: HashMap<(String, String), (i64, String)> = HashMap::new();

    for (line_index, line) in text.lines().enumerate() {
        let line_no = line_index as u64 + 1;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => {
                data.parse_errors += 1;
                continue;
            }
        };
        data.lines += 1;

        let params = value.get("params").unwrap_or(&Value::Null);
        let update = params.get("update").unwrap_or(&Value::Null);
        let update_type = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or("");
        let session_id = params
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or(fallback_session)
            .to_string();
        let ts = event_timestamp(&value);
        let session = data
            .sessions
            .entry(session_id.clone())
            .or_insert_with(|| SessionChunk::new(KIND_GROK, session_id.clone()));
        session.stamp(ts);
        session.entrypoint = Some("grok".to_string());
        if session.origin != crate::ailog::ORIGIN_AILOG_INTERNAL {
            session.origin = ORIGIN_UNKNOWN.to_string();
        }

        let update_meta = update.get("_meta").unwrap_or(&Value::Null);
        let outer_meta = params.get("_meta").unwrap_or(&Value::Null);
        if let Some(model) = update_meta
            .get("modelId")
            .and_then(Value::as_str)
            .filter(|model| !model.trim().is_empty())
        {
            current_model.insert(session_id.clone(), model.to_string());
        }

        let explicit_prompt = prompt_id(update, update_meta, outer_meta);
        if let Some(prompt) = explicit_prompt.clone() {
            active_prompt.insert(session_id.clone(), prompt);
        }

        match update_type {
            "user_message_chunk" => {
                let key = explicit_prompt
                    .or_else(|| prompt_index_key(update_meta))
                    .unwrap_or_else(|| format!("line:{line_no}"));
                let text = update
                    .get("content")
                    .and_then(|content| content.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let entry = pending_users
                    .entry((session_id.clone(), key))
                    .or_insert_with(|| (ts, String::new()));
                entry.0 = entry.0.min(ts);
                entry.1.push_str(text);
                session.ends_on_tool = false;
            }
            "agent_message_chunk" => {
                session.ends_on_tool = false;
            }
            "tool_call" => {
                handle_tool_call(
                    session,
                    update,
                    ts,
                    active_prompt.get(&session_id).map(String::as_str),
                    &mut call_names,
                    &mut pending_tool_calls,
                );
            }
            "tool_call_update" => {
                handle_tool_update(session, update, ts, &mut call_names, &mut seen_tool_results);
            }
            "turn_completed" => {
                let turn_key = explicit_prompt
                    .or_else(|| active_prompt.get(&session_id).cloned())
                    .unwrap_or_else(|| format!("turn:{ts}:{}", session.turn_count_hint));
                handle_turn_completed(
                    session,
                    update,
                    ts,
                    turn_key,
                    current_model.get(&session_id).map(String::as_str),
                    &mut pending_tool_calls,
                );
            }
            _ => {}
        }
    }

    // User text is assembled before counting. Grok streams chunks of one user
    // message separately, and counting each chunk would inflate rework metrics.
    let mut users_by_session: HashMap<String, Vec<(i64, String)>> = HashMap::new();
    for ((session_id, _key), (ts, text)) in pending_users {
        users_by_session
            .entry(session_id)
            .or_default()
            .push((ts, text));
    }
    for (session_id, mut users) in users_by_session {
        users.sort_by_key(|(ts, _)| *ts);
        if let Some(session) = data.sessions.get_mut(&session_id) {
            for (_, text) in users {
                record_user_text(session, &text);
            }
        }
    }

    data
}

fn handle_turn_completed(
    session: &mut SessionChunk,
    update: &Value,
    ts: i64,
    turn_key: String,
    fallback_model: Option<&str>,
    pending_tool_calls: &mut HashMap<String, i64>,
) {
    let usage = update.get("usage").unwrap_or(&Value::Null);
    let model_usage = usage.get("modelUsage").unwrap_or(&Value::Null);
    let model = first_object_key(model_usage)
        .map(str::to_string)
        .or_else(|| fallback_model.map(str::to_string));
    let reported_cost_usd = usage
        .get("costUsdTicks")
        .and_then(number)
        .or_else(|| {
            first_object_value(model_usage)
                .and_then(|value| value.get("costUsdTicks"))
                .and_then(number)
        })
        .map(|ticks| ticks as f64 * GROK_USD_PER_TICK);
    let input_total = number_field(usage, "inputTokens");
    let cached = number_field(usage, "cachedReadTokens");
    let turn = TurnRow {
        dedup_key: turn_key,
        ts,
        model,
        effort: None,
        service_tier: None,
        input_tokens: (input_total - cached).max(0),
        output_tokens: number_field(usage, "outputTokens"),
        cache_read_tokens: cached,
        cache_write_5m_tokens: number_field(usage, "cacheCreationTokens"),
        cache_write_1h_tokens: 0,
        reasoning_tokens: number_field(usage, "reasoningTokens"),
        reported_cost_usd,
        duration_ms: number_field(usage, "apiDurationMs").checked_into_option(),
        tool_calls: pending_tool_calls.remove(&session.session_id).unwrap_or(0),
        tool_errors: 0,
    };
    session.turns.push(turn);
    session.turn_count_hint += 1;
    session.ends_on_tool = false;
}

fn handle_tool_call(
    session: &mut SessionChunk,
    update: &Value,
    ts: i64,
    prompt: Option<&str>,
    call_names: &mut HashMap<String, String>,
    pending_tool_calls: &mut HashMap<String, i64>,
) {
    let Some(call_id) = update.get("toolCallId").and_then(Value::as_str) else {
        return;
    };
    if call_names.contains_key(call_id) {
        return;
    }
    let raw_input = update.get("rawInput").unwrap_or(&Value::Null);
    let name = tool_name(update, raw_input);
    let target = tool_target(raw_input);
    call_names.insert(call_id.to_string(), name.clone());
    if let Some(target) = target.as_deref() {
        record_tool_side_effects(session, &name, target, ts, raw_input);
    }
    session.tools.push(ToolRow {
        call_id: Some(call_id.to_string()),
        ts,
        name,
        is_error: false,
        target,
        turn_key: prompt.map(str::to_string),
    });
    *pending_tool_calls
        .entry(session.session_id.clone())
        .or_insert(0) += 1;
    session.ends_on_tool = true;
}

fn handle_tool_update(
    session: &mut SessionChunk,
    update: &Value,
    ts: i64,
    call_names: &mut HashMap<String, String>,
    seen_tool_results: &mut HashSet<String>,
) {
    let Some(call_id) = update.get("toolCallId").and_then(Value::as_str) else {
        return;
    };
    let raw_output = update.get("rawOutput").unwrap_or(&Value::Null);
    if let Some(name) = raw_output
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
    {
        let name = name.trim().to_string();
        call_names.insert(call_id.to_string(), name.clone());
        if let Some(tool) = session
            .tools
            .iter_mut()
            .rev()
            .find(|tool| tool.call_id.as_deref() == Some(call_id))
        {
            tool.name = name;
            if tool.target.is_none() {
                tool.target = tool_target(raw_output);
            }
        }
    }

    let status = update.get("status").and_then(Value::as_str).unwrap_or("");
    let terminal = matches!(status, "completed" | "failed" | "error" | "cancelled");
    if !terminal || !seen_tool_results.insert(call_id.to_string()) {
        return;
    }
    let is_error = matches!(status, "failed" | "error" | "cancelled")
        || raw_output
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || raw_output.get("error").is_some();
    session.results.push(ResultRow {
        call_id: call_id.to_string(),
        ts,
        is_error,
        chars: value_chars(raw_output),
        name: call_names.get(call_id).cloned(),
    });
    session.ends_on_tool = false;
}

fn record_tool_side_effects(
    session: &mut SessionChunk,
    name: &str,
    target: &str,
    ts: i64,
    input: &Value,
) {
    match metrics::classify_tool(name) {
        metrics::ToolClass::Read => session.touch_file(target, ts, 0, 1),
        metrics::ToolClass::Edit => {
            session.touch_file(target, ts, 1, 0);
            session.write_chars += value_chars(input);
        }
        _ => {}
    }
}

fn record_user_text(session: &mut SessionChunk, text: &str) {
    let trimmed = text.trim();
    if trimmed.is_empty() || is_internal_marker(trimmed) {
        if is_internal_marker(trimmed) {
            session.origin = crate::ailog::ORIGIN_AILOG_INTERNAL.to_string();
        }
        return;
    }
    session.user_msg_count += 1;
    session.prompt_chars += trimmed.chars().count() as i64;
    if session.first_prompt.is_none() {
        session.first_prompt = Some(truncate_chars(trimmed, FIRST_PROMPT_CHARS));
    }
    if metrics::is_correction(trimmed) {
        session.correction_hits += 1;
    }
}

fn is_internal_marker(text: &str) -> bool {
    text.starts_with(AILOG_SUMMARIZER_MARKER) || text.starts_with(NEXT_ACTION_MARKER)
}

fn event_timestamp(value: &Value) -> i64 {
    if let Some(seconds) = value.get("timestamp").and_then(number) {
        return seconds.saturating_mul(1000);
    }
    value
        .get("params")
        .and_then(|params| params.get("_meta"))
        .and_then(|meta| meta.get("agentTimestampMs"))
        .and_then(number)
        .or_else(|| parse_ts(value.get("timestamp").and_then(Value::as_str)))
        .unwrap_or(0)
}

fn prompt_id(update: &Value, update_meta: &Value, outer_meta: &Value) -> Option<String> {
    ["prompt_id", "promptId"]
        .iter()
        .find_map(|key| update.get(key).and_then(Value::as_str))
        .or_else(|| {
            ["promptId", "prompt_id"]
                .iter()
                .find_map(|key| update_meta.get(key).and_then(Value::as_str))
        })
        .or_else(|| {
            ["promptId", "prompt_id"]
                .iter()
                .find_map(|key| outer_meta.get(key).and_then(Value::as_str))
        })
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn prompt_index_key(meta: &Value) -> Option<String> {
    meta.get("promptIndex")
        .and_then(|value| {
            value
                .as_i64()
                .map(|index| index.to_string())
                .or_else(|| value.as_str().map(str::to_string))
        })
        .map(|index| format!("prompt-index:{index}"))
}

fn tool_name(update: &Value, raw_input: &Value) -> String {
    update
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .map(|name| name.trim_end_matches(':').trim().to_string())
        .filter(|name| !name.is_empty())
        .or_else(|| {
            raw_input
                .get("variant")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "unknown".to_string())
}

fn tool_target(value: &Value) -> Option<String> {
    for key in ["file_path", "path", "command", "query", "url", "input"] {
        if let Some(text) = value.get(key).and_then(Value::as_str) {
            return Some(truncate_chars(text, 200));
        }
    }
    None
}

fn value_chars(value: &Value) -> i64 {
    let text = value
        .get("output")
        .or_else(|| value.get("content"))
        .or_else(|| value.get("result"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| serde_json::to_string(value).ok())
        .unwrap_or_default();
    text.chars().count() as i64
}

fn first_object_key(value: &Value) -> Option<&str> {
    value.as_object()?.keys().next().map(String::as_str)
}

fn first_object_value(value: &Value) -> Option<&Value> {
    value.as_object()?.values().next()
}

fn number_field(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(number).unwrap_or(0)
}

fn number(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
}

trait CheckedIntoOption {
    fn checked_into_option(self) -> Option<i64>;
}

impl CheckedIntoOption for i64 {
    fn checked_into_option(self) -> Option<i64> {
        (self > 0).then_some(self)
    }
}
