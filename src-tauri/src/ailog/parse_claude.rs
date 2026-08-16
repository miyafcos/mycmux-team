//! Parser for Claude Code transcripts (`~/.claude/projects/<key>/<uuid>.jsonl`).
//!
//! Two properties of the format drive the design:
//!
//! 1. **A logical turn spans several lines.** Streaming splits one API request
//!    across multiple `assistant` records that share a `requestId` and repeat
//!    the *same* `usage` object while carrying different content blocks
//!    (`thinking`, then `tool_use`, then `text`). Token totals must therefore
//!    be taken once per `requestId`, while tool calls must be collected from
//!    every line in the group.
//! 2. **`usage.iterations[]` mirrors the top level.** It is a per-attempt
//!    breakdown of the same request, so adding it to the top-level counters
//!    double counts. Only the top level is read.
//!
//! The project directory name is a lossy slug of the cwd (every non
//! alphanumeric byte becomes `-`, so Japanese paths collapse entirely). The
//! `cwd` field inside the records is the only reliable source.

use std::collections::HashMap;

use serde_json::Value;

use crate::ailog::{
    metrics, parse_ts, truncate_chars, ChunkData, ResultRow, SessionChunk, ToolRow, TurnRow,
    KIND_CLAUDE, ORIGIN_AILOG_INTERNAL, ORIGIN_OTHER, ORIGIN_UNKNOWN,
};

const FIRST_PROMPT_CHARS: usize = 300;
const AILOG_SUMMARIZER_MARKER: &str = "[mycmux-ailog-summarizer]";

/// Parse a run of complete JSONL lines.
///
/// `fallback_session` is used when a record omits its session id (rare, but
/// the file stem is authoritative for these transcripts).
pub fn parse_chunk(text: &str, fallback_session: &str) -> ChunkData {
    let mut data = ChunkData::default();
    // (session_id, dedup key) -> index into that session's `turns`.
    let mut turn_index: HashMap<(String, String), usize> = HashMap::new();
    // tool_use_id -> tool name, so a later tool_result can be classified.
    let mut call_names: HashMap<String, String> = HashMap::new();
    let mut line_no: u64 = 0;

    for line in text.lines() {
        line_no += 1;
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

        let session_id = value
            .get("sessionId")
            .and_then(Value::as_str)
            .or_else(|| value.get("session_id").and_then(Value::as_str))
            .unwrap_or(fallback_session)
            .to_string();

        let session = data
            .sessions
            .entry(session_id.clone())
            .or_insert_with(|| SessionChunk::new(KIND_CLAUDE, session_id.clone()));

        apply_common_meta(session, &value);
        let ts = parse_ts(value.get("timestamp").and_then(Value::as_str)).unwrap_or(0);
        session.stamp(ts);

        match value.get("type").and_then(Value::as_str).unwrap_or("") {
            "assistant" => handle_assistant(
                session,
                &value,
                ts,
                line_no,
                &session_id,
                &mut turn_index,
                &mut call_names,
            ),
            "user" => handle_user(session, &value, ts, &call_names),
            "system" => handle_system(session, &value, &session_id, &mut turn_index),
            "ai-title" => {
                if let Some(title) = value.get("aiTitle").and_then(Value::as_str) {
                    if !title.trim().is_empty() {
                        session.ai_title = Some(title.trim().to_string());
                    }
                }
            }
            "agent-name" => {
                // Real records use `agentName`; `name` is accepted as a
                // defensive fallback in case the key is ever renamed.
                let name = value
                    .get("agentName")
                    .and_then(Value::as_str)
                    .or_else(|| value.get("name").and_then(Value::as_str));
                if let Some(name) = name {
                    let name = name.trim().to_string();
                    if !name.is_empty() && !session.agent_names.contains(&name) {
                        session.agent_names.push(name);
                    }
                }
            }
            "file-history-delta" => {
                // Registered so the path is visible, but with a zero count:
                // the authoritative edit signal is the Edit/Write tool call,
                // and counting both would inflate churn.
                if let Some(path) = value.get("trackingPath").and_then(Value::as_str) {
                    let ts = parse_ts(value.get("timestamp").and_then(Value::as_str)).unwrap_or(ts);
                    session.touch_file(path, ts, 0, 0);
                }
            }
            _ => {}
        }
    }

    data
}

fn apply_common_meta(session: &mut SessionChunk, value: &Value) {
    if session.cwd.is_none() {
        if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
            session.cwd = Some(cwd.to_string());
        }
    }
    if let Some(branch) = value.get("gitBranch").and_then(Value::as_str) {
        if !branch.is_empty() {
            session.git_branch = Some(branch.to_string());
        }
    }
    if session.slug.is_none() {
        if let Some(slug) = value.get("slug").and_then(Value::as_str) {
            session.slug = Some(slug.to_string());
        }
    }
    if let Some(version) = value.get("version").and_then(Value::as_str) {
        session.cli_version = Some(version.to_string());
    }
    if let Some(entrypoint) = value.get("entrypoint").and_then(Value::as_str) {
        session.entrypoint = Some(entrypoint.to_string());
        // `MYCMUX_*` never reaches the transcript, so a mycmux launch is
        // indistinguishable from a bare terminal. Only a non-CLI entrypoint
        // proves the session ran somewhere else.
        if session.origin != ORIGIN_AILOG_INTERNAL {
            session.origin = if entrypoint == "cli" {
                ORIGIN_UNKNOWN.to_string()
            } else {
                ORIGIN_OTHER.to_string()
            };
        }
    }
    if value
        .get("isSidechain")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        session.is_sidechain = true;
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_assistant(
    session: &mut SessionChunk,
    value: &Value,
    ts: i64,
    line_no: u64,
    session_id: &str,
    turn_index: &mut HashMap<(String, String), usize>,
    call_names: &mut HashMap<String, String>,
) {
    let message = value.get("message").cloned().unwrap_or(Value::Null);
    let dedup_key = value
        .get("requestId")
        .and_then(Value::as_str)
        .or_else(|| message.get("id").and_then(Value::as_str))
        .or_else(|| value.get("uuid").and_then(Value::as_str))
        .map(str::to_string)
        .unwrap_or_else(|| format!("line:{line_no}"));

    let key = (session_id.to_string(), dedup_key.clone());
    let index = match turn_index.get(&key) {
        Some(index) => *index,
        None => {
            let usage = message.get("usage").cloned().unwrap_or(Value::Null);
            let (write_5m, write_1h) = cache_creation_split(&usage);
            let turn = TurnRow {
                dedup_key: dedup_key.clone(),
                ts,
                model: message
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                effort: value
                    .get("effort")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                service_tier: usage
                    .get("service_tier")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                input_tokens: num(&usage, "input_tokens"),
                output_tokens: num(&usage, "output_tokens"),
                cache_read_tokens: num(&usage, "cache_read_input_tokens"),
                cache_write_5m_tokens: write_5m,
                cache_write_1h_tokens: write_1h,
                // Claude bills thinking inside `output_tokens` and does not
                // report it separately, so this stays zero rather than being
                // guessed from the thinking block length.
                reasoning_tokens: 0,
                reported_cost_usd: None,
                duration_ms: None,
                tool_calls: 0,
                tool_errors: 0,
            };
            session.turns.push(turn);
            let index = session.turns.len() - 1;
            turn_index.insert(key, index);
            index
        }
    };

    let mut saw_tool = false;
    if let Some(blocks) = message.get("content").and_then(Value::as_array) {
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            saw_tool = true;
            let name = block
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let call_id = block.get("id").and_then(Value::as_str).map(str::to_string);
            let input = block.get("input").cloned().unwrap_or(Value::Null);
            let target = tool_target(&name, &input);

            if let Some(id) = &call_id {
                call_names.insert(id.clone(), name.clone());
            }
            record_tool_side_effects(session, &name, &input, ts);

            session.turns[index].tool_calls += 1;
            session.tools.push(ToolRow {
                call_id,
                ts,
                name,
                is_error: false,
                target,
                turn_key: Some(dedup_key.clone()),
            });
        }
    }
    session.ends_on_tool = saw_tool;
    session.turn_count_hint = session.turns.len() as i64;
}

/// Split Anthropic's cache-write counter into its 5-minute and 1-hour halves.
///
/// The two TTLs are priced differently, so they are stored separately. When
/// the detailed `cache_creation` object is missing, the aggregate lands in the
/// 5-minute column (the cheaper of the two) rather than being split by guess.
fn cache_creation_split(usage: &Value) -> (i64, i64) {
    if let Some(detail) = usage.get("cache_creation") {
        let five = num(detail, "ephemeral_5m_input_tokens");
        let hour = num(detail, "ephemeral_1h_input_tokens");
        if five > 0 || hour > 0 {
            return (five, hour);
        }
    }
    (num(usage, "cache_creation_input_tokens"), 0)
}

fn handle_user(
    session: &mut SessionChunk,
    value: &Value,
    ts: i64,
    call_names: &HashMap<String, String>,
) {
    let Some(message) = value.get("message") else {
        return;
    };
    match message.get("content") {
        Some(Value::String(text)) => record_user_text(session, text),
        Some(Value::Array(blocks)) => {
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            record_user_text(session, text);
                        }
                    }
                    Some("tool_result") => {
                        let call_id = block
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        if call_id.is_empty() {
                            continue;
                        }
                        let is_error = block
                            .get("is_error")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        let chars = content_chars(block.get("content"));
                        session.results.push(ResultRow {
                            name: call_names.get(&call_id).cloned(),
                            call_id,
                            ts,
                            is_error,
                            chars,
                        });
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

fn record_user_text(session: &mut SessionChunk, text: &str) {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return;
    }
    session.user_msg_count += 1;
    session.prompt_chars += trimmed.chars().count() as i64;
    if session.first_prompt.is_none() {
        if trimmed.starts_with(AILOG_SUMMARIZER_MARKER) {
            session.origin = ORIGIN_AILOG_INTERNAL.to_string();
        }
        session.first_prompt = Some(truncate_chars(trimmed, FIRST_PROMPT_CHARS));
    }
    if metrics::is_correction(trimmed) {
        session.correction_hits += 1;
    }
}

fn handle_system(
    session: &mut SessionChunk,
    value: &Value,
    session_id: &str,
    turn_index: &mut HashMap<(String, String), usize>,
) {
    match value.get("subtype").and_then(Value::as_str).unwrap_or("") {
        "turn_duration" => {
            let duration = num(value, "durationMs");
            session.active_ms += duration;
            // `turn_duration` covers a whole user turn, which may contain
            // several API requests. It is attributed to the most recent turn
            // so per-model duration sums still add up to `active_ms`.
            if let Some(last) = session.turns.last_mut() {
                last.duration_ms = Some(last.duration_ms.unwrap_or(0) + duration);
            }
            let _ = (session_id, turn_index);
        }
        "compact_boundary" => session.compact_count += 1,
        _ => {}
    }
}

fn record_tool_side_effects(session: &mut SessionChunk, name: &str, input: &Value, ts: i64) {
    let path = input
        .get("file_path")
        .and_then(Value::as_str)
        .or_else(|| input.get("path").and_then(Value::as_str))
        .or_else(|| input.get("notebook_path").and_then(Value::as_str));

    match metrics::classify_tool(name) {
        metrics::ToolClass::Read => {
            if let Some(path) = path {
                session.touch_file(path, ts, 0, 1);
            }
        }
        metrics::ToolClass::Edit => {
            if let Some(path) = path {
                session.touch_file(path, ts, 1, 0);
            }
            // Written volume is measured on the way in, from the payload we
            // actually sent, rather than from the tool's confirmation text.
            let written = input
                .get("new_string")
                .and_then(Value::as_str)
                .or_else(|| input.get("content").and_then(Value::as_str))
                .or_else(|| input.get("new_source").and_then(Value::as_str));
            if let Some(written) = written {
                session.write_chars += written.chars().count() as i64;
            }
        }
        _ => {}
    }
}

fn tool_target(name: &str, input: &Value) -> Option<String> {
    match metrics::classify_tool(name) {
        metrics::ToolClass::Exec => input
            .get("command")
            .and_then(Value::as_str)
            .and_then(metrics::command_stem),
        metrics::ToolClass::Read | metrics::ToolClass::Edit => input
            .get("file_path")
            .and_then(Value::as_str)
            .or_else(|| input.get("path").and_then(Value::as_str))
            .or_else(|| input.get("pattern").and_then(Value::as_str))
            .map(str::to_string),
        metrics::ToolClass::Fetch => input
            .get("url")
            .and_then(Value::as_str)
            .or_else(|| input.get("query").and_then(Value::as_str))
            .map(|value| truncate_chars(value, 200)),
        _ => None,
    }
}

fn content_chars(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::String(text)) => text.chars().count() as i64,
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.get("text")
                    .and_then(Value::as_str)
                    .map(|text| text.chars().count() as i64)
                    .unwrap_or(0)
            })
            .sum(),
        _ => 0,
    }
}

fn num(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarizer_marker_classifies_the_session_as_internal() {
        let data = parse_chunk(
            r#"{"type":"user","sessionId":"s","entrypoint":"cli","message":{"content":"[mycmux-ailog-summarizer]\nsummary input"}}"#,
            "fallback",
        );
        assert_eq!(data.sessions["s"].origin, ORIGIN_AILOG_INTERNAL);
    }
}
