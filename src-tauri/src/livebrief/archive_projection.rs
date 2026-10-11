//! Record-local archive presentation. No reducer, clock, telemetry, PTY or DB.
use std::collections::HashMap;
use serde_json::Value;
use super::adapter::{collect_text, extract_target, is_injected_user_text, parse_question, parse_timestamp};
use super::archive_scan::STRUCTURED_BYTES;
use super::sha256_hex;

#[derive(Clone, Debug)]
pub struct Draft {
    pub slot: u32,
    pub kind: &'static str,
    pub text: String,
    pub timestamp: Option<i64>,
    pub call_id: Option<String>,
    pub tool: Option<String>,
    pub target: Option<String>,
    pub aliases: Vec<String>,
    pub user_form: Option<bool>,
    pub legacy_index: Option<u32>,
}

/// A lexical admission pass runs BEFORE serde allocates a Value. Conservative
/// limits also bound object/array metadata, not just the raw input or depth.
pub fn bounded_value(raw: &[u8]) -> Result<Value, &'static str> {
    if raw.len() > STRUCTURED_BYTES { return Err("oversizedRecord"); }
    let mut depth = 0usize; let mut tokens = 0usize;
    let mut quoted = false; let mut escape = false;
    let mut elements = [0usize; 64];
    for byte in raw {
        if quoted {
            if escape { escape = false; } else if *byte == b'\\' { escape = true; } else if *byte == b'"' { quoted = false; }
            continue;
        }
        match byte {
            b'"' => { quoted = true; tokens += 1; }
            b'{' | b'[' => {
                if depth == 64 { return Err("complexRecord"); }
                elements[depth] = 0; depth += 1; tokens += 1;
            }
            b'}' | b']' => { depth = depth.saturating_sub(1); }
            b',' => {
                tokens += 1;
                if depth > 0 { elements[depth - 1] += 1; if elements[depth - 1] >= 4096 { return Err("complexRecord"); } }
            }
            _ => {}
        }
        if tokens > 32768 { return Err("complexRecord"); }
    }
    serde_json::from_slice(raw).map_err(|_| "invalidRecord")
}

pub fn check_identity(kind: &str, id: &str, value: &Value) -> Result<(), String> {
    if kind == "codex" {
        if value["type"] == "session_meta" && value["payload"]["id"].as_str() != Some(id) { return Err("identityMismatch".into()); }
    } else if value["isSidechain"] != true {
        for key in ["sessionId", "session_id"] {
            if value.get(key).is_some_and(|v| v.as_str() != Some(id)) { return Err("identityMismatch".into()); }
        }
    }
    Ok(())
}

pub fn project(kind: &str, value: &Value) -> Vec<Draft> {
    let mut out = Vec::new();
    let mut legacy_index = Some(0u32);
    if kind != "codex" && value["isSidechain"] == true { return out; }
    let timestamp = value["timestamp"].as_str().and_then(parse_timestamp);
    let native = value["uuid"].as_str().or(value["id"].as_str()).or(value["payload"]["id"].as_str());
    let message = value.get("message").unwrap_or(value);
    let mut push = |slot: u32, kind: &'static str, text: String, call: Option<String>, tool: Option<String>, target: Option<String>, form: Option<bool>| {
        let operational = matches!(kind, "user" | "assistant" | "toolCall" | "toolResult" | "question")
            && !(value["type"] == "assistant" && message["content"].is_string());
        let index = if operational { legacy_index } else { None };
        let mut aliases = native.filter(|id| id.len() <= 256).map(|id| vec![id.to_string()]).unwrap_or_default();
        if let (Some(id), Some(index)) = (native.filter(|id| id.len() <= 240), index) { aliases.push(format!("{id}:{index}")); }
        if operational { legacy_index = if kind == "toolResult" { None } else { legacy_index.map(|n| n+1) }; }
        out.push(Draft { slot, kind, text, timestamp, call_id: call, tool, target, aliases, user_form: form, legacy_index: if native.is_none() { index } else { None } });
    };
    let outer = value["type"].as_str().unwrap_or_default();
    let payload = value.get("payload").unwrap_or(value);
    if kind == "codex" {
        let inner = payload["type"].as_str().unwrap_or_default();
        match (outer, inner) {
            ("event_msg", "user_message") => {
                if let Some(text) = payload["message"].as_str().filter(|s| !s.trim().is_empty()) {
                    push(0, "user", text.to_string(), None, None, None, Some(true));
                }
            }
            ("response_item", "message") => {
                if let Some(text) = collect_text(payload.get("content")) {
                    match payload["role"].as_str() {
                        Some("user") => push(0, "user", text, None, None, None, Some(false)),
                        Some("assistant") => push(0, "assistant", text, None, None, None, None),
                        _ => {}
                    }
                }
            }
            ("response_item", "function_call" | "custom_tool_call") => {
                let tool = payload["name"].as_str().unwrap_or("unknown");
                let raw = payload[if inner == "custom_tool_call" { "input" } else { "arguments" }].as_str().unwrap_or_default();
                let question = matches!(tool, "request_user_input" | "request_permissions");
                let text = if question { question_text(raw) } else { raw.to_string() };
                push(0, if question { "question" } else { "toolCall" }, text, string(payload, "call_id"), Some(tool.into()), bounded_target(raw), None);
            }
            ("response_item", "function_call_output" | "custom_tool_call_output") => {
                push(0, "toolResult", collect_text(payload.get("output")).unwrap_or_default(), string(payload, "call_id"), None, None, None);
            }
            ("session_meta" | "turn_context", _) | ("event_msg", "task_started" | "task_complete" | "turn_aborted" | "token_count" | "agent_message" | "agent_reasoning") => {}
            _ => push(0, "diagnostic", "未対応の記録（元の記録を表示できます）".into(), None, None, None, None),
        }
        return out;
    }
    match outer {
        "user" => {
            let text = if let Some(blocks) = message["content"].as_array() {
                let text = blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n");
                (!text.trim().is_empty()).then_some(text)
            } else { collect_text(message.get("content")) };
            if let Some(text) = text.filter(|s| value["isMeta"] != true && !is_injected_user_text(s)) {
                push(0, "user", text, None, None, None, None);
            }
            if let Some(blocks) = message["content"].as_array() {
                for (index, block) in blocks.iter().enumerate() {
                    if block["type"] == "tool_result" {
                        push(index as u32 + 1, "toolResult", collect_text(block.get("content")).unwrap_or_default(), string(block, "tool_use_id").or_else(|| string(block, "toolUseId")), None, None, None);
                    } else if matches!(block["type"].as_str(), Some("image" | "document")) {
                        push(index as u32 + 1, "attachment", "添付資料（会話記録）".into(), None, None, None, None);
                    }
                }
            }
        }
        "assistant" => {
            if let Some(text) = message["content"].as_str() { push(0, "assistant", text.into(), None, None, None, None); }
            if let Some(blocks) = message["content"].as_array() {
                for (index, block) in blocks.iter().enumerate() {
                    let slot = index as u32 + 1;
                    match block["type"].as_str() {
                        Some("text") => push(slot, "assistant", block["text"].as_str().unwrap_or_default().into(), None, None, None, None),
                        Some("tool_use") => {
                            let tool = block["name"].as_str().unwrap_or("unknown");
                            let raw = block.get("input").map(Value::to_string).unwrap_or_default();
                            let question = matches!(tool, "AskUserQuestion" | "ask_user_question");
                            let text = if question { question_text(&raw) } else { raw.clone() };
                            push(slot, if question { "question" } else { "toolCall" }, text, string(block, "id"), Some(tool.into()), bounded_target(&raw), None);
                        }
                        Some("image" | "document") => push(slot, "attachment", "添付資料（会話記録）".into(), None, None, None, None),
                        Some("thinking" | "redacted_thinking") => {}
                        _ => push(slot, "diagnostic", "未対応の内容（元の記録を表示できます）".into(), None, None, None, None),
                    }
                }
            }
        }
        "tool_result" => push(0, "toolResult", collect_text(value.get("content")).unwrap_or_default(), string(value, "tool_use_id").or_else(|| string(value, "toolUseId")), None, None, None),
        "system" if value["subtype"] == "compact_boundary" => push(0, "boundary", "会話の要約・圧縮".into(), None, None, None, None),
        "system" | "progress" | "file-history-snapshot" | "queue-operation" | "summary" => {}
        _ => push(0, "diagnostic", "未対応の記録（元の記録を表示できます）".into(), None, None, None, None),
    }
    out
}
fn string(v: &Value, key: &str) -> Option<String> { v[key].as_str().filter(|s| !s.is_empty()).map(str::to_string) }
fn bounded_target(raw: &str) -> Option<String> {
    if bounded_value(raw.as_bytes()).is_err() { return None; }
    extract_target(raw)
}
fn question_text(raw: &str) -> String {
    // JSON embedded in a string needs its own structural admission before
    // the existing pure helper can allocate a second Value.
    if bounded_value(raw.as_bytes()).is_err() { return raw.to_string(); }
    let (prompt, _, options) = parse_question(raw);
    if options.is_empty() { prompt } else { format!("{}\n{}", prompt, options.iter().map(|o| o.label.as_str()).collect::<Vec<_>>().join("\n")) }
}

pub fn turn_key(turn: &str) -> String { sha256_hex(turn.as_bytes()) }

/// Replay only the SELECTED digests. Each digest needs a signed counter,
/// rather than an unbounded vector of every earlier prompt. Opposite forms
/// consume one unmatched occurrence; resets preserve/clear turns exactly as
/// the operational adapter does. This state can resume at any LF boundary.
#[derive(Default, Clone)]
pub struct PairContext {
    pub turn: Option<String>,
    pub counts: HashMap<String, i64>,
}
impl PairContext {
    pub fn selected(digests: impl Iterator<Item = String>) -> Self {
        Self { turn: None, counts: digests.map(|d| (d, 0)).collect() }
    }
    pub fn apply(&mut self, value: &Value, users: &[Draft]) -> bool {
        let p = value.get("payload").unwrap_or(value);
        let outer = value["type"].as_str().unwrap_or_default(); let inner = p["type"].as_str().unwrap_or_default();
        let user = (outer == "event_msg" && inner == "user_message") || (outer == "response_item" && inner == "message" && p["role"] == "user");
        let turn = p["turn_id"].as_str().or(value["turn_id"].as_str()).filter(|s| !s.is_empty()).map(turn_key);
        if outer == "turn_context" || (outer == "event_msg" && inner == "task_started") || (user && turn.is_some()) {
            if self.turn != turn || turn.is_none() { self.reset(); self.turn = turn; }
        } else if !user && ((outer == "response_item" && matches!(inner, "message" | "function_call" | "custom_tool_call")) || (outer == "event_msg" && inner == "agent_message")) {
            self.reset();
        }
        if outer == "event_msg" && matches!(inner, "task_complete" | "turn_aborted") { self.reset(); self.turn = None; }
        let Some(draft) = users.iter().find(|d| d.user_form.is_some()) else { return false; };
        if self.turn.is_none() { return false; }
        let Some(count) = self.counts.get_mut(&sha256_hex(draft.text.as_bytes())) else { return false; };
        let sign = if draft.user_form == Some(true) { 1 } else { -1 };
        let paired = *count != 0 && count.signum() != sign;
        *count = count.saturating_add(sign);
        paired
    }
    fn reset(&mut self) { for count in self.counts.values_mut() { *count = 0; } }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn structural_slots_repeat_native_ids_and_standalone_results_are_preserved() {
        let v = json!({"type":"assistant","uuid":"same","message":{"content":[{"type":"thinking"},{"type":"text","text":"hello"},{"type":"tool_use","name":"Read","input":{}}]}});
        let rows = project("claude", &v); assert_eq!(rows.iter().map(|r| r.slot).collect::<Vec<_>>(), vec![2,3]);
        assert_eq!(project("claude", &v).len(), 2); assert!(rows[0].timestamp.is_none());
        let result = project("claude", &json!({"type":"tool_result","content":"FULL output"}));
        assert_eq!(result[0].kind, "toolResult"); assert_eq!(result[0].call_id, None);
    }
    #[test]
    fn foreign_identity_is_never_a_fallback_and_sidechains_are_excluded() {
        assert!(check_identity("claude", "a", &json!({"sessionId":"b"})).is_err());
        assert!(check_identity("codex", "a", &json!({"type":"session_meta","payload":{"id":"b","session_id":"a"}})).is_err());
        assert!(project("claude", &json!({"type":"assistant","isSidechain":true,"message":{"content":"hidden"}})).is_empty());
        assert!(project("claude", &json!({"type":"user","message":{"content":"<system-reminder> hidden"}})).is_empty());
    }
    #[test]
    fn mirror_pairs_are_once_per_proven_turn_and_work_resets_only_pairs() {
        let digest = sha256_hex(b"repeat"); let mut context = PairContext::selected([digest].into_iter());
        let event = json!({"type":"event_msg","payload":{"type":"user_message","message":"repeat"}});
        let response = json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"repeat"}]}});
        assert!(!context.apply(&event, &project("codex", &event)));
        assert!(!context.apply(&response, &project("codex", &response)));
        context.apply(&json!({"type":"turn_context","payload":{"turn_id":"t"}}), &[]);
        assert!(!context.apply(&event, &project("codex", &event))); assert!(!context.apply(&event, &project("codex", &event)));
        assert!(context.apply(&response, &project("codex", &response))); assert!(context.apply(&response, &project("codex", &response)));
        context.apply(&json!({"type":"event_msg","payload":{"type":"agent_message"}}), &[]);
        assert_eq!(context.turn, Some(turn_key("t")));
        assert!(!context.apply(&response, &project("codex", &response)));
        assert!(context.apply(&event, &project("codex", &event)));
    }
    #[test]
    fn parser_limits_precede_value_allocation() {
        assert_eq!(bounded_value(&vec![b'x'; STRUCTURED_BYTES+1]).unwrap_err(), "oversizedRecord");
        assert_eq!(bounded_value(format!("{}0{}", "[".repeat(65), "]".repeat(65)).as_bytes()).unwrap_err(), "complexRecord");
        assert_eq!(bounded_value(format!("[{}]", vec!["0"; 4097].join(",")).as_bytes()).unwrap_err(), "complexRecord");
    }
    #[test]
    fn attachment_slots_do_not_shift_proven_legacy_event_aliases() {
        let rows=project("claude",&json!({"type":"assistant","uuid":"native","message":{"content":[{"type":"image"},{"type":"text","text":"answer"},{"type":"tool_use","name":"Read","input":{}}]}}));
        assert_eq!(rows[1].aliases,vec!["native","native:0"]);assert_eq!(rows[2].aliases,vec!["native","native:1"]);
        assert_eq!(rows[0].aliases,vec!["native"]);
        let rows=project("claude",&json!({"type":"user","uuid":"native","message":{"content":[{"type":"tool_result","content":"first"},{"type":"tool_result","content":"second"}]}}));
        assert_eq!(rows[0].aliases,vec!["native","native:0"]);assert_eq!(rows[1].aliases,vec!["native"]);
    }

    #[test]
    fn json_arguments_inside_strings_cannot_bypass_structural_admission() {
        let raw=format!("[{}]",vec!["0";4097].join(","));
        assert!(bounded_target(&raw).is_none());assert_eq!(question_text(&raw),raw);
        let v=json!({"type":"response_item","payload":{"type":"function_call","name":"request_user_input","arguments":raw}});
        assert!(bounded_value(v.to_string().as_bytes()).is_ok());
        let rows=project("codex",&v);assert_eq!(rows[0].text,raw);assert_eq!(rows[0].kind,"question");
        assert_eq!(bounded_target(r#"{"file_path":"/synthetic"}"#),Some("/synthetic".into()));
    }

}
