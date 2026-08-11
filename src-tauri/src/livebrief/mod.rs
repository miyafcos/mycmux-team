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
            service.refresh_all();
            thread::sleep(Duration::from_secs(1));
        });
    }

    pub fn snapshots(&self) -> Vec<LiveSessionBrief> {
        self.refresh_all();
        let state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.sessions.values().map(|snapshot| snapshot.brief.clone()).collect()
    }

    fn refresh_all(&self) {
        let session_ids: Vec<String> = self.manager.iter_pids().into_iter().map(|(id, _)| id).collect();
        let mappings = agent_mappings_for_ids(session_ids.iter().map(String::as_str));
        let mut next = HashMap::new();
        for session_id in &session_ids {
            let brief = self.refresh_one(session_id, mappings.get(session_id), &mappings);
            next.insert(session_id.clone(), brief);
        }
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        for (session_id, snapshot) in next {
            let changed = state.sessions.get(&session_id).map(|old| old.brief != snapshot.brief).unwrap_or(true);
            if changed {
                state.brief_revision = state.brief_revision.saturating_add(1);
                let mut snapshot = snapshot;
                snapshot.brief.brief_revision = state.brief_revision;
                if let Some(app) = self.app_handle.get() {
                    let _ = app.emit(EVENT_NAME, LiveBriefUpdate { brief: snapshot.brief.clone() });
                }
                state.sessions.insert(session_id, snapshot);
            }
        }
        state.sessions.retain(|session_id, _| session_ids.contains(session_id));
    }

    fn refresh_one(
        &self,
        pty_session_id: &str,
        mapping: Option<&AgentSessionMapping>,
        all_mappings: &HashMap<String, AgentSessionMapping>,
    ) -> SessionSnapshot {
        let (pty_generation, pty_input_revision, _) = self.manager
            .intervention_observation(pty_session_id)
            .unwrap_or((0, 0, None));
        let mapping = mapping.filter(|mapping| matches!(mapping.agent_kind.as_deref(), Some("claude") | Some("codex")));
        let Some(mapping) = mapping else {
            return unavailable_snapshot(
                self.base_binding(pty_session_id, "", "", pty_generation, pty_input_revision),
                "unlinked",
                &self.service_epoch,
            );
        };
        let kind = mapping.agent_kind.as_deref().unwrap_or_default();
        if all_mappings.values().filter(|candidate| candidate.agent_kind.as_deref() == Some(kind) && candidate.session_id == mapping.session_id).count() != 1 {
            return unavailable_snapshot(
                self.base_binding(pty_session_id, kind, &mapping.session_id, pty_generation, pty_input_revision),
                "unavailable",
                &self.service_epoch,
            );
        }
        let binding = self.base_binding(pty_session_id, kind, &mapping.session_id, pty_generation, pty_input_revision);
        let Some(path) = locate_transcript(kind, &mapping.session_id) else {
            return unavailable_snapshot(binding, "unavailable", &self.service_epoch);
        };
        match bootstrap_transcript(&path, kind, &binding, &self.service_epoch) {
            Ok(snapshot) => snapshot,
            Err(_) => unavailable_snapshot(binding, "unavailable", &self.service_epoch),
        }
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

fn locate_transcript(kind: &str, session_id: &str) -> Option<PathBuf> {
    let root = match kind {
        "claude" => crate::ailog::claude_root()?,
        "codex" => crate::ailog::codex_root()?,
        _ => return None,
    };
    let pattern = match kind {
        "claude" => format!("{}/**/{}.jsonl", root.display(), session_id),
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
        binding, task: None, task_source_event_ids: Vec::new(), activity_kind: None, activity_text: None,
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
}
