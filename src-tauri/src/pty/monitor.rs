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

fn min_created_local_date(min_created: Option<std::time::SystemTime>) -> Option<(i32, u32, u32)> {
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
    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.2));
    candidates
}

fn newest_jsonl_session_id_for_cwd_in_dir(
    project_dir: &std::path::Path,
    cwd: &str,
    min_created: Option<std::time::SystemTime>,
    excluded_session_ids: &HashSet<String>,
) -> Option<String> {
    let candidates = newest_jsonl_candidates_in_dir(project_dir, min_created);
    let newest = candidates
        .iter()
        .find(|(id, _, _)| !excluded_session_ids.contains(id))
        .map(|(id, _, _)| id.clone());
    let cwd_key = normalize_cwd_key(cwd);
    let mut readable_cwd_count = 0;
    for (session_id, path, _) in candidates {
        if excluded_session_ids.contains(&session_id) {
            continue;
        }
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
    excluded_session_ids: &HashSet<String>,
) -> Option<String> {
    let home = dirs::home_dir()?;
    let mangled = super::path_norm::claude_project_key(cwd);
    let project_dir = home.join(".claude").join("projects").join(&mangled);
    if !project_dir.exists() {
        return None;
    }

    detect_claude_session_id_in_dir(&project_dir, cwd, min_created, excluded_session_ids)
}

fn detect_claude_session_id_in_dir(
    project_dir: &std::path::Path,
    cwd: &str,
    min_created: Option<std::time::SystemTime>,
    excluded_session_ids: &HashSet<String>,
) -> Option<String> {
    newest_jsonl_session_id_for_cwd_in_dir(project_dir, cwd, min_created, excluded_session_ids)
}

fn detect_claude_codex_session_id(
    cwd: &str,
    min_created: Option<std::time::SystemTime>,
    excluded_session_ids: &HashSet<String>,
) -> Option<String> {
    let home = dirs::home_dir()?;
    let mangled = super::path_norm::claude_project_key(cwd);
    let project_dir = home
        .join(".claude-codex")
        .join("config")
        .join("projects")
        .join(&mangled);
    if !project_dir.exists() {
        return None;
    }

    detect_claude_codex_session_id_in_dir(&project_dir, cwd, min_created, excluded_session_ids)
}

fn detect_claude_codex_session_id_in_dir(
    project_dir: &std::path::Path,
    cwd: &str,
    min_created: Option<std::time::SystemTime>,
    excluded_session_ids: &HashSet<String>,
) -> Option<String> {
    newest_jsonl_session_id_for_cwd_in_dir(project_dir, cwd, min_created, excluded_session_ids)
}

fn detect_claude_family_session_id(
    cwd: &str,
    min_created: Option<std::time::SystemTime>,
    excluded_session_ids: &HashSet<String>,
) -> Option<AgentSessionAttribution> {
    detect_claude_family_session_id_with(
        || detect_claude_session_id(cwd, min_created, excluded_session_ids),
        || detect_claude_codex_session_id(cwd, min_created, excluded_session_ids),
    )
}

fn detect_claude_family_session_id_with<F, G>(
    detect_claude: F,
    detect_claude_codex: G,
) -> Option<AgentSessionAttribution>
where
    F: FnOnce() -> Option<String>,
    G: FnOnce() -> Option<String>,
{
    detect_claude()
        .map(|session_id| AgentSessionAttribution::new("claude", session_id))
        .or_else(|| {
            detect_claude_codex()
                .map(|session_id| AgentSessionAttribution::new("claude-codex", session_id))
        })
}

#[cfg(test)]
fn detect_claude_family_session_id_in_dirs(
    claude_project_dir: &std::path::Path,
    claude_codex_project_dir: &std::path::Path,
    cwd: &str,
    min_created: Option<std::time::SystemTime>,
    excluded_session_ids: &HashSet<String>,
) -> Option<AgentSessionAttribution> {
    detect_claude_family_session_id_with(
        || {
            detect_claude_session_id_in_dir(
                claude_project_dir,
                cwd,
                min_created,
                excluded_session_ids,
            )
        },
        || {
            detect_claude_codex_session_id_in_dir(
                claude_codex_project_dir,
                cwd,
                min_created,
                excluded_session_ids,
            )
        },
    )
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
    excluded_session_ids: &HashSet<String>,
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
            visit_codex_sessions_dir(&path, cwd_key, min_created, excluded_session_ids, best);
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
        if excluded_session_ids.contains(&session_id) {
            continue;
        }
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
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
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
        if let (Some(day), Some(month_name)) = (
            parse_date_component(&name, 1, 31),
            path_component_string(month_dir),
        ) {
            if let Some(year_dir) = month_dir.parent() {
                if let (Some(month), Some(year_name)) = (
                    parse_date_component(&month_name, 1, 12),
                    path_component_string(year_dir),
                ) {
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

fn detect_codex_session_id(
    cwd: &str,
    min_created: Option<std::time::SystemTime>,
    excluded_session_ids: &HashSet<String>,
) -> Option<String> {
    let home = dirs::home_dir()?;
    let sessions_dir = home.join(".codex").join("sessions");
    if !sessions_dir.exists() {
        return None;
    }
    let cwd_key = normalize_cwd_key(cwd);
    let mut best: Option<(String, std::time::SystemTime)> = None;
    visit_codex_sessions_dir(
        &sessions_dir,
        &cwd_key,
        min_created,
        excluded_session_ids,
        &mut best,
    );
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

#[derive(Clone, Debug, PartialEq, Eq)]
struct AgentSessionAttribution {
    agent_kind: &'static str,
    session_id: String,
}

impl AgentSessionAttribution {
    fn new(agent_kind: &'static str, session_id: String) -> Self {
        Self {
            agent_kind,
            session_id,
        }
    }
}

fn mapping_matches_detected_agent_kind(
    mapping: &AgentSessionMapping,
    agent_kind: DetectedAgentKind,
) -> bool {
    matches!(
        (mapping.agent_kind.as_deref(), agent_kind),
        (Some("codex"), DetectedAgentKind::Codex)
            | (Some("claude"), DetectedAgentKind::Claude)
            | (Some("claude-codex"), DetectedAgentKind::Claude)
            | (Some("claude-codex"), DetectedAgentKind::ClaudeCodex)
            // Prefix-less mapping files predate agent_kind and were Claude-only.
            | (None, DetectedAgentKind::Claude)
    )
}

fn mapped_agent_session_owners(
    mappings: &HashMap<String, AgentSessionMapping>,
) -> HashMap<String, HashSet<String>> {
    let mut owners = HashMap::<String, HashSet<String>>::new();
    for (pty_session_key, mapping) in mappings {
        owners
            .entry(mapping.session_id.clone())
            .or_default()
            .insert(pty_session_key.clone());
    }
    owners
}

fn mapped_agent_session_id_for_pane(
    mappings: &HashMap<String, AgentSessionMapping>,
    pty_session_key: &str,
    agent_kind: DetectedAgentKind,
    excluded_session_ids: &HashSet<String>,
) -> Option<String> {
    mappings
        .get(pty_session_key)
        .filter(|mapping| mapping_matches_detected_agent_kind(mapping, agent_kind))
        .map(|mapping| mapping.session_id.clone())
        .filter(|session_id| !excluded_session_ids.contains(session_id))
}

fn mapped_agent_session_attribution_for_pane(
    mappings: &HashMap<String, AgentSessionMapping>,
    pty_session_key: &str,
    agent_kind: DetectedAgentKind,
    excluded_session_ids: &HashSet<String>,
    exact_session_id: Option<&str>,
) -> Option<AgentSessionAttribution> {
    mappings
        .get(pty_session_key)
        .filter(|mapping| mapping_matches_detected_agent_kind(mapping, agent_kind))
        .filter(|mapping| {
            !excluded_session_ids.contains(&mapping.session_id)
                || exact_session_id == Some(mapping.session_id.as_str())
        })
        .map(|mapping| {
            let agent_kind = match mapping.agent_kind.as_deref() {
                Some("claude-codex") => "claude-codex",
                Some("codex") => "codex",
                Some("claude") | None => "claude",
                Some(_) => unreachable!("incompatible mapping kind was already filtered"),
            };
            AgentSessionAttribution::new(agent_kind, mapping.session_id.clone())
        })
}

fn detection_exclusions_for_exact_session(
    excluded_session_ids: &HashSet<String>,
    exact_session_id: Option<&str>,
) -> HashSet<String> {
    let mut detection_exclusions = excluded_session_ids.clone();
    if let Some(exact_session_id) = exact_session_id {
        detection_exclusions.remove(exact_session_id);
    }
    detection_exclusions
}

fn select_claude_process_attribution<F>(
    mapped: Option<AgentSessionAttribution>,
    exact_session_id: Option<String>,
    cached_session_id: Option<String>,
    previous_agent_kind: Option<&str>,
    previous_session_id: Option<String>,
    excluded_session_ids: &HashSet<String>,
    detect: F,
) -> Option<AgentSessionAttribution>
where
    F: FnOnce() -> Option<AgentSessionAttribution>,
{
    if mapped.as_ref().is_some_and(|value| {
        value.agent_kind == "claude-codex"
            || exact_session_id.as_deref() == Some(value.session_id.as_str())
    }) {
        return mapped;
    }

    let previous_is_claude_codex = previous_agent_kind == Some("claude-codex");
    let previous_session_id = previous_session_id
        .filter(|candidate| !excluded_session_ids.contains(candidate));
    let cached_session_id =
        cached_session_id.filter(|candidate| !excluded_session_ids.contains(candidate));

    if exact_session_id.is_none() {
        if let Some(mapped) = mapped {
            return Some(mapped);
        }
        if let Some(cached_session_id) = cached_session_id {
            let cached_kind = if previous_is_claude_codex
                && previous_session_id.as_deref() == Some(cached_session_id.as_str())
            {
                "claude-codex"
            } else {
                "claude"
            };
            return Some(AgentSessionAttribution::new(cached_kind, cached_session_id));
        }
    }

    let detected = detect();
    if let Some(exact_session_id) = exact_session_id {
        if detected
            .as_ref()
            .is_some_and(|value| value.session_id == exact_session_id)
        {
            return detected;
        }
        let exact_kind = if previous_is_claude_codex
            && previous_session_id.as_deref() == Some(exact_session_id.as_str())
        {
            "claude-codex"
        } else {
            "claude"
        };
        return Some(AgentSessionAttribution::new(exact_kind, exact_session_id));
    }
    if let Some(detected) = detected {
        return Some(detected);
    }

    let previous_kind = match previous_agent_kind {
        Some("claude-codex") => "claude-codex",
        Some("claude") => "claude",
        _ => return None,
    };
    previous_session_id
        .map(|session_id| AgentSessionAttribution::new(previous_kind, session_id))
}

fn mapping_matches_agent_session(
    mappings: &HashMap<String, AgentSessionMapping>,
    pty_session_key: &str,
    agent_kind: &str,
    agent_session_id: &str,
) -> bool {
    mappings.get(pty_session_key).is_some_and(|mapping| {
        mapping.agent_kind.as_deref().unwrap_or("claude") == agent_kind
            && mapping.session_id == agent_session_id
    })
}

fn should_write_agent_session_mapping(
    mappings: &HashMap<String, AgentSessionMapping>,
    pty_session_key: &str,
    agent_kind: &str,
    agent_session_id: &str,
) -> bool {
    !mapping_matches_agent_session(mappings, pty_session_key, agent_kind, agent_session_id)
}

fn preferred_known_agent_session_id(
    exact_session_id: Option<String>,
    mappings: &HashMap<String, AgentSessionMapping>,
    cache: &HashMap<String, DetectedAgentCacheEntry>,
    pty_session_key: &str,
    agent_pid: Pid,
    agent_kind: DetectedAgentKind,
    excluded_session_ids: &HashSet<String>,
) -> Option<String> {
    exact_session_id
        .or_else(|| {
            mapped_agent_session_id_for_pane(
                mappings,
                pty_session_key,
                agent_kind,
                excluded_session_ids,
            )
        })
        .or_else(|| {
            cached_detected_agent_session_id(cache, pty_session_key, agent_pid, agent_kind)
                .filter(|candidate| !excluded_session_ids.contains(candidate))
        })
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

fn reserve_cached_agent_session_ids(
    cache: &mut HashMap<String, DetectedAgentCacheEntry>,
    explicit_claims: &HashSet<String>,
) -> HashMap<String, String> {
    // Exact live-process claims supersede heuristic cache entries. Removing
    // those entries also prevents a stale owner from reclaiming the ID later.
    cache.retain(|_, entry| !explicit_claims.contains(&entry.session_id));
    cache
        .iter()
        .map(|(pty_session_key, entry)| (entry.session_id.clone(), pty_session_key.clone()))
        .collect()
}

fn agent_session_id_exclusions_for_pane(
    claimed_session_ids: &HashSet<String>,
    cached_session_owners: &HashMap<String, String>,
    mapped_session_owners: &HashMap<String, HashSet<String>>,
    pty_session_key: &str,
) -> HashSet<String> {
    let mut excluded = claimed_session_ids.clone();
    excluded.extend(
        cached_session_owners
            .iter()
            .filter(|(_, owner)| owner.as_str() != pty_session_key)
            .map(|(session_id, _)| session_id.clone()),
    );
    excluded.extend(
        mapped_session_owners
            .iter()
            .filter(|(_, owners)| owners.iter().any(|owner| owner.as_str() != pty_session_key))
            .map(|(session_id, _)| session_id.clone()),
    );
    excluded
}

fn detect_agent_session_id_with_negative_ttl<T, F>(
    cache: &mut HashMap<String, FailedDetectedAgentCacheEntry>,
    session_id: &str,
    agent_pid: Pid,
    agent_kind: DetectedAgentKind,
    detect: F,
) -> Option<T>
where
    F: FnOnce() -> Option<T>,
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
fn session_id_from_args(args: &[String], allow_bare_uuid: bool) -> Option<String> {
    let forks_session = args
        .iter()
        .any(|arg| arg.eq_ignore_ascii_case("--fork-session"));
    for (i, arg) in args.iter().enumerate() {
        let lower = arg.to_ascii_lowercase();
        let is_resume_flag = lower == "--resume" || lower == "-r";
        if lower == "--session-id" || (is_resume_flag && !forks_session) {
            if let Some(next) = args.get(i + 1) {
                let candidate = next.strip_prefix("sid:").unwrap_or(next);
                if is_uuid_like(candidate) {
                    return Some(candidate.to_string());
                }
            }
        }
        for prefix in ["--session-id=", "--resume=", "-r="] {
            if let Some(candidate) = lower.strip_prefix(prefix) {
                if prefix != "--session-id=" && forks_session {
                    continue;
                }
                let candidate = candidate.strip_prefix("sid:").unwrap_or(candidate);
                if is_uuid_like(candidate) {
                    return Some(candidate.to_string());
                }
            }
        }
    }
    if !allow_bare_uuid || forks_session {
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
    session_id_from_args(&args, allow_bare_uuid)
}

fn collect_explicit_agent_session_ids(sys: &System) -> HashSet<String> {
    sys.processes()
        .keys()
        .filter_map(|pid| {
            let kind = agent_kind_from_process(sys, *pid)?;
            session_id_from_agent_args(sys, *pid, kind == DetectedAgentKind::Codex)
        })
        .collect()
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
            // Reserve every process-exact ID before per-pane fallback detection.
            // This prevents several --continue agents sharing a CWD from all
            // adopting the session that an exact --session-id process owns.
            let explicit_agent_session_ids = collect_explicit_agent_session_ids(&sys);
            let cached_agent_session_owners = reserve_cached_agent_session_ids(
                &mut detected_agent_sessions,
                &explicit_agent_session_ids,
            );
            let mut claimed_agent_session_ids = explicit_agent_session_ids;

            let pids = manager.iter_pids();
            let agent_mappings = crate::commands::session_mapping::agent_mappings_for_ids(
                pids.iter().map(|(session_id, _)| session_id.as_str()),
            );
            let mapped_session_owners = mapped_agent_session_owners(&agent_mappings);

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
                    let excluded_agent_session_ids = agent_session_id_exclusions_for_pane(
                        &claimed_agent_session_ids,
                        &cached_agent_session_owners,
                        &mapped_session_owners,
                        &session_id,
                    );
                    let (agent_kind, agent_session_id, claude_session_id) = match foreground_agent {
                        Some((kind, agent_pid)) => match kind {
                            DetectedAgentKind::ClaudeCodex => {
                                let exact = session_id_from_agent_args(&sys, agent_pid, false);
                                let detected = preferred_known_agent_session_id(
                                    exact,
                                    &agent_mappings,
                                    &detected_agent_sessions,
                                    &session_id,
                                    agent_pid,
                                    kind,
                                    &excluded_agent_session_ids,
                                )
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
                                                &excluded_agent_session_ids,
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
                                    }
                                    .filter(|candidate| {
                                        !excluded_agent_session_ids.contains(candidate)
                                    });
                                let agent_session_id = detected.or(previous_same_kind_session);
                                if let Some(candidate) = agent_session_id.as_ref() {
                                    claimed_agent_session_ids.insert(candidate.clone());
                                }
                                (
                                    agent_session_id
                                        .as_ref()
                                        .map(|_| "claude-codex".to_string()),
                                    agent_session_id,
                                    previous_claude_session_id.clone(),
                                )
                            }
                            DetectedAgentKind::Claude => {
                                let exact = session_id_from_agent_args(&sys, agent_pid, false);
                                let mapped = mapped_agent_session_attribution_for_pane(
                                    &agent_mappings,
                                    &session_id,
                                    kind,
                                    &excluded_agent_session_ids,
                                    exact.as_deref(),
                                );
                                let cached = cached_detected_agent_session_id(
                                    &detected_agent_sessions,
                                    &session_id,
                                    agent_pid,
                                    kind,
                                );
                                let previous_session_id = match previous_agent_kind.as_deref() {
                                    Some("claude-codex") => previous_agent_session_id.clone(),
                                    Some("claude") => previous_agent_session_id
                                        .clone()
                                        .or_else(|| previous_claude_session_id.clone()),
                                    _ => None,
                                };
                                let detection_exclusions = detection_exclusions_for_exact_session(
                                    &excluded_agent_session_ids,
                                    exact.as_deref(),
                                );
                                let attribution = select_claude_process_attribution(
                                    mapped,
                                    exact,
                                    cached,
                                    previous_agent_kind.as_deref(),
                                    previous_session_id,
                                    &excluded_agent_session_ids,
                                    || {
                                        detect_agent_session_id_with_negative_ttl(
                                            &mut failed_detected_agent_sessions,
                                            &session_id,
                                            agent_pid,
                                            kind,
                                            || {
                                                detect_claude_family_session_id(
                                                    &cwd,
                                                    agent_min_created,
                                                    &detection_exclusions,
                                                )
                                            },
                                        )
                                    },
                                );
                                let agent_session_id =
                                    attribution.as_ref().map(|value| value.session_id.clone());
                                remember_detected_agent_session_id(
                                    &mut detected_agent_sessions,
                                    &session_id,
                                    agent_pid,
                                    kind,
                                    &agent_session_id,
                                );
                                if let Some(candidate) = agent_session_id.as_ref() {
                                    claimed_agent_session_ids.insert(candidate.clone());
                                }
                                let claude_session_id = attribution.as_ref().and_then(|value| {
                                    if value.agent_kind == "claude" {
                                        Some(value.session_id.clone())
                                    } else {
                                        previous_claude_session_id.clone()
                                    }
                                });
                                // Process detection and session-id discovery are independent.
                                // Emit the Claude kind immediately so the UI can expose actions
                                // in a disabled state while the transcript id is still resolving.
                                let agent_kind = Some(
                                    attribution
                                        .as_ref()
                                        .map(|value| value.agent_kind)
                                        .unwrap_or("claude")
                                        .to_string(),
                                );
                                (agent_kind, agent_session_id, claude_session_id)
                            }
                            DetectedAgentKind::Codex => {
                                let exact = session_id_from_agent_args(&sys, agent_pid, true);
                                let detected = preferred_known_agent_session_id(
                                    exact,
                                    &agent_mappings,
                                    &detected_agent_sessions,
                                    &session_id,
                                    agent_pid,
                                    kind,
                                    &excluded_agent_session_ids,
                                )
                                .or_else(|| {
                                    detect_agent_session_id_with_negative_ttl(
                                        &mut failed_detected_agent_sessions,
                                        &session_id,
                                        agent_pid,
                                        kind,
                                        || {
                                            detect_codex_session_id(
                                                &cwd,
                                                agent_min_created,
                                                &excluded_agent_session_ids,
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
                                    if previous_agent_kind.as_deref() == Some("codex") {
                                        previous_agent_session_id.clone()
                                    } else {
                                        None
                                    }
                                    .filter(|candidate| {
                                        !excluded_agent_session_ids.contains(candidate)
                                    });
                                let agent_session_id = detected.or(previous_same_kind_session);
                                if let Some(candidate) = agent_session_id.as_ref() {
                                    claimed_agent_session_ids.insert(candidate.clone());
                                }
                                codex_agent_metadata_fields(
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

                    if foreground_agent.is_none()
                        && process_name.as_deref().is_some_and(is_shell_process)
                    {
                        // Failed descendant detection is not proof the agent is
                        // gone: MSYS bash orphans shebang-script children, so a
                        // live claude can be invisible here. Only drop the
                        // launcher-written mapping when no process anywhere owns
                        // the mapped session id (argv scan from this same tick).
                        let mapping_owned_by_live_process =
                            agent_mappings.get(&session_id).is_some_and(|mapping| {
                                claimed_agent_session_ids.contains(&mapping.session_id)
                            });
                        if !mapping_owned_by_live_process {
                            let _ = crate::commands::session_mapping::remove_session_mapping_file(
                                &session_id,
                            );
                        }
                    }

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
                        if should_write_agent_session_mapping(
                            &agent_mappings,
                            &session_id,
                            kind,
                            current_agent_session_id,
                        ) {
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

    #[test]
    fn codex_process_emits_kind_before_session_id_is_detected() {
        let (agent_kind, agent_session_id, claude_session_id) =
            codex_agent_metadata_fields(None, None);
        let metadata = PtyMetadata {
            session_id: "pane-session".to_string(),
            cwd: r"C:\work".to_string(),
            git_branch: None,
            process_name: Some("codex".to_string()),
            agent_active: true,
            claude_session_id,
            agent_kind,
            agent_session_id,
        };

        assert_eq!(metadata.agent_kind.as_deref(), Some("codex"));
        assert!(metadata.agent_session_id.is_none());
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
            detect_claude_session_id_in_dir(
                dir.path(),
                r"C:/Users/miyaz/work",
                None,
                &HashSet::new(),
            )
            .as_deref(),
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
            detect_claude_codex_session_id_in_dir(
                dir.path(),
                r"C:\Users\miyaz\work",
                None,
                &HashSet::new(),
            )
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
            detect_claude_session_id_in_dir(
                dir.path(),
                r"C:\Users\miyaz\three",
                None,
                &HashSet::new(),
            ),
            None
        );
    }

    #[test]
    fn detect_claude_session_id_in_dir_skips_claimed_newest_candidate() {
        let dir = tempfile::tempdir().unwrap();
        write_claude_jsonl(
            &dir.path().join("older-unclaimed.jsonl"),
            r"C:\Users\miyaz\work",
        );
        wait_for_distinct_mtime();
        write_claude_jsonl(
            &dir.path().join("newer-claimed.jsonl"),
            r"C:\Users\miyaz\work",
        );
        let excluded = HashSet::from(["newer-claimed".to_string()]);

        assert_eq!(
            detect_claude_session_id_in_dir(dir.path(), r"C:\Users\miyaz\work", None, &excluded,)
                .as_deref(),
            Some("older-unclaimed")
        );
    }

    #[test]
    fn claude_process_uses_claude_codex_mapping_authoritatively() {
        let root = tempfile::tempdir().unwrap();
        let claude_dir = root.path().join("claude");
        let claude_codex_dir = root.path().join("claude-codex");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::create_dir_all(&claude_codex_dir).unwrap();
        write_claude_jsonl(
            &claude_dir.join("plain-dir-session.jsonl"),
            r"C:\Users\miyaz\work",
        );
        write_claude_jsonl(
            &claude_codex_dir.join("codex-dir-session.jsonl"),
            r"C:\Users\miyaz\work",
        );
        let mappings = HashMap::from([(
            "pane-a".to_string(),
            AgentSessionMapping {
                agent_kind: Some("claude-codex".to_string()),
                session_id: "mapped-session".to_string(),
            },
        )]);
        let excluded = HashSet::new();
        let exact = Some("exact-session".to_string());
        let mapped = mapped_agent_session_attribution_for_pane(
            &mappings,
            "pane-a",
            DetectedAgentKind::Claude,
            &excluded,
            exact.as_deref(),
        );

        let attribution = select_claude_process_attribution(
            mapped,
            exact,
            None,
            None,
            None,
            &excluded,
            || {
                detect_claude_family_session_id_in_dirs(
                    &claude_dir,
                    &claude_codex_dir,
                    r"C:\Users\miyaz\work",
                    None,
                    &excluded,
                )
            },
        );

        assert_eq!(
            attribution,
            Some(AgentSessionAttribution::new(
                "claude-codex",
                "mapped-session".to_string(),
            ))
        );
    }

    #[test]
    fn claude_process_falls_back_to_claude_codex_project_dir() {
        let root = tempfile::tempdir().unwrap();
        let claude_dir = root.path().join("claude");
        let claude_codex_dir = root.path().join("claude-codex");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::create_dir_all(&claude_codex_dir).unwrap();
        write_claude_jsonl(
            &claude_codex_dir.join("codex-dir-session.jsonl"),
            r"C:\Users\miyaz\work",
        );
        let excluded = HashSet::from(["codex-dir-session".to_string()]);
        let detection_exclusions =
            detection_exclusions_for_exact_session(&excluded, Some("codex-dir-session"));

        let attribution = select_claude_process_attribution(
            None,
            Some("codex-dir-session".to_string()),
            None,
            None,
            None,
            &excluded,
            || {
                detect_claude_family_session_id_in_dirs(
                    &claude_dir,
                    &claude_codex_dir,
                    r"C:\Users\miyaz\work",
                    None,
                    &detection_exclusions,
                )
            },
        );

        assert_eq!(
            attribution,
            Some(AgentSessionAttribution::new(
                "claude-codex",
                "codex-dir-session".to_string(),
            ))
        );
    }

    #[test]
    fn claude_process_preserves_previous_claude_codex_identity() {
        let root = tempfile::tempdir().unwrap();
        let claude_dir = root.path().join("claude");
        let claude_codex_dir = root.path().join("claude-codex");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::create_dir_all(&claude_codex_dir).unwrap();
        let excluded = HashSet::new();

        let attribution = select_claude_process_attribution(
            None,
            None,
            None,
            Some("claude-codex"),
            Some("previous-codex-session".to_string()),
            &excluded,
            || {
                detect_claude_family_session_id_in_dirs(
                    &claude_dir,
                    &claude_codex_dir,
                    r"C:\Users\miyaz\work",
                    None,
                    &excluded,
                )
            },
        );

        assert_eq!(
            attribution,
            Some(AgentSessionAttribution::new(
                "claude-codex",
                "previous-codex-session".to_string(),
            ))
        );
    }

    #[test]
    fn plain_claude_session_wins_when_both_project_dirs_match() {
        let root = tempfile::tempdir().unwrap();
        let claude_dir = root.path().join("claude");
        let claude_codex_dir = root.path().join("claude-codex");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::create_dir_all(&claude_codex_dir).unwrap();
        write_claude_jsonl(
            &claude_dir.join("plain-dir-session.jsonl"),
            r"C:\Users\miyaz\work",
        );
        wait_for_distinct_mtime();
        write_claude_jsonl(
            &claude_codex_dir.join("newer-codex-dir-session.jsonl"),
            r"C:\Users\miyaz\work",
        );
        let excluded = HashSet::new();

        let attribution = select_claude_process_attribution(
            None,
            None,
            None,
            None,
            None,
            &excluded,
            || {
                detect_claude_family_session_id_in_dirs(
                    &claude_dir,
                    &claude_codex_dir,
                    r"C:\Users\miyaz\work",
                    None,
                    &excluded,
                )
            },
        );

        assert_eq!(
            attribution,
            Some(AgentSessionAttribution::new(
                "claude",
                "plain-dir-session".to_string(),
            ))
        );
    }

    #[test]
    fn plain_claude_exact_session_wins_over_stale_plain_mapping() {
        let root = tempfile::tempdir().unwrap();
        let claude_dir = root.path().join("claude");
        let claude_codex_dir = root.path().join("claude-codex");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::create_dir_all(&claude_codex_dir).unwrap();
        write_claude_jsonl(
            &claude_dir.join("exact-session.jsonl"),
            r"C:\Users\miyaz\work",
        );
        let mappings = HashMap::from([(
            "pane-a".to_string(),
            AgentSessionMapping {
                agent_kind: Some("claude".to_string()),
                session_id: "stale-mapped-session".to_string(),
            },
        )]);
        let excluded = HashSet::from(["exact-session".to_string()]);
        let exact = Some("exact-session".to_string());
        let detection_exclusions =
            detection_exclusions_for_exact_session(&excluded, exact.as_deref());
        let mapped = mapped_agent_session_attribution_for_pane(
            &mappings,
            "pane-a",
            DetectedAgentKind::Claude,
            &excluded,
            exact.as_deref(),
        );

        let attribution = select_claude_process_attribution(
            mapped,
            exact,
            None,
            None,
            None,
            &excluded,
            || {
                detect_claude_family_session_id_in_dirs(
                    &claude_dir,
                    &claude_codex_dir,
                    r"C:\Users\miyaz\work",
                    None,
                    &detection_exclusions,
                )
            },
        );

        assert_eq!(
            attribution,
            Some(AgentSessionAttribution::new(
                "claude",
                "exact-session".to_string(),
            ))
        );
    }

    #[test]
    fn cached_agent_session_id_is_reserved_from_another_same_cwd_pane() {
        let dir = tempfile::tempdir().unwrap();
        write_claude_jsonl(
            &dir.path().join("older-pane-session.jsonl"),
            r"C:\Users\miyaz\work",
        );
        wait_for_distinct_mtime();
        write_claude_jsonl(
            &dir.path().join("newer-owner-session.jsonl"),
            r"C:\Users\miyaz\work",
        );
        let mut cache = HashMap::from([(
            "owner-pane".to_string(),
            DetectedAgentCacheEntry {
                agent_pid: Pid::from_u32(101),
                agent_kind: DetectedAgentKind::Claude,
                session_id: "newer-owner-session".to_string(),
            },
        )]);
        let owners = reserve_cached_agent_session_ids(&mut cache, &HashSet::new());
        let excluded = agent_session_id_exclusions_for_pane(
            &HashSet::new(),
            &owners,
            &HashMap::new(),
            "second-pane",
        );

        assert_eq!(
            detect_claude_session_id_in_dir(dir.path(), r"C:\Users\miyaz\work", None, &excluded,)
                .as_deref(),
            Some("older-pane-session")
        );
    }

    #[test]
    fn cached_agent_session_id_remains_adoptable_by_its_owner() {
        let agent_pid = Pid::from_u32(101);
        let mut cache = HashMap::from([(
            "owner-pane".to_string(),
            DetectedAgentCacheEntry {
                agent_pid,
                agent_kind: DetectedAgentKind::Claude,
                session_id: "owner-session".to_string(),
            },
        )]);
        let owners = reserve_cached_agent_session_ids(&mut cache, &HashSet::new());
        let excluded = agent_session_id_exclusions_for_pane(
            &HashSet::new(),
            &owners,
            &HashMap::new(),
            "owner-pane",
        );
        let adopted = cached_detected_agent_session_id(
            &cache,
            "owner-pane",
            agent_pid,
            DetectedAgentKind::Claude,
        )
        .filter(|candidate| !excluded.contains(candidate));

        assert_eq!(adopted.as_deref(), Some("owner-session"));
    }

    #[test]
    fn pane_mapping_prevents_cross_pane_marker_overwrite_with_empty_cache() {
        let pane_a_session = "db723e1e-618b-4566-802c-c9486f7701b7";
        let pane_b_session = "b15c0d1c-e7ae-4d8a-beeb-39dbc5437dac";
        let mappings = HashMap::from([
            (
                "pane-a".to_string(),
                AgentSessionMapping {
                    agent_kind: Some("claude".to_string()),
                    session_id: pane_a_session.to_string(),
                },
            ),
            (
                "pane-b".to_string(),
                AgentSessionMapping {
                    agent_kind: Some("claude".to_string()),
                    session_id: pane_b_session.to_string(),
                },
            ),
        ]);
        let mapped_owners = mapped_agent_session_owners(&mappings);
        let excluded = agent_session_id_exclusions_for_pane(
            &HashSet::new(),
            &HashMap::new(),
            &mapped_owners,
            "pane-a",
        );

        let detected = preferred_known_agent_session_id(
            None,
            &mappings,
            &HashMap::new(),
            "pane-a",
            Pid::from_u32(101),
            DetectedAgentKind::Claude,
            &excluded,
        )
        // This is the same-CWD newest-file result that caused the live overwrite.
        .or_else(|| (!excluded.contains(pane_b_session)).then(|| pane_b_session.to_string()));

        assert!(excluded.contains(pane_b_session));
        assert!(!excluded.contains(pane_a_session));
        assert_eq!(detected.as_deref(), Some(pane_a_session));
        assert!(mapping_matches_agent_session(
            &mappings,
            "pane-a",
            "claude",
            pane_a_session,
        ));
        assert!(!mapping_matches_agent_session(
            &mappings,
            "pane-a",
            "claude",
            pane_b_session,
        ));
        assert!(!should_write_agent_session_mapping(
            &mappings,
            "pane-a",
            "claude",
            pane_a_session,
        ));
        assert!(should_write_agent_session_mapping(
            &mappings,
            "pane-a",
            "claude",
            pane_b_session,
        ));
    }

    #[test]
    fn duplicate_mapping_is_contested_until_one_owner_is_repaired() {
        let duplicate = "b15c0d1c-e7ae-4d8a-beeb-39dbc5437dac";
        let mappings = HashMap::from([
            (
                "pane-a".to_string(),
                AgentSessionMapping {
                    agent_kind: Some("claude".to_string()),
                    session_id: duplicate.to_string(),
                },
            ),
            (
                "pane-b".to_string(),
                AgentSessionMapping {
                    agent_kind: Some("claude".to_string()),
                    session_id: duplicate.to_string(),
                },
            ),
        ]);
        let mapped_owners = mapped_agent_session_owners(&mappings);

        for pane in ["pane-a", "pane-b"] {
            let excluded = agent_session_id_exclusions_for_pane(
                &HashSet::new(),
                &HashMap::new(),
                &mapped_owners,
                pane,
            );
            assert!(excluded.contains(duplicate));
            assert_eq!(
                mapped_agent_session_id_for_pane(
                    &mappings,
                    pane,
                    DetectedAgentKind::Claude,
                    &excluded,
                ),
                None
            );
        }
    }

    #[test]
    fn explicit_claim_supersedes_another_panes_cached_reservation() {
        let explicit_session = "explicit-session".to_string();
        let explicit_claims = HashSet::from([explicit_session.clone()]);
        let mut cache = HashMap::from([(
            "cached-pane".to_string(),
            DetectedAgentCacheEntry {
                agent_pid: Pid::from_u32(101),
                agent_kind: DetectedAgentKind::Claude,
                session_id: explicit_session.clone(),
            },
        )]);

        let owners = reserve_cached_agent_session_ids(&mut cache, &explicit_claims);
        let excluded = agent_session_id_exclusions_for_pane(
            &explicit_claims,
            &owners,
            &HashMap::new(),
            "cached-pane",
        );

        assert!(!cache.contains_key("cached-pane"));
        assert!(!owners.contains_key(&explicit_session));
        assert!(excluded.contains(&explicit_session));
    }

    #[test]
    fn session_id_from_args_ignores_resume_source_when_forking() {
        let source = "85d1dd8d-0f32-410e-91da-008f1cfb82a3";
        let args = vec![
            "claude".to_string(),
            "--resume".to_string(),
            source.to_string(),
            "--fork-session".to_string(),
        ];

        assert_eq!(session_id_from_args(&args, false), None);
    }

    #[test]
    fn session_id_from_args_keeps_exact_non_fork_ids() {
        let session = "401caf0d-c8d1-4c12-b0d4-ed291d41d356";
        let args = vec![
            "claude".to_string(),
            "--session-id".to_string(),
            session.to_string(),
        ];

        assert_eq!(session_id_from_args(&args, false).as_deref(), Some(session));
    }
}
