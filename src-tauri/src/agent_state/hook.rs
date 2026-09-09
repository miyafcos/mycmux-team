use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use rand::RngCore;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

use crate::session_state::{
    self, AttentionKind, Evidence, EvidenceSignal, EvidenceSource, SessionStateStore,
};

use super::*;
use crate::commands::session_mapping;

pub const HOOK_PROTOCOL_MAJOR: u64 = 1;
pub const HOOK_PROTOCOL_MINOR: u64 = 0;
pub const HOOK_QUEUE_CAPACITY: usize = 2048;
pub const HOOK_CAP_MAX_BYTES: usize = 512;
pub const HOOK_COMMAND_MAX_BYTES: usize = 64;
pub const HOOK_STRING_MAX_BYTES: usize = 64 * 1024;
pub const HOOK_BODY_MAX_DEPTH: usize = 32;
pub const HOOK_DRAINING_MS: u64 = 10_000;

const HOOK_REPLY_TIMEOUT: Duration = Duration::from_millis(500);
// Same window every other evidence producer uses (screen scan, codex rollout).
// Attention staleness merges with max(), so a sentinel here would pin the session
// permanently once staleness is acted on.
const HOOK_ATTENTION_STALE_AFTER_MS: u64 = 30_000;

#[derive(Debug, Clone, Serialize)]
pub struct HookWireResponse {
    pub id: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
}

impl HookWireResponse {
    pub fn success(id: u64, result: Value) -> Self {
        Self {
            id,
            ok: true,
            result: Some(result),
            reason: None,
            retryable: None,
        }
    }

    pub fn rejected(id: u64, reason: &'static str, retryable: bool) -> Self {
        Self {
            id,
            ok: false,
            result: None,
            reason: Some(reason),
            retryable: Some(retryable),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CapabilityGrant {
    pub hook_cap: String,
    pub protocol_major: u64,
    pub protocol_minor: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HookMetricsSnapshot {
    pub received: u64,
    pub accepted: u64,
    pub rejected_invalid_cap: u64,
    pub rejected_stale_launch: u64,
    pub rejected_wrong_provider: u64,
    pub queue_dropped: u64,
}

#[derive(Debug, Default)]
struct HookMetrics {
    received: AtomicU64,
    accepted: AtomicU64,
    rejected_invalid_cap: AtomicU64,
    rejected_stale_launch: AtomicU64,
    rejected_wrong_provider: AtomicU64,
    queue_dropped: AtomicU64,
}

impl HookMetrics {
    fn snapshot(&self) -> HookMetricsSnapshot {
        HookMetricsSnapshot {
            received: self.received.load(Ordering::Relaxed),
            accepted: self.accepted.load(Ordering::Relaxed),
            rejected_invalid_cap: self.rejected_invalid_cap.load(Ordering::Relaxed),
            rejected_stale_launch: self.rejected_stale_launch.load(Ordering::Relaxed),
            rejected_wrong_provider: self.rejected_wrong_provider.load(Ordering::Relaxed),
            queue_dropped: self.queue_dropped.load(Ordering::Relaxed),
        }
    }
}

#[derive(Clone)]
pub struct HookService {
    app_instance_id: AppInstanceId,
    started: Instant,
    sender: mpsc::SyncSender<Work>,
    metrics: Arc<HookMetrics>,
}

impl HookService {
    pub fn new() -> Self {
        Self::start(None)
    }

    pub fn with_session_state(session_state: SessionStateStore) -> Self {
        Self::start(Some(session_state))
    }

    fn start(session_state: Option<SessionStateStore>) -> Self {
        let app_instance_id =
            AppInstanceId::try_new(random_hex(16)).expect("random id is nonempty");
        let (sender, receiver) = mpsc::sync_channel(HOOK_QUEUE_CAPACITY);
        let metrics = Arc::new(HookMetrics::default());
        let worker_metrics = metrics.clone();
        let worker_app_instance = app_instance_id.clone();
        std::thread::Builder::new()
            .name("mycmux-hook-worker".to_string())
            .spawn(move || {
                Worker::new(worker_app_instance, worker_metrics, session_state).run(receiver)
            })
            .expect("failed to start hook worker");
        Self {
            app_instance_id,
            started: Instant::now(),
            sender,
            metrics,
        }
    }

    pub async fn try_answer_prompt(
        &self,
        terminal_session_id: String,
        prompt_id: String,
    ) -> Result<bool, String> {
        let (reply, response) = oneshot::channel();
        self.try_send(
            Work::TryAnswerPrompt {
                terminal_session_id,
                prompt_id,
                reply,
            },
            0,
        )
        .map_err(|response| response.reason.unwrap_or("queue_dropped").to_string())?;
        tokio::time::timeout(HOOK_REPLY_TIMEOUT, response)
            .await
            .map_err(|_| "queue_dropped".to_string())?
            .map_err(|_| "queue_dropped".to_string())
    }

    pub async fn is_current_launch(
        &self,
        terminal_session_id: String,
        launch_id: String,
    ) -> Result<bool, String> {
        let (reply, response) = oneshot::channel();
        self.try_send(
            Work::IsCurrentLaunch {
                terminal_session_id,
                launch_id,
                reply,
            },
            0,
        )
        .map_err(|response| response.reason.unwrap_or("queue_dropped").to_string())?;
        tokio::time::timeout(HOOK_REPLY_TIMEOUT, response)
            .await
            .map_err(|_| "queue_dropped".to_string())?
            .map_err(|_| "queue_dropped".to_string())
    }

    pub fn app_instance_id(&self) -> &AppInstanceId {
        &self.app_instance_id
    }

    pub fn metrics(&self) -> HookMetricsSnapshot {
        self.metrics.snapshot()
    }

    pub async fn issue_capability(
        &self,
        terminal_session_id: String,
        provider: Provider,
        pane_id: Option<String>,
    ) -> Result<CapabilityGrant, HookWireResponse> {
        let (reply, response) = oneshot::channel();
        self.try_send(
            Work::Issue {
                terminal_session_id,
                provider,
                pane_id,
                reply,
            },
            0,
        )?;
        match tokio::time::timeout(HOOK_REPLY_TIMEOUT, response).await {
            Ok(Ok(WorkerReply::Grant(grant))) => Ok(grant),
            Ok(Ok(WorkerReply::Wire(rejection))) => Err(rejection),
            _ => {
                self.metrics.queue_dropped.fetch_add(1, Ordering::Relaxed);
                Err(HookWireResponse::rejected(0, "queue_dropped", true))
            }
        }
    }

    pub async fn handle_hook(
        &self,
        id: u64,
        hook_cap: String,
        command: String,
        body: Value,
    ) -> HookWireResponse {
        self.metrics.received.fetch_add(1, Ordering::Relaxed);
        let (reply, response) = oneshot::channel();
        if let Err(rejection) = self.try_send(
            Work::Hook {
                id,
                hook_cap,
                command,
                body,
                received_at: self.elapsed_millis(),
                reply,
            },
            id,
        ) {
            return rejection;
        }
        match tokio::time::timeout(HOOK_REPLY_TIMEOUT, response).await {
            Ok(Ok(WorkerReply::Wire(response))) => response,
            _ => {
                self.metrics.queue_dropped.fetch_add(1, Ordering::Relaxed);
                HookWireResponse::rejected(id, "queue_dropped", true)
            }
        }
    }

    pub fn drain_session(&self, terminal_session_id: &str) {
        let (reply, response) = mpsc::channel();
        if self
            .sender
            .try_send(Work::DrainSession {
                terminal_session_id: terminal_session_id.to_string(),
                at: self.elapsed_millis(),
                reply,
            })
            .is_ok()
        {
            let _ = response.recv_timeout(HOOK_REPLY_TIMEOUT);
        }
    }

    pub fn revoke_all(&self) {
        let (reply, response) = mpsc::channel();
        if self.sender.try_send(Work::RevokeAll { reply }).is_ok() {
            let _ = response.recv_timeout(HOOK_REPLY_TIMEOUT);
        }
    }

    #[cfg(test)]
    fn for_test() -> Self { Self::for_mapping_test(None) }

    #[cfg(test)]
    pub(crate) fn for_mapping_test(mapping_dir: Option<std::path::PathBuf>) -> Self {
        let app_instance_id = AppInstanceId::try_new("app-test-service").unwrap();
        let (sender, receiver) = mpsc::sync_channel(HOOK_QUEUE_CAPACITY);
        let metrics = Arc::new(HookMetrics::default());
        let worker_metrics = metrics.clone();
        let worker_app_instance = app_instance_id.clone();
        std::thread::spawn(move || {
            let mut worker = Worker::for_test(worker_app_instance, worker_metrics);
            worker.mapping_dir = mapping_dir;
            worker.run(receiver)
        });
        Self {
            app_instance_id,
            started: Instant::now(),
            sender,
            metrics,
        }
    }

    pub fn set_hook_mode(&self, provider: Provider, mode: HookMode) {
        let (reply, response) = mpsc::channel();
        if self
            .sender
            .try_send(Work::SetHookMode {
                provider,
                mode,
                reply,
            })
            .is_ok()
        {
            let _ = response.recv_timeout(HOOK_REPLY_TIMEOUT);
        }
    }

    fn elapsed_millis(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    fn try_send(&self, work: Work, id: u64) -> Result<(), HookWireResponse> {
        self.sender.try_send(work).map_err(|_| {
            self.metrics.queue_dropped.fetch_add(1, Ordering::Relaxed);
            HookWireResponse::rejected(id, "queue_dropped", true)
        })
    }
}

impl Default for HookService {
    fn default() -> Self {
        Self::new()
    }
}

enum Work {
    Issue {
        terminal_session_id: String,
        provider: Provider,
        pane_id: Option<String>,
        reply: oneshot::Sender<WorkerReply>,
    },
    Hook {
        id: u64,
        hook_cap: String,
        command: String,
        body: Value,
        received_at: u64,
        reply: oneshot::Sender<WorkerReply>,
    },
    DrainSession {
        terminal_session_id: String,
        at: u64,
        reply: mpsc::Sender<()>,
    },
    RevokeAll {
        reply: mpsc::Sender<()>,
    },
    SetHookMode {
        provider: Provider,
        mode: HookMode,
        reply: mpsc::Sender<()>,
    },
    TryAnswerPrompt {
        terminal_session_id: String,
        prompt_id: String,
        reply: oneshot::Sender<bool>,
    },
    IsCurrentLaunch {
        terminal_session_id: String,
        launch_id: String,
        reply: oneshot::Sender<bool>,
    },
}

enum WorkerReply {
    Grant(CapabilityGrant),
    Wire(HookWireResponse),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CapabilityState {
    Active,
    Draining { since: u64 },
    Revoked,
}

struct CapabilityRecord {
    app_instance_id: AppInstanceId,
    launch: LaunchKey,
    state: CapabilityState,
    rate: TokenBucket,
    last_mapping_event: Option<String>,
    last_mapping_session: Option<String>,
    observed_sessions: HashSet<String>,
}

struct Worker {
    app_instance_id: AppInstanceId,
    metrics: Arc<HookMetrics>,
    capabilities: HashMap<String, CapabilityRecord>,
    current_launch: HashMap<(TerminalSessionId, Provider), LaunchId>,
    generations: HashMap<(TerminalSessionId, Provider), u64>,
    provider_modes: HashMap<Provider, HookMode>,
    answered_prompts: HashSet<(TerminalSessionId, String)>,
    session_state: Option<SessionStateStore>,
    mapping_dir: Option<std::path::PathBuf>,
    reconciler: Reconciler,
    ledger: Result<Ledger, String>,
    global_rate: TokenBucket,
}

impl Worker {
    fn new(
        app_instance_id: AppInstanceId,
        metrics: Arc<HookMetrics>,
        session_state: Option<SessionStateStore>,
    ) -> Self {
        Self {
            app_instance_id,
            metrics,
            capabilities: HashMap::new(),
            current_launch: HashMap::new(),
            generations: HashMap::new(),
            provider_modes: HashMap::new(),
            answered_prompts: HashSet::new(),
            session_state,
            mapping_dir: session_mapping::session_mapping_dir(),
            reconciler: Reconciler::new(),
            ledger: Ledger::open().map_err(|error| error.to_string()),
            global_rate: TokenBucket::new(200, 200),
        }
    }

    #[cfg(test)]
    fn for_test(app_instance_id: AppInstanceId, metrics: Arc<HookMetrics>) -> Self {
        Self {
            app_instance_id,
            metrics,
            capabilities: HashMap::new(),
            current_launch: HashMap::new(),
            generations: HashMap::new(),
            provider_modes: HashMap::new(),
            answered_prompts: HashSet::new(),
            session_state: None,
            mapping_dir: None,
            reconciler: Reconciler::new(),
            ledger: Ledger::from_connection(rusqlite::Connection::open_in_memory().unwrap())
                .map_err(|error| error.to_string()),
            global_rate: TokenBucket::new(200, 200),
        }
    }

    fn run(mut self, receiver: mpsc::Receiver<Work>) {
        while let Ok(work) = receiver.recv() {
            match work {
                Work::Issue {
                    terminal_session_id,
                    provider,
                    pane_id,
                    reply,
                } => {
                    let response = self.issue(terminal_session_id, provider, pane_id);
                    let _ = reply.send(response);
                }
                Work::Hook {
                    id,
                    hook_cap,
                    command,
                    body,
                    received_at,
                    reply,
                } => {
                    let response = self.handle(id, &hook_cap, &command, body, received_at);
                    let _ = reply.send(WorkerReply::Wire(response));
                }
                Work::DrainSession {
                    terminal_session_id,
                    at,
                    reply,
                } => {
                    self.drain(&terminal_session_id, at);
                    let _ = reply.send(());
                }
                Work::RevokeAll { reply } => {
                    self.revoke_all();
                    let _ = reply.send(());
                }
                Work::SetHookMode {
                    provider,
                    mode,
                    reply,
                } => {
                    self.provider_modes.insert(provider, mode);
                    let _ = reply.send(());
                }
                Work::TryAnswerPrompt {
                    terminal_session_id,
                    prompt_id,
                    reply,
                } => {
                    let accepted = self.try_answer_prompt(terminal_session_id, prompt_id);
                    let _ = reply.send(accepted);
                }
                Work::IsCurrentLaunch {
                    terminal_session_id,
                    launch_id,
                    reply,
                } => {
                    let current = self.is_current_launch(terminal_session_id, launch_id);
                    let _ = reply.send(current);
                }
            }
        }
    }

    fn revoke_all(&mut self) {
        for record in self.capabilities.values_mut() {
            if let Some(dir) = &self.mapping_dir {
                session_mapping::clear_hook_session_mapping(dir, record.launch.terminal_session_id().as_str());
            }
            record.state = CapabilityState::Revoked;
        }
        self.current_launch.clear();
        // Answered prompts are per-launch state. Leaving them behind would make a
        // re-enabled hook reject the first answer to a freshly asked question.
        self.answered_prompts.clear();
    }

    fn try_answer_prompt(&mut self, terminal_session_id: String, prompt_id: String) -> bool {
        let Ok(terminal_session_id) = TerminalSessionId::try_new(terminal_session_id) else {
            return false;
        };
        if prompt_id.is_empty() || prompt_id.len() > HOOK_STRING_MAX_BYTES {
            return false;
        }
        self.answered_prompts.insert((terminal_session_id, prompt_id))
    }

    fn is_current_launch(&self, terminal_session_id: String, launch_id: String) -> bool {
        let Ok(terminal_session_id) = TerminalSessionId::try_new(terminal_session_id) else {
            return false;
        };
        let Ok(launch_id) = LaunchId::try_new(launch_id) else {
            return false;
        };
        self.current_launch
            .iter()
            .any(|((session_id, _provider), current)| {
                session_id == &terminal_session_id && current == &launch_id
            })
    }

    fn issue(
        &mut self,
        terminal_session_id: String,
        provider: Provider,
        pane_id: Option<String>,
    ) -> WorkerReply {
        let terminal_session_id = match TerminalSessionId::try_new(terminal_session_id) {
            Ok(value) => value,
            Err(_) => return WorkerReply::Wire(HookWireResponse::rejected(0, "malformed", false)),
        };
        let pane_id = match pane_id {
            Some(value) => match PaneId::try_new(value) {
                Ok(value) => Some(value),
                Err(_) => {
                    return WorkerReply::Wire(HookWireResponse::rejected(0, "malformed", false))
                }
            },
            None => None,
        };
        let slot = (terminal_session_id.clone(), provider);
        let generation = self
            .generations
            .entry(slot.clone())
            .and_modify(|value| *value = value.saturating_add(1))
            .or_insert(1);
        let launch_id = LaunchId::try_new(random_hex(16)).expect("random id is nonempty");
        let launch = LaunchKey::new(
            self.app_instance_id.clone(),
            terminal_session_id,
            provider,
            launch_id.clone(),
            LaunchGeneration::new(*generation),
            pane_id,
        );
        let hook_mode = self
            .provider_modes
            .get(&provider)
            .copied()
            .unwrap_or(HookMode::Installed);
        if !self.reconciler.register_launch(launch.clone(), hook_mode) {
            return WorkerReply::Wire(HookWireResponse::rejected(0, "malformed", true));
        }
        if let Some(dir) = &self.mapping_dir {
            session_mapping::clear_hook_session_mapping(dir, launch.terminal_session_id().as_str());
        }
        self.current_launch.insert(slot, launch_id);
        let hook_cap = random_hex(32);
        self.capabilities.insert(
            hook_cap.clone(),
            CapabilityRecord {
                app_instance_id: self.app_instance_id.clone(),
                launch,
                state: CapabilityState::Active,
                rate: TokenBucket::new(40, 20),
                last_mapping_event: None,
                last_mapping_session: None,
                observed_sessions: HashSet::new(),
            },
        );
        WorkerReply::Grant(CapabilityGrant {
            hook_cap,
            protocol_major: HOOK_PROTOCOL_MAJOR,
            protocol_minor: HOOK_PROTOCOL_MINOR,
        })
    }

    fn handle(
        &mut self,
        id: u64,
        hook_cap: &str,
        command: &str,
        body: Value,
        received_at: u64,
    ) -> HookWireResponse {
        if hook_cap.len() > HOOK_CAP_MAX_BYTES || command.len() > HOOK_COMMAND_MAX_BYTES {
            return self.reject(id, "too_large", false);
        }
        let current_launch = &self.current_launch;
        let app_instance_id = &self.app_instance_id;
        let Some(record) = self.capabilities.get_mut(hook_cap) else {
            return self.reject(id, "unauthorized", false);
        };
        if &record.app_instance_id != app_instance_id {
            return self.reject(id, "unauthorized", false);
        }
        let slot = (
            record.launch.terminal_session_id().clone(),
            record.launch.provider(),
        );
        if current_launch.get(&slot) != Some(record.launch.launch_id()) {
            return self.reject(id, "stale_launch", false);
        }
        if let CapabilityState::Draining { since } = record.state {
            if received_at.saturating_sub(since) >= HOOK_DRAINING_MS {
                record.state = CapabilityState::Revoked;
            }
        }
        if record.state == CapabilityState::Revoked {
            return self.reject(id, "unauthorized", false);
        }
        if !self.global_rate.allow(received_at) || !record.rate.allow(received_at) {
            return self.reject(id, "queue_dropped", true);
        }
        if let Err(reason) = validate_value_bounds(&body, 0) {
            return self.reject(id, reason, false);
        }

        match command {
            "hook.health" => {
                if !body.is_object() {
                    return self.reject(id, "malformed", false);
                }
                self.metrics.accepted.fetch_add(1, Ordering::Relaxed);
                HookWireResponse::success(
                    id,
                    json!({
                        "protocol_major": HOOK_PROTOCOL_MAJOR,
                        "protocol_minor": HOOK_PROTOCOL_MINOR,
                    }),
                )
            }
            "hook.observe" => self.observe(id, hook_cap, body, received_at),
            _ => self.reject(id, "malformed", false),
        }
    }

    fn observe(
        &mut self,
        id: u64,
        hook_cap: &str,
        body: Value,
        received_at: u64,
    ) -> HookWireResponse {
        let Some(record) = self.capabilities.get(hook_cap) else {
            return self.reject(id, "unauthorized", false);
        };
        let parsed = match ObserveBody::parse(&body) {
            Ok(value) => value,
            Err(reason) => return self.reject(id, reason, false),
        };
        if parsed
            .provider
            .is_some_and(|value| value != record.launch.provider())
        {
            return self.reject(id, "wrong_provider", false);
        }
        if parsed
            .terminal_session_id
            .as_deref()
            .is_some_and(|value| value != record.launch.terminal_session_id().as_str())
            || parsed
                .launch_id
                .as_deref()
                .is_some_and(|value| value != record.launch.launch_id().as_str())
            || parsed
                .pane_id
                .as_deref()
                .is_some_and(|value| record.launch.pane_id().map(PaneId::as_str) != Some(value))
        {
            return self.reject(id, "malformed", false);
        }
        if matches!(record.state, CapabilityState::Draining { .. })
            && !parsed.event_kind.is_terminal()
        {
            return self.reject(id, "stale_launch", false);
        }

        if !session_mapping::is_safe_mapping_id(&parsed.provider_session_id) {
            return self.reject(id, "malformed", false);
        }
        // Reject a mapping/provider conflict before persisting canonical events
        // or ingesting attention evidence. The writer checks again under its lock.
        if record.state == CapabilityState::Active {
            if let Some(dir) = &self.mapping_dir {
                let mappings = session_mapping::read_session_mapping_files_for_ids(dir, [record.launch.terminal_session_id().as_str()]);
                let kind = mappings.get(record.launch.terminal_session_id().as_str()).and_then(|mapping| mapping.agent_kind.as_deref());
                let provider = record.launch.provider().as_str();
                if kind.is_some_and(|kind| kind != provider && !(provider == "claude" && kind == "claude-codex")) {
                    return self.reject(id, "wrong_provider", false);
                }
            }
        }
        let mapping_session_id = parsed.provider_session_id.clone();
        let mapping_event_id = parsed.source_event_id.clone();

        let identity = IdentityKey::new(
            record.launch.clone(),
            match ProviderSessionId::try_new(parsed.provider_session_id) {
                Ok(value) => value,
                Err(_) => return self.reject(id, "malformed", false),
            },
            match ProviderTurnId::provider(parsed.provider_turn_id) {
                Ok(value) => value,
                Err(_) => return self.reject(id, "malformed", false),
            },
            parsed.event_kind,
        );
        let source_event_id = match SourceEventId::try_new(parsed.source_event_id) {
            Ok(value) => value,
            Err(_) => return self.reject(id, "malformed", false),
        };
        let payload_hash = PayloadHash::try_new(hex::encode(Sha256::digest(
            serde_json::to_vec(&body).unwrap_or_default(),
        )))
        .ok();
        let observation = Observation::new(
            identity,
            ObservationSource::Hook,
            MonotonicTime::new(received_at),
            source_event_id,
            payload_hash,
        );
        let result = {
            let ledger = match self.ledger.as_mut() {
                Ok(value) => value,
                Err(_) => return self.reject(id, "queue_dropped", true),
            };
            ledger.reconcile(&mut self.reconciler, observation)
        };
        match result {
            Ok(PersistedReconcileOutcome::Accepted(reserved)) => {
                if parsed.event_kind == NormalizedState::AttentionRequired {
                    if let Some(session_state) = &self.session_state {
                        let session_id = record.launch.terminal_session_id().as_str().to_string();
                        let attention_id = format!(
                            "agent-hook:{}:{}",
                            record.launch.launch_id().as_str(),
                            reserved.canonical.canonical_event_id,
                        );
                        session_state.ingest(
                            session_id.clone(),
                            Evidence {
                                observed_at: session_state::unix_epoch_millis(),
                                source: EvidenceSource::Hook,
                                session_epoch: session_state.current_epoch(&session_id),
                                process: None,
                                signal: EvidenceSignal::Hook {
                                    attention: AttentionKind::Input,
                                    attention_id: Some(attention_id),
                                    detail: None,
                                    confidence: 1.0,
                                    stale_after: HOOK_ATTENTION_STALE_AFTER_MS,
                                },
                            },
                        );
                    }
                }
                if let Err(reason) = self.sync_mapping(hook_cap, &mapping_session_id, &mapping_event_id, parsed.event_kind, true) {
                    return self.reject(id, reason, reason == "queue_dropped");
                }
                self.metrics.accepted.fetch_add(1, Ordering::Relaxed);
                HookWireResponse::success(
                    id,
                    json!({
                        "accepted": true,
                        "intents_reserved": reserved.intents.len(),
                    }),
                )
            }
            Ok(PersistedReconcileOutcome::Rejected {
                reason: RejectionReason::Duplicate,
                ..
            }) => {
                if let Err(reason) = self.sync_mapping(hook_cap, &mapping_session_id, &mapping_event_id, parsed.event_kind, false) {
                    return self.reject(id, reason, reason == "queue_dropped");
                }
                HookWireResponse::success(id, json!({ "deduplicated": true }))
            },
            Ok(PersistedReconcileOutcome::Rejected {
                reason: RejectionReason::StaleLaunch,
                ..
            }) => self.reject(id, "stale_launch", false),
            Ok(PersistedReconcileOutcome::Rejected { .. }) => self.reject(id, "malformed", false),
            Err(_) => self.reject(id, "queue_dropped", true),
        }
    }

    fn sync_mapping(&mut self, cap: &str, session_id: &str, event_id: &str, state: NormalizedState, accepted: bool) -> Result<(), &'static str> {
        let record = self.capabilities.get_mut(cap).ok_or("unauthorized")?;
        if record.state != CapabilityState::Active { return Ok(()); }
        if !accepted && record.last_mapping_event.as_deref() != Some(event_id) { return Ok(()); }
        if record.last_mapping_session.is_none() {
            if let Some(dir) = &self.mapping_dir {
                let mappings = session_mapping::read_session_mapping_files_for_ids(dir, [record.launch.terminal_session_id().as_str()]);
                if let Some(mapping) = mappings.get(record.launch.terminal_session_id().as_str()) {
                    record.observed_sessions.insert(mapping.session_id.clone());
                    record.last_mapping_session = Some(mapping.session_id.clone());
                }
            }
        }
        // An old session's delayed Stop/SessionEnd must not undo a newer input.
        // A new active event can still explicitly resume that older session.
        if state.is_terminal() && record.observed_sessions.contains(session_id)
            && record.last_mapping_session.as_deref() != Some(session_id) { return Ok(()); }
        record.last_mapping_event = Some(event_id.to_string());
        if let Some(dir) = &self.mapping_dir {
            session_mapping::write_hook_session_mapping(
                dir, record.launch.terminal_session_id().as_str(), record.launch.provider().as_str(), session_id,
            )?;
        }
        record.observed_sessions.insert(session_id.to_string());
        record.last_mapping_session = Some(session_id.to_string());
        Ok(())
    }

    fn drain(&mut self, terminal_session_id: &str, at: u64) {
        self.answered_prompts
            .retain(|(session_id, _)| session_id.as_str() != terminal_session_id);
        for record in self.capabilities.values_mut().filter(|record| {
            record.launch.terminal_session_id().as_str() == terminal_session_id
                && self.current_launch.get(&(
                    record.launch.terminal_session_id().clone(),
                    record.launch.provider(),
                )) == Some(record.launch.launch_id())
        }) {
            record.state = CapabilityState::Draining { since: at };
            self.reconciler
                .mark_session_closed(&record.launch, MonotonicTime::new(at));
        }
    }

    fn reject(&self, id: u64, reason: &'static str, retryable: bool) -> HookWireResponse {
        match reason {
            "unauthorized" => {
                self.metrics
                    .rejected_invalid_cap
                    .fetch_add(1, Ordering::Relaxed);
            }
            "stale_launch" => {
                self.metrics
                    .rejected_stale_launch
                    .fetch_add(1, Ordering::Relaxed);
            }
            "wrong_provider" => {
                self.metrics
                    .rejected_wrong_provider
                    .fetch_add(1, Ordering::Relaxed);
            }
            "queue_dropped" => {
                self.metrics.queue_dropped.fetch_add(1, Ordering::Relaxed);
            }
            _ => {}
        }
        HookWireResponse::rejected(id, reason, retryable)
    }
}

struct ObserveBody {
    event_kind: NormalizedState,
    provider_session_id: String,
    provider_turn_id: String,
    source_event_id: String,
    terminal_session_id: Option<String>,
    launch_id: Option<String>,
    pane_id: Option<String>,
    provider: Option<Provider>,
}

impl ObserveBody {
    fn parse(value: &Value) -> Result<Self, &'static str> {
        let object = value.as_object().ok_or("malformed")?;
        Ok(Self {
            event_kind: parse_state(required_string(object, "event_kind")?).ok_or("malformed")?,
            provider_session_id: required_string(object, "provider_session_id")?.to_string(),
            provider_turn_id: required_string(object, "provider_turn_id")?.to_string(),
            source_event_id: required_string(object, "source_event_id")?.to_string(),
            terminal_session_id: optional_string(object, "terminal_session_id")?,
            launch_id: optional_string(object, "launch_id")?,
            pane_id: optional_string(object, "pane_id")?,
            provider: optional_string(object, "provider")?
                .map(|value| parse_provider(&value).ok_or("wrong_provider"))
                .transpose()?,
        })
    }
}

fn required_string<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<&'a str, &'static str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or("malformed")
}

fn optional_string(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<String>, &'static str> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(Some(value.clone())),
        _ => Err("malformed"),
    }
}

pub fn parse_provider(value: &str) -> Option<Provider> {
    match value {
        "claude" | "claude-codex" => Some(Provider::Claude),
        "codex" => Some(Provider::Codex),
        "grok" => Some(Provider::Grok),
        _ => None,
    }
}

fn parse_state(value: &str) -> Option<NormalizedState> {
    NormalizedState::from_str(&value.to_ascii_lowercase())
}

pub fn validate_value_bounds(value: &Value, depth: usize) -> Result<(), &'static str> {
    if depth > HOOK_BODY_MAX_DEPTH {
        return Err("too_large");
    }
    match value {
        Value::String(value) if value.len() > HOOK_STRING_MAX_BYTES => Err("too_large"),
        Value::Array(values) => values
            .iter()
            .try_for_each(|value| validate_value_bounds(value, depth + 1)),
        Value::Object(values) => values.iter().try_for_each(|(key, value)| {
            if key.len() > HOOK_STRING_MAX_BYTES {
                return Err("too_large");
            }
            validate_value_bounds(value, depth + 1)
        }),
        _ => Ok(()),
    }
}

struct TokenBucket {
    capacity: u64,
    refill_per_second: u64,
    tokens_milli: u64,
    last_ms: u64,
}

impl TokenBucket {
    fn new(capacity: u64, refill_per_second: u64) -> Self {
        Self {
            capacity,
            refill_per_second,
            tokens_milli: capacity * 1000,
            last_ms: 0,
        }
    }

    fn allow(&mut self, now_ms: u64) -> bool {
        let elapsed = now_ms.saturating_sub(self.last_ms);
        self.last_ms = now_ms;
        self.tokens_milli = self
            .tokens_milli
            .saturating_add(elapsed.saturating_mul(self.refill_per_second))
            .min(self.capacity * 1000);
        if self.tokens_milli < 1000 {
            return false;
        }
        self.tokens_milli -= 1000;
        true
    }
}

fn random_hex(bytes: usize) -> String {
    let mut value = vec![0_u8; bytes];
    rand::thread_rng().fill_bytes(&mut value);
    hex::encode(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    fn worker() -> Worker {
        let metrics = Arc::new(HookMetrics::default());
        Worker::for_test(AppInstanceId::try_new("app-test").unwrap(), metrics)
    }

    fn issue(worker: &mut Worker, session: &str, provider: Provider) -> CapabilityGrant {
        match worker.issue(session.to_string(), provider, None) {
            WorkerReply::Grant(grant) => grant,
            WorkerReply::Wire(response) => panic!("issue failed: {:?}", response.reason),
        }
    }

    fn body(state: &str, source: &str) -> Value {
        json!({
            "event_kind": state,
            "provider_session_id": "provider-session-a",
            "provider_turn_id": "turn-a",
            "source_event_id": source,
        })
    }

    #[test]
    fn issuing_twice_in_one_terminal_session_returns_distinct_capabilities() {
        let mut worker = worker();
        let first = issue(&mut worker, "terminal-a", Provider::Codex);
        let second = issue(&mut worker, "terminal-a", Provider::Codex);
        assert_ne!(first.hook_cap, second.hook_cap);
        assert_eq!(first.hook_cap.len(), 64);
        assert_eq!(second.hook_cap.len(), 64);
    }

    #[test]
    fn provider_hook_mode_is_applied_to_new_launches() {
        let mut worker = worker();
        worker
            .provider_modes
            .insert(Provider::Codex, HookMode::Unavailable);
        let _ = issue(&mut worker, "terminal-a", Provider::Codex);
        assert_eq!(
            worker.provider_modes.get(&Provider::Codex),
            Some(&HookMode::Unavailable)
        );
    }

    #[test]
    fn installed_helper_reaches_hook_observe_and_reconciler() {
        let service = HookService::for_test();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let grant = runtime
            .block_on(service.issue_capability("terminal-e2e".to_string(), Provider::Codex, None))
            .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        fs::write(
            directory.path().join("mycmux.port"),
            listener.local_addr().unwrap().port().to_string(),
        )
        .unwrap();
        let server_service = service.clone();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
                .unwrap();
            for _ in 0..2 {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let mut request: Value = serde_json::from_str(&line).unwrap();
                let id = request["id"].as_u64().unwrap();
                let hook_cap = request["hook_cap"].as_str().unwrap().to_string();
                let command = request["cmd"].as_str().unwrap().to_string();
                let body = request.as_object_mut().unwrap().remove("body").unwrap();
                let response =
                    runtime.block_on(server_service.handle_hook(id, hook_cap, command, body));
                serde_json::to_writer(&mut stream, &response).unwrap();
                stream.write_all(b"\n").unwrap();
                stream.flush().unwrap();
            }
        });
        let helper = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("hooks")
            .join("mycmux_hook.py");
        #[cfg(target_os = "windows")]
        let python = "python";
        #[cfg(not(target_os = "windows"))]
        let python = "python3";
        let mut child = Command::new(python)
            .arg(helper)
            .args(["--provider", "codex", "--event-kind", "turn_ended"])
            .env("MYCMUX_HOOK_CAP", &grant.hook_cap)
            .env("MYCMUX_RUNTIME_DIR", directory.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(br#"{"session_id":"provider-session","turn_id":"turn","event_id":"event"}"#)
            .unwrap();
        let output = child.wait_with_output().unwrap();
        server.join().unwrap();
        assert!(output.status.success());
        assert!(output.stdout.is_empty());
        assert!(output.stderr.is_empty());
        assert_eq!(service.metrics().accepted, 2);
    }

    #[test]
    fn p2_01_attention_required_hook_marks_session_waiting_without_screen_content() {
        let state = SessionStateStore::new();
        let metrics = Arc::new(HookMetrics::default());
        let mut worker = Worker::for_test(
            AppInstanceId::try_new("app-test").unwrap(),
            metrics,
        );
        worker.session_state = Some(state.clone());
        let grant = issue(&mut worker, "terminal-hook-waiting", Provider::Claude);

        let response = worker.handle(
            1,
            &grant.hook_cap,
            "hook.observe",
            body("attention_required", "notification-a"),
            1,
        );

        assert!(response.ok);
        let view = state.current_view("terminal-hook-waiting").unwrap();
        assert_eq!(view.attention.kind, AttentionKind::Input);
        assert_eq!(view.attention.sources, vec![EvidenceSource::Hook]);
        assert!(view
            .attention
            .attention_id
            .as_deref()
            .unwrap()
            .starts_with("agent-hook:"));
        assert_eq!(
            session_state::derive_ui_state(&view),
            session_state::UiSessionState::Waiting,
        );
    }

    #[test]
    fn hook_attention_evidence_expires_like_every_other_source() {
        let state = SessionStateStore::new();
        let metrics = Arc::new(HookMetrics::default());
        let mut worker = Worker::for_test(AppInstanceId::try_new("app-test").unwrap(), metrics);
        worker.session_state = Some(state.clone());
        let grant = issue(&mut worker, "terminal-hook-stale", Provider::Claude);

        let response = worker.handle(
            1,
            &grant.hook_cap,
            "hook.observe",
            body("attention_required", "notification-stale"),
            1,
        );

        assert!(response.ok);
        let view = state.current_view("terminal-hook-stale").unwrap();
        // Attention staleness merges with max(), so a sentinel here would pin the
        // session for the lifetime of the process once staleness is acted on.
        assert!(view.attention.stale_after < u64::MAX);
        assert_eq!(view.attention.stale_after, HOOK_ATTENTION_STALE_AFTER_MS);
    }

    #[test]
    fn revoke_all_releases_answered_prompts_so_the_next_question_can_be_answered() {
        let mut worker = worker();
        assert!(worker.try_answer_prompt("terminal-a".to_string(), "prompt-a".to_string()));
        assert!(!worker.try_answer_prompt("terminal-a".to_string(), "prompt-a".to_string()));

        worker.revoke_all();

        assert!(worker.try_answer_prompt("terminal-a".to_string(), "prompt-a".to_string()));
    }

    #[test]
    fn p2_03_prompt_answer_is_compare_and_swap() {
        let mut worker = worker();
        assert!(worker.try_answer_prompt("terminal-a".to_string(), "prompt-a".to_string()));
        assert!(!worker.try_answer_prompt("terminal-a".to_string(), "prompt-a".to_string()));
        assert!(worker.try_answer_prompt("terminal-a".to_string(), "prompt-b".to_string()));
    }

    #[test]
    fn p2_04_current_launch_check_rejects_superseded_launch() {
        let mut worker = worker();
        let old = issue(&mut worker, "terminal-a", Provider::Claude);
        let old_launch = worker
            .capabilities
            .get(&old.hook_cap)
            .unwrap()
            .launch
            .launch_id()
            .as_str()
            .to_string();
        assert!(worker.is_current_launch("terminal-a".to_string(), old_launch.clone()));
        let _new = issue(&mut worker, "terminal-a", Provider::Claude);
        assert!(!worker.is_current_launch("terminal-a".to_string(), old_launch));
    }

    #[test]
    fn superseded_launch_cannot_change_current_projection() {
        let mut worker = worker();
        let old = issue(&mut worker, "terminal-a", Provider::Codex);
        let new = issue(&mut worker, "terminal-a", Provider::Codex);
        let stale = worker.handle(
            1,
            &old.hook_cap,
            "hook.observe",
            body("turn_ended", "old-event"),
            1,
        );
        assert_eq!(stale.reason, Some("stale_launch"));
        let accepted = worker.handle(
            2,
            &new.hook_cap,
            "hook.observe",
            body("turn_active", "new-event"),
            2,
        );
        assert!(accepted.ok);
        let current_launch = worker
            .current_launch
            .get(&(
                TerminalSessionId::try_new("terminal-a").unwrap(),
                Provider::Codex,
            ))
            .unwrap();
        assert_eq!(
            worker
                .capabilities
                .get(&new.hook_cap)
                .unwrap()
                .launch
                .launch_id(),
            current_launch
        );
    }

    #[test]
    fn session_and_provider_mismatches_are_rejected() {
        let mut worker = worker();
        let grant = issue(&mut worker, "terminal-a", Provider::Codex);
        let mut wrong_session = body("turn_active", "event-a");
        wrong_session["terminal_session_id"] = Value::String("terminal-b".to_string());
        assert_eq!(
            worker
                .handle(1, &grant.hook_cap, "hook.observe", wrong_session, 1)
                .reason,
            Some("malformed")
        );
        let mut wrong_provider = body("turn_active", "event-b");
        wrong_provider["provider"] = Value::String("claude".to_string());
        assert_eq!(
            worker
                .handle(2, &grant.hook_cap, "hook.observe", wrong_provider, 2)
                .reason,
            Some("wrong_provider")
        );
    }

    #[test]
    fn hook_capability_cannot_reach_broad_socket_commands() {
        let mut worker = worker();
        let grant = issue(&mut worker, "terminal-a", Provider::Codex);
        for (id, command) in [
            "pane.spawn",
            "pane.send_text",
            "pane.read",
            "pane.close_tab",
        ]
        .into_iter()
        .enumerate()
        {
            let response = worker.handle(
                id as u64,
                &grant.hook_cap,
                command,
                Value::Object(Default::default()),
                id as u64,
            );
            assert_eq!(response.reason, Some("malformed"), "{command}");
        }
    }

    #[test]
    fn unknown_or_wrong_app_capability_is_unauthorized() {
        let mut worker = worker();
        let grant = issue(&mut worker, "terminal-a", Provider::Codex);
        assert_eq!(
            worker
                .handle(1, "missing", "hook.health", json!({}), 1)
                .reason,
            Some("unauthorized")
        );
        worker
            .capabilities
            .get_mut(&grant.hook_cap)
            .unwrap()
            .app_instance_id = AppInstanceId::try_new("other-app").unwrap();
        assert_eq!(
            worker
                .handle(2, &grant.hook_cap, "hook.health", json!({}), 2)
                .reason,
            Some("unauthorized")
        );
    }

    #[test]
    fn draining_accepts_terminal_only_and_revoked_changes_nothing() {
        let mut worker = worker();
        let grant = issue(&mut worker, "terminal-a", Provider::Codex);
        worker.drain("terminal-a", 10);
        let active = worker.handle(
            1,
            &grant.hook_cap,
            "hook.observe",
            body("turn_active", "active"),
            11,
        );
        assert_eq!(active.reason, Some("stale_launch"));
        let terminal = worker.handle(
            2,
            &grant.hook_cap,
            "hook.observe",
            body("turn_ended", "terminal"),
            12,
        );
        assert!(terminal.ok);
        let before = worker.ledger.as_ref().unwrap().count_records().unwrap();
        worker.capabilities.get_mut(&grant.hook_cap).unwrap().state = CapabilityState::Revoked;
        let revoked = worker.handle(
            3,
            &grant.hook_cap,
            "hook.observe",
            body("failed", "revoked"),
            13,
        );
        assert_eq!(revoked.reason, Some("unauthorized"));
        assert_eq!(
            worker.ledger.as_ref().unwrap().count_records().unwrap(),
            before
        );
    }

    #[test]
    fn accepted_observations_reserve_intents_exactly_once() {
        let mut worker = worker();
        let grant = issue(&mut worker, "terminal-a", Provider::Claude);
        let first = worker.handle(
            1,
            &grant.hook_cap,
            "hook.observe",
            body("turn_ended", "same"),
            1,
        );
        let second = worker.handle(
            2,
            &grant.hook_cap,
            "hook.observe",
            body("turn_ended", "same"),
            2,
        );
        assert_eq!(first.result.unwrap()["intents_reserved"], 3);
        assert_eq!(second.result.unwrap()["deduplicated"], true);
    }

    #[test]
    fn body_string_and_depth_limits_are_enforced() {
        assert_eq!(
            validate_value_bounds(&Value::String("x".repeat(HOOK_STRING_MAX_BYTES + 1)), 0),
            Err("too_large")
        );
        let mut nested = Value::Null;
        for _ in 0..=HOOK_BODY_MAX_DEPTH {
            nested = json!([nested]);
        }
        assert_eq!(validate_value_bounds(&nested, 0), Err("too_large"));

        let mut worker = worker();
        let grant = issue(&mut worker, "terminal-a", Provider::Codex);
        assert_eq!(
            worker
                .handle(1, &grant.hook_cap, "hook.health", Value::Null, 1)
                .reason,
            Some("malformed")
        );
    }

    #[test]
    fn per_capability_rate_limit_allows_burst_forty() {
        let mut bucket = TokenBucket::new(40, 20);
        assert!((0..40).all(|_| bucket.allow(0)));
        assert!(!bucket.allow(0));
        assert!((0..20).all(|_| bucket.allow(1_000)));
        assert!(!bucket.allow(1_000));
    }

    #[test]
    fn bounded_queue_overflow_is_counted() {
        let (sender, _receiver) = mpsc::sync_channel::<Work>(HOOK_QUEUE_CAPACITY);
        for _ in 0..HOOK_QUEUE_CAPACITY {
            let (reply, _response) = mpsc::channel();
            sender.try_send(Work::RevokeAll { reply }).unwrap();
        }
        let metrics = Arc::new(HookMetrics::default());
        let service = HookService {
            app_instance_id: AppInstanceId::try_new("app-test").unwrap(),
            started: Instant::now(),
            sender,
            metrics: metrics.clone(),
        };
        assert_eq!(
            service
                .try_send(
                    {
                        let (reply, _response) = mpsc::channel();
                        Work::RevokeAll { reply }
                    },
                    1
                )
                .unwrap_err()
                .reason,
            Some("queue_dropped")
        );
        assert_eq!(metrics.snapshot().queue_dropped, 1);
    }

    #[test]
    fn mapping_rejects_unsafe_ids_wrong_providers_and_stale_capabilities() {
        let dir = tempfile::tempdir().unwrap();
        let mut worker = worker();
        worker.mapping_dir = Some(dir.path().to_path_buf());
        session_mapping::write_session_mapping_file_to_dir(dir.path(), "terminal-a", "claude-codex", "old").unwrap();
        let grant = issue(&mut worker, "terminal-a", Provider::Claude);
        for unsafe_id in ["../outside", "bad:id", "bad\nline", " CON", "CON", "COM1", ".."] {
            let mut input = body("turn_active", "source");
            input["provider_session_id"] = json!(unsafe_id);
            assert_eq!(worker.handle(1, &grant.hook_cap, "hook.observe", input, 1).reason, Some("malformed"));
        }
        let mut wrong = body("turn_active", "wrong");
        wrong["provider"] = json!("codex");
        assert_eq!(worker.handle(2, &grant.hook_cap, "hook.observe", wrong, 2).reason, Some("wrong_provider"));
        let next = issue(&mut worker, "terminal-a", Provider::Claude);
        assert_eq!(worker.handle(3, &grant.hook_cap, "hook.observe", body("turn_active", "stale"), 3).reason, Some("stale_launch"));
        assert!(worker.handle(4, &next.hook_cap, "hook.observe", body("turn_active", "fresh"), 4).ok);
        let mapping = session_mapping::read_session_mapping_files_for_ids(dir.path(), ["terminal-a"]).remove("terminal-a").unwrap();
        assert_eq!(mapping.agent_kind.as_deref(), Some("claude-codex"));
        assert_eq!(mapping.session_id, "provider-session-a");
        let codex = issue(&mut worker, "terminal-a", Provider::Codex);
        let codex_launch = worker.capabilities[&codex.hook_cap].launch.clone();
        assert_eq!(worker.handle(5, &codex.hook_cap, "hook.observe", body("turn_active", "cross-provider"), 5).reason, Some("wrong_provider"));
        assert!(worker.reconciler.canonical_for(&codex_launch).is_none());
        assert_eq!(session_mapping::read_session_mapping_files_for_ids(dir.path(), ["terminal-a"])["terminal-a"].agent_kind.as_deref(), Some("claude-codex"));
    }

    #[test]
    fn mapping_follows_new_sessions_but_not_replayed_or_delayed_old_terminal_hooks() {
        let dir = tempfile::tempdir().unwrap();
        let mut worker = worker();
        worker.mapping_dir = Some(dir.path().to_path_buf());
        let grant = issue(&mut worker, "terminal-a", Provider::Codex);
        let input = |session: &str, turn: &str, event: &str, state: &str| json!({
            "event_kind":state, "provider_session_id":session, "provider_turn_id":turn, "source_event_id":event,
        });
        let old = input("old", "turn-old", "event-old", "turn_active");
        assert!(worker.handle(1, &grant.hook_cap, "hook.observe", old.clone(), 1).ok);
        assert!(worker.handle(2, &grant.hook_cap, "hook.observe", input("new", "turn-new", "event-new", "turn_active"), 2).ok);
        assert!(worker.handle(3, &grant.hook_cap, "hook.observe", old, 3).ok);
        assert!(worker.handle(4, &grant.hook_cap, "hook.observe", input("old", "turn-old", "stop-old", "turn_ended"), 4).ok);
        let read = || session_mapping::read_session_mapping_files_for_ids(dir.path(), ["terminal-a"])["terminal-a"].session_id.clone();
        assert_eq!(read(), "new");
        assert!(worker.handle(5, &grant.hook_cap, "hook.observe", input("old", "turn-resume", "resume", "turn_active"), 5).ok);
        assert_eq!(read(), "old");
        worker.drain("terminal-a", 6);
        assert!(worker.handle(6, &grant.hook_cap, "hook.observe", input("new", "turn-new", "end-new", "turn_ended"), 7).ok);
        assert_eq!(read(), "old");
    }

    #[test]
    fn a_delayed_stop_for_the_launch_mapping_cannot_undo_the_first_new_session_hook() {
        let dir = tempfile::tempdir().unwrap();
        let mut worker = worker();
        worker.mapping_dir = Some(dir.path().to_path_buf());
        session_mapping::write_session_mapping_file_to_dir(dir.path(), "terminal-a", "claude", "launch-old").unwrap();
        let grant = issue(&mut worker, "terminal-a", Provider::Claude);
        assert!(worker.handle(1, &grant.hook_cap, "hook.observe", body("turn_active", "new"), 1).ok);
        let mut old_stop = body("turn_ended", "old-stop");
        old_stop["provider_session_id"] = json!("launch-old");
        assert!(worker.handle(2, &grant.hook_cap, "hook.observe", old_stop, 2).ok);
        assert_eq!(session_mapping::read_session_mapping_files_for_ids(dir.path(), ["terminal-a"])["terminal-a"].session_id, "provider-session-a");
    }

    #[test]
    fn revoking_hooks_or_starting_a_new_launch_releases_mapping_provenance() {
        let dir = tempfile::tempdir().unwrap();
        let mut worker = worker();
        worker.mapping_dir = Some(dir.path().to_path_buf());
        for revoke in [false, true] {
            let grant = issue(&mut worker, "terminal-a", Provider::Codex);
            assert!(worker.handle(1, &grant.hook_cap, "hook.observe", body("turn_active", "active"), 1).ok);
            assert!(session_mapping::read_session_mapping_files_for_ids(dir.path(), ["terminal-a"])["terminal-a"].hook_confirmed);
            if revoke { worker.revoke_all(); }
            else { let _ = issue(&mut worker, "terminal-a", Provider::Codex); }
            assert!(!session_mapping::read_session_mapping_files_for_ids(dir.path(), ["terminal-a"])["terminal-a"].hook_confirmed);
            session_mapping::write_session_mapping_file_to_dir(dir.path(), "terminal-a", "codex", "next-launch").unwrap();
            assert_eq!(session_mapping::read_session_mapping_files_for_ids(dir.path(), ["terminal-a"])["terminal-a"].session_id, "next-launch");
        }
    }

    #[test]
    fn a_failed_mapping_write_can_retry_the_current_deduplicated_hook() {
        let dir = tempfile::tempdir().unwrap();
        let mut worker = worker();
        let invalid_dir = dir.path().join("not-a-directory");
        fs::write(&invalid_dir, b"file").unwrap();
        worker.mapping_dir = Some(invalid_dir);
        let grant = issue(&mut worker, "terminal-a", Provider::Codex);
        let input = body("turn_active", "retry");
        assert_eq!(worker.handle(1, &grant.hook_cap, "hook.observe", input.clone(), 1).reason, Some("queue_dropped"));
        worker.mapping_dir = Some(dir.path().join("valid"));
        assert!(worker.handle(2, &grant.hook_cap, "hook.observe", input, 2).ok);
        let mapping = session_mapping::read_session_mapping_files_for_ids(worker.mapping_dir.as_ref().unwrap(), ["terminal-a"]);
        assert_eq!(mapping["terminal-a"].session_id, "provider-session-a");
        assert!(mapping["terminal-a"].hook_confirmed);
    }
}
