//! Review-1 regressions. Fake only clock/owned reader timestamps, never projections.
use super::*;
use crate::session_state::{reduce, Lifecycle, SessionView};
use crate::pty::monitor::{monitor_status_changed, PtyMetadata};
use std::sync::Barrier;

mod base_reducer;

fn attention(at: u64, epoch: u64, kind: AttentionKind, hook: bool) -> Evidence {
    Evidence {
        observed_at: at,
        source: if hook { EvidenceSource::Hook } else { EvidenceSource::ScreenScan },
        session_epoch: Some(epoch),
        process: None,
        signal: if hook {
            EvidenceSignal::Hook { attention: kind, attention_id: None, detail: None, confidence: 0.9, stale_after: 30_000 }
        } else {
            EvidenceSignal::ScreenScan { attention: kind, attention_id: None, detail: None, confidence: 0.9, stale_after: 30_000, complete: true, resync: false }
        },
    }
}

fn capture(f: &Fixture) -> Arc<Mutex<Vec<super::super::super::super::ProjectedSession>>> {
    let captured = Arc::new(Mutex::new(Vec::new()));
    let output = captured.clone();
    let publish = f.feed.change_listener();
    let weak = Arc::downgrade(&f.store.inner);
    f.store.set_change_listener(Arc::new(move |projection| {
        let inner = weak.upgrade().unwrap();
        assert!(matches!(inner.operation_gate.try_lock(), Err(std::sync::TryLockError::WouldBlock)));
        assert!(matches!(inner.sessions.try_get_mut(&projection.view.session_id), dashmap::try_result::TryResult::Present(_)));
        let current = inner.sessions.get(&projection.view.session_id).unwrap().projected();
        assert_eq!(current.view, projection.view);
        assert_eq!(current.ui_state, projection.ui_state);
        output.lock().unwrap().push(projection.clone());
        publish(projection);
    }));
    captured
}

fn freshness_ingestion_case(hook: bool, duplicate: bool, clear: bool) {
    let f = Fixture::new();
    f.streaming(SESSION);
    let due = OUTPUT + QUIET_AFTER_MS;
    if clear {
        f.store.ingest(SESSION, attention(OUTPUT + 1, 1, AttentionKind::Approval, true));
    }
    let event = attention(due, 1, AttentionKind::None, hook);
    if duplicate {
        // Put the exact evidence at the back of the real ledger while the
        // canonical output is still fresh. The repeated delivery changes no evidence.
        f.store.ingest(SESSION, event.clone());
    }
    let (peer, initial) = f.feed.subscribe();
    let captured = capture(&f);
    let weak_store = Arc::downgrade(&f.store.inner);
    let weak_reader = Arc::downgrade(&f.reader);
    f.store.set_observation_provider(Arc::new(move |id| {
        let inner = weak_store.upgrade().unwrap();
        assert!(matches!(inner.operation_gate.try_lock(), Err(std::sync::TryLockError::WouldBlock)));
        assert!(matches!(inner.sessions.try_get_mut(id), dashmap::try_result::TryResult::Present(_)));
        let reader = weak_reader.upgrade().unwrap();
        reader.reads.fetch_add(1, Ordering::SeqCst);
        let observation = reader.values.lock().unwrap().get(id).copied();
        observation
    }));
    f.at(due);
    f.observe(SESSION, 1, Some(due - 1));
    let clock_reads = f.clock_reads.load(Ordering::SeqCst);
    let reader_reads = f.reader.reads.load(Ordering::SeqCst);
    f.store.ingest(SESSION, event);
    assert_eq!(f.clock_reads.load(Ordering::SeqCst) - clock_reads, 1);
    let projections = captured.lock().unwrap().clone();
    assert!(projections.iter().all(|p| p.ui_state != UiSessionState::Idle),
        "QX1: an ordinary ingestion published Idle while same-epoch reader output was 1 ms old: {projections:?}");
    let current = f.store.inner.sessions.get(SESSION).unwrap().projected();
    assert_eq!(current.ui_state, UiSessionState::Working);
    assert_eq!(current.view.attention.kind, AttentionKind::None);
    drop(current);
    assert_eq!(f.reader.reads.load(Ordering::SeqCst) - reader_reads, 1, "ingestion must consult the reader under its own gate");
    let snapshot = f.feed.frontend_snapshot();
    assert_eq!(snapshot.sessions[0].status.ui_state, UiSessionState::Working);
    assert_eq!(snapshot.seq, initial.snapshot.seq + peer.pending_len() as u64);
}

#[test]
fn quiet_review_qx1_screen_scan_reads_fresh_output_before_publication() {
    freshness_ingestion_case(false, false, false);
}

#[test]
fn quiet_review_qx1_hook_reads_fresh_output_before_publication() {
    freshness_ingestion_case(true, false, false);
}

#[test]
fn quiet_review_qx1_duplicate_reads_fresh_output_before_publication() {
    freshness_ingestion_case(false, true, false);
}

#[test]
fn quiet_review_qx1_attention_clear_reads_fresh_output_before_publication() {
    freshness_ingestion_case(true, false, true);
}

fn without_revision(mut view: SessionView) -> SessionView {
    view.session_revision = 0;
    view
}

fn delayed_monitor_case(work_done: bool) {
    let f = Fixture::new();
    f.streaming(SESSION);
    let initial = f.store.current_view(SESSION).unwrap();
    let observed_at = OUTPUT + 100;
    let output_at = OUTPUT + 200;
    let idle = Evidence::monitor_status(observed_at, 1, MonitorStatus::Idle, None);
    let event = if work_done {
        Evidence::work_done(observed_at, 1, "agent".into(), "zsh".into())
    } else { idle.clone() };
    let observed = Arc::new(Barrier::new(2));
    let deliver = Arc::new(Barrier::new(2));
    let monitor_store = f.store.clone();
    let monitor_observed = observed.clone();
    let monitor_deliver = deliver.clone();
    let delayed = event.clone();
    let delayed_idle = idle.clone();
    let producer = std::thread::spawn(move || {
        // Evidence and metadata are observed at t1; delivery is barred until
        // the actual worker pass has accepted PTY output at t2 > t1.
        let mut metadata = PtyMetadata::unobserved(SESSION.into());
        metadata.process_status = Some("working".into());
        let idle_status = Some("idle".into());
        assert!(monitor_status_changed(Some(&metadata), &idle_status));
        monitor_observed.wait();
        monitor_deliver.wait();
        monitor_store.ingest(SESSION, delayed);
        if work_done { monitor_store.ingest(SESSION, delayed_idle); }
        metadata.process_status = idle_status;
        metadata
    });
    observed.wait();
    f.at(output_at);
    f.observe(SESSION, 1, Some(output_at));
    f.store.quiet_worker_pass().unwrap();
    assert_eq!(f.store.current_view(SESSION).unwrap().last_output_at, output_at);
    let captured = capture(&f);
    deliver.wait();
    let metadata = producer.join().unwrap();
    let after_delivery = f.store.current_view(SESSION).unwrap();
    // Next real monitor poll: it has not recorded t2 yet, so LastOutput(t2)
    // is delivered; the now stable shell classification emits no new Idle.
    f.store.ingest(SESSION, Evidence::last_output(output_at, 1, OutputOrigin::Pty));
    let stable = Some("idle".into());
    assert!(!monitor_status_changed(Some(&metadata), &stable));
    let actual = f.store.current_view(SESSION).unwrap();
    let mut base = base_reducer::reduce(&initial, &event);
    if work_done { base = base_reducer::reduce(&base, &idle); }
    base = base_reducer::reduce(&base, &Evidence::last_output(output_at, 1, OutputOrigin::Pty));
    assert_eq!(actual.activity, Activity::Streaming,
        "QX2: delayed monitor evidence plus equal-timestamp LastOutput replay left Idle stuck; delivery={after_delivery:?}");
    assert_eq!(without_revision(actual), without_revision(base), "same observation-time order must reach the base state after the next monitor poll");
    assert!(captured.lock().unwrap().iter().all(|p| p.ui_state != UiSessionState::Idle));
}

#[test]
fn quiet_review_qx2_delayed_idle_survives_equal_output_replay() {
    delayed_monitor_case(false);
}

#[test]
fn quiet_review_qx2_delayed_work_done_survives_equal_output_replay() {
    delayed_monitor_case(true);
}

fn random(state: &mut u64) -> u64 {
    *state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
    *state >> 32
}

#[test]
fn quiet_review_qx2_post_output_idle_duplicates_and_attention_keep_base_meaning() {
    for kind in [AttentionKind::None, AttentionKind::Input, AttentionKind::Approval, AttentionKind::Done, AttentionKind::Error, AttentionKind::RateLimited] {
        for idle_at in [OUTPUT, OUTPUT + 1] {
            let events = [
                Evidence::last_output(OUTPUT, 1, OutputOrigin::Pty),
                attention(OUTPUT, 1, kind, true),
                Evidence::monitor_status(idle_at, 1, MonitorStatus::Idle, None),
                Evidence::work_done(idle_at, 1, "agent".into(), "zsh".into()),
                Evidence::last_output(OUTPUT, 1, OutputOrigin::Pty),
                Evidence::last_output(OUTPUT - 1, 1, OutputOrigin::Pty),
                Evidence::last_output(OUTPUT + 2, 1, OutputOrigin::Replay),
                Evidence::last_output(OUTPUT + 2, 1, OutputOrigin::Internal),
                Evidence::last_output(OUTPUT + 2, 1, OutputOrigin::Pty),
            ];
            let mut candidate = SessionView::new("precedence");
            let mut base = candidate.clone();
            for event in events {
                candidate = reduce(&candidate, &event);
                base = base_reducer::reduce(&base, &event);
                assert_eq!(candidate, base, "genuine post-output Idle/WorkDone, duplicate output and attention must keep the base meaning");
            }
            assert_eq!(candidate.attention.kind, kind);
        }
    }
}

#[test]
fn quiet_review_reducer_is_identical_to_base_outside_output_order_exception() {
    let mut comparisons = 0;
    let mut exceptions = 0;
    for seed in 1..=128 {
        let mut rng = seed;
        let mut view = SessionView::new("differential");
        for _ in 0..128 {
            let epoch = 1 + random(&mut rng) % 3;
            let at = OUTPUT + random(&mut rng) % 180_001;
            let event = match random(&mut rng) % 12 {
                0 => Evidence::monitor_status(at, epoch, MonitorStatus::Idle, None),
                1 => Evidence::monitor_status(at, epoch, MonitorStatus::Working, None),
                2 => Evidence::monitor_status(at, epoch, MonitorStatus::Unknown, None),
                3 => Evidence::work_done(at, epoch, "agent".into(), "zsh".into()),
                4..=6 => Evidence::last_output(at, epoch, [OutputOrigin::Pty, OutputOrigin::Internal, OutputOrigin::Replay][(random(&mut rng) % 3) as usize]),
                7 => Evidence::socket_lifecycle(at, epoch, Lifecycle::Exited),
                8 => Evidence::socket_lifecycle(at, epoch, Lifecycle::Alive),
                _ => attention(at, epoch, [AttentionKind::None, AttentionKind::Input, AttentionKind::Approval, AttentionKind::Done, AttentionKind::Error, AttentionKind::RateLimited][(random(&mut rng) % 6) as usize], random(&mut rng) % 2 == 0),
            };
            let candidate = reduce(&view, &event);
            let base = base_reducer::reduce(&view, &event);
            let exception = view.lifecycle != Lifecycle::Exited
                && view.session_epoch == event.session_epoch
                && event.observed_at < view.last_output_at
                && matches!(event.signal, EvidenceSignal::MonitorStatus { status: MonitorStatus::Idle } | EvidenceSignal::WorkDone { .. });
            if exception { exceptions += 1; } else {
                assert_eq!(candidate, base, "base differential seed={seed} evidence={event:?}");
                comparisons += 1;
            }
            view = candidate;
        }
    }
    assert!(comparisons > 10_000 && exceptions > 0);
    println!("REVIEW_DIFF comparisons={comparisons} explicit_order_exceptions={exceptions}");
}

/// Base reducer reference, with delayed Idle/WorkDone inserted before the real
/// output they preceded. Other evidence keeps delivery order. Revisions and
/// health/evidence bookkeeping are checked separately, not used as an oracle.
#[derive(Default)]
struct Reference {
    events: Vec<Evidence>,
    delivered: Vec<Evidence>,
    incoming: Option<usize>,
    ledger_back: Option<Evidence>,
}

impl Reference {
    fn deliver(&mut self, event: Evidence) {
        self.delivered.push(event.clone());
        // Match the base store's exact consecutive-evidence deduplication.
        // Sorting observations must not turn a skipped duplicate into Idle.
        if self.ledger_back.as_ref() == Some(&event) { return; }
        self.ledger_back = Some(event.clone());
        let insert = if matches!(event.signal, EvidenceSignal::MonitorStatus { status: MonitorStatus::Idle } | EvidenceSignal::WorkDone { .. }) {
            self.events.iter().position(|other| other.session_epoch == event.session_epoch
                && other.observed_at > event.observed_at
                && matches!(other.signal, EvidenceSignal::LastOutput { origin: OutputOrigin::Pty }))
        } else { None };
        let index = insert.unwrap_or(self.events.len());
        self.events.insert(index, event);
        self.incoming = Some(index);
    }

    fn view(&self, id: &str) -> SessionView {
        self.events.iter().fold(SessionView::new(id), |view, event| base_reducer::reduce(&view, event))
    }

    fn accept_reader_output(&mut self, current: &SessionView, reader: Option<(u64, Option<u64>)>) {
        let before = self.view(&current.session_id);
        if current.last_output_at > 0 && (current.session_epoch != before.session_epoch || current.last_output_at > before.last_output_at) {
            assert_eq!(reader, current.session_epoch.map(|epoch| (epoch, Some(current.last_output_at))), "accepted freshness must be actual same-epoch reader output");
            let output = Evidence::last_output(current.last_output_at, current.session_epoch.unwrap(), OutputOrigin::Pty);
            // Freshness combined with a post-output observation is ordered
            // before that incoming observation, just as the real monitor poll.
            let at = self.incoming.filter(|&index| self.events[index].session_epoch == output.session_epoch
                && self.events[index].observed_at >= output.observed_at);
            if let Some(index) = at {
                self.ledger_back = Some(self.events[index].clone());
                self.events.insert(index, output);
            } else {
                self.ledger_back = Some(output.clone());
                self.events.push(output);
            }
        }
    }
}

fn check_fresh_publications(f: &Fixture, captured: &Arc<Mutex<Vec<super::super::super::super::ProjectedSession>>>, seed: u64, step: usize, action: u64) {
    let clock = f.clock.load(Ordering::SeqCst);
    for p in captured.lock().unwrap().drain(..) {
        if derive_ui_state(&p.view) == UiSessionState::Working && p.ui_state == UiSessionState::Idle {
            let reader = f.reader.values.lock().unwrap().get(&p.view.session_id).copied();
            if let Some((reader_epoch, Some(at))) = reader {
                if Some(reader_epoch) == p.view.session_epoch {
                    assert!(clock.saturating_sub(at) >= QUIET_AFTER_MS,
                        "QX1 generated seed={seed} step={step} action={action}: {p:?} reader={at}");
                }
            }
        }
    }
}

#[tokio::test]
async fn quiet_review_generated_three_session_interleavings_obey_invariants() {
    let mut operations = 0;
    let mut actions = [0; 22];
    for seed in 1..=48 {
        let f = Fixture::new();
        let ids = ["generated-a", "generated-b", "generated-c"];
        let mut references: HashMap<&str, Reference> = HashMap::new();
        for id in ids {
            f.streaming(id);
            f.observe(id, 1, Some(OUTPUT));
            let reference = references.entry(id).or_default();
            reference.deliver(Evidence::monitor_status(OUTPUT - 100, 1, MonitorStatus::Idle, None));
            reference.deliver(Evidence::last_output(OUTPUT, 1, OutputOrigin::Pty));
        }
        let (peer, initial) = f.feed.subscribe();
        let captured = capture(&f);
        let mut seq = initial.snapshot.seq;
        let mut revisions: HashMap<String, u64> = initial.snapshot.sessions.iter().map(|s| (s.session_id.clone(), s.session_revision)).collect();
        let mut rng = seed;
        for step in 0..240 {
            for reference in references.values_mut() { reference.incoming = None; }
            let id = ids[(random(&mut rng) % ids.len() as u64) as usize];
            let before = f.store.current_view(id).unwrap();
            let epoch = before.session_epoch.unwrap();
            let now = f.clock.load(Ordering::SeqCst);
            let observed = f.reader.values.lock().unwrap().get(id).copied();
            let output_at = observed.and_then(|(_, at)| at).unwrap_or(before.last_output_at).max(OUTPUT);
            let action = if step == 0 { 3 } else { random(&mut rng) % 22 };
            actions[action as usize] += 1;
            let mut event = None;
            match action {
                0 => { f.observe(id, epoch, Some(now.max(output_at) + 1)); }
                1 => { let at = now.max(output_at) + 1; f.observe(id, epoch, Some(at)); event = Some(Evidence::last_output(at, epoch, OutputOrigin::Pty)); }
                2 => { f.store.quiet_worker_pass().unwrap(); }
                3 => {
                    // Force ordinary ingestion to win the gate after new reader
                    // output and before a worker/snapshot can repair it.
                    f.at(output_at + QUIET_AFTER_MS);
                    f.observe(id, epoch, Some(output_at + QUIET_AFTER_MS - 1));
                    event = Some(attention(output_at + QUIET_AFTER_MS, epoch, AttentionKind::None, false));
                }
                4 => { event = Some(attention(now, epoch, AttentionKind::None, true)); }
                5 => { event = references[id].delivered.last().cloned(); }
                6..=8 => { event = Some(attention(now, epoch, [AttentionKind::Input, AttentionKind::Approval, AttentionKind::Done][(action - 6) as usize], true)); }
                9 => { event = Some(Evidence::monitor_status(output_at - 1, epoch, MonitorStatus::Idle, None)); }
                10 => { event = Some(Evidence::work_done(output_at - 1, epoch, "agent".into(), "zsh".into())); }
                11..=12 => {
                    // Genuine post-output monitor polls ingest LastOutput before
                    // the new classification, keeping the base monitor flow.
                    let output = Evidence::last_output(output_at, epoch, OutputOrigin::Pty);
                    f.store.ingest(id, output.clone()); references.get_mut(id).unwrap().deliver(output);
                    let at = now.max(output_at) + 1;
                    event = Some(if action == 11 { Evidence::monitor_status(at, epoch, MonitorStatus::Idle, None) }
                        else { Evidence::work_done(at, epoch, "agent".into(), "zsh".into()) });
                }
                13 => { event = Some(Evidence::last_output(output_at, epoch, OutputOrigin::Pty)); }
                14 => { f.at(output_at + [59_999, 60_000, 60_001][(random(&mut rng) % 3) as usize]); }
                15 => { f.observe(id, epoch + 1, None); event = Some(Evidence::socket_lifecycle(now, epoch + 1, Lifecycle::Alive)); }
                16 => { event = Some(Evidence::socket_lifecycle(now, epoch, Lifecycle::Exited)); }
                17 => { event = Some(attention(now, epoch, AttentionKind::Approval, false)); }
                18 => {
                    let mut scan = attention(now, epoch, AttentionKind::None, false);
                    if let EvidenceSignal::ScreenScan { complete, .. } = &mut scan.signal { *complete = false; }
                    event = Some(scan);
                }
                19 => { event = Some(Evidence::monitor_status(now, epoch, MonitorStatus::Working, None)); }
                20 => { f.at(if step % 2 == 0 { 0 } else { OUTPUT - 1 }); }
                _ => { f.observe(id, epoch + 1, Some(now.max(output_at) + 1)); }
            }
            if let Some(event) = event {
                references.get_mut(id).unwrap().deliver(event.clone());
                f.store.ingest(id, event);
            }
            operations += 1;
            // Inspect publications BEFORE snapshot reconciliation can conceal
            // a one-frame freshness regression. Each entry point is exercised.
            check_fresh_publications(&f, &captured, seed, step, action);
            let projection = f.store.current_projection(id).unwrap();
            let ledger = f.store.snapshot(None);
            let snapshot = f.feed.frontend_snapshot();
            check_fresh_publications(&f, &captured, seed, step, action);
            assert_eq!(snapshot.seq, seq + peer.pending_len() as u64);
            for record in &ledger.sessions {
                let reader = f.reader.values.lock().unwrap().get(&record.session_id).copied();
                let reference = references.get_mut(record.session_id.as_str()).unwrap();
                reference.accept_reader_output(&record.view, reader);
                let base = reference.view(&record.session_id);
                assert_eq!((record.view.session_epoch, record.view.lifecycle, record.view.activity, &record.view.attention),
                    (base.session_epoch, base.lifecycle, base.activity, &base.attention),
                    "QX2 base observation order seed={seed} step={step} action={action} id={}", record.session_id);
                assert!(record.view.session_revision >= revisions[&record.session_id]);
                let status = snapshot.sessions.iter().find(|s| s.session_id == record.session_id).unwrap();
                assert_eq!(status.status.ui_state, record.ui_state);
                assert_eq!(status.session_revision, record.view.session_revision);
                for e in &record.recent_evidence {
                    if matches!(e.signal, EvidenceSignal::WorkDone { .. }) {
                        assert!(reference.delivered.contains(e), "no worker/projection may fabricate WorkDone");
                    }
                }
                if record.session_id == id {
                    assert_eq!(projection.ui_state, record.ui_state);
                    assert_eq!(projection.view.session_revision, record.view.session_revision);
                }
            }
            let mut last_delta: HashMap<String, StatusChangedEvent> = HashMap::new();
            while peer.pending_len() > 0 {
                let delta = changed(&peer).await;
                assert_eq!(delta.seq, seq + 1);
                assert!(delta.session_revision > revisions[&delta.session_id]);
                seq = delta.seq;
                revisions.insert(delta.session_id.clone(), delta.session_revision);
                last_delta.insert(delta.session_id.clone(), delta);
            }
            for (id, delta) in last_delta {
                let status = snapshot.sessions.iter().find(|s| s.session_id == id).unwrap();
                // The existing reducer intentionally does not publish a
                // timestamp-only LastOutput update. Check its monotonic real
                // watermark separately, and compare every versioned field.
                assert!(status.status.last_output_at >= delta.status.last_output_at);
                let mut published = delta.status;
                published.last_output_at = status.status.last_output_at;
                assert_eq!(status.status, published, "snapshot and latest delta at the same clock");
                assert_eq!(status.session_revision, delta.session_revision);
            }
            assert_eq!(snapshot.seq, seq);
        }
    }
    assert_eq!(operations, 11_520);
    assert!(actions.iter().all(|count| *count > 0));
    println!("REVIEW_INTERLEAVINGS sessions=3 seeds=48 steps={operations} actions={actions:?}");
}
