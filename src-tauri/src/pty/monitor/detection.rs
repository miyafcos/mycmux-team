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

/// Index live parent-child relationships, rejecting reused parent PIDs.
pub(super) fn build_child_index(sys: &System) -> HashMap<Pid, Vec<Pid>> {
    build_child_index_with(
        sys.processes()
            .iter()
            .map(|(pid, process)| (*pid, process.parent(), process.start_time())),
        |pid| sys.process(pid).map(|process| process.start_time()),
    )
}

fn build_child_index_with<I, F>(processes: I, mut start_time: F) -> HashMap<Pid, Vec<Pid>>
where
    I: IntoIterator<Item = (Pid, Option<Pid>, u64)>,
    F: FnMut(Pid) -> Option<u64>,
{
    let mut child_index: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, parent, child_started_at) in processes {
        if let Some(parent) = parent.filter(|parent| {
            start_time(*parent)
                .is_some_and(|parent_started_at| parent_started_at <= child_started_at)
        }) {
            child_index.entry(parent).or_default().push(pid);
        }
    }
    child_index
}

const MAX_FOREGROUND_PROCESS_DEPTH: usize = 64;

/// Follow the highest-PID child chain, skipping system and missing processes.
pub(super) fn deepest_child_pid(
    sys: &System,
    child_index: &HashMap<Pid, Vec<Pid>>,
    pid: Pid,
) -> Pid {
    deepest_child_pid_with(child_index, pid, |child_pid| {
        sys.process(child_pid)
            .is_some_and(|process| !is_system_process(&process.name().to_string_lossy()))
    })
}

/// Bound traversal even if equal start timestamps leave a cycle in the index.
fn deepest_child_pid_with<F>(
    child_index: &HashMap<Pid, Vec<Pid>>,
    pid: Pid,
    mut is_foreground_candidate: F,
) -> Pid
where
    F: FnMut(Pid) -> bool,
{
    let mut current = pid;
    let mut visited = HashSet::from([pid]);
    for _ in 0..MAX_FOREGROUND_PROCESS_DEPTH {
        let next_child = child_index
            .get(&current)
            .into_iter()
            .flatten()
            .filter(|child_pid| is_foreground_candidate(**child_pid))
            .max_by_key(|child_pid| child_pid.as_u32())
            .copied();
        let Some(next_child) = next_child else { break };
        if !visited.insert(next_child) {
            break;
        }
        current = next_child;
    }
    current
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum DetectedAgentKind {
    Codex = 1,
    Claude = 2,
    ClaudeCodex = 3,
    Grok = 4,
    Antigravity = 5,
    Hermes = 6,
    Omp = 7,
}

impl DetectedAgentKind {
    pub(super) fn display_kind(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::ClaudeCodex => "claude-codex",
            Self::Codex => "codex",
            Self::Grok => "grok",
            Self::Antigravity => "antigravity",
            Self::Hermes => "hermes",
            Self::Omp => "omp",
        }
    }

    pub(super) fn is_restorable(self) -> bool {
        matches!(
            self,
            Self::Claude | Self::ClaudeCodex | Self::Codex | Self::Grok
        )
    }
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
    has_session_id: bool,
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

/// Gate every monitor mapping write on the agent selected from this PTY's root.
pub(super) fn should_write_selected_agent_session_mapping(
    mappings: &HashMap<String, AgentSessionMapping>,
    pane: &str,
    selected_kind: Option<DetectedAgentKind>,
    mapping_kind: &str,
    session_id: &str,
) -> bool {
    selected_kind
        .is_some_and(|kind| mapping_kind_is_grounded_for_pane(mappings, pane, mapping_kind, kind))
        && should_write_agent_session_mapping(mappings, pane, mapping_kind, session_id)
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

fn is_agent_helper_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase().replace('\\', "/");
    let leaf = lower.rsplit('/').next().unwrap_or(&lower);
    let leaf = leaf.strip_suffix(".exe").unwrap_or(leaf);
    matches!(leaf, "codex-code-mode-host" | "node_repl" | "node_repl.js")
        || lower.contains("/openai/codex/runtimes/cua_node/")
}

fn agent_kind_from_executable_name(name: &str) -> Option<DetectedAgentKind> {
    if is_agent_helper_path(name) {
        return None;
    }
    let lower_name = name.to_ascii_lowercase();
    let leaf = lower_name.rsplit(['/', '\\']).next()?;
    match leaf.strip_suffix(".exe").unwrap_or(leaf) {
        "claude-codex" => Some(DetectedAgentKind::ClaudeCodex),
        "claude" => Some(DetectedAgentKind::Claude),
        "codex" => Some(DetectedAgentKind::Codex),
        "grok" => Some(DetectedAgentKind::Grok),
        "agy" => Some(DetectedAgentKind::Antigravity),
        "hermes" => Some(DetectedAgentKind::Hermes),
        "omp" => Some(DetectedAgentKind::Omp),
        _ => None,
    }
}

/// Classify node/bun only from its executable and script-path arguments.
/// Prompts routinely include arbitrary filesystem paths (including `.claude`),
/// so later arguments must never participate in agent identity detection.
pub(super) fn classify_interpreter_cmdline(args: &[String]) -> Option<DetectedAgentKind> {
    if args.iter().take(2).any(|arg| is_agent_helper_path(arg)) {
        return None;
    }
    let interpreter = args.first()?.to_ascii_lowercase();
    let interpreter_leaf = interpreter
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(&interpreter);
    let interpreter_leaf = interpreter_leaf
        .strip_suffix(".exe")
        .unwrap_or(interpreter_leaf);
    if !matches!(interpreter_leaf, "node" | "bun") {
        return None;
    }
    let script_path = args.get(1)?.to_ascii_lowercase().replace('\\', "/");
    // Match complete script leaves or known package entry points, never a
    // directory or arbitrary prefix containing an agent's name.
    let leaf = script_path.rsplit('/').next()?;
    let parent = script_path.rsplit('/').nth(1).unwrap_or("");
    match leaf {
        "codex.js" => Some(DetectedAgentKind::Codex),
        "claude.js" => Some(DetectedAgentKind::Claude),
        "claude-codex.js" => Some(DetectedAgentKind::ClaudeCodex),
        "grok.js" => Some(DetectedAgentKind::Grok),
        "agy.js" => Some(DetectedAgentKind::Antigravity),
        "hermes.js" => Some(DetectedAgentKind::Hermes),
        "omp.js" => Some(DetectedAgentKind::Omp),
        "cli.js" if matches!(parent, "claude" | "claude-code") => Some(DetectedAgentKind::Claude),
        "cli.js" if parent == "claude-codex" => Some(DetectedAgentKind::ClaudeCodex),
        // The wrapper fixture represents the supported Claude launcher wrapper.
        "wrapper.js" if parent == "claude" => Some(DetectedAgentKind::Claude),
        "cli.js" if parent == "grok" => Some(DetectedAgentKind::Grok),
        _ => None,
    }
}

fn agent_detection_from_process(
    sys: &System,
    pid: Pid,
) -> Option<(DetectedAgentKind, AgentDetectionSource)> {
    let process = sys.process(pid)?;
    classify_agent_process(&process.name().to_string_lossy(), || {
        process
            .cmd()
            .iter()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect()
    })
}

fn classify_agent_process<F>(
    name: &str,
    args: F,
) -> Option<(DetectedAgentKind, AgentDetectionSource)>
where
    F: FnOnce() -> Vec<String>,
{
    if is_system_process(name) || is_shell_process(name) || is_agent_helper_path(name) {
        return None;
    }
    if let Some(kind) = agent_kind_from_executable_name(name) {
        return Some((kind, AgentDetectionSource::ExecutableName));
    }
    classify_interpreter_cmdline(&args())
        .map(|kind| (kind, AgentDetectionSource::InterpreterScript))
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
pub(crate) fn session_id_from_args(args: &[String], allow_bare_uuid: bool) -> Option<String> {
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
            if !kind.is_restorable() {
                return None;
            }
            session_id_from_agent_args(sys, *pid, kind == DetectedAgentKind::Codex)
        })
        .collect()
}

pub(super) fn find_agent_descendant(
    sys: &System,
    child_index: &HashMap<Pid, Vec<Pid>>,
    root_pid: Pid,
) -> Option<(DetectedAgentKind, Pid)> {
    find_agent_descendant_with(child_index, root_pid, |pid| {
        let (kind, source) = agent_detection_from_process(sys, pid)?;
        let has_session_id =
            session_id_from_agent_args(sys, pid, kind == DetectedAgentKind::Codex).is_some();
        Some((kind, source, has_session_id))
    })
}

/// The process lookup is injected so root identity and wrapper traversal can be
/// tested without launching agents or depending on the host process table.
fn find_agent_descendant_with<F>(
    child_index: &HashMap<Pid, Vec<Pid>>,
    root_pid: Pid,
    mut detect: F,
) -> Option<(DetectedAgentKind, Pid)>
where
    F: FnMut(Pid) -> Option<(DetectedAgentKind, AgentDetectionSource, bool)>,
{
    let mut candidates = Vec::new();
    let mut visited: HashSet<Pid> = HashSet::new();
    let mut stack = vec![(root_pid, 0usize)];

    while let Some((pid, depth)) = stack.pop() {
        if !visited.insert(pid) {
            continue;
        }
        if let Some((kind, source, has_session_id)) = detect(pid) {
            candidates.push(AgentDescendantCandidate {
                kind,
                pid,
                depth,
                source,
                has_session_id,
            });
        }
        if let Some(children) = child_index.get(&pid) {
            stack.extend(children.iter().copied().map(|child| (child, depth + 1)));
        }
    }

    select_agent_descendant(&candidates, child_index)
        .map(|candidate| (candidate.kind, candidate.pid))
}

fn select_agent_descendant(
    candidates: &[AgentDescendantCandidate],
    child_index: &HashMap<Pid, Vec<Pid>>,
) -> Option<AgentDescendantCandidate> {
    use std::cmp::Reverse;

    // Identity comes from the nearest agent, never from the foreground tool.
    let nearest = candidates.iter().copied().min_by_key(|candidate| {
        (
            candidate.depth,
            Reverse(candidate.source),
            Reverse(candidate.has_session_id),
            candidate.pid.as_u32(),
        )
    })?;
    if nearest.source == AgentDetectionSource::ExecutableName {
        return Some(nearest);
    }

    // Only an interpreter wrapper may resolve to a same-kind implementation.
    // Stop at native executables and at other agent kinds: their tools (including
    // same-kind exec children) must not replace the pane's main agent.
    let by_pid: HashMap<_, _> = candidates
        .iter()
        .map(|candidate| (candidate.pid, *candidate))
        .collect();
    let mut implementations = vec![nearest];
    let mut visited = HashSet::from([nearest.pid]);
    let mut stack = child_index.get(&nearest.pid).cloned().unwrap_or_default();
    while let Some(pid) = stack.pop() {
        if !visited.insert(pid) {
            continue;
        }
        if let Some(candidate) = by_pid.get(&pid) {
            if candidate.kind != nearest.kind {
                continue;
            }
            implementations.push(*candidate);
            if candidate.source == AgentDetectionSource::ExecutableName {
                continue;
            }
        }
        if let Some(children) = child_index.get(&pid) {
            stack.extend(children.iter().copied());
        }
    }
    implementations.into_iter().min_by_key(|candidate| {
        (
            Reverse(candidate.source),
            Reverse(candidate.has_session_id),
            candidate.depth,
            candidate.pid.as_u32(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn child_index_from_edges(edges: &[(u32, u32)]) -> HashMap<Pid, Vec<Pid>> {
        let mut index = HashMap::<Pid, Vec<Pid>>::new();
        for (parent, child) in edges {
            index
                .entry(Pid::from_u32(*parent))
                .or_default()
                .push(Pid::from_u32(*child));
        }
        index
    }

    fn timed_child_index(rows: &[(u32, Option<u32>, u64)]) -> HashMap<Pid, Vec<Pid>> {
        build_child_index_with(
            rows.iter().map(|(pid, parent, started_at)| {
                (Pid::from_u32(*pid), parent.map(Pid::from_u32), *started_at)
            }),
            |pid| {
                rows.iter()
                    .find(|(row_pid, _, _)| *row_pid == pid.as_u32())
                    .map(|(_, _, started_at)| *started_at)
            },
        )
    }

    #[test]
    fn foreground_traversal_returns_from_the_observed_e12_cycle() {
        let index =
            child_index_from_edges(&[(23112, 444), (444, 56876), (56876, 33636), (33636, 23112)]);
        let mut checks = 0;
        let foreground = deepest_child_pid_with(&index, Pid::from_u32(23112), |_| {
            checks += 1;
            true
        });
        assert_eq!(foreground, Pid::from_u32(33636));
        assert_eq!(checks, 4);
    }

    #[test]
    fn foreground_traversal_stops_on_self_and_two_process_cycles() {
        let index = child_index_from_edges(&[(42, 42)]);
        assert_eq!(
            deepest_child_pid_with(&index, Pid::from_u32(42), |_| true),
            Pid::from_u32(42)
        );
        let index = child_index_from_edges(&[(10, 20), (20, 10)]);
        assert_eq!(
            deepest_child_pid_with(&index, Pid::from_u32(10), |_| true),
            Pid::from_u32(20)
        );
        assert_eq!(
            deepest_child_pid_with(&index, Pid::from_u32(20), |_| true),
            Pid::from_u32(10)
        );
    }

    #[test]
    fn foreground_traversal_reaches_the_leaf_just_below_and_at_the_depth_limit() {
        for depth in [
            MAX_FOREGROUND_PROCESS_DEPTH - 1,
            MAX_FOREGROUND_PROCESS_DEPTH,
        ] {
            let edges = (0..depth as u32)
                .map(|pid| (pid, pid + 1))
                .collect::<Vec<_>>();
            let index = child_index_from_edges(&edges);
            assert_eq!(
                deepest_child_pid_with(&index, Pid::from_u32(0), |_| true),
                Pid::from_u32(depth as u32)
            );
        }
    }

    #[test]
    fn foreground_traversal_bounds_a_chain_beyond_the_depth_limit() {
        let edges = (0..MAX_FOREGROUND_PROCESS_DEPTH as u32 + 10)
            .map(|pid| (pid, pid + 1))
            .collect::<Vec<_>>();
        let index = child_index_from_edges(&edges);
        let mut checks = 0;
        let foreground = deepest_child_pid_with(&index, Pid::from_u32(0), |_| {
            checks += 1;
            true
        });
        assert_eq!(
            foreground,
            Pid::from_u32(MAX_FOREGROUND_PROCESS_DEPTH as u32)
        );
        assert_eq!(checks, MAX_FOREGROUND_PROCESS_DEPTH);
    }

    #[test]
    fn foreground_traversal_keeps_the_maximum_non_system_live_child_rule() {
        let names = HashMap::from([
            (10, "claude.exe"),
            (20, "powershell.exe"),
            (30, "node.exe"),
            (99, "conhost.exe"),
        ]);
        for edges in [
            vec![(1, 10), (1, 20), (1, 99), (1, 1000), (20, 30)],
            vec![(20, 30), (1, 1000), (1, 99), (1, 20), (1, 10)],
        ] {
            let index = child_index_from_edges(&edges);
            let foreground = deepest_child_pid_with(&index, Pid::from_u32(1), |pid| {
                names
                    .get(&pid.as_u32())
                    .is_some_and(|name| !is_system_process(name))
            });
            assert_eq!(foreground, Pid::from_u32(30));
        }
        let only_missing = child_index_from_edges(&[(1, 999)]);
        assert_eq!(
            deepest_child_pid_with(&only_missing, Pid::from_u32(1), |_| false),
            Pid::from_u32(1)
        );
        assert_eq!(
            deepest_child_pid_with(&HashMap::new(), Pid::from_u32(1), |_| true),
            Pid::from_u32(1)
        );
    }

    #[test]
    fn child_index_rejects_missing_and_reused_parents_but_keeps_equal_start_times() {
        let index = timed_child_index(&[
            (10, None, 200),
            (20, Some(10), 100), // The process with the parent's reused PID is newer.
            (30, Some(10), 200), // Equality must be allowed, as in live_parent.
            (40, Some(10), 201),
            (50, Some(999), 300), // The parent is no longer in the process table.
        ]);
        assert_eq!(
            index[&Pid::from_u32(10)],
            vec![Pid::from_u32(30), Pid::from_u32(40)]
        );
        assert!(!index.contains_key(&Pid::from_u32(999)));
        assert_eq!(index.len(), 1);
    }

    #[test]
    fn child_index_breaks_the_e12_reused_parent_edge_at_the_source() {
        let index = timed_child_index(&[
            (23112, Some(33636), 100),
            (444, Some(23112), 150),
            (56876, Some(444), 200),
            (33636, Some(56876), 250),
        ]);
        assert!(!index.contains_key(&Pid::from_u32(33636)));
        assert_eq!(index.len(), 3);
        assert_eq!(
            deepest_child_pid_with(&index, Pid::from_u32(23112), |_| true),
            Pid::from_u32(33636)
        );
    }

    #[test]
    fn equal_timestamp_cycles_are_still_bounded_after_index_construction() {
        let index = timed_child_index(&[(10, Some(20), 100), (20, Some(10), 100)]);
        assert_eq!(index.len(), 2);
        assert_eq!(
            deepest_child_pid_with(&index, Pid::from_u32(10), |_| true),
            Pid::from_u32(20)
        );
    }

    #[test]
    fn valid_parent_index_preserves_b4_agent_identity_and_foreground_choices() {
        for (case, (processes, kind, expected_agent)) in agent_tree_cases().into_iter().enumerate()
        {
            let rows = processes
                .iter()
                .map(|process| {
                    (
                        process.pid,
                        (process.parent != 0).then_some(process.parent),
                        100,
                    )
                })
                .collect::<Vec<_>>();
            let index = timed_child_index(&rows);
            let root = processes
                .iter()
                .find(|process| process.parent == 0)
                .unwrap();
            let selected = find_agent_descendant_with(&index, Pid::from_u32(root.pid), |pid| {
                let process = processes
                    .iter()
                    .find(|process| process.pid == pid.as_u32())?;
                let (kind, source) = classify_agent_process(process.name, || process.args.clone())?;
                Some((
                    kind,
                    source,
                    session_id_from_args(&process.args, kind == DetectedAgentKind::Codex).is_some(),
                ))
            });
            assert_eq!(selected, Some((kind, Pid::from_u32(expected_agent))));
            assert_eq!(selected, detect_fixture(&processes));
            let foreground = deepest_child_pid_with(&index, Pid::from_u32(root.pid), |pid| {
                processes
                    .iter()
                    .find(|process| process.pid == pid.as_u32())
                    .is_some_and(|process| !is_system_process(process.name))
            });
            assert_eq!(foreground, Pid::from_u32([30, 50, 60, 70, 50][case]));
        }
    }

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
            has_session_id: false,
        };
        let codex_child = AgentDescendantCandidate {
            kind: DetectedAgentKind::Codex,
            pid: Pid::from_u32(30),
            depth: 3,
            source: AgentDetectionSource::ExecutableName,
            has_session_id: false,
        };
        let children = HashMap::from([(node_with_codex_script.pid, vec![codex_child.pid])]);
        let selected =
            select_agent_descendant(&[node_with_codex_script, codex_child], &children).unwrap();
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
            has_session_id: false,
        };
        let deep_interpreter = AgentDescendantCandidate {
            kind: DetectedAgentKind::Claude,
            pid: Pid::from_u32(40),
            depth: 4,
            source: AgentDetectionSource::InterpreterScript,
            has_session_id: false,
        };
        let selected =
            select_agent_descendant(&[shallow_executable, deep_interpreter], &HashMap::new())
                .unwrap();
        assert_eq!(selected.kind, DetectedAgentKind::Codex);
    }

    const CODEX_SESSION: &str = "401caf0d-c8d1-4c12-b0d4-ed291d41d356";

    struct FixtureProcess {
        pid: u32,
        parent: u32,
        name: &'static str,
        args: Vec<String>,
    }

    fn fixture_process(pid: u32, parent: u32, name: &'static str, args: &[&str]) -> FixtureProcess {
        FixtureProcess {
            pid,
            parent,
            name,
            args: std::iter::once(name)
                .chain(args.iter().copied())
                .map(str::to_string)
                .collect(),
        }
    }

    fn detect_fixture(processes: &[FixtureProcess]) -> Option<(DetectedAgentKind, Pid)> {
        let mut children = HashMap::<Pid, Vec<Pid>>::new();
        for process in processes {
            children
                .entry(Pid::from_u32(process.parent))
                .or_default()
                .push(Pid::from_u32(process.pid));
        }
        let root = processes
            .iter()
            .find(|process| process.parent == 0)
            .unwrap();
        find_agent_descendant_with(&children, Pid::from_u32(root.pid), |pid| {
            let process = processes
                .iter()
                .find(|process| process.pid == pid.as_u32())?;
            let (kind, source) = classify_agent_process(process.name, || process.args.clone())?;
            Some((
                kind,
                source,
                session_id_from_args(&process.args, kind == DetectedAgentKind::Codex).is_some(),
            ))
        })
    }

    fn agent_tree_cases() -> Vec<(Vec<FixtureProcess>, DetectedAgentKind, u32)> {
        vec![
            // T1: a restored Claude root owns its MCP tools.
            (
                vec![
                    fixture_process(10, 0, "claude.exe", &[]),
                    fixture_process(20, 10, "cmd.exe", &[]),
                    fixture_process(30, 20, "node.exe", &[r"C:\tools\oracle-mcp.js"]),
                ],
                DetectedAgentKind::Claude,
                10,
            ),
            // T2: persistent bash and PowerShell tools do not hide the root.
            (
                vec![
                    fixture_process(10, 0, "claude.exe", &[]),
                    fixture_process(20, 10, "bash.exe", &[]),
                    fixture_process(30, 20, "bash.exe", &[]),
                    fixture_process(40, 10, "cmd.exe", &[]),
                    fixture_process(50, 40, "powershell.exe", &[]),
                ],
                DetectedAgentKind::Claude,
                10,
            ),
            // T3: Claude's headless Codex child cannot take over its identity.
            (
                vec![
                    fixture_process(10, 0, "bash.exe", &[]),
                    fixture_process(20, 10, "cmd.exe", &[]),
                    fixture_process(30, 20, "claude.exe", &[]),
                    fixture_process(40, 30, "bash.exe", &[]),
                    fixture_process(50, 40, "node.exe", &[r"C:\tools\codex.js"]),
                    fixture_process(60, 50, "codex.exe", &["exec", CODEX_SESSION]),
                ],
                DetectedAgentKind::Claude,
                30,
            ),
            // T4: unwrap Codex once, retaining the executable's resume id.
            (
                vec![
                    fixture_process(10, 0, "powershell.exe", &[]),
                    fixture_process(20, 10, "node.exe", &[r"C:\tools\codex.js"]),
                    fixture_process(30, 20, "codex.exe", &["resume", CODEX_SESSION]),
                    fixture_process(40, 30, "codex-code-mode-host.exe", &[]),
                    fixture_process(
                        50,
                        30,
                        "node.exe",
                        &[r"C:\OpenAI\Codex\runtimes\cua_node\agent.js"],
                    ),
                    fixture_process(60, 30, "python.exe", &[]),
                    fixture_process(70, 30, "node_repl.exe", &[]),
                ],
                DetectedAgentKind::Codex,
                30,
            ),
            // T5: Codex's headless Claude child cannot take over its identity.
            (
                vec![
                    fixture_process(10, 0, "powershell.exe", &[]),
                    fixture_process(20, 10, "node.exe", &[r"C:\tools\codex.js"]),
                    fixture_process(30, 20, "codex.exe", &[]),
                    fixture_process(40, 30, "powershell.exe", &[]),
                    fixture_process(50, 40, "claude.exe", &["-p", "prompt"]),
                ],
                DetectedAgentKind::Codex,
                30,
            ),
        ]
    }

    #[test]
    fn root_and_nearest_agent_trees_t1_through_t5() {
        for (index, (processes, kind, pid)) in agent_tree_cases().into_iter().enumerate() {
            assert_eq!(
                detect_fixture(&processes),
                Some((kind, Pid::from_u32(pid))),
                "T{}",
                index + 1
            );
        }
    }

    #[test]
    fn normal_shell_roots_keep_claude_codex_and_no_agent_detection_t6() {
        let claude = vec![
            fixture_process(10, 0, "powershell.exe", &[]),
            fixture_process(20, 10, "claude.exe", &[]),
        ];
        let codex = vec![
            fixture_process(10, 0, "powershell.exe", &[]),
            fixture_process(20, 10, "node.exe", &[r"C:\tools\codex.js"]),
            fixture_process(30, 20, "codex.exe", &[]),
        ];
        let shell = vec![fixture_process(10, 0, "powershell.exe", &[])];
        assert_eq!(
            detect_fixture(&claude),
            Some((DetectedAgentKind::Claude, Pid::from_u32(20)))
        );
        assert_eq!(
            detect_fixture(&codex),
            Some((DetectedAgentKind::Codex, Pid::from_u32(30)))
        );
        assert_eq!(detect_fixture(&shell), None);
    }

    #[test]
    fn sibling_pid_and_iteration_order_do_not_change_agent_identity_t7() {
        for (processes, kind, pid) in agent_tree_cases() {
            let mut swapped: Vec<_> = processes
                .into_iter()
                .map(|mut process| {
                    process.pid = 1000 - process.pid;
                    if process.parent != 0 {
                        process.parent = 1000 - process.parent;
                    }
                    process
                })
                .collect();
            swapped.reverse();
            assert_eq!(
                detect_fixture(&swapped),
                Some((kind, Pid::from_u32(1000 - pid)))
            );
        }
    }

    #[test]
    fn selected_codex_executable_supplies_exact_resume_id_and_mapping_kind() {
        let (processes, _, _) = agent_tree_cases().swap_remove(3);
        let (kind, pid) = detect_fixture(&processes).unwrap();
        let selected = processes
            .iter()
            .find(|process| process.pid == pid.as_u32())
            .unwrap();
        let exact_rollout_id = session_id_from_args(&selected.args, true);
        assert_eq!(exact_rollout_id.as_deref(), Some(CODEX_SESSION));
        let (mapping_kind, mapping_id, _) = codex_agent_metadata_fields(exact_rollout_id, None);
        assert_eq!(mapping_kind.as_deref(), Some("codex"));
        assert_eq!(mapping_id.as_deref(), Some(CODEX_SESSION));
        assert!(mapping_kind_is_grounded_for_pane(
            &HashMap::new(),
            "pane",
            mapping_kind.as_deref().unwrap(),
            kind
        ));
        assert!(should_write_agent_session_mapping(
            &HashMap::new(),
            "pane",
            mapping_kind.as_deref().unwrap(),
            mapping_id.as_deref().unwrap()
        ));
    }

    #[test]
    fn auxiliary_processes_are_never_agent_candidates() {
        for name in [
            "codex-code-mode-host.exe",
            "CODEX-CODE-MODE-HOST",
            "node_repl.exe",
            "node_repl",
        ] {
            assert_eq!(
                classify_agent_process(name, || vec![name.to_string()]),
                None,
                "{name}"
            );
        }
        for args in [
            vec![
                r"C:\OpenAI\Codex\runtimes\cua_node\node.exe",
                r"C:\tools\app.js",
            ],
            vec!["node.exe", r"C:\OpenAI\Codex\runtimes\cua_node\agent.js"],
            vec!["node", "/opt/OpenAI/Codex/runtimes/cua_node/agent.js"],
            vec!["node.exe", r"C:\tools\codex\node_repl.js"],
        ] {
            let args = args.into_iter().map(str::to_string).collect::<Vec<_>>();
            assert_eq!(classify_interpreter_cmdline(&args), None, "{args:?}");
        }
        let helpers = vec![
            fixture_process(10, 0, "powershell.exe", &[]),
            fixture_process(20, 10, "codex-code-mode-host.exe", &[]),
            fixture_process(
                30,
                10,
                "node.exe",
                &[r"C:\OpenAI\Codex\runtimes\cua_node\agent.js"],
            ),
            fixture_process(40, 10, "node_repl.exe", &[]),
        ];
        assert_eq!(detect_fixture(&helpers), None);
    }

    #[test]
    fn wrappers_do_not_cross_other_kinds_or_unrelated_branches() {
        let different_kind = vec![
            fixture_process(10, 0, "powershell.exe", &[]),
            fixture_process(20, 10, "node.exe", &[r"C:\tools\claude\cli.js"]),
            fixture_process(30, 20, "codex.exe", &[]),
            fixture_process(40, 30, "claude.exe", &[]),
        ];
        assert_eq!(
            detect_fixture(&different_kind),
            Some((DetectedAgentKind::Claude, Pid::from_u32(20)))
        );
        let unrelated_branch = vec![
            fixture_process(10, 0, "powershell.exe", &[]),
            fixture_process(20, 10, "node.exe", &[r"C:\tools\claude\cli.js"]),
            fixture_process(30, 10, "cmd.exe", &[]),
            fixture_process(40, 30, "claude.exe", &[]),
        ];
        assert_eq!(
            detect_fixture(&unrelated_branch),
            Some((DetectedAgentKind::Claude, Pid::from_u32(20)))
        );
    }

    #[test]
    fn native_codex_does_not_unwrap_into_a_same_kind_exec_child() {
        let processes = vec![
            fixture_process(10, 0, "powershell.exe", &[]),
            fixture_process(20, 10, "node.exe", &[r"C:\tools\codex.js"]),
            fixture_process(30, 20, "codex.exe", &["resume", CODEX_SESSION]),
            fixture_process(40, 30, "codex.exe", &["exec", "prompt"]),
        ];
        assert_eq!(
            detect_fixture(&processes),
            Some((DetectedAgentKind::Codex, Pid::from_u32(30)))
        );
    }

    #[test]
    fn interpreter_implementation_with_a_session_id_wins_over_its_wrapper() {
        let processes = vec![
            fixture_process(10, 0, "powershell.exe", &[]),
            fixture_process(20, 10, "node.exe", &[r"C:\tools\claude\wrapper.js"]),
            fixture_process(
                30,
                20,
                "node.exe",
                &[r"C:\tools\claude\cli.js", "--session-id", CODEX_SESSION],
            ),
        ];
        assert_eq!(
            detect_fixture(&processes),
            Some((DetectedAgentKind::Claude, Pid::from_u32(30)))
        );
    }

    #[test]
    fn unix_node_paths_still_classify_real_agent_scripts() {
        let args = vec![
            "/usr/bin/node".to_string(),
            "/opt/codex/bin/codex.js".to_string(),
        ];
        assert_eq!(
            classify_interpreter_cmdline(&args),
            Some(DetectedAgentKind::Codex)
        );
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
    fn exact_agent_executable_leaves_reject_substring_matches() {
        for (name, kind) in [
            ("CLAUDE.EXE", DetectedAgentKind::Claude),
            ("/usr/bin/codex", DetectedAgentKind::Codex),
            (r"C:\tools\claude-codex.exe", DetectedAgentKind::ClaudeCodex),
            ("grok", DetectedAgentKind::Grok),
            ("agy.exe", DetectedAgentKind::Antigravity),
            ("hermes", DetectedAgentKind::Hermes),
            ("omp.exe", DetectedAgentKind::Omp),
        ] {
            assert_eq!(
                classify_agent_process(name, Vec::new),
                Some((kind, AgentDetectionSource::ExecutableName))
            );
        }
        for name in [
            "my-claude.exe",
            "codex-tool.exe",
            "grokking.exe",
            "agy-helper",
            "hermes-server",
            "omp-worker.exe",
            r"C:\codex\other.exe",
            "/claude/node",
        ] {
            assert_eq!(classify_agent_process(name, Vec::new), None, "{name}");
        }
    }

    #[test]
    fn known_script_paths_use_complete_components() {
        for (script, kind) in [
            (
                "/opt/node_modules/@anthropic-ai/claude-code/cli.js",
                DetectedAgentKind::Claude,
            ),
            (
                r"C:\npm\node_modules\@openai\codex\bin\codex.js",
                DetectedAgentKind::Codex,
            ),
            ("/tools/claude-codex/cli.js", DetectedAgentKind::ClaudeCodex),
            ("/tools/grok/cli.js", DetectedAgentKind::Grok),
            ("/tools/agy.js", DetectedAgentKind::Antigravity),
            ("/tools/hermes.js", DetectedAgentKind::Hermes),
            ("/tools/omp.js", DetectedAgentKind::Omp),
        ] {
            let args = vec!["/usr/bin/node".into(), script.into()];
            assert_eq!(classify_interpreter_cmdline(&args), Some(kind), "{script}");
        }
        for script in [
            "/opt/codex/app.js",
            "/claude/report.js",
            "/claude-helper/cli.js",
            "/grok-tool/cli.js",
            "/codex-server.js",
            "/OpenAI/Codex/runtimes/cua_node/codex.js",
            "/node_modules/@openai/codex-tools/cli.js",
            "/hermes-worker.js",
        ] {
            assert_eq!(
                classify_interpreter_cmdline(&["bun.exe".into(), script.into()]),
                None,
                "{script}"
            );
        }
    }

    #[test]
    fn display_only_agents_own_the_root_but_never_resume_or_map_t9() {
        for (name, kind) in [
            ("agy.exe", DetectedAgentKind::Antigravity),
            ("hermes.exe", DetectedAgentKind::Hermes),
            ("omp.exe", DetectedAgentKind::Omp),
        ] {
            let processes = vec![
                fixture_process(10, 0, "bash.exe", &[]),
                fixture_process(20, 10, name, &[]),
                fixture_process(30, 20, "codex.exe", &["exec", CODEX_SESSION]),
            ];
            assert_eq!(detect_fixture(&processes), Some((kind, Pid::from_u32(20))));
            assert!(!kind.is_restorable());
            assert!(!should_write_selected_agent_session_mapping(
                &HashMap::new(),
                "pane",
                Some(kind),
                "codex",
                CODEX_SESSION
            ));
        }
        let fresh = PtyMetadata::unobserved("pane".into());
        assert_eq!(
            preserved_agent_metadata_fields(Some(&fresh)),
            (None, None, None)
        );
        let mut previous = fresh;
        previous.agent_kind = Some("claude".into());
        previous.agent_session_id = Some("resume".into());
        assert_eq!(
            preserved_agent_metadata_fields(Some(&previous)),
            (Some("claude".into()), Some("resume".into()), None)
        );
    }

    #[test]
    fn child_codex_mapping_cannot_replace_the_selected_claude_t3() {
        let (processes, _, _) = agent_tree_cases().swap_remove(2);
        let (selected, _) = detect_fixture(&processes).unwrap();
        let mappings = HashMap::from([(
            "pane".into(),
            AgentSessionMapping {
                hook_confirmed: false,
                agent_kind: Some("claude".into()),
                session_id: "parent".into(),
            },
        )]);
        assert!(!should_write_selected_agent_session_mapping(
            &mappings,
            "pane",
            Some(selected),
            "codex",
            CODEX_SESSION
        ));
        assert!(!should_write_selected_agent_session_mapping(
            &mappings, "pane", None, "claude", "parent"
        ));
        assert!(!should_write_selected_agent_session_mapping(
            &mappings,
            "pane",
            Some(selected),
            "claude",
            "parent"
        ));
        assert!(should_write_selected_agent_session_mapping(
            &mappings,
            "pane",
            Some(selected),
            "claude",
            "successor"
        ));
        assert_eq!(mappings["pane"].session_id, "parent");
    }

    #[test]
    fn claude_root_tools_keep_working_and_the_root_timestamp_t2() {
        let (processes, _, _) = agent_tree_cases().swap_remove(1);
        let (selected, root) = detect_fixture(&processes).unwrap();
        assert_eq!(root, Pid::from_u32(10));
        for tool in ["powershell.exe", "bash.exe", "cmd.exe"] {
            let (status, at) =
                process_status_from_observation(Some(tool), Some(1000), selected.is_restorable());
            assert_eq!(status.as_deref(), Some("working"));
            assert_eq!(at, Some(1000));
        }
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
