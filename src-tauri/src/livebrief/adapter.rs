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
    pub fn new(kind: &str) -> Result<Self, String> {
        if !matches!(kind, "claude" | "codex") { return Err("unsupported agent adapter".to_string()); }
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
        let kind = value.get("type").and_then(Value::as_str).unwrap_or_default();
        let message = value.get("message").unwrap_or(value);
        match kind {
            "user" => collect_text(message.get("content")).map(|text| self.user_message(&text)).into_iter().collect(),
            "assistant" => self.claude_assistant(message),
            "tool_result" => self.claude_tool_result(value),
            _ => Vec::new(),
        }
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
        vec![SemanticEventKind::ToolEnd { call_id, tool, target, ok: !output.contains("Exit code: 1"), summary: short(&output) }]
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
        vec![SemanticEventKind::ToolEnd { call_id, tool, target, ok: !value.get("is_error").and_then(Value::as_bool).unwrap_or(false), summary: short(&output) }]
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

fn extract_target(raw: &str) -> Option<String> { serde_json::from_str::<Value>(raw).ok().and_then(|value| value.get("path").or_else(|| value.get("command")).or_else(|| value.get("query")).and_then(Value::as_str).map(str::to_string)) }

fn parse_question(raw: &str) -> (String, PendingInputKind, Vec<PendingOption>) {
    let value = serde_json::from_str::<Value>(raw).unwrap_or(Value::Null);
    let prompt = value.get("question").or_else(|| value.get("prompt")).or_else(|| value.get("message")).and_then(Value::as_str).unwrap_or("Input required").to_string();
    let options: Vec<PendingOption> = value.get("options").and_then(Value::as_array).map(|items| items.iter().enumerate().filter_map(|(index, item)| { let label = item.get("label").or_else(|| item.get("text")).and_then(Value::as_str).or_else(|| item.as_str())?; let payload = item.get("value").or_else(|| item.get("payload")).and_then(Value::as_str).unwrap_or(label); Some(PendingOption::new(format!("option-{index}"), label.to_string(), payload.to_string())) }).collect()).unwrap_or_default();
    let kind = if options.is_empty() { PendingInputKind::FreeText } else { PendingInputKind::Choice };
    (prompt, kind, options)
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
    #[test]
    fn codex_question_tracks_call_id_across_records() {
        let mut adapter = AgentAdapter::new("codex").unwrap();
        let start = adapter.decode_record(r#"{"type":"response_item","timestamp":"2026-01-01T00:00:00Z","payload":{"type":"function_call","call_id":"c1","name":"request_user_input","arguments":"{\"question\":\"go?\",\"options\":[\"yes\"]}"}}"#, ByteRange { start: 0, end: 1 }, 1).unwrap();
        assert!(matches!(start[0].kind, SemanticEventKind::Question { .. }));
        let end = adapter.decode_record(r#"{"type":"response_item","timestamp":"2026-01-01T00:00:01Z","payload":{"type":"function_call_output","call_id":"c1","output":"ok"}}"#, ByteRange { start: 1, end: 2 }, 2).unwrap();
        assert!(matches!(end[0].kind, SemanticEventKind::QuestionResolved { .. }));
    }
}
