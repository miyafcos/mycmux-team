use std::collections::HashMap;
use std::process::Command;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use sysinfo::{Pid, System, ProcessesToUpdate, ProcessRefreshKind};
use tauri::{AppHandle, Emitter};

use dashmap::DashMap;

use super::manager::SessionManager;

#[derive(Clone, serde::Serialize)]
pub struct PtyMetadata {
    pub session_id: String,
    pub cwd: String,
    pub git_branch: Option<String>,
    pub process_name: Option<String>,
}

/// Shared metadata store accessible from remote server.
pub type MetadataStore = Arc<DashMap<String, PtyMetadata>>;

pub fn new_metadata_store() -> MetadataStore {
    Arc::new(DashMap::new())
}

/// Get the CWD of a process using sysinfo (cross-platform).
fn get_process_cwd(sys: &System, pid: u32) -> Option<String> {
    let sysinfo_pid = Pid::from_u32(pid);
    sys.process(sysinfo_pid)
        .and_then(|p| p.cwd().map(|c| c.to_string_lossy().to_string()))
}

/// Get the foreground (child) process name.
/// Walks child processes and returns the name of the deepest child.
fn get_foreground_process_name(sys: &System, shell_pid: u32) -> Option<String> {
    let sysinfo_pid = Pid::from_u32(shell_pid);

    // Find direct children of the shell process
    let children: Vec<_> = sys
        .processes()
        .values()
        .filter(|p| p.parent() == Some(sysinfo_pid))
        .collect();

    if let Some(child) = children.last() {
        Some(child.name().to_string_lossy().to_string())
    } else {
        // No children — return the shell process name itself
        sys.process(sysinfo_pid)
            .map(|p| p.name().to_string_lossy().to_string())
    }
}

pub fn start_monitor(app_handle: AppHandle, manager: Arc<SessionManager>, metadata_store: MetadataStore) {
    thread::spawn(move || {
        let mut sys = System::new();
        let mut last_metadata: HashMap<String, PtyMetadata> = HashMap::new();

        loop {
            thread::sleep(Duration::from_secs(2));

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
                        Command::new("git")
                            .args(["rev-parse", "--abbrev-ref", "HEAD"])
                            .current_dir(&cwd)
                            .output()
                            .ok()
                            .and_then(|output| {
                                if output.status.success() {
                                    Some(
                                        String::from_utf8_lossy(&output.stdout)
                                            .trim()
                                            .to_string(),
                                    )
                                } else {
                                    None
                                }
                            })
                    } else {
                        last_metadata
                            .get(&session_id)
                            .and_then(|m| m.git_branch.clone())
                    };

                    let process_name = get_foreground_process_name(&sys, pid);

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

                    if changed {
                        last_metadata.insert(session_id.clone(), metadata.clone());
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
