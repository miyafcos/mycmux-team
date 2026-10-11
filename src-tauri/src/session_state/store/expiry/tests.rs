use super::*;
use crate::session_state::{
    Activity, AttentionKind, Evidence, EvidenceSignal, EvidenceSource, MonitorStatus, OutputOrigin,
};
use crate::status_feed::{StatusChangedEvent, StatusEvent, StatusFeed, StatusSubscription};
use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::Mutex;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

mod trace;
mod review;

const OUTPUT: u64 = 1_000_100;
const SESSION: &str = "quiet-session";

#[derive(Default)]
struct Reader {
    values: Mutex<HashMap<String, (u64, Option<u64>)>>,
    reads: AtomicU64,
}

struct Fixture {
    clock: Arc<AtomicU64>,
    clock_reads: Arc<AtomicU64>,
    reader: Arc<Reader>,
    store: SessionStateStore,
    feed: StatusFeed,
}

impl Fixture {
    fn new() -> Self {
        let clock = Arc::new(AtomicU64::new(OUTPUT));
        let clock_reads = Arc::new(AtomicU64::new(0));
        let read_clock = clock.clone();
        let reads = clock_reads.clone();
        let store = SessionStateStore::with_clock(Arc::new(move || {
            reads.fetch_add(1, Ordering::SeqCst);
            read_clock.load(Ordering::SeqCst)
        }));
        let reader = Arc::new(Reader::default());
        let weak_reader = Arc::downgrade(&reader);
        store.set_observation_provider(Arc::new(move |id| {
            let reader = weak_reader.upgrade()?;
            reader.reads.fetch_add(1, Ordering::SeqCst);
            let observation = reader.values.lock().unwrap().get(id).copied();
            observation
        }));
        let feed = StatusFeed::new(store.clone());
        store.set_change_listener(feed.change_listener());
        Self { clock, clock_reads, reader, store, feed }
    }

    fn at(&self, now: u64) {
        self.clock.store(now, Ordering::SeqCst);
    }

    fn streaming(&self, id: &str) {
        self.store.ingest(id, Evidence::monitor_status(OUTPUT - 100, 1, MonitorStatus::Idle, None));
        self.store.ingest(id, Evidence::last_output(OUTPUT, 1, OutputOrigin::Pty));
    }

    fn observe(&self, id: &str, epoch: u64, at: Option<u64>) {
        self.reader.values.lock().unwrap().insert(id.into(), (epoch, at));
    }

    fn token(&self, id: &str) -> Option<QuietDeadline> {
        self.store.inner.sessions.get(id).unwrap().quiet_deadline
    }
}

/// Reports only after a completed real driver pass and when its wait is polled.
/// The tick replaces sleeps; timeouts below are failure guards, not policy time.
struct ManualWait {
    tick: Arc<Notify>,
    sender: mpsc::UnboundedSender<WaitPlan>,
    receiver: mpsc::UnboundedReceiver<WaitPlan>,
}

impl ManualWait {
    fn new() -> Self {
        let (sender, receiver) = mpsc::unbounded_channel();
        Self { tick: Arc::new(Notify::new()), sender, receiver }
    }

    fn waiter(&self) -> WorkerWait {
        let tick = self.tick.clone();
        let sender = self.sender.clone();
        Arc::new(move |plan| {
            let tick = tick.clone();
            let sender = sender.clone();
            Box::pin(async move {
                let notified = tick.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                sender.send(plan).unwrap();
                notified.await;
            })
        })
    }

    fn start(&self, store: &SessionStateStore) -> JoinHandle<()> {
        tokio::spawn(store.quiet_worker_task(self.waiter()).expect("first start"))
    }

    async fn next(&mut self) -> WaitPlan {
        tokio::time::timeout(Duration::from_secs(5), self.receiver.recv())
            .await.expect("worker completed its pass").expect("worker wait report")
    }

    async fn next_at(&mut self, now: u64) -> WaitPlan {
        loop {
            let plan = self.next().await;
            if plan.sampled_at == now {
                return plan;
            }
        }
    }

    async fn advance(&mut self, f: &Fixture, now: u64) -> WaitPlan {
        f.at(now);
        self.tick.notify_one();
        self.next_at(now).await
    }
}

async fn changed(subscription: &StatusSubscription) -> StatusChangedEvent {
    assert!(subscription.pending_len() > 0, "worker has already published the delta");
    let StatusEvent::Changed(delta) = subscription.recv().await.unwrap() else {
        panic!("expected status.changed");
    };
    delta
}

async fn stopped(store: &SessionStateStore, task: JoinHandle<()>) {
    store.stop_quiet_worker();
    tokio::time::timeout(Duration::from_secs(5), task).await.unwrap().unwrap();
}

fn attention(at: u64, kind: AttentionKind) -> Evidence {
    Evidence {
        observed_at: at,
        source: EvidenceSource::Hook,
        session_epoch: Some(1),
        process: None,
        signal: EvidenceSignal::Hook {
            attention: kind,
            attention_id: Some(format!("attention-{kind:?}")),
            detail: Some("protected original detail".into()),
            confidence: 1.0,
            stale_after: at + 30_000,
        },
    }
}

#[test]
fn constructing_a_store_does_not_start_a_task_or_require_a_runtime() {
    let store = SessionStateStore::new();
    assert!(!store.inner.quiet_worker.started.load(Ordering::Acquire));
    assert!(!store.inner.quiet_worker.stopped.load(Ordering::Acquire));
}

#[tokio::test]
async fn the_actual_driver_publishes_idle_at_the_boundary_without_a_snapshot_or_evidence() {
    for running_silent in [false, true] {
        let f = Fixture::new();
        f.streaming(SESSION);
        if running_silent {
            f.at(OUTPUT + 10_000);
            f.store.ingest(SESSION, Evidence::monitor_status(OUTPUT + 10_000, 1, MonitorStatus::Working, None));
        }
        let before = f.store.snapshot(None).sessions.remove(0);
        let (subscription, initial) = f.feed.subscribe();
        let mut driver = ManualWait::new();
        let task = driver.start(&f.store);
        assert_eq!(driver.next().await.delay, Some(FRESHNESS_WAIT));
        assert_eq!(driver.advance(&f, OUTPUT + QUIET_AFTER_MS - 1).await.delay, Some(Duration::from_millis(1)));
        assert_eq!(subscription.pending_len(), 0);
        let due = driver.advance(&f, OUTPUT + QUIET_AFTER_MS).await;
        assert_eq!(due.delay, Some(FRESHNESS_WAIT));
        assert_eq!(due.eligible_sessions, 1);
        let idle = changed(&subscription).await;
        assert_eq!(idle.status.ui_state, UiSessionState::Idle);
        assert_eq!(idle.seq, initial.snapshot.seq + 1);
        assert_eq!(idle.session_revision, before.view.session_revision + 1);
        let snapshot = f.store.snapshot(None).sessions.remove(0);
        assert_eq!(snapshot.ui_state, idle.status.ui_state);
        assert_eq!(snapshot.recent_evidence, before.recent_evidence);
        let mut expected = before.view;
        expected.session_revision += 1;
        assert_eq!(snapshot.view, expected);
        assert!(!f.token(SESSION).unwrap().armed);
        driver.advance(&f, OUTPUT + 120_000).await;
        assert_eq!(subscription.pending_len(), 0);
        assert_eq!(f.store.current_view(SESSION).unwrap(), expected);

        let at = OUTPUT + 120_001;
        f.at(at);
        f.store.ingest(SESSION, Evidence::last_output(at, 1, OutputOrigin::Pty));
        assert_eq!(driver.next_at(at).await.delay, Some(FRESHNESS_WAIT));
        let resumed = changed(&subscription).await;
        assert_eq!(resumed.status.ui_state, UiSessionState::Working);
        assert_eq!(resumed.seq, idle.seq + 1);
        assert_eq!(resumed.session_revision, idle.session_revision + 1);
        stopped(&f.store, task).await;
    }
}

#[tokio::test]
async fn reader_freshness_prevents_false_expiry_and_reactivates_idle_without_monitor_ingestion() {
    let f = Fixture::new();
    f.streaming(SESSION);
    let before = f.store.current_view(SESSION).unwrap();
    let old_token = f.token(SESSION).unwrap();
    let (subscription, _) = f.feed.subscribe();
    let mut driver = ManualWait::new();
    let task = driver.start(&f.store);
    driver.next().await;
    let output_at = OUTPUT + QUIET_AFTER_MS - 1;
    f.observe(SESSION, 1, Some(output_at));
    driver.advance(&f, OUTPUT + QUIET_AFTER_MS).await;
    let fresh = f.store.current_view(SESSION).unwrap();
    assert_eq!(fresh.last_output_at, output_at);
    assert_eq!(fresh.session_revision, before.session_revision);
    assert_eq!(subscription.pending_len(), 0);
    assert!(f.token(SESSION).unwrap().generation > old_token.generation);
    assert_eq!(f.token(SESSION).unwrap().due_at, Some(output_at + QUIET_AFTER_MS));
    driver.advance(&f, output_at + QUIET_AFTER_MS).await;
    let idle = changed(&subscription).await;
    assert_eq!(idle.status.ui_state, UiSessionState::Idle);
    let new_output = output_at + QUIET_AFTER_MS + 1;
    f.observe(SESSION, 1, Some(new_output));
    driver.advance(&f, new_output).await;
    let resumed = changed(&subscription).await;
    assert_eq!(resumed.status.ui_state, UiSessionState::Working);
    assert_eq!(resumed.session_revision, idle.session_revision + 1);
    assert_eq!(resumed.seq, idle.seq + 1);
    let ledger = f.store.snapshot(None).sessions.remove(0);
    assert_eq!(ledger.recent_evidence.last(), Some(&Evidence::last_output(new_output, 1, OutputOrigin::Pty)));
    stopped(&f.store, task).await;
}

#[test]
fn snapshot_and_current_projection_refresh_owned_reader_values_with_one_clock_sample() {
    for current_projection in [false, true] {
        let f = Fixture::new();
        f.streaming(SESSION);
        let before = f.store.current_view(SESSION).unwrap();
        let now = OUTPUT + QUIET_AFTER_MS;
        f.at(now);
        f.observe(SESSION, 1, Some(now - 1));
        let weak = Arc::downgrade(&f.store.inner);
        let reader = f.reader.clone();
        let feed_listener = f.feed.change_listener();
        f.store.set_change_listener(Arc::new(move |projected| {
            let inner = weak.upgrade().unwrap();
            assert!(reader.values.try_lock().is_ok());
            assert!(matches!(inner.sessions.try_get_mut(SESSION), dashmap::try_result::TryResult::Present(_)));
            feed_listener(projected);
        }));
        f.clock_reads.store(0, Ordering::SeqCst);
        let projected = if current_projection {
            f.store.current_projection(SESSION).unwrap()
        } else {
            let snapshot = f.feed.frontend_snapshot();
            assert_eq!(snapshot.sessions[0].status.ui_state, UiSessionState::Working);
            let record = f.store.inner.sessions.get(SESSION).unwrap();
            record.projected()
        };
        assert_eq!(f.clock_reads.load(Ordering::SeqCst), 1);
        assert_eq!(projected.ui_state, UiSessionState::Working);
        assert_eq!(projected.view.last_output_at, now - 1);
        assert_eq!(projected.view.session_revision, before.session_revision);
        // A later snapshot really expires it; its callback can acquire both maps.
        f.at(now - 1 + QUIET_AFTER_MS);
        assert_eq!(f.feed.frontend_snapshot().sessions[0].status.ui_state, UiSessionState::Idle);
    }
}

#[tokio::test]
async fn timestamp_only_output_wakes_the_driver_and_replaces_its_deadline_without_a_delta() {
    let f = Fixture::new();
    f.streaming(SESSION);
    let before = f.store.current_view(SESSION).unwrap();
    let old = f.token(SESSION).unwrap();
    let (subscription, _) = f.feed.subscribe();
    let mut driver = ManualWait::new();
    let task = driver.start(&f.store);
    driver.next().await;
    let new_output = OUTPUT + 30_000;
    f.at(new_output);
    let next = f.store.ingest(SESSION, Evidence::last_output(new_output, 1, OutputOrigin::Pty));
    driver.next_at(new_output).await;
    assert_eq!(next.session_revision, before.session_revision);
    assert_eq!(subscription.pending_len(), 0);
    let token = f.token(SESSION).unwrap();
    assert!(token.generation > old.generation);
    assert_eq!(token.output_at, new_output);
    driver.advance(&f, OUTPUT + QUIET_AFTER_MS).await;
    assert_eq!(subscription.pending_len(), 0, "obsolete wake cannot expire the newer token");
    driver.advance(&f, new_output + QUIET_AFTER_MS).await;
    assert_eq!(changed(&subscription).await.status.ui_state, UiSessionState::Idle);
    stopped(&f.store, task).await;
}

#[tokio::test]
async fn replay_internal_duplicate_and_old_epoch_output_do_not_extend_a_deadline() {
    let f = Fixture::new();
    f.streaming(SESSION);
    let before = f.token(SESSION).unwrap();
    let (subscription, _) = f.feed.subscribe();
    let mut driver = ManualWait::new();
    let task = driver.start(&f.store);
    driver.next().await;
    for evidence in [
        Evidence::last_output(OUTPUT + 30_000, 1, OutputOrigin::Replay),
        Evidence::last_output(OUTPUT + 30_001, 1, OutputOrigin::Internal),
        Evidence::last_output(OUTPUT, 1, OutputOrigin::Pty),
        Evidence::last_output(OUTPUT - 1, 1, OutputOrigin::Pty),
        Evidence::last_output(OUTPUT + 30_002, 0, OutputOrigin::Pty),
    ] {
        f.store.ingest(SESSION, evidence);
        assert_eq!(f.token(SESSION), Some(before));
    }
    assert_eq!(subscription.pending_len(), 0);
    driver.advance(&f, OUTPUT + QUIET_AFTER_MS).await;
    assert_eq!(changed(&subscription).await.status.ui_state, UiSessionState::Idle);
    stopped(&f.store, task).await;
}

#[tokio::test]
async fn an_empty_worker_sleeps_until_a_retained_signal_adds_eligible_output() {
    let f = Fixture::new();
    f.store.ingest(SESSION, Evidence::monitor_status(OUTPUT, 1, MonitorStatus::Working, None));
    let mut driver = ManualWait::new();
    let task = driver.start(&f.store);
    let plan = driver.next().await;
    assert_eq!(plan.eligible_sessions, 0);
    assert_eq!(plan.delay, None);
    assert_eq!(f.reader.reads.load(Ordering::SeqCst), 0);
    f.store.ingest(SESSION, Evidence::last_output(OUTPUT, 1, OutputOrigin::Pty));
    let plan = driver.next().await;
    assert_eq!(plan.eligible_sessions, 1);
    assert_eq!(plan.delay, Some(FRESHNESS_WAIT));
    stopped(&f.store, task).await;
}

#[tokio::test]
async fn output_between_wait_selection_and_polling_is_not_lost_and_no_gate_survives_into_the_wait() {
    let f = Fixture::new();
    f.streaming(SESSION);
    let mut driver = ManualWait::new();
    let normal_wait = driver.waiter();
    let weak = Arc::downgrade(&f.store.inner);
    let clock = f.clock.clone();
    let fired = Arc::new(AtomicBool::new(false));
    let hook_fired = fired.clone();
    let new_output = OUTPUT + 30_000;
    let wait: WorkerWait = Arc::new(move |plan| {
        if !hook_fired.swap(true, Ordering::SeqCst) {
            let inner = weak.upgrade().unwrap();
            assert!(inner.operation_gate.try_lock().is_ok());
            clock.store(new_output, Ordering::SeqCst);
            SessionStateStore { inner }.ingest(SESSION, Evidence::last_output(new_output, 1, OutputOrigin::Pty));
        }
        normal_wait(plan)
    });
    let task = tokio::spawn(f.store.quiet_worker_task(wait).unwrap());
    driver.next_at(new_output).await;
    assert!(fired.load(Ordering::SeqCst));
    assert_eq!(f.token(SESSION).unwrap().output_at, new_output);
    let (subscription, _) = f.feed.subscribe();
    driver.advance(&f, OUTPUT + QUIET_AFTER_MS).await;
    assert_eq!(subscription.pending_len(), 0);
    stopped(&f.store, task).await;
}

#[tokio::test]
async fn protected_attention_has_no_deadline_or_reader_watch_and_is_not_cleared_by_time() {
    let f = Fixture::new();
    for kind in [AttentionKind::Input, AttentionKind::Approval, AttentionKind::Error, AttentionKind::RateLimited, AttentionKind::Done] {
        let id = format!("{kind:?}");
        f.streaming(&id);
        f.store.ingest(&id, attention(OUTPUT + 1, kind));
        f.observe(&id, 1, Some(OUTPUT + 60_001));
        assert_eq!(f.token(&id), None);
    }
    let before = f.store.snapshot(None);
    let (subscription, _) = f.feed.subscribe();
    f.reader.reads.store(0, Ordering::SeqCst);
    let mut driver = ManualWait::new();
    let task = driver.start(&f.store);
    assert_eq!(driver.next().await.delay, None);
    assert_eq!(driver.advance(&f, OUTPUT + 120_000).await.delay, None);
    assert_eq!(subscription.pending_len(), 0);
    let after = f.store.snapshot(None);
    assert_eq!(serde_json::to_value(after).unwrap(), serde_json::to_value(before).unwrap());
    assert_eq!(f.reader.reads.load(Ordering::SeqCst), 0);
    stopped(&f.store, task).await;
}

#[tokio::test]
async fn attention_that_wins_before_an_obsolete_expiry_wake_stays_protected() {
    let f = Fixture::new();
    f.streaming(SESSION);
    let (subscription, _) = f.feed.subscribe();
    let mut driver = ManualWait::new();
    let task = driver.start(&f.store);
    driver.next().await;
    f.at(OUTPUT + QUIET_AFTER_MS);
    f.store.ingest(SESSION, attention(OUTPUT + QUIET_AFTER_MS, AttentionKind::Approval));
    let waiting = changed(&subscription).await;
    assert_eq!(waiting.status.ui_state, UiSessionState::Waiting);
    assert_eq!(driver.next().await.delay, None);
    driver.advance(&f, OUTPUT + QUIET_AFTER_MS + 1).await;
    assert_eq!(subscription.pending_len(), 0);
    assert_eq!(f.token(SESSION), None);
    assert_eq!(f.store.current_view(SESSION).unwrap().attention.kind, AttentionKind::Approval);
    stopped(&f.store, task).await;
}

#[tokio::test]
async fn missing_and_mismatched_observations_cannot_change_lifecycle_or_reuse_an_exited_epoch() {
    let f = Fixture::new();
    f.streaming(SESSION);
    let (subscription, _) = f.feed.subscribe();
    let mut driver = ManualWait::new();
    let task = driver.start(&f.store);
    driver.next().await;
    let due = OUTPUT + QUIET_AFTER_MS;
    f.observe(SESSION, 2, Some(due));
    driver.advance(&f, due).await;
    let idle = changed(&subscription).await;
    assert_eq!(idle.status.ui_state, UiSessionState::Idle);
    assert_eq!(f.store.current_view(SESSION).unwrap().last_output_at, OUTPUT);
    f.at(due + 1);
    f.store.ingest(SESSION, Evidence::socket_lifecycle(due + 1, 1, Lifecycle::Exited));
    assert_eq!(driver.next_at(due + 1).await.delay, None);
    let exited = changed(&subscription).await;
    f.observe(SESSION, 1, Some(due + 2));
    driver.advance(&f, due + 2).await;
    assert_eq!(subscription.pending_len(), 0);
    assert_eq!(f.store.current_view(SESSION).unwrap().lifecycle, Lifecycle::Exited);
    f.at(due + 3);
    f.store.ingest(SESSION, Evidence::monitor_status(due + 3, 2, MonitorStatus::Working, None));
    let recreated = changed(&subscription).await;
    assert!(recreated.session_revision > exited.session_revision);
    assert_eq!(f.store.current_view(SESSION).unwrap().last_output_at, 0);
    // No-output Working has no deadline/watch, including the old epoch's byte.
    assert_eq!(f.token(SESSION), None);
    let plan = driver.advance(&f, due + 4).await;
    assert_eq!(plan.delay, None);
    f.observe(SESSION, 2, None);
    f.at(due + 5);
    f.store.ingest(SESSION, Evidence::last_output(due + 5, 2, OutputOrigin::Pty));
    driver.next_at(due + 5).await;
    let output = changed(&subscription).await;
    assert_eq!(output.status.ui_state, UiSessionState::Working);
    assert_eq!(f.token(SESSION).unwrap().epoch, 2);
    driver.advance(&f, due + 5 + QUIET_AFTER_MS).await;
    let later = changed(&subscription).await;
    assert_eq!(later.status.ui_state, UiSessionState::Idle);
    assert!(later.seq > recreated.seq);
    assert_eq!(f.store.current_view(SESSION).unwrap().lifecycle, Lifecycle::Alive);
    stopped(&f.store, task).await;
}

#[tokio::test]
async fn unknown_and_never_output_records_do_not_add_periodic_wakes() {
    let f = Fixture::new();
    f.store.ingest("no-output", Evidence::monitor_status(OUTPUT, 1, MonitorStatus::Working, None));
    f.streaming("unknown");
    f.store.ingest("unknown", Evidence::monitor_status(OUTPUT + 1, 1, MonitorStatus::Unknown, None));
    let before = f.store.snapshot(None);
    let (subscription, _) = f.feed.subscribe();
    let mut driver = ManualWait::new();
    let task = driver.start(&f.store);
    assert_eq!(driver.next().await.delay, None);
    assert_eq!(driver.advance(&f, OUTPUT + 120_000).await.delay, None);
    assert_eq!(subscription.pending_len(), 0);
    assert_eq!(serde_json::to_value(f.store.snapshot(None)).unwrap(), serde_json::to_value(before).unwrap());
    stopped(&f.store, task).await;
}

#[tokio::test]
async fn unreadable_and_backwards_clocks_after_idle_rearm_conservatively_without_busy_waits() {
    let f = Fixture::new();
    f.streaming(SESSION);
    let (subscription, _) = f.feed.subscribe();
    let mut driver = ManualWait::new();
    let task = driver.start(&f.store);
    driver.next().await;
    driver.advance(&f, OUTPUT + QUIET_AFTER_MS).await;
    let idle = changed(&subscription).await;
    assert_eq!(driver.advance(&f, 0).await.delay, Some(FRESHNESS_WAIT));
    let working = changed(&subscription).await;
    assert_eq!(working.status.ui_state, UiSessionState::Working);
    assert_eq!(working.session_revision, idle.session_revision + 1);
    assert!(f.token(SESSION).unwrap().armed);
    assert_eq!(driver.advance(&f, OUTPUT - 1).await.delay, Some(FRESHNESS_WAIT));
    assert_eq!(subscription.pending_len(), 0);
    assert_eq!(driver.advance(&f, OUTPUT + QUIET_AFTER_MS - 1).await.delay, Some(Duration::from_millis(1)));
    driver.advance(&f, OUTPUT + QUIET_AFTER_MS).await;
    let idle_again = changed(&subscription).await;
    assert_eq!(idle_again.session_revision, working.session_revision + 1);
    assert_eq!(idle_again.seq, working.seq + 1);
    stopped(&f.store, task).await;
}

#[tokio::test]
async fn checked_deadline_overflow_retains_working_and_a_bounded_freshness_watch() {
    let f = Fixture::new();
    let output = u64::MAX - 10;
    f.at(output);
    f.store.ingest(SESSION, Evidence::last_output(output, 1, OutputOrigin::Pty));
    let token = f.token(SESSION).unwrap();
    assert_eq!(token.due_at, None);
    assert!(!token.armed);
    let (subscription, _) = f.feed.subscribe();
    let mut driver = ManualWait::new();
    let task = driver.start(&f.store);
    assert_eq!(driver.next().await.delay, Some(FRESHNESS_WAIT));
    assert_eq!(driver.advance(&f, u64::MAX).await.delay, Some(FRESHNESS_WAIT));
    assert_eq!(subscription.pending_len(), 0);
    assert_eq!(f.store.current_projection(SESSION).unwrap().ui_state, UiSessionState::Working);
    stopped(&f.store, task).await;
}

#[tokio::test]
async fn elapsed_deadlines_are_disarmed_and_one_thousand_wakes_never_repeat_idle_or_spin() {
    let f = Fixture::new();
    f.streaming(SESSION);
    let (subscription, _) = f.feed.subscribe();
    let mut driver = ManualWait::new();
    let task = driver.start(&f.store);
    driver.next().await;
    let due = OUTPUT + QUIET_AFTER_MS;
    driver.advance(&f, due).await;
    let idle = changed(&subscription).await;
    let before = f.token(SESSION).unwrap();
    f.clock_reads.store(0, Ordering::SeqCst);
    for n in 1..=1_000 {
        let plan = driver.advance(&f, due + n * 1_000).await;
        assert_eq!(plan.delay, Some(FRESHNESS_WAIT));
        assert_eq!(plan.eligible_sessions, 1);
        assert_eq!(f.token(SESSION), Some(before));
    }
    assert_eq!(f.clock_reads.load(Ordering::SeqCst), 1_000);
    assert_eq!(subscription.pending_len(), 0);
    assert_eq!(f.store.current_view(SESSION).unwrap().session_revision, idle.session_revision);
    stopped(&f.store, task).await;
}

#[tokio::test]
async fn start_is_idempotent_and_dropping_one_clone_does_not_cancel_the_worker() {
    let f = Fixture::new();
    f.streaming(SESSION);
    let (subscription, _) = f.feed.subscribe();
    let clone = f.store.clone();
    let mut driver = ManualWait::new();
    let task = driver.start(&f.store);
    driver.next().await;
    assert!(f.store.quiet_worker_task(driver.waiter()).is_none());
    assert!(!f.store.start_quiet_worker());
    drop(clone);
    assert!(!f.store.inner.quiet_worker.stopped.load(Ordering::Acquire));
    driver.advance(&f, OUTPUT + QUIET_AFTER_MS).await;
    assert_eq!(changed(&subscription).await.status.ui_state, UiSessionState::Idle);
    stopped(&f.store, task).await;
    assert!(!f.store.start_quiet_worker(), "shutdown is terminal for this runtime owner");
}

#[tokio::test]
async fn last_owner_drop_cancels_an_untimed_wait_and_neither_store_nor_reader_is_retained() {
    let store = SessionStateStore::with_clock(Arc::new(|| OUTPUT));
    let owner = Arc::downgrade(&store.inner);
    let reader = Arc::new(Reader::default());
    let weak_reader = Arc::downgrade(&reader);
    let observed = weak_reader.clone();
    store.set_observation_provider(Arc::new(move |id| {
        let reader = observed.upgrade()?;
        let observation = reader.values.lock().unwrap().get(id).copied();
        observation
    }));
    let mut driver = ManualWait::new();
    let task = driver.start(&store);
    assert_eq!(driver.next().await.delay, None);
    drop(reader);
    assert!(weak_reader.upgrade().is_none());
    let clone = store.clone();
    drop(store);
    assert!(owner.upgrade().is_some());
    drop(clone);
    assert!(owner.upgrade().is_none(), "driver only retains a Weak across its wait");
    tokio::time::timeout(Duration::from_secs(5), task).await.unwrap().unwrap();
}

#[tokio::test]
async fn explicit_runtime_shutdown_cancels_timed_and_untimed_waits_without_a_late_publication() {
    for timed in [false, true] {
        let f = Fixture::new();
        if timed {
            f.streaming(SESSION);
        }
        let (subscription, _) = f.feed.subscribe();
        let mut driver = ManualWait::new();
        let task = driver.start(&f.store);
        driver.next().await;
        stopped(&f.store, task).await;
        f.at(OUTPUT + QUIET_AFTER_MS);
        driver.tick.notify_one();
        assert_eq!(subscription.pending_len(), 0);
        assert!(f.store.quiet_worker_pass().is_none());
        assert!(!f.store.start_quiet_worker());
    }
}

#[tokio::test]
async fn output_that_wins_the_gate_before_an_old_wake_cannot_emit_idle() {
    let f = Fixture::new();
    f.streaming(SESSION);
    let (subscription, _) = f.feed.subscribe();
    let mut driver = ManualWait::new();
    let task = driver.start(&f.store);
    driver.next().await;
    let boundary = OUTPUT + QUIET_AFTER_MS;
    f.at(boundary);
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let producer_barrier = barrier.clone();
    let producer_store = f.store.clone();
    let producer = std::thread::spawn(move || {
        producer_store.ingest(SESSION, Evidence::last_output(boundary, 1, OutputOrigin::Pty));
        producer_barrier.wait();
    });
    barrier.wait();
    producer.join().unwrap();
    driver.next_at(boundary).await;
    driver.advance(&f, boundary + 1).await;
    assert_eq!(subscription.pending_len(), 0);
    assert_eq!(f.token(SESSION).unwrap().output_at, boundary);
    stopped(&f.store, task).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn expiry_that_wins_the_gate_publishes_idle_then_output_with_distinct_revisions_and_sequences() {
    let f = Fixture::new();
    f.streaming(SESSION);
    let (subscription, initial) = f.feed.subscribe();
    let (entered, entry) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    let released = Mutex::new(released);
    let listener = f.feed.change_listener();
    f.store.set_change_listener(Arc::new(move |projected| {
        if projected.ui_state == UiSessionState::Idle {
            entered.send(()).unwrap();
            released.lock().unwrap().recv_timeout(Duration::from_secs(5)).unwrap();
        }
        listener(projected);
    }));
    let mut driver = ManualWait::new();
    let task = driver.start(&f.store);
    driver.next().await;
    let boundary = OUTPUT + QUIET_AFTER_MS;
    f.at(boundary);
    driver.tick.notify_one();
    entry.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(f.store.inner.operation_gate.try_lock().is_err());
    let producer_store = f.store.clone();
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let producer_barrier = barrier.clone();
    f.at(boundary + 1);
    let producer = std::thread::spawn(move || {
        producer_barrier.wait();
        producer_store.ingest(SESSION, Evidence::last_output(boundary + 1, 1, OutputOrigin::Pty));
    });
    barrier.wait();
    assert_eq!(subscription.pending_len(), 0, "publication is still held by the winning expiry");
    release.send(()).unwrap();
    producer.join().unwrap();
    driver.next_at(boundary + 1).await;
    let idle = changed(&subscription).await;
    let working = changed(&subscription).await;
    assert_eq!(idle.status.ui_state, UiSessionState::Idle);
    assert_eq!(working.status.ui_state, UiSessionState::Working);
    assert_eq!(idle.seq, initial.snapshot.seq + 1);
    assert_eq!(working.seq, idle.seq + 1);
    assert_eq!(working.session_revision, idle.session_revision + 1);
    stopped(&f.store, task).await;
}

#[test]
#[ignore = "commander-run worker-pass estimate; no latency assertion"]
fn quiet_worker_pass_load_probe() {
    for subscribers in [0, 8] {
        let f = Fixture::new();
        for n in 0..64 {
            f.streaming(&format!("session-{n}"));
        }
        let subscriptions: Vec<_> = (0..subscribers).map(|_| f.feed.subscribe().0).collect();
        f.at(OUTPUT + QUIET_AFTER_MS);
        // Settle one expiry publication per session before measuring steady
        // freshness passes. This is not async scheduling or contended latency.
        f.store.quiet_worker_pass().unwrap();
        let mut elapsed = Vec::with_capacity(1_000);
        let reads = f.reader.reads.load(Ordering::SeqCst);
        for _ in 0..1_000 {
            let start = std::time::Instant::now();
            let plan = f.store.quiet_worker_pass().unwrap();
            elapsed.push(start.elapsed().as_nanos() as u64);
            assert_eq!(plan.eligible_sessions, 64);
            assert_eq!(plan.delay, Some(FRESHNESS_WAIT));
        }
        assert_eq!(f.reader.reads.load(Ordering::SeqCst) - reads, 64_000);
        elapsed.sort_unstable();
        println!("WORKER_LOAD {}", serde_json::json!({
            "measurement": "uncontended settled quiet worker pass with a mutex-backed fake observation provider",
            "sessions": 64, "subscribers": subscribers, "samples": elapsed.len(),
            "median_ns": elapsed[elapsed.len() / 2],
            "p95_ns": elapsed[(elapsed.len() * 95 / 100) - 1],
            "max_ns": elapsed.last().unwrap(),
            "includes_expiry_publication": false, "includes_webview_emit": false,
            "private_token_bytes_per_record": std::mem::size_of::<Option<QuietDeadline>>(),
            "latency_assertion": false, "scheduled_wakes_per_hour": 3_600,
        }));
        drop(subscriptions);
    }
}
