use std::collections::HashMap;
use std::process::Command;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use dashmap::DashMap;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter};

use super::manager::SessionManager;

#[derive(Clone, serde::Serialize)]
pub struct PtyMetadata {
    pub session_id: String,
    pub cwd: String,
    pub git_branch: Option<String>,
    pub process_name: Option<String>,
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

/// System/infrastructure processes to skip when detecting the foreground process.
fn is_system_process(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let leaf = lower.strip_suffix(".exe").unwrap_or(&lower);
    matches!(leaf, "conhost" | "csrss" | "wininit" | "winlogon" | "dwm" | "fontdrvhost")
}

/// Follow the newest child chain to find the foreground process PID,
/// skipping system processes like conhost.
fn deepest_child_pid(sys: &System, pid: Pid) -> Pid {
    let next_child = sys
        .processes()
        .iter()
        .filter(|(_, process)| {
            process.parent() == Some(pid)
                && !is_system_process(&process.name().to_string_lossy())
        })
        .max_by_key(|(child_pid, _)| child_pid.as_u32())
        .map(|(child_pid, _)| *child_pid);

    match next_child {
        Some(child_pid) => deepest_child_pid(sys, child_pid),
        None => pid,
    }
}

/// Get the CWD of the foreground process (deepest child), falling back to shell CWD.
fn get_process_cwd(sys: &System, pid: u32) -> Option<String> {
    let shell_pid = Pid::from_u32(pid);
    let fg_pid = deepest_child_pid(sys, shell_pid);

    // Try foreground process CWD first, fall back to shell CWD
    sys.process(fg_pid)
        .and_then(|p| p.cwd().map(|c| c.to_string_lossy().to_string()))
        .or_else(|| {
            sys.process(shell_pid)
                .and_then(|p| p.cwd().map(|c| c.to_string_lossy().to_string()))
        })
}

/// Get the foreground process name by following the newest child chain.
fn get_foreground_process_name(sys: &System, shell_pid: u32) -> Option<String> {
    let foreground_pid = deepest_child_pid(sys, Pid::from_u32(shell_pid));
    sys.process(foreground_pid)
        .map(|p| p.name().to_string_lossy().to_string())
}

pub fn start_monitor(app_handle: AppHandle, manager: Arc<SessionManager>, metadata_store: MetadataStore) {
    thread::spawn(move || {
        let mut sys = System::new();
        let mut last_metadata: HashMap<String, PtyMetadata> = HashMap::new();

        loop {
            thread::sleep(Duration::from_secs(3));

            // Refresh process info
            sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::everything(),
            );

            let pids = manager.iter_pids();

            for (session_id, pid_opt) in pids {
                if let Some(pid) = pid_opt {
                    let cwd = match get_process_cwd(&sys, pid) {
                        Some(c) if !c.is_empty() => c,
                        _ => continue,
                    };

                    // Check if CWD changed to avoid spamming git commands
                    let needs_git_check = match last_metadata.get(&session_id) {
                        Some(meta) => meta.cwd != cwd,
                        None => true,
                    };

                    let git_branch = if needs_git_check {
                        // Run git with a 2-second timeout to avoid blocking on slow filesystems
                        let cwd_clone = cwd.clone();
                        let (tx, rx) = std::sync::mpsc::channel();
                        thread::spawn(move || {
                            let result = Command::new("git")
                                .args(["rev-parse", "--abbrev-ref", "HEAD"])
                                .current_dir(&cwd_clone)
                                .stdout(std::process::Stdio::piped())
                                .stderr(std::process::Stdio::null())
                                .output()
                                .ok()
                                .and_then(|output| {
                                    if output.status.success() {
                                        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
                                    } else {
                                        None
                                    }
                                });
                            let _ = tx.send(result);
                        });
                        match rx.recv_timeout(Duration::from_secs(2)) {
                            Ok(result) => result,
                            Err(_) => {
                                eprintln!("[monitor] git rev-parse timed out for {}", cwd);
                                None
                            }
                        }
                    } else {
                        last_metadata
                            .get(&session_id)
                            .and_then(|m| m.git_branch.clone())
                    };

                    let process_name = get_foreground_process_name(&sys, pid);

                    // Detect work→idle transition: previous foreground was a non-shell
                    // process (claude/node/python/…) and current is a shell.
                    // Emit a one-shot "pty_work_done" event so the UI can badge the pane.
                    if let (Some(prev_meta), Some(current)) =
                        (last_metadata.get(&session_id), process_name.as_ref())
                    {
                        if let Some(prev) = prev_meta.process_name.as_ref() {
                            if !is_shell_process(prev)
                                && is_shell_process(current)
                                && prev != current
                            {
                                let evt = PtyWorkDone {
                                    session_id: session_id.clone(),
                                    prev_process: prev.clone(),
                                    current_process: current.to_string(),
                                };
                                let _ = app_handle.emit("pty_work_done", evt);
                            }
                        }
                    }

                    let metadata = PtyMetadata {
                        session_id: session_id.clone(),
                        cwd: cwd.clone(),
                        git_branch: git_branch.clone(),
                        process_name: process_name.clone(),
                    };

                    let changed = match last_metadata.get(&session_id) {
                        Some(old) => {
                            old.cwd != cwd
                                || old.git_branch != git_branch
                                || old.process_name != process_name
                        }
                        None => true,
                    };

                    // Always track last_metadata for work-done detection, even if
                    // not "changed" enough to re-emit pty_metadata.
                    last_metadata.insert(session_id.clone(), metadata.clone());
                    if changed {
                        // Also update the shared metadata store for remote access
                        metadata_store.insert(session_id.clone(), metadata.clone());
                        let _ = app_handle.emit("pty_metadata", metadata);
                    }
                }
            }

            // Cleanup dead sessions
            let active_keys: std::collections::HashSet<String> =
                manager.iter_pids().into_iter().map(|(k, _)| k).collect();
            last_metadata.retain(|k, _| active_keys.contains(k));
            metadata_store.retain(|k, _| active_keys.contains(k));
        }
    });
}
