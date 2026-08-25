//! Live transcript summaries and fail-closed intervention support.
//!
//! This module deliberately does not use the analytics database. A live brief
//! is rebuilt from the mapped transcript and is considered writable only while
//! its source, binding and PTY input revision all still match.

mod adapter;
mod excerpt;
pub(crate) mod excerpt_ja;
mod intervene;
mod reducer;
mod telemetry;

use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::commands::session_mapping::{agent_mappings_for_ids, AgentSessionMapping};
use crate::history::{IngestInput, JournalEvent};
use crate::pty::manager::SessionManager;
use crate::pty::monitor::MetadataStore;
use crate::AppState;

pub use adapter::{AgentAdapter, ByteRange, SemanticEventEnvelope, SemanticEventKind};
pub(crate) use excerpt::ContextExcerpt;
pub use intervene::{InterventionAction, InterventionExpectation, InterventionResult};
pub use reducer::{LiveBriefReducer, PendingInputKind, PendingOption};
pub use telemetry::AgentTelemetry;

const EVENT_NAME: &str = "livebrief://update";
const MAX_BOOTSTRAP_BYTES: u64 = 32 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 1024 * 1024;
const RING_CAPACITY: usize = 200;
const DEFAULT_EVENT_LIMIT: usize = 50;
const MIN_EVENT_LIMIT: usize = 8;
/// Turn-mark restore only ever needs the prompts that can still be on screen,
/// so it reads a much smaller tail than a full livebrief bootstrap.
const MAX_PROMPT_SCAN_BYTES: u64 = 8 * 1024 * 1024;
/// Matches `MAX_TURN_MARKS_PER_SESSION` on the frontend: more prompts than
/// that could never all hold a mark anyway.
const MAX_RESTORED_PROMPTS: usize = 200;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiveBinding {
    pub pty_session_id: String,
    pub agent_session_id: String,
    pub agent_kind: String,
    pub pty_instance_id: String,
    pub pty_generation: u64,
    pub source_revision: u64,
    pub pty_input_revision: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiveSessionBrief {
    #[serde(flatten)]
    pub binding: LiveBinding,
    pub task: Option<String>,
    /// The most recent instruction on its own, without the folded task history.
    pub latest_instruction: Option<String>,
    pub task_source_event_ids: Vec<String>,
    pub activity_kind: Option<String>,
    pub activity_text: Option<String>,
    pub activity_source_event_id: Option<String>,
    pub checkpoint: Option<String>,
    pub checkpoint_evidence_event_ids: Vec<String>,
    pub pending_input_kind: Option<PendingInputKind>,
    pub pending_prompt: Option<String>,
    pub pending_options: Vec<PendingOption>,
    pub prompt_event_id: Option<String>,
    pub prompt_hash: Option<String>,
    pub event_seq: u64,
    pub operational_state: String,
    pub telemetry_health: String,
    pub last_event_at: Option<i64>,
    pub last_successful_read_at: Option<i64>,
    pub updated_at: i64,
    pub service_epoch: String,
    pub brief_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub telemetry: Option<AgentTelemetry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveBriefUpdate {
    pub brief: LiveSessionBrief,
}

/// Tail of the semantic event ring for one session. Read straight out of the
/// cache the refresh thread already maintains; it never triggers a re-read.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSessionEvents {
    pub pty_session_id: String,
    pub brief_revision: u64,
    pub telemetry_health: String,
    pub events: Vec<SemanticEventEnvelope>,
}

/// One prompt the operator typed, as recorded in the transcript.
///
/// Turn-mark restore matches these against the terminal buffer an agent
/// redrew, so the payload is the raw prompt text and nothing else.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPrompt {
    pub text: String,
    pub occurred_at: i64,
}

#[derive(Clone, Debug)]
struct TailCursor {
    path: PathBuf,
    file_identity: String,
    stream_generation: u64,
    read_offset: u64,
    committed_offset: u64,
    pending_bytes: Vec<u8>,
    committed_anchor: String,
}

#[derive(Clone, Debug)]
pub(crate) struct SessionSnapshot {
    brief: LiveSessionBrief,
    cursor: TailCursor,
    adapter: AgentAdapter,
    reducer: LiveBriefReducer,
    events: VecDeque<SemanticEventEnvelope>,
}

#[derive(Default)]
struct ServiceState {
    sessions: HashMap<String, SessionSnapshot>,
    brief_revision: u64,
    refresh_in_progress: bool,
    last_refresh_finished_at: Option<std::time::Instant>,
}

#[derive(Clone)]
pub struct LiveBriefService {
    manager: Arc<SessionManager>,
    metadata: MetadataStore,
    state: Arc<Mutex<ServiceState>>,
    service_epoch: String,
    app_handle: Arc<OnceLock<AppHandle>>,
    started: Arc<OnceLock<()>>,
    subscribers: Arc<AtomicUsize>,
    coordinators: Arc<DashMap<String, Arc<Mutex<intervene::Coordinator>>>>,
}

impl LiveBriefService {
    pub fn new(manager: Arc<SessionManager>, metadata: MetadataStore) -> Self {
        Self {
            manager,
            metadata,
            state: Arc::new(Mutex::new(ServiceState::default())),
            service_epoch: Uuid::new_v4().to_string(),
            app_handle: Arc::new(OnceLock::new()),
            started: Arc::new(OnceLock::new()),
            subscribers: Arc::new(AtomicUsize::new(0)),
            coordinators: Arc::new(DashMap::new()),
        }
    }

    pub fn start(&self, app_handle: AppHandle) {
        let _ = self.app_handle.set(app_handle);
        if self.started.set(()).is_err() {
            return;
        }
        let service = self.clone();
        thread::spawn(move || loop {
            if service.subscribers.load(Ordering::Acquire) == 0 {
                thread::sleep(Duration::from_secs(30));
                continue;
            }
            service.refresh_all();
            thread::sleep(Duration::from_secs(1));
        });
    }

    pub fn subscribe(&self) {
        self.subscribers.fetch_add(1, Ordering::AcqRel);
    }

    pub fn unsubscribe(&self) {
        let _ = self.subscribers.fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| count.checked_sub(1));
    }

    pub fn snapshots(&self) -> Vec<LiveSessionBrief> {
        self.refresh_all();
        let state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.sessions.values().map(|snapshot| snapshot.brief.clone()).collect()
    }

    fn refresh_all(&self) {
        {
            let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.refresh_in_progress
                || state.last_refresh_finished_at.is_some_and(|at| at.elapsed() <= Duration::from_millis(500))
            {
                return;
            }
            state.refresh_in_progress = true;
        }
        let session_ids: Vec<String> = self.manager.iter_pids().into_iter().map(|(id, _)| id).collect();
        let mappings = agent_mappings_for_ids(session_ids.iter().map(String::as_str));
        let priors: HashMap<String, SessionSnapshot> = {
            let state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            state.sessions.clone()
        };
        let mut next = HashMap::new();
        let mut reused: Vec<String> = Vec::new();
        for session_id in &session_ids {
            match self.refresh_one(session_id, mappings.get(session_id), &mappings, priors.get(session_id)) {
                Some(snapshot) => { next.insert(session_id.clone(), snapshot); }
                None => reused.push(session_id.clone()),
            }
        }
        let now = unix_ms();
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        for session_id in reused {
            if let Some(snapshot) = state.sessions.get_mut(&session_id) {
                snapshot.brief.last_successful_read_at = Some(now);
                snapshot.brief.updated_at = now;
            }
        }
        for (session_id, snapshot) in next {
            let previous = state.sessions.get(&session_id);
            let mut snapshot = keep_last_picture(previous, snapshot);
            let changed = previous.map(|old| brief_changed(&old.brief, &snapshot.brief)).unwrap_or(true);
            let previous_revision = previous.map(|old| old.brief.brief_revision).unwrap_or(0);
            if changed {
                state.brief_revision = state.brief_revision.saturating_add(1);
                snapshot.brief.brief_revision = state.brief_revision;
                if self.subscribers.load(Ordering::Acquire) > 0 {
                    if let Some(app) = self.app_handle.get() {
                    let _ = app.emit(EVENT_NAME, LiveBriefUpdate { brief: snapshot.brief.clone() });
                    }
                }
            } else {
                // Same meaning as last tick: keep the revision (and therefore the
                // frontend's merge guard) still, and emit nothing.
                snapshot.brief.brief_revision = previous_revision;
            }
            state.sessions.insert(session_id, snapshot);
        }
        state.sessions.retain(|session_id, _| session_ids.contains(session_id));
        state.refresh_in_progress = false;
        state.last_refresh_finished_at = Some(std::time::Instant::now());
    }

    /// Rebuild one session. `None` means the cached snapshot is still exact —
    /// the transcript file identity and the binding both match — so the caller
    /// keeps it instead of re-reading up to `MAX_BOOTSTRAP_BYTES`.
    fn refresh_one(
        &self,
        pty_session_id: &str,
        mapping: Option<&AgentSessionMapping>,
        all_mappings: &HashMap<String, AgentSessionMapping>,
        prior: Option<&SessionSnapshot>,
    ) -> Option<SessionSnapshot> {
        let (pty_generation, pty_input_revision, _) = self.manager
            .intervention_observation(pty_session_id)
            .unwrap_or((0, 0, None));
        let mapping = mapping.filter(|mapping| matches!(mapping.agent_kind.as_deref(), Some("claude") | Some("codex") | Some("claude-codex") | Some("grok")));
        let Some(mapping) = mapping else {
            return Some(unavailable_snapshot(
                self.base_binding(pty_session_id, "", "", pty_generation, pty_input_revision),
                "unlinked",
                &self.service_epoch,
            ));
        };
        let kind = mapping.agent_kind.as_deref().unwrap_or_default();
        let same_session: Vec<&str> = all_mappings
            .iter()
            .filter(|(_, candidate)| {
                candidate.agent_kind.as_deref() == Some(kind) && candidate.session_id == mapping.session_id
            })
            .map(|(id, _)| id.as_str())
            .collect();
        if same_session.len() != 1 {
            let newest = mapping_dir().and_then(|dir| newest_pane_by_mapping_mtime(&dir, &same_session));
            if newest.as_deref() != Some(pty_session_id) {
                return Some(unavailable_snapshot(
                    self.base_binding(pty_session_id, kind, &mapping.session_id, pty_generation, pty_input_revision),
                    "unavailable",
                    &self.service_epoch,
                ));
            }
        }
        let binding = self.base_binding(pty_session_id, kind, &mapping.session_id, pty_generation, pty_input_revision);
        let (history_cwd, history_branch) = self
            .metadata
            .get(pty_session_id)
            .map(|metadata| (Some(metadata.cwd.clone()), metadata.git_branch.clone()))
            .unwrap_or((None, None));
        refresh_bound_transcript(
            prior,
            &binding,
            kind,
            &mapping.session_id,
            &self.service_epoch,
            history_cwd.as_deref(),
            history_branch.as_deref(),
            locate_transcript,
        )
    }

    fn base_binding(&self, pty_session_id: &str, agent_kind: &str, agent_session_id: &str, pty_generation: u64, pty_input_revision: u64) -> LiveBinding {
        LiveBinding {
            pty_session_id: pty_session_id.to_string(),
            agent_session_id: agent_session_id.to_string(),
            agent_kind: agent_kind.to_string(),
            pty_instance_id: format!("pty-{pty_generation}"),
            pty_generation,
            source_revision: 0,
            pty_input_revision,
        }
    }

    /// Tail of the cached event ring for each requested session. Deliberately
    /// does not call `refresh_all` — the once-a-second thread already keeps
    /// `state.sessions` current, so a poll here must stay a memory read.
    pub fn events(&self, ids: &[String], limit: usize) -> Vec<LiveSessionEvents> {
        let state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        ids.iter()
            .filter_map(|pty_session_id| {
                let snapshot = state.sessions.get(pty_session_id)?;
                let skip = snapshot.events.len().saturating_sub(limit);
                Some(LiveSessionEvents {
                    pty_session_id: pty_session_id.clone(),
                    brief_revision: snapshot.brief.brief_revision,
                    telemetry_health: snapshot.brief.telemetry_health.clone(),
                    events: snapshot.events.iter().skip(skip).cloned().collect(),
                })
            })
            .collect()
    }

    /// Builds an excerpt from already-cached data without refreshing transcripts.
    pub(crate) fn context_excerpt(&self, pty_session_id: &str, max_chars: usize) -> Option<ContextExcerpt> {
        let state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let snapshot = state.sessions.get(pty_session_id)?;
        let events = snapshot.events.iter().cloned().collect::<Vec<_>>();
        excerpt::build_context_excerpt(&snapshot.brief, &events, max_chars)
    }

    /// Reads the already-cached semantic question for attention evidence.
    /// It deliberately does not refresh transcripts or touch the PTY.
    pub(crate) fn agent_asked_excerpt(&self, pty_session_id: &str, prompt_event_id: &str) -> Option<String> {
        let state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let snapshot = state.sessions.get(pty_session_id)?;
        let events = snapshot.events.iter().cloned().collect::<Vec<_>>();
        semantic_question_excerpt(&events, prompt_event_id)
            .or_else(|| snapshot.brief.pending_prompt.clone())
            .or_else(|| snapshot.brief.activity_text.clone())
    }

    pub(crate) fn current(&self, pty_session_id: &str) -> Option<SessionSnapshot> {
        self.refresh_all();
        self.state.lock().ok()?.sessions.get(pty_session_id).cloned()
    }

    pub(crate) fn coordinator(&self, pty_session_id: &str) -> Arc<Mutex<intervene::Coordinator>> {
        self.coordinators
            .entry(pty_session_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(intervene::Coordinator::default())))
            .clone()
    }

    pub(crate) fn manager(&self) -> &Arc<SessionManager> { &self.manager }
    pub(crate) fn metadata(&self) -> &MetadataStore { &self.metadata }
}

pub(crate) fn semantic_question_excerpt(
    events: &[SemanticEventEnvelope],
    prompt_event_id: &str,
) -> Option<String> {
    events.iter().rev().find_map(|event| match &event.kind {
        SemanticEventKind::Question { prompt_event_id: id, prompt, .. } if id == prompt_event_id => Some(prompt.clone()),
        _ => None,
    })
}

/// Keep the last meaningful picture of a pane whose agent has gone away.
///
/// When an agent exits the mapping disappears and the rebuild yields an empty
/// `unlinked`/`unavailable` snapshot, which used to wipe the event ring and the
/// task the operator was still reading. The history is carried over and marked
/// `ended` instead. Everything actionable — the pending question and its hashes
/// — is dropped on purpose: intervening against a prompt whose agent no longer
/// exists would type into whatever now owns the PTY.
fn session_identity_changed(previous: &LiveBinding, next: &LiveBinding) -> bool {
    previous.agent_session_id != next.agent_session_id
        || previous.pty_instance_id != next.pty_instance_id
        || previous.pty_generation != next.pty_generation
}

fn keep_last_picture(previous: Option<&SessionSnapshot>, next: SessionSnapshot) -> SessionSnapshot {
    if next.brief.telemetry_health == "live" || !next.events.is_empty() { return next; }
    let Some(previous) = previous else { return next };
    let session_changed = session_identity_changed(&previous.brief.binding, &next.brief.binding);
    if previous.brief.telemetry_health == "ended" && !session_changed {
        return previous.clone();
    }
    if previous.brief.telemetry_health != "live" && previous.brief.telemetry_health != "ended" {
        return next;
    }
    let mut merged = previous.clone();
    merged.brief.binding = next.brief.binding;
    if session_changed {
        merged.brief.telemetry = None;
        merged.reducer.reset_telemetry();
    }
    merged.brief.telemetry_health = "ended".to_string();
    merged.brief.operational_state = "ended".to_string();
    merged.brief.pending_input_kind = None;
    merged.brief.pending_prompt = None;
    merged.brief.pending_options = Vec::new();
    merged.brief.prompt_event_id = None;
    merged.brief.prompt_hash = None;
    merged.brief.last_successful_read_at = next.brief.last_successful_read_at;
    merged.brief.updated_at = next.brief.updated_at;
    merged
}

/// True when two briefs differ in meaning. `updated_at`,
/// `last_successful_read_at` and `brief_revision` are excluded on purpose:
/// the reducer stamps the first two with `now` on every rebuild, so a plain
/// `!=` made every session look changed once a second.
fn brief_changed(old: &LiveSessionBrief, new: &LiveSessionBrief) -> bool {
    old.binding != new.binding
        || old.task != new.task
        || old.latest_instruction != new.latest_instruction
        || old.task_source_event_ids != new.task_source_event_ids
        || old.activity_kind != new.activity_kind
        || old.activity_text != new.activity_text
        || old.activity_source_event_id != new.activity_source_event_id
        || old.checkpoint != new.checkpoint
        || old.checkpoint_evidence_event_ids != new.checkpoint_evidence_event_ids
        || old.pending_input_kind != new.pending_input_kind
        || old.pending_prompt != new.pending_prompt
        || old.pending_options != new.pending_options
        || old.prompt_event_id != new.prompt_event_id
        || old.prompt_hash != new.prompt_hash
        || old.event_seq != new.event_seq
        || old.operational_state != new.operational_state
        || old.telemetry_health != new.telemetry_health
        || old.last_event_at != new.last_event_at
        || old.service_epoch != new.service_epoch
        || old.telemetry != new.telemetry
}

/// Bindings match when everything except `source_revision` is equal;
/// `source_revision` is only known after the transcript has been re-read.
fn binding_matches(prior: &LiveBinding, next: &LiveBinding) -> bool {
    prior.pty_session_id == next.pty_session_id
        && prior.agent_session_id == next.agent_session_id
        && prior.agent_kind == next.agent_kind
        && prior.pty_instance_id == next.pty_instance_id
        && prior.pty_generation == next.pty_generation
        && prior.pty_input_revision == next.pty_input_revision
}

fn reuses_prior_snapshot(prior: Option<&SessionSnapshot>, path: &Path, metadata: &std::fs::Metadata, binding: &LiveBinding) -> bool {
    let Some(prior) = prior else { return false };
    prior.brief.telemetry_health == "live"
        && !prior.cursor.file_identity.is_empty()
        && prior.cursor.file_identity == file_identity(path, metadata)
        && binding_matches(&prior.brief.binding, binding)
}

fn can_advance_prior(prior: &SessionSnapshot, path: &Path, binding: &LiveBinding) -> bool {
    prior.brief.telemetry_health == "live"
        && prior.cursor.path == path
        && binding_matches(&prior.brief.binding, binding)
}

/// Recursive discovery is reserved for first bind and recovery. A live
/// snapshot whose transcript is still at the bound path must not glob the
/// session tree on every append.
enum TranscriptPathDecision {
    Unchanged,
    Cached(PathBuf),
    NeedsDiscovery,
}

enum AdvanceFailAction {
    Rediscover,
    Bootstrap,
}

enum PathApply {
    Unchanged,
    Ready(SessionSnapshot),
    Rediscover,
    Unavailable,
}

fn transcript_path_decision(prior: Option<&SessionSnapshot>, binding: &LiveBinding) -> TranscriptPathDecision {
    let Some(prior) = prior.filter(|prior| prior.brief.telemetry_health == "live") else {
        return TranscriptPathDecision::NeedsDiscovery;
    };
    if prior.cursor.path.as_os_str().is_empty() || !binding_matches(&prior.brief.binding, binding) {
        return TranscriptPathDecision::NeedsDiscovery;
    }
    match std::fs::metadata(&prior.cursor.path) {
        Ok(metadata) if reuses_prior_snapshot(Some(prior), &prior.cursor.path, &metadata, binding) => {
            TranscriptPathDecision::Unchanged
        }
        Ok(_) => TranscriptPathDecision::Cached(prior.cursor.path.clone()),
        Err(_) => TranscriptPathDecision::NeedsDiscovery,
    }
}

fn refresh_bound_transcript(
    prior: Option<&SessionSnapshot>,
    binding: &LiveBinding,
    kind: &str,
    session_id: &str,
    service_epoch: &str,
    history_cwd: Option<&str>,
    history_branch: Option<&str>,
    mut locate: impl FnMut(&str, &str) -> Option<PathBuf>,
) -> Option<SessionSnapshot> {
    match transcript_path_decision(prior, binding) {
        TranscriptPathDecision::Unchanged => None,
        TranscriptPathDecision::Cached(path) => {
            match apply_known_transcript_path(
                prior,
                &path,
                binding,
                kind,
                service_epoch,
                history_cwd,
                history_branch,
                AdvanceFailAction::Rediscover,
            ) {
                PathApply::Unchanged => None,
                PathApply::Ready(snapshot) => Some(snapshot),
                PathApply::Unavailable => {
                    Some(unavailable_snapshot(binding.clone(), "unavailable", service_epoch))
                }
                PathApply::Rediscover => refresh_discovered_transcript(
                    prior,
                    binding,
                    kind,
                    session_id,
                    service_epoch,
                    history_cwd,
                    history_branch,
                    &mut locate,
                ),
            }
        }
        TranscriptPathDecision::NeedsDiscovery => refresh_discovered_transcript(
            prior,
            binding,
            kind,
            session_id,
            service_epoch,
            history_cwd,
            history_branch,
            &mut locate,
        ),
    }
}

fn refresh_discovered_transcript(
    prior: Option<&SessionSnapshot>,
    binding: &LiveBinding,
    kind: &str,
    session_id: &str,
    service_epoch: &str,
    history_cwd: Option<&str>,
    history_branch: Option<&str>,
    locate: &mut impl FnMut(&str, &str) -> Option<PathBuf>,
) -> Option<SessionSnapshot> {
    let Some(path) = locate(kind, session_id) else {
        return Some(unavailable_snapshot(binding.clone(), "unavailable", service_epoch));
    };
    match apply_known_transcript_path(
        prior,
        &path,
        binding,
        kind,
        service_epoch,
        history_cwd,
        history_branch,
        AdvanceFailAction::Bootstrap,
    ) {
        PathApply::Unchanged => None,
        PathApply::Ready(snapshot) => Some(snapshot),
        PathApply::Unavailable | PathApply::Rediscover => {
            Some(unavailable_snapshot(binding.clone(), "unavailable", service_epoch))
        }
    }
}

fn apply_known_transcript_path(
    prior: Option<&SessionSnapshot>,
    path: &Path,
    binding: &LiveBinding,
    kind: &str,
    service_epoch: &str,
    history_cwd: Option<&str>,
    history_branch: Option<&str>,
    on_advance_fail: AdvanceFailAction,
) -> PathApply {
    let Ok(metadata) = std::fs::metadata(path) else {
        return match on_advance_fail {
            AdvanceFailAction::Rediscover => PathApply::Rediscover,
            AdvanceFailAction::Bootstrap => PathApply::Unavailable,
        };
    };
    if reuses_prior_snapshot(prior, path, &metadata, binding) {
        return PathApply::Unchanged;
    }
    if let Some(prior) = prior.filter(|prior| can_advance_prior(prior, path, binding)) {
        match advance_transcript_with_history(
            prior.clone(),
            &metadata,
            binding,
            service_epoch,
            history_cwd,
            history_branch,
        ) {
            Ok(snapshot) => return PathApply::Ready(snapshot),
            Err(_) => {
                if matches!(on_advance_fail, AdvanceFailAction::Rediscover) {
                    return PathApply::Rediscover;
                }
            }
        }
    }
    match bootstrap_transcript_with_history(path, kind, binding, service_epoch, history_cwd, history_branch) {
        Ok(snapshot) => PathApply::Ready(snapshot),
        Err(_) => PathApply::Unavailable,
    }
}

fn clamp_event_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(DEFAULT_EVENT_LIMIT).clamp(MIN_EVENT_LIMIT, RING_CAPACITY)
}

fn locate_transcript(kind: &str, session_id: &str) -> Option<PathBuf> {
    let root = match kind {
        "claude" => crate::ailog::claude_root()?,
        "claude-codex" => crate::ailog::claude_codex_root()?,
        "codex" => crate::ailog::codex_root()?,
        "grok" => grok_root()?,
        _ => return None,
    };
    let pattern = match kind {
        "claude" | "claude-codex" => format!("{}/**/{}.jsonl", root.display(), session_id),
        "codex" => format!("{}/**/*{}.jsonl", root.display(), session_id),
        "grok" => format!("{}/**/{}/updates.jsonl", root.display(), session_id),
        _ => unreachable!(),
    };
    newest_path_by_mtime(glob::glob(&pattern).ok()?.filter_map(Result::ok))
}

fn newest_path_by_mtime(paths: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    paths
        .into_iter()
        .filter(|path| path.is_file())
        .max_by(|left, right| file_mtime(left).cmp(&file_mtime(right)))
}

fn file_mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|metadata| metadata.modified()).ok()
}

fn mapping_dir() -> Option<PathBuf> {
    crate::test_profile::runtime_dir()
        .ok()
        .map(|runtime_dir| runtime_dir.join("pane-sessions"))
}

/// Newest pane among duplicates of the same (kind, session_id). Any missing
/// mapping-file mtime fails closed to "all unavailable".
fn newest_pane_by_mapping_mtime(map_dir: &Path, pane_ids: &[&str]) -> Option<String> {
    let mut best: Option<(SystemTime, &str)> = None;
    for id in pane_ids {
        let mtime = std::fs::metadata(map_dir.join(format!("{id}.txt")))
            .and_then(|metadata| metadata.modified())
            .ok()?;
        match best {
            Some((best_time, _)) if mtime <= best_time => {}
            _ => best = Some((mtime, *id)),
        }
    }
    best.map(|(_, id)| id.to_string())
}

fn grok_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".grok").join("sessions"))
}

fn bootstrap_transcript(
    path: &Path,
    kind: &str,
    binding: &LiveBinding,
    service_epoch: &str,
) -> Result<SessionSnapshot, String> {
    bootstrap_transcript_with_history(path, kind, binding, service_epoch, None, None)
}

fn bootstrap_transcript_with_history(
    path: &Path,
    kind: &str,
    binding: &LiveBinding,
    service_epoch: &str,
    history_cwd: Option<&str>,
    history_branch: Option<&str>,
) -> Result<SessionSnapshot, String> {
    bootstrap_transcript_windowed(
        path,
        kind,
        binding,
        service_epoch,
        history_cwd,
        history_branch,
        MAX_BOOTSTRAP_BYTES,
    )
}

fn bootstrap_transcript_windowed(
    path: &Path,
    kind: &str,
    binding: &LiveBinding,
    service_epoch: &str,
    history_cwd: Option<&str>,
    history_branch: Option<&str>,
    max_bootstrap_bytes: u64,
) -> Result<SessionSnapshot, String> {
    let metadata = std::fs::metadata(path).map_err(|error| format!("stat transcript: {error}"))?;
    let (bytes, base_offset) = read_bootstrap_window_limited(path, metadata.len(), max_bootstrap_bytes)?;
    let file_identity = file_identity(path, &metadata);
    let mut adapter = AgentAdapter::new(kind)?;
    let mut reducer = LiveBriefReducer::new();
    let mut events = VecDeque::new();
    let mut history_events = Vec::new();
    let parsed = complete_line_records(&bytes, base_offset);
    let (source_revision, decode_skipped) = apply_decoded_records(
        &mut adapter,
        &mut reducer,
        &mut events,
        &mut history_events,
        parsed.records,
        0,
    );
    warn_skipped_lines(path, parsed.skipped.saturating_add(decode_skipped));
    // History is best-effort only: a corrupt or locked history.db must never
    // stop livebrief's transcript poll or prevent its snapshot from updating.
    ingest_history_events(path, binding, history_cwd, history_branch, &history_events);
    let mut binding = binding.clone();
    binding.source_revision = source_revision;
    let now = unix_ms();
    let mut brief = reducer.to_brief(binding.clone(), "live", service_epoch, now);
    brief.brief_revision = source_revision;
    let cursor = TailCursor {
        path: path.to_path_buf(),
        file_identity,
        stream_generation: 1,
        // Absolute end of what was actually read, which can exceed the stat'd
        // length if the transcript grew between the stat and the read.
        read_offset: base_offset.saturating_add(bytes.len() as u64),
        committed_offset: parsed.committed_end,
        pending_bytes: parsed.pending_bytes,
        committed_anchor: transcript_anchor(path, parsed.committed_end)?,
    };
    Ok(SessionSnapshot { brief, cursor, adapter, reducer, events })
}

/// Operator prompts in `path`, oldest first, capped to the newest `max`.
///
/// This deliberately reuses the livebrief decode path (`AgentAdapter` plus
/// `complete_line_records`) rather than reading the JSONL a second way: the
/// adapter already knows which `user` records are something a person typed,
/// dropping meta records, tool results and injected reminders.
fn transcript_user_prompts(
    path: &Path,
    kind: &str,
    max: usize,
) -> Result<Vec<TranscriptPrompt>, String> {
    let metadata = std::fs::metadata(path).map_err(|error| format!("stat transcript: {error}"))?;
    let (bytes, base_offset) =
        read_bootstrap_window_limited(path, metadata.len(), MAX_PROMPT_SCAN_BYTES)?;
    let mut adapter = AgentAdapter::new(kind)?;
    let parsed = complete_line_records(&bytes, base_offset);
    let mut prompts: VecDeque<TranscriptPrompt> = VecDeque::new();
    let mut source_revision = 0u64;
    for (raw, range) in parsed.records {
        source_revision = source_revision.saturating_add(1);
        let Ok(decoded) = adapter.decode_record(raw, range, source_revision) else {
            continue;
        };
        for event in decoded {
            let occurred_at = event.occurred_at;
            let SemanticEventKind::UserMessage { text, .. } = event.kind else {
                continue;
            };
            if text.trim().is_empty() {
                continue;
            }
            prompts.push_back(TranscriptPrompt { text, occurred_at });
            if prompts.len() > max {
                prompts.pop_front();
            }
        }
    }
    Ok(prompts.into())
}

/// Prompts for whichever agent session the pane is mapped to right now.
///
/// Every failure — no mapping, an unsupported kind, no transcript on disk —
/// returns an empty list on purpose. Restoring nothing is always better than
/// restoring another pane's conversation onto this one's scrollback.
fn pane_transcript_user_prompts(pty_session_id: &str, max: usize) -> Vec<TranscriptPrompt> {
    let mappings = agent_mappings_for_ids([pty_session_id]);
    let Some(mapping) = mappings.get(pty_session_id) else {
        return Vec::new();
    };
    let Some(kind) = mapping.agent_kind.as_deref() else {
        return Vec::new();
    };
    let Some(path) = locate_transcript(kind, &mapping.session_id) else {
        return Vec::new();
    };
    transcript_user_prompts(&path, kind, max).unwrap_or_default()
}

/// Read at most `max_bytes` from the end of the file. If the window starts
/// mid-line, decoding begins after the first newline so byte offsets stay
/// aligned with the real file for later incremental tail reads.
fn read_bootstrap_window_limited(
    path: &Path,
    file_len: u64,
    max_bytes: u64,
) -> Result<(Vec<u8>, u64), String> {
    if file_len <= max_bytes {
        let bytes = std::fs::read(path).map_err(|error| format!("read transcript: {error}"))?;
        return Ok((bytes, 0));
    }
    let window_start = file_len.saturating_sub(max_bytes);
    let mut file = File::open(path).map_err(|error| format!("open transcript: {error}"))?;
    file.seek(SeekFrom::Start(window_start))
        .map_err(|error| format!("seek transcript: {error}"))?;
    let mut bytes = Vec::new();
    file.take(max_bytes)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read transcript: {error}"))?;
    match bytes.iter().position(|byte| *byte == b'\n') {
        Some(newline) => {
            let skip = newline + 1;
            let decode_start = window_start.saturating_add(skip as u64);
            bytes.drain(..skip);
            Ok((bytes, decode_start))
        }
        None => Ok((bytes, window_start)),
    }
}

fn apply_decoded_records(
    adapter: &mut AgentAdapter,
    reducer: &mut LiveBriefReducer,
    events: &mut VecDeque<SemanticEventEnvelope>,
    history_events: &mut Vec<JournalEvent>,
    records: Vec<(&str, ByteRange)>,
    mut source_revision: u64,
) -> (u64, usize) {
    let mut skipped = 0;
    for (raw, range) in records {
        source_revision = source_revision.saturating_add(1);
        match adapter.decode_record(raw, range, source_revision) {
            Ok(decoded) => {
                if let Some(delta) = adapter.take_telemetry_delta() {
                    reducer.apply_telemetry(delta);
                }
                for event in decoded {
                    reducer.apply(&event);
                    history_events.push(JournalEvent::from_raw_line(event.clone(), raw));
                    events.push_back(event);
                    if events.len() > RING_CAPACITY {
                        events.pop_front();
                    }
                }
            }
            Err(_) => skipped += 1,
        }
    }
    (source_revision, skipped)
}

fn warn_skipped_lines(path: &Path, skipped: usize) {
    if skipped == 0 {
        return;
    }
    crate::diag_warn!(
        "livebrief",
        "skipped {skipped} malformed transcript line(s) in {}",
        path.display()
    );
}

fn advance_transcript_with_history(
    mut snapshot: SessionSnapshot,
    metadata: &std::fs::Metadata,
    binding: &LiveBinding,
    service_epoch: &str,
    history_cwd: Option<&str>,
    history_branch: Option<&str>,
) -> Result<SessionSnapshot, String> {
    if metadata.len() < snapshot.cursor.read_offset
        || transcript_anchor(&snapshot.cursor.path, snapshot.cursor.committed_offset)? != snapshot.cursor.committed_anchor
    {
        return Err("transcript tail cursor no longer matches source".to_string());
    }
    let mut file = File::open(&snapshot.cursor.path).map_err(|error| format!("open transcript tail: {error}"))?;
    file.seek(SeekFrom::Start(snapshot.cursor.read_offset)).map_err(|error| format!("seek transcript tail: {error}"))?;
    let mut appended = Vec::new();
    file.read_to_end(&mut appended).map_err(|error| format!("read transcript tail: {error}"))?;
    let mut bytes = std::mem::take(&mut snapshot.cursor.pending_bytes);
    bytes.extend_from_slice(&appended);
    let parsed = complete_line_records(&bytes, snapshot.cursor.committed_offset);
    let mut history_events = Vec::new();
    let committed_offset = parsed.committed_end;
    let (source_revision, decode_skipped) = apply_decoded_records(
        &mut snapshot.adapter,
        &mut snapshot.reducer,
        &mut snapshot.events,
        &mut history_events,
        parsed.records,
        snapshot.brief.binding.source_revision,
    );
    warn_skipped_lines(&snapshot.cursor.path, parsed.skipped.saturating_add(decode_skipped));
    let pending_bytes = parsed.pending_bytes;
    ingest_history_events(&snapshot.cursor.path, binding, history_cwd, history_branch, &history_events);
    let mut binding = binding.clone();
    binding.source_revision = source_revision;
    let now = unix_ms();
    snapshot.brief = snapshot.reducer.to_brief(binding, "live", service_epoch, now);
    snapshot.cursor.file_identity = file_identity(&snapshot.cursor.path, metadata);
    snapshot.cursor.read_offset = metadata.len();
    snapshot.cursor.committed_offset = committed_offset;
    snapshot.cursor.pending_bytes = pending_bytes;
    snapshot.cursor.committed_anchor = transcript_anchor(&snapshot.cursor.path, committed_offset)?;
    Ok(snapshot)
}

fn ingest_history_events(
    path: &Path,
    binding: &LiveBinding,
    history_cwd: Option<&str>,
    history_branch: Option<&str>,
    events: &[JournalEvent],
) {
    if events.is_empty() { return; }
    crate::history::try_ingest(&IngestInput {
        logical_session_id: &binding.agent_session_id,
        agent_session_id: &binding.agent_session_id,
        agent_kind: &binding.agent_kind,
        pty_session_id: &binding.pty_session_id,
        repo_id: None,
        cwd: history_cwd,
        branch: history_branch,
        source_log: path,
        events,
    });
}

/// Complete JSONL lines carved out of `bytes`, which start at absolute file
/// offset `base_offset`.
struct ParsedRecords<'a> {
    records: Vec<(&'a str, ByteRange)>,
    /// Trailing bytes after the last newline; not yet a complete line.
    pending_bytes: Vec<u8>,
    /// Absolute offset just past the last complete line (including bad ones).
    committed_end: u64,
    /// Lines dropped because they were oversized or not valid UTF-8.
    skipped: usize,
}

/// Never fails: an oversized or non-UTF-8 line is dropped and counted instead
/// of poisoning the whole read. One bad line must not blank a whole session.
fn complete_line_records(bytes: &[u8], base_offset: u64) -> ParsedRecords<'_> {
    let mut records = Vec::new();
    let mut skipped = 0usize;
    let mut start = 0usize;
    let mut committed_end = base_offset;
    while let Some(relative_end) = bytes[start..].iter().position(|byte| *byte == b'\n') {
        let end = start + relative_end + 1;
        committed_end = base_offset.saturating_add(end as u64);
        let line = bytes[start..end - 1].strip_suffix(b"\r").unwrap_or(&bytes[start..end - 1]);
        let range = ByteRange {
            start: base_offset.saturating_add(start as u64),
            end: base_offset.saturating_add(end as u64),
        };
        start = end;
        if line.is_empty() {
            continue;
        }
        if line.len() > MAX_LINE_BYTES {
            skipped += 1;
            continue;
        }
        match std::str::from_utf8(line) {
            Ok(text) => records.push((text, range)),
            Err(_) => skipped += 1,
        }
    }
    let mut parsed =
        ParsedRecords { records, pending_bytes: bytes[start..].to_vec(), committed_end, skipped };
    parsed.discard_overlong_pending();
    parsed
}

impl ParsedRecords<'_> {
    /// An unterminated fragment longer than `MAX_LINE_BYTES` can never become a
    /// line we would accept, so it is dropped instead of being carried (and
    /// grown) in the tail cursor forever. The committed offset skips past it so
    /// the cursor stays aligned with the file.
    fn discard_overlong_pending(&mut self) {
        if self.pending_bytes.len() <= MAX_LINE_BYTES {
            return;
        }
        self.committed_end = self.committed_end.saturating_add(self.pending_bytes.len() as u64);
        self.pending_bytes = Vec::new();
        self.skipped = self.skipped.saturating_add(1);
    }
}

fn transcript_anchor(path: &Path, committed_offset: u64) -> Result<String, String> {
    let start = committed_offset.saturating_sub(256);
    let mut file = File::open(path).map_err(|error| format!("open transcript anchor: {error}"))?;
    file.seek(SeekFrom::Start(start)).map_err(|error| format!("seek transcript anchor: {error}"))?;
    let mut bytes = Vec::new();
    file.take(committed_offset.saturating_sub(start)).read_to_end(&mut bytes).map_err(|error| format!("read transcript anchor: {error}"))?;
    Ok(sha256_hex(&bytes))
}

fn unavailable_snapshot(binding: LiveBinding, health: &str, service_epoch: &str) -> SessionSnapshot {
    let now = unix_ms();
    let brief = LiveSessionBrief {
        binding, task: None, latest_instruction: None, task_source_event_ids: Vec::new(), activity_kind: None, activity_text: None,
        activity_source_event_id: None, checkpoint: None, checkpoint_evidence_event_ids: Vec::new(),
        pending_input_kind: None, pending_prompt: None, pending_options: Vec::new(), prompt_event_id: None,
        prompt_hash: None, event_seq: 0, operational_state: "running".to_string(), telemetry_health: health.to_string(),
        last_event_at: None, last_successful_read_at: None, updated_at: now, service_epoch: service_epoch.to_string(), brief_revision: 0,
        telemetry: None,
    };
    SessionSnapshot { brief, cursor: TailCursor { path: PathBuf::new(), file_identity: String::new(), stream_generation: 0, read_offset: 0, committed_offset: 0, pending_bytes: Vec::new(), committed_anchor: String::new() }, adapter: AgentAdapter::new("codex").expect("supported adapter"), reducer: LiveBriefReducer::new(), events: VecDeque::new() }
}

fn file_identity(path: &Path, metadata: &std::fs::Metadata) -> String {
    let changed = metadata.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map(|duration| duration.as_nanos()).unwrap_or_default();
    format!("{}:{}:{}", path.display(), metadata.len(), changed)
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String { hex::encode(Sha256::digest(bytes)) }
pub(crate) fn unix_ms() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_millis() as i64).unwrap_or_default() }

#[tauri::command(async)]
pub async fn get_live_briefs(state: State<'_, AppState>) -> Result<Vec<LiveSessionBrief>, String> { Ok(state.livebrief_service.snapshots()) }

#[tauri::command(async)]
pub async fn subscribe_live_briefs(state: State<'_, AppState>) -> Result<(), String> {
    state.livebrief_service.subscribe();
    Ok(())
}

#[tauri::command(async)]
pub async fn unsubscribe_live_briefs(state: State<'_, AppState>) -> Result<(), String> {
    state.livebrief_service.unsubscribe();
    Ok(())
}

#[tauri::command(async)]
pub async fn get_live_events(
    state: State<'_, AppState>,
    pty_session_ids: Vec<String>,
    limit: Option<usize>,
) -> Result<Vec<LiveSessionEvents>, String> {
    Ok(state.livebrief_service.events(&pty_session_ids, clamp_event_limit(limit)))
}

/// Prompts a pane's agent recorded before mycmux was watching it type.
///
/// Used only by turn-mark restore after a replayed pane finishes redrawing.
#[tauri::command(async)]
pub async fn get_transcript_user_prompts(
    pty_session_id: String,
    limit: Option<usize>,
) -> Result<Vec<TranscriptPrompt>, String> {
    let max = limit
        .unwrap_or(MAX_RESTORED_PROMPTS)
        .clamp(1, MAX_RESTORED_PROMPTS);
    crate::util::task::run_blocking("get_transcript_user_prompts", move || {
        Ok(pane_transcript_user_prompts(&pty_session_id, max))
    })
    .await
}

#[tauri::command(async)]
pub async fn send_intervention(
    state: State<'_, AppState>,
    expectation: InterventionExpectation,
    action: InterventionAction,
) -> Result<InterventionResult, String> {
    let service = state.livebrief_service.clone();
    crate::util::task::run_blocking("send_intervention", move || intervene::send(&service, expectation, action)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::io::Write;

    #[test]
    fn a_multibyte_character_split_by_the_read_boundary_stays_pending() {
        // The tail is a truncated UTF-8 sequence, not a complete line: it must
        // wait for the rest of the character instead of being decoded or dropped.
        let parsed = complete_line_records(b"{\"x\":1}\n{\"x\":\"\xe3\x81", 0);
        assert_eq!(parsed.records.len(), 1);
        assert_eq!(parsed.records[0].0, "{\"x\":1}");
        assert_eq!(parsed.skipped, 0);
        assert_eq!(parsed.pending_bytes, b"{\"x\":\"\xe3\x81".to_vec());
    }

    fn test_binding() -> LiveBinding {
        LiveBinding {
            pty_session_id: "pane-1".to_string(),
            agent_session_id: "agent-1".to_string(),
            agent_kind: "codex".to_string(),
            pty_instance_id: "pty-3".to_string(),
            pty_generation: 3,
            source_revision: 0,
            pty_input_revision: 9,
        }
    }

    #[test]
    fn event_history_never_outgrows_the_ring_capacity() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("rollout.jsonl");
        let body: String = (0..(RING_CAPACITY * 2))
            .map(|index| format!("{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\",\"message\":\"m{index}\"}}}}\n"))
            .collect();
        std::fs::write(&path, body).expect("write transcript");
        let snapshot = bootstrap_transcript(&path, "codex", &test_binding(), "epoch").expect("bootstrap");
        assert_eq!(snapshot.events.len(), RING_CAPACITY);
        assert_eq!(snapshot.brief.event_seq, (RING_CAPACITY * 2) as u64);
    }

    #[test]
    fn transcript_append_advances_only_the_tail() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("rollout.jsonl");
        let first = "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"first\"}}\n";
        let second = "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"second\"}}\n";
        std::fs::write(&path, first).expect("write first record");
        let snapshot = bootstrap_transcript(&path, "codex", &test_binding(), "epoch").expect("bootstrap");
        std::fs::OpenOptions::new().append(true).open(&path).expect("open append").write_all(second.as_bytes()).expect("append record");
        let metadata = std::fs::metadata(&path).expect("stat appended transcript");
        let advanced = advance_transcript_with_history(snapshot, &metadata, &test_binding(), "epoch", None, None).expect("advance tail");
        assert_eq!(advanced.cursor.read_offset, metadata.len());
        assert_eq!(advanced.cursor.committed_offset, metadata.len());
        assert_eq!(advanced.brief.binding.source_revision, 2);
        assert_eq!(advanced.brief.event_seq, 2);
    }

    fn codex_user_line(message: &str) -> String {
        format!("{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\",\"message\":\"{message}\"}}}}\n")
    }

    fn user_message_texts(snapshot: &SessionSnapshot) -> Vec<String> {
        snapshot
            .events
            .iter()
            .filter_map(|event| match &event.kind {
                adapter::SemanticEventKind::UserMessage { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    fn claude_user_line(text: &str) -> String {
        format!(
            "{{\"type\":\"user\",\"timestamp\":\"2026-08-20T12:00:00.000Z\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":{}}}]}}}}\n",
            serde_json::to_string(text).expect("encode text")
        )
    }

    #[test]
    fn transcript_prompts_keep_transcript_order() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("session.jsonl");
        let body: String = ["first prompt", "Go", "second prompt", "Go"]
            .iter()
            .map(|text| claude_user_line(text))
            .collect();
        std::fs::write(&path, body).expect("write transcript");

        let prompts = transcript_user_prompts(&path, "claude", MAX_RESTORED_PROMPTS)
            .expect("read prompts");

        let texts: Vec<&str> = prompts.iter().map(|prompt| prompt.text.as_str()).collect();
        assert_eq!(texts, vec!["first prompt", "Go", "second prompt", "Go"]);
    }

    /// Injected scaffolding reaches the transcript as `user` records but was
    /// never typed, so it must not become a turn mark.
    #[test]
    fn transcript_prompts_drop_injected_and_meta_records() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("session.jsonl");
        let mut body = claude_user_line("real prompt");
        body.push_str(&claude_user_line("<system-reminder>not typed</system-reminder>"));
        body.push_str(&claude_user_line("<command-name>/clear</command-name>"));
        body.push_str("{\"type\":\"user\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"meta\"}}\n");
        body.push_str("{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"reply\"}]}}\n");
        std::fs::write(&path, body).expect("write transcript");

        let prompts = transcript_user_prompts(&path, "claude", MAX_RESTORED_PROMPTS)
            .expect("read prompts");

        let texts: Vec<&str> = prompts.iter().map(|prompt| prompt.text.as_str()).collect();
        assert_eq!(texts, vec!["real prompt"]);
    }

    #[test]
    fn transcript_prompts_keep_only_the_newest_when_capped() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("session.jsonl");
        let body: String = (0..10).map(|index| claude_user_line(&format!("p{index}"))).collect();
        std::fs::write(&path, body).expect("write transcript");

        let prompts = transcript_user_prompts(&path, "claude", 3).expect("read prompts");

        let texts: Vec<&str> = prompts.iter().map(|prompt| prompt.text.as_str()).collect();
        assert_eq!(texts, vec!["p7", "p8", "p9"]);
    }

    /// An unmapped pane must yield nothing rather than guessing a transcript.
    #[test]
    fn pane_prompts_are_empty_without_a_mapping() {
        assert!(pane_transcript_user_prompts("pane-that-has-no-mapping-file", 10).is_empty());
    }

    fn set_mtime(path: &Path, seconds_since_epoch: u64) {
        let file = std::fs::OpenOptions::new().write(true).open(path).expect("open for set_modified");
        file.set_modified(UNIX_EPOCH + Duration::from_secs(seconds_since_epoch))
            .expect("set_modified");
    }

    /// A-1: a transcript over the bootstrap limit must still produce a live
    /// brief built from its tail instead of failing the whole session.
    #[test]
    fn an_oversized_transcript_bootstraps_from_its_tail_window() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("rollout.jsonl");
        let body: String = (0..200).map(|index| codex_user_line(&format!("m{index}"))).collect();
        std::fs::write(&path, &body).expect("write transcript");
        let file_len = std::fs::metadata(&path).expect("stat").len();

        let snapshot =
            bootstrap_transcript_windowed(&path, "codex", &test_binding(), "epoch", None, None, 512)
                .expect("windowed bootstrap");

        let texts = user_message_texts(&snapshot);
        assert!(!texts.is_empty(), "tail window must still yield events");
        assert!(texts.len() < 200, "only the tail window is decoded");
        assert_eq!(texts.last().map(String::as_str), Some("m199"));
        // Offsets stay absolute so the incremental tail read keeps working.
        assert_eq!(snapshot.cursor.read_offset, file_len);
        assert_eq!(snapshot.cursor.committed_offset, file_len);
        assert!(snapshot.cursor.pending_bytes.is_empty());
        assert_eq!(snapshot.brief.telemetry_health, "live");
    }

    /// A-1 follow-up: the tail cursor of a windowed bootstrap must advance.
    #[test]
    fn a_windowed_bootstrap_still_advances_on_append() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("rollout.jsonl");
        let body: String = (0..200).map(|index| codex_user_line(&format!("m{index}"))).collect();
        std::fs::write(&path, &body).expect("write transcript");
        let snapshot =
            bootstrap_transcript_windowed(&path, "codex", &test_binding(), "epoch", None, None, 512)
                .expect("windowed bootstrap");

        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open append")
            .write_all(codex_user_line("tail").as_bytes())
            .expect("append record");
        let metadata = std::fs::metadata(&path).expect("stat appended transcript");
        let advanced =
            advance_transcript_with_history(snapshot, &metadata, &test_binding(), "epoch", None, None)
                .expect("advance tail");

        assert_eq!(advanced.cursor.read_offset, metadata.len());
        assert_eq!(advanced.cursor.committed_offset, metadata.len());
        assert_eq!(user_message_texts(&advanced).last().map(String::as_str), Some("tail"));
    }

    /// A-2: one giant, non-UTF-8 or unparsable line must not blank the session.
    #[test]
    fn malformed_lines_are_skipped_without_losing_the_good_ones() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("rollout.jsonl");
        let mut body: Vec<u8> = Vec::new();
        body.extend_from_slice(codex_user_line("first").as_bytes());
        // Oversized single line (base64 attachment shaped).
        body.extend_from_slice(b"{\"blob\":\"");
        body.extend(std::iter::repeat(b'A').take(MAX_LINE_BYTES + 16));
        body.extend_from_slice(b"\"}\n");
        // Invalid UTF-8 line.
        body.extend_from_slice(&[0xff, 0xfe, b'\n']);
        // Complete but unparsable JSON line.
        body.extend_from_slice(b"this is not json\n");
        body.extend_from_slice(codex_user_line("second").as_bytes());
        std::fs::write(&path, &body).expect("write transcript");
        let file_len = std::fs::metadata(&path).expect("stat").len();

        let snapshot = bootstrap_transcript(&path, "codex", &test_binding(), "epoch").expect("bootstrap");

        assert_eq!(user_message_texts(&snapshot), vec!["first".to_string(), "second".to_string()]);
        assert_eq!(snapshot.brief.telemetry_health, "live");
        assert_eq!(snapshot.cursor.committed_offset, file_len);
    }

    #[test]
    fn complete_line_records_counts_skips_and_keeps_offsets_absolute() {
        let mut bytes: Vec<u8> = Vec::new();
        bytes.extend_from_slice(b"{\"a\":1}\n");
        bytes.extend_from_slice(&[0xff, b'\n']);
        bytes.extend_from_slice(b"{\"b\":2}\n");
        bytes.extend_from_slice(b"partial");
        let parsed = complete_line_records(&bytes, 1_000);
        assert_eq!(parsed.skipped, 1);
        assert_eq!(parsed.records.len(), 2);
        assert_eq!(parsed.records[0].1.start, 1_000);
        assert_eq!(parsed.records[1].1.start, 1_010);
        assert_eq!(parsed.committed_end, 1_018);
        assert_eq!(parsed.pending_bytes, b"partial".to_vec());
    }

    #[test]
    fn an_overlong_unterminated_fragment_is_not_carried_in_the_cursor() {
        let mut bytes: Vec<u8> = Vec::new();
        bytes.extend_from_slice(b"{\"a\":1}\n");
        bytes.extend(std::iter::repeat(b'A').take(MAX_LINE_BYTES + 1));
        let parsed = complete_line_records(&bytes, 0);
        assert_eq!(parsed.records.len(), 1);
        assert!(parsed.pending_bytes.is_empty());
        assert_eq!(parsed.skipped, 1);
        assert_eq!(parsed.committed_end, bytes.len() as u64);
    }

    /// A-3: duplicated transcripts for one session id resolve to the newest.
    #[test]
    fn newest_path_by_mtime_prefers_the_most_recent_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let stale = dir.path().join("stale.jsonl");
        let fresh = dir.path().join("fresh.jsonl");
        let missing = dir.path().join("missing.jsonl");
        std::fs::write(&stale, b"{}\n").expect("write stale");
        std::fs::write(&fresh, b"{}\n").expect("write fresh");
        set_mtime(&stale, 1_700_000_000);
        set_mtime(&fresh, 1_700_000_600);

        let picked = newest_path_by_mtime(vec![missing, stale.clone(), fresh.clone()]);
        assert_eq!(picked, Some(fresh));

        let only_stale = newest_path_by_mtime(vec![stale.clone()]);
        assert_eq!(only_stale, Some(stale));
        assert_eq!(newest_path_by_mtime(Vec::new()), None);
    }

    /// A-4: duplicated (kind, session id) mappings keep the newest pane live.
    #[test]
    fn newest_pane_by_mapping_mtime_picks_the_latest_and_fails_closed() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("pane-a.txt"), b"codex:s1").expect("write pane-a");
        std::fs::write(dir.path().join("pane-b.txt"), b"codex:s1").expect("write pane-b");
        set_mtime(&dir.path().join("pane-a.txt"), 1_700_000_000);
        set_mtime(&dir.path().join("pane-b.txt"), 1_700_000_600);

        assert_eq!(
            newest_pane_by_mapping_mtime(dir.path(), &["pane-a", "pane-b"]),
            Some("pane-b".to_string())
        );
        // A missing mapping file falls back to the old "all unavailable" rule.
        assert_eq!(newest_pane_by_mapping_mtime(dir.path(), &["pane-a", "pane-gone"]), None);
        assert_eq!(newest_pane_by_mapping_mtime(dir.path(), &[]), None);
    }

    #[test]
    fn brief_changed_ignores_the_per_tick_timestamps() {
        let old = unavailable_snapshot(test_binding(), "live", "epoch").brief;
        let mut next = old.clone();
        next.updated_at += 5_000;
        next.last_successful_read_at = Some(old.updated_at + 5_000);
        next.brief_revision += 7;
        assert!(!brief_changed(&old, &next));
        next.task = Some("build the thing".to_string());
        assert!(brief_changed(&old, &next));
    }

    #[test]
    fn brief_changed_still_sees_a_new_source_revision() {
        let old = unavailable_snapshot(test_binding(), "live", "epoch").brief;
        let mut next = old.clone();
        next.binding.source_revision += 1;
        assert!(brief_changed(&old, &next));
    }

    #[test]
    fn the_brief_exposes_latest_instruction_as_camel_case() {
        let mut brief = unavailable_snapshot(test_binding(), "live", "epoch").brief;
        brief.latest_instruction = Some("run the tests".to_string());
        let json: serde_json::Value = serde_json::from_str(&serde_json::to_string(&brief).unwrap()).unwrap();
        assert_eq!(json.get("latestInstruction").and_then(serde_json::Value::as_str), Some("run the tests"));
    }

    #[test]
    fn brief_changed_sees_a_new_latest_instruction() {
        let old = unavailable_snapshot(test_binding(), "live", "epoch").brief;
        let mut next = old.clone();
        next.latest_instruction = Some("run the tests".to_string());
        assert!(brief_changed(&old, &next));
    }

    #[test]
    fn an_ended_agent_keeps_its_history_but_loses_its_pending_question() {
        let mut previous = unavailable_snapshot(test_binding(), "live", "epoch");
        previous.brief.task = Some("ship it".to_string());
        previous.brief.latest_instruction = Some("ship it".to_string());
        previous.brief.activity_kind = Some("Read".to_string());
        previous.brief.activity_text = Some("Inspecting a.rs".to_string());
        previous.brief.checkpoint = Some("Tests: 3 passed, 0 failed".to_string());
        previous.brief.last_event_at = Some(1_700_000_000_000);
        previous.brief.event_seq = 12;
        previous.brief.pending_input_kind = Some(PendingInputKind::Choice);
        previous.brief.pending_prompt = Some("Continue?".to_string());
        previous.brief.pending_options = vec![PendingOption::new("option-0".to_string(), "Yes".to_string(), "y".to_string())];
        previous.brief.prompt_event_id = Some("p1".to_string());
        previous.brief.prompt_hash = Some("hash".to_string());
        previous.events.push_back(SemanticEventEnvelope {
            event_id: "e1".to_string(), source_revision: 1, occurred_at: 1, source_byte_start: 0, source_byte_end: 1,
            kind: adapter::SemanticEventKind::AgentMessage { text: "done".to_string() },
        });

        let mut gone_binding = test_binding();
        gone_binding.pty_input_revision += 1;
        let merged = keep_last_picture(Some(&previous), unavailable_snapshot(gone_binding.clone(), "unlinked", "epoch"));

        assert_eq!(merged.brief.telemetry_health, "ended");
        assert_eq!(merged.brief.operational_state, "ended");
        assert_eq!(merged.brief.task.as_deref(), Some("ship it"));
        assert_eq!(merged.brief.latest_instruction.as_deref(), Some("ship it"));
        assert_eq!(merged.brief.activity_kind.as_deref(), Some("Read"));
        assert_eq!(merged.brief.activity_text.as_deref(), Some("Inspecting a.rs"));
        assert_eq!(merged.brief.checkpoint.as_deref(), Some("Tests: 3 passed, 0 failed"));
        assert_eq!(merged.brief.last_event_at, Some(1_700_000_000_000));
        assert_eq!(merged.brief.event_seq, 12);
        assert_eq!(merged.events.len(), 1);
        assert_eq!(merged.brief.binding, gone_binding);
        assert!(merged.brief.pending_input_kind.is_none());
        assert!(merged.brief.pending_prompt.is_none());
        assert!(merged.brief.pending_options.is_empty());
        assert!(merged.brief.prompt_event_id.is_none());
        assert!(merged.brief.prompt_hash.is_none());

        // Already ended: kept as-is rather than rebuilt on every tick.
        let again = keep_last_picture(Some(&merged), unavailable_snapshot(test_binding(), "unlinked", "epoch"));
        assert_eq!(again.brief.telemetry_health, "ended");
        assert_eq!(again.events.len(), 1);
        assert!(!brief_changed(&merged.brief, &again.brief));

        // A live rebuild always wins over the retained picture.
        let live = keep_last_picture(Some(&merged), unavailable_snapshot(test_binding(), "live", "epoch"));
        assert_eq!(live.brief.telemetry_health, "live");
        assert!(live.brief.task.is_none());
    }

    #[test]
    fn keep_last_picture_drops_telemetry_when_agent_session_changes() {
        use super::telemetry::{TelemetryContext, TelemetryModel};
        let mut previous = unavailable_snapshot(test_binding(), "live", "epoch");
        previous.brief.telemetry = Some(AgentTelemetry {
            model: Some(TelemetryModel { name: "sonnet-4.6".to_string(), effort: Some("high".to_string()) }),
            context: Some(TelemetryContext { pct: Some(34), tokens: Some(68_000) }),
            cost: None,
            turns: None,
        });
        let mut next_binding = test_binding();
        next_binding.agent_session_id = "agent-2".to_string();
        let merged = keep_last_picture(Some(&previous), unavailable_snapshot(next_binding.clone(), "unlinked", "epoch"));
        assert_eq!(merged.brief.binding.agent_session_id, "agent-2");
        assert!(merged.brief.telemetry.is_none());

        let mut revision_only = test_binding();
        revision_only.pty_input_revision += 1;
        let kept = keep_last_picture(Some(&previous), unavailable_snapshot(revision_only, "unlinked", "epoch"));
        assert!(kept.brief.telemetry.is_some());
        assert_eq!(kept.brief.telemetry.as_ref().unwrap().model.as_ref().unwrap().name, "sonnet-4.6");
    }

    #[test]
    fn keep_last_picture_drops_telemetry_after_ended_then_session_change() {
        use super::telemetry::{TelemetryContext, TelemetryModel};
        let sample = AgentTelemetry {
            model: Some(TelemetryModel { name: "sonnet-4.6".to_string(), effort: Some("high".to_string()) }),
            context: Some(TelemetryContext { pct: Some(34), tokens: Some(68_000) }),
            cost: None,
            turns: None,
        };
        let mut live_a = unavailable_snapshot(test_binding(), "live", "epoch");
        live_a.brief.telemetry = Some(sample.clone());

        let ended_a = keep_last_picture(Some(&live_a), unavailable_snapshot(test_binding(), "unlinked", "epoch"));
        assert_eq!(ended_a.brief.telemetry_health, "ended");
        assert!(ended_a.brief.telemetry.is_some());

        let mut sid_b = test_binding();
        sid_b.agent_session_id = "agent-2".to_string();
        let after_sid = keep_last_picture(Some(&ended_a), unavailable_snapshot(sid_b, "unlinked", "epoch"));
        assert_eq!(after_sid.brief.binding.agent_session_id, "agent-2");
        assert!(after_sid.brief.telemetry.is_none());

        let mut revision_only = test_binding();
        revision_only.pty_input_revision += 1;
        let kept = keep_last_picture(Some(&ended_a), unavailable_snapshot(revision_only, "unlinked", "epoch"));
        assert!(kept.brief.telemetry.is_some());
        assert_eq!(kept.brief.binding.agent_session_id, "agent-1");

        let mut generation_changed = test_binding();
        generation_changed.pty_generation += 1;
        generation_changed.pty_instance_id = "pty-4".to_string();
        let after_pty = keep_last_picture(Some(&ended_a), unavailable_snapshot(generation_changed, "unlinked", "epoch"));
        assert!(after_pty.brief.telemetry.is_none());
        assert_eq!(after_pty.brief.binding.pty_generation, 4);
    }

    #[test]
    fn event_limit_is_clamped_to_the_supported_window() {
        assert_eq!(clamp_event_limit(None), DEFAULT_EVENT_LIMIT);
        assert_eq!(clamp_event_limit(Some(0)), MIN_EVENT_LIMIT);
        assert_eq!(clamp_event_limit(Some(7)), MIN_EVENT_LIMIT);
        assert_eq!(clamp_event_limit(Some(8)), 8);
        assert_eq!(clamp_event_limit(Some(120)), 120);
        assert_eq!(clamp_event_limit(Some(10_000)), RING_CAPACITY);
    }

    #[test]
    fn semantic_event_json_matches_the_typescript_contract() {
        use super::adapter::{SemanticEventKind, UserMessageKind};
        let envelope = SemanticEventEnvelope {
            event_id: "e1".to_string(),
            source_revision: 4,
            occurred_at: 1_700_000_000_000,
            source_byte_start: 0,
            source_byte_end: 12,
            kind: SemanticEventKind::ToolStart { call_id: "c1".to_string(), tool: "Read".to_string(), target: Some("a.rs".to_string()) },
        };
        assert_eq!(
            serde_json::to_string(&envelope).unwrap(),
            r#"{"eventId":"e1","sourceRevision":4,"occurredAt":1700000000000,"sourceByteStart":0,"sourceByteEnd":12,"kind":{"type":"toolStart","call_id":"c1","tool":"Read","target":"a.rs"}}"#
        );
        let user = SemanticEventKind::UserMessage { kind: UserMessageKind::TaskStart, text: "go".to_string(), digest: "d".to_string() };
        assert_eq!(serde_json::to_string(&user).unwrap(), r#"{"type":"userMessage","kind":"taskStart","text":"go","digest":"d"}"#);
        let question = SemanticEventKind::Question {
            prompt_event_id: "p1".to_string(),
            provider_call_id: "c2".to_string(),
            prompt: "ok?".to_string(),
            kind: PendingInputKind::Choice,
            options: vec![PendingOption::new("option-0".to_string(), "Yes".to_string(), "y".to_string())],
        };
        assert_eq!(
            serde_json::to_string(&question).unwrap(),
            r#"{"type":"question","prompt_event_id":"p1","provider_call_id":"c2","prompt":"ok?","kind":"choice","options":[{"id":"option-0","label":"Yes"}]}"#
        );
        assert_eq!(serde_json::to_string(&SemanticEventKind::FileChange { path: "src/live.rs".to_string(), change: "modified".to_string() }).unwrap(), r#"{"type":"fileChange","path":"src/live.rs","change":"modified"}"#);
        assert_eq!(serde_json::to_string(&SemanticEventKind::TestResult { pass: 12, fail: 1 }).unwrap(), r#"{"type":"testResult","pass":12,"fail":1}"#);
        assert_eq!(serde_json::to_string(&SemanticEventKind::Error { fingerprint: "f".to_string(), text: "Bash: failed".to_string() }).unwrap(), r#"{"type":"error","fingerprint":"f","text":"Bash: failed"}"#);
    }

    fn collect_jsonl(root: &Path, out: &mut Vec<PathBuf>, files_visited: &Cell<usize>) {
        let Ok(entries) = std::fs::read_dir(root) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_jsonl(&path, out, files_visited);
            } else if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
                files_visited.set(files_visited.get() + 1);
                out.push(path);
            }
        }
    }

    fn glob_locate(
        root: &Path,
        kind: &str,
        session_id: &str,
        calls: &Cell<usize>,
        files_visited: &Cell<usize>,
    ) -> Option<PathBuf> {
        calls.set(calls.get() + 1);
        let mut all = Vec::new();
        collect_jsonl(root, &mut all, files_visited);
        let matches = all.into_iter().filter(|path| match kind {
            "claude" | "claude-codex" => {
                path.file_name().and_then(|name| name.to_str()) == Some(&format!("{session_id}.jsonl"))
            }
            "codex" => path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.contains(session_id) && name.ends_with(".jsonl")),
            _ => false,
        });
        newest_path_by_mtime(matches)
    }

    fn poll_transcript(
        prior: Option<&SessionSnapshot>,
        binding: &LiveBinding,
        kind: &str,
        session_id: &str,
        root: &Path,
        calls: &Cell<usize>,
        files_visited: &Cell<usize>,
    ) -> Option<SessionSnapshot> {
        refresh_bound_transcript(
            prior,
            binding,
            kind,
            session_id,
            "epoch",
            None,
            None,
            |kind, session_id| glob_locate(root, kind, session_id, calls, files_visited),
        )
    }

    fn append_codex_line(path: &Path, message: &str) {
        std::fs::OpenOptions::new()
            .append(true)
            .open(path)
            .expect("open append")
            .write_all(codex_user_line(message).as_bytes())
            .expect("append record");
    }

    /// Growth of a bound Codex transcript must not walk the session tree again.
    #[test]
    fn cached_codex_growth_discovers_only_on_initial_bind() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let session_id = "agent-1";
        let path = root.join(format!("rollout-{session_id}.jsonl"));
        std::fs::write(&path, codex_user_line("seed")).expect("write seed");

        let calls = Cell::new(0usize);
        let visited = Cell::new(0usize);
        let binding = test_binding();

        let mut snapshot = poll_transcript(None, &binding, "codex", session_id, root, &calls, &visited)
            .expect("initial bind");
        assert_eq!(calls.get(), 1);
        assert_eq!(user_message_texts(&snapshot), vec!["seed".to_string()]);
        assert_eq!(snapshot.brief.binding.source_revision, 1);
        assert_eq!(snapshot.cursor.path, path);

        for index in 0..10 {
            append_codex_line(&path, &format!("m{index}"));
            snapshot = poll_transcript(Some(&snapshot), &binding, "codex", session_id, root, &calls, &visited)
                .expect("growth should advance the cached path");
        }
        assert_eq!(calls.get(), 1, "append must not re-run discovery");
        assert_eq!(snapshot.brief.binding.source_revision, 11);
        assert_eq!(snapshot.brief.event_seq, 11);
        assert_eq!(snapshot.cursor.read_offset, std::fs::metadata(&path).expect("stat").len());
        assert_eq!(user_message_texts(&snapshot).last().map(String::as_str), Some("m9"));
    }

    #[test]
    fn unchanged_cached_transcript_is_a_metadata_fast_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let session_id = "agent-1";
        let path = root.join(format!("rollout-{session_id}.jsonl"));
        std::fs::write(&path, codex_user_line("only")).expect("write");

        let calls = Cell::new(0usize);
        let visited = Cell::new(0usize);
        let binding = test_binding();
        let snapshot = poll_transcript(None, &binding, "codex", session_id, root, &calls, &visited)
            .expect("initial bind");
        assert_eq!(calls.get(), 1);

        let again = poll_transcript(Some(&snapshot), &binding, "codex", session_id, root, &calls, &visited);
        assert!(again.is_none(), "unchanged file must reuse the snapshot");
        assert_eq!(calls.get(), 1);
        assert_eq!(snapshot.brief.telemetry_health, "live");
        assert_eq!(user_message_texts(&snapshot), vec!["only".to_string()]);
    }

    #[test]
    fn truncated_cached_transcript_recovers_via_discovery() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let session_id = "agent-1";
        let path = root.join(format!("rollout-{session_id}.jsonl"));
        let mut body = codex_user_line("first");
        body.push_str(&codex_user_line("second"));
        std::fs::write(&path, &body).expect("write");

        let calls = Cell::new(0usize);
        let visited = Cell::new(0usize);
        let binding = test_binding();
        let snapshot = poll_transcript(None, &binding, "codex", session_id, root, &calls, &visited)
            .expect("initial bind");
        assert_eq!(user_message_texts(&snapshot), vec!["first".to_string(), "second".to_string()]);

        std::fs::write(&path, codex_user_line("rewritten")).expect("truncate");
        let recovered = poll_transcript(Some(&snapshot), &binding, "codex", session_id, root, &calls, &visited)
            .expect("truncate recovers");
        assert_eq!(calls.get(), 2, "truncate must rediscover rather than keep a stale cursor");
        assert_eq!(user_message_texts(&recovered), vec!["rewritten".to_string()]);
        assert_eq!(recovered.brief.binding.source_revision, 1);
        assert_eq!(recovered.cursor.path, path);
        assert_eq!(recovered.brief.telemetry_health, "live");
    }

    #[test]
    fn replaced_transcript_at_a_new_path_recovers_via_discovery() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let session_id = "agent-1";
        let original = root.join(format!("old-{session_id}.jsonl"));
        std::fs::write(&original, codex_user_line("old")).expect("write original");

        let calls = Cell::new(0usize);
        let visited = Cell::new(0usize);
        let binding = test_binding();
        let snapshot = poll_transcript(None, &binding, "codex", session_id, root, &calls, &visited)
            .expect("initial bind");
        assert_eq!(snapshot.cursor.path, original);

        std::fs::remove_file(&original).expect("remove original");
        let replacement = root.join(format!("new-{session_id}.jsonl"));
        std::fs::write(&replacement, codex_user_line("fresh")).expect("write replacement");

        let recovered = poll_transcript(Some(&snapshot), &binding, "codex", session_id, root, &calls, &visited)
            .expect("missing cached path falls back to discovery");
        assert_eq!(calls.get(), 2);
        assert_eq!(recovered.cursor.path, replacement);
        assert_eq!(user_message_texts(&recovered), vec!["fresh".to_string()]);
        assert_eq!(recovered.brief.event_seq, 1);
    }

    #[test]
    fn missing_cached_path_without_a_replacement_is_unavailable() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let session_id = "agent-1";
        let path = root.join(format!("rollout-{session_id}.jsonl"));
        std::fs::write(&path, codex_user_line("gone")).expect("write");

        let calls = Cell::new(0usize);
        let visited = Cell::new(0usize);
        let binding = test_binding();
        let snapshot = poll_transcript(None, &binding, "codex", session_id, root, &calls, &visited)
            .expect("initial bind");
        std::fs::remove_file(&path).expect("remove");

        let missing = poll_transcript(Some(&snapshot), &binding, "codex", session_id, root, &calls, &visited)
            .expect("missing path yields a snapshot");
        assert_eq!(calls.get(), 2);
        assert_eq!(missing.brief.telemetry_health, "unavailable");
        assert!(user_message_texts(&missing).is_empty());
    }

    #[test]
    fn binding_change_does_not_reuse_the_old_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let first_id = "agent-1";
        let second_id = "agent-2";
        let first_path = root.join(format!("rollout-{first_id}.jsonl"));
        let second_path = root.join(format!("rollout-{second_id}.jsonl"));
        std::fs::write(&first_path, codex_user_line("one")).expect("write first");
        std::fs::write(&second_path, codex_user_line("two")).expect("write second");

        let calls = Cell::new(0usize);
        let visited = Cell::new(0usize);
        let first_binding = test_binding();
        let snapshot = poll_transcript(None, &first_binding, "codex", first_id, root, &calls, &visited)
            .expect("bind first session");
        assert_eq!(snapshot.cursor.path, first_path);
        append_codex_line(&first_path, "one-more");

        let mut second_binding = test_binding();
        second_binding.agent_session_id = second_id.to_string();
        let switched = poll_transcript(Some(&snapshot), &second_binding, "codex", second_id, root, &calls, &visited)
            .expect("session change rediscovers");
        assert_eq!(calls.get(), 2);
        assert_eq!(switched.cursor.path, second_path);
        assert_eq!(user_message_texts(&switched), vec!["two".to_string()]);
        assert_eq!(switched.brief.binding.agent_session_id, second_id);
        assert_ne!(switched.cursor.path, first_path);
    }

    #[test]
    fn claude_cached_append_keeps_events_and_cursor() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let session_id = "claude-sess";
        let path = root.join(format!("{session_id}.jsonl"));
        std::fs::write(&path, claude_user_line("ask")).expect("write");

        let calls = Cell::new(0usize);
        let visited = Cell::new(0usize);
        let mut binding = test_binding();
        binding.agent_session_id = session_id.to_string();
        binding.agent_kind = "claude".to_string();

        let snapshot = poll_transcript(None, &binding, "claude", session_id, root, &calls, &visited)
            .expect("claude bind");
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open append")
            .write_all(claude_user_line("follow-up").as_bytes())
            .expect("append");
        let advanced = poll_transcript(Some(&snapshot), &binding, "claude", session_id, root, &calls, &visited)
            .expect("claude append uses cache");
        assert_eq!(calls.get(), 1);
        assert_eq!(user_message_texts(&advanced), vec!["ask".to_string(), "follow-up".to_string()]);
        assert_eq!(advanced.cursor.committed_offset, std::fs::metadata(&path).expect("stat").len());
        assert_eq!(advanced.brief.service_epoch, "epoch");
    }

    /// Synthetic Codex tree: after the first glob, ten appends must not walk again.
    #[test]
    fn growing_codex_tree_is_not_reenumerated_after_bind() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("sessions");
        const NOISE_FILES: usize = 400;
        for index in 0..NOISE_FILES {
            let sub = root.join(format!("2026/{:02}/{:02}", (index % 12) + 1, (index % 28) + 1));
            std::fs::create_dir_all(&sub).expect("mkdir noise");
            std::fs::write(sub.join(format!("noise-{index:04}.jsonl")), b"{}\n").expect("write noise");
        }
        let session_id = "targetSESSIONid";
        let target_dir = root.join("2026").join("08").join("24");
        std::fs::create_dir_all(&target_dir).expect("mkdir target");
        let target = target_dir.join(format!("rollout-{session_id}.jsonl"));
        std::fs::write(&target, codex_user_line("seed")).expect("write target");

        let calls = Cell::new(0usize);
        let visited = Cell::new(0usize);
        let mut binding = test_binding();
        binding.agent_session_id = session_id.to_string();

        let discover_started = std::time::Instant::now();
        let mut snapshot = poll_transcript(None, &binding, "codex", session_id, &root, &calls, &visited)
            .expect("initial discover");
        let discover_ms = discover_started.elapsed().as_secs_f64() * 1000.0;
        let visited_on_bind = visited.get();
        assert_eq!(calls.get(), 1);
        assert!(
            visited_on_bind > NOISE_FILES,
            "initial bind must glob the synthetic tree, visited={visited_on_bind}"
        );
        assert_eq!(snapshot.cursor.path, target);

        visited.set(0);
        let grow_started = std::time::Instant::now();
        for index in 0..10 {
            append_codex_line(&target, &format!("g{index}"));
            snapshot = poll_transcript(Some(&snapshot), &binding, "codex", session_id, &root, &calls, &visited)
                .expect("cached growth");
        }
        let grow_ms = grow_started.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(calls.get(), 1, "ten appends must not re-enumerate");
        assert_eq!(visited.get(), 0, "cached growth must visit zero glob matches");
        assert_eq!(snapshot.brief.binding.source_revision, 11);
        assert_eq!(user_message_texts(&snapshot).last().map(String::as_str), Some("g9"));
        eprintln!(
            "codex cached-path perf: discover={discover_ms:.2}ms visited={visited_on_bind} grow10={grow_ms:.2}ms locate_calls={}",
            calls.get()
        );
    }
}
