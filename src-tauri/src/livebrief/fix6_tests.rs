//! FIX-6 synthetic scenes use the supplied skeleton keys and mothership table.
//! ANSWER-FIX6-1: only the anonymous control without B delivery stays pending.
use super::*;
use serde_json::{json, Value};

const BASE: i64 = 1_800_000_000_000;

fn cases() -> Vec<Value> {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/livebrief_autonomy/notification-provisional-id-cases.json"
    )).unwrap()
}

fn binding() -> LiveBinding {
    LiveBinding {
        pty_session_id: "fix6-pty".into(), agent_session_id: "fix6-conversation".into(),
        agent_kind: "claude".into(), pty_instance_id: "fix6-instance".into(),
        pty_generation: 1, source_revision: 0, pty_input_revision: 1,
    }
}

fn timestamped(mut value: Value, seq: u64) -> Value {
    value["timestamp"] = json!(chrono::DateTime::from_timestamp_millis(BASE + seq as i64 * 1000).unwrap().to_rfc3339());
    value["uuid"] = json!(format!("fix6-record-{seq}"));
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
    snapshot.brief = snapshot.reducer.to_brief(current, "live", "fix6", now);
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
fn l1_shared_producer_and_cached_polls_resolve_id_handoffs_but_keep_undelivered_anonymous_b() {
    let cases = cases();
    assert_eq!(cases.len(), 4);
    for case in &cases {
        let mut snapshot = unavailable_snapshot(binding(), "live", "fix6");
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
            for poll in case["polls"].as_array().unwrap().iter()
                .filter(|poll| poll["atStep"].as_u64() == Some(index as u64)) {
                let anchor = snapshot.brief.last_event_at.unwrap();
                let now = anchor + poll["elapsedMs"].as_i64().unwrap();
                let polled = refresh_autonomy(None, Some(&snapshot), now, None).unwrap_or_else(|| snapshot.clone());
                assert_output(&polled, case, step);
                assert_eq!(polled.brief.autonomy.as_ref().unwrap().turn_state, super::autonomy::TurnState::Complete);
                // Rust preserves the actual count and event clock even at TTL;
                // TS alone bounds how long anonymous pending work is displayed.
            }
        }
    }
}

#[test]
fn l1_same_conversation_replay_preserves_provisional_receipt_then_rebinds_definite_handoff() {
    for case in &cases() {
        let dir = tempfile::tempdir().unwrap(); let _unit_home = crate::unit_test_dirs::fixture_home(&dir);
        let path = dir.path().join("synthetic-l1.jsonl");
        let steps = case["steps"].as_array().unwrap();
        let source: Vec<Value> = monitor_records().into_iter()
            .chain(steps[..5].iter().map(|step| step["record"].clone())).collect();
        let mut body: String = source.into_iter().enumerate()
            .map(|(index, value)| timestamped(value, index as u64 + 1).to_string() + "\n").collect();
        std::fs::write(&path, &body).unwrap();
        let prior = bootstrap_transcript(&path, "claude", &binding(), "fix6").unwrap();
        let prior = refresh_autonomy(Some(prior), None, BASE + 10_000, None).unwrap();
        assert_output(&prior, case, &steps[4]);
        let replay = bootstrap_transcript_seeded(
            &path, "claude", &binding(), "fix6", None, None, MAX_BOOTSTRAP_BYTES, Some(&prior),
        ).unwrap();
        let replay = refresh_autonomy(Some(replay), Some(&prior), BASE + 11_000, None).unwrap();
        assert_output(&replay, case, &steps[4]);
        for (index, step) in steps[5..].iter().enumerate() {
            body.push_str(&(timestamped(step["record"].clone(), index as u64 + 11).to_string() + "\n"));
        }
        std::fs::write(&path, body).unwrap();
        let delivered = bootstrap_transcript_seeded(
            &path, "claude", &binding(), "fix6", None, None, MAX_BOOTSTRAP_BYTES, Some(&replay),
        ).unwrap();
        let delivered = refresh_autonomy(Some(delivered), Some(&replay), BASE + 13_000, None).unwrap();
        assert_output(&delivered, case, steps.last().unwrap());
    }
}

#[test]
fn l1_definite_id_duplicates_keep_priority_and_repeated_provisional_remove_still_rebinds() {
    let x = "<task-notification><task-id>id-00592</task-id><status>completed</status></task-notification>";
    let traces = [
        // A has a definite ID before its receipt. Even after B's handoff,
        // duplicate user/remove records for A must not consume B.
        vec![
            (json!({"type":"queue-operation","operation":"enqueue","content":x,"commandUuid":"opaque-R"}), 1),
            (json!({"type":"queue-operation","operation":"dequeue","commandUuid":"opaque-R"}), 1),
            (json!({"type":"queue-operation","operation":"enqueue","content":x}), 2),
            (json!({"type":"user","commandUuid":"opaque-R","message":{"role":"user","content":x}}), 1),
            (json!({"type":"queue-operation","operation":"dequeue"}), 1),
            (json!({"type":"queue-operation","operation":"remove","reason":"absorbed_mid_turn","content":x,"commandUuid":"opaque-R"}), 1),
            (json!({"type":"user","commandUuid":"opaque-R","message":{"role":"user","content":x}}), 1),
            (json!({"type":"user","message":{"role":"user","content":x}}), 0),
        ],
        // Repeating a guessed remove does not promote it to a definite ID.
        // B's later definite handoff must still resolve both notices.
        vec![
            (json!({"type":"queue-operation","operation":"enqueue","content":x}), 1),
            (json!({"type":"queue-operation","operation":"dequeue"}), 1),
            (json!({"type":"queue-operation","operation":"enqueue","content":x}), 2),
            (json!({"type":"user","message":{"role":"user","content":x}}), 1),
            (json!({"type":"queue-operation","operation":"remove","reason":"absorbed_mid_turn","content":x,"commandUuid":"opaque-R"}), 1),
            (json!({"type":"queue-operation","operation":"remove","reason":"absorbed_mid_turn","content":x,"commandUuid":"opaque-R"}), 1),
            (json!({"type":"queue-operation","operation":"dequeue","commandUuid":"opaque-R"}), 1),
            (json!({"type":"user","commandUuid":"opaque-R","message":{"role":"user","content":x}}), 0),
        ],
    ];
    for trace in traces {
        let mut snapshot = unavailable_snapshot(binding(), "live", "fix6");
        snapshot.adapter = AgentAdapter::new("claude").unwrap();
        let mut seq = 0;
        for value in monitor_records() {
            seq += 1;
            record(&mut snapshot, value, seq);
        }
        for (value, expected) in trace {
            seq += 1;
            record(&mut snapshot, value, seq);
            assert_eq!(snapshot.brief.autonomy.as_ref().unwrap().pending_notification_count, expected);
        }
        record(&mut snapshot, json!({"type":"assistant","message":{"stop_reason":"end_turn","content":[]}}), seq + 1);
        assert_eq!(snapshot.brief.autonomy.as_ref().unwrap().turn_state, super::autonomy::TurnState::Complete);
        assert_eq!(snapshot.brief.autonomy.as_ref().unwrap().pending_notification_count, 0);
    }
}
