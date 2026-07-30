use std::collections::{HashMap, HashSet};
use std::io::BufRead;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Command;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use chrono::{DateTime, Datelike, Local};
use dashmap::DashMap;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Emitter};

use crate::commands::session_mapping::AgentSessionMapping;

use super::manager::SessionManager;

#[derive(Clone, serde::Serialize)]
pub struct PtyMetadata {
    pub session_id: String,
    pub cwd: String,
    pub git_branch: Option<String>,
    pub process_name: Option<String>,
    pub process_status: Option<String>,
    pub process_status_at: Option<i64>,
    pub agent_active: bool,
    pub claude_session_id: Option<String>,
    pub agent_kind: Option<String>,
    pub agent_session_id: Option<String>,
}

fn process_status_from_observation(
    process_name: Option<&str>,
    process_started_at: Option<i64>,
) -> (Option<String>, Option<i64>) {
    let status = process_name.map(|name| {
        if is_shell_process(name) {
            "idle".to_string()
        } else {
            "working".to_string()
        }
    });
    // The OS process start time is stable across mycmux restarts. Using the
    // monitor poll time here would make every tab look newly active at once.
    let status_at = status.as_ref().and(process_started_at.filter(|value| *value > 0));
    (status, status_at)
}

#[derive(Clone, serde::Serialize)]
pub struct PtyWorkDone {
    pub session_id: String,
    pub prev_process: String,
    pub current_process: String,
}

/// Shell processes that signal "back to idle" when the foreground switches to them.
fn is_shell_process(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let leaf = lower.strip_suffix(".exe").unwrap_or(&lower);
    matches!(
        leaf,
        "bash" | "sh" | "zsh" | "fish" | "pwsh" | "powershell" | "cmd" | "dash" | "ksh"
    )
}

/// Shared metadata store accessible from remote server.
pub type MetadataStore = Arc<DashMap<String, PtyMetadata>>;

pub fn new_metadata_store() -> MetadataStore {
    Arc::new(DashMap::new())
}

fn codex_agent_metadata_fields(
    agent_session_id: Option<String>,
    claude_session_id: Option<String>,
) -> (Option<String>, Option<String>, Option<String>) {
    (
        Some("codex".to_string()),
        agent_session_id,
        claude_session_id,
    )
}

fn write_detected_agent_session_mapping(
    session_id: &str,
    agent_kind: &str,
    agent_session_id: &str,
) {
    let _ = crate::commands::session_mapping::write_session_mapping_file(
        session_id,
        agent_kind,
        agent_session_id,
    );
}

/// Returns true when the session file was created at/after `min_created`.
/// Used to keep the mtime-newest fallback from adopting sessions that already
/// existed before the agent process started (e.g. a long-running claude in
/// another window sharing the same CWD keeps touching its old jsonl, which
/// would otherwise win every scan and resume a stale conversation).
mod detection;
mod codex_rollout;
mod git_branch;
mod runner;
mod transcripts;

use detection::*;
use codex_rollout::*;
use git_branch::*;
pub use runner::start_monitor;
use transcripts::*;


#[cfg(test)]
mod tests;
