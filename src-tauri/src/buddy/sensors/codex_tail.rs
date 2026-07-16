use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Runtime};

use crate::buddy::signal::{now_ms, SignalEvent};

use super::{spawn_jsonl_tail, user_home_dir};

pub fn spawn<R: Runtime + 'static>(app: AppHandle<R>) {
    spawn_jsonl_tail(app, "codex_tail", codex_history_path(), parse_codex_line);
}

fn codex_history_path() -> PathBuf {
    user_home_dir().join(".codex").join("history.jsonl")
}

fn parse_codex_line(raw_line: String, value: Value) -> SignalEvent {
    let text = value
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let session_id = value
        .get("session_id")
        .and_then(Value::as_str)
        .map(str::to_string);
    let timestamp_ms = value
        .get("ts")
        .and_then(Value::as_u64)
        .map(|seconds| seconds.saturating_mul(1_000))
        .unwrap_or_else(now_ms);

    SignalEvent::CodexEvent {
        timestamp_ms,
        session_id,
        text,
        raw_line,
    }
}
