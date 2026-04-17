use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Runtime};

pub const SIGNAL_EVENT_NAME: &str = "buddy://signal";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SignalEvent {
    ClaudeEvent {
        timestamp_ms: u64,
        session_id: Option<String>,
        project: Option<String>,
        text: String,
        raw_line: String,
    },
    CodexEvent {
        timestamp_ms: u64,
        session_id: Option<String>,
        text: String,
        raw_line: String,
    },
}

pub fn emit_signal_event<R: Runtime>(app: &AppHandle<R>, signal: &SignalEvent) {
    match signal {
        SignalEvent::ClaudeEvent { text, .. } => {
            eprintln!("[buddy] ClaudeEvent: {}", preview_text(text));
        }
        SignalEvent::CodexEvent { text, .. } => {
            eprintln!("[buddy] CodexEvent: {}", preview_text(text));
        }
    }

    if let Err(error) = app.emit(SIGNAL_EVENT_NAME, signal.clone()) {
        eprintln!("[buddy] failed to emit signal event: {error}");
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn preview_text(value: &str) -> String {
    let mut preview = value.trim().replace('\n', " ");
    if preview.chars().count() > 80 {
        preview = preview.chars().take(77).collect::<String>() + "...";
    }
    preview
}
