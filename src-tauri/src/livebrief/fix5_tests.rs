//! FIX-5 synthetic scenes use the supplied skeleton keys and the mothership table.
//! The old anonymous J3 expectation is corrected only under ANSWER-FIX5-1.
use super::*;
use serde_json::{json, Value};

const BASE: i64 = 1_800_000_000_000;
const ANONYMOUS_J3: &str = "J3 dequeue A before enqueue B then user A and late-ID remove B";

fn cases() -> Vec<Value> {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/livebrief_autonomy/notification-delivery-cases.json"
    )).unwrap()
}

fn binding() -> LiveBinding {
    LiveBinding {
        pty_session_id: "fix5-pty".into(), agent_session_id: "fix5-conversation".into(),
        agent_kind: "claude".into(), pty_instance_id: "fix5-instance".into(),
        pty_generation: 1, source_revision: 0, pty_input_revision: 1,
    }
}

fn timestamped(mut value: Value, seq: u64) -> Value {
    value["timestamp"] = json!(chrono::DateTime::from_timestamp_millis(BASE + seq as i64 * 1000).unwrap().to_rfc3339());
    value["uuid"] = json!(format!("fix5-record-{seq}"));
    value
}

fn monitor_records() -> Vec<Value> {
    include_str!("../../../tests/fixtures/livebrief_autonomy/claude-monitor.jsonl")
        .lines().map(|row| serde_json::from_str(row).unwrap()).collect()
}

fn record(snapshot: &mut SessionSnapshot, value: Value, seq: u64) {
    let value = timestamped(value, seq);
    for event in snapshot.adapter.decode_record(
        &value.to_string(), ByteRange { start: seq * 100, end: seq * 100 + 99 }, seq,
    ).unwrap() {
        snapshot.reducer.apply(&event);
        snapshot.events.push_back(event);
    }
    let mut current = snapshot.brief.binding.clone();
    current.source_revision = seq;
    let now = BASE + seq as i64 * 1000;
    snapshot.brief = snapshot.reducer.to_brief(current, "live", "fix5", now);
    apply_autonomy(&snapshot.adapter, &mut snapshot.brief, now, None);
}

fn assert_output(snapshot: &SessionSnapshot, case: &Value, step: &Value) {
    let state = serde_json::to_value(snapshot.brief.autonomy.as_ref().unwrap()).unwrap();
    for (key, expected) in step["expected"].as_object().unwrap() {
        assert_eq!(&state[key], expected, "{} {key} {step}", case["name"]);
    }
    assert_eq!(
        snapshot.brief.last_event_at,
        Some(BASE + step["expectedLastEventAtOffsetMs"].as_i64().unwrap()),
        "{} event clock {step}", case["name"],
    );
}

#[test]
fn k1_anonymous_duplicate_shared_cases_keep_b_until_delivery_and_keep_clock_for_safety_net() {
    let cases = cases();
    assert_eq!(cases.iter().filter(|case| case["name"].as_str().unwrap().starts_with("K1 ")).count(), 4);
    for case in cases.iter().filter(|case| {
        case["name"].as_str().unwrap().starts_with("K1 ") || case["name"] == ANONYMOUS_J3
    }) {
        let mut snapshot = unavailable_snapshot(binding(), "live", "fix5");
        snapshot.adapter = AgentAdapter::new("claude").unwrap();
        let mut seq = 0;
        for value in monitor_records() {
            seq += 1;
            record(&mut snapshot, value, seq);
        }
        for (index, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            let before = snapshot.brief.autonomy.as_ref().unwrap().pending_notification_count;
            seq += 1;
            record(&mut snapshot, step["record"].clone(), seq);
            assert_output(&snapshot, case, step);
            if step["record"]["operation"] == "dequeue" {
                assert_eq!(snapshot.brief.autonomy.as_ref().unwrap().pending_notification_count, before);
            }
            let anchor = snapshot.brief.last_event_at.unwrap();
            for poll in case["undeliveredPolls"].as_array().unwrap().iter()
                .filter(|poll| poll["atStep"].as_u64() == Some(index as u64)) {
                let now = anchor + poll["elapsedMs"].as_i64().unwrap();
                let polled = refresh_autonomy(None, Some(&snapshot), now, None).unwrap_or_else(|| snapshot.clone());
                assert_output(&polled, case, step);
                let state = polled.brief.autonomy.as_ref().unwrap();
                assert_eq!(state.turn_state, super::autonomy::TurnState::Complete);
                assert_eq!(state.pending_notification_count, 1);
                assert_eq!((state.open_tool_count, state.armed_background_count), (0, 0));
                // Cached polling preserves truthful pending evidence and its
                // original clock. TS, not Rust, owns the 30-minute display limit.
            }
        }
    }
}

#[test]
fn k1_same_conversation_replay_preserves_ambiguous_handoff_and_settles_later_b() {
    for case in cases().iter().filter(|case| case["name"].as_str().unwrap().starts_with("K1 ")) {
        let dir = tempfile::tempdir().unwrap(); let _unit_home = crate::unit_test_dirs::fixture_home(&dir);
        let path = dir.path().join("synthetic-k1.jsonl");
        let steps = case["steps"].as_array().unwrap();
        let source: Vec<Value> = monitor_records().into_iter()
            .chain(steps[..6].iter().map(|step| step["record"].clone())).collect();
        let mut body: String = source.into_iter().enumerate()
            .map(|(index, value)| timestamped(value, index as u64 + 1).to_string() + "\n").collect();
        std::fs::write(&path, &body).unwrap();
        let prior = bootstrap_transcript(&path, "claude", &binding(), "fix5").unwrap();
        let prior = refresh_autonomy(Some(prior), None, BASE + 11_000, None).unwrap();
        assert_output(&prior, case, &steps[5]);
        let replay = bootstrap_transcript_seeded(
            &path, "claude", &binding(), "fix5", None, None, MAX_BOOTSTRAP_BYTES, Some(&prior),
        ).unwrap();
        let replay = refresh_autonomy(Some(replay), Some(&prior), BASE + 12_000, None).unwrap();
        assert_output(&replay, case, &steps[5]);
        for (index, step) in steps[6..].iter().enumerate() {
            body.push_str(&(timestamped(step["record"].clone(), index as u64 + 12).to_string() + "\n"));
        }
        std::fs::write(&path, body).unwrap();
        let delivered = bootstrap_transcript_seeded(
            &path, "claude", &binding(), "fix5", None, None, MAX_BOOTSTRAP_BYTES, Some(&replay),
        ).unwrap();
        let delivered = refresh_autonomy(Some(delivered), Some(&replay), BASE + 13_000, None).unwrap();
        assert_output(&delivered, case, &steps[7]);
        assert_eq!(delivered.brief.autonomy.as_ref().unwrap().pending_notification_count, 0);
        assert_eq!(delivered.brief.autonomy.as_ref().unwrap().turn_state, super::autonomy::TurnState::Complete);
    }
}
