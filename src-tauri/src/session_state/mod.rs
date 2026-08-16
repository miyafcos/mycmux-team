use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Listener};

const LEDGER_CAPACITY: usize = 32;
const DEFAULT_ATTENTION_STALE_AFTER_MS: u64 = 30_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Lifecycle {
    Alive,
    Exited,
    Orphaned,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Activity {
    Streaming,
    RunningSilent,
    Idle,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttentionKind {
    None,
    Input,
    Approval,
    RateLimited,
    Error,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Health {
    Fresh,
    Stale,
    Degraded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceSource {
    MonitorStatus,
    WorkDone,
    LastOutput,
    ScreenScan,
    Hook,
    SocketLifecycle,
    CodexRollout,
}

impl EvidenceSource {
    fn rank(self) -> u8 {
        match self {
            Self::Hook => 0,
            Self::ScreenScan => 1,
            Self::WorkDone => 2,
            Self::MonitorStatus => 3,
            Self::LastOutput => 4,
            Self::SocketLifecycle => 5,
            Self::CodexRollout => 6,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MonitorStatus {
    Working,
    Idle,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputOrigin {
    Pty,
    Replay,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub started_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EvidenceSignal {
    MonitorStatus {
        status: MonitorStatus,
    },
    WorkDone {
        previous_process: String,
        current_process: String,
    },
    LastOutput {
        origin: OutputOrigin,
    },
    ScreenScan {
        attention: AttentionKind,
        attention_id: Option<String>,
        detail: Option<String>,
        confidence: f32,
        stale_after: u64,
        complete: bool,
        resync: bool,
    },
    Hook {
        attention: AttentionKind,
        attention_id: Option<String>,
        detail: Option<String>,
        confidence: f32,
        stale_after: u64,
    },
    SocketLifecycle {
        lifecycle: Lifecycle,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Evidence {
    pub observed_at: u64,
    pub source: EvidenceSource,
    pub session_epoch: Option<u64>,
    pub process: Option<ProcessIdentity>,
    pub signal: EvidenceSignal,
}

impl Evidence {
    pub fn monitor_status(
        observed_at: u64,
        session_epoch: u64,
        status: MonitorStatus,
        process: Option<ProcessIdentity>,
    ) -> Self {
        Self {
            observed_at,
            source: EvidenceSource::MonitorStatus,
            session_epoch: Some(session_epoch),
            process,
            signal: EvidenceSignal::MonitorStatus { status },
        }
    }

    pub fn work_done(
        observed_at: u64,
        session_epoch: u64,
        previous_process: String,
        current_process: String,
    ) -> Self {
        Self {
            observed_at,
            source: EvidenceSource::WorkDone,
            session_epoch: Some(session_epoch),
            process: None,
            signal: EvidenceSignal::WorkDone {
                previous_process,
                current_process,
            },
        }
    }

    pub fn last_output(observed_at: u64, session_epoch: u64, origin: OutputOrigin) -> Self {
        Self {
            observed_at,
            source: EvidenceSource::LastOutput,
            session_epoch: Some(session_epoch),
            process: None,
            signal: EvidenceSignal::LastOutput { origin },
        }
    }

    pub fn socket_lifecycle(observed_at: u64, session_epoch: u64, lifecycle: Lifecycle) -> Self {
        Self {
            observed_at,
            source: EvidenceSource::SocketLifecycle,
            session_epoch: Some(session_epoch),
            process: None,
            signal: EvidenceSignal::SocketLifecycle { lifecycle },
        }
    }
}

pub fn unix_epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Attention {
    pub attention_id: Option<String>,
    pub kind: AttentionKind,
    pub detail: Option<String>,
    pub state_since: u64,
    pub observed_at: u64,
    pub sources: Vec<EvidenceSource>,
    pub confidence: f32,
    pub stale_after: u64,
}

impl Default for Attention {
    fn default() -> Self {
        Self {
            attention_id: None,
            kind: AttentionKind::None,
            detail: None,
            state_since: 0,
            observed_at: 0,
            sources: Vec::new(),
            confidence: 0.0,
            stale_after: DEFAULT_ATTENTION_STALE_AFTER_MS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionView {
    pub session_id: String,
    pub session_epoch: Option<u64>,
    pub session_revision: u64,
    pub lifecycle: Lifecycle,
    pub activity: Activity,
    pub attention: Attention,
    pub health: Health,
    pub process: Option<ProcessIdentity>,
    pub last_evidence_at: u64,
    pub last_monitor_at: u64,
    pub last_output_at: u64,
}

impl SessionView {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            session_epoch: None,
            session_revision: 0,
            lifecycle: Lifecycle::Unknown,
            activity: Activity::Unknown,
            attention: Attention::default(),
            health: Health::Stale,
            process: None,
            last_evidence_at: 0,
            last_monitor_at: 0,
            last_output_at: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UiSessionState {
    Working,
    Idle,
    Waiting,
    Done,
    Unknown,
}

pub fn derive_ui_state(view: &SessionView) -> UiSessionState {
    match view.attention.kind {
        AttentionKind::Input | AttentionKind::Approval | AttentionKind::RateLimited | AttentionKind::Error => {
            UiSessionState::Waiting
        }
        AttentionKind::Done => UiSessionState::Done,
        AttentionKind::None => match view.activity {
            Activity::Streaming | Activity::RunningSilent => UiSessionState::Working,
            Activity::Idle => UiSessionState::Idle,
            Activity::Unknown => UiSessionState::Unknown,
        },
    }
}

fn reset_for_epoch(view: &SessionView, epoch: u64) -> SessionView {
    let mut reset = SessionView::new(view.session_id.clone());
    reset.session_epoch = Some(epoch);
    reset
}

fn evidence_epoch_is_current(view: &SessionView, evidence: &Evidence) -> bool {
    match (view.session_epoch, evidence.session_epoch) {
        (Some(current), Some(incoming)) => incoming >= current,
        _ => true,
    }
}

fn process_evidence_is_current(view: &SessionView, evidence: &Evidence) -> bool {
    match (&view.process, &evidence.process) {
        (Some(current), Some(incoming)) if current.pid == incoming.pid => {
            incoming.started_at >= current.started_at
        }
        _ => true,
    }
}

fn attention_id(view: &SessionView, evidence: &Evidence, supplied: Option<&String>) -> String {
    supplied.cloned().unwrap_or_else(|| {
        format!(
            "{}:{}:{}:{}",
            view.session_id,
            evidence.session_epoch.unwrap_or_default(),
            evidence.source.rank(),
            evidence.observed_at
        )
    })
}

struct AttentionUpdate<'a> {
    kind: AttentionKind,
    supplied_id: Option<&'a String>,
    detail: &'a Option<String>,
    confidence: f32,
    stale_after: u64,
}

fn apply_attention(view: &mut SessionView, evidence: &Evidence, update: AttentionUpdate<'_>) {
    if update.kind == AttentionKind::None {
        if evidence.observed_at < view.attention.observed_at {
            return;
        }
        if view.attention.sources.contains(&evidence.source) && view.attention.sources.len() > 1 {
            view.attention
                .sources
                .retain(|source| *source != evidence.source);
            view.attention.observed_at = evidence.observed_at;
        } else if view.attention.sources.is_empty()
            || view.attention.sources.contains(&evidence.source)
        {
            view.attention = Attention {
                state_since: evidence.observed_at,
                observed_at: evidence.observed_at,
                stale_after: update.stale_after,
                ..Attention::default()
            };
        }
        return;
    }

    let next_id = attention_id(view, evidence, update.supplied_id);
    let same_attention = view.attention.kind == update.kind
        && (view.attention.attention_id.as_deref() == Some(next_id.as_str())
            || update.supplied_id.is_none());

    if same_attention {
        if !view.attention.sources.contains(&evidence.source) {
            view.attention.sources.push(evidence.source);
            view.attention.sources.sort_by_key(|source| source.rank());
        }
        let replaces_detail = update.confidence > view.attention.confidence
            || (update.confidence == view.attention.confidence
                && update.detail.as_deref().unwrap_or("")
                    < view.attention.detail.as_deref().unwrap_or(""));
        if replaces_detail {
            view.attention.detail = update.detail.clone();
            view.attention.confidence = update.confidence;
        }
        view.attention.state_since = view.attention.state_since.min(evidence.observed_at);
        view.attention.observed_at = view.attention.observed_at.max(evidence.observed_at);
        view.attention.stale_after = view.attention.stale_after.max(update.stale_after);
        if update.supplied_id.is_some() {
            view.attention.attention_id = Some(next_id);
        }
        return;
    }

    if evidence.observed_at < view.attention.observed_at {
        return;
    }

    view.attention = Attention {
        attention_id: Some(next_id),
        kind: update.kind,
        detail: update.detail.clone(),
        state_since: evidence.observed_at,
        observed_at: evidence.observed_at,
        sources: vec![evidence.source],
        confidence: update.confidence,
        stale_after: update.stale_after,
    };
}

pub fn reduce(previous: &SessionView, evidence: &Evidence) -> SessionView {
    if !evidence_epoch_is_current(previous, evidence)
        || !process_evidence_is_current(previous, evidence)
    {
        return previous.clone();
    }

    let mut view = match (previous.session_epoch, evidence.session_epoch) {
        (Some(current), Some(incoming)) if incoming > current => {
            reset_for_epoch(previous, incoming)
        }
        _ => previous.clone(),
    };
    if view.session_epoch.is_none() {
        view.session_epoch = evidence.session_epoch;
    }

    let before = view.clone();
    match &evidence.signal {
        EvidenceSignal::MonitorStatus { status } => {
            if evidence.observed_at < view.last_monitor_at {
                return previous.clone();
            }
            view.last_monitor_at = evidence.observed_at;
            view.lifecycle = Lifecycle::Alive;
            view.process = evidence.process.clone().or(view.process);
            view.activity = match status {
                MonitorStatus::Working => {
                    if view.last_output_at > 0
                        && evidence.observed_at.saturating_sub(view.last_output_at) <= 5_000
                    {
                        Activity::Streaming
                    } else {
                        Activity::RunningSilent
                    }
                }
                MonitorStatus::Idle => Activity::Idle,
                MonitorStatus::Unknown => Activity::Unknown,
            };
            view.health = if *status == MonitorStatus::Unknown {
                Health::Degraded
            } else {
                Health::Fresh
            };
        }
        EvidenceSignal::WorkDone { .. } => {
            view.activity = Activity::Idle;
            view.lifecycle = Lifecycle::Alive;
            view.health = Health::Fresh;
        }
        EvidenceSignal::LastOutput { origin } => {
            if *origin != OutputOrigin::Pty || evidence.observed_at <= view.last_output_at {
                return previous.clone();
            }
            view.last_output_at = evidence.observed_at;
            view.activity = Activity::Streaming;
            view.lifecycle = Lifecycle::Alive;
            view.health = Health::Fresh;
        }
        EvidenceSignal::ScreenScan {
            attention,
            attention_id,
            detail,
            confidence,
            stale_after,
            complete,
            resync,
        } => {
            if *resync || !*complete {
                view.health = Health::Degraded;
            } else {
                apply_attention(
                    &mut view,
                    evidence,
                    AttentionUpdate {
                        kind: *attention,
                        supplied_id: attention_id.as_ref(),
                        detail,
                        confidence: *confidence,
                        stale_after: *stale_after,
                    },
                );
                view.health = Health::Fresh;
            }
        }
        EvidenceSignal::Hook {
            attention,
            attention_id,
            detail,
            confidence,
            stale_after,
        } => {
            apply_attention(
                &mut view,
                evidence,
                AttentionUpdate {
                    kind: *attention,
                    supplied_id: attention_id.as_ref(),
                    detail,
                    confidence: *confidence,
                    stale_after: *stale_after,
                },
            );
            view.health = Health::Fresh;
        }
        EvidenceSignal::SocketLifecycle { lifecycle } => {
            view.lifecycle = *lifecycle;
            view.health = if *lifecycle == Lifecycle::Orphaned {
                Health::Degraded
            } else {
                Health::Fresh
            };
            if *lifecycle == Lifecycle::Exited {
                view.activity = Activity::Idle;
            }
        }
    }

    let state_changed = if matches!(&evidence.signal, EvidenceSignal::LastOutput { .. }) {
            let mut without_last_output_at = view.clone();
            without_last_output_at.last_output_at = before.last_output_at;
            without_last_output_at != before
    } else {
        view != before
    };
    if state_changed {
        view.session_revision = previous.session_revision.saturating_add(1);
        view.last_evidence_at = view.last_evidence_at.max(evidence.observed_at);
    }
    view
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionStateRecordSnapshot {
    pub session_id: String,
    pub view: SessionView,
    pub ui_state: UiSessionState,
    pub recent_evidence: Vec<Evidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionStateSnapshot {
    pub sessions: Vec<SessionStateRecordSnapshot>,
}

#[derive(Debug, Clone)]
struct SessionRecord {
    view: SessionView,
    recent_evidence: VecDeque<Evidence>,
}

type ChangeListener = Arc<dyn Fn(SessionView) + Send + Sync>;

#[derive(Clone, Default)]
pub struct SessionStateStore {
    sessions: Arc<DashMap<String, SessionRecord>>,
    change_listener: Arc<RwLock<Option<ChangeListener>>>,
}

impl SessionStateStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_change_listener(&self, listener: ChangeListener) {
        let mut current = self
            .change_listener
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *current = Some(listener);
    }

    pub fn ingest(&self, session_id: impl Into<String>, evidence: Evidence) -> SessionView {
        let session_id = session_id.into();
        let mut record = self
            .sessions
            .entry(session_id.clone())
            .or_insert_with(|| SessionRecord {
                view: SessionView::new(session_id),
                recent_evidence: VecDeque::with_capacity(LEDGER_CAPACITY),
            });
        if record.recent_evidence.back() == Some(&evidence) {
            return record.view.clone();
        }
        let previous_revision = record.view.session_revision;
        record.view = reduce(&record.view, &evidence);
        if record.recent_evidence.len() == LEDGER_CAPACITY {
            record.recent_evidence.pop_front();
        }
        record.recent_evidence.push_back(evidence);
        let view = record.view.clone();
        let changed = view.session_revision != previous_revision;
        drop(record);

        if changed {
            let listener = self
                .change_listener
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            if let Some(listener) = listener {
                listener(view.clone());
            }
        }
        view
    }

    pub fn current_epoch(&self, session_id: &str) -> Option<u64> {
        self.sessions
            .get(session_id)
            .and_then(|record| record.view.session_epoch)
    }

    pub fn current_view(&self, session_id: &str) -> Option<SessionView> {
        self.sessions
            .get(session_id)
            .map(|record| record.view.clone())
    }

    pub fn snapshot(&self, session_id: Option<&str>) -> SessionStateSnapshot {
        let mut sessions: Vec<_> = self
            .sessions
            .iter()
            .filter(|record| session_id.is_none_or(|id| record.key() == id))
            .map(|record| SessionStateRecordSnapshot {
                session_id: record.key().clone(),
                view: record.view.clone(),
                ui_state: derive_ui_state(&record.view),
                recent_evidence: record.recent_evidence.iter().cloned().collect(),
            })
            .collect();
        sessions.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        SessionStateSnapshot { sessions }
    }
}

#[derive(Debug, Deserialize)]
struct ScreenScanEvent {
    session_id: String,
    session_epoch: Option<u64>,
    attention: AttentionKind,
    attention_id: Option<String>,
    detail: Option<String>,
    observed_at: u64,
    #[serde(default = "default_confidence")]
    confidence: f32,
    #[serde(default = "default_stale_after")]
    stale_after: u64,
    #[serde(default = "default_true")]
    complete: bool,
    #[serde(default)]
    resync: bool,
}

fn default_confidence() -> f32 {
    0.7
}

fn default_stale_after() -> u64 {
    DEFAULT_ATTENTION_STALE_AFTER_MS
}

fn default_true() -> bool {
    true
}

pub fn register_frontend_listener(app: &AppHandle, store: SessionStateStore) {
    app.listen_any("mycmux:session-state-evidence", move |event| {
        let Ok(payload) = serde_json::from_str::<ScreenScanEvent>(event.payload()) else {
            return;
        };
        let session_epoch = payload
            .session_epoch
            .or_else(|| store.current_epoch(&payload.session_id));
        let evidence = Evidence {
            observed_at: payload.observed_at,
            source: EvidenceSource::ScreenScan,
            session_epoch,
            process: None,
            signal: EvidenceSignal::ScreenScan {
                attention: payload.attention,
                attention_id: payload.attention_id,
                detail: payload.detail,
                confidence: payload.confidence,
                stale_after: payload.stale_after,
                complete: payload.complete,
                resync: payload.resync,
            },
        };
        store.ingest(payload.session_id, evidence);
    });
}

#[cfg(test)]
mod tests;
