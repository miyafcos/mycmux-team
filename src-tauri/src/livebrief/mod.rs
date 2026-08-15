//! Live transcript summaries and fail-closed intervention support.
//!
//! This module deliberately does not use the analytics database. A live brief
//! is rebuilt from the mapped transcript and is considered writable only while
//! its source, binding and PTY input revision all still match.

mod adapter;
mod intervene;
mod reducer;

use std::collections::{HashMap, VecDeque};
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
use crate::pty::manager::SessionManager;
use crate::pty::monitor::MetadataStore;
use crate::AppState;

pub use adapter::{AgentAdapter, ByteRange, SemanticEventEnvelope};
pub use intervene::{InterventionAction, InterventionExpectation, InterventionResult};
pub use reducer::{LiveBriefReducer, PendingInputKind, PendingOption};

const EVENT_NAME: &str = "livebrief://update";
const MAX_BOOTSTRAP_BYTES: u64 = 32 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 1024 * 1024;
const RING_CAPACITY: usize = 200;
const DEFAULT_EVENT_LIMIT: usize = 50;
const MIN_EVENT_LIMIT: usize = 8;

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

/// What a cached snapshot must still match for its transcript to be reusable
/// without a full re-read.
#[derive(Clone, Debug)]
struct SnapshotIdentity {
    path: PathBuf,
    file_identity: String,
    binding: LiveBinding,
    telemetry_health: String,
}

#[derive(Clone, Debug)]
#[allow(dead_code)]
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
#[allow(dead_code)]
pub(crate) struct SessionSnapshot {
    brief: LiveSessionBrief,
    cursor: TailCursor,
    reducer: LiveBriefReducer,
    events: VecDeque<SemanticEventEnvelope>,
}

impl SessionSnapshot {
    fn identity(&self) -> SnapshotIdentity {
        SnapshotIdentity {
            path: self.cursor.path.clone(),
            file_identity: self.cursor.file_identity.clone(),
            binding: self.brief.binding.clone(),
            telemetry_health: self.brief.telemetry_health.clone(),
        }
    }
}

#[derive(Default)]
struct ServiceState {
    sessions: HashMap<String, SessionSnapshot>,
    brief_revision: u64,
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
        let session_ids: Vec<String> = self.manager.iter_pids().into_iter().map(|(id, _)| id).collect();
        let mappings = agent_mappings_for_ids(session_ids.iter().map(String::as_str));
        let priors: HashMap<String, SnapshotIdentity> = {
            let state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            state.sessions.iter().map(|(session_id, snapshot)| (session_id.clone(), snapshot.identity())).collect()
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
    }

    /// Rebuild one session. `None` means the cached snapshot is still exact —
    /// the transcript file identity and the binding both match — so the caller
    /// keeps it instead of re-reading up to `MAX_BOOTSTRAP_BYTES`.
    fn refresh_one(
        &self,
        pty_session_id: &str,
        mapping: Option<&AgentSessionMapping>,
        all_mappings: &HashMap<String, AgentSessionMapping>,
        prior: Option<&SnapshotIdentity>,
    ) -> Option<SessionSnapshot> {
        let (pty_generation, pty_input_revision, _) = self.manager
            .intervention_observation(pty_session_id)
            .unwrap_or((0, 0, None));
        let mapping = mapping.filter(|mapping| matches!(mapping.agent_kind.as_deref(), Some("claude") | Some("codex") | Some("claude-codex")));
        let Some(mapping) = mapping else {
            return Some(unavailable_snapshot(
                self.base_binding(pty_session_id, "", "", pty_generation, pty_input_revision),
                "unlinked",
                &self.service_epoch,
            ));
        };
        let kind = mapping.agent_kind.as_deref().unwrap_or_default();
        if all_mappings.values().filter(|candidate| candidate.agent_kind.as_deref() == Some(kind) && candidate.session_id == mapping.session_id).count() != 1 {
            return Some(unavailable_snapshot(
                self.base_binding(pty_session_id, kind, &mapping.session_id, pty_generation, pty_input_revision),
                "unavailable",
                &self.service_epoch,
            ));
        }
        let binding = self.base_binding(pty_session_id, kind, &mapping.session_id, pty_generation, pty_input_revision);
        // The cached path is checked first: a live snapshot whose transcript has
        // not moved is reusable without the recursive glob, which otherwise ran
        // once a second per pane.
        if let Some(prior) = prior.filter(|prior| prior.telemetry_health == "live") {
            if let Ok(metadata) = std::fs::metadata(&prior.path) {
                if reuses_prior_snapshot(Some(prior), &prior.path, &metadata, &binding) { return None; }
            }
        }
        let Some(path) = locate_transcript(kind, &mapping.session_id) else {
            return Some(unavailable_snapshot(binding, "unavailable", &self.service_epoch));
        };
        if let Ok(metadata) = std::fs::metadata(&path) {
            if reuses_prior_snapshot(prior, &path, &metadata, &binding) { return None; }
        }
        Some(match bootstrap_transcript(&path, kind, &binding, &self.service_epoch) {
            Ok(snapshot) => snapshot,
            Err(_) => unavailable_snapshot(binding, "unavailable", &self.service_epoch),
        })
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

/// Keep the last meaningful picture of a pane whose agent has gone away.
///
/// When an agent exits the mapping disappears and the rebuild yields an empty
/// `unlinked`/`unavailable` snapshot, which used to wipe the event ring and the
/// task the operator was still reading. The history is carried over and marked
/// `ended` instead. Everything actionable — the pending question and its hashes
/// — is dropped on purpose: intervening against a prompt whose agent no longer
/// exists would type into whatever now owns the PTY.
fn keep_last_picture(previous: Option<&SessionSnapshot>, next: SessionSnapshot) -> SessionSnapshot {
    if next.brief.telemetry_health == "live" || !next.events.is_empty() { return next; }
    let Some(previous) = previous else { return next };
    if previous.brief.telemetry_health == "ended" { return previous.clone(); }
    if previous.brief.telemetry_health != "live" { return next; }
    let mut merged = previous.clone();
    merged.brief.binding = next.brief.binding;
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

fn reuses_prior_snapshot(prior: Option<&SnapshotIdentity>, path: &Path, metadata: &std::fs::Metadata, binding: &LiveBinding) -> bool {
    let Some(prior) = prior else { return false };
    prior.telemetry_health == "live"
        && !prior.file_identity.is_empty()
        && prior.file_identity == file_identity(path, metadata)
        && binding_matches(&prior.binding, binding)
}

fn clamp_event_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(DEFAULT_EVENT_LIMIT).clamp(MIN_EVENT_LIMIT, RING_CAPACITY)
}

fn locate_transcript(kind: &str, session_id: &str) -> Option<PathBuf> {
    let root = match kind {
        "claude" => crate::ailog::claude_root()?,
        "claude-codex" => crate::ailog::claude_codex_root()?,
        "codex" => crate::ailog::codex_root()?,
        _ => return None,
    };
    let pattern = match kind {
        "claude" | "claude-codex" => format!("{}/**/{}.jsonl", root.display(), session_id),
        "codex" => format!("{}/**/*{}.jsonl", root.display(), session_id),
        _ => unreachable!(),
    };
    glob::glob(&pattern).ok()?.filter_map(Result::ok).find(|path| path.is_file())
}

fn bootstrap_transcript(path: &Path, kind: &str, binding: &LiveBinding, service_epoch: &str) -> Result<SessionSnapshot, String> {
    let metadata = std::fs::metadata(path).map_err(|error| format!("stat transcript: {error}"))?;
    if metadata.len() > MAX_BOOTSTRAP_BYTES { return Err("transcript exceeds live bootstrap limit".to_string()); }
    let bytes = std::fs::read(path).map_err(|error| format!("read transcript: {error}"))?;
    let file_identity = file_identity(path, &metadata);
    let mut adapter = AgentAdapter::new(kind)?;
    let mut reducer = LiveBriefReducer::new();
    let mut events = VecDeque::new();
    let mut source_revision = 0_u64;
    let mut offset = 0_u64;
    for raw in complete_lines(&bytes)? {
        let start = offset;
        offset = offset.saturating_add(raw.len() as u64 + 1);
        source_revision = source_revision.saturating_add(1);
        for event in adapter.decode_record(raw, ByteRange { start, end: offset }, source_revision)? {
            reducer.apply(&event);
            events.push_back(event);
            if events.len() > RING_CAPACITY { events.pop_front(); }
        }
    }
    let mut binding = binding.clone();
    binding.source_revision = source_revision;
    let now = unix_ms();
    let mut brief = reducer.to_brief(binding.clone(), "live", service_epoch, now);
    brief.brief_revision = source_revision;
    let cursor = TailCursor {
        path: path.to_path_buf(), file_identity,
        stream_generation: 1, read_offset: offset, committed_offset: offset,
        pending_bytes: Vec::new(), committed_anchor: sha256_hex(&bytes[bytes.len().saturating_sub(256)..]),
    };
    Ok(SessionSnapshot { brief, cursor, reducer, events })
}

fn complete_lines(bytes: &[u8]) -> Result<Vec<&str>, String> {
    let mut out = Vec::new();
    for line in bytes.split_inclusive(|byte| *byte == b'\n') {
        if !line.ends_with(b"\n") { break; }
        let line = line.strip_suffix(b"\n").unwrap_or(line);
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.len() > MAX_LINE_BYTES { return Err("live JSONL line exceeds limit".to_string()); }
        if line.is_empty() { continue; }
        out.push(std::str::from_utf8(line).map_err(|_| "live JSONL is not valid UTF-8")?);
    }
    Ok(out)
}

fn unavailable_snapshot(binding: LiveBinding, health: &str, service_epoch: &str) -> SessionSnapshot {
    let now = unix_ms();
    let brief = LiveSessionBrief {
        binding, task: None, latest_instruction: None, task_source_event_ids: Vec::new(), activity_kind: None, activity_text: None,
        activity_source_event_id: None, checkpoint: None, checkpoint_evidence_event_ids: Vec::new(),
        pending_input_kind: None, pending_prompt: None, pending_options: Vec::new(), prompt_event_id: None,
        prompt_hash: None, event_seq: 0, operational_state: "running".to_string(), telemetry_health: health.to_string(),
        last_event_at: None, last_successful_read_at: None, updated_at: now, service_epoch: service_epoch.to_string(), brief_revision: 0,
    };
    SessionSnapshot { brief, cursor: TailCursor { path: PathBuf::new(), file_identity: String::new(), stream_generation: 0, read_offset: 0, committed_offset: 0, pending_bytes: Vec::new(), committed_anchor: String::new() }, reducer: LiveBriefReducer::new(), events: VecDeque::new() }
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

    #[test]
    fn complete_lines_keeps_an_unterminated_utf8_tail_pending() {
        let lines = complete_lines(b"{\"x\":1}\n{\"x\":\"\xe3\x81").unwrap();
        assert_eq!(lines, vec!["{\"x\":1}"]);
    }

    #[test]
    fn complete_lines_rejects_invalid_completed_utf8() {
        assert!(complete_lines(b"\xff\n").is_err());
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
    }
}
