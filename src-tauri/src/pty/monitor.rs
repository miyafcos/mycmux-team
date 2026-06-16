use std::collections::HashMap;
use std::io::BufRead;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Command;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
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
    pub claude_session_id: Option<String>,
    pub agent_kind: Option<String>,
    pub agent_session_id: Option<String>,
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

/// Detect the active Claude Code session ID by finding the most recently
/// modified `.jsonl` file in `~/.claude/projects/<mangled-cwd>/`.
fn detect_claude_session_id(cwd: &str) -> Option<String> {
    let home = dirs::home_dir()?;
    let mangled = super::path_norm::claude_project_key(cwd);
    let project_dir = home.join(".claude").join("projects").join(&mangled);
    if !project_dir.exists() {
        return None;
    }

    let mut best: Option<(String, std::time::SystemTime)> = None;
    for entry in std::fs::read_dir(&project_dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            if let Ok(meta) = entry.metadata() {
                if let Ok(mtime) = meta.modified() {
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        if best.is_none() || mtime > best.as_ref().unwrap().1 {
                            best = Some((stem.to_string(), mtime));
                        }
                    }
                }
            }
        }
    }
    best.map(|(id, _)| id)
}

fn detect_claude_codex_session_id(cwd: &str) -> Option<String> {
    let home = dirs::home_dir()?;
    let normalized = if cwd.starts_with('/') && cwd.len() > 2 && cwd.as_bytes()[2] == b'/' {
        format!(
            "{}:{}",
            cwd[1..2].to_uppercase(),
            cwd[2..].replace('/', "\\")
        )
    } else {
        cwd.to_string()
    };
    let mangled = normalized.replace([':', '\\', '/'], "-");
    let project_dir = home
        .join(".claude-codex")
        .join("config")
        .join("projects")
        .join(&mangled);
    if !project_dir.exists() {
        return None;
    }

    let mut best: Option<(String, std::time::SystemTime)> = None;
    for entry in std::fs::read_dir(&project_dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            if let Ok(meta) = entry.metadata() {
                if let Ok(mtime) = meta.modified() {
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        if best.is_none() || mtime > best.as_ref().unwrap().1 {
                            best = Some((stem.to_string(), mtime));
                        }
                    }
                }
            }
        }
    }
    best.map(|(id, _)| id)
}

fn normalize_cwd_key(cwd: &str) -> String {
    let normalized = if cwd.starts_with('/') && cwd.len() > 2 && cwd.as_bytes()[2] == b'/' {
        format!(
            "{}:{}",
            cwd[1..2].to_uppercase(),
            cwd[2..].replace('/', "\\")
        )
    } else {
        cwd.replace('/', "\\")
    };
    normalized
        .trim_end_matches(['\\', '/'])
        .to_ascii_lowercase()
}

fn codex_session_meta(path: &std::path::Path) -> Option<(String, String)> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return None,
    };
    let mut lines = std::io::BufReader::new(file).lines();
    let Some(Ok(line)) = lines.next() else {
        return None;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
        return None;
    };
    let payload = value.get("payload")?;
    let id = payload.get("id").and_then(|id| id.as_str())?;
    let cwd = payload.get("cwd").and_then(|cwd| cwd.as_str())?;
    if id.trim().is_empty() {
        return None;
    }
    Some((id.to_string(), cwd.to_string()))
}

fn codex_session_id_for_cwd(path: &std::path::Path, cwd_key: &str) -> Option<String> {
    let (payload_id, payload_cwd) = codex_session_meta(path)?;
    if normalize_cwd_key(&payload_cwd) == cwd_key {
        Some(payload_id)
    } else {
        None
    }
}

fn visit_codex_sessions_dir(
    dir: &std::path::Path,
    cwd_key: &str,
    best: &mut Option<(String, std::time::SystemTime)>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            visit_codex_sessions_dir(&path, cwd_key, best);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(session_id) = codex_session_id_for_cwd(&path, cwd_key) else {
            continue;
        };
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if best.is_none() || modified > best.as_ref().unwrap().1 {
            *best = Some((session_id, modified));
        }
    }
}

fn detect_codex_session_id(cwd: &str) -> Option<String> {
    let home = dirs::home_dir()?;
    let sessions_dir = home.join(".codex").join("sessions");
    if !sessions_dir.exists() {
        return None;
    }
    let cwd_key = normalize_cwd_key(cwd);
    let mut best: Option<(String, std::time::SystemTime)> = None;
    visit_codex_sessions_dir(&sessions_dir, &cwd_key, &mut best);
    best.map(|(id, _)| id)
}

/// System/infrastructure processes to skip when detecting the foreground process.
fn is_system_process(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let leaf = lower.strip_suffix(".exe").unwrap_or(&lower);
    matches!(
        leaf,
        "conhost" | "csrss" | "wininit" | "winlogon" | "dwm" | "fontdrvhost"
    )
}

/// Follow the newest child chain to find the foreground process PID,
/// skipping system processes like conhost.
fn deepest_child_pid(sys: &System, pid: Pid) -> Pid {
    let next_child = sys
        .processes()
        .iter()
        .filter(|(_, process)| {
            process.parent() == Some(pid) && !is_system_process(&process.name().to_string_lossy())
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

pub fn start_monitor(
    app_handle: AppHandle,
    manager: Arc<SessionManager>,
    metadata_store: MetadataStore,
) {
    thread::spawn(move || {
        let mut sys = System::new();
        let mut last_metadata: HashMap<String, PtyMetadata> = HashMap::new();

        loop {
            // 5s cadence: OSC 7 handles CWD instantly for bash/zsh/fish;
            // sysinfo is now the fallback for cmd.exe / PowerShell and the
            // safety net that fills in git_branch / process_name.
            thread::sleep(Duration::from_secs(5));

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
                            let mut git_cmd = Command::new("git");
                            git_cmd
                                .args(["rev-parse", "--abbrev-ref", "HEAD"])
                                .current_dir(&cwd_clone)
                                .stdout(std::process::Stdio::piped())
                                .stderr(std::process::Stdio::null());
                            #[cfg(target_os = "windows")]
                            git_cmd.creation_flags(CREATE_NO_WINDOW);
                            let result = git_cmd.output().ok().and_then(|output| {
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

                    // Detect coding-agent session IDs only while that agent is foreground.
                    // When an agent exits, preserve the last ID in backend metadata; the
                    // frontend clears it when the foreground process returns to a shell.
                    let lower_process = process_name
                        .as_deref()
                        .map(|name| name.to_ascii_lowercase());
                    let previous_metadata = last_metadata.get(&session_id);
                    let (agent_kind, agent_session_id, claude_session_id) =
                        match (process_name.as_deref(), lower_process.as_deref()) {
                            (Some(name), Some(lower))
                                if lower.contains("claude-codex") && !is_shell_process(name) =>
                            {
                                let detected = detect_claude_codex_session_id(&cwd);
                                (
                                    detected.as_ref().map(|_| "claude-codex".to_string()),
                                    detected,
                                    previous_metadata.and_then(|m| m.claude_session_id.clone()),
                                )
                            }
                            (Some(name), Some(lower))
                                if lower.contains("claude") && !is_shell_process(name) =>
                            {
                                let detected = detect_claude_session_id(&cwd);
                                (
                                    detected.as_ref().map(|_| "claude".to_string()),
                                    detected.clone(),
                                    detected,
                                )
                            }
                            (Some(name), Some(lower))
                                if lower.contains("codex") && !is_shell_process(name) =>
                            {
                                let detected = detect_codex_session_id(&cwd);
                                (
                                    detected.as_ref().map(|_| "codex".to_string()),
                                    detected,
                                    previous_metadata.and_then(|m| m.claude_session_id.clone()),
                                )
                            }
                            _ => (
                                previous_metadata.and_then(|m| m.agent_kind.clone()),
                                previous_metadata.and_then(|m| m.agent_session_id.clone()),
                                previous_metadata.and_then(|m| m.claude_session_id.clone()),
                            ),
                        };

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
                        claude_session_id: claude_session_id.clone(),
                        agent_kind: agent_kind.clone(),
                        agent_session_id: agent_session_id.clone(),
                    };

                    let changed = match last_metadata.get(&session_id) {
                        Some(old) => {
                            old.cwd != cwd
                                || old.git_branch != git_branch
                                || old.process_name != process_name
                                || old.claude_session_id != claude_session_id
                                || old.agent_kind != agent_kind
                                || old.agent_session_id != agent_session_id
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
