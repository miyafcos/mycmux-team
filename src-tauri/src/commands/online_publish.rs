// GUI-side savepoint publisher: native port of scripts/savepoint_publish.py.
// The Python CLI remains the scriptable path; keep the bundle layout,
// manifest schema, and handoff.md template in sync between the two.

use chrono::{Duration as ChronoDuration, FixedOffset, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use tauri::Emitter;

use super::online::{
    is_link_or_reparse_point, load_config, read_json, sanitize_project_dir, SavepointAgentKind,
    SavepointLifecycle, SavepointLifecycleStatus, SavepointRecordKind, DROPBOX_TOKEN,
    FINAL_RECORDS_DIR, SAVEPOINT_SCHEMA, TRASHED_FINAL_CHECKPOINT_FIELD,
};

const DEFAULT_EXPIRE_HOURS: i64 = 48;
const READ_TOOL: &str = "Read";
const WRITE_TOOLS: [&str; 4] = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
const PUBLISH_PROGRESS_EVENT: &str = "mycmux:savepoint-publish-progress";
pub(crate) static PUBLISH_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum PublishProgressStage {
    Digest,
    Handoff,
    Bundle,
    Register,
    Done,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
struct PublishProgressPayload {
    stage: PublishProgressStage,
    agent_kind: SavepointAgentKind,
    agent_session_id: String,
    claude_session_id: Option<String>,
}

fn publish_progress(
    stage: PublishProgressStage,
    kind: SavepointAgentKind,
    session_id: &str,
) -> PublishProgressPayload {
    PublishProgressPayload {
        stage,
        agent_kind: kind,
        agent_session_id: session_id.to_string(),
        claude_session_id: (kind == SavepointAgentKind::Claude).then(|| session_id.to_string()),
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SavepointCloseReason {
    Manual,
    TabClosed,
    PaneClosed,
    WorkspaceClosed,
    AppClosed,
}

impl SavepointCloseReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::TabClosed => "tab_closed",
            Self::PaneClosed => "pane_closed",
            Self::WorkspaceClosed => "workspace_closed",
            Self::AppClosed => "app_closed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PublishMode {
    Current,
    Final(SavepointCloseReason),
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct PublishSavepointResult {
    pub bundle_dir: String,
    pub session_id: String,
    pub summary_line: String,
    pub files_written: usize,
    pub files_read: usize,
    pub warnings: Vec<String>,
    pub updated: bool,
    pub record_kind: SavepointRecordKind,
    pub checkpoint_id: String,
    pub parent_checkpoint_id: Option<String>,
}

include!("online_publish/digest.rs");

include!("online_publish/transcript.rs");

include!("online_publish/lifecycle.rs");

include!("online_publish/publish.rs");

#[tauri::command(async)]
pub fn publish_savepoint(
    app: tauri::AppHandle,
    cwd: String,
    agent_kind: Option<SavepointAgentKind>,
    agent_session_id: Option<String>,
    claude_session_id: Option<String>,
    summary: Option<String>,
    next_step: Option<String>,
    window_label: Option<String>,
) -> Result<PublishSavepointResult, String> {
    let home = dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    let agent_kind = agent_kind.unwrap_or(SavepointAgentKind::Claude);
    let session_id = match agent_kind {
        SavepointAgentKind::Claude => agent_session_id.as_deref().or(claude_session_id.as_deref()),
        SavepointAgentKind::Codex => agent_session_id.as_deref(),
    };
    let transcript_root = match agent_kind {
        SavepointAgentKind::Claude => home.join(".claude").join("projects"),
        SavepointAgentKind::Codex => home.join(".codex").join("sessions"),
    };
    // Multi-window: the progress stream belongs to the window that started
    // the publish. Broadcasting it made every open window animate the same
    // savepoint. `window_label` is optional so the socket/CLI callers (which
    // have no window) keep the broadcast behaviour.
    let mut emit_progress = |payload: PublishProgressPayload| match window_label.as_deref() {
        Some(label) => {
            let _ = app.emit_to(label, PUBLISH_PROGRESS_EVENT, payload);
        }
        None => {
            let _ = app.emit(PUBLISH_PROGRESS_EVENT, payload);
        }
    };
    publish_savepoint_impl(
        &home.join(".mycmux").join("savepoint.json"),
        &home,
        &transcript_root,
        agent_kind,
        &cwd,
        session_id,
        summary.as_deref(),
        next_step.as_deref(),
        PublishMode::Current,
        Utc::now(),
        &mut emit_progress,
    )
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn finalize_savepoint(
    app: tauri::AppHandle,
    cwd: String,
    agent_kind: Option<SavepointAgentKind>,
    agent_session_id: Option<String>,
    claude_session_id: Option<String>,
    summary: Option<String>,
    next_step: Option<String>,
    closed_reason: Option<SavepointCloseReason>,
    window_label: Option<String>,
) -> Result<PublishSavepointResult, String> {
    let home = dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    let agent_kind = agent_kind.unwrap_or(SavepointAgentKind::Claude);
    let session_id = match agent_kind {
        SavepointAgentKind::Claude => agent_session_id.as_deref().or(claude_session_id.as_deref()),
        SavepointAgentKind::Codex => agent_session_id.as_deref(),
    };
    let transcript_root = match agent_kind {
        SavepointAgentKind::Claude => home.join(".claude").join("projects"),
        SavepointAgentKind::Codex => home.join(".codex").join("sessions"),
    };
    // Multi-window: the progress stream belongs to the window that started
    // the publish. Broadcasting it made every open window animate the same
    // savepoint. `window_label` is optional so the socket/CLI callers (which
    // have no window) keep the broadcast behaviour.
    let mut emit_progress = |payload: PublishProgressPayload| match window_label.as_deref() {
        Some(label) => {
            let _ = app.emit_to(label, PUBLISH_PROGRESS_EVENT, payload);
        }
        None => {
            let _ = app.emit(PUBLISH_PROGRESS_EVENT, payload);
        }
    };
    publish_savepoint_impl(
        &home.join(".mycmux").join("savepoint.json"),
        &home,
        &transcript_root,
        agent_kind,
        &cwd,
        session_id,
        summary.as_deref(),
        next_step.as_deref(),
        PublishMode::Final(closed_reason.unwrap_or(SavepointCloseReason::Manual)),
        Utc::now(),
        &mut emit_progress,
    )
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod stale_id_fallback_tests;
