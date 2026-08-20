//! Parser for Codex rollout transcripts
//! (`~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl`).
//!
//! Three facts about the format matter for correctness:
//!
//! 1. **`total_token_usage` is cumulative, `last_token_usage` is the delta.**
//!    Per-turn rows use `last_token_usage`; summing both would roughly double
//!    the session.
//! 2. **`input_tokens` already contains `cached_input_tokens`.** The invariant
//!    `total_tokens == input_tokens + output_tokens` holds on real records, so
//!    the cached half is subtracted before storing the uncached input — cache
//!    reads are an order of magnitude cheaper and must not be billed at the
//!    full input rate.
//! 3. **`reasoning_output_tokens` is a subset of `output_tokens`.** It is kept
//!    for reporting but never priced separately.
//!
//! The model can change mid-session, so each `token_count` is attributed to
//! the model named by the most recent `turn_context`.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::ailog::{
    metrics, parse_ts, truncate_chars, ChunkData, ResultRow, SessionChunk, ToolRow, TurnRow,
    KIND_CODEX, ORIGIN_AILOG_INTERNAL, ORIGIN_OTHER, ORIGIN_UNKNOWN,
};

const FIRST_PROMPT_CHARS: usize = 300;
const AILOG_SUMMARIZER_MARKER: &str = "[mycmux-ailog-summarizer]";
const NEXT_ACTION_MARKER: &str = "[mycmux-next-action]";

/// Human-readable rollout evidence shared with the summary pipeline.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RolloutMaterial {
    pub user: Vec<String>,
    pub errors: Vec<String>,
    pub assistant_last: Option<String>,
}

pub fn extract_material(text: &str) -> RolloutMaterial {
    parse_rollout(text, "material-only").1
}

/// Leading markers that identify a `role: "user"` record as harness-injected
/// context rather than something the operator typed.
const INJECTED_PREFIXES: &[&str] = &[
    "<recommended_plugins>",
    "<user_instructions>",
    "<environment_context>",
    "<plan_mode>",
    "<system_reminder>",
    "<INSTRUCTIONS>",
    "# Codex CLI",
];

/// Parse a run of complete JSONL lines from one rollout file.
///
/// `fallback_session` should be the rollout id embedded in the file name; it
/// is used until a `session_meta` record supplies the authoritative id.
pub fn parse_chunk(text: &str, fallback_session: &str) -> ChunkData {
    parse_rollout(text, fallback_session).0
}

/// Parse indexing data and summary evidence in one JSONL traversal so both
/// consumers agree on user messages, final assistant text, and errors.
fn parse_rollout(text: &str, fallback_session: &str) -> (ChunkData, RolloutMaterial) {
    let mut data = ChunkData::default();
    let mut session = SessionChunk::new(KIND_CODEX, fallback_session.to_string());
    let mut material = RolloutMaterial::default();

    let mut current_model: Option<String> = None;
    let mut current_effort: Option<String> = None;
    let mut call_names: HashMap<String, String> = HashMap::new();
    let mut turn_starts: HashMap<String, i64> = HashMap::new();
    let mut seen_prompts: HashSet<String> = HashSet::new();
    let mut turn_keys: HashSet<String> = HashSet::new();
    let mut material_users: HashSet<String> = HashSet::new();
    let mut material_errors: HashSet<String> = HashSet::new();

    for line in text.lines() {
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

        let ts = parse_ts(value.get("timestamp").and_then(Value::as_str)).unwrap_or(0);
        session.stamp(ts);
        let payload = value.get("payload").cloned().unwrap_or(Value::Null);
        let outer = value.get("type").and_then(Value::as_str).unwrap_or("");
        let inner = payload.get("type").and_then(Value::as_str).unwrap_or("");

        match (outer, inner) {
            ("session_meta", _) => apply_session_meta(&mut session, &payload),
            ("turn_context", _) => {
                if let Some(model) = payload.get("model").and_then(Value::as_str) {
                    current_model = Some(model.to_string());
                }
                if let Some(effort) = payload.get("effort").and_then(Value::as_str) {
                    current_effort = Some(effort.to_string());
                }
                if session.cwd.is_none() {
                    if let Some(cwd) = payload.get("cwd").and_then(Value::as_str) {
                        session.cwd = Some(cwd.to_string());
                    }
                }
            }
            ("event_msg", "thread_settings_applied") => {
                let settings = payload
                    .get("thread_settings")
                    .cloned()
                    .unwrap_or(Value::Null);
                if current_model.is_none() {
                    current_model = settings
                        .get("model")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
                if current_effort.is_none() {
                    current_effort = settings
                        .get("reasoning_effort")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
            }
            ("event_msg", "token_count") => handle_token_count(
                &mut session,
                &value,
                &payload,
                ts,
                current_model.as_deref(),
                current_effort.as_deref(),
                &mut turn_keys,
            ),
            ("event_msg", "task_started") => {
                if let Some(turn_id) = payload.get("turn_id").and_then(Value::as_str) {
                    turn_starts.insert(turn_id.to_string(), ts);
                }
            }
            ("event_msg", "task_complete") => {
                if let Some(turn_id) = payload.get("turn_id").and_then(Value::as_str) {
                    if let Some(start) = turn_starts.remove(turn_id) {
                        if ts > start {
                            add_duration(&mut session, ts - start);
                        }
                    }
                }
            }
            ("event_msg", "turn_aborted") => {
                let duration = payload
                    .get("duration_ms")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                if duration > 0 {
                    add_duration(&mut session, duration);
                }
                if let Some(turn_id) = payload.get("turn_id").and_then(Value::as_str) {
                    turn_starts.remove(turn_id);
                }
                let reason = payload
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("turn aborted")
                    .trim()
                    .to_string();
                record_material_error(&mut material, &mut material_errors, reason, true);
            }
            ("event_msg", "user_message") => {
                if let Some(message) = payload.get("message").and_then(Value::as_str) {
                    if is_internal_marker(message.trim_start()) {
                        session.origin = ORIGIN_AILOG_INTERNAL.to_string();
                    }
                    record_user_text(&mut session, message, &mut seen_prompts);
                    record_material_user(&mut material, &mut material_users, message);
                }
            }
            ("event_msg", "context_compacted") => session.compact_count += 1,
            ("compacted", _) => session.compact_count += 1,
            ("response_item", "message") => {
                if payload.get("role").and_then(Value::as_str) == Some("user") {
                    let text = collect_text(payload.get("content"));
                    if is_internal_marker(text.trim_start()) {
                        session.origin = ORIGIN_AILOG_INTERNAL.to_string();
                    }
                    record_user_text(&mut session, &text, &mut seen_prompts);
                    record_material_user(&mut material, &mut material_users, &text);
                } else if payload.get("role").and_then(Value::as_str) == Some("assistant") {
                    let text = collect_text(payload.get("content")).trim().to_string();
                    if !text.is_empty() {
                        material.assistant_last = Some(text);
                    }
                }
            }
            ("response_item", "function_call") | ("response_item", "custom_tool_call") => {
                handle_tool_call(&mut session, &payload, ts, inner, &mut call_names);
            }
            ("response_item", "function_call_output")
            | ("response_item", "custom_tool_call_output") => {
                let raw = payload
                    .get("output")
                    .or_else(|| payload.get("content"))
                    .map(|value| collect_text(Some(value)))
                    .unwrap_or_default();
                if payload
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    || raw.to_ascii_lowercase().contains("error")
                {
                    record_material_error(&mut material, &mut material_errors, raw, false);
                }
                handle_tool_output(&mut session, &payload, ts, &call_names);
            }
            ("event_msg", "patch_apply_end") => {
                // The only place Codex reports patch success as a boolean.
                if let (Some(call_id), Some(success)) = (
                    payload.get("call_id").and_then(Value::as_str),
                    payload.get("success").and_then(Value::as_bool),
                ) {
                    if !success {
                        session.results.push(ResultRow {
                            call_id: call_id.to_string(),
                            ts,
                            is_error: true,
                            chars: 0,
                            name: Some("apply_patch".to_string()),
                        });
                    }
                }
            }
            _ => {}
        }
    }

    session.turn_count_hint = session.turns.len() as i64;
    let session_id = session.session_id.clone();
    data.sessions.insert(session_id, session);
    (data, material)
}

fn record_material_user(material: &mut RolloutMaterial, seen: &mut HashSet<String>, text: &str) {
    let text = text.trim().to_string();
    if !text.is_empty() && !is_internal_marker(&text) && seen.insert(text.clone()) {
        material.user.push(text);
    }
}

fn is_internal_marker(text: &str) -> bool {
    text.starts_with(AILOG_SUMMARIZER_MARKER) || text.starts_with(NEXT_ACTION_MARKER)
}

fn record_material_error(
    material: &mut RolloutMaterial,
    seen: &mut HashSet<String>,
    text: String,
    include_empty: bool,
) {
    if (include_empty || !text.is_empty()) && seen.insert(text.clone()) {
        material.errors.push(text);
    }
}

fn apply_session_meta(session: &mut SessionChunk, payload: &Value) {
    // `payload.id` is the rollout's own id and matches the file name;
    // `payload.session_id` names the root thread a subagent belongs to.
    if let Some(id) = payload.get("id").and_then(Value::as_str) {
        session.session_id = id.to_string();
    }
    if let Some(cwd) = payload.get("cwd").and_then(Value::as_str) {
        session.cwd = Some(cwd.to_string());
    }
    if let Some(version) = payload.get("cli_version").and_then(Value::as_str) {
        session.cli_version = Some(version.to_string());
    }
    if let Some(nickname) = payload.get("agent_nickname").and_then(Value::as_str) {
        let nickname = nickname.trim().to_string();
        if !nickname.is_empty() && !session.agent_names.contains(&nickname) {
            session.agent_names.push(nickname);
        }
    }
    if payload.get("thread_source").and_then(Value::as_str) == Some("subagent") {
        session.is_sidechain = true;
    }
    if payload
        .get("source")
        .and_then(Value::get_subagent)
        .unwrap_or(false)
    {
        session.is_sidechain = true;
    }

    let originator = payload.get("originator").and_then(Value::as_str);
    session.entrypoint = originator.map(str::to_string);
    // `source` is either a plain host string ("cli", "vscode") or an object
    // describing a subagent spawn.
    let source_str = payload.get("source").and_then(Value::as_str);
    session.origin = match (originator, source_str) {
        (Some("Claude Code"), _) => ORIGIN_OTHER.to_string(),
        (_, Some("vscode")) => ORIGIN_OTHER.to_string(),
        _ => ORIGIN_UNKNOWN.to_string(),
    };
}

trait SubagentSource {
    fn get_subagent(&self) -> Option<bool>;
}

impl SubagentSource for Value {
    fn get_subagent(&self) -> Option<bool> {
        self.as_object().map(|map| map.contains_key("subagent"))
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_token_count(
    session: &mut SessionChunk,
    value: &Value,
    payload: &Value,
    ts: i64,
    model: Option<&str>,
    effort: Option<&str>,
    turn_keys: &mut HashSet<String>,
) {
    let info = payload.get("info").cloned().unwrap_or(Value::Null);
    let last = info.get("last_token_usage").cloned().unwrap_or(Value::Null);
    let total = info
        .get("total_token_usage")
        .cloned()
        .unwrap_or(Value::Null);
    if last.is_null() {
        return;
    }

    // Content-derived so the key survives an incremental resume: a per-file
    // counter would restart at zero on the next chunk and collide.
    let ordinal = value.get("ordinal").and_then(Value::as_i64).unwrap_or(-1);
    let key = format!("tc:{ordinal}:{ts}:{}", num(&total, "total_tokens"));
    if !turn_keys.insert(key.clone()) {
        return;
    }

    let raw_input = num(&last, "input_tokens");
    let cached = num(&last, "cached_input_tokens");
    let uncached = (raw_input - cached).max(0);

    if let Some(rate_limits) = payload.get("rate_limits") {
        if let Some(plan) = rate_limits.get("plan_type").and_then(Value::as_str) {
            session.plan_type = Some(plan.to_string());
        }
    }

    session.turns.push(TurnRow {
        dedup_key: key,
        ts,
        model: model.map(str::to_string),
        effort: effort.map(str::to_string),
        service_tier: None,
        input_tokens: uncached,
        output_tokens: num(&last, "output_tokens"),
        cache_read_tokens: cached,
        // Codex reports a single cache-write counter with no TTL split; it is
        // stored in the 5-minute column and priced at the input rate.
        cache_write_5m_tokens: num(&last, "cache_write_input_tokens"),
        cache_write_1h_tokens: 0,
        reasoning_tokens: num(&last, "reasoning_output_tokens"),
        reported_cost_usd: None,
        duration_ms: None,
        tool_calls: 0,
        tool_errors: 0,
    });
}

fn add_duration(session: &mut SessionChunk, duration: i64) {
    session.active_ms += duration;
    if let Some(last) = session.turns.last_mut() {
        last.duration_ms = Some(last.duration_ms.unwrap_or(0) + duration);
    }
}

fn handle_tool_call(
    session: &mut SessionChunk,
    payload: &Value,
    ts: i64,
    inner: &str,
    call_names: &mut HashMap<String, String>,
) {
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let call_id = payload
        .get("call_id")
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(id) = &call_id {
        call_names.insert(id.clone(), name.clone());
    }

    // `function_call` carries a JSON string in `arguments`; `custom_tool_call`
    // carries free-form JS in `input` that wraps a `tools.*` call.
    let raw_args = if inner == "custom_tool_call" {
        payload.get("input").and_then(Value::as_str).unwrap_or("")
    } else {
        payload
            .get("arguments")
            .and_then(Value::as_str)
            .unwrap_or("")
    };

    let target = codex_target(&name, raw_args);
    if metrics::classify_tool(&name) == metrics::ToolClass::Edit {
        for path in patch_paths(raw_args) {
            session.touch_file(&path, ts, 1, 0);
        }
        session.write_chars += raw_args.chars().count() as i64;
    }

    if let Some(last) = session.turns.last_mut() {
        last.tool_calls += 1;
    }
    session.tools.push(ToolRow {
        call_id,
        ts,
        name,
        is_error: false,
        target,
        turn_key: session.turns.last().map(|turn| turn.dedup_key.clone()),
    });
    session.ends_on_tool = true;
}

fn handle_tool_output(
    session: &mut SessionChunk,
    payload: &Value,
    ts: i64,
    call_names: &HashMap<String, String>,
) {
    let Some(call_id) = payload.get("call_id").and_then(Value::as_str) else {
        return;
    };
    let text = match payload.get("output") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(_)) => collect_text(payload.get("output")),
        _ => String::new(),
    };
    session.results.push(ResultRow {
        call_id: call_id.to_string(),
        ts,
        is_error: output_is_error(&text),
        chars: text.chars().count() as i64,
        name: call_names.get(call_id).cloned(),
    });
    session.ends_on_tool = false;
}

/// Deterministic failure test for a Codex tool result.
///
/// Codex has no `is_error` flag, so the only mechanical signal is the exit
/// code the shell wrapper prints. Every `Exit code: N` in the output is
/// examined; any non-zero marks the call as failed.
pub fn output_is_error(text: &str) -> bool {
    const MARKER: &str = "Exit code: ";
    let mut rest = text;
    let mut found = false;
    while let Some(pos) = rest.find(MARKER) {
        let after = &rest[pos + MARKER.len()..];
        let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
        if !digits.is_empty() {
            found = true;
            if digits != "0" {
                return true;
            }
        }
        rest = &after[digits.len().min(after.len())..];
    }
    if found {
        return false;
    }
    text.contains("\"success\": false") || text.contains("\"success\":false")
}

fn codex_target(name: &str, raw_args: &str) -> Option<String> {
    match metrics::classify_tool(name) {
        metrics::ToolClass::Exec => {
            extract_field(raw_args, "command").and_then(|cmd| metrics::command_stem(&cmd))
        }
        metrics::ToolClass::Edit => patch_paths(raw_args).into_iter().next(),
        metrics::ToolClass::Fetch => {
            extract_field(raw_args, "query").or_else(|| extract_field(raw_args, "url"))
        }
        _ => None,
    }
}

/// Pull a string field out of either a JSON argument blob or the JS snippet a
/// `custom_tool_call` wraps around it. Both spell the key the same way, so a
/// single scan handles both without a JSON parser that the JS form would fail.
fn extract_field(raw: &str, key: &str) -> Option<String> {
    if let Ok(value) = serde_json::from_str::<Value>(raw) {
        if let Some(found) = value.get(key).and_then(Value::as_str) {
            return Some(found.to_string());
        }
    }
    let quoted = format!("\"{key}\"");
    let start = raw
        .find(&quoted)
        .map(|pos| pos + quoted.len())
        .or_else(|| {
            let bare = format!("{key}:");
            raw.find(&bare).map(|pos| pos + bare.len())
        })?;
    let after = &raw[start..];
    let colon = after.find(':').map(|pos| pos + 1).unwrap_or(0);
    let after = &after[colon.min(after.len())..];
    let open = after.find('"')? + 1;
    let bytes = after.as_bytes();
    let mut index = open;
    let mut out = String::new();
    while index < bytes.len() {
        match bytes[index] {
            b'\\' if index + 1 < bytes.len() => {
                let next = bytes[index + 1];
                out.push(match next {
                    b'n' => '\n',
                    b't' => '\t',
                    other => other as char,
                });
                index += 2;
            }
            b'"' => break,
            other => {
                out.push(other as char);
                index += 1;
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Extract file paths from an `apply_patch` envelope.
fn patch_paths(raw: &str) -> Vec<String> {
    const MARKERS: &[&str] = &["*** Add File: ", "*** Update File: ", "*** Delete File: "];
    let mut paths = Vec::new();
    for line in raw.split("\\n").flat_map(|part| part.split('\n')) {
        for marker in MARKERS {
            if let Some(path) = line.trim().strip_prefix(marker) {
                let path = path.trim().trim_end_matches('"');
                if !path.is_empty() && !paths.contains(&path.to_string()) {
                    paths.push(path.to_string());
                }
            }
        }
    }
    paths
}

fn record_user_text(session: &mut SessionChunk, text: &str, seen: &mut HashSet<String>) {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return;
    }
    if INJECTED_PREFIXES
        .iter()
        .any(|prefix| trimmed.starts_with(prefix))
    {
        return;
    }
    // The same prompt shows up as both an `event_msg/user_message` and a
    // `response_item/message`, so utterances are keyed by content.
    let key = truncate_chars(trimmed, 200);
    if !seen.insert(key) {
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

fn collect_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn num(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_rollout_parse_keeps_index_stats_and_material_in_sync() {
        let (data, material) = parse_rollout(
            concat!(
                "not-json\n",
                r#"{"type":"event_msg","payload":{"type":"user_message","message":"same prompt"}}"#,
                "\n",
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"same prompt"}]}}"#,
            ),
            "fallback",
        );
        let session = data.sessions.get("fallback").expect("session");
        assert_eq!(data.lines, 2);
        assert_eq!(data.parse_errors, 1);
        assert_eq!(session.user_msg_count, 1);
        assert_eq!(material.user, vec!["same prompt"]);
    }

    #[test]
    fn summarizer_marker_classifies_codex_session_as_internal() {
        let data = parse_chunk(
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"[mycmux-ailog-summarizer]\ninput"}}"#,
            "fallback",
        );
        assert_eq!(
            data.sessions.get("fallback").expect("session").origin,
            ORIGIN_AILOG_INTERNAL
        );
    }

    #[test]
    fn response_item_user_marker_classifies_codex_session_as_internal() {
        let data = parse_chunk(
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"[mycmux-ailog-summarizer] input"}]}}"#,
            "fallback",
        );
        assert_eq!(
            data.sessions.get("fallback").expect("session").origin,
            ORIGIN_AILOG_INTERNAL
        );
    }

    #[test]
    fn next_action_event_marker_is_internal_and_excluded_from_material() {
        let (data, material) = parse_rollout(
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"[mycmux-next-action] input"}}"#,
            "fallback",
        );
        assert_eq!(data.sessions["fallback"].origin, ORIGIN_AILOG_INTERNAL);
        assert!(material.user.is_empty());
    }

    #[test]
    fn next_action_response_marker_is_internal_and_excluded_from_material() {
        let (data, material) = parse_rollout(
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"[mycmux-next-action] input"}]}}"#,
            "fallback",
        );
        assert_eq!(data.sessions["fallback"].origin, ORIGIN_AILOG_INTERNAL);
        assert!(material.user.is_empty());
    }
}
