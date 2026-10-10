use super::{
    derive_ui_state_at, reduce, unix_epoch_millis, Evidence, SessionStateRecordSnapshot,
    SessionStateSnapshot, SessionView, UiSessionState, LEDGER_CAPACITY,
};
use dashmap::DashMap;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

mod expiry;
use expiry::{ObservationProvider, QuietDeadline, WorkerSignal};

/// A revision and its projection captured at the same store ordering point.
/// This is runtime state, not a new ledger or protocol field.
#[derive(Debug, Clone)]
pub(crate) struct ProjectedSession {
    pub view: SessionView,
    pub ui_state: UiSessionState,
}

#[derive(Debug, Clone)]
pub(super) struct SessionRecord {
    view: SessionView,
    ui_state: UiSessionState,
    recent_evidence: VecDeque<Evidence>,
    quiet_deadline: Option<QuietDeadline>,
    deadline_generation: u64,
}

impl SessionRecord {
    fn new(session_id: String) -> Self {
        Self {
            view: SessionView::new(session_id),
            ui_state: UiSessionState::Unknown,
            recent_evidence: VecDeque::with_capacity(LEDGER_CAPACITY),
            quiet_deadline: None,
            deadline_generation: 0,
        }
    }

    fn projected(&self) -> ProjectedSession {
        ProjectedSession {
            view: self.view.clone(),
            ui_state: self.ui_state,
        }
    }

    fn remember(&mut self, evidence: Evidence) {
        if self.recent_evidence.len() == LEDGER_CAPACITY {
            self.recent_evidence.pop_front();
        }
        self.recent_evidence.push_back(evidence);
    }

    fn ingest(
        &mut self,
        evidence: Evidence,
        observation: Option<(u64, Option<u64>)>,
        now: u64,
    ) -> bool {
        let previous_revision = self.view.session_revision;
        let previous_epoch = self.view.session_epoch;
        let incoming = self.recent_evidence.back() != Some(&evidence);
        let next = if incoming {
            reduce(&self.view, &evidence)
        } else {
            self.view.clone()
        };
        // Match the epoch after incoming evidence, including attention removal
        // and epoch replacement. Never publish the intermediate quiet view.
        let output = observation.and_then(|(epoch, at)| {
            at.filter(|at| Some(epoch) == next.session_epoch && *at > next.last_output_at)
                .map(|at| Evidence::last_output(at, epoch, super::OutputOrigin::Pty))
        });
        match output {
            Some(output) if incoming && output.observed_at <= evidence.observed_at => {
                // A genuinely post-output Idle/WorkDone keeps its base meaning.
                self.view = reduce(&self.view, &output);
                self.remember(output);
                self.view = reduce(&self.view, &evidence);
                self.remember(evidence);
            }
            output => {
                self.view = next;
                if incoming { self.remember(evidence); }
                if let Some(output) = output {
                    self.view = reduce(&self.view, &output);
                    self.remember(output);
                }
            }
        }
        let ui_state = derive_ui_state_at(&self.view, now);
        let changed = self.view.session_revision != previous_revision
            || self.view.session_epoch != previous_epoch
            || ui_state != self.ui_state;
        // Evidence and projection changes share one revision. Epoch reset must
        // never reset this session's revision; timestamp-only output need not
        // publish until it also changes the projected state.
        self.view.session_revision = if changed {
            previous_revision.saturating_add(1)
        } else {
            previous_revision
        };
        self.ui_state = ui_state;
        changed
    }

    fn reproject(&mut self, now: u64) -> bool {
        let ui_state = derive_ui_state_at(&self.view, now);
        if ui_state == self.ui_state {
            return false;
        }
        self.ui_state = ui_state;
        self.view.session_revision = self.view.session_revision.saturating_add(1);
        // Time is an interpretation of evidence, not new process/attention
        // evidence. Leave activity, all timestamps and the ledger untouched.
        true
    }
}

type ChangeListener = Arc<dyn Fn(ProjectedSession) + Send + Sync>;

pub(super) struct StoreInner {
    pub(super) sessions: DashMap<String, SessionRecord>,
    change_listener: RwLock<Option<ChangeListener>>,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    operation_gate: Mutex<()>,
    observation_provider: RwLock<Option<ObservationProvider>>,
    quiet_worker: Arc<WorkerSignal>,
}

impl Drop for StoreInner {
    fn drop(&mut self) {
        // Only the last inner owner cancels; dropping a store clone is harmless.
        self.quiet_worker.shutdown();
    }
}

#[derive(Clone)]
pub struct SessionStateStore {
    pub(super) inner: Arc<StoreInner>,
}

impl Default for SessionStateStore {
    fn default() -> Self {
        Self::with_clock(Arc::new(unix_epoch_millis))
    }
}

impl SessionStateStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub(crate) fn with_clock(clock: Arc<dyn Fn() -> u64 + Send + Sync>) -> Self {
        Self {
            inner: Arc::new(StoreInner {
                sessions: DashMap::new(),
                change_listener: RwLock::new(None),
                clock,
                operation_gate: Mutex::new(()),
                observation_provider: RwLock::new(None),
                quiet_worker: Arc::new(WorkerSignal::new()),
            }),
        }
    }

    fn operation_guard(&self) -> MutexGuard<'_, ()> {
        self.inner
            .operation_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The listener receives captured state and must not reenter a gated store
    /// method. Lock order: store operation -> feed publication -> feed queues.
    pub(crate) fn set_change_listener(&self, listener: ChangeListener) {
        let mut current = self
            .inner
            .change_listener
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *current = Some(listener);
    }

    fn publish_locked(&self, projected: ProjectedSession) {
        let listener = self
            .inner
            .change_listener
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        // No DashMap or listener RwLock guard survives into the callback.
        if let Some(listener) = listener {
            listener(projected);
        }
    }

    pub fn ingest(&self, session_id: impl Into<String>, evidence: Evidence) -> SessionView {
        let _operation_guard = self.operation_guard();
        let now = (self.inner.clock)();
        let session_id = session_id.into();
        let has_output = self.inner.sessions.get(&session_id)
            .is_some_and(|record| record.view.last_output_at > 0);
        let incoming_output = evidence.observed_at > 0
            && matches!(&evidence.signal, super::EvidenceSignal::LastOutput { origin: super::OutputOrigin::Pty });
        // No time-based expiry is possible before the first real output.
        // Otherwise read even when attention/Idle currently blocks expiry:
        // incoming evidence may remove that protection in this operation.
        let observation = if has_output || incoming_output {
            self.reader_observation_locked(&session_id)
        } else { None };
        let (view, reschedule) = self.ingest_locked(session_id, evidence, observation, now);
        if reschedule {
            self.inner.quiet_worker.reschedule();
        }
        view
    }

    fn reader_observation_locked(&self, session_id: &str) -> Option<(u64, Option<u64>)> {
        let provider = self.inner.observation_provider.read()
            .unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
        // The operation gate is held, but no session map/provider lock is held
        // across the owned in-memory read. No monitor scanning or file work.
        provider.and_then(|provider| provider(session_id))
    }

    fn ingest_locked(
        &self,
        session_id: String,
        evidence: Evidence,
        observation: Option<(u64, Option<u64>)>,
        now: u64,
    ) -> (SessionView, bool) {
        let mut record = self
            .inner
            .sessions
            .entry(session_id.clone())
            .or_insert_with(|| SessionRecord::new(session_id));
        let changed = record.ingest(evidence, observation, now);
        let reschedule = record.refresh_deadline();
        let projected = record.projected();
        drop(record);
        if changed {
            self.publish_locked(projected.clone());
        }
        (projected.view, reschedule)
    }

    fn reconcile_locked(&self, session_id: Option<&str>, now: u64) -> bool {
        let mut ids: Vec<_> = self
            .inner
            .sessions
            .iter()
            .filter(|record| session_id.is_none_or(|id| record.key() == id))
            .map(|record| record.key().clone())
            .collect();
        ids.sort();
        let provider = self
            .inner
            .observation_provider
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let mut reschedule = false;
        for id in ids {
            // Copy the canonical identity, drop its guard, then read only the
            // manager's atomic observation. The provider must return owned
            // values, do no I/O, and never reenter a gated store method.
            let identity = self
                .inner
                .sessions
                .get(&id)
                .and_then(|record| expiry::quiet_identity(&record.view));
            if let (Some((epoch, output_at)), Some(provider)) = (identity, provider.as_ref()) {
                if let Some((observed_epoch, Some(observed_output))) = provider(&id) {
                    if observed_epoch == epoch && observed_output > output_at {
                        // The store gate prevents authoritative epoch/lifecycle
                        // changes until this real timestamp has been reduced.
                        let (_, changed) = self.ingest_locked(
                            id.clone(),
                            Evidence::last_output(observed_output, epoch, super::OutputOrigin::Pty),
                            None, // This output is already the gated reader observation.
                            now,
                        );
                        reschedule |= changed;
                    }
                }
            }
            let changed = {
                let Some(mut record) = self.inner.sessions.get_mut(&id) else {
                    continue;
                };
                let changed = record.reproject(now);
                reschedule |= record.refresh_deadline();
                changed.then(|| record.projected())
            };
            if let Some(projected) = changed {
                self.publish_locked(projected);
            }
        }
        reschedule
    }

    pub fn current_epoch(&self, session_id: &str) -> Option<u64> {
        self.inner
            .sessions
            .get(session_id)
            .and_then(|record| record.view.session_epoch)
    }

    pub fn current_view(&self, session_id: &str) -> Option<SessionView> {
        self.inner
            .sessions
            .get(session_id)
            .map(|record| record.view.clone())
    }

    pub(crate) fn current_projection(&self, session_id: &str) -> Option<ProjectedSession> {
        let _operation_guard = self.operation_guard();
        let now = (self.inner.clock)();
        if self.reconcile_locked(Some(session_id), now) {
            self.inner.quiet_worker.reschedule();
        }
        self.inner
            .sessions
            .get(session_id)
            .map(|record| record.projected())
    }

    pub fn with_current_view<T>(
        &self,
        session_id: &str,
        operation: impl FnOnce(&SessionView) -> T,
    ) -> Option<T> {
        // Preserve the same-session guard through the existing guarded PTY
        // write, without holding the store operation gate across PTY I/O.
        self.inner
            .sessions
            .get(session_id)
            .map(|record| operation(&record.view))
    }

    pub fn snapshot(&self, session_id: Option<&str>) -> SessionStateSnapshot {
        self.snapshot_with_input_revisions(session_id, |_| None)
    }

    pub fn snapshot_with_input_revisions(
        &self,
        session_id: Option<&str>,
        input_revision_for: impl Fn(&str) -> Option<u64>,
    ) -> SessionStateSnapshot {
        self.with_reconciled_snapshot(session_id, input_revision_for, |snapshot| snapshot)
    }

    /// Reconcile and publish before snapshot revision claiming. `operation`
    /// runs under the store gate, with no map guard, and may take the feed gate.
    /// It must not call another public gated store method or perform I/O.
    pub(crate) fn with_reconciled_snapshot<T>(
        &self,
        session_id: Option<&str>,
        input_revision_for: impl Fn(&str) -> Option<u64>,
        operation: impl FnOnce(SessionStateSnapshot) -> T,
    ) -> T {
        let _operation_guard = self.operation_guard();
        // One sampled clock for reconciliation and the entire captured result.
        let now = (self.inner.clock)();
        if self.reconcile_locked(session_id, now) {
            self.inner.quiet_worker.reschedule();
        }
        let mut sessions: Vec<_> = self
            .inner
            .sessions
            .iter()
            .filter(|record| session_id.is_none_or(|id| record.key() == id))
            .map(|record| SessionStateRecordSnapshot {
                session_id: record.key().clone(),
                input_revision: None,
                view: record.view.clone(),
                ui_state: record.ui_state,
                recent_evidence: record.recent_evidence.iter().cloned().collect(),
            })
            .collect();
        // External input-revision reads and the feed callback happen only
        // after every session map guard has been released.
        for record in &mut sessions {
            record.input_revision = input_revision_for(&record.session_id);
        }
        sessions.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        operation(SessionStateSnapshot { sessions })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_state::{Activity, MonitorStatus, OutputOrigin, QUIET_AFTER_MS};
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn publication_and_snapshot_callbacks_hold_the_operation_gate_without_map_guards() {
        let clock = Arc::new(AtomicU64::new(1));
        let read_clock = clock.clone();
        let store = SessionStateStore::with_clock(Arc::new(move || read_clock.load(Ordering::SeqCst)));
        let weak = Arc::downgrade(&store.inner);
        let calls = Arc::new(AtomicU64::new(0));
        let listener_calls = calls.clone();
        store.set_change_listener(Arc::new(move |projected| {
            let inner = weak.upgrade().unwrap();
            assert!(matches!(inner.operation_gate.try_lock(), Err(std::sync::TryLockError::WouldBlock)));
            assert!(matches!(
                inner.sessions.try_get_mut(&projected.view.session_id),
                dashmap::try_result::TryResult::Present(_)
            ));
            assert!(inner.change_listener.try_write().is_ok());
            listener_calls.fetch_add(1, Ordering::SeqCst);
        }));
        store.ingest("a", Evidence::last_output(1, 1, OutputOrigin::Pty));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        clock.store(1 + QUIET_AFTER_MS, Ordering::SeqCst);
        store.with_reconciled_snapshot(None, |id| {
            assert!(matches!(store.inner.sessions.try_get_mut(id), dashmap::try_result::TryResult::Present(_)));
            Some(7)
        }, |snapshot| {
            assert_eq!(snapshot.sessions[0].input_revision, Some(7));
            assert!(matches!(store.inner.operation_gate.try_lock(), Err(std::sync::TryLockError::WouldBlock)));
            assert!(matches!(store.inner.sessions.try_get_mut("a"), dashmap::try_result::TryResult::Present(_)));
        });
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(store.inner.operation_gate.try_lock().is_ok());
    }

    #[test]
    fn quiet_reprojection_only_changes_revision_and_cached_ui() {
        let clock = Arc::new(AtomicU64::new(1_000_000));
        let read_clock = clock.clone();
        let store = SessionStateStore::with_clock(Arc::new(move || read_clock.load(Ordering::SeqCst)));
        store.ingest("a", Evidence::monitor_status(1_000_000, 1, MonitorStatus::Idle, None));
        clock.store(1_000_100, Ordering::SeqCst);
        store.ingest("a", Evidence::last_output(1_000_100, 1, OutputOrigin::Pty));
        let before = store.snapshot(None).sessions.remove(0);
        clock.store(before.view.last_output_at + QUIET_AFTER_MS, Ordering::SeqCst);
        let after = store.snapshot(None).sessions.remove(0);
        assert_eq!(after.ui_state, UiSessionState::Idle);
        assert_eq!(after.view.activity, Activity::Streaming);
        let mut expected = before.view;
        expected.session_revision += 1;
        assert_eq!(after.view, expected);
        assert_eq!(after.recent_evidence, before.recent_evidence);
        assert_eq!(store.snapshot(None).sessions[0].view, after.view);
    }

    #[test]
    fn output_too_near_the_u64_limit_never_expires_by_overflow() {
        let store = SessionStateStore::with_clock(Arc::new(|| u64::MAX));
        let output_at = u64::MAX - QUIET_AFTER_MS + 1;
        let view = store.ingest("a", Evidence::last_output(output_at, 1, OutputOrigin::Pty));
        assert!(output_at.checked_add(QUIET_AFTER_MS).is_none());
        let snapshot = store.snapshot(None);
        assert_eq!(snapshot.sessions[0].ui_state, UiSessionState::Working);
        assert_eq!(snapshot.sessions[0].view.session_revision, view.session_revision);
    }

    #[tokio::test]
    async fn a_competing_snapshot_cannot_claim_a_revision_before_its_blocked_listener_publishes() {
        let clock = Arc::new(AtomicU64::new(1_000_100));
        let read_clock = clock.clone();
        let store = SessionStateStore::with_clock(Arc::new(move || read_clock.load(Ordering::SeqCst)));
        let feed = crate::status_feed::StatusFeed::new(store.clone());
        store.set_change_listener(feed.change_listener());
        store.ingest("a", Evidence::last_output(1_000_100, 1, OutputOrigin::Pty));
        let (peer, initial) = feed.subscribe();
        let publish = feed.change_listener();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        store.set_change_listener(Arc::new(move |projected| {
            if projected.ui_state == UiSessionState::Idle {
                entered_tx.send(()).unwrap();
                release_rx.lock().unwrap().recv().unwrap();
            }
            publish(projected);
        }));
        clock.store(1_000_100 + QUIET_AFTER_MS, Ordering::SeqCst);
        let reconciling_store = store.clone();
        let reconciliation = std::thread::spawn(move || reconciling_store.snapshot(None));
        entered_rx.recv().unwrap();
        let start = Arc::new(std::sync::Barrier::new(2));
        let subscribing_start = start.clone();
        let subscribing_feed = feed.clone();
        let subscribing = std::thread::spawn(move || {
            subscribing_start.wait();
            subscribing_feed.subscribe()
        });
        start.wait();
        assert!(matches!(store.inner.operation_gate.try_lock(), Err(std::sync::TryLockError::WouldBlock)));
        release_tx.send(()).unwrap();
        let ledger = reconciliation.join().unwrap();
        let (newcomer, snapshot) = subscribing.join().unwrap();
        assert_eq!(peer.pending_len(), 1);
        let crate::status_feed::StatusEvent::Changed(delta) = peer.recv().await.unwrap() else {
            panic!("expected existing subscriber's quiet delta");
        };
        assert_eq!(delta.seq, initial.snapshot.seq + 1);
        assert_eq!(snapshot.snapshot.seq, delta.seq);
        assert_eq!(snapshot.snapshot.sessions[0].status, delta.status);
        assert_eq!(ledger.sessions[0].view.session_revision, delta.session_revision);
        assert_eq!(newcomer.pending_len(), 0);
    }
}
