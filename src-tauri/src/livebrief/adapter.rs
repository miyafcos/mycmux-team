use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{sha256_hex, unix_ms};
use super::reducer::{PendingInputKind, PendingOption};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ByteRange { pub start: u64, pub end: u64 }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SemanticEventEnvelope {
    pub event_id: String,
    pub source_revision: u64,
    pub occurred_at: i64,
    pub source_byte_start: u64,
    pub source_byte_end: u64,
    pub kind: SemanticEventKind,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SemanticEventKind {
    UserMessage { kind: UserMessageKind, text: String, digest: String },
    AgentMessage { text: String },
    ToolStart { call_id: String, tool: String, target: Option<String> },
    ToolEnd { call_id: String, tool: String, target: Option<String>, ok: bool, summary: Option<String> },
    Question { prompt_event_id: String, provider_call_id: String, prompt: String, kind: PendingInputKind, options: Vec<PendingOption> },
    QuestionResolved { prompt_event_id: String, provider_call_id: String },
    TestResult { pass: u32, fail: u32 },
    FileChange { path: String, change: String },
    Error { fingerprint: String, text: String },
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UserMessageKind { TaskStart, TaskChange, Correction, Answer, Ack }

pub struct AgentAdapter {
    kind: String,
    open_questions: HashMap<String, String>,
    open_tools: HashMap<String, (String, Option<String>)>,
    seen_native_ids: HashSet<String>,
    seen_operator_message: bool,
}

impl AgentAdapter {
    /// `claude-codex` writes the very same transcript shape as `claude`, so it
    /// is normalised here instead of being threaded through every decoder.
    pub fn new(kind: &str) -> Result<Self, String> {
        let kind = match kind {
            "claude" | "claude-codex" => "claude",
            "codex" => "codex",
            _ => return Err("unsupported agent adapter".to_string()),
        };
        Ok(Self { kind: kind.to_string(), open_questions: HashMap::new(), open_tools: HashMap::new(), seen_native_ids: HashSet::new(), seen_operator_message: false })
    }

    /// Decode one complete JSONL record. Callers must never pass a partial
    /// line; this primitive owns state across record and poll boundaries.
    pub fn decode_record(&mut self, raw_line: &str, byte_range: ByteRange, source_revision: u64) -> Result<Vec<SemanticEventEnvelope>, String> {
        let value: Value = serde_json::from_str(raw_line).map_err(|_| "invalid complete JSONL record".to_string())?;
        let native_id = native_id(&value, byte_range);
        if !self.seen_native_ids.insert(native_id.clone()) { return Ok(Vec::new()); }
        let occurred_at = value.get("timestamp").and_then(Value::as_str).and_then(parse_timestamp).unwrap_or_else(unix_ms);
        let mut kinds = if self.kind == "codex" { self.decode_codex(&value) } else { self.decode_claude(&value) };
        Ok(kinds.drain(..).enumerate().map(|(index, kind)| SemanticEventEnvelope {
            event_id: format!("{native_id}:{index}"), source_revision, occurred_at,
            source_byte_start: byte_range.start, source_byte_end: byte_range.end, kind,
        }).collect())
    }

    fn decode_codex(&mut self, value: &Value) -> Vec<SemanticEventKind> {
        let payload = value.get("payload").unwrap_or(value);
        let outer = value.get("type").and_then(Value::as_str).unwrap_or_default();
        let inner = payload.get("type").and_then(Value::as_str).unwrap_or_default();
        match (outer, inner) {
            ("event_msg", "user_message") => payload.get("message").and_then(Value::as_str).map(|text| self.user_message(text)).into_iter().collect(),
            ("response_item", "message") if payload.get("role").and_then(Value::as_str) == Some("user") => collect_text(payload.get("content")).map(|text| self.user_message(&text)).into_iter().collect(),
            ("response_item", "message") if payload.get("role").and_then(Value::as_str) == Some("assistant") => collect_text(payload.get("content")).map(|text| SemanticEventKind::AgentMessage { text }).into_iter().collect(),
            ("response_item", "function_call") | ("response_item", "custom_tool_call") => self.codex_tool_start(payload, inner),
            ("response_item", "function_call_output") | ("response_item", "custom_tool_call_output") => self.codex_tool_end(payload),
            _ => Vec::new(),
        }
    }

    fn decode_claude(&mut self, value: &Value) -> Vec<SemanticEventKind> {
        // Sub-agent transcripts share the file with the parent conversation.
        // Folding them in would attribute a sub-agent's prompts and tools to
        // the operator, so the whole record is dropped.
        if value.get("isSidechain").and_then(Value::as_bool).unwrap_or(false) { return Vec::new(); }
        let kind = value.get("type").and_then(Value::as_str).unwrap_or_default();
        let message = value.get("message").unwrap_or(value);
        match kind {
            "user" => self.claude_user(value, message),
            "assistant" => self.claude_assistant(message),
            "tool_result" => self.claude_tool_result(value),
            _ => Vec::new(),
        }
    }

    /// Claude records tool results as `tool_result` blocks inside a `user`
    /// record, not as a top-level record, so one record can carry both an
    /// operator message and several tool completions.
    fn claude_user(&mut self, record: &Value, message: &Value) -> Vec<SemanticEventKind> {
        let is_meta = record.get("isMeta").and_then(Value::as_bool).unwrap_or(false);
        let mut out = Vec::new();
        match message.get("content") {
            Some(Value::Array(blocks)) => {
                let text = blocks.iter()
                    .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n");
                if let Some(event) = self.operator_message(&text, is_meta) { out.push(event); }
                for block in blocks {
                    if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                        out.extend(self.claude_tool_result(block));
                    }
                }
            }
            Some(Value::String(text)) => { if let Some(event) = self.operator_message(text, is_meta) { out.push(event); } }
            _ => {}
        }
        out
    }

    /// `None` when the text is not something the operator typed: meta records,
    /// slash-command scaffolding and injected reminders all reach the
    /// transcript as `user` content.
    fn operator_message(&mut self, text: &str, is_meta: bool) -> Option<SemanticEventKind> {
        if is_meta || text.trim().is_empty() || is_injected_user_text(text) { return None; }
        Some(self.user_message(text))
    }

    fn codex_tool_start(&mut self, payload: &Value, inner: &str) -> Vec<SemanticEventKind> {
        let call_id = payload.get("call_id").and_then(Value::as_str).unwrap_or("missing-call-id").to_string();
        let tool = payload.get("name").and_then(Value::as_str).unwrap_or("unknown").to_string();
        let raw = if inner == "custom_tool_call" { payload.get("input").and_then(Value::as_str).unwrap_or("") } else { payload.get("arguments").and_then(Value::as_str).unwrap_or("") };
        let target = extract_target(raw);
        self.open_tools.insert(call_id.clone(), (tool.clone(), target.clone()));
        if matches!(tool.as_str(), "request_user_input" | "request_permissions") {
            let (prompt, kind, options) = parse_question(raw);
            let prompt_event_id = format!("question:{call_id}");
            self.open_questions.insert(call_id.clone(), prompt_event_id.clone());
            vec![SemanticEventKind::Question { prompt_event_id, provider_call_id: call_id, prompt, kind, options }]
        } else {
            vec![SemanticEventKind::ToolStart { call_id, tool, target }]
        }
    }

    fn codex_tool_end(&mut self, payload: &Value) -> Vec<SemanticEventKind> {
        let call_id = payload.get("call_id").and_then(Value::as_str).unwrap_or("missing-call-id").to_string();
        if let Some(prompt_event_id) = self.open_questions.remove(&call_id) {
            return vec![SemanticEventKind::QuestionResolved { prompt_event_id, provider_call_id: call_id }];
        }
        let (tool, target) = self.open_tools.remove(&call_id).unwrap_or_else(|| ("unknown".to_string(), None));
        let output = collect_text(payload.get("output")).unwrap_or_default();
        terminal_events(call_id, tool, target, !has_nonzero_exit_code(&output), &output)
    }

    fn claude_assistant(&mut self, message: &Value) -> Vec<SemanticEventKind> {
        let mut out = Vec::new();
        let contents = message.get("content").and_then(Value::as_array).cloned().unwrap_or_default();
        for part in contents {
            match part.get("type").and_then(Value::as_str) {
                Some("text") => if let Some(text) = part.get("text").and_then(Value::as_str) { out.push(SemanticEventKind::AgentMessage { text: text.to_string() }); },
                Some("tool_use") => {
                    let call_id = part.get("id").and_then(Value::as_str).unwrap_or("missing-call-id").to_string();
                    let tool = part.get("name").and_then(Value::as_str).unwrap_or("unknown").to_string();
                    let raw = part.get("input").map(Value::to_string).unwrap_or_default();
                    let target = extract_target(&raw);
                    self.open_tools.insert(call_id.clone(), (tool.clone(), target.clone()));
                    if matches!(tool.as_str(), "AskUserQuestion" | "ask_user_question") {
                        let (prompt, kind, options) = parse_question(&raw);
                        let prompt_event_id = format!("question:{call_id}");
                        self.open_questions.insert(call_id.clone(), prompt_event_id.clone());
                        out.push(SemanticEventKind::Question { prompt_event_id, provider_call_id: call_id, prompt, kind, options });
                    } else {
                        out.push(SemanticEventKind::ToolStart { call_id, tool, target });
                    }
                }
                _ => {}
            }
        }
        out
    }

    fn claude_tool_result(&mut self, value: &Value) -> Vec<SemanticEventKind> {
        let call_id = value.get("tool_use_id").or_else(|| value.get("toolUseId")).and_then(Value::as_str).unwrap_or("missing-call-id").to_string();
        if let Some(prompt_event_id) = self.open_questions.remove(&call_id) { return vec![SemanticEventKind::QuestionResolved { prompt_event_id, provider_call_id: call_id }]; }
        let (tool, target) = self.open_tools.remove(&call_id).unwrap_or_else(|| ("unknown".to_string(), None));
        let output = collect_text(value.get("content")).unwrap_or_default();
        terminal_events(call_id, tool, target, !value.get("is_error").and_then(Value::as_bool).unwrap_or(false), &output)
    }

    fn user_message(&mut self, text: &str) -> SemanticEventKind {
        let kind = classify_user_message(text, !self.open_questions.is_empty(), self.seen_operator_message);
        self.seen_operator_message = true;
        SemanticEventKind::UserMessage { kind, text: text.trim().to_string(), digest: sha256_hex(normalize(text).as_bytes()) }
    }
}

pub fn classify_user_message(text: &str, has_unresolved_question: bool, seen_operator_message: bool) -> UserMessageKind {
    let normalized = normalize(text);
    if ["違う", "戻して", "やり直し", "違います"].iter().any(|word| normalized.contains(word)) { return UserMessageKind::Correction; }
    if has_unresolved_question { return UserMessageKind::Answer; }
    if normalized.chars().count() < 20 && matches!(normalized.as_str(), "はい" | "ok" | "okay" | "続けて" | "y" | "yes") { return UserMessageKind::Ack; }
    if seen_operator_message { UserMessageKind::TaskChange } else { UserMessageKind::TaskStart }
}

pub fn normalize(text: &str) -> String { text.trim().to_lowercase() }

fn native_id(value: &Value, range: ByteRange) -> String {
    value.get("uuid").or_else(|| value.get("id")).or_else(|| value.pointer("/payload/id")).and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("{}:{}", range.start, range.end))
}

fn collect_text(value: Option<&Value>) -> Option<String> {
    match value? { Value::String(text) if !text.trim().is_empty() => Some(text.to_string()), Value::Array(items) => { let text = items.iter().filter_map(|item| item.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"); (!text.trim().is_empty()).then_some(text) }, Value::Object(map) => map.get("text").and_then(Value::as_str).map(str::to_string), _ => None }
}

fn extract_target(raw: &str) -> Option<String> { serde_json::from_str::<Value>(raw).ok().and_then(|value| value.get("file_path").or_else(|| value.get("path")).or_else(|| value.get("notebook_path")).or_else(|| value.get("command")).or_else(|| value.get("query")).and_then(Value::as_str).map(str::to_string)) }

fn terminal_events(call_id: String, tool: String, target: Option<String>, ok: bool, output: &str) -> Vec<SemanticEventKind> {
    let summary = short(output);
    let mut events = vec![SemanticEventKind::ToolEnd {
        call_id,
        tool: tool.clone(),
        target: target.clone(),
        ok,
        summary: summary.clone(),
    }];
    if ok {
        if let Some((path, change)) = file_change(&tool, target.as_deref()) {
            events.push(SemanticEventKind::FileChange { path, change });
        }
    }
    if is_test_command_tool(&tool) {
        for (pass, fail) in explicit_test_results(output) {
            events.push(SemanticEventKind::TestResult { pass, fail });
        }
    }
    if !ok {
        let detail = clear_error_line(output)
            .map(str::to_string)
            .or(summary)
            .unwrap_or_else(|| "failed".to_string());
        let text = format!("{tool}: {detail}");
        events.push(SemanticEventKind::Error {
            fingerprint: sha256_hex(normalize(&text).as_bytes()),
            text,
        });
    }
    events
}

/// Only tool names observed in the pre-change real-log measurement are
/// admitted. A success does not imply a write for any other tool name.
fn file_change(tool: &str, target: Option<&str>) -> Option<(String, String)> {
    let path = target?.trim();
    if path.is_empty() {
        return None;
    }
    match tool {
        "Edit" => Some((path.to_string(), "modified".to_string())),
        "Write" => Some((path.to_string(), "written".to_string())),
        _ => None,
    }
}

/// Only command runner names observed in the pre-change real-log measurement
/// are considered. TestResult never follows a tool name alone; a recognised
/// explicit result line is also required.
fn is_test_command_tool(tool: &str) -> bool {
    matches!(tool, "Bash" | "PowerShell" | "exec")
}

fn explicit_test_results(output: &str) -> Vec<(u32, u32)> {
    output.lines().filter_map(parse_explicit_test_result).collect()
}

/// Accept only complete summary forms seen in real logs: cargo's `test
/// result`, Vitest's `Tests N passed (N)`, and pytest's `= N passed in ... =`.
fn parse_explicit_test_result(line: &str) -> Option<(u32, u32)> {
    let line = line.trim();
    if let Some(rest) = line.strip_prefix("test result: ") {
        let pass = count_before_marker(rest, " passed;")?;
        let fail = count_before_marker(rest, " failed;").unwrap_or(0);
        return Some((pass, fail));
    }
    if let Some(rest) = line.strip_prefix("Tests") {
        let pass = first_number(rest)?;
        if rest.contains(" passed (") {
            return Some((pass, 0));
        }
    }
    if line.starts_with('=') && line.ends_with('=') && line.contains(" passed in ") {
        let pass = count_before_marker(line, " passed in")?;
        let fail = count_before_marker(line, " failed,").unwrap_or(0);
        return Some((pass, fail));
    }
    None
}

fn count_before_marker(text: &str, marker: &str) -> Option<u32> {
    let prefix = text.split_once(marker)?.0;
    prefix.split_whitespace().last()?.parse::<u32>().ok()
}

fn first_number(text: &str) -> Option<u32> {
    text.split_whitespace().find_map(|word| word.parse::<u32>().ok())
}

fn has_nonzero_exit_code(output: &str) -> bool {
    output.lines().any(|line| {
        line.trim()
            .strip_prefix("Exit code:")
            .and_then(|code| code.trim().parse::<i32>().ok())
            .is_some_and(|code| code != 0)
    })
}

fn clear_error_line(output: &str) -> Option<&str> {
    output.lines().map(str::trim).find(|line| {
        line.starts_with("error:")
            || line.starts_with("error[")
            || line.starts_with("FAILED")
            || line.starts_with("Traceback")
    })
}

fn parse_question(raw: &str) -> (String, PendingInputKind, Vec<PendingOption>) {
    let value = serde_json::from_str::<Value>(raw).unwrap_or(Value::Null);
    let prompt = value.get("question").or_else(|| value.get("prompt")).or_else(|| value.get("message")).and_then(Value::as_str).unwrap_or("Input required").to_string();
    let options: Vec<PendingOption> = value.get("options").and_then(Value::as_array).map(|items| items.iter().enumerate().filter_map(|(index, item)| { let label = item.get("label").or_else(|| item.get("text")).and_then(Value::as_str).or_else(|| item.as_str())?; let payload = item.get("value").or_else(|| item.get("payload")).and_then(Value::as_str).unwrap_or(label); Some(PendingOption::new(format!("option-{index}"), label.to_string(), payload.to_string())) }).collect()).unwrap_or_default();
    let kind = if options.is_empty() { PendingInputKind::FreeText } else { PendingInputKind::Choice };
    (prompt, kind, options)
}

/// Text the CLI injects into the `user` role on the operator's behalf.
const INJECTED_USER_PREFIXES: [&str; 4] = ["<command-name>", "<command-message>", "<local-command-stdout>", "<system-reminder>"];

fn is_injected_user_text(text: &str) -> bool {
    let text = text.trim_start();
    INJECTED_USER_PREFIXES.iter().any(|prefix| text.starts_with(prefix))
}

fn short(text: &str) -> Option<String> { let text = text.trim(); (!text.is_empty()).then(|| text.chars().take(160).collect()) }

fn parse_timestamp(value: &str) -> Option<i64> { chrono::DateTime::parse_from_rfc3339(value).ok().map(|time| time.timestamp_millis()) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn answer_beats_short_ack_when_a_question_is_open() { assert_eq!(classify_user_message("y", true, true), UserMessageKind::Answer); }
    #[test]
    fn correction_beats_answer() { assert_eq!(classify_user_message("違う", true, true), UserMessageKind::Correction); }
    fn decode(adapter: &mut AgentAdapter, line: &str) -> Vec<SemanticEventKind> {
        adapter.decode_record(line, ByteRange { start: 0, end: 1 }, 1).unwrap().into_iter().map(|envelope| envelope.kind).collect()
    }

    #[test]
    fn claude_tool_result_block_inside_a_user_record_ends_the_call() {
        let mut adapter = AgentAdapter::new("claude").unwrap();
        let events = decode(&mut adapter, r#"{"type":"user","uuid":"u1","message":{"role":"user","content":[{"tool_use_id":"toolu_x","type":"tool_result","content":"ok"}]}}"#);
        assert_eq!(events.len(), 1);
        match &events[0] {
            SemanticEventKind::ToolEnd { call_id, ok, summary, .. } => {
                assert_eq!(call_id, "toolu_x");
                assert!(ok);
                assert_eq!(summary.as_deref(), Some("ok"));
            }
            other => panic!("expected a toolEnd, got {other:?}"),
        }
    }

    #[test]
    fn claude_tool_end_inherits_the_tool_and_target_of_its_tool_use() {
        let mut adapter = AgentAdapter::new("claude").unwrap();
        let started = decode(&mut adapter, r#"{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_x","name":"Read","input":{"path":"src/lib.rs"}}]}}"#);
        assert!(matches!(&started[0], SemanticEventKind::ToolStart { tool, .. } if tool == "Read"));
        let ended = decode(&mut adapter, r#"{"type":"user","uuid":"u2","message":{"role":"user","content":[{"tool_use_id":"toolu_x","type":"tool_result","content":[{"type":"text","text":"file body"}]}]}}"#);
        match &ended[0] {
            SemanticEventKind::ToolEnd { tool, target, summary, .. } => {
                assert_eq!(tool, "Read");
                assert_eq!(target.as_deref(), Some("src/lib.rs"));
                assert_eq!(summary.as_deref(), Some("file body"));
            }
            other => panic!("expected a toolEnd, got {other:?}"),
        }
    }

    #[test]
    fn claude_tool_result_error_flag_marks_the_call_failed() {
        let mut adapter = AgentAdapter::new("claude").unwrap();
        let events = decode(&mut adapter, r#"{"type":"user","uuid":"u3","message":{"role":"user","content":[{"tool_use_id":"toolu_y","type":"tool_result","is_error":true,"content":"boom"}]}}"#);
        assert!(matches!(&events[0], SemanticEventKind::ToolEnd { ok: false, .. }));
    }

    #[test]
    fn successful_edit_with_file_path_emits_file_change_after_tool_end() {
        let mut adapter = AgentAdapter::new("claude").unwrap();
        let started = decode(&mut adapter, r#"{"type":"assistant","uuid":"e1","message":{"role":"assistant","content":[{"type":"tool_use","id":"edit-1","name":"Edit","input":{"file_path":"src/live.rs","old_string":"old","new_string":"new"}}]}}"#);
        assert!(matches!(&started[0], SemanticEventKind::ToolStart { target, .. } if target.as_deref() == Some("src/live.rs")));
        let ended = decode(&mut adapter, r#"{"type":"user","uuid":"e2","message":{"role":"user","content":[{"tool_use_id":"edit-1","type":"tool_result","content":"Done"}]}}"#);
        assert!(matches!(&ended[0], SemanticEventKind::ToolEnd { ok: true, .. }));
        assert!(matches!(&ended[1], SemanticEventKind::FileChange { path, change } if path == "src/live.rs" && change == "modified"));
    }

    #[test]
    fn failed_edit_emits_error_but_not_file_change() {
        let mut adapter = AgentAdapter::new("claude").unwrap();
        decode(&mut adapter, r#"{"type":"assistant","uuid":"f1","message":{"role":"assistant","content":[{"type":"tool_use","id":"edit-2","name":"Edit","input":{"file_path":"src/live.rs"}}]}}"#);
        let ended = decode(&mut adapter, r#"{"type":"user","uuid":"f2","message":{"role":"user","content":[{"tool_use_id":"edit-2","type":"tool_result","is_error":true,"content":"permission denied"}]}}"#);
        assert!(matches!(&ended[0], SemanticEventKind::ToolEnd { ok: false, .. }));
        assert!(matches!(&ended[1], SemanticEventKind::Error { text, .. } if text == "Edit: permission denied"));
        assert!(!ended.iter().any(|event| matches!(event, SemanticEventKind::FileChange { .. })));
    }

    #[test]
    fn explicit_cargo_result_emits_test_result_after_tool_end() {
        let mut adapter = AgentAdapter::new("claude").unwrap();
        decode(&mut adapter, r#"{"type":"assistant","uuid":"t1","message":{"role":"assistant","content":[{"type":"tool_use","id":"bash-1","name":"Bash","input":{"command":"cargo test"}}]}}"#);
        let ended = decode(&mut adapter, r#"{"type":"user","uuid":"t2","message":{"role":"user","content":[{"tool_use_id":"bash-1","type":"tool_result","content":"test result: ok. 12 passed; 0 failed; 0 ignored;"}]}}"#);
        assert!(matches!(&ended[0], SemanticEventKind::ToolEnd { ok: true, .. }));
        assert!(matches!(&ended[1], SemanticEventKind::TestResult { pass: 12, fail: 0 }));
    }

    #[test]
    fn test_named_command_without_explicit_counts_emits_no_test_result() {
        let mut adapter = AgentAdapter::new("claude").unwrap();
        decode(&mut adapter, r#"{"type":"assistant","uuid":"nt1","message":{"role":"assistant","content":[{"type":"tool_use","id":"bash-2","name":"Bash","input":{"command":"cargo test"}}]}}"#);
        let ended = decode(&mut adapter, r#"{"type":"user","uuid":"nt2","message":{"role":"user","content":[{"tool_use_id":"bash-2","type":"tool_result","content":"tests are running"}]}}"#);
        assert_eq!(ended.len(), 1);
        assert!(matches!(&ended[0], SemanticEventKind::ToolEnd { .. }));
    }

    #[test]
    fn successful_error_lookalike_emits_no_error() {
        let mut adapter = AgentAdapter::new("claude").unwrap();
        decode(&mut adapter, r#"{"type":"assistant","uuid":"se1","message":{"role":"assistant","content":[{"type":"tool_use","id":"bash-3","name":"Bash","input":{"command":"printf error"}}]}}"#);
        let ended = decode(&mut adapter, r#"{"type":"user","uuid":"se2","message":{"role":"user","content":[{"tool_use_id":"bash-3","type":"tool_result","content":"error: this string is expected output"}]}}"#);
        assert_eq!(ended.len(), 1);
        assert!(matches!(&ended[0], SemanticEventKind::ToolEnd { ok: true, .. }));
    }

    #[test]
    fn codex_nonzero_exit_code_emits_error() {
        let mut adapter = AgentAdapter::new("codex").unwrap();
        let started = adapter.decode_record(r#"{"type":"response_item","payload":{"type":"function_call","call_id":"exec-1","name":"exec","arguments":"{\"command\":\"cargo test\"}"}}"#, ByteRange { start: 0, end: 1 }, 1).unwrap();
        assert!(matches!(started[0].kind, SemanticEventKind::ToolStart { .. }));
        let ended = adapter.decode_record(r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"exec-1","output":"Exit code: 2\nerror: failed"}}"#, ByteRange { start: 1, end: 2 }, 2).unwrap();
        assert!(matches!(&ended[0].kind, SemanticEventKind::ToolEnd { ok: false, .. }));
        assert!(matches!(&ended[1].kind, SemanticEventKind::Error { text, .. } if text == "exec: error: failed"));
    }

    #[test]
    fn injected_user_records_never_become_operator_messages() {
        let mut adapter = AgentAdapter::new("claude").unwrap();
        let meta = decode(&mut adapter, r#"{"type":"user","uuid":"n1","isMeta":true,"message":{"role":"user","content":"Caveat: the messages below were generated"}}"#);
        assert!(meta.is_empty(), "isMeta record produced {meta:?}");
        let command = decode(&mut adapter, r#"{"type":"user","uuid":"n2","message":{"role":"user","content":[{"type":"text","text":"<command-name>junbi</command-name>"}]}}"#);
        assert!(command.is_empty(), "slash-command scaffolding produced {command:?}");
        let reminder = decode(&mut adapter, r#"{"type":"user","uuid":"n3","message":{"role":"user","content":"<system-reminder>do not mention this</system-reminder>"}}"#);
        assert!(reminder.is_empty(), "system reminder produced {reminder:?}");
        let stdout = decode(&mut adapter, r#"{"type":"user","uuid":"n4","message":{"role":"user","content":"<local-command-stdout>done</local-command-stdout>"}}"#);
        assert!(stdout.is_empty(), "local command output produced {stdout:?}");
    }

    #[test]
    fn sidechain_records_contribute_neither_messages_nor_tool_events() {
        let mut adapter = AgentAdapter::new("claude").unwrap();
        let prompt = decode(&mut adapter, r#"{"type":"user","uuid":"s1","isSidechain":true,"message":{"role":"user","content":[{"type":"text","text":"sub-agent task"}]}}"#);
        assert!(prompt.is_empty(), "sidechain prompt produced {prompt:?}");
        let tool_use = decode(&mut adapter, r#"{"type":"assistant","uuid":"s2","isSidechain":true,"message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_s","name":"Grep","input":{"path":"x"}}]}}"#);
        assert!(tool_use.is_empty(), "sidechain tool_use produced {tool_use:?}");
        let tool_result = decode(&mut adapter, r#"{"type":"user","uuid":"s3","isSidechain":true,"message":{"role":"user","content":[{"tool_use_id":"toolu_s","type":"tool_result","content":"ok"}]}}"#);
        assert!(tool_result.is_empty(), "sidechain tool_result produced {tool_result:?}");
    }

    #[test]
    fn a_user_record_carrying_both_text_and_a_tool_result_emits_both() {
        let mut adapter = AgentAdapter::new("claude").unwrap();
        let events = decode(&mut adapter, r#"{"type":"user","uuid":"u5","message":{"role":"user","content":[{"type":"text","text":"keep going"},{"tool_use_id":"toolu_z","type":"tool_result","content":"ok"}]}}"#);
        assert_eq!(events.len(), 2);
        assert!(matches!(&events[0], SemanticEventKind::UserMessage { text, .. } if text == "keep going"));
        assert!(matches!(&events[1], SemanticEventKind::ToolEnd { call_id, .. } if call_id == "toolu_z"));
    }

    #[test]
    fn claude_codex_decodes_with_the_claude_transcript_shape() {
        let mut adapter = AgentAdapter::new("claude-codex").unwrap();
        let events = decode(&mut adapter, r#"{"type":"user","uuid":"cc1","message":{"role":"user","content":[{"type":"text","text":"build it"},{"tool_use_id":"toolu_c","type":"tool_result","content":"ok"}]}}"#);
        assert_eq!(events.len(), 2);
        assert!(matches!(&events[0], SemanticEventKind::UserMessage { kind: UserMessageKind::TaskStart, .. }));
        assert!(matches!(&events[1], SemanticEventKind::ToolEnd { call_id, .. } if call_id == "toolu_c"));
    }

    #[test]
    fn codex_question_tracks_call_id_across_records() {
        let mut adapter = AgentAdapter::new("codex").unwrap();
        let start = adapter.decode_record(r#"{"type":"response_item","timestamp":"2026-01-01T00:00:00Z","payload":{"type":"function_call","call_id":"c1","name":"request_user_input","arguments":"{\"question\":\"go?\",\"options\":[\"yes\"]}"}}"#, ByteRange { start: 0, end: 1 }, 1).unwrap();
        assert!(matches!(start[0].kind, SemanticEventKind::Question { .. }));
        let end = adapter.decode_record(r#"{"type":"response_item","timestamp":"2026-01-01T00:00:01Z","payload":{"type":"function_call_output","call_id":"c1","output":"ok"}}"#, ByteRange { start: 1, end: 2 }, 2).unwrap();
        assert!(matches!(end[0].kind, SemanticEventKind::QuestionResolved { .. }));
    }
}
