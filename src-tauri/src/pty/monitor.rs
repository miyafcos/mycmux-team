use std::collections::{HashMap, HashSet};
use std::io::BufRead;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Command;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use chrono::{DateTime, Datelike, Local};
use dashmap::DashMap;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Emitter};

use super::manager::SessionManager;

#[derive(Clone, serde::Serialize)]
pub struct PtyMetadata {
    pub session_id: String,
    pub cwd: String,
    pub git_branch: Option<String>,
    pub process_name: Option<String>,
    pub agent_active: bool,
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

fn write_detected_agent_session_mapping(
    session_id: &str,
    agent_kind: &str,
    agent_session_id: &str,
) {
    if session_id.trim().is_empty()
        || agent_kind.trim().is_empty()
        || agent_session_id.trim().is_empty()
    {
        return;
    }
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let map_dir = home.join(".mycmux").join("pane-sessions");
    if std::fs::create_dir_all(&map_dir).is_err() {
        return;
    }
    let path = map_dir.join(format!("{session_id}.txt"));
    let _ = std::fs::write(path, format!("{agent_kind}:{agent_session_id}\n"));
}

/// Returns true when the session file was created at/after `min_created`.
/// Used to keep the mtime-newest fallback from adopting sessions that already
/// existed before the agent process started (e.g. a long-running claude in
/// another window sharing the same CWD keeps touching its old jsonl, which
/// would otherwise win every scan and resume a stale conversation).
fn created_at_or_after(
    metadata: &std::fs::Metadata,
    min_created: Option<std::time::SystemTime>,
) -> bool {
    let Some(min) = min_created else { return true };
    match metadata.created() {
        Ok(created) => created >= min,
        // Creation time unavailable on this filesystem — don't exclude.
        Err(_) => true,
    }
}

fn min_created_local_date(
    min_created: Option<std::time::SystemTime>,
) -> Option<(i32, u32, u32)> {
    let min_created = min_created?;
    let date: DateTime<Local> = min_created.into();
    Some((date.year(), date.month(), date.day()))
}

/// Detect the active Claude Code session ID by finding the most recently
/// modified `.jsonl` file in `~/.claude/projects/<mangled-cwd>/`,
/// restricted to files created after the agent process started.
fn detect_claude_session_id(
    cwd: &str,
    min_created: Option<std::time::SystemTime>,
) -> Option<String> {
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
                if !created_at_or_after(&meta, min_created) {
                    continue;
                }
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

fn detect_claude_codex_session_id(
    cwd: &str,
    min_created: Option<std::time::SystemTime>,
) -> Option<String> {
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
                if !created_at_or_after(&meta, min_created) {
                    continue;
                }
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
    min_created: Option<std::time::SystemTime>,
    best: &mut Option<(String, std::time::SystemTime)>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if is_codex_date_dir_before_min(&path, min_created) {
                continue;
            }
            visit_codex_sessions_dir(&path, cwd_key, min_created, best);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !created_at_or_after(&metadata, min_created) {
            continue;
        }
        let Some(session_id) = codex_session_id_for_cwd(&path, cwd_key) else {
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

fn parse_date_component(value: &str, min: u32, max: u32) -> Option<u32> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let parsed = value.parse::<u32>().ok()?;
    if (min..=max).contains(&parsed) {
        Some(parsed)
    } else {
        None
    }
}

fn path_component_string(path: &std::path::Path) -> Option<String> {
    path.file_name().and_then(|name| name.to_str()).map(str::to_string)
}

fn is_codex_date_dir_before_min(
    dir: &std::path::Path,
    min_created: Option<std::time::SystemTime>,
) -> bool {
    let Some((min_year, min_month, min_day)) = min_created_local_date(min_created) else {
        return false;
    };
    let Some(name) = path_component_string(dir) else {
        return false;
    };

    if let Some(month_dir) = dir.parent() {
        if let (Some(day), Some(month_name)) =
            (parse_date_component(&name, 1, 31), path_component_string(month_dir))
        {
            if let Some(year_dir) = month_dir.parent() {
                if let (Some(month), Some(year_name)) =
                    (parse_date_component(&month_name, 1, 12), path_component_string(year_dir))
                {
                    if let Some(year) = parse_date_component(&year_name, 1970, 9999) {
                        return (year as i32, month, day) < (min_year, min_month, min_day);
                    }
                }
            }
        }

        if let Some(year_name) = path_component_string(month_dir) {
            if let (Some(month), Some(year)) = (
                parse_date_component(&name, 1, 12),
                parse_date_component(&year_name, 1970, 9999),
            ) {
                return (year as i32, month) < (min_year, min_month);
            }
        }
    }

    if let Some(year) = parse_date_component(&name, 1970, 9999) {
        return (year as i32) < min_year;
    }

    false
}

fn detect_codex_session_id(cwd: &str, min_created: Option<std::time::SystemTime>) -> Option<String> {
    let home = dirs::home_dir()?;
    let sessions_dir = home.join(".codex").join("sessions");
    if !sessions_dir.exists() {
        return None;
    }
    let cwd_key = normalize_cwd_key(cwd);
    let mut best: Option<(String, std::time::SystemTime)> = None;
    visit_codex_sessions_dir(&sessions_dir, &cwd_key, min_created, &mut best);
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
fn build_child_index(sys: &System) -> HashMap<Pid, Vec<Pid>> {
    let mut child_index: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, process) in sys.processes() {
        if let Some(parent) = process.parent() {
            child_index.entry(parent).or_default().push(*pid);
        }
    }
    child_index
}

fn deepest_child_pid(sys: &System, child_index: &HashMap<Pid, Vec<Pid>>, pid: Pid) -> Pid {
    let next_child = child_index
        .get(&pid)
        .into_iter()
        .flatten()
        .filter(|child_pid| {
            sys.process(**child_pid)
                .map(|process| !is_system_process(&process.name().to_string_lossy()))
                .unwrap_or(false)
        })
        .max_by_key(|child_pid| child_pid.as_u32())
        .copied();

    match next_child {
        Some(child_pid) => deepest_child_pid(sys, child_index, child_pid),
        None => pid,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum DetectedAgentKind {
    Codex = 1,
    Claude = 2,
    ClaudeCodex = 3,
}

struct DetectedAgentCacheEntry {
    agent_pid: Pid,
    agent_kind: DetectedAgentKind,
    session_id: String,
}

fn cached_detected_agent_session_id(
    cache: &HashMap<String, DetectedAgentCacheEntry>,
    session_id: &str,
    agent_pid: Pid,
    agent_kind: DetectedAgentKind,
) -> Option<String> {
    cache.get(session_id).and_then(|entry| {
        if entry.agent_pid == agent_pid && entry.agent_kind == agent_kind {
            Some(entry.session_id.clone())
        } else {
            None
        }
    })
}

fn remember_detected_agent_session_id(
    cache: &mut HashMap<String, DetectedAgentCacheEntry>,
    session_id: &str,
    agent_pid: Pid,
    agent_kind: DetectedAgentKind,
    detected_session_id: &Option<String>,
) {
    if let Some(detected_session_id) = detected_session_id {
        cache.insert(
            session_id.to_string(),
            DetectedAgentCacheEntry {
                agent_pid,
                agent_kind,
                session_id: detected_session_id.clone(),
            },
        );
    }
}

fn agent_kind_from_process(sys: &System, pid: Pid) -> Option<DetectedAgentKind> {
    let process = sys.process(pid)?;
    let name = process.name().to_string_lossy();
    if is_system_process(&name) || is_shell_process(&name) {
        return None;
    }
    let lower_name = name.to_ascii_lowercase();
    if lower_name.contains("claude-codex") {
        return Some(DetectedAgentKind::ClaudeCodex);
    }
    if lower_name.contains("claude") {
        return Some(DetectedAgentKind::Claude);
    }
    if lower_name.contains("codex") {
        return Some(DetectedAgentKind::Codex);
    }

    let leaf = lower_name.strip_suffix(".exe").unwrap_or(&lower_name);
    if leaf != "node" && leaf != "bun" {
        return None;
    }

    let lower_cmd = process
        .cmd()
        .iter()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect::<Vec<String>>()
        .join(" ")
        .to_ascii_lowercase();
    if lower_cmd.contains("claude-codex") {
        return Some(DetectedAgentKind::ClaudeCodex);
    }
    if lower_cmd.contains("claude") {
        return Some(DetectedAgentKind::Claude);
    }
    if lower_cmd.contains("@openai/codex")
        || lower_cmd.contains("codex.js")
        || lower_cmd.contains(" codex")
        || lower_cmd.contains("\\codex")
        || lower_cmd.contains("/codex")
    {
        return Some(DetectedAgentKind::Codex);
    }
    None
}

/// Canonical UUID shape (8-4-4-4-12 hex) — mirrors terminal.rs::is_uuid_like.
fn is_uuid_like(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// Extract the exact session id from the agent process's own command line
/// (`--session-id <uuid>` / `--resume <uuid>` / a bare uuid positional for
/// `codex resume <uuid>`). This is pane-exact, unlike the mtime-newest
/// `detect_*_session_id(cwd)` scan which cross-contaminates panes that share
/// a CWD (multiple agents in ~ all get whichever session wrote last).
fn session_id_from_agent_args(
    sys: &System,
    agent_pid: Pid,
    allow_bare_uuid: bool,
) -> Option<String> {
    let process = sys.process(agent_pid)?;
    let args: Vec<String> = process
        .cmd()
        .iter()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect();
    for (i, arg) in args.iter().enumerate() {
        let lower = arg.to_ascii_lowercase();
        if lower == "--session-id" || lower == "--resume" || lower == "-r" {
            if let Some(next) = args.get(i + 1) {
                let candidate = next.strip_prefix("sid:").unwrap_or(next);
                if is_uuid_like(candidate) {
                    return Some(candidate.to_string());
                }
            }
        }
    }
    if !allow_bare_uuid {
        return None;
    }
    // codex passes the session id as a bare positional (`codex resume <uuid>`);
    // restricted to codex because claude prompts could contain incidental uuids.
    args.iter()
        .skip(1)
        .map(|arg| arg.strip_prefix("sid:").unwrap_or(arg))
        .find(|arg| is_uuid_like(arg))
        .map(|arg| arg.to_string())
}

fn find_agent_descendant(
    sys: &System,
    child_index: &HashMap<Pid, Vec<Pid>>,
    shell_pid: Pid,
) -> Option<(DetectedAgentKind, Pid)> {
    let mut best: Option<(DetectedAgentKind, Pid)> = None;
    let mut visited: HashSet<Pid> = HashSet::new();
    let mut stack = child_index.get(&shell_pid).cloned().unwrap_or_default();

    while let Some(pid) = stack.pop() {
        if !visited.insert(pid) {
            continue;
        }
        if let Some(kind) = agent_kind_from_process(sys, pid) {
            best = Some(match best {
                Some((current_kind, current_pid)) if current_kind >= kind => {
                    (current_kind, current_pid)
                }
                _ => (kind, pid),
            });
            if best.map(|(best_kind, _)| best_kind) == Some(DetectedAgentKind::ClaudeCodex) {
                break;
            }
        }
        if let Some(children) = child_index.get(&pid) {
            stack.extend(children.iter().copied());
        }
    }

    best
}

/// Get the CWD of the foreground process (deepest child), falling back to shell CWD.
/// `fg_pid` is resolved once by the caller and shared with the name lookup below
/// so the full process table is walked once per session per tick, not twice.
fn get_process_cwd(sys: &System, shell_pid: Pid, fg_pid: Pid) -> Option<String> {
    // Try foreground process CWD first, fall back to shell CWD
    sys.process(fg_pid)
        .and_then(|p| p.cwd().map(|c| c.to_string_lossy().to_string()))
        .or_else(|| {
            sys.process(shell_pid)
                .and_then(|p| p.cwd().map(|c| c.to_string_lossy().to_string()))
        })
}

/// Get the foreground process name for an already-resolved foreground PID.
fn get_foreground_process_name(sys: &System, foreground_pid: Pid) -> Option<String> {
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
        let mut detected_agent_sessions: HashMap<String, DetectedAgentCacheEntry> = HashMap::new();

        loop {
            // 5s cadence: OSC 7 handles CWD instantly for bash/zsh/fish;
            // sysinfo is now the fallback for cmd.exe / PowerShell and the
            // safety net that fills in git_branch / process_name.
            thread::sleep(Duration::from_secs(5));

            // Refresh process info
            sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing()
                    .with_cmd(UpdateKind::OnlyIfNotSet)
                    .with_cwd(UpdateKind::OnlyIfNotSet),
            );
            let child_index = build_child_index(&sys);

            let pids = manager.iter_pids();

            for (session_id, pid_opt) in pids {
                if let Some(pid) = pid_opt {
                    // Resolve the foreground (deepest child) PID once per tick and
                    // reuse it for both CWD and process-name lookups — each helper
                    // previously re-walked the entire process table on its own.
                    let shell_pid = Pid::from_u32(pid);
                    let fg_pid = deepest_child_pid(&sys, &child_index, shell_pid);
                    let process_name = get_foreground_process_name(&sys, fg_pid);
                    let foreground_agent = agent_kind_from_process(&sys, fg_pid)
                        .map(|kind| (kind, fg_pid))
                        .or_else(|| find_agent_descendant(&sys, &child_index, shell_pid));
                    let agent_active = foreground_agent.is_some();
                    let cwd_pid = foreground_agent
                        .map(|(_, agent_pid)| agent_pid)
                        .unwrap_or(fg_pid);
                    let cwd = match get_process_cwd(&sys, shell_pid, cwd_pid) {
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

                    // Detect coding-agent session IDs only while that agent is foreground.
                    // When an agent exits, preserve the last ID in backend metadata; the
                    // frontend clears it when the foreground process returns to a shell.
                    match foreground_agent {
                        Some((kind, agent_pid)) => {
                            if cached_detected_agent_session_id(
                                &detected_agent_sessions,
                                &session_id,
                                agent_pid,
                                kind,
                            )
                            .is_none()
                            {
                                detected_agent_sessions.remove(&session_id);
                            }
                        }
                        None => {
                            detected_agent_sessions.remove(&session_id);
                        }
                    }
                    let previous_metadata = last_metadata.get(&session_id);
                    let previous_agent_kind = previous_metadata.and_then(|m| m.agent_kind.clone());
                    let previous_agent_session_id =
                        previous_metadata.and_then(|m| m.agent_session_id.clone());
                    let previous_claude_session_id =
                        previous_metadata.and_then(|m| m.claude_session_id.clone());
                    // Floor for the mtime-newest fallback: only session files
                    // created after this agent process started may be adopted.
                    // 30s slack absorbs clock/accounting skew.
                    let agent_min_created = foreground_agent.and_then(|(_, agent_pid)| {
                        sys.process(agent_pid).map(|process| {
                            std::time::UNIX_EPOCH
                                + Duration::from_secs(process.start_time().saturating_sub(30))
                        })
                    });
                    let (agent_kind, agent_session_id, claude_session_id) = match foreground_agent {
                        Some((kind, agent_pid)) => match kind {
                            DetectedAgentKind::ClaudeCodex => {
                                let detected = session_id_from_agent_args(&sys, agent_pid, false)
                                    .or_else(|| {
                                        cached_detected_agent_session_id(
                                            &detected_agent_sessions,
                                            &session_id,
                                            agent_pid,
                                            kind,
                                        )
                                    })
                                    .or_else(|| {
                                        detect_claude_codex_session_id(&cwd, agent_min_created)
                                    });
                                remember_detected_agent_session_id(
                                    &mut detected_agent_sessions,
                                    &session_id,
                                    agent_pid,
                                    kind,
                                    &detected,
                                );
                                let previous_same_kind_session =
                                    if previous_agent_kind.as_deref() == Some("claude-codex") {
                                        previous_agent_session_id.clone()
                                    } else {
                                        None
                                    };
                                let agent_session_id = detected.or(previous_same_kind_session);
                                (
                                    agent_session_id
                                        .as_ref()
                                        .map(|_| "claude-codex".to_string()),
                                    agent_session_id,
                                    previous_claude_session_id.clone(),
                                )
                            }
                            DetectedAgentKind::Claude => {
                                let detected = session_id_from_agent_args(&sys, agent_pid, false)
                                    .or_else(|| {
                                        cached_detected_agent_session_id(
                                            &detected_agent_sessions,
                                            &session_id,
                                            agent_pid,
                                            kind,
                                        )
                                    })
                                    .or_else(|| detect_claude_session_id(&cwd, agent_min_created));
                                remember_detected_agent_session_id(
                                    &mut detected_agent_sessions,
                                    &session_id,
                                    agent_pid,
                                    kind,
                                    &detected,
                                );
                                let claude_session_id =
                                    detected.or_else(|| previous_claude_session_id.clone());
                                let previous_same_kind_session =
                                    if previous_agent_kind.as_deref() == Some("claude") {
                                        previous_agent_session_id.clone()
                                    } else {
                                        None
                                    };
                                (
                                    claude_session_id.as_ref().map(|_| "claude".to_string()),
                                    claude_session_id.clone().or(previous_same_kind_session),
                                    claude_session_id,
                                )
                            }
                            DetectedAgentKind::Codex => {
                                let detected = session_id_from_agent_args(&sys, agent_pid, true)
                                    .or_else(|| {
                                        cached_detected_agent_session_id(
                                            &detected_agent_sessions,
                                            &session_id,
                                            agent_pid,
                                            kind,
                                        )
                                    })
                                    .or_else(|| detect_codex_session_id(&cwd, agent_min_created));
                                remember_detected_agent_session_id(
                                    &mut detected_agent_sessions,
                                    &session_id,
                                    agent_pid,
                                    kind,
                                    &detected,
                                );
                                let previous_same_kind_session =
                                    if previous_agent_kind.as_deref() == Some("codex") {
                                        previous_agent_session_id.clone()
                                    } else {
                                        None
                                    };
                                let agent_session_id = detected.or(previous_same_kind_session);
                                (
                                    agent_session_id.as_ref().map(|_| "codex".to_string()),
                                    agent_session_id,
                                    previous_claude_session_id.clone(),
                                )
                            }
                        },
                        None => (
                            previous_agent_kind.clone(),
                            previous_agent_session_id.clone(),
                            previous_claude_session_id.clone(),
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

                    if let (Some(kind), Some(current_agent_session_id)) =
                        (agent_kind.as_deref(), agent_session_id.as_deref())
                    {
                        if previous_agent_kind.as_deref() != Some(kind)
                            || previous_agent_session_id.as_deref()
                                != Some(current_agent_session_id)
                        {
                            write_detected_agent_session_mapping(
                                &session_id,
                                kind,
                                current_agent_session_id,
                            );
                        }
                    }

                    let metadata = PtyMetadata {
                        session_id: session_id.clone(),
                        cwd: cwd.clone(),
                        git_branch: git_branch.clone(),
                        process_name: process_name.clone(),
                        agent_active,
                        claude_session_id: claude_session_id.clone(),
                        agent_kind: agent_kind.clone(),
                        agent_session_id: agent_session_id.clone(),
                    };

                    let changed = match last_metadata.get(&session_id) {
                        Some(old) => {
                            old.cwd != cwd
                                || old.git_branch != git_branch
                                || old.process_name != process_name
                                || old.agent_active != agent_active
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
            detected_agent_sessions.retain(|k, _| active_keys.contains(k));
            metadata_store.retain(|k, _| active_keys.contains(k));
        }
    });
}
