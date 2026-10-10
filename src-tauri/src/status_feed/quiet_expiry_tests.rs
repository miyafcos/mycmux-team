use super::{SessionStatus, StatusFeed};
use crate::session_state::{
    derive_ui_state_at, Activity, AttentionKind, Evidence, EvidenceSignal, EvidenceSource,
    Lifecycle, MonitorStatus, OutputOrigin, SessionStateStore, SessionView, UiSessionState,
    QUIET_AFTER_MS,
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

const START: u64 = 1_000_000;
const EPOCH: u64 = 1;
const SESSION: &str = "quiet-session";

struct Case {
    clock: Arc<AtomicU64>,
    store: SessionStateStore,
    feed: StatusFeed,
}

impl Case {
    fn new() -> Self {
        let clock = Arc::new(AtomicU64::new(START));
        let read_clock = clock.clone();
        let store = SessionStateStore::with_clock(Arc::new(move || read_clock.load(Ordering::SeqCst)));
        let feed = StatusFeed::new(store.clone());
        store.set_change_listener(feed.change_listener());
        Self { clock, store, feed }
    }

    fn ingest(&self, evidence: Evidence) -> SessionView {
        self.clock.store(evidence.observed_at, Ordering::SeqCst);
        self.store.ingest(SESSION, evidence)
    }

    fn view(&self) -> SessionView {
        self.store.current_view(SESSION).expect("canonical record")
    }

    // B1's red patch used the timeless conversion because no clock seam
    // existed. Now read the actual store/feed with an injected clock; neither
    // the test nor the serializer supplies a fabricated Idle projection.
    fn status_at(&self, now: u64) -> SessionStatus {
        self.clock.store(now, Ordering::SeqCst);
        let snapshot = self.feed.frontend_snapshot();
        let status = snapshot.sessions[0].status.clone();
        let view = self.view();
        println!(
            "now={now} last_output={} revision={} raw={:?} projected={:?} feed={:?}",
            view.last_output_at,
            view.session_revision,
            view.activity,
            derive_ui_state_at(&view, now),
            status.ui_state,
        );
        status
    }
}

fn idle() -> Case {
    let case = Case::new();
    case.ingest(Evidence::monitor_status(START, EPOCH, MonitorStatus::Idle, None));
    case
}

fn output_after_idle() -> Case {
    let case = idle();
    case.ingest(Evidence::last_output(START + 100, EPOCH, OutputOrigin::Pty));
    case
}

#[test]
fn quiet_streaming_feed_must_be_idle_at_sixty_seconds() {
    let case = output_after_idle();
    let view = case.view();
    let now = view.last_output_at + QUIET_AFTER_MS;
    assert_eq!(derive_ui_state_at(&view, now), UiSessionState::Idle);
    assert_eq!(case.status_at(now).ui_state, UiSessionState::Idle);
}

#[test]
fn quiet_running_silent_feed_must_be_idle_at_one_hundred_twenty_seconds() {
    let case = output_after_idle();
    let view = case.ingest(Evidence::monitor_status(
        START + 10_000, EPOCH, MonitorStatus::Working, None,
    ));
    assert_eq!(view.activity, Activity::RunningSilent);
    let now = view.last_output_at + 120_000;
    assert_eq!(derive_ui_state_at(&view, now), UiSessionState::Idle);
    assert_eq!(case.status_at(now).ui_state, UiSessionState::Idle);
}

#[test]
fn unchanged_idle_process_supplies_no_additional_evidence_to_repair_streaming() {
    let case = output_after_idle();
    let output_at = case.view().last_output_at;
    // No new monitor evidence when process status stays Idle. Keep the raw
    // evidence while checking the real feed at its actual output deadline.
    for elapsed in [10_000, 60_000, 120_000, 3_600_000, 86_400_000] {
        let expected = if elapsed < QUIET_AFTER_MS {
            UiSessionState::Working
        } else {
            UiSessionState::Idle
        };
        assert_eq!(case.status_at(output_at + elapsed).ui_state, expected);
        assert_eq!(case.view().activity, Activity::Streaming);
    }
    assert_eq!(case.store.snapshot(None).sessions[0].recent_evidence.len(), 2);
}

#[test]
fn output_before_the_first_idle_observation_returns_idle() {
    let case = Case::new();
    case.ingest(Evidence::last_output(START, EPOCH, OutputOrigin::Pty));
    case.ingest(Evidence::monitor_status(START + 1, EPOCH, MonitorStatus::Idle, None));
    assert_eq!(case.status_at(START + 1).ui_state, UiSessionState::Idle);
    let delayed = output_after_idle();
    assert_eq!(delayed.status_at(delayed.view().last_output_at).ui_state, UiSessionState::Working);
}

#[test]
fn the_clock_projection_has_an_exact_sixty_second_boundary() {
    let case = output_after_idle();
    let view = case.view();
    let before = view.last_output_at + QUIET_AFTER_MS - 1;
    assert_eq!(derive_ui_state_at(&view, before), UiSessionState::Working);
    assert_eq!(case.status_at(before).ui_state, UiSessionState::Working);
    for elapsed in [QUIET_AFTER_MS, 120_000, 86_400_000] {
        let now = view.last_output_at + elapsed;
        assert_eq!(derive_ui_state_at(&view, now), UiSessionState::Idle);
        assert_eq!(case.status_at(now).ui_state, UiSessionState::Idle);
    }
}

#[test]
fn a_real_monitor_idle_transition_returns_idle() {
    let case = output_after_idle();
    let view = case.ingest(Evidence::monitor_status(
        START + 20_000, EPOCH, MonitorStatus::Idle, None,
    ));
    assert_eq!(view.activity, Activity::Idle);
    assert_eq!(case.status_at(START + 20_000).ui_state, UiSessionState::Idle);
}

#[test]
fn real_work_done_returns_idle_without_manufacturing_attention() {
    let case = output_after_idle();
    let view = case.ingest(Evidence::work_done(
        START + 20_000, EPOCH, "agent".into(), "shell".into(),
    ));
    assert_eq!(view.activity, Activity::Idle);
    assert_eq!(view.attention.kind, AttentionKind::None);
    assert_eq!(case.status_at(START + 20_000).ui_state, UiSessionState::Idle);
}

#[test]
fn quiet_time_preserves_blocking_attention_and_done() {
    for (kind, expected) in [
        (AttentionKind::Input, UiSessionState::Waiting),
        (AttentionKind::Approval, UiSessionState::Waiting),
        (AttentionKind::Error, UiSessionState::Waiting),
        (AttentionKind::RateLimited, UiSessionState::Waiting),
        (AttentionKind::Done, UiSessionState::Done),
    ] {
        let case = output_after_idle();
        let view = case.ingest(Evidence {
            observed_at: START + 200,
            source: EvidenceSource::Hook,
            session_epoch: Some(EPOCH),
            process: None,
            signal: EvidenceSignal::Hook {
                attention: kind,
                attention_id: Some("protected-attention".into()),
                detail: Some("Keep the semantic evidence".into()),
                confidence: 0.95,
                stale_after: 30_000,
            },
        });
        let status = case.status_at(START + 86_400_000);
        assert_eq!(derive_ui_state_at(&view, START + 86_400_000), expected);
        assert_eq!(status.ui_state, expected);
        assert_eq!(status.attention, view.attention);
    }
}

#[test]
fn internal_replay_duplicate_and_older_output_do_not_extend_activity() {
    for origin in [OutputOrigin::Internal, OutputOrigin::Replay] {
        let case = idle();
        let before = case.view();
        let after = case.ingest(Evidence::last_output(START + 100, EPOCH, origin));
        assert_eq!(after, before);
        assert_eq!(case.status_at(START + 100).ui_state, UiSessionState::Idle);
    }
    let case = output_after_idle();
    let view = case.view();
    for at in [START, view.last_output_at] {
        assert_eq!(case.ingest(Evidence::last_output(at, EPOCH, OutputOrigin::Pty)), view);
    }
}

#[test]
fn unknown_no_output_and_bad_or_backwards_clocks_remain_conservative() {
    let unknown = Case::new();
    unknown.ingest(Evidence::socket_lifecycle(START, EPOCH, Lifecycle::Alive));
    assert_eq!(unknown.status_at(START).ui_state, UiSessionState::Unknown);
    let no_output = Case::new();
    let view = no_output.ingest(Evidence::monitor_status(START, EPOCH, MonitorStatus::Working, None));
    assert_eq!(view.last_output_at, 0);
    assert_eq!(no_output.status_at(START + 86_400_000).ui_state, UiSessionState::Working);
    let case = output_after_idle();
    for now in [0, START - 1, case.view().last_output_at] {
        assert_eq!(case.status_at(now).ui_state, UiSessionState::Working);
    }
}
