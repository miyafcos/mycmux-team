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

pub(super) fn deepest_child_pid(
    sys: &System,
    child_index: &HashMap<Pid, Vec<Pid>>,
    pid: Pid,
) -> Pid {
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum DetectedAgentKind {
    Codex = 1,
    Claude = 2,
    ClaudeCodex = 3,
    Grok = 4,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum AgentDetectionSource {
    InterpreterScript,
    ExecutableName,
}

#[derive(Clone, Copy)]
struct AgentDescendantCandidate {
    kind: DetectedAgentKind,
    pid: Pid,
    depth: usize,
    source: AgentDetectionSource,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct AgentSessionAttribution {
    pub(super) agent_kind: &'static str,
    pub(super) session_id: String,
    hook_confirmed: bool,
}

impl AgentSessionAttribution {
    pub(super) fn new(agent_kind: &'static str, session_id: String) -> Self {
        Self {
            agent_kind,
            session_id,
            hook_confirmed: false,
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
            | (Some("grok"), DetectedAgentKind::Grok)
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
            mapping.hook_confirmed || !excluded_session_ids.contains(&mapping.session_id)
                || exact_session_id == Some(mapping.session_id.as_str())
        })
        .map(|mapping| {
            let agent_kind = match mapping.agent_kind.as_deref() {
                Some("claude-codex") => "claude-codex",
                Some("codex") => "codex",
                Some("grok") => "grok",
                Some("claude") | None => "claude",
                Some(_) => unreachable!("incompatible mapping kind was already filtered"),
            };
            let mut attribution = AgentSessionAttribution::new(agent_kind, mapping.session_id.clone());
            attribution.hook_confirmed = mapping.hook_confirmed;
            attribution
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

/// Claude and claude-codex are the same process identity, so the kind of a bare
/// session id is decided by what this pane reported on the previous tick.
pub(super) fn claude_family_kind_for(
    previous_agent_kind: Option<&str>,
    previous_session_id: Option<&str>,
    candidate: &str,
) -> &'static str {
    if previous_agent_kind == Some("claude-codex") && previous_session_id == Some(candidate) {
        "claude-codex"
    } else {
        "claude"
    }
}

/// Resolve both native Claude and explicitly detected claude-codex processes.
pub(super) fn claude_process_kind_for(
    process_kind: DetectedAgentKind,
    previous_agent_kind: Option<&str>,
    previous_session_id: Option<&str>,
    candidate: &str,
) -> &'static str {
    if process_kind == DetectedAgentKind::ClaudeCodex {
        "claude-codex"
    } else {
        claude_family_kind_for(previous_agent_kind, previous_session_id, candidate)
    }
}

/// Once a provider root is known, a successor must stay in that root.
pub(super) fn claude_process_uses_codex_root(
    kind: DetectedAgentKind,
    pinned: Option<&AgentSessionAttribution>,
) -> bool {
    kind == DetectedAgentKind::ClaudeCodex
        || pinned.is_some_and(|value| value.agent_kind == "claude-codex")
}

/// A native Claude process may continue an already grounded claude-codex
/// mapping. A scan alone must not change a plain Claude pane's provider.
pub(super) fn mapping_kind_is_grounded_for_pane(
    mappings: &HashMap<String, AgentSessionMapping>,
    pane: &str,
    mapping_kind: &str,
    detected_kind: DetectedAgentKind,
) -> bool {
    mapping_kind_is_grounded_in_detected_process(mapping_kind, detected_kind)
        || (detected_kind == DetectedAgentKind::Claude
            && mapping_kind == "claude-codex"
            && mappings.get(pane).is_some_and(|mapping| {
                mapping.agent_kind.as_deref() == Some("claude-codex")
            }))
}

/// Pick the session id a Claude pane is showing.
///
/// A pane is normally pinned to the id captured at launch — the launcher's
/// mapping file, or `--session-id` / `--resume` in the agent's argv. Both are
/// frozen at launch, so when the CLI rolls its session id over mid-run the pane
/// stays bolted to a transcript that never grows again and its chat column
/// freezes at the moment of the rollover.
///
/// `transcript_is_stale(agent_kind, session_id)` answers "that transcript has
/// gone silent" (see `transcript_is_silent`). Only then is the pin allowed to
/// move, and only onto whatever `detect` returns — a scan the caller floors at
/// the pinned transcript's last write and filters through the exclusion set, so
/// it cannot reach a conversation that was alive alongside the pinned one or
/// that another pane already owns. A silent pin is still returned as the last
/// resort when the scan finds nothing: a frozen transcript beats none.
pub(super) fn select_claude_process_attribution<F, S>(
    process_kind: DetectedAgentKind,
    mapped: Option<AgentSessionAttribution>,
    exact_session_id: Option<String>,
    cached_session_id: Option<String>,
    previous_agent_kind: Option<&str>,
    previous_session_id: Option<String>,
    excluded_session_ids: &HashSet<String>,
    mut transcript_is_stale: S,
    detect: F,
) -> Option<AgentSessionAttribution>
where
    F: FnOnce() -> Option<AgentSessionAttribution>,
    S: FnMut(&str, &str) -> bool,
{
    if mapped.as_ref().is_some_and(|mapping| mapping.hook_confirmed) {
        return mapped;
    }
    let mut is_stale =
        |value: &AgentSessionAttribution| transcript_is_stale(value.agent_kind, &value.session_id);
    let mapped_is_stale = mapped.as_ref().is_some_and(|value| is_stale(value));

    let previous_session_id =
        previous_session_id.filter(|candidate| !excluded_session_ids.contains(candidate));
    let cached_session_id =
        cached_session_id.filter(|candidate| !excluded_session_ids.contains(candidate));
    let family_kind = |candidate: &str| {
        claude_process_kind_for(
            process_kind,
            previous_agent_kind,
            previous_session_id.as_deref(),
            candidate,
        )
    };
    let exact_attribution = exact_session_id
        .map(|session_id| AgentSessionAttribution::new(family_kind(&session_id), session_id));
    let exact_is_stale = exact_attribution.as_ref().is_some_and(|value| is_stale(value));

    // A live mapping wins outright when it is the claude-codex identity, when
    // argv confirms it, or when argv is the frozen half of a rollover.
    if !mapped_is_stale
        && mapped.as_ref().is_some_and(|value| {
            value.agent_kind == "claude-codex"
                || exact_attribution
                    .as_ref()
                    .is_some_and(|exact| exact.session_id == value.session_id)
                || exact_is_stale
        })
    {
        return mapped;
    }

    let cached_attribution = cached_session_id
        .map(|session_id| AgentSessionAttribution::new(family_kind(&session_id), session_id));
    let cached_is_stale = cached_attribution
        .as_ref()
        .is_some_and(|value| is_stale(value));

    if exact_attribution.is_none() {
        if let Some(mapped) = mapped.clone().filter(|_| !mapped_is_stale) {
            return Some(mapped);
        }
        if let Some(cached) = cached_attribution.clone().filter(|_| !cached_is_stale) {
            return Some(cached);
        }
    }

    let detected = detect();
    if let Some(exact) = exact_attribution {
        if detected
            .as_ref()
            .is_some_and(|value| value.session_id == exact.session_id)
        {
            return detected;
        }
        if !exact_is_stale {
            return Some(exact);
        }
        if let Some(detected) = detected {
            return Some(detected);
        }
        if let Some(mapped) = mapped.filter(|_| !mapped_is_stale) {
            return Some(mapped);
        }
        return Some(exact);
    }
    if let Some(detected) = detected {
        return Some(detected);
    }
    // No successor was found: keep the silent pin rather than blanking the pane.
    if let Some(mapped) = mapped {
        return Some(mapped);
    }
    if let Some(cached) = cached_attribution {
        return Some(cached);
    }

    let previous_kind = match previous_agent_kind {
        Some("claude-codex") => "claude-codex",
        Some("claude") => "claude",
        _ => return None,
    };
    previous_session_id.map(|session_id| AgentSessionAttribution::new(previous_kind, session_id))
}

/// One tick of "hold" recorded before a pane's pinned session id may move.
pub(super) struct PendingSessionSwitch {
    pub(super) agent_pid: Pid,
    pub(super) from_session_id: String,
    pub(super) to_session_id: String,
}

pub(super) struct AgentSessionSelection {
    pub(super) attribution: Option<AgentSessionAttribution>,
    /// `Some(previous id)` only on the tick a confirmed rollover moves the pane.
    pub(super) switched_from: Option<String>,
}

/// Require the same successor twice before a pane leaves its pinned session id.
///
/// The exclusion set already reserves every id another pane owns through argv,
/// a mapping file, or last tick's detection cache. The remaining gap is an id
/// nobody has claimed *yet*: a lane whose own mapping failed to be written
/// starts its transcript, and for exactly one tick that file is unclaimed and
/// newer than a silent neighbour's. Demanding a second, identical observation
/// closes it — by then the owning pane has claimed the id through the detection
/// cache, so it is excluded here and the proposal never returns.
pub(super) fn confirm_agent_session_switch(
    pending: &mut HashMap<String, PendingSessionSwitch>,
    pty_session_key: &str,
    agent_pid: Pid,
    pinned: Option<&AgentSessionAttribution>,
    proposed: Option<AgentSessionAttribution>,
) -> AgentSessionSelection {
    let Some(pinned) = pinned else {
        pending.remove(pty_session_key);
        return AgentSessionSelection {
            attribution: proposed,
            switched_from: None,
        };
    };
    let Some(proposed) = proposed else {
        pending.remove(pty_session_key);
        return AgentSessionSelection {
            attribution: None,
            switched_from: None,
        };
    };
    if proposed.session_id == pinned.session_id {
        pending.remove(pty_session_key);
        return AgentSessionSelection {
            attribution: Some(proposed),
            switched_from: None,
        };
    }
    let confirmed = pending.get(pty_session_key).is_some_and(|entry| {
        entry.agent_pid == agent_pid
            && entry.from_session_id == pinned.session_id
            && entry.to_session_id == proposed.session_id
    });
    if confirmed {
        pending.remove(pty_session_key);
        return AgentSessionSelection {
            switched_from: Some(pinned.session_id.clone()),
            attribution: Some(proposed),
        };
    }
    pending.insert(
        pty_session_key.to_string(),
        PendingSessionSwitch {
            agent_pid,
            from_session_id: pinned.session_id.clone(),
            to_session_id: proposed.session_id,
        },
    );
    AgentSessionSelection {
        attribution: Some(pinned.clone()),
        switched_from: None,
    }
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
    mappings.get(pty_session_key)
        .filter(|mapping| mapping.hook_confirmed && mapping_matches_detected_agent_kind(mapping, agent_kind))
        .map(|mapping| mapping.session_id.clone())
        .or(exact_session_id)
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

fn agent_kind_from_executable_name(name: &str) -> Option<DetectedAgentKind> {
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
    if lower_name.contains("grok") {
        return Some(DetectedAgentKind::Grok);
    }
    None
}

/// Classify node/bun only from its executable and script-path arguments.
/// Prompts routinely include arbitrary filesystem paths (including `.claude`),
/// so later arguments must never participate in agent identity detection.
pub(super) fn classify_interpreter_cmdline(args: &[String]) -> Option<DetectedAgentKind> {
    let interpreter = args.first()?.to_ascii_lowercase();
    let interpreter_leaf = interpreter
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(&interpreter)
        .strip_suffix(".exe")
        .unwrap_or(&interpreter);
    if !matches!(interpreter_leaf, "node" | "bun") {
        return None;
    }
    let script_path = args.get(1)?.to_ascii_lowercase();
    if script_path.contains("@openai/codex")
        || script_path.contains("/codex")
        || script_path.contains("\\codex")
    {
        return Some(DetectedAgentKind::Codex);
    }
    if script_path.contains("claude-codex") {
        return Some(DetectedAgentKind::ClaudeCodex);
    }
    if script_path.contains("claude") {
        return Some(DetectedAgentKind::Claude);
    }
    None
}

fn agent_detection_from_process(
    sys: &System,
    pid: Pid,
) -> Option<(DetectedAgentKind, AgentDetectionSource)> {
    let process = sys.process(pid)?;
    let name = process.name().to_string_lossy();
    if is_system_process(&name) || is_shell_process(&name) {
        return None;
    }
    if let Some(kind) = agent_kind_from_executable_name(&name) {
        return Some((kind, AgentDetectionSource::ExecutableName));
    }
    let args = process
        .cmd()
        .iter()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect::<Vec<String>>();
    classify_interpreter_cmdline(&args).map(|kind| (kind, AgentDetectionSource::InterpreterScript))
}

pub(super) fn agent_kind_from_process(sys: &System, pid: Pid) -> Option<DetectedAgentKind> {
    agent_detection_from_process(sys, pid).map(|(kind, _)| kind)
}

pub(super) fn mapping_kind_is_grounded_in_detected_process(
    mapping_kind: &str,
    detected_kind: DetectedAgentKind,
) -> bool {
    matches!(
        (mapping_kind, detected_kind),
        ("codex", DetectedAgentKind::Codex)
            | ("claude", DetectedAgentKind::Claude)
            | ("claude-codex", DetectedAgentKind::ClaudeCodex)
            | ("grok", DetectedAgentKind::Grok)
    )
}

pub(super) use crate::util::ids::is_uuid_like;

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
    let deepest_pid = deepest_child_pid(sys, child_index, shell_pid);
    let mut candidates = Vec::new();
    let mut visited: HashSet<Pid> = HashSet::new();
    let mut stack = child_index
        .get(&shell_pid)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|pid| (pid, 1usize))
        .collect::<Vec<_>>();

    while let Some((pid, depth)) = stack.pop() {
        if !visited.insert(pid) {
            continue;
        }
        if let Some((kind, source)) = agent_detection_from_process(sys, pid) {
            candidates.push(AgentDescendantCandidate {
                kind,
                pid,
                depth,
                source,
            });
        }
        if let Some(children) = child_index.get(&pid) {
            stack.extend(children.iter().copied().map(|child| (child, depth + 1)));
        }
    }

    select_agent_descendant(&candidates, deepest_pid)
        .map(|candidate| (candidate.kind, candidate.pid))
}

fn select_agent_descendant(
    candidates: &[AgentDescendantCandidate],
    deepest_pid: Pid,
) -> Option<AgentDescendantCandidate> {
    candidates
        .iter()
        .copied()
        .find(|candidate| candidate.pid == deepest_pid)
        .or_else(|| {
            candidates
                .iter()
                .copied()
                .max_by_key(|candidate| (candidate.source, candidate.depth, candidate.pid.as_u32()))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpreter_classification_ignores_prompt_paths() {
        let args = vec![
            "node.exe".to_string(),
            "C:\\Users\\miyaz\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"
                .to_string(),
            "--no-alt-screen".to_string(),
            "Handoff C:\\Users\\miyaz\\.claude\\dispatch".to_string(),
        ];
        assert_eq!(
            classify_interpreter_cmdline(&args),
            Some(DetectedAgentKind::Codex)
        );
    }

    #[test]
    fn interpreter_classifies_claude_from_its_script_path() {
        let args = vec![
            "node.exe".to_string(),
            "C:\\tools\\claude\\cli.js".to_string(),
            "prompt".to_string(),
        ];
        assert_eq!(
            classify_interpreter_cmdline(&args),
            Some(DetectedAgentKind::Claude)
        );
    }

    #[test]
    fn interpreter_does_not_classify_prompt_mentions() {
        let args = vec![
            "node.exe".to_string(),
            "C:\\tools\\app.js".to_string(),
            "codex is only mentioned in this prompt".to_string(),
        ];
        assert_eq!(classify_interpreter_cmdline(&args), None);
    }

    #[test]
    fn powershell_node_codex_tree_prefers_the_deepest_direct_codex_process() {
        // Models PowerShell -> node(codex.js, prompt includes .claude) -> codex.exe.
        // PowerShell is not an agent candidate, while both lower nodes are Codex.
        let node_with_codex_script = AgentDescendantCandidate {
            kind: DetectedAgentKind::Codex,
            pid: Pid::from_u32(20),
            depth: 2,
            source: AgentDetectionSource::InterpreterScript,
        };
        let codex_child = AgentDescendantCandidate {
            kind: DetectedAgentKind::Codex,
            pid: Pid::from_u32(30),
            depth: 3,
            source: AgentDetectionSource::ExecutableName,
        };
        let selected =
            select_agent_descendant(&[node_with_codex_script, codex_child], codex_child.pid).unwrap();
        assert_eq!(selected.kind, DetectedAgentKind::Codex);
        assert_eq!(selected.pid, codex_child.pid);
    }

    #[test]
    fn descendant_selection_prefers_executable_evidence_then_depth() {
        let shallow_executable = AgentDescendantCandidate {
            kind: DetectedAgentKind::Codex,
            pid: Pid::from_u32(10),
            depth: 1,
            source: AgentDetectionSource::ExecutableName,
        };
        let deep_interpreter = AgentDescendantCandidate {
            kind: DetectedAgentKind::Claude,
            pid: Pid::from_u32(40),
            depth: 4,
            source: AgentDetectionSource::InterpreterScript,
        };
        let selected =
            select_agent_descendant(&[shallow_executable, deep_interpreter], Pid::from_u32(99))
                .unwrap();
        assert_eq!(selected.kind, DetectedAgentKind::Codex);
    }

    #[test]
    fn grounded_claude_codex_rollover_can_persist_under_a_native_claude_process() {
        let pinned = AgentSessionAttribution::new("claude-codex", "old".into());
        assert!(claude_process_uses_codex_root(DetectedAgentKind::Claude, Some(&pinned)));
        assert!(claude_process_uses_codex_root(DetectedAgentKind::ClaudeCodex, None));
        assert!(!claude_process_uses_codex_root(DetectedAgentKind::Claude, None));
        let mappings = HashMap::from([("pane".to_string(), AgentSessionMapping {
            hook_confirmed: false,
            agent_kind: Some("claude-codex".to_string()), session_id: "old".to_string(),
        })]);
        assert!(mapping_kind_is_grounded_for_pane(&mappings, "pane", "claude-codex", DetectedAgentKind::Claude));
        assert!(should_write_agent_session_mapping(&mappings, "pane", "claude-codex", "new"));
        assert!(!mapping_kind_is_grounded_for_pane(&HashMap::new(), "pane", "claude-codex", DetectedAgentKind::Claude));
        assert!(!mapping_kind_is_grounded_for_pane(&mappings, "other-pane", "claude-codex", DetectedAgentKind::Claude));
        assert!(!mapping_kind_is_grounded_for_pane(&mappings, "pane", "claude-codex", DetectedAgentKind::Codex));
    }

    #[test]
    fn explicitly_detected_claude_codex_uses_rollover_and_keeps_its_provider() {
        let old = AgentSessionAttribution::new("claude-codex", "old".to_string());
        let next = select_claude_process_attribution(
            DetectedAgentKind::ClaudeCodex, Some(old.clone()), Some("old".into()),
            None, None, None, &HashSet::new(),
            |kind, id| { assert_eq!(kind, "claude-codex"); id == "old" },
            || Some(AgentSessionAttribution::new("claude-codex", "new".into())),
        );
        let mut pending = HashMap::new();
        let first = confirm_agent_session_switch(&mut pending, "pane", Pid::from_u32(1), Some(&old), next.clone());
        assert_eq!(first.attribution, Some(old.clone()));
        let second = confirm_agent_session_switch(&mut pending, "pane", Pid::from_u32(1), Some(&old), next);
        assert_eq!(second.attribution.unwrap().session_id, "new");
        assert_eq!(second.switched_from.as_deref(), Some("old"));
        let fresh = select_claude_process_attribution(
            DetectedAgentKind::ClaudeCodex, None, Some("fresh".into()),
            None, None, None, &HashSet::new(), |kind, _| { assert_eq!(kind, "claude-codex"); false }, || None,
        ).unwrap();
        assert_eq!(fresh.agent_kind, "claude-codex");
    }

    #[test]
    fn mapping_persistence_requires_the_matching_process_identity() {
        assert!(mapping_kind_is_grounded_in_detected_process(
            "codex",
            DetectedAgentKind::Codex
        ));
        assert!(!mapping_kind_is_grounded_in_detected_process(
            "claude",
            DetectedAgentKind::Codex
        ));
        assert!(!mapping_kind_is_grounded_in_detected_process(
            "claude-codex",
            DetectedAgentKind::Claude
        ));
        assert!(mapping_kind_is_grounded_in_detected_process(
            "grok",
            DetectedAgentKind::Grok
        ));
    }
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
