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

fn jsonl_head_cwd(path: &std::path::Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let lines = std::io::BufReader::new(file).lines().take(32);
    for line in lines.map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if let Some(cwd) = value.get("cwd").and_then(|cwd| cwd.as_str()) {
            if !cwd.trim().is_empty() {
                return Some(cwd.to_string());
            }
        }
    }
    None
}

fn newest_jsonl_candidates_in_dir(
    project_dir: &std::path::Path,
    min_created: Option<std::time::SystemTime>,
) -> Vec<(String, std::path::PathBuf, std::time::SystemTime)> {
    let Ok(entries) = std::fs::read_dir(project_dir) else {
        return Vec::new();
    };
    let mut candidates = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !created_at_or_after(&meta, min_created) {
            continue;
        }
        let Ok(mtime) = meta.modified() else {
            continue;
        };
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        candidates.push((stem.to_string(), path, mtime));
    }
    candidates.sort_by(|left, right| right.2.cmp(&left.2));
    candidates
}

fn newest_jsonl_session_id_for_cwd_in_dir(
    project_dir: &std::path::Path,
    cwd: &str,
    min_created: Option<std::time::SystemTime>,
) -> Option<String> {
    let candidates = newest_jsonl_candidates_in_dir(project_dir, min_created);
    let newest = candidates.first().map(|(id, _, _)| id.clone());
    let cwd_key = normalize_cwd_key(cwd);
    let mut readable_cwd_count = 0;
    for (session_id, path, _) in candidates {
        let Some(candidate_cwd) = jsonl_head_cwd(&path) else {
            continue;
        };
        readable_cwd_count += 1;
        if normalize_cwd_key(&candidate_cwd) == cwd_key {
            return Some(session_id);
        }
    }
    if readable_cwd_count == 0 {
        newest
    } else {
        None
    }
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

    detect_claude_session_id_in_dir(&project_dir, cwd, min_created)
}

fn detect_claude_session_id_in_dir(
    project_dir: &std::path::Path,
    cwd: &str,
    min_created: Option<std::time::SystemTime>,
) -> Option<String> {
    newest_jsonl_session_id_for_cwd_in_dir(project_dir, cwd, min_created)
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

    detect_claude_codex_session_id_in_dir(&project_dir, cwd, min_created)
}

fn detect_claude_codex_session_id_in_dir(
    project_dir: &std::path::Path,
    cwd: &str,
    min_created: Option<std::time::SystemTime>,
) -> Option<String> {
    newest_jsonl_session_id_for_cwd_in_dir(project_dir, cwd, min_created)
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

const DETECTED_AGENT_NEGATIVE_TTL: Duration = Duration::from_secs(10);

struct FailedDetectedAgentCacheEntry {
    agent_pid: Pid,
    agent_kind: DetectedAgentKind,
    checked_at: Instant,
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

fn detect_agent_session_id_with_negative_ttl<F>(
    cache: &mut HashMap<String, FailedDetectedAgentCacheEntry>,
    session_id: &str,
    agent_pid: Pid,
    agent_kind: DetectedAgentKind,
    detect: F,
) -> Option<String>
where
    F: FnOnce() -> Option<String>,
{
    if cache.get(session_id).is_some_and(|entry| {
        entry.agent_pid == agent_pid
            && entry.agent_kind == agent_kind
            && entry.checked_at.elapsed() < DETECTED_AGENT_NEGATIVE_TTL
    }) {
        return None;
    }

    let detected = detect();
    if detected.is_some() {
        cache.remove(session_id);
    } else {
        cache.insert(
            session_id.to_string(),
            FailedDetectedAgentCacheEntry {
                agent_pid,
                agent_kind,
                checked_at: Instant::now(),
            },
        );
    }
    detected
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

/// Number of dedicated worker threads that run `git rev-parse` off the
/// monitor thread. A small fixed pool bounds concurrent `git` child
/// processes while still letting several slow CWDs resolve in parallel
/// instead of serially blocking every session behind them (RS-5).
const GIT_BRANCH_WORKER_COUNT: usize = 4;

/// A CWD that needs its git branch (re-)resolved.
struct GitBranchRequest {
    session_id: String,
    cwd: String,
}

/// Result of resolving `GitBranchRequest` on a worker thread. `cwd` is
/// echoed back so the monitor loop can tell whether the CWD moved on
/// again while the request was in flight.
struct GitBranchResult {
    session_id: String,
    cwd: String,
    git_branch: Option<String>,
}

/// Spawn the fixed-size git-detection worker pool and return the sender used
/// to submit CWD lookups. All workers pull from the same request queue (a
/// `Mutex`-guarded `Receiver`, the standard way to fan a single mpsc channel
/// out to multiple consumers) so bursts of simultaneous CWD changes are
/// resolved concurrently rather than one-at-a-time on the monitor thread.
///
/// Each worker calls `git_branch_with_timeout`, which still owns the
/// kill+wait guarantee on timeout (R-1, CHANGELOG 0.9.2) — moving the call
/// off the monitor thread does not change that guarantee, it only changes
/// which thread blocks for up to `timeout` while enforcing it.
fn spawn_git_branch_workers(
    result_tx: mpsc::Sender<GitBranchResult>,
) -> mpsc::Sender<GitBranchRequest> {
    let (request_tx, request_rx) = mpsc::channel::<GitBranchRequest>();
    let request_rx = Arc::new(Mutex::new(request_rx));

    for _ in 0..GIT_BRANCH_WORKER_COUNT {
        let request_rx = Arc::clone(&request_rx);
        let result_tx = result_tx.clone();
        thread::spawn(move || {
            loop {
                let request = {
                    // Only the `recv()` call itself needs the lock; it is
                    // released again as soon as a request is dequeued (or the
                    // channel closes), so other idle workers can immediately
                    // claim the next queued request instead of queueing
                    // behind this one's git invocation.
                    let rx = request_rx.lock().unwrap_or_else(|e| e.into_inner());
                    rx.recv()
                };
                let Ok(request) = request else {
                    // Sender dropped (monitor thread exiting) — stop the worker.
                    break;
                };
                let git_branch = git_branch_with_timeout(&request.cwd, Duration::from_secs(2));
                let sent = result_tx.send(GitBranchResult {
                    session_id: request.session_id,
                    cwd: request.cwd,
                    git_branch,
                });
                if sent.is_err() {
                    // Receiver dropped — monitor thread is gone, no point continuing.
                    break;
                }
            }
        });
    }

    request_tx
}

/// Run `git rev-parse --abbrev-ref HEAD` in `cwd` with a hard timeout.
/// The child is killed on timeout so a hung git (e.g. on a slow network
/// filesystem) does not leak a process + thread per CWD change.
fn git_branch_with_timeout(cwd: &str, timeout: Duration) -> Option<String> {
    let mut git_cmd = Command::new("git");
    git_cmd
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    git_cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = git_cmd.spawn().ok()?;
    let started_at = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = String::new();
                if let Some(mut pipe) = child.stdout.take() {
                    use std::io::Read;
                    let _ = pipe.read_to_string(&mut stdout);
                }
                return if status.success() {
                    Some(stdout.trim().to_string())
                } else {
                    None
                };
            }
            Ok(None) => {
                if started_at.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    #[cfg(debug_assertions)]
                    {
                        eprintln!("[monitor] git rev-parse timed out for {}", cwd);
                    }
                    return None;
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
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
        let mut failed_detected_agent_sessions: HashMap<String, FailedDetectedAgentCacheEntry> =
            HashMap::new();

        // RS-5: git branch detection runs on a dedicated worker pool instead
        // of inline in this loop. `git_branch_cwd` records the CWD that the
        // *last applied* git_branch in `last_metadata` corresponds to, kept
        // separate from `last_metadata`'s own `cwd` field (which is updated
        // every tick regardless of git status) so a CWD change is never lost
        // just because a request for it is still in flight — see the
        // `needs_git_check` comment below. `git_in_flight` prevents queueing
        // a second request for a session while one is already outstanding.
        let (git_result_tx, git_result_rx) = mpsc::channel::<GitBranchResult>();
        let git_request_tx = spawn_git_branch_workers(git_result_tx);
        let mut git_branch_cwd: HashMap<String, String> = HashMap::new();
        let mut git_in_flight: HashSet<String> = HashSet::new();

        loop {
            // 5s cadence: OSC 7 handles CWD instantly for bash/zsh/fish;
            // sysinfo is now the fallback for cmd.exe / PowerShell and the
            // safety net that fills in git_branch / process_name.
            thread::sleep(Duration::from_secs(5));

            // Drain any git branch lookups that finished since the last tick.
            // Applying results here (before the per-session pass) means a
            // session whose lookup just completed uses the fresh branch for
            // this tick's `changed` comparison instead of the previous 5s
            // finding out via a second, redundant emit.
            while let Ok(result) = git_result_rx.try_recv() {
                git_in_flight.remove(&result.session_id);
                git_branch_cwd.insert(result.session_id.clone(), result.cwd.clone());
                if let Some(meta) = last_metadata.get_mut(&result.session_id) {
                    if meta.git_branch != result.git_branch {
                        meta.git_branch = result.git_branch;
                        metadata_store.insert(result.session_id.clone(), meta.clone());
                        let _ = app_handle.emit("pty_metadata", meta.clone());
                    }
                }
            }

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

            for (session_id, pid_opt) in pids.iter().cloned() {
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

                    // Check if CWD changed (relative to the CWD the *current*
                    // git_branch was actually resolved for, not just the last
                    // stored metadata.cwd) to avoid spamming git commands.
                    // Using `git_branch_cwd` here — rather than
                    // `last_metadata`'s `cwd` field, which is overwritten every
                    // tick regardless of git status — means a CWD change that
                    // arrives while a request for the previous CWD is still
                    // in flight is not lost: it keeps looking "needed" every
                    // tick until a request actually gets queued for it.
                    let needs_git_check = git_branch_cwd.get(&session_id) != Some(&cwd);
                    if needs_git_check && git_in_flight.insert(session_id.clone()) {
                        // RS-5: hand the (possibly slow) git invocation to the
                        // worker pool instead of blocking this loop — other
                        // sessions' metadata keeps updating every tick even
                        // while this lookup is still running.
                        let _ = git_request_tx.send(GitBranchRequest {
                            session_id: session_id.clone(),
                            cwd: cwd.clone(),
                        });
                    }
                    // Use the last known branch (possibly stale while a
                    // lookup for a new CWD is in flight) until the worker
                    // pool reports a fresh result via `git_result_rx`.
                    let git_branch = last_metadata
                        .get(&session_id)
                        .and_then(|m| m.git_branch.clone());

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
                            failed_detected_agent_sessions.remove(&session_id);
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
                                        detect_agent_session_id_with_negative_ttl(
                                            &mut failed_detected_agent_sessions,
                                            &session_id,
                                            agent_pid,
                                            kind,
                                            || {
                                                detect_claude_codex_session_id(
                                                    &cwd,
                                                    agent_min_created,
                                                )
                                            },
                                        )
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
                                    .or_else(|| {
                                        detect_agent_session_id_with_negative_ttl(
                                            &mut failed_detected_agent_sessions,
                                            &session_id,
                                            agent_pid,
                                            kind,
                                            || detect_claude_session_id(&cwd, agent_min_created),
                                        )
                                    });
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
                                    .or_else(|| {
                                        detect_agent_session_id_with_negative_ttl(
                                            &mut failed_detected_agent_sessions,
                                            &session_id,
                                            agent_pid,
                                            kind,
                                            || detect_codex_session_id(&cwd, agent_min_created),
                                        )
                                    });
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
                pids.into_iter().map(|(k, _)| k).collect();
            last_metadata.retain(|k, _| active_keys.contains(k));
            detected_agent_sessions.retain(|k, _| active_keys.contains(k));
            failed_detected_agent_sessions.retain(|k, _| active_keys.contains(k));
            metadata_store.retain(|k, _| active_keys.contains(k));
            // git_in_flight is *not* pruned for dead sessions here: a request
            // may still be running on a worker thread, and the drain step at
            // the top of the next tick removes the entry once that request's
            // result (or the worker dropping it) comes back, regardless of
            // whether the session is still active.
            git_branch_cwd.retain(|k, _| active_keys.contains(k));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn write_jsonl(path: &std::path::Path, lines: &[serde_json::Value]) {
        let contents = lines
            .iter()
            .map(serde_json::Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        std::fs::write(path, contents).unwrap();
    }

    fn write_no_cwd_jsonl(path: &std::path::Path) {
        write_jsonl(path, &[serde_json::json!({"type": "last-prompt"})]);
    }

    fn write_claude_jsonl(path: &std::path::Path, cwd: &str) {
        write_jsonl(
            path,
            &[
                serde_json::json!({"type": "last-prompt"}),
                serde_json::json!({"type": "mode", "mode": "default"}),
                serde_json::json!({"type": "permission-mode", "permissionMode": "default"}),
                serde_json::json!({"type": "user", "cwd": cwd, "sessionId": "sid"}),
            ],
        );
    }

    fn wait_for_distinct_mtime() {
        std::thread::sleep(Duration::from_millis(25));
    }

    #[test]
    fn detect_claude_session_id_in_dir_uses_matching_cwd_not_newest() {
        let dir = tempfile::tempdir().unwrap();
        write_claude_jsonl(
            &dir.path().join("matching-session.jsonl"),
            r"C:\Users\miyaz\work",
        );
        wait_for_distinct_mtime();
        write_claude_jsonl(
            &dir.path().join("newer-other-cwd.jsonl"),
            r"C:\Users\miyaz\other",
        );

        assert_eq!(
            detect_claude_session_id_in_dir(dir.path(), r"C:/Users/miyaz/work", None).as_deref(),
            Some("matching-session")
        );
    }

    #[test]
    fn detect_claude_codex_session_id_in_dir_falls_back_to_newest_when_no_cwd_is_readable() {
        let dir = tempfile::tempdir().unwrap();
        write_no_cwd_jsonl(&dir.path().join("older-session.jsonl"));
        wait_for_distinct_mtime();
        write_no_cwd_jsonl(&dir.path().join("newer-session.jsonl"));

        assert_eq!(
            detect_claude_codex_session_id_in_dir(dir.path(), r"C:\Users\miyaz\work", None)
                .as_deref(),
            Some("newer-session")
        );
    }

    #[test]
    fn detect_claude_session_id_in_dir_returns_none_when_readable_cwds_do_not_match() {
        let dir = tempfile::tempdir().unwrap();
        write_claude_jsonl(
            &dir.path().join("first-session.jsonl"),
            r"C:\Users\miyaz\one",
        );
        wait_for_distinct_mtime();
        write_claude_jsonl(
            &dir.path().join("second-session.jsonl"),
            r"C:\Users\miyaz\two",
        );

        assert_eq!(
            detect_claude_session_id_in_dir(dir.path(), r"C:\Users\miyaz\three", None),
            None
        );
    }
}
