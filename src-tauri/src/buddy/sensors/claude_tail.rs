use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Runtime};

use crate::buddy::signal::{now_ms, SignalEvent};

use super::{spawn_jsonl_tail, user_home_dir};

pub fn spawn<R: Runtime + 'static>(app: AppHandle<R>) {
    spawn_jsonl_tail(app, "claude_tail", claude_history_path(), parse_claude_line);
}

fn claude_history_path() -> PathBuf {
    user_home_dir().join(".claude").join("history.jsonl")
}

fn parse_claude_line(raw_line: String, value: Value) -> SignalEvent {
    let text = value
        .get("display")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let session_id = value
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let project = value
        .get("project")
        .and_then(Value::as_str)
        .map(str::to_string);
    let timestamp_ms = value
        .get("timestamp")
        .and_then(Value::as_u64)
        .unwrap_or_else(now_ms);

    SignalEvent::ClaudeEvent {
        timestamp_ms,
        session_id,
        project,
        text,
        raw_line,
    }
}
