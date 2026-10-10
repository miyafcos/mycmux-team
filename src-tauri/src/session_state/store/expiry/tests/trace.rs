//! Subscriber frames from the real asynchronous driver, for B4's fixture.
use super::*;
use crate::status_feed::FeedSession;
use serde_json::{json, Value};

fn output_snapshot(f: &Fixture) -> Value {
    let mut outputs = serde_json::Map::new();
    for record in f.store.snapshot(None).sessions {
        outputs.insert(record.session_id, if record.view.last_output_at > 0 {
            json!(record.view.last_output_at)
        } else {
            Value::Null
        });
    }
    Value::Object(outputs)
}

async fn checkpoint(f: &Fixture, subscription: &StatusSubscription, at: u64) -> Value {
    let mut frames = Vec::new();
    while subscription.pending_len() > 0 {
        frames.push(changed(subscription).await);
    }
    let snapshot = f.feed.frontend_snapshot();
    for frame in &frames {
        let current = snapshot.sessions.iter().find(|record| record.session_id == frame.session_id).unwrap();
        assert_eq!(current.status, frame.status);
        assert_eq!(current.session_revision, frame.session_revision);
    }
    for id in ["input-peer", "approval-peer", "error-peer", "rate-limit-peer"] {
        assert_eq!(snapshot.sessions.iter().find(|record| record.session_id == id).unwrap().status.ui_state, UiSessionState::Waiting);
    }
    assert_eq!(snapshot.sessions.iter().find(|record| record.session_id == "done-peer").unwrap().status.ui_state, UiSessionState::Done);
    assert_eq!(snapshot.sessions.iter().find(|record| record.session_id == "keeper").unwrap().status.ui_state, UiSessionState::Working);
    assert_eq!(snapshot.sessions.iter().find(|record| record.session_id == "unknown-peer").unwrap().status.ui_state, UiSessionState::Unknown);
    json!({ "at": at, "frames": frames, "output_snapshot": output_snapshot(f) })
}

/// Only the random server_epoch may be normalized when this is committed as a
/// fixture. The frames themselves are serde output, never fabricated UI states.
async fn record_trace() -> Value {
    let f = Fixture::new();
    for id in ["quiet-agent", "quiet-shell"] {
        f.streaming(id);
    }
    for (id, kind) in [
        ("input-peer", AttentionKind::Input),
        ("approval-peer", AttentionKind::Approval),
        ("error-peer", AttentionKind::Error),
        ("rate-limit-peer", AttentionKind::RateLimited),
        ("done-peer", AttentionKind::Done),
    ] {
        f.streaming(id);
        f.store.ingest(id, attention(OUTPUT, kind));
    }
    // A live keeper with no first byte stays Working under the existing policy.
    f.store.ingest("keeper", Evidence::monitor_status(OUTPUT, 1, MonitorStatus::Working, None));
    f.store.ingest("unknown-peer", Evidence::monitor_status(OUTPUT, 1, MonitorStatus::Unknown, None));
    let before = f.store.snapshot(None);
    let (subscription, initial) = f.feed.subscribe();
    let mut driver = ManualWait::new();
    let task = driver.start(&f.store);
    assert_eq!(driver.next().await.eligible_sessions, 2);
    let mut steps = Vec::new();
    for elapsed in [59_999, 60_000, 120_000, 300_001, 360_001] {
        let at = OUTPUT + elapsed;
        driver.advance(&f, at).await;
        let step = checkpoint(&f, &subscription, at).await;
        let frames = step["frames"].as_array().unwrap();
        if elapsed == 60_000 {
            assert_eq!(frames.len(), 2);
            assert!(frames.iter().all(|frame| frame["status"]["ui_state"] == "idle"));
            let after = f.store.snapshot(None);
            for id in ["quiet-agent", "quiet-shell"] {
                let old = before.sessions.iter().find(|record| record.session_id == id).unwrap();
                let new = after.sessions.iter().find(|record| record.session_id == id).unwrap();
                assert_eq!(new.view.activity, Activity::Streaming);
                assert_eq!(new.view.attention, old.view.attention);
                assert_eq!(new.recent_evidence, old.recent_evidence);
                let mut expected = old.view.clone();
                expected.session_revision += 1;
                assert_eq!(new.view, expected);
                assert_eq!(FeedSession::from(new).status.ui_state, UiSessionState::Idle);
            }
        } else {
            assert!(frames.is_empty());
        }
        steps.push(step);
    }
    let resumed_at = OUTPUT + 360_002;
    f.at(resumed_at);
    for id in ["quiet-agent", "quiet-shell"] {
        f.store.ingest(id, Evidence::last_output(resumed_at, 1, OutputOrigin::Pty));
    }
    driver.next_at(resumed_at).await;
    let resumed = checkpoint(&f, &subscription, resumed_at).await;
    assert_eq!(resumed["frames"].as_array().unwrap().len(), 2);
    assert!(resumed["frames"].as_array().unwrap().iter().all(|frame| frame["status"]["ui_state"] == "working"));
    steps.push(resumed);

    let approval_at = resumed_at + 1;
    f.at(approval_at);
    f.store.ingest("quiet-agent", attention(approval_at, AttentionKind::Approval));
    driver.next_at(approval_at).await;
    let approval = checkpoint(&f, &subscription, approval_at).await;
    assert_eq!(approval["frames"][0]["status"]["ui_state"], "waiting");
    steps.push(approval);

    let exit_at = approval_at + 1;
    f.at(exit_at);
    f.store.ingest("quiet-agent", Evidence::socket_lifecycle(exit_at, 1, Lifecycle::Exited));
    driver.advance(&f, exit_at).await;
    steps.push(checkpoint(&f, &subscription, exit_at).await);
    let recreated_at = exit_at + 1;
    f.at(recreated_at);
    f.store.ingest("quiet-agent", Evidence::monitor_status(recreated_at, 2, MonitorStatus::Working, None));
    driver.advance(&f, recreated_at).await;
    let recreated = checkpoint(&f, &subscription, recreated_at).await;
    assert_eq!(recreated["frames"][0]["status"]["session_epoch"], 2);
    assert_eq!(recreated["frames"][0]["status"]["last_output_at"], 0);
    steps.push(recreated);
    stopped(&f.store, task).await;

    let mut last_seq = initial.snapshot.seq;
    for step in &steps {
        for frame in step["frames"].as_array().unwrap() {
            let seq = frame["seq"].as_u64().unwrap();
            assert_eq!(seq, last_seq + 1);
            last_seq = seq;
        }
    }
    json!({
        "trace_version": 1,
        "producer": "SessionStateStore + StatusFeed + asynchronous quiet worker",
        "origin_ms": OUTPUT,
        "initial": initial,
        "initial_output_snapshot": output_snapshot_from_initial(&before),
        "steps": steps,
    })
}

fn output_snapshot_from_initial(snapshot: &crate::session_state::SessionStateSnapshot) -> Value {
    let mut outputs = serde_json::Map::new();
    for record in &snapshot.sessions {
        outputs.insert(record.session_id.clone(), if record.view.last_output_at > 0 {
            json!(record.view.last_output_at)
        } else {
            Value::Null
        });
    }
    Value::Object(outputs)
}

#[tokio::test]
async fn connected_subscriber_trace_is_generated_by_the_actual_quiet_driver() {
    let trace = record_trace().await;
    println!("WORKER_TRACE {trace}");
}

/// This fixture is the commander's request-3 trace at 1f1bf857a, SHA256
/// 25bc6992bc689ea8996c47bdb0eea04e2d14a3c7f01364bfff39db639a0f5640.
/// Timestamps, evidence, attention, session epochs, revisions and sequences
/// must reproduce exactly; only the random feed server epoch is normalized.
#[tokio::test]
async fn committed_frontend_fixture_reproduces_the_actual_quiet_driver_trace() {
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../tests/fixtures/canonicalQuietFeed.json"
    ))).unwrap();
    let mut actual = record_trace().await;
    let epoch = actual["initial"]["server_epoch"].as_str().unwrap().to_owned();
    actual["initial"]["server_epoch"] = json!("quiet-expiry-fixture");
    for step in actual["steps"].as_array_mut().unwrap() {
        for frame in step["frames"].as_array_mut().unwrap() {
            assert_eq!(frame["server_epoch"], epoch);
            frame["server_epoch"] = json!("quiet-expiry-fixture");
        }
    }
    assert_eq!(actual, fixture);
}
