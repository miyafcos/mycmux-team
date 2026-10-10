use super::*;
use crate::session_state::{
    derive_ui_state_at, reduce, Evidence, Lifecycle, MonitorStatus, OutputOrigin, QUIET_AFTER_MS,
};

const START: u64 = 1_000_000;
const OUTPUT: u64 = START + 100;
const SESSION: &str = "quiet-session";

struct Fixture {
    clock: Arc<AtomicU64>,
    store: SessionStateStore,
    feed: StatusFeed,
}

impl Fixture {
    fn new(capacity: usize) -> Self {
        let clock = Arc::new(AtomicU64::new(START));
        let read_clock = clock.clone();
        let store = SessionStateStore::with_clock(Arc::new(move || read_clock.load(Ordering::SeqCst)));
        let feed = StatusFeed::with_capacity(store.clone(), capacity);
        store.set_change_listener(feed.change_listener());
        Self { clock, store, feed }
    }

    fn at(&self, now: u64) {
        self.clock.store(now, Ordering::SeqCst);
    }

    fn streaming(&self) -> SessionView {
        self.store.ingest(SESSION, Evidence::monitor_status(START, 1, MonitorStatus::Idle, None));
        self.at(OUTPUT);
        self.store.ingest(SESSION, Evidence::last_output(OUTPUT, 1, OutputOrigin::Pty))
    }
}

async fn changed(subscription: &StatusSubscription) -> StatusChangedEvent {
    assert!(subscription.pending_len() > 0, "expected an already-published delta");
    let StatusEvent::Changed(delta) = subscription.recv().await.expect("live subscription") else {
        panic!("expected status.changed");
    };
    delta
}

#[tokio::test]
async fn quiet_snapshot_publishes_one_delta_at_the_exact_boundary_and_keeps_raw_evidence() {
    for running_silent in [false, true] {
        let f = Fixture::new(8);
        f.streaming();
        if running_silent {
            f.at(OUTPUT + 10_000);
            f.store.ingest(SESSION, Evidence::monitor_status(OUTPUT + 10_000, 1, MonitorStatus::Working, None));
        }
        let before = f.store.snapshot(None).sessions.remove(0);
        let (subscription, initial) = f.feed.subscribe();
        f.at(OUTPUT + QUIET_AFTER_MS - 1);
        let early = f.feed.frontend_snapshot();
        assert_eq!(early.sessions[0].status.ui_state, UiSessionState::Working);
        assert_eq!(early.seq, initial.snapshot.seq);
        assert_eq!(subscription.pending_len(), 0);

        f.at(OUTPUT + QUIET_AFTER_MS);
        let due = f.feed.frontend_snapshot();
        let delta = changed(&subscription).await;
        assert_eq!(delta.status.ui_state, UiSessionState::Idle);
        assert_eq!(delta.seq, initial.snapshot.seq + 1);
        assert_eq!(delta.session_revision, before.view.session_revision + 1);
        assert_eq!(due.seq, delta.seq);
        assert_eq!(due.sessions[0].status, delta.status);
        let after = f.store.snapshot(None).sessions.remove(0);
        assert_eq!(FeedSession::from(&after), due.sessions[0]);
        assert_eq!(after.recent_evidence, before.recent_evidence);
        let mut expected_raw = before.view.clone();
        expected_raw.session_revision += 1;
        assert_eq!(after.view, expected_raw);

        f.at(OUTPUT + 120_000);
        let later = f.feed.frontend_snapshot();
        assert_eq!(later, due);
        assert_eq!(subscription.pending_len(), 0);
    }
}

#[tokio::test]
async fn a_new_subscription_cannot_swallow_an_existing_subscribers_quiet_delta() {
    let f = Fixture::new(8);
    f.streaming();
    let (existing, initial) = f.feed.subscribe();
    f.at(OUTPUT + QUIET_AFTER_MS);
    let (newcomer, snapshot) = f.feed.subscribe();
    let idle = changed(&existing).await;
    assert_eq!(idle.seq, initial.snapshot.seq + 1);
    assert_eq!(snapshot.snapshot.seq, idle.seq);
    assert_eq!(snapshot.snapshot.sessions[0].session_revision, idle.session_revision);
    assert_eq!(snapshot.snapshot.sessions[0].status, idle.status);
    assert_eq!(newcomer.pending_len(), 0);
}

#[tokio::test]
async fn resnapshot_and_periodic_snapshot_publish_due_changes_before_resetting_their_queue() {
    for periodic in [false, true] {
        let f = Fixture::new(8);
        f.streaming();
        let (requesting, initial) = f.feed.subscribe();
        let (peer, _) = f.feed.subscribe();
        f.at(OUTPUT + QUIET_AFTER_MS);
        let snapshot = if periodic {
            f.feed.periodic_snapshot(&requesting).snapshot
        } else {
            f.feed.resnapshot(&requesting)
        };
        let idle = changed(&peer).await;
        assert_eq!(snapshot.seq, initial.snapshot.seq + 1);
        assert_eq!(snapshot.seq, idle.seq);
        assert_eq!(snapshot.sessions[0].status, idle.status);
        assert_eq!(requesting.pending_len(), 0);
        f.at(OUTPUT + QUIET_AFTER_MS + 1);
        f.store.ingest(SESSION, Evidence::last_output(OUTPUT + QUIET_AFTER_MS + 1, 1, OutputOrigin::Pty));
        let resumed = changed(&requesting).await;
        assert_eq!(resumed.seq, snapshot.seq + 1);
        assert_eq!(resumed.status.ui_state, UiSessionState::Working);
    }
}

#[tokio::test]
async fn timestamp_only_output_after_projected_idle_gets_a_new_revision_and_delta() {
    let f = Fixture::new(8);
    f.streaming();
    let (subscription, _) = f.feed.subscribe();
    f.at(OUTPUT + QUIET_AFTER_MS);
    let idle = f.feed.frontend_snapshot();
    let _ = changed(&subscription).await;
    let previous = f.store.current_view(SESSION).unwrap();
    let evidence = Evidence::last_output(OUTPUT + QUIET_AFTER_MS + 1, 1, OutputOrigin::Pty);
    assert_eq!(reduce(&previous, &evidence).session_revision, previous.session_revision);
    f.at(evidence.observed_at);
    let resumed = f.store.ingest(SESSION, evidence);
    let delta = changed(&subscription).await;
    assert_eq!(resumed.session_revision, previous.session_revision + 1);
    assert_eq!(delta.session_revision, resumed.session_revision);
    assert_eq!(delta.seq, idle.seq + 1);
    assert_eq!(delta.status.ui_state, UiSessionState::Working);
    assert_eq!(f.feed.frontend_snapshot().sessions[0].status, delta.status);
}

#[tokio::test]
async fn timestamp_only_output_extends_silence_without_publishing_an_extra_working_delta() {
    let f = Fixture::new(8);
    let initial_view = f.streaming();
    let (subscription, initial) = f.feed.subscribe();
    let newer_output = OUTPUT + 30_000;
    f.at(newer_output);
    let view = f.store.ingest(SESSION, Evidence::last_output(newer_output, 1, OutputOrigin::Pty));
    assert_eq!(view.session_revision, initial_view.session_revision);
    assert_eq!(subscription.pending_len(), 0);
    f.at(OUTPUT + QUIET_AFTER_MS);
    assert_eq!(f.feed.frontend_snapshot().sessions[0].status.ui_state, UiSessionState::Working);
    assert_eq!(subscription.pending_len(), 0);
    f.at(newer_output + QUIET_AFTER_MS - 1);
    assert_eq!(f.feed.frontend_snapshot().seq, initial.snapshot.seq);
    f.at(newer_output + QUIET_AFTER_MS);
    let snapshot = f.feed.frontend_snapshot();
    let idle = changed(&subscription).await;
    assert_eq!(idle.seq, initial.snapshot.seq + 1);
    assert_eq!(snapshot.sessions[0].status.last_output_at, newer_output);
    assert_eq!(snapshot.sessions[0].status.ui_state, UiSessionState::Idle);
}

#[tokio::test]
async fn evidence_and_projection_changes_are_one_revision_and_one_publication() {
    let f = Fixture::new(8);
    f.streaming();
    f.at(OUTPUT + 10_000);
    f.store.ingest(SESSION, Evidence::monitor_status(OUTPUT + 10_000, 1, MonitorStatus::Working, None));
    let (subscription, _) = f.feed.subscribe();
    f.at(OUTPUT + QUIET_AFTER_MS);
    f.feed.frontend_snapshot();
    let idle = changed(&subscription).await;
    assert_eq!(idle.status.activity, Activity::RunningSilent);
    f.at(OUTPUT + QUIET_AFTER_MS + 1);
    let resumed = f.store.ingest(SESSION, Evidence::last_output(OUTPUT + QUIET_AFTER_MS + 1, 1, OutputOrigin::Pty));
    let working = changed(&subscription).await;
    assert_eq!(resumed.session_revision, idle.session_revision + 1);
    assert_eq!(working.seq, idle.seq + 1);
    assert_eq!(working.status.activity, Activity::Streaming);
    assert_eq!(working.status.ui_state, UiSessionState::Working);
    assert_eq!(subscription.pending_len(), 0);
}

#[tokio::test]
async fn rejected_output_does_not_extend_the_quiet_boundary() {
    let f = Fixture::new(8);
    let before = f.streaming();
    let (subscription, _) = f.feed.subscribe();
    f.at(OUTPUT + 10_000);
    for evidence in [
        Evidence::last_output(OUTPUT + 10_000, 1, OutputOrigin::Replay),
        Evidence::last_output(OUTPUT + 10_000, 1, OutputOrigin::Internal),
        Evidence::last_output(OUTPUT, 1, OutputOrigin::Pty),
        Evidence::last_output(START, 1, OutputOrigin::Pty),
        Evidence::last_output(OUTPUT + 10_000, 0, OutputOrigin::Pty),
    ] {
        assert_eq!(f.store.ingest(SESSION, evidence), before);
    }
    assert_eq!(subscription.pending_len(), 0);
    f.at(OUTPUT + QUIET_AFTER_MS);
    f.feed.frontend_snapshot();
    assert_eq!(changed(&subscription).await.status.ui_state, UiSessionState::Idle);
}

#[tokio::test]
async fn duplicate_evidence_still_reconciles_time_without_adding_ledger_evidence() {
    let f = Fixture::new(8);
    f.streaming();
    let (subscription, _) = f.feed.subscribe();
    let before = f.store.snapshot(None).sessions.remove(0);
    f.at(OUTPUT + QUIET_AFTER_MS);
    let view = f.store.ingest(SESSION, Evidence::last_output(OUTPUT, 1, OutputOrigin::Pty));
    let idle = changed(&subscription).await;
    assert_eq!(view.session_revision, before.view.session_revision + 1);
    assert_eq!(idle.status.ui_state, UiSessionState::Idle);
    assert_eq!(f.store.snapshot(None).sessions[0].recent_evidence, before.recent_evidence);
}

#[tokio::test]
async fn backwards_or_unreadable_clock_after_idle_restores_working_conservatively() {
    for backwards in [0, START - 1, OUTPUT + QUIET_AFTER_MS - 1] {
        let f = Fixture::new(8);
        f.streaming();
        let before = f.store.snapshot(None).sessions.remove(0);
        let (subscription, _) = f.feed.subscribe();
        f.at(OUTPUT + QUIET_AFTER_MS);
        f.feed.frontend_snapshot();
        let idle = changed(&subscription).await;
        f.at(backwards);
        let snapshot = f.feed.frontend_snapshot();
        let conservative = changed(&subscription).await;
        assert_eq!(conservative.seq, idle.seq + 1);
        assert_eq!(conservative.session_revision, idle.session_revision + 1);
        assert_eq!(conservative.status.ui_state, UiSessionState::Working);
        assert_eq!(snapshot.sessions[0].status, conservative.status);
        f.at(OUTPUT + QUIET_AFTER_MS);
        f.feed.frontend_snapshot();
        let expired_again = changed(&subscription).await;
        assert_eq!(expired_again.seq, conservative.seq + 1);
        assert_eq!(expired_again.status.ui_state, UiSessionState::Idle);
        assert_eq!(f.store.snapshot(None).sessions[0].recent_evidence, before.recent_evidence);
    }
}

#[tokio::test]
async fn exit_and_new_epoch_never_reuse_old_output_or_regress_revision() {
    let f = Fixture::new(8);
    f.streaming();
    let (subscription, _) = f.feed.subscribe();
    f.at(OUTPUT + 1);
    let exit = f.store.ingest(SESSION, Evidence::socket_lifecycle(OUTPUT + 1, 1, Lifecycle::Exited));
    let _ = changed(&subscription).await;
    f.at(OUTPUT + QUIET_AFTER_MS);
    assert_eq!(f.feed.frontend_snapshot().sessions[0].status.lifecycle, Lifecycle::Exited);
    assert_eq!(subscription.pending_len(), 0);
    assert_eq!(f.store.ingest(SESSION, Evidence::last_output(OUTPUT + QUIET_AFTER_MS, 1, OutputOrigin::Pty)), exit);
    let recreated = f.store.ingest(SESSION, Evidence::socket_lifecycle(OUTPUT + QUIET_AFTER_MS, 2, Lifecycle::Alive));
    assert_eq!(recreated.session_revision, exit.session_revision + 1);
    assert_eq!(recreated.last_output_at, 0);
    assert_eq!(changed(&subscription).await.status.ui_state, UiSessionState::Unknown);
    assert_eq!(f.store.ingest(SESSION, Evidence::last_output(OUTPUT + QUIET_AFTER_MS + 1, 1, OutputOrigin::Pty)), recreated);
    f.at(OUTPUT + QUIET_AFTER_MS + 2);
    let current = f.store.ingest(SESSION, Evidence::last_output(OUTPUT + QUIET_AFTER_MS + 2, 2, OutputOrigin::Pty));
    assert_eq!(current.session_revision, recreated.session_revision + 1);
    assert_eq!(changed(&subscription).await.status.ui_state, UiSessionState::Working);
}

#[tokio::test]
async fn quiet_overflow_requires_resync_and_snapshot_restores_the_same_state_and_sequence() {
    let f = Fixture::new(1);
    f.streaming();
    f.store.ingest("other", Evidence::last_output(OUTPUT, 1, OutputOrigin::Pty));
    let (subscription, initial) = f.feed.subscribe();
    f.at(OUTPUT + QUIET_AFTER_MS);
    let snapshot = f.feed.frontend_snapshot();
    let StatusEvent::ResyncRequired(resync) = subscription.recv().await.unwrap() else {
        panic!("expected overflow resync");
    };
    assert_eq!(resync.seq, initial.snapshot.seq + 2);
    assert_eq!(snapshot.seq, resync.seq);
    assert!(snapshot.sessions.iter().all(|session| session.status.ui_state == UiSessionState::Idle));
    assert_eq!(f.feed.resnapshot(&subscription), snapshot);
    f.at(OUTPUT + QUIET_AFTER_MS + 1);
    f.store.ingest(SESSION, Evidence::last_output(OUTPUT + QUIET_AFTER_MS + 1, 1, OutputOrigin::Pty));
    assert_eq!(changed(&subscription).await.seq, snapshot.seq + 1);
}

#[tokio::test]
async fn serialization_uses_the_captured_clock_even_if_the_listener_changes_it() {
    let f = Fixture::new(8);
    f.streaming();
    f.store.ingest("other", Evidence::last_output(OUTPUT, 1, OutputOrigin::Pty));
    let (subscription, initial) = f.feed.subscribe();
    let listener = f.feed.change_listener();
    let clock = f.clock.clone();
    f.store.set_change_listener(Arc::new(move |projected| {
        clock.store(0, Ordering::SeqCst);
        listener(projected);
    }));
    f.at(OUTPUT + QUIET_AFTER_MS);
    let snapshot = f.feed.frontend_snapshot();
    assert_eq!(snapshot.seq, initial.snapshot.seq + 2);
    for _ in 0..2 {
        let delta = changed(&subscription).await;
        assert_eq!(delta.status.ui_state, UiSessionState::Idle);
        let raw = f.store.current_view(&delta.session_id).unwrap();
        assert_eq!(derive_ui_state_at(&raw, 0), UiSessionState::Working);
    }
    assert!(snapshot.sessions.iter().all(|session| session.status.ui_state == UiSessionState::Idle));
}

#[test]
fn a_snapshot_samples_the_clock_once_for_all_records() {
    let reads = Arc::new(AtomicU64::new(0));
    let now = Arc::new(AtomicU64::new(OUTPUT));
    let read_now = now.clone();
    let read_count = reads.clone();
    let store = SessionStateStore::with_clock(Arc::new(move || {
        read_now.load(Ordering::SeqCst) + read_count.fetch_add(1, Ordering::SeqCst)
    }));
    for id in ["a", "b", "c"] {
        store.ingest(id, Evidence::last_output(OUTPUT, 1, OutputOrigin::Pty));
    }
    now.store(OUTPUT + QUIET_AFTER_MS - 1, Ordering::SeqCst);
    reads.store(0, Ordering::SeqCst);
    let feed = StatusFeed::new(store.clone());
    store.set_change_listener(feed.change_listener());
    let snapshot = feed.frontend_snapshot();
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    assert!(snapshot.sessions.iter().all(|session| session.status.ui_state == UiSessionState::Working));
    let due = feed.frontend_snapshot();
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    assert!(due.sessions.iter().all(|session| session.status.ui_state == UiSessionState::Idle));
    assert_eq!(due.seq, 3);
}

#[tokio::test]
#[ignore = "commander-run load estimate; no latency assertion"]
async fn projection_gate_load_probe() {
    for subscriber_count in [0, 8] {
        let f = Fixture::new(64);
        for index in 0..64 {
            f.store.ingest(format!("load-{index}"), Evidence::monitor_status(START, 1, MonitorStatus::Idle, None));
        }
        let subscriptions: Vec<_> = (0..subscriber_count).map(|_| f.feed.subscribe().0).collect();
        let mut samples = Vec::with_capacity(1_000);
        for index in 0..1_000 {
            let status = if index % 2 == 0 { MonitorStatus::Working } else { MonitorStatus::Idle };
            let evidence = Evidence::monitor_status(START + index + 1, 1, status, None);
            let started = std::time::Instant::now();
            f.store.ingest("load-0", evidence);
            samples.push(started.elapsed().as_nanos());
            // Drain outside the measured operation so the estimate includes
            // actual bounded-queue publication, not repeated overflow only.
            for subscription in &subscriptions {
                let _ = changed(subscription).await;
            }
        }
        samples.sort_unstable();
        println!("GATE_LOAD {}", serde_json::json!({
            "sessions": 64,
            "subscribers": subscriber_count,
            "samples": samples.len(),
            "median_ns": samples[500],
            "p95_ns": samples[950],
            "max_ns": samples[999],
            "measurement": "uncontended ingest elapsed, including synchronous publication",
            "app_handle_installed": false,
            "includes_webview_emit": false,
            "latency_assertion": false,
        }));
    }
}
