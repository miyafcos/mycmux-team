use super::*;

/// System/infrastructure processes to skip when detecting the foreground process.
pub(super) fn is_system_process(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let leaf = lower.strip_suffix(".exe").unwrap_or(&lower);
    matches!(
        leaf,
        "conhost" | "csrss" | "wininit" | "winlogon" | "dwm" | "fontdrvhost"
    )
}

/// Follow the newest child chain to find the foreground process PID,
/// skipping system processes like conhost.
pub(super) fn build_child_index(sys: &System) -> HashMap<Pid, Vec<Pid>> {
    let mut child_index: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, process) in sys.processes() {
        if let Some(parent) = process.parent() {
            child_index.entry(parent).or_default().push(*pid);
        }
    }
    child_index
}

pub(super) fn deepest_child_pid(sys: &System, child_index: &HashMap<Pid, Vec<Pid>>, pid: Pid) -> Pid {
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
pub(super) enum DetectedAgentKind {
    Codex = 1,
    Claude = 2,
    ClaudeCodex = 3,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct AgentSessionAttribution {
    pub(super) agent_kind: &'static str,
    pub(super) session_id: String,
}

impl AgentSessionAttribution {
    pub(super) fn new(agent_kind: &'static str, session_id: String) -> Self {
        Self {
            agent_kind,
            session_id,
        }
    }
}

pub(super) fn mapping_matches_detected_agent_kind(
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

pub(super) fn mapped_agent_session_owners(
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

pub(super) fn mapped_agent_session_id_for_pane(
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

pub(super) fn mapped_agent_session_attribution_for_pane(
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

pub(super) fn detection_exclusions_for_exact_session(
    excluded_session_ids: &HashSet<String>,
    exact_session_id: Option<&str>,
) -> HashSet<String> {
    let mut detection_exclusions = excluded_session_ids.clone();
    if let Some(exact_session_id) = exact_session_id {
        detection_exclusions.remove(exact_session_id);
    }
    detection_exclusions
}

pub(super) fn select_claude_process_attribution<F>(
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

pub(super) fn mapping_matches_agent_session(
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

pub(super) fn should_write_agent_session_mapping(
    mappings: &HashMap<String, AgentSessionMapping>,
    pty_session_key: &str,
    agent_kind: &str,
    agent_session_id: &str,
) -> bool {
    !mapping_matches_agent_session(mappings, pty_session_key, agent_kind, agent_session_id)
}

pub(super) fn preferred_known_agent_session_id(
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

pub(super) struct DetectedAgentCacheEntry {
    pub(super) agent_pid: Pid,
    pub(super) agent_kind: DetectedAgentKind,
    pub(super) session_id: String,
}

pub(super) const DETECTED_AGENT_NEGATIVE_TTL: Duration = Duration::from_secs(10);

pub(super) struct FailedDetectedAgentCacheEntry {
    pub(super) agent_pid: Pid,
    pub(super) agent_kind: DetectedAgentKind,
    pub(super) checked_at: Instant,
}

pub(super) fn cached_detected_agent_session_id(
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

pub(super) fn remember_detected_agent_session_id(
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

pub(super) fn reserve_cached_agent_session_ids(
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

pub(super) fn agent_session_id_exclusions_for_pane(
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

pub(super) fn detect_agent_session_id_with_negative_ttl<T, F>(
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

pub(super) fn agent_kind_from_process(sys: &System, pid: Pid) -> Option<DetectedAgentKind> {
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
pub(super) fn is_uuid_like(value: &str) -> bool {
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
pub(super) fn session_id_from_args(args: &[String], allow_bare_uuid: bool) -> Option<String> {
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

pub(super) fn session_id_from_agent_args(
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

pub(super) fn collect_explicit_agent_session_ids(sys: &System) -> HashSet<String> {
    sys.processes()
        .keys()
        .filter_map(|pid| {
            let kind = agent_kind_from_process(sys, *pid)?;
            session_id_from_agent_args(sys, *pid, kind == DetectedAgentKind::Codex)
        })
        .collect()
}

pub(super) fn find_agent_descendant(
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
pub(super) fn get_process_cwd(sys: &System, shell_pid: Pid, fg_pid: Pid) -> Option<String> {
    // Try foreground process CWD first, fall back to shell CWD
    sys.process(fg_pid)
        .and_then(|p| p.cwd().map(|c| c.to_string_lossy().to_string()))
        .or_else(|| {
            sys.process(shell_pid)
                .and_then(|p| p.cwd().map(|c| c.to_string_lossy().to_string()))
        })
}

/// Get the foreground process name for an already-resolved foreground PID.
pub(super) fn get_foreground_process_name(sys: &System, foreground_pid: Pid) -> Option<String> {
    sys.process(foreground_pid)
        .map(|p| p.name().to_string_lossy().to_string())
}
