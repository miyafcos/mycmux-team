//! Extra background/wakeup records are constructed from the supplied table:
//! their keys and value types match those observed in actual provider records.
use serde_json::{json, Value};

#[test]
fn t20_old_persisted_tabs_roundtrip_and_new_delegation_is_optional() {
    use crate::db::storage::PaneTabConfig;
    let old = json!({"agent_id":"shell","type":"terminal","label":"Old"});
    let tab: PaneTabConfig = serde_json::from_value(old).unwrap();
    assert!(tab.delegated_by_tab_id.is_none());
    assert!(tab.delegated_by_agent_session_id.is_none() && tab.delegated_at.is_none());
    let saved = serde_json::to_value(&tab).unwrap();
    assert!(saved.get("delegated_by_tab_id").is_none());
    let mut new = saved;
    new["delegated_by_tab_id"] = json!("parent");
    let restored: PaneTabConfig = serde_json::from_value(new).unwrap();
    assert_eq!(restored.delegated_by_tab_id.as_deref(), Some("parent"));
}

use super::autonomy::TurnState;
use super::*;

#[test]
fn integ4_process_boundary_eviction_matches_ordinary_naming_plan() {
    let mut snapshot = unavailable_snapshot(binding(), "live", "integ4");
    snapshot.adapter = AgentAdapter::new("claude").unwrap();
    let now = 1_800_000_000_000;
    let user = json!({"type":"user","uuid":"old-instruction","timestamp":
        chrono::DateTime::from_timestamp_millis(now).unwrap().to_rfc3339(),
        "message":{"content":"Inspect the orchard report"}}).to_string();
    let tool = json!({"type":"assistant","uuid":"old-tool","timestamp":
        chrono::DateTime::from_timestamp_millis(now + 1000).unwrap().to_rfc3339(),
        "message":{"content":[{"type":"tool_use","id":"old","name":"Bash","input":{}}]}}).to_string();
    apply_decoded_records(&mut snapshot.adapter, &mut snapshot.reducer, &mut snapshot.events,
        &mut Vec::new(), vec![(&user, ByteRange {start: 0, end: 99}),
            (&tool, ByteRange {start: 100, end: 199})], 0);
    // One retained instruction, followed by non-naming events: unlike 200 user
    // messages, this detects a ring loss that the naming cap has not already seen.
    while snapshot.events.len() < RING_CAPACITY {
        let seq = snapshot.events.len() as u64;
        let event = SemanticEventEnvelope {event_id: format!("filler-{seq}"), source_revision: seq,
            occurred_at: now + 1000, source_byte_start: seq * 100, source_byte_end: seq * 100 + 99,
            kind: SemanticEventKind::TestResult {pass: 1, fail: 0}};
        snapshot.reducer.apply(&event); snapshot.events.push_back(event);
    }
    snapshot.brief = snapshot.reducer.to_brief(binding(), "live", "integ4", now + 1000);
    let old_id = snapshot.events.front().unwrap().event_id.clone();
    assert!(snapshot.reducer.naming_plan().entries.iter().any(|entry| entry.event_id == old_id));
    let mut ordinary = snapshot.clone();
    let result = json!({"type":"user","uuid":"ordinary-result","message":{"content":[
        {"type":"tool_result","tool_use_id":"old","content":"ok"}]}}).to_string();
    apply_decoded_records(&mut ordinary.adapter, &mut ordinary.reducer, &mut ordinary.events,
        &mut Vec::new(), vec![(&result, ByteRange {start: 0, end: 0})], 1);
    assert_eq!(ordinary.events.len(), RING_CAPACITY);
    let replaced = refresh_autonomy(None, Some(&snapshot), now + 10_000, Some(now + 2000)).unwrap();
    assert_eq!(replaced.events.len(), RING_CAPACITY);
    assert!(!replaced.events.iter().any(|event| event.event_id == old_id));
    assert_eq!(replaced.brief.naming_plan.as_ref().unwrap(), &ordinary.reducer.naming_plan());
    assert_eq!(replaced.brief.naming_plan.as_ref().unwrap().coverage.count_loss, Some(99));
    assert!(replaced.brief.naming_plan.as_ref().unwrap().entries.iter()
        .all(|entry| replaced.events.iter().any(|event| event.event_id == entry.event_id)));
}

#[test]
fn integ4_pasted_interruption_log_remains_human_instruction_and_naming_material() {
    let text = "Please inspect this pasted log:\n[Request interrupted by user for tool use]\nKeep the orchard report.";
    let mut driver = Driver::new("claude");
    driver.user("Previous work"); driver.complete(); driver.user(text);
    let brief = driver.brief(0, None);
    assert_eq!(brief.autonomy.unwrap().turn_state, TurnState::Active);
    assert_eq!(brief.latest_instruction.as_deref(), Some(text));
    let plan = driver.reducer.naming_plan();
    assert_eq!(plan.entries.last().unwrap().hash, sha256_hex(text.as_bytes()));
    driver.user("  [Request interrupted by user for tool use]");
    assert_eq!(driver.autonomy(0).turn_state, TurnState::Complete);
    assert_eq!(driver.reducer.naming_plan(), plan);
}

#[cfg(test)]
mod poll_performance {
    use super::*;
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;
    use std::hint::black_box;
    use std::io::Write;

    thread_local! {
        static COUNTING: Cell<bool> = const { Cell::new(false) };
        static ALLOCS: Cell<u64> = const { Cell::new(0) };
        static BYTES: Cell<u64> = const { Cell::new(0) };
    }
    struct CountingAllocator;
    fn record(size: usize) {
        let _ = COUNTING.try_with(|enabled| {
            if enabled.get() {
                let _ = ALLOCS.try_with(|count| count.set(count.get() + 1));
                let _ = BYTES.try_with(|bytes| bytes.set(bytes.get() + size as u64));
            }
        });
    }
    unsafe impl GlobalAlloc for CountingAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let ptr = unsafe { System.alloc(layout) };
            if !ptr.is_null() {
                record(layout.size());
            }
            ptr
        }
        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            let ptr = unsafe { System.alloc_zeroed(layout) };
            if !ptr.is_null() {
                record(layout.size());
            }
            ptr
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            unsafe { System.dealloc(ptr, layout) }
        }
        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
            let ptr = unsafe { System.realloc(ptr, layout, size) };
            if !ptr.is_null() {
                record(size);
            }
            ptr
        }
    }
    #[global_allocator]
    static ALLOCATOR: CountingAllocator = CountingAllocator;

    // This is the pre-FIX refresh_all snapshot copy plus the exact extra
    // prior.clone() performed by refresh_autonomy on every unchanged poll.
    fn before_poll(panes: &[SessionSnapshot], now: i64) {
        let priors: Vec<_> = panes.to_vec();
        for prior in &priors {
            let mut updated = prior.clone();
            apply_autonomy(&updated.adapter, &mut updated.brief, now, None);
            black_box(brief_changed(&prior.brief, &updated.brief));
        }
    }
    fn after_poll(panes: &[SessionSnapshot], now: i64) {
        let priors: Vec<_> = panes.to_vec(); // existing refresh_all copy is preserved
        for prior in &priors {
            assert!(refresh_autonomy(None, Some(prior), now, None).is_none());
        }
    }
    fn measure(poll: impl Fn(), repetitions: u32) -> (u128, u64, u64) {
        ALLOCS.with(|v| v.set(0));
        BYTES.with(|v| v.set(0));
        COUNTING.with(|v| v.set(true));
        let started = Instant::now();
        for _ in 0..repetitions {
            poll();
        }
        let ns = started.elapsed().as_nanos() / u128::from(repetitions);
        COUNTING.with(|v| v.set(false));
        (
            ns,
            ALLOCS.with(|v| v.get()) / u64::from(repetitions),
            BYTES.with(|v| v.get()) / u64::from(repetitions),
        )
    }
    #[test]
    fn f14_fifty_long_unchanged_panes_measure_poll_time_and_allocations_and_prune_expiry() {
        let dir = tempfile::tempdir().unwrap(); let _unit_home = crate::unit_test_dirs::fixture_home(&dir);
        let path = dir.path().join("long.jsonl");
        let mut lines = String::new();
        // 4,000 provider ids in a long transcript are retained by the adapter.
        // Unknown records reproduce long quiet history without history.db writes.
        for id in 0..4000 {
            lines.push_str(&json!({"type":"future-record","uuid":format!("provider-{id:05}-{}", "x".repeat(80)),"timestamp":"2026-10-08T05:20:00Z","padding":"x".repeat(256)}).to_string());
            lines.push('\n');
        }
        std::fs::write(&path, &lines).unwrap();
        let now = adapter::parse_timestamp("2026-10-08T06:00:00Z").unwrap();
        let seed = refresh_autonomy(
            Some(bootstrap_transcript(&path, "claude", &binding(), "test").unwrap()),
            None,
            now,
            None,
        )
        .unwrap();
        let panes: Vec<_> = (0..50).map(|_| seed.clone()).collect();
        before_poll(&panes, now);
        after_poll(&panes, now);
        let before = measure(|| before_poll(&panes, now), 7);
        let after = measure(|| after_poll(&panes, now), 7);
        assert!(after.1 < before.1 && after.2 < before.2);
        // Direct stdout (not println!) survives libtest capture on passing tests.
        writeln!(std::io::stdout(),"F14_PERF {}",json!({"panes":50,"transcriptBytesPerPane":lines.len(),"retainedProviderIdsPerPane":4000,"repetitions":7,"before":{"nsPerPoll":before.0,"allocationsPerPoll":before.1,"allocatedBytesPerPoll":before.2},"after":{"nsPerPoll":after.0,"allocationsPerPoll":after.1,"allocatedBytesPerPoll":after.2},"comparison":"pre-FIX polling algorithm replay on identical snapshots; thread-local allocation counters"})).unwrap();

        let mut d = Driver::new("claude");
        for id in 0..200 {
            let call = format!("monitor-{id}");
            d.tool(&call, "Monitor", json!({}));
            d.result(
                &call,
                json!({"taskId":call,"timeoutMs":0,"persistent":false}),
            );
        }
        assert_eq!(d.adapter.retained_background_count(), 200);
        d.adapter.prune_autonomy(d.at + 60_001, None);
        assert_eq!(d.adapter.retained_background_count(), 0);
        assert_eq!(d.autonomy(60_001).armed_background_count, 0);
    }
}

#[test]
fn f2_local_ui_and_meta_records_do_not_restart_complete_or_idle_turns() {
    for complete in [false, true] {
        for (text, meta) in [
            ("<local-command-stdout>hello</local-command-stdout>", false),
            ("injected reminder", true),
            ("<command-name>/help</command-name>", false),
        ] {
            let mut d = Driver::new("claude");
            if complete {
                d.user("work");
                d.complete();
            }
            let before = d.autonomy(0);
            let last = d.adapter.autonomy_last_event_at();
            d.add(json!({"type":"user","isMeta":meta,"message":{"content":text}}));
            assert_eq!(d.autonomy(0), before, "{text}");
            assert_eq!(d.adapter.autonomy_last_event_at(), last);
        }
    }
    for origin in ["peer", "task-notification", "stop-hook", "hook"] {
        let mut d = Driver::new("claude");
        d.user("work");
        d.complete();
        d.add(json!({"type":"user","isMeta":true,"origin":{"kind":origin},"message":{"content":"continue automatically"}}));
        assert_eq!(d.autonomy(0).turn_state, TurnState::Active);
    }
}

#[test]
fn f3_process_restart_discards_old_open_tools_and_turn_before_new_completion() {
    for kind in ["claude", "codex"] {
        let mut d = Driver::new(kind);
        if kind == "claude" {
            d.user("work");
            d.tool("old", "Bash", json!({}));
        } else {
            d.add(json!({"type":"event_msg","payload":{"type":"task_started"}}));
            d.add(json!({"type":"response_item","payload":{"type":"function_call","call_id":"old","name":"exec_command","arguments":"{}"}}));
        }
        let birth = d.at + 1;
        let restarted = d.brief(1000, Some(birth)).autonomy.unwrap();
        assert_eq!(restarted.open_tool_count, 0);
        assert_eq!(restarted.turn_state, TurnState::Idle);
        d.adapter.prune_autonomy(d.at + 1000, Some(birth));
        if kind == "claude" {
            d.user("new work");
            d.tool("new", "Bash", json!({}));
            d.result("new", json!({}));
            d.complete();
        } else {
            d.add(json!({"type":"event_msg","payload":{"type":"task_started"}}));
            d.add(json!({"type":"response_item","payload":{"type":"function_call","call_id":"new","name":"exec_command","arguments":"{}"}}));
            d.add(json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"new","output":"ok"}}));
            d.add(json!({"type":"event_msg","payload":{"type":"task_complete"}}));
        }
        let state = d.brief(0, Some(birth)).autonomy.unwrap();
        assert_eq!(state.open_tool_count, 0);
        assert_eq!(state.turn_state, TurnState::Complete);
    }
}

#[test]
fn f4_replacement_shrink_and_conversation_switch_preserve_current_background() {
    let dir = tempfile::tempdir().unwrap(); let _unit_home = crate::unit_test_dirs::fixture_home(&dir);
    let path = dir.path().join("transcript.jsonl");
    std::fs::write(
        &path,
        include_str!("../../../tests/fixtures/livebrief_autonomy/claude-monitor.jsonl"),
    )
    .unwrap();
    let now = adapter::parse_timestamp("2026-10-08T05:22:00Z").unwrap();
    let prior = refresh_autonomy(
        Some(bootstrap_transcript(&path, "claude", &binding(), "test").unwrap()),
        None,
        now,
        None,
    )
    .unwrap();
    let end = "{\"type\":\"assistant\",\"uuid\":\"new-end\",\"timestamp\":\"2026-10-08T05:22:01Z\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"finished\"}],\"stop_reason\":\"end_turn\"}}\n";
    std::fs::write(&path, end).unwrap(); // same-process truncation/replacement
    let mut other = binding();
    other.agent_session_id = "new-conversation".into();
    for binding in [binding(), other] {
        let next = bootstrap_transcript_seeded(
            &path,
            "claude",
            &binding,
            "test",
            None,
            None,
            MAX_BOOTSTRAP_BYTES,
            Some(&prior),
        )
        .unwrap();
        let current = refresh_autonomy(Some(next), Some(&prior), now + 2000, None).unwrap();
        assert_eq!(current.brief.autonomy.unwrap().armed_background_count, 1);
    }
    // A queued terminal record without its omitted start is reconciled against
    // prior proven work and must retain model-delivery wait across rebootstrap.
    std::fs::write(&path,format!("{end}{{\"type\":\"queue-operation\",\"operation\":\"enqueue\",\"uuid\":\"queued\",\"timestamp\":\"2026-10-08T05:22:02Z\",\"content\":\"<task-notification><task-id>id-00592</task-id><status>completed</status></task-notification>\"}}\n")).unwrap();
    let queued = refresh_autonomy(
        Some(
            bootstrap_transcript_seeded(
                &path,
                "claude",
                &binding(),
                "test",
                None,
                None,
                MAX_BOOTSTRAP_BYTES,
                Some(&prior),
            )
            .unwrap(),
        ),
        Some(&prior),
        now + 3000,
        None,
    )
    .unwrap();
    let state = queued.brief.autonomy.unwrap();
    assert_eq!(state.armed_background_count, 0);
    assert_eq!(state.pending_notification_count, 1);
    // A terminal record in the replacement must not resurrect previous work.
    std::fs::write(&path,format!("{end}{{\"type\":\"user\",\"uuid\":\"terminal\",\"timestamp\":\"2026-10-08T05:22:02Z\",\"message\":{{\"content\":\"<task-notification><task-id>id-00592</task-id><status>completed</status></task-notification>\"}}}}\n")).unwrap();
    let terminal = refresh_autonomy(
        Some(
            bootstrap_transcript_seeded(
                &path,
                "claude",
                &binding(),
                "test",
                None,
                None,
                MAX_BOOTSTRAP_BYTES,
                Some(&prior),
            )
            .unwrap(),
        ),
        Some(&prior),
        now + 3000,
        None,
    )
    .unwrap();
    assert_eq!(terminal.brief.autonomy.unwrap().armed_background_count, 0);
}

#[test]
fn f4_bounded_window_cannot_prove_background_empty_from_an_end_marker() {
    use super::autonomy::BackgroundState;
    let dir = tempfile::tempdir().unwrap(); let _unit_home = crate::unit_test_dirs::fixture_home(&dir);
    let path = dir.path().join("long.jsonl");
    let filler = "x".repeat(4096);
    std::fs::write(&path,format!("{{\"type\":\"future-record\",\"timestamp\":\"2026-10-08T05:20:00Z\",\"padding\":\"{filler}\"}}\n{{\"type\":\"assistant\",\"uuid\":\"end\",\"timestamp\":\"2026-10-08T05:22:00Z\",\"message\":{{\"stop_reason\":\"end_turn\",\"content\":[]}}}}\n")).unwrap();
    let next = bootstrap_transcript_windowed(&path, "claude", &binding(), "test", None, None, 512)
        .unwrap();
    let state = next.brief.autonomy.unwrap();
    assert_eq!(state.turn_state, TurnState::Complete);
    assert_eq!(state.background_state, BackgroundState::Unknown);
    let current = next.adapter.autonomy_at(
        adapter::parse_timestamp("2026-10-08T05:23:00Z").unwrap(),
        Some(adapter::parse_timestamp("2026-10-08T05:22:01Z").unwrap()),
    );
    assert_eq!(
        current.background_state,
        BackgroundState::Known,
        "window predates process birth"
    );
}

#[test]
fn f5_delayed_duplicate_completion_does_not_advance_the_turn_clock() {
    let mut d = Driver::new("claude");
    d.user("work");
    d.complete();
    let before = d.autonomy(0);
    let last = d.adapter.autonomy_last_event_at();
    d.at += 17_000;
    d.add(json!({"type":"system","subtype":"turn_duration","durationMs":17000}));
    assert_eq!(d.autonomy(0), before);
    assert_eq!(d.adapter.autonomy_last_event_at(), last);
    d.user("next task");
    assert!(d.autonomy(0).turn_started_at > before.turn_started_at);
}

#[test]
fn f6_queued_terminal_notifications_remain_autonomous_until_model_delivery() {
    for absorbed in [false, true] {
        let mut d = Driver::monitor();
        let notice = "<task-notification><task-id>id-00592</task-id><status>completed</status></task-notification>";
        d.add(json!({"type":"queue-operation","operation":"enqueue","content":notice}));
        assert_eq!(d.autonomy(0).armed_background_count, 0);
        assert_eq!(d.autonomy(0).pending_notification_count, 1);
        d.add(json!({"type":"queue-operation","operation":"dequeue"}));
        assert_eq!(
            d.autonomy(0).pending_notification_count,
            1,
            "dequeue is not model delivery"
        );
        if absorbed {
            d.add(json!({"type":"queue-operation","operation":"remove","reason":"absorbed_mid_turn","content":notice}));
        } else {
            d.user(notice);
        }
        assert_eq!(d.autonomy(0).pending_notification_count, 0);
        assert_eq!(d.autonomy(0).turn_state, TurnState::Active);
        d.complete();
        assert_eq!(d.autonomy(0).turn_state, TurnState::Complete);
    }
}

#[test]
fn f6_notifications_without_a_proven_start_remain_ignored() {
    let mut d = Driver::new("claude");
    d.user("work");
    d.complete();
    let before = d.autonomy(0);
    let last = d.adapter.autonomy_last_event_at();
    d.add(json!({"type":"queue-operation","operation":"enqueue","content":"<task-notification><task-id>unknown</task-id><status>completed</status></task-notification>"}));
    assert_eq!(d.autonomy(0), before);
    assert_eq!(d.adapter.autonomy_last_event_at(), last);
}

#[test]
fn f7_task_stop_only_removes_work_after_confirmed_success() {
    for failure in ["unreturned", "error", "denied"] {
        let mut d = Driver::new("claude");
        d.user("work");
        d.tool("background", "Bash", json!({"run_in_background":true}));
        d.result("background", json!({"backgroundTaskId":"task"}));
        d.complete();
        d.tool("stop", "TaskStop", json!({"task_id":"task"}));
        if failure != "unreturned" {
            d.add(json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"stop","is_error":true,"content":failure}]},"toolUseResult":{"success":false,"task_id":"task"}}));
            d.complete();
        }
        assert_eq!(d.autonomy(0).armed_background_count, 1, "{failure}");
    }
    let mut d = Driver::monitor();
    d.tool("stop", "TaskStop", json!({"task_id":"id-00592"}));
    d.result("stop",json!({"task_id":"id-00592","task_type":"monitor","command":"watch","message":"Successfully stopped task"}));
    d.complete();
    assert_eq!(d.autonomy(0).armed_background_count, 0);
}

#[test]
fn g5_rebootstrap_applies_abort_to_inherited_tools_and_notifications_before_a_new_turn() {
    for provider in ["claude", "codex"] {
        let dir = tempfile::tempdir().unwrap(); let _unit_home = crate::unit_test_dirs::fixture_home(&dir);
        let path = dir.path().join("replace.jsonl");
        let at = adapter::parse_timestamp("2026-10-08T05:22:00Z").unwrap();
        let prior_rows = if provider == "claude" {
            include_str!("../../../tests/fixtures/livebrief_autonomy/claude-monitor.jsonl").to_owned()
                + "{\"uuid\":\"open\",\"timestamp\":\"2026-10-08T05:22:01Z\",\"type\":\"assistant\",\"message\":{\"stop_reason\":\"tool_use\",\"content\":[{\"type\":\"tool_use\",\"id\":\"open\",\"name\":\"Bash\",\"input\":{}}]}}\n"
                + "{\"uuid\":\"queued\",\"timestamp\":\"2026-10-08T05:22:02Z\",\"type\":\"queue-operation\",\"operation\":\"enqueue\",\"content\":\"<task-notification><task-id>id-00592</task-id><status>completed</status></task-notification>\"}\n"
        } else {
            "{\"uuid\":\"start\",\"timestamp\":\"2026-10-08T05:22:00Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n".to_owned()
                + "{\"uuid\":\"call\",\"timestamp\":\"2026-10-08T05:22:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call\",\"call_id\":\"open\",\"name\":\"sleep\",\"input\":\"long\"}}\n"
        };
        std::fs::write(&path, prior_rows).unwrap();
        let mut b = binding();
        b.agent_kind = provider.into();
        let prior = bootstrap_transcript(&path, provider, &b, "test").unwrap();
        assert_eq!(prior.brief.autonomy.as_ref().unwrap().open_tool_count, 1);
        if provider == "claude" {
            assert_eq!(
                prior
                    .brief
                    .autonomy
                    .as_ref()
                    .unwrap()
                    .pending_notification_count,
                1
            );
        }
        let mut abort = if provider == "claude" {
            json!({"type":"user","message":{"content":"[Request interrupted by user]"}})
        } else {
            json!({"type":"event_msg","payload":{"type":"turn_aborted"}})
        };
        abort["timestamp"] = json!("2026-10-08T05:22:03Z");
        abort["uuid"] = json!("abort-new");
        std::fs::write(&path, abort.to_string() + "\n").unwrap();
        let ready = match apply_known_transcript_path(
            Some(&prior),
            &path,
            &b,
            provider,
            "test",
            None,
            None,
            AdvanceFailAction::Bootstrap,
        ) {
            PathApply::Ready(snapshot) => snapshot,
            _ => panic!("replacement must bootstrap"),
        };
        let current = refresh_autonomy(Some(ready), Some(&prior), at + 4000, None).unwrap();
        let state = current.brief.autonomy.as_ref().unwrap();
        assert_eq!(state.turn_state, TurnState::Complete);
        assert_eq!(
            (
                state.open_tool_count,
                state.pending_notification_count,
                state.armed_background_count
            ),
            (0, 0, 0)
        );
        let mut d = Driver::new(provider);
        d.adapter = current.adapter.clone();
        d.reducer = current.reducer.clone();
        d.at = at + 5000;
        if provider == "claude" {
            d.user("next");
            d.complete();
        } else {
            d.add(json!({"type":"event_msg","payload":{"type":"task_started"}}));
            d.add(json!({"type":"event_msg","payload":{"type":"task_complete"}}));
        }
        assert_eq!(d.autonomy(0).open_tool_count, 0);
        assert_eq!(d.autonomy(0).pending_notification_count, 0);
        assert_eq!(d.autonomy(0).turn_state, TurnState::Complete);
    }
}

#[test]
fn g1_g5_rebootstrap_preserves_current_questions_and_their_evidence_without_old_user_history() {
    for (provider, tool) in [
        ("codex", "request_user_input"),
        ("codex", "request_permissions"),
        ("claude", "AskUserQuestion"),
    ] {
        let dir = tempfile::tempdir().unwrap(); let _unit_home = crate::unit_test_dirs::fixture_home(&dir);
        let path = dir.path().join("question.jsonl");
        let input = json!({"question":"Current question", "options":["yes","no"]});
        let mut question = if provider == "codex" {
            json!({"type":"response_item","payload":{"type":"function_call","call_id":"q","name":tool,"arguments":input.to_string()}})
        } else {
            json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"q","name":tool,"input":input}]}})
        };
        question["uuid"] = json!("current-question");
        question["timestamp"] = json!("2026-10-08T05:22:01Z");
        let at = adapter::parse_timestamp("2026-10-08T05:22:00Z").unwrap();
        let mut b = binding();
        b.agent_kind = provider.into();
        std::fs::write(&path, question.to_string() + "\n").unwrap();
        let prior = bootstrap_transcript(&path, provider, &b, "test").unwrap();
        assert_eq!(prior.brief.operational_state, "needsHuman");
        let row = if provider == "codex" {
            json!({"uuid":"new-activity","timestamp":"2026-10-08T05:22:02Z","type":"event_msg","payload":{"type":"agent_message","message":"working"}})
        } else {
            json!({"uuid":"new-activity","timestamp":"2026-10-08T05:22:02Z","type":"assistant","message":{"content":[{"type":"text","text":"working"}]}})
        };
        for overlapping in [false, true] {
            let body = if overlapping {
                question.to_string() + "\n" + &row.to_string() + "\n"
            } else {
                row.to_string() + "\n"
            };
            std::fs::write(&path, body).unwrap();
            let next = bootstrap_transcript_seeded(
                &path,
                provider,
                &b,
                "test",
                None,
                None,
                MAX_BOOTSTRAP_BYTES,
                Some(&prior),
            )
            .unwrap();
            let current =
                refresh_autonomy(Some(next), Some(&prior), at + 3000, Some(at + 500)).unwrap();
            assert_eq!(current.brief.prompt_hash, prior.brief.prompt_hash);
            assert_eq!(current.brief.operational_state, "needsHuman");
            assert!(current.events.iter().any(|event| matches!(&event.kind,
                SemanticEventKind::Question { prompt_event_id, .. } if Some(prompt_event_id) == current.brief.prompt_event_id.as_ref())));
            let retired =
                refresh_autonomy(None, Some(&current), at + 4000, Some(at + 3500)).unwrap();
            assert!(retired.brief.prompt_hash.is_none());
            assert_ne!(retired.brief.operational_state, "needsHuman");
        }
    }
}

#[test]
fn g5_reused_byte_range_in_a_replacement_is_not_a_duplicate_abort() {
    let dir = tempfile::tempdir().unwrap(); let _unit_home = crate::unit_test_dirs::fixture_home(&dir);
    let path = dir.path().join("same-range.jsonl");
    let call = json!({"timestamp":"2026-10-08T05:22:01Z","type":"response_item","payload":{
        "type":"custom_tool_call","call_id":"open","name":"sleep","input":"long"}});
    let mut before = call.to_string();
    before.push('\n');
    std::fs::write(&path, &before).unwrap();
    let mut b = binding();
    b.agent_kind = "codex".into();
    let prior = bootstrap_transcript(&path, "codex", &b, "test").unwrap();
    assert_eq!(prior.brief.autonomy.as_ref().unwrap().open_tool_count, 1);
    let mut after = json!({"timestamp":"2026-10-08T05:22:03Z","type":"event_msg","payload":{"type":"turn_aborted"}}).to_string();
    assert!(after.len() < before.len());
    after.push_str(&" ".repeat(before.len() - after.len() - 1));
    after.push('\n');
    assert_eq!(after.len(), before.len());
    std::fs::write(&path, after).unwrap();
    let next = bootstrap_transcript_seeded(
        &path,
        "codex",
        &b,
        "test",
        None,
        None,
        MAX_BOOTSTRAP_BYTES,
        Some(&prior),
    )
    .unwrap();
    let current = refresh_autonomy(
        Some(next),
        Some(&prior),
        adapter::parse_timestamp("2026-10-08T05:22:04Z").unwrap(),
        None,
    )
    .unwrap();
    let state = current.brief.autonomy.unwrap();
    assert_eq!(
        (state.turn_state, state.open_tool_count),
        (TurnState::Complete, 0)
    );
    assert!(current.brief.pending_prompt.is_none());
}

#[test]
fn g5_rebootstrap_matches_an_inherited_task_stop_call_to_its_success_result() {
    let dir = tempfile::tempdir().unwrap(); let _unit_home = crate::unit_test_dirs::fixture_home(&dir);
    let path = dir.path().join("stop.jsonl");
    let source=include_str!("../../../tests/fixtures/livebrief_autonomy/claude-monitor.jsonl").to_owned()
        + "{\"uuid\":\"stop-call\",\"timestamp\":\"2026-10-08T05:22:01Z\",\"type\":\"assistant\",\"message\":{\"stop_reason\":\"tool_use\",\"content\":[{\"type\":\"tool_use\",\"id\":\"stop\",\"name\":\"TaskStop\",\"input\":{\"task_id\":\"id-00592\"}}]}}\n";
    std::fs::write(&path, source).unwrap();
    let prior = bootstrap_transcript(&path, "claude", &binding(), "test").unwrap();
    std::fs::write(&path,
        "{\"uuid\":\"stop-result\",\"timestamp\":\"2026-10-08T05:22:02Z\",\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"stop\",\"content\":\"ok\"}]},\"toolUseResult\":{\"task_id\":\"id-00592\",\"stopped\":true}}\n".to_owned()
        + "{\"uuid\":\"end\",\"timestamp\":\"2026-10-08T05:22:03Z\",\"type\":\"assistant\",\"message\":{\"stop_reason\":\"end_turn\",\"content\":[]}}\n").unwrap();
    let ready = match apply_known_transcript_path(
        Some(&prior),
        &path,
        &binding(),
        "claude",
        "test",
        None,
        None,
        AdvanceFailAction::Bootstrap,
    ) {
        PathApply::Ready(snapshot) => snapshot,
        _ => panic!("replacement must bootstrap"),
    };
    let current = refresh_autonomy(
        Some(ready),
        Some(&prior),
        adapter::parse_timestamp("2026-10-08T05:22:04Z").unwrap(),
        None,
    )
    .unwrap();
    let state = current.brief.autonomy.as_ref().unwrap();
    assert_eq!(
        (state.open_tool_count, state.armed_background_count),
        (0, 0)
    );
    let mut d = Driver::new("claude");
    d.adapter = current.adapter;
    d.reducer = current.reducer;
    d.user("new");
    d.complete();
    assert_eq!(d.autonomy(0).armed_background_count, 0);
}

#[test]
fn g6_overlapping_notifications_preserve_the_undelivered_later_notice() {
    for identified in [false, true] {
        for remove_first in [false, true] {
            let mut d = Driver::monitor();
            let a = "<task-notification><task-id>id-00592</task-id></task-notification>";
            let b="<task-notification><task-id>id-00592</task-id><status>completed</status></task-notification>";
            let queue = |content: &str, id: &str| {
                let mut row =
                    json!({"type":"queue-operation","operation":"enqueue","content":content});
                if identified {
                    row["commandUuid"] = json!(id);
                }
                row
            };
            let delivered = |content: &str, id: &str, removed: bool| {
                let mut row = if removed {
                    json!({"type":"queue-operation","operation":"remove","reason":"absorbed_mid_turn","content":content})
                } else {
                    json!({"type":"user","message":{"content":content}})
                };
                if identified {
                    row["commandUuid"] = json!(id);
                }
                row
            };
            d.add(queue(a, "A"));
            d.add(json!({"type":"queue-operation","operation":"dequeue"}));
            d.add(queue(b, "B"));
            assert_eq!(d.autonomy(0).pending_notification_count, 2);
            d.add(delivered(a, "A", remove_first));
            d.add(delivered(a, "A", !remove_first));
            d.complete();
            assert_eq!(d.autonomy(0).armed_background_count, 0);
            assert_eq!(d.autonomy(0).pending_notification_count, 1);
            assert_eq!(d.autonomy(0).turn_state, TurnState::Complete);
            d.add(delivered(b, "B", false));
            d.complete();
            assert_eq!(d.autonomy(0).pending_notification_count, 0);
        }
    }
}

#[test]
fn g6_identical_unidentified_notices_are_counted_and_remove_user_are_not_double_delivery() {
    let mut d = Driver::monitor();
    let text="<task-notification><task-id>id-00592</task-id><status>completed</status></task-notification>";
    for _ in 0..2 {
        d.add(json!({"type":"queue-operation","operation":"enqueue","content":text}));
    }
    assert_eq!(d.autonomy(0).pending_notification_count, 2);
    d.add(json!({"type":"queue-operation","operation":"remove","reason":"absorbed_mid_turn","content":text,"commandUuid":"introduced-only-on-remove","deliveryId":"delivery-A"}));
    d.user(text);
    d.complete();
    assert_eq!(d.autonomy(0).pending_notification_count, 1);
    d.user(text);
    d.complete();
    assert_eq!(d.autonomy(0).pending_notification_count, 0);
}

#[test]
fn g6_distinct_enqueue_records_at_the_same_millisecond_are_counted_separately() {
    let mut d = Driver::monitor();
    let text = "<task-notification><task-id>id-00592</task-id><status>completed</status></task-notification>";
    d.add(json!({"type":"queue-operation","operation":"enqueue","content":text}));
    d.at -= 1_000; // The next distinct native record has the same timestamp.
    d.add(json!({"type":"queue-operation","operation":"enqueue","content":text}));
    assert_eq!(d.autonomy(0).pending_notification_count, 2);
    d.user(text);
    d.complete();
    assert_eq!(d.autonomy(0).pending_notification_count, 1);
    d.user(text);
    d.complete();
    assert_eq!(d.autonomy(0).pending_notification_count, 0);
}

#[test]
fn h4_mixed_delivery_routes_match_each_enqueue_and_finish_with_no_pending_notice() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../tests/fixtures/livebrief_autonomy/notification-delivery-cases.json"
    ))
    .unwrap();
    for case in cases {
        let mut driver = Driver::monitor();
        for step in case["steps"].as_array().unwrap() {
            driver.add(step["record"].clone());
            let state = serde_json::to_value(driver.autonomy(0)).unwrap();
            for (key, expected) in step["expected"].as_object().unwrap() {
                assert_eq!(&state[key], expected, "{} {key}", case["name"]);
            }
        }
        let state = driver.autonomy(0);
        assert_eq!(state.turn_state, TurnState::Complete);
        // ANSWER-FIX5-1 changes only this indistinguishable anonymous case.
        let ambiguous = case["name"] == "J3 dequeue A before enqueue B then user A and late-ID remove B";
        assert_eq!(state.pending_notification_count, if ambiguous { 1 } else { 0 });
        assert_eq!(state.open_tool_count, 0);
        assert_eq!(state.armed_background_count, 0);
    }
}

#[test]
fn h2_truncated_history_leaves_known_long_work_intact_and_exports_the_last_event_clock() {
    // The 30-minute unknown display deadline belongs only to TS. Rust exports
    // truthful unknown/count evidence; fresh polling is not a transcript event.
    let mut d = Driver::new("claude");
    d.adapter.mark_truncated_history();
    d.user("work");
    d.complete();
    let at = d.brief(0, None).last_event_at;
    let later = d.brief(24 * 60 * 60_000, None);
    assert_eq!(later.last_event_at, at);
    assert_eq!(
        later.autonomy.unwrap().background_state,
        super::autonomy::BackgroundState::Unknown
    );
    d.tool("background", "Bash", json!({"run_in_background":true}));
    d.result("background", json!({"backgroundTaskId":"known-long-bash"}));
    d.complete();
    let state = d.autonomy(24 * 60 * 60_000);
    assert_eq!(state.armed_background_count, 1);
    assert_eq!(
        state.background_state,
        super::autonomy::BackgroundState::Unknown
    );
}

struct Driver {
    adapter: AgentAdapter,
    reducer: LiveBriefReducer,
    seq: u64,
    at: i64,
}

impl Driver {
    fn new(kind: &str) -> Self {
        Self {
            adapter: AgentAdapter::new(kind).unwrap(),
            reducer: LiveBriefReducer::new(),
            seq: 0,
            at: 1_790_000_000_000,
        }
    }

    fn raw(&mut self, raw: &str) {
        self.seq += 1;
        if let Some(at) = serde_json::from_str::<Value>(raw)
            .unwrap()
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(adapter::parse_timestamp)
        {
            self.at = at;
        }
        for event in self
            .adapter
            .decode_record(
                raw,
                ByteRange {
                    start: self.seq * 100,
                    end: self.seq * 100 + 99,
                },
                self.seq,
            )
            .unwrap()
        {
            self.reducer.apply(&event);
        }
    }

    fn add(&mut self, mut value: Value) {
        self.at += 1_000;
        value["timestamp"] = json!(chrono::DateTime::from_timestamp_millis(self.at)
            .unwrap()
            .to_rfc3339());
        value["uuid"] = json!(format!("record-{}", self.seq + 1));
        self.raw(&value.to_string());
    }

    fn brief(&self, elapsed_ms: i64, process_start: Option<i64>) -> LiveSessionBrief {
        let now = self.at + elapsed_ms;
        let mut brief = self.reducer.to_brief(binding(), "live", "test", now);
        apply_autonomy(&self.adapter, &mut brief, now, process_start);
        brief
    }

    fn autonomy(&self, elapsed_ms: i64) -> SessionAutonomy {
        self.brief(elapsed_ms, None).autonomy.unwrap()
    }

    fn user(&mut self, text: &str) {
        self.add(json!({"type":"user","message":{"role":"user","content":text}}));
    }
    fn tool(&mut self, id: &str, name: &str, input: Value) {
        self.add(json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":id,"name":name,"input":input}],"stop_reason":"tool_use"}}));
    }
    fn result(&mut self, id: &str, result: Value) {
        self.add(json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":"ok"}]},"toolUseResult":result}));
    }
    fn complete(&mut self) {
        self.add(json!({"type":"assistant","message":{"content":[{"type":"text","text":"finished"}],"stop_reason":"end_turn"}}));
        self.add(json!({"type":"system","subtype":"turn_duration","durationMs":1000}));
    }
    fn monitor() -> Self {
        let mut driver = Self::new("claude");
        for line in
            include_str!("../../../tests/fixtures/livebrief_autonomy/claude-monitor.jsonl").lines()
        {
            driver.raw(line);
        }
        driver
    }
}

fn binding() -> LiveBinding {
    LiveBinding {
        pty_session_id: "pty".into(),
        agent_session_id: "agent".into(),
        agent_kind: "claude".into(),
        pty_instance_id: "instance".into(),
        pty_generation: 1,
        source_revision: 1,
        pty_input_revision: 1,
    }
}

#[test]
fn t1_claude_open_tool_remains_active_after_twelve_quiet_minutes() {
    let mut d = Driver::new("claude");
    d.user("work");
    d.tool("call", "Bash", json!({"command":"long command"}));
    let state = d.autonomy(12 * 60_000);
    assert_eq!(state.turn_state, TurnState::Active);
    assert_eq!(state.open_tool_count, 1);
}

#[test]
fn t2_tool_result_does_not_end_the_model_response_wait() {
    let mut d = Driver::new("claude");
    d.user("work");
    d.tool("call", "Bash", json!({}));
    d.result("call", json!({}));
    let state = d.autonomy(7 * 60_000);
    assert_eq!(state.turn_state, TurnState::Active);
    assert_eq!(state.open_tool_count, 0);
}

#[test]
fn t3_end_turn_and_turn_duration_complete_immediately_in_either_order() {
    for duration_first in [false, true] {
        let mut d = Driver::new("claude");
        d.user("work");
        let duration = json!({"type":"system","subtype":"turn_duration","durationMs":1000});
        let end = json!({"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"finished"}]}});
        for row in if duration_first {
            [duration, end]
        } else {
            [end, duration]
        } {
            d.add(row);
        }
        for elapsed in [0, 5 * 60_000, 60 * 60_000] {
            assert_eq!(d.autonomy(elapsed).turn_state, TurnState::Complete);
            assert_eq!(d.autonomy(elapsed).armed_background_count, 0);
        }
    }
}

#[test]
fn t4_real_monitor_skeleton_arms_one_background_after_completion() {
    let d = Driver::monitor();
    assert_eq!(d.autonomy(0).turn_state, TurnState::Complete);
    assert_eq!(d.autonomy(0).open_tool_count, 0);
    assert_eq!(d.autonomy(0).armed_background_count, 1);
}

#[test]
fn t5_terminal_notification_resumes_then_completes_without_background() {
    let mut d = Driver::monitor();
    d.add(json!({"type":"queue-operation","operation":"enqueue","content":"<task-notification><task-id>id-00592</task-id></task-notification>"}));
    assert_eq!(
        d.autonomy(0).armed_background_count,
        1,
        "nonterminal notification preserves monitor"
    );
    d.add(json!({"type":"queue-operation","operation":"enqueue","content":"<task-notification><task-id>id-00592</task-id><status>completed</status></task-notification>"}));
    assert_eq!(d.autonomy(0).armed_background_count, 0);
    d.user("<task-notification><task-id>id-00592</task-id><status>completed</status></task-notification>");
    assert_eq!(d.autonomy(0).turn_state, TurnState::Active);
    d.complete();
    assert_eq!(d.autonomy(0).turn_state, TurnState::Complete);
    assert_eq!(d.autonomy(0).armed_background_count, 0);
}

#[test]
fn t6_background_command_lives_until_a_terminal_notification() {
    for status in ["completed", "killed", "failed", "stopped"] {
        let mut d = Driver::new("claude");
        d.user("work");
        d.tool("call", "Bash", json!({"run_in_background":true}));
        d.result(
            "call",
            json!({"backgroundTaskId":"task","interrupted":false,"stdout":"","stderr":""}),
        );
        d.complete();
        assert_eq!(d.autonomy(60 * 60_000).armed_background_count, 1);
        d.add(json!({"type":"queue-operation","operation":"enqueue","content":format!("<task-notification><task-id>task</task-id><status>{status}</status></task-notification>")}));
        assert_eq!(d.autonomy(0).armed_background_count, 0);
        assert_eq!(d.autonomy(0).turn_state, TurnState::Complete);
    }
}

#[test]
fn t7_monitor_expires_after_its_timeout_and_one_minute_grace() {
    let mut d = Driver::new("claude");
    d.user("work");
    d.tool("call", "Monitor", json!({}));
    d.result(
        "call",
        json!({"taskId":"monitor","timeoutMs":1800000,"persistent":false}),
    );
    let started = d.at;
    d.complete();
    assert_eq!(
        d.adapter
            .autonomy_at(started + 1_860_000, None)
            .armed_background_count,
        1
    );
    assert_eq!(
        d.adapter
            .autonomy_at(started + 1_860_001, None)
            .armed_background_count,
        0
    );
}

#[test]
fn t8_scheduled_wakeup_expires_after_the_scheduled_time_and_grace() {
    let mut d = Driver::new("claude");
    d.user("work");
    d.tool("call", "ScheduleWakeup", json!({}));
    let scheduled = d.at + 600_000;
    d.result("call", json!({"scheduledFor":chrono::DateTime::from_timestamp_millis(scheduled).unwrap().to_rfc3339(),"clampedDelaySeconds":600,"wasClamped":false}));
    d.complete();
    assert_eq!(
        d.adapter
            .autonomy_at(scheduled - 1, None)
            .armed_background_count,
        1
    );
    assert_eq!(
        d.adapter
            .autonomy_at(scheduled + 60_001, None)
            .armed_background_count,
        0
    );
}

#[test]
fn t9_async_agent_arms_work_but_a_synchronous_agent_does_not() {
    for asynchronous in [true, false] {
        let mut d = Driver::new("claude");
        d.user("work");
        d.tool("call", "Agent", json!({}));
        d.result(
            "call",
            json!({"agentId":"agent","isAsync":asynchronous,"status":"running"}),
        );
        d.complete();
        assert_eq!(
            d.autonomy(60 * 60_000).armed_background_count,
            usize::from(asynchronous)
        );
    }
}

#[test]
fn t10_question_keeps_the_existing_intervention_state_during_an_active_turn() {
    let mut d = Driver::new("claude");
    d.user("work");
    d.tool(
        "ask",
        "AskUserQuestion",
        json!({"question":"Continue?","options":["yes","no"]}),
    );
    let brief = d.brief(12 * 60_000, None);
    assert_eq!(brief.operational_state, "needsHuman");
    assert_eq!(brief.autonomy.unwrap().turn_state, TurnState::Active);
    assert!(brief.prompt_hash.is_some());
}

#[test]
fn t11_error_does_not_clear_an_active_turn_or_change_operational_state() {
    let mut d = Driver::new("claude");
    d.user("work");
    d.tool("call", "Bash", json!({}));
    d.add(json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call","is_error":true,"content":"Error: rate limit reached"}]}}));
    let brief = d.brief(0, None);
    assert_eq!(brief.autonomy.unwrap().turn_state, TurnState::Active);
    assert_eq!(brief.operational_state, "running");
}

#[test]
fn t12_process_restart_excludes_prior_monitors_even_without_new_transcript_bytes() {
    let d = Driver::monitor();
    assert_eq!(d.brief(0, None).autonomy.unwrap().armed_background_count, 1);
    assert_eq!(
        d.brief(0, Some(d.at + 1))
            .autonomy
            .unwrap()
            .armed_background_count,
        0
    );
}

#[test]
fn t13_real_codex_sleep_call_remains_open_after_thirty_minutes() {
    let mut d = Driver::new("codex");
    for line in
        include_str!("../../../tests/fixtures/livebrief_autonomy/codex-open-sleep.jsonl").lines()
    {
        d.raw(line);
    }
    let state = d.autonomy(30 * 60_000);
    assert_eq!(state.turn_state, TurnState::Active);
    assert_eq!(state.open_tool_count, 1);
}

#[test]
fn t14_real_codex_task_complete_is_a_completion_boundary() {
    let mut d = Driver::new("codex");
    for line in
        include_str!("../../../tests/fixtures/livebrief_autonomy/codex-complete.jsonl").lines()
    {
        d.raw(line);
    }
    assert_eq!(d.autonomy(0).turn_state, TurnState::Complete);
}

#[test]
fn t15_codex_abort_closes_an_unreturned_custom_tool_call() {
    let mut d = Driver::new("codex");
    d.add(json!({"type":"event_msg","payload":{"type":"task_started"}}));
    d.add(json!({"type":"response_item","payload":{"type":"custom_tool_call","call_id":"call","name":"apply_patch","input":"patch"}}));
    d.add(json!({"type":"event_msg","payload":{"type":"turn_aborted"}}));
    assert_eq!(d.autonomy(0).turn_state, TurnState::Complete);
    assert_eq!(d.autonomy(0).open_tool_count, 0);
}

#[test]
fn unknown_malformed_and_sidechain_records_preserve_the_last_known_state() {
    let mut d = Driver::monitor();
    let before = d.autonomy(0);
    d.add(json!({"type":"future-record","payload":{"type":"future-event"}}));
    d.add(json!({"type":"user","isSidechain":true,"message":{"content":"subagent prompt"}}));
    d.add(json!({"type":"queue-operation","content":"<task-notification><task-id>unknown</task-id><status>completed</status></task-notification>"}));
    assert!(d
        .adapter
        .decode_record(
            "{bad",
            ByteRange {
                start: 9000,
                end: 9004
            },
            999
        )
        .is_err());
    assert_eq!(d.autonomy(0), before);
}

#[test]
fn interruption_task_stop_and_schedule_stop_clear_the_right_work() {
    let mut d = Driver::monitor();
    d.tool("stop", "TaskStop", json!({"task_id":"id-00592"}));
    assert_eq!(d.autonomy(0).armed_background_count, 1);
    d.result(
        "stop",
        json!({"task_id":"id-00592","task_type":"monitor","message":"Successfully stopped task"}),
    );
    assert_eq!(d.autonomy(0).armed_background_count, 0);
    d.user("[Request interrupted by user for tool use]");
    assert_eq!(d.autonomy(0).turn_state, TurnState::Complete);
    assert_eq!(d.autonomy(0).open_tool_count, 0);
    d.tool("wake", "ScheduleWakeup", json!({}));
    d.result("wake", json!({"scheduledFor":chrono::DateTime::from_timestamp_millis(d.at + 600_000).unwrap().to_rfc3339()}));
    d.tool("stop-wake", "ScheduleWakeup", json!({"stop":true}));
    d.result("stop-wake", json!({"stopped":true,"cancelledWakeups":1}));
    assert_eq!(d.autonomy(0).armed_background_count, 0);
}

#[test]
fn expiry_changes_the_cached_brief_without_a_transcript_reread() {
    let dir = tempfile::tempdir().unwrap(); let _unit_home = crate::unit_test_dirs::fixture_home(&dir);
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures/livebrief_autonomy/claude-monitor.jsonl");
    let snapshot = bootstrap_transcript(&path, "claude", &binding(), "test").unwrap();
    assert!(dir.path().join(".mycmux/history.db").is_file(), "history must be in this explicit fixture");
    let before = refresh_autonomy(
        Some(snapshot),
        None,
        adapter::parse_timestamp("2026-10-08T05:21:08.855Z").unwrap(),
        None,
    )
    .unwrap();
    assert_eq!(
        before
            .brief
            .autonomy
            .as_ref()
            .unwrap()
            .armed_background_count,
        1
    );
    let after = refresh_autonomy(
        None,
        Some(&before),
        adapter::parse_timestamp("2026-10-08T06:00:00Z").unwrap(),
        None,
    )
    .unwrap();
    assert_eq!(
        after
            .brief
            .autonomy
            .as_ref()
            .unwrap()
            .armed_background_count,
        0
    );
    assert_eq!(
        after.brief.binding.source_revision,
        before.brief.binding.source_revision
    );
    assert!(refresh_autonomy(
        None,
        Some(&after),
        adapter::parse_timestamp("2026-10-08T06:01:00Z").unwrap(),
        None
    )
    .is_none());
}

#[test]
fn truncated_history_is_unknown_until_a_proven_boundary_and_old_briefs_deserialize() {
    let mut d = Driver::new("claude");
    d.adapter.mark_truncated_history();
    assert_eq!(d.autonomy(0).turn_state, TurnState::Unknown);
    d.complete();
    assert_eq!(d.autonomy(0).turn_state, TurnState::Complete);
    let mut json = serde_json::to_value(d.brief(0, None)).unwrap();
    json.as_object_mut().unwrap().remove("autonomy");
    assert!(serde_json::from_value::<LiveSessionBrief>(json)
        .unwrap()
        .autonomy
        .is_none());
}
