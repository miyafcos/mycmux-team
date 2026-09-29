//! Bounded, display-oriented transcript extraction.
use serde::Serialize;
use serde_json::Value;

use crate::ailog::{KIND_CLAUDE, KIND_CODEX};

pub const MESSAGE_LIMIT: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptMessage {
    pub role: String,
    pub text: String,
    pub tool_name: Option<String>,
    pub tool_target: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptReport {
    pub messages: Vec<TranscriptMessage>,
    pub truncated: bool,
    pub omitted_count: usize,
    pub bytes_read: u64,
    pub file_bytes: u64,
    pub scan_truncated: bool,
}

pub fn extract(kind: &str, text: &str) -> Result<TranscriptReport, String> {
    if kind != KIND_CLAUDE && kind != KIND_CODEX { return Err("unsupported transcript kind".to_string()); }
    let mut messages = Vec::new();
    let mut omitted = 0;
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else { continue; };
        for message in messages_from_value(kind, &value) {
            if messages.len() < MESSAGE_LIMIT { messages.push(message); } else { omitted += 1; }
        }
    }
    Ok(TranscriptReport { messages, truncated: omitted > 0, omitted_count: omitted, bytes_read: text.len() as u64, file_bytes: text.len() as u64, scan_truncated: false })
}

pub fn extract_path(kind: &str, path: &std::path::Path) -> Result<TranscriptReport, String> {
    if kind != KIND_CLAUDE && kind != KIND_CODEX { return Err("unsupported transcript kind".to_string()); }
    let mut messages = Vec::new(); let mut omitted = 0;
    let stats = crate::ailog::jsonl::for_each_line(path, crate::ailog::jsonl::Budget { max_bytes: 64 * 1024 * 1024, max_lines: 200_000 }, |line| {
        if let Ok(value) = serde_json::from_str::<Value>(line) { for message in messages_from_value(kind, &value) { if messages.len() < MESSAGE_LIMIT { messages.push(message); } else { omitted += 1; } } }
        std::ops::ControlFlow::Continue(())
    })?;
    Ok(TranscriptReport { messages, truncated: omitted > 0 || stats.scan_truncated, omitted_count: omitted, bytes_read: stats.bytes_read, file_bytes: stats.file_bytes, scan_truncated: stats.scan_truncated })
}

fn messages_from_value(kind: &str, value: &Value) -> Vec<TranscriptMessage> {
    if kind == KIND_CLAUDE { return claude_messages(value); }
    codex_messages(value)
}

fn text_blocks(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.trim().to_string(),
        Some(Value::Array(items)) => items.iter().filter_map(|v| v.get("text").and_then(Value::as_str)).map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

fn tool_target(input: &Value) -> Option<String> {
    ["file_path", "path", "command", "query", "url"].iter().find_map(|key| input.get(*key).and_then(Value::as_str)).map(|s| crate::ailog::truncate_chars(s, 200))
}

fn claude_messages(value: &Value) -> Vec<TranscriptMessage> {
    let kind = value.get("type").and_then(Value::as_str);
    let message = value.get("message");
    let role = match kind { Some("user") => "user", Some("assistant") => "assistant", _ => return vec![] };
    let mut out = Vec::new();
    match message.and_then(|m| m.get("content")) {
        Some(Value::String(text)) if !text.trim().is_empty() => out.push(TranscriptMessage { role: role.into(), text: text.trim().into(), tool_name: None, tool_target: None }),
        Some(Value::Array(blocks)) => for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("text") if block.get("text").and_then(Value::as_str).is_some() => out.push(TranscriptMessage { role: role.into(), text: block.get("text").and_then(Value::as_str).unwrap().trim().into(), tool_name: None, tool_target: None }),
                Some("tool_use") => out.push(TranscriptMessage { role: "tool".into(), text: String::new(), tool_name: block.get("name").and_then(Value::as_str).map(str::to_string), tool_target: tool_target(&block.get("input").cloned().unwrap_or(Value::Null)) }),
                Some("tool_result") => out.push(TranscriptMessage { role: "tool".into(), text: text_blocks(block.get("content")), tool_name: Some("result".into()), tool_target: None }),
                _ => {}
            }
        },
        _ => {}
    }
    out
}

fn codex_messages(value: &Value) -> Vec<TranscriptMessage> {
    let payload = value.get("payload").unwrap_or(value);
    let mut out = Vec::new();
    if value.get("type").and_then(Value::as_str) == Some("event_msg") && payload.get("type").and_then(Value::as_str) == Some("user_message") {
        if let Some(text) = payload.get("message").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) { out.push(TranscriptMessage { role: "user".into(), text: text.trim().into(), tool_name: None, tool_target: None }); }
    }
    if value.get("type").and_then(Value::as_str) == Some("response_item") {
        match payload.get("type").and_then(Value::as_str) {
            Some("message") => { let text = text_blocks(payload.get("content")); if !text.is_empty() { out.push(TranscriptMessage { role: payload.get("role").and_then(Value::as_str).unwrap_or("assistant").into(), text, tool_name: None, tool_target: None }); } }
            Some("function_call") | Some("tool_call") => out.push(TranscriptMessage { role: "tool".into(), text: String::new(), tool_name: payload.get("name").and_then(Value::as_str).map(str::to_string), tool_target: payload.get("arguments").and_then(Value::as_str).map(|s| crate::ailog::truncate_chars(s, 200)) }),
            Some("function_call_output") | Some("tool_result") => out.push(TranscriptMessage { role: "tool".into(), text: text_blocks(payload.get("output").or_else(|| payload.get("content"))), tool_name: Some("result".into()), tool_target: None }),
            _ => {}
        }
    }
    out
}
