//! FIX-4 synthetic producer fixtures; keys follow the supplied record skeletons.
use super::*;
use serde_json::{json, Value};

const CLOCK_BASE: i64 = 1_800_000_000_000;

fn fixture_binding() -> LiveBinding {
    LiveBinding {
        pty_session_id: "clock-pty".into(), agent_session_id: "clock-conversation".into(),
        agent_kind: "claude".into(), pty_instance_id: "clock-instance".into(),
        pty_generation: 1, source_revision: 0, pty_input_revision: 1,
    }
}

fn record(snapshot: &mut SessionSnapshot, mut value: Value, at: i64, seq: u64) {
    value["timestamp"] = json!(chrono::DateTime::from_timestamp_millis(at).unwrap().to_rfc3339());
    value["uuid"] = json!(format!("clock-record-{seq}"));
    for event in snapshot.adapter.decode_record(&value.to_string(), ByteRange { start: seq * 100, end: seq * 100 + 99 }, seq).unwrap() {
        snapshot.reducer.apply(&event);
        snapshot.events.push_back(event);
    }
    let mut binding = snapshot.brief.binding.clone();
    binding.source_revision = seq;
    snapshot.brief = snapshot.reducer.to_brief(binding, "live", "fix4", at);
    apply_autonomy(&snapshot.adapter, &mut snapshot.brief, at, None);
}

#[test]
fn j2_h2_f4_shared_clock_fixtures_rebase_once_and_keep_new_event_times() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../tests/fixtures/livebrief_autonomy/autonomy-clock-cases.json"
    )).unwrap();
    for case in cases {
        let mut snapshot = unavailable_snapshot(fixture_binding(), "live", "fix4");
        snapshot.adapter = AgentAdapter::new("claude").unwrap();
        snapshot.adapter.mark_truncated_history();
        let mut seq = 0;
        for input in case["records"].as_array().unwrap() {
            seq += 1;
            record(&mut snapshot, input["record"].clone(), CLOCK_BASE + input["atOffsetMs"].as_i64().unwrap(), seq);
        }
        if case["turnUnknown"].as_bool().unwrap() { snapshot.adapter.mark_truncated_history(); }
        snapshot = refresh_autonomy(Some(snapshot), None, CLOCK_BASE, None).unwrap();
        for step in case["steps"].as_array().unwrap() {
            let prior = snapshot.clone();
            let next = if let Some(value) = step.get("record") {
                seq += 1;
                record(&mut snapshot, value.clone(), CLOCK_BASE + step["eventAtOffsetMs"].as_i64().unwrap(), seq);
                Some(snapshot)
            } else { None };
            let now = CLOCK_BASE + step["nowOffsetMs"].as_i64().unwrap();
            snapshot = refresh_autonomy(next, Some(&prior), now, None).unwrap_or(prior);
            let expected = step["expectedLastEventAtOffsetMs"].as_i64().map(|at| CLOCK_BASE + at);
            assert_eq!(snapshot.brief.last_event_at, expected, "{} {step}", case["name"]);
            let state = serde_json::to_value(snapshot.brief.autonomy.as_ref().unwrap()).unwrap();
            assert_eq!(state["turnState"], step["expectedTurnState"], "{} {step}", case["name"]);
            assert_eq!(state["backgroundState"], "unknown");
            assert_eq!(state["openToolCount"], 0);
            assert_eq!(state["armedBackgroundCount"], 0);
            assert_eq!(state["pendingNotificationCount"], 0);
        }
    }
}

#[test]
fn j3_h4_g6_f6_shared_overlapping_queue_fixtures_finish_without_pending_notifications() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../tests/fixtures/livebrief_autonomy/notification-delivery-cases.json"
    )).unwrap();
    assert_eq!(cases.iter().filter(|case| case["name"].as_str().unwrap().starts_with("J3 ")).count(), 3);
    for case in cases.iter().filter(|case| case["name"].as_str().unwrap().starts_with("J3 ")) {
        let mut snapshot = unavailable_snapshot(fixture_binding(), "live", "fix4");
        snapshot.adapter = AgentAdapter::new("claude").unwrap();
        let mut seq = 0;
        for raw in include_str!("../../../tests/fixtures/livebrief_autonomy/claude-monitor.jsonl").lines() {
            seq += 1;
            record(&mut snapshot, serde_json::from_str(raw).unwrap(), CLOCK_BASE + seq as i64 * 1000, seq);
        }
        for step in case["steps"].as_array().unwrap() {
            let previous_count = snapshot.brief.autonomy.as_ref().unwrap().pending_notification_count;
            seq += 1;
            record(&mut snapshot, step["record"].clone(), CLOCK_BASE + seq as i64 * 1000, seq);
            let state = serde_json::to_value(snapshot.brief.autonomy.as_ref().unwrap()).unwrap();
            for (key, expected) in step["expected"].as_object().unwrap() {
                assert_eq!(&state[key], expected, "{} {key} {step}", case["name"]);
            }
            if step["record"]["operation"] == "dequeue" {
                assert_eq!(snapshot.brief.autonomy.as_ref().unwrap().pending_notification_count, previous_count);
            }
        }
        let final_state = snapshot.brief.autonomy.as_ref().unwrap();
        // ANSWER-FIX5-1 permits only this anonymous fixture's correction.
        // Its historical name is kept; all other J3 final counts remain zero.
        let ambiguous = case["name"] == "J3 dequeue A before enqueue B then user A and late-ID remove B";
        assert_eq!(final_state.pending_notification_count, if ambiguous { 1 } else { 0 });
        assert_eq!(final_state.open_tool_count, 0);
        assert_eq!(final_state.armed_background_count, 0);
        assert_eq!(final_state.turn_state, super::autonomy::TurnState::Complete);
    }
}
