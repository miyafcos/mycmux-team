use crate::session_state::{
    derive_ui_state, Activity, Attention, Health, Lifecycle, ProcessIdentity, SessionStateStore,
    SessionView, UiSessionState,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

pub const STATUS_PROTOCOL_VERSION: u8 = 2;
pub const DEFAULT_SUBSCRIBER_QUEUE_CAPACITY: usize = 64;
pub const SESSION_STATUS_CHANGED_EVENT: &str = "mycmux://session-status-changed";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionStatus {
    pub session_epoch: Option<u64>,
    pub lifecycle: Lifecycle,
    pub activity: Activity,
    pub attention: Attention,
    pub health: Health,
    pub process: Option<ProcessIdentity>,
    pub last_evidence_at: u64,
    pub last_monitor_at: u64,
    pub last_output_at: u64,
    pub ui_state: UiSessionState,
}

impl From<&SessionView> for SessionStatus {
    fn from(view: &SessionView) -> Self {
        Self {
            session_epoch: view.session_epoch,
            lifecycle: view.lifecycle,
            activity: view.activity,
            attention: view.attention.clone(),
            health: view.health,
            process: view.process.clone(),
            last_evidence_at: view.last_evidence_at,
            last_monitor_at: view.last_monitor_at,
            last_output_at: view.last_output_at,
            ui_state: derive_ui_state(view),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FeedSession {
    pub session_id: String,
    pub session_revision: u64,
    pub status: SessionStatus,
}

impl From<&SessionView> for FeedSession {
    fn from(view: &SessionView) -> Self {
        Self {
            session_id: view.session_id.clone(),
            session_revision: view.session_revision,
            status: SessionStatus::from(view),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotPayload {
    pub server_epoch: String,
    pub seq: u64,
    pub sessions: Vec<FeedSession>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FeedResponseFrame {
    pub v: u8,
    pub kind: &'static str,
    pub id: u64,
    pub result: Option<Value>,
    pub error: Option<String>,
}

impl FeedResponseFrame {
    pub fn success(id: u64, result: Value) -> Self {
        Self {
            v: STATUS_PROTOCOL_VERSION,
            kind: "response",
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: u64, error: impl Into<String>) -> Self {
        Self {
            v: STATUS_PROTOCOL_VERSION,
            kind: "response",
            id,
            result: None,
            error: Some(error.into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StatusSnapshotEvent {
    pub v: u8,
    pub kind: &'static str,
    pub event: &'static str,
    #[serde(flatten)]
    pub snapshot: SnapshotPayload,
}

impl StatusSnapshotEvent {
    fn new(snapshot: SnapshotPayload) -> Self {
        Self {
            v: STATUS_PROTOCOL_VERSION,
            kind: "event",
            event: "status.snapshot",
            snapshot,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StatusChangedEvent {
    pub v: u8,
    pub kind: &'static str,
    pub event: &'static str,
    pub server_epoch: String,
    pub seq: u64,
    pub session_id: String,
    pub session_revision: u64,
    pub status: SessionStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StatusResyncRequiredEvent {
    pub v: u8,
    pub kind: &'static str,
    pub event: &'static str,
    pub server_epoch: String,
    pub seq: u64,
    pub reason: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum StatusEvent {
    Changed(StatusChangedEvent),
    ResyncRequired(StatusResyncRequiredEvent),
}

#[derive(Debug, Clone, Deserialize)]
pub struct FeedRequest {
    pub v: u8,
    pub id: u64,
    pub cmd: String,
    #[serde(default)]
    pub args: Value,
}

impl FeedRequest {
    pub fn validate(&self, expected_command: &str) -> Result<(), String> {
        if self.v != STATUS_PROTOCOL_VERSION {
            return Err(format!("unsupported status protocol version: {}", self.v));
        }
        if self.cmd != expected_command {
            return Err(format!(
                "unsupported command on status feed connection: {}",
                self.cmd
            ));
        }
        if !self.args.is_object() {
            return Err(format!("{} args must be an object", expected_command));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QueuePushResult {
    Queued,
    Coalesced,
    ResyncRequired,
    AwaitingSnapshot,
    Closed,
}

#[derive(Debug)]
struct SubscriberQueueState {
    events: VecDeque<StatusEvent>,
    needs_resync: bool,
    resync_emitted: bool,
    resync_seq: u64,
    closed: bool,
}

#[derive(Debug)]
struct SubscriberQueue {
    capacity: usize,
    state: Mutex<SubscriberQueueState>,
    notify: Notify,
}

impl SubscriberQueue {
    fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            state: Mutex::new(SubscriberQueueState {
                events: VecDeque::with_capacity(capacity.max(1)),
                needs_resync: false,
                resync_emitted: false,
                resync_seq: 0,
                closed: false,
            }),
            notify: Notify::new(),
        }
    }

    fn state(&self) -> MutexGuard<'_, SubscriberQueueState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn push(&self, event: StatusChangedEvent) -> QueuePushResult {
        let mut state = self.state();
        if state.closed {
            return QueuePushResult::Closed;
        }
        if state.needs_resync {
            state.resync_seq = state.resync_seq.max(event.seq);
            return QueuePushResult::AwaitingSnapshot;
        }
        if state.events.len() < self.capacity {
            state.events.push_back(StatusEvent::Changed(event));
            drop(state);
            self.notify.notify_one();
            return QueuePushResult::Queued;
        }

        let same_session = state.events.iter().position(|queued| {
            matches!(
                queued,
                StatusEvent::Changed(previous) if previous.session_id == event.session_id
            )
        });
        let result = if let Some(index) = same_session {
            state.events.remove(index);
            state.events.push_back(StatusEvent::Changed(event.clone()));
            QueuePushResult::Coalesced
        } else {
            QueuePushResult::ResyncRequired
        };

        // Coalescing drops a global sequence number. The client contract says
        // every sequence gap must recover through a fresh snapshot, so never
        // disguise the gap by forwarding a renumbered or out-of-order delta.
        state.events.clear();
        state.needs_resync = true;
        state.resync_emitted = false;
        state.resync_seq = event.seq;
        drop(state);
        self.notify.notify_one();
        result
    }

    async fn recv(&self, server_epoch: &str) -> Option<StatusEvent> {
        loop {
            let notified = self.notify.notified();
            {
                let mut state = self.state();
                if state.closed {
                    return None;
                }
                if state.needs_resync && !state.resync_emitted {
                    state.resync_emitted = true;
                    return Some(StatusEvent::ResyncRequired(StatusResyncRequiredEvent {
                        v: STATUS_PROTOCOL_VERSION,
                        kind: "event",
                        event: "status.resync_required",
                        server_epoch: server_epoch.to_string(),
                        seq: state.resync_seq,
                        reason: "queue_overflow",
                    }));
                }
                if let Some(event) = state.events.pop_front() {
                    return Some(event);
                }
            }
            notified.await;
        }
    }

    fn reset_for_snapshot(&self) {
        let mut state = self.state();
        state.events.clear();
        state.needs_resync = false;
        state.resync_emitted = false;
        state.resync_seq = 0;
    }

    fn close(&self) {
        let mut state = self.state();
        state.closed = true;
        state.events.clear();
        drop(state);
        self.notify.notify_waiters();
    }

    fn is_closed(&self) -> bool {
        self.state().closed
    }

    #[cfg(test)]
    fn pending_len(&self) -> usize {
        self.state().events.len()
    }
}

struct FeedInner {
    store: SessionStateStore,
    server_epoch: String,
    seq: AtomicU64,
    next_subscriber_id: AtomicU64,
    subscribers: Mutex<HashMap<u64, Arc<SubscriberQueue>>>,
    published_revisions: Mutex<HashMap<String, u64>>,
    publish_gate: Mutex<()>,
    queue_capacity: usize,
    app_handle: OnceLock<AppHandle>,
}

impl FeedInner {
    fn subscribers(&self) -> MutexGuard<'_, HashMap<u64, Arc<SubscriberQueue>>> {
        self.subscribers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn read_snapshot_payload(&self) -> SnapshotPayload {
        let sessions = self
            .store
            .snapshot(None)
            .sessions
            .iter()
            .map(|record| FeedSession::from(&record.view))
            .collect::<Vec<_>>();
        SnapshotPayload {
            server_epoch: self.server_epoch.clone(),
            seq: self.seq.load(Ordering::Acquire),
            sessions,
        }
    }

    fn snapshot_payload(&self) -> SnapshotPayload {
        let snapshot = self.read_snapshot_payload();
        let mut published_revisions = self
            .published_revisions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for session in &snapshot.sessions {
            published_revisions
                .entry(session.session_id.clone())
                .and_modify(|revision| *revision = (*revision).max(session.session_revision))
                .or_insert(session.session_revision);
        }
        snapshot
    }

    fn publish(&self, view: SessionView) {
        let _publish_guard = self
            .publish_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut published_revisions = self
            .published_revisions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if published_revisions
            .get(&view.session_id)
            .is_some_and(|revision| *revision >= view.session_revision)
        {
            return;
        }
        published_revisions.insert(view.session_id.clone(), view.session_revision);
        drop(published_revisions);
        let seq = self.seq.fetch_add(1, Ordering::AcqRel).saturating_add(1);
        let event = StatusChangedEvent {
            v: STATUS_PROTOCOL_VERSION,
            kind: "event",
            event: "status.changed",
            server_epoch: self.server_epoch.clone(),
            seq,
            session_id: view.session_id.clone(),
            session_revision: view.session_revision,
            status: SessionStatus::from(&view),
        };
        if let Some(app_handle) = self.app_handle.get() {
            let _ = app_handle.emit(SESSION_STATUS_CHANGED_EVENT, &event);
        }
        self.subscribers()
            .retain(|_, subscriber| subscriber.push(event.clone()) != QueuePushResult::Closed);
    }

    fn unsubscribe(&self, id: u64) {
        if let Some(queue) = self.subscribers().remove(&id) {
            queue.close();
        }
    }
}

#[derive(Clone)]
pub struct StatusFeed {
    inner: Arc<FeedInner>,
}

impl StatusFeed {
    pub fn new(store: SessionStateStore) -> Self {
        Self::with_capacity(store, DEFAULT_SUBSCRIBER_QUEUE_CAPACITY)
    }

    fn with_capacity(store: SessionStateStore, queue_capacity: usize) -> Self {
        Self {
            inner: Arc::new(FeedInner {
                store,
                server_epoch: uuid::Uuid::new_v4().to_string(),
                seq: AtomicU64::new(0),
                next_subscriber_id: AtomicU64::new(1),
                subscribers: Mutex::new(HashMap::new()),
                published_revisions: Mutex::new(HashMap::new()),
                publish_gate: Mutex::new(()),
                queue_capacity: queue_capacity.max(1),
                app_handle: OnceLock::new(),
            }),
        }
    }

    pub fn set_app_handle(&self, app_handle: AppHandle) {
        let _ = self.inner.app_handle.set(app_handle);
    }

    pub fn change_listener(&self) -> Arc<dyn Fn(SessionView) + Send + Sync> {
        let inner: Weak<FeedInner> = Arc::downgrade(&self.inner);
        Arc::new(move |view| {
            if let Some(inner) = inner.upgrade() {
                inner.publish(view);
            }
        })
    }

    pub fn subscribe(&self) -> (StatusSubscription, StatusSnapshotEvent) {
        let _publish_guard = self
            .inner
            .publish_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let id = self
            .inner
            .next_subscriber_id
            .fetch_add(1, Ordering::Relaxed);
        let queue = Arc::new(SubscriberQueue::new(self.inner.queue_capacity));
        let mut subscribers = self.inner.subscribers();
        subscribers.retain(|_, subscriber| !subscriber.is_closed());
        subscribers.insert(id, queue.clone());
        drop(subscribers);
        let snapshot = StatusSnapshotEvent::new(self.inner.snapshot_payload());
        (
            StatusSubscription {
                id,
                queue,
                feed: Arc::downgrade(&self.inner),
            },
            snapshot,
        )
    }

    pub fn frontend_snapshot(&self) -> SnapshotPayload {
        let _publish_guard = self
            .inner
            .publish_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.inner.read_snapshot_payload()
    }

    pub fn resnapshot(&self, subscription: &StatusSubscription) -> SnapshotPayload {
        let _publish_guard = self
            .inner
            .publish_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        subscription.queue.reset_for_snapshot();
        self.inner.snapshot_payload()
    }

    pub fn periodic_snapshot(&self, subscription: &StatusSubscription) -> StatusSnapshotEvent {
        StatusSnapshotEvent::new(self.resnapshot(subscription))
    }

    pub fn server_epoch(&self) -> &str {
        &self.inner.server_epoch
    }

    #[cfg(test)]
    pub(crate) fn subscriber_count(&self) -> usize {
        self.inner.subscribers().len()
    }
}

#[tauri::command(async)]
pub fn get_session_status_snapshot(state: tauri::State<'_, crate::AppState>) -> SnapshotPayload {
    state.status_feed.frontend_snapshot()
}

pub struct StatusSubscription {
    id: u64,
    queue: Arc<SubscriberQueue>,
    feed: Weak<FeedInner>,
}

impl StatusSubscription {
    pub async fn recv(&self) -> Option<StatusEvent> {
        let server_epoch = self.feed.upgrade()?.server_epoch.clone();
        self.queue.recv(&server_epoch).await
    }

    #[cfg(test)]
    fn pending_len(&self) -> usize {
        self.queue.pending_len()
    }
}

impl Drop for StatusSubscription {
    fn drop(&mut self) {
        if let Some(feed) = self.feed.upgrade() {
            feed.unsubscribe(self.id);
        } else {
            self.queue.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_state::{Evidence, MonitorStatus, OutputOrigin};

    fn store_and_feed(capacity: usize) -> (SessionStateStore, StatusFeed) {
        let store = SessionStateStore::new();
        let feed = StatusFeed::with_capacity(store.clone(), capacity);
        store.set_change_listener(feed.change_listener());
        (store, feed)
    }

    fn ingest_status(
        store: &SessionStateStore,
        session_id: &str,
        observed_at: u64,
        status: MonitorStatus,
    ) -> SessionView {
        store.ingest(
            session_id,
            Evidence::monitor_status(observed_at, 1, status, None),
        )
    }

    #[tokio::test]
    async fn subscribe_returns_snapshot_before_contiguous_delta() {
        let (store, feed) = store_and_feed(4);
        ingest_status(&store, "session-a", 1, MonitorStatus::Idle);

        let (subscription, snapshot) = feed.subscribe();
        assert_eq!(snapshot.event, "status.snapshot");
        assert_eq!(snapshot.snapshot.seq, 1);
        assert_eq!(snapshot.snapshot.sessions[0].session_revision, 1);

        let view = ingest_status(&store, "session-a", 2, MonitorStatus::Working);
        let StatusEvent::Changed(delta) = subscription.recv().await.unwrap() else {
            panic!("expected status.changed");
        };
        assert_eq!(delta.seq, snapshot.snapshot.seq + 1);
        assert_eq!(delta.session_revision, view.session_revision);
        assert_eq!(delta.status.ui_state, UiSessionState::Working);
    }

    #[tokio::test]
    async fn global_sequence_is_contiguous_across_sessions() {
        let (store, feed) = store_and_feed(8);
        let (subscription, snapshot) = feed.subscribe();
        assert_eq!(snapshot.snapshot.seq, 0);

        ingest_status(&store, "session-a", 1, MonitorStatus::Idle);
        ingest_status(&store, "session-b", 2, MonitorStatus::Working);
        ingest_status(&store, "session-a", 3, MonitorStatus::Working);

        for expected in 1..=3 {
            let StatusEvent::Changed(delta) = subscription.recv().await.unwrap() else {
                panic!("expected status.changed");
            };
            assert_eq!(delta.seq, expected);
        }
    }

    #[tokio::test]
    async fn duplicate_evidence_does_not_advance_sequence() {
        let (store, feed) = store_and_feed(4);
        let (subscription, _) = feed.subscribe();
        let evidence = Evidence::monitor_status(1, 1, MonitorStatus::Idle, None);
        store.ingest("session-a", evidence.clone());
        store.ingest("session-a", evidence);
        assert_eq!(subscription.pending_len(), 1);
        let StatusEvent::Changed(delta) = subscription.recv().await.unwrap() else {
            panic!("expected status.changed");
        };
        assert_eq!(delta.seq, 1);
    }

    #[tokio::test]
    async fn output_timestamp_without_state_transition_does_not_publish() {
        let (store, feed) = store_and_feed(4);
        let (subscription, _) = feed.subscribe();
        ingest_status(&store, "session-a", 1, MonitorStatus::Working);
        let _ = subscription.recv().await.expect("monitor delta");
        store.ingest("session-a", Evidence::last_output(2, 1, OutputOrigin::Pty));
        let _ = subscription.recv().await.expect("streaming delta");
        let revision = store.current_view("session-a").expect("view").session_revision;

        store.ingest("session-a", Evidence::last_output(3, 1, OutputOrigin::Pty));

        let view = store.current_view("session-a").expect("view");
        assert_eq!(view.last_output_at, 3);
        assert_eq!(view.session_revision, revision);
        assert_eq!(subscription.pending_len(), 0);
    }

    #[tokio::test]
    async fn delayed_older_revision_is_not_published_after_newer_revision() {
        let (_store, feed) = store_and_feed(4);
        let (subscription, _) = feed.subscribe();
        let listener = feed.change_listener();
        let mut newer = SessionView::new("session-a");
        newer.session_revision = 2;
        newer.activity = Activity::Idle;
        listener(newer);
        let mut older = SessionView::new("session-a");
        older.session_revision = 1;
        older.activity = Activity::RunningSilent;
        listener(older);

        assert_eq!(subscription.pending_len(), 1);
        let StatusEvent::Changed(delta) = subscription.recv().await.unwrap() else {
            panic!("expected status.changed");
        };
        assert_eq!(delta.seq, 1);
        assert_eq!(delta.session_revision, 2);
    }

    #[test]
    fn frontend_snapshot_does_not_claim_an_unpublished_revision() {
        let store = SessionStateStore::new();
        let feed = StatusFeed::with_capacity(store.clone(), 4);
        let view = ingest_status(&store, "session-a", 1, MonitorStatus::Idle);

        let snapshot = feed.frontend_snapshot();
        assert_eq!(snapshot.seq, 0);
        assert_eq!(snapshot.sessions[0].session_revision, 1);

        feed.change_listener()(view);
        let (_subscription, snapshot_after_publish) = feed.subscribe();
        assert_eq!(snapshot_after_publish.snapshot.seq, 1);
    }

    #[tokio::test]
    async fn full_queue_coalesces_then_requires_resnapshot() {
        let (store, feed) = store_and_feed(1);
        let (subscription, _) = feed.subscribe();
        ingest_status(&store, "session-a", 1, MonitorStatus::Idle);
        ingest_status(&store, "session-a", 2, MonitorStatus::Working);

        assert_eq!(subscription.pending_len(), 0);
        let StatusEvent::ResyncRequired(resync) = subscription.recv().await.unwrap() else {
            panic!("expected status.resync_required");
        };
        assert_eq!(resync.seq, 2);
        assert_eq!(resync.reason, "queue_overflow");

        let snapshot = feed.resnapshot(&subscription);
        assert_eq!(snapshot.seq, 2);
        assert_eq!(snapshot.sessions[0].session_revision, 2);
    }

    #[tokio::test]
    async fn different_session_overflow_requires_resnapshot_and_stays_bounded() {
        let (store, feed) = store_and_feed(1);
        let (subscription, _) = feed.subscribe();
        ingest_status(&store, "session-a", 1, MonitorStatus::Idle);
        ingest_status(&store, "session-b", 2, MonitorStatus::Working);
        for observed_at in 3..20 {
            ingest_status(
                &store,
                "session-b",
                observed_at,
                if observed_at % 2 == 0 {
                    MonitorStatus::Idle
                } else {
                    MonitorStatus::Working
                },
            );
            assert!(subscription.pending_len() <= 1);
        }

        let StatusEvent::ResyncRequired(resync) = subscription.recv().await.unwrap() else {
            panic!("expected status.resync_required");
        };
        assert_eq!(resync.seq, 19);
        let snapshot = feed.resnapshot(&subscription);
        assert_eq!(snapshot.seq, 19);
        assert_eq!(snapshot.sessions.len(), 2);
    }

    #[test]
    fn dropping_subscription_unregisters_it_without_another_publish() {
        let (_store, feed) = store_and_feed(2);
        let (first, _) = feed.subscribe();
        let (second, _) = feed.subscribe();
        assert_eq!(feed.subscriber_count(), 2);
        drop(first);
        assert_eq!(feed.subscriber_count(), 1);
        drop(second);
        assert_eq!(feed.subscriber_count(), 0);
    }

    #[test]
    fn multiple_read_only_subscribers_do_not_take_each_other_over() {
        let (_store, feed) = store_and_feed(2);
        let (_first, _) = feed.subscribe();
        let (_second, _) = feed.subscribe();
        assert_eq!(feed.subscriber_count(), 2);
    }

    #[test]
    fn every_server_frame_has_explicit_kind() {
        let (store, feed) = store_and_feed(2);
        let (_subscription, snapshot) = feed.subscribe();
        let snapshot = serde_json::to_value(snapshot).unwrap();
        let response = serde_json::to_value(FeedResponseFrame::success(
            1,
            serde_json::json!({ "subscribed": true }),
        ))
        .unwrap();
        assert_eq!(snapshot["kind"], "event");
        assert_eq!(response["kind"], "response");
        ingest_status(&store, "session-a", 1, MonitorStatus::Idle);
    }
}
