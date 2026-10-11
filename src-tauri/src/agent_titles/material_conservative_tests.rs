//! Generated evidence from the real adapter, reducer and both naming readers.
use super::*;
use crate::livebrief::{LiveBinding, LiveBriefReducer};
use serde_json::{json, Value};

fn naming_request(id: &str) -> NamingRequest {
    NamingRequest { pty_session_id: format!("pty-{id}"), title: TitleRequest {
        tab_id: id.into(), agent_kind: "claude".into(), agent_session_id: Some(format!("agent-{id}")), cwd: "/fixture".into(),
    } }
}
fn user_record(index: usize, text: &str) -> Value {
    json!({"type":"user", "uuid":format!("u-{index}"), "message":{"role":"user", "content":text}})
}
fn question_record() -> Value {
    json!({"type":"assistant", "uuid":"q", "message":{"role":"assistant", "content":[
        {"type":"tool_use", "id":"ask", "name":"AskUserQuestion", "input":{"question":"Which task?", "options":["A","B"]}}
    ]}})
}
fn resolved_record() -> Value {
    json!({"type":"user", "uuid":"resolved", "message":{"role":"user", "content":[
        {"type":"tool_result", "tool_use_id":"ask", "content":"A"}
    ]}})
}
fn answer_record(text: &str, mode: &str) -> Value {
    if mode == "mixed" {
        json!({"type":"user", "uuid":"answer", "message":{"role":"user", "content":[
            {"type":"text", "text":text}, {"type":"tool_result", "tool_use_id":"ask", "content":text}
        ]}})
    } else { user_record(1, text) }
}
fn frame(id: &str, at: u64, records: &[Value], reader: &str) -> Value {
    let request = naming_request(&format!("{id}-0"));
    let mut adapter = AgentAdapter::new("claude").unwrap();
    let mut reducer = LiveBriefReducer::new();
    let mut events = Vec::new();
    let mut transcript = String::new();
    for (revision, record) in records.iter().enumerate() {
        let raw = serde_json::to_string(record).unwrap();
        let range = ByteRange { start: transcript.len() as u64, end: (transcript.len() + raw.len() + 1) as u64 };
        transcript.push_str(&raw); transcript.push('\n');
        for event in adapter.decode_record(&raw, range, revision as u64).unwrap() {
            reducer.apply(&event); events.push(event);
        }
    }
    let brief = reducer.to_brief(LiveBinding {
        pty_session_id: request.pty_session_id.clone(), agent_session_id: request.title.agent_session_id.clone().unwrap(),
        agent_kind: "claude".into(), pty_instance_id: "instance".into(), pty_generation: 1, source_revision: records.len() as u64, pty_input_revision: 0,
    }, "live", "B11", 2_000_000 + at as i64);
    let material = if reader == "transcript" {
        let path = std::env::temp_dir().join(format!("b11-naming-{}.jsonl", uuid::Uuid::new_v4()));
        std::fs::write(&path, transcript).unwrap();
        let bounded = read_current(&path, "claude", Instant::now() + Duration::from_secs(5));
        std::fs::remove_file(path).unwrap();
        material_from_selection(request, bounded)
    } else { material_from_brief(request, brief.clone(), events.clone()) };
    assert!(material.events.len() <= 24);
    let user_chars: usize = material.events.iter().filter_map(|event| match &event.kind {
        SemanticEventKind::UserMessage {text,..} => Some(text.chars().count()), _ => None,
    }).sum();
    assert!(user_chars + material.latest_instruction.as_ref().map_or(0, |text| text.chars().count()) <= 1600);
    json!({"at":at, "raw_records":records, "brief":brief, "cache_events":events, "material":material})
}

#[test]
fn review_conservative_native_pipeline() {
    let mut cases = Vec::new();
    let tasks = [("動画", "編集", "動画編集"), ("字幕位置", "修正", "字幕位置修正"), ("解説スライド", "制作", "解説スライド制作")];
    let readers = ["live-cached", "live-native", "transcript"];
    for (target, action, old_name) in tasks {
        let initial = format!("{target}を{action}する");
        let answers = [(format!("{target}を{action}してはいけません"), "作業内容未取得"),
            (format!("{target}ではなく解説スライドを作る"), "解説スライド制作"),
            ("次は会議を予約してください".into(), "作業内容未取得"),
            ("はい".into(), old_name), ("A".into(), old_name), ("動画".into(), old_name), ("了解".into(), old_name)];
        for (answer_index, (answer, _prior_expected)) in answers.iter().enumerate() {
            for mode in ["open", "closed", "mixed"] {
                for reader in readers {
                    let id = format!("b11-real-{}", cases.len());
                    let first = vec![user_record(0, &initial)];
                    let mut records = first.clone(); records.push(question_record());
                    if mode == "closed" { records.push(resolved_record()); }
                    records.push(answer_record(answer, mode));
                    let before = frame(&id, 0, &first, reader);
                    let after = frame(&id, 60_000, &records, reader);
                    let actual_kind = after["cache_events"].as_array().unwrap().iter().rev()
                        .find(|event| event["kind"]["type"] == "userMessage").unwrap()["kind"]["kind"].clone();
                    if mode != "closed" {
                        assert_eq!(actual_kind, "answer", "{id}: the generic answer classification must remain unchanged");
                        assert_eq!(after["brief"]["latestInstruction"], initial);
                        assert_eq!(after["material"]["latest_instruction_kind"], "answer");
                        assert_eq!(after["material"]["latest_instruction"], *answer);
                    }
                    let expected = if mode == "closed" && answer_index == 1 { "解説スライド制作" } else { "作業内容未取得" };
                    cases.push(json!({"id":id, "family":"answer", "reader":reader, "expected":expected, "frames":[before, after]}));
                }
            }
        }
    }
    for next in ["解説スライドを作る", "次は会議を予約してください", "動画を編集しない"] {
        for control in ["続きをお願いします", "そのまま続けてください", "引き続きお願いします", "進捗はどうですか", "状況を教えてください", "いつ終わりそうですか"] {
            for quiet in [false, true] {
                for reader in readers {
                    let id = format!("b11-real-{}", cases.len());
                    let first = vec![user_record(0, "動画を編集する")];
                    let changed = vec![first[0].clone(), user_record(1, next)];
                    let mut controlled = changed.clone(); controlled.push(user_record(2, control));
                    let mut frames = vec![frame(&id, 0, &first, reader)];
                    if quiet { frames.push(frame(&id, 60_000, &changed, reader)); }
                    frames.push(frame(&id, if quiet {65_000} else {60_000}, &controlled, reader));
                    cases.push(json!({"id":id, "family":"temporal", "reader":reader,
                        "expected":"作業内容未取得", "frames":frames}));
                }
            }
        }
    }
    for control in ["", "続きをお願いします", "状況を教えてください"] {
        for suffix in ["はいけません。", "は不要です。", "のをやめてください。", "よいですか？", "ください。"] {
            for reader in readers {
                let id = format!("b11-real-{}", cases.len());
                let prefix_length = 1593 - control.chars().count();
                let clipped = format!("引用：「{}」。\n動画を編集して{suffix}", "あ".repeat(prefix_length - 7));
                let first = vec![user_record(0, "動画を編集する")];
                let mut records = vec![first[0].clone(), user_record(1, &clipped)];
                if !control.is_empty() { records.push(user_record(2, control)); }
                let before = frame(&id, 0, &first, reader);
                let after = frame(&id, 60_000, &records, reader);
                assert!(after["material"]["latest_instruction_complete"] == false
                    || !after["material"]["incomplete_event_ids"].as_array().unwrap().is_empty()
                    || !after["material"]["naming_plan"]["coverage"]["characterLoss"].is_null(), "{id}: clipping must have a witness");
                cases.push(json!({"id":id, "family":"budget", "reader":reader, "expected":"作業内容未取得", "frames":[before, after]}));
            }
        }
    }
    for change in ["reject", "positive", "none"] {
        for reader in readers {
            let id = format!("b11-real-{}", cases.len());
            let first = vec![user_record(0, "動画を編集する"), question_record()];
            let mut records = first.clone();
            let mut frames = vec![frame(&id, 0, &first, reader)];
            if change != "none" {
                records.push(user_record(1, if change == "reject" {"動画を編集してはいけません"} else {"解説スライドを作る"}));
                frames.push(frame(&id, 60_000, &records, reader));
            }
            for (index, answer) in ["A", "動画", "はい", "了解"].iter().enumerate() { records.push(user_record(index + 2, answer)); }
            frames.push(frame(&id, if change == "none" {60_000} else {65_000}, &records, reader));
            cases.push(json!({"id":id, "family":"answer-history-loss", "reader":reader, "stableAt":180_000,
                "expected":"作業内容未取得", "frames":frames}));
        }
    }
    for change in ["reject", "positive"] {
        for reader in readers {
            let id = format!("b11-real-{}", cases.len());
            let first = vec![user_record(0, "動画を編集する"), question_record()];
            let mut records = first.clone();
            records.push(user_record(1, if change == "reject" {"動画を編集してはいけません"} else {"解説スライドを作る"}));
            let before = frame(&id, 0, &first, reader);
            let changed = frame(&id, 60_000, &records, reader);
            records.push(resolved_record());
            for index in 2..6 { records.push(user_record(index, "了解")); }
            let after = frame(&id, 65_000, &records, reader);
            cases.push(json!({"id":id, "family":"closed-ack-history-loss", "reader":reader, "stableAt":180_000,
                "expected":"作業内容未取得", "frames":[before,changed,after]}));
        }
    }
    for control in ["続きをお願いします", "状況を教えてください"] {
        for tail in ["動画を編集しない", "動画を編集してよいですか？", "次は会議を予約してください"] {
            for reader in readers {
                let id = format!("b11-real-{}", cases.len());
                let first = vec![user_record(0, "動画を編集する")];
                let clipped = format!("引用：「{}」。\n{control}。{tail}", "あ".repeat(1600 - control.chars().count() - 7));
                let records = vec![first[0].clone(), user_record(1, &clipped)];
                cases.push(json!({"id":id, "family":"clipped-control", "reader":reader, "expected":"作業内容未取得",
                    "frames":[frame(&id,0,&first,reader), frame(&id,60_000,&records,reader)]}));
            }
        }
    }
    assert_eq!(cases.len(), 375);
    if let Ok(path) = std::env::var("B11_RECORD_NATIVE") {
        std::fs::write(path, serde_json::to_string_pretty(&json!({"schema":"B11-native-recording-v1",
            "head":std::env::var("B11_RECORD_HEAD").unwrap_or_default(),
            "product_head":std::env::var("K1_PRODUCT_SHA").unwrap_or_default(),
            "test_source_head":std::env::var("K1_TEST_SHA").unwrap_or_default(),
            "product_tree":std::env::var("K3_PRODUCT_TREE").unwrap_or_default(),
            "test_source_tree":std::env::var("K3_TEST_TREE").unwrap_or_default(), "cases":cases})).unwrap()).unwrap();
    }
}

#[test]
fn bounds_preserve_completeness_even_for_a_partly_consumed_user_budget() {
    for consumed in [0, 9, 21, 79] {
        let text = format!("引用：「{}」。\n動画を編集してはいけません。", "あ".repeat(1586 - consumed));
        let mut input = event_with_text("old", text);
        input.source_byte_start = 1;
        let latest = "あ".repeat(consumed);
        let mut events = vec![input];
        if consumed > 0 { let mut current = event_with_text("latest", latest); current.source_byte_start = 2; events.push(current); }
        let mut state = crate::livebrief::naming::NamingState::default();
        for event in &events { state.observe(event, false); }
        let result = select(state.plan(), events);
        assert_eq!(result.incomplete_event_ids, ["old"]);
        let SemanticEventKind::UserMessage {text,..} = &result.events[0].kind else {panic!("user event")};
        assert!(text.ends_with("動画を編集して"));
    }
}
fn event_with_text(id: &str, text: String) -> SemanticEventEnvelope {
    SemanticEventEnvelope { event_id:id.into(), source_revision:1, occurred_at:1, source_byte_start:0, source_byte_end:1,
        kind:SemanticEventKind::UserMessage {kind:UserMessageKind::TaskChange, text, digest:id.into()} }
}

#[test]
fn clipped_activity_and_project_heading_keep_their_completeness_witness() {
    let mut activity = event_with_text("activity", String::new());
    activity.kind = SemanticEventKind::AgentMessage { text: format!("引用：「{}」。\n動画を編集してはいけません。", "あ".repeat(286)) };
    let mut state = crate::livebrief::naming::NamingState::default(); state.observe(&activity, false);
    let result = select(state.plan(), vec![activity]);
    assert_eq!(result.incomplete_event_ids, ["activity"]);
    let root = std::env::temp_dir().join(format!("b11-heading-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("spec.md"), format!("# 引用：「{}」。\n動画を編集してはいけません。", "あ".repeat(180))).unwrap();
    let mut request = naming_request("heading");
    request.title.agent_kind = "unsupported".into(); request.title.cwd = root.to_string_lossy().into_owned();
    let material = fallback(request, Instant::now() + Duration::from_secs(5));
    std::fs::remove_dir_all(root).unwrap();
    assert!(!material.task_title_complete);
    assert_eq!(material.task_title.unwrap().chars().count(), 160);
}

#[test]
fn missing_current_naming_event_is_not_an_affirmation_of_the_old_generic_task() {
    let records = vec![user_record(0, "動画を編集する"), question_record(), answer_record("動画を編集してはいけません", "mixed")];
    let output = frame("missing", 0, &records, "live-native");
    let brief: LiveSessionBrief = serde_json::from_value(output["brief"].clone()).unwrap();
    assert_eq!(brief.latest_instruction.as_deref(), Some("動画を編集する"));
    let material = material_from_brief(naming_request("missing-0"), brief, Vec::new());
    assert!(!material.instruction_history_complete);
    assert!(!material.latest_instruction_complete);
}

#[test]
fn naming_references_are_bounded_without_changing_general_answer_semantics() {
    let mut records = vec![user_record(0, "動画を編集する"), question_record()];
    for index in 1..12 { records.push(user_record(index, "次は会議を予約してください")); }
    let output = frame("references", 0, &records, "live-native");
    assert_eq!(output["brief"]["latestInstruction"], "動画を編集する");
    assert_eq!(output["brief"]["taskSourceEventIds"].as_array().unwrap().len(), 1);
    assert_eq!(output["brief"]["namingSourceEventIds"].as_array().unwrap().len(), 4);
    assert_eq!(output["material"]["latest_instruction_kind"], "answer");
}

// K1 tests only. No B-only frame in the unobserved branch, no hand-edited kinds.
fn core_count_records(next: &str, count: usize, mode: &str) -> Vec<Value> {
    let mut records = vec![user_record(0, "動画を編集する"), user_record(1, next), question_record()];
    if mode == "closed" { records.push(resolved_record()); }
    for index in 0..count {
        let text = ["A", "動画", "はい", "了解"][index % 4];
        records.push(if mode == "mixed" && index == 0 { answer_record(text, mode) } else { user_record(index + 2, text) });
    }
    records
}
fn core_control(size: usize, pad: &str) -> String {
    let control = "続きをお願いします";
    let padding: String = pad.repeat(size).chars().take(size - 7 - control.chars().count()).collect();
    let text = format!("引用：「{padding}」。\n{control}");
    assert_eq!(text.chars().count(), size);
    text
}
fn save_core_audit(variable: &str, rows: &[Value]) {
    if let Ok(path) = std::env::var(variable) {
        std::fs::write(path, serde_json::to_string_pretty(rows).unwrap()).unwrap();
    }
}

#[test]
fn core_source_holes_do_not_claim_a_complete_instruction() {
    let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("source.jsonl");
    let good = format!("{}\n", user_record(1000, "解説スライドを作る"));
    let holes = [b"not json\n".to_vec(), vec![0xff, b'\n'], [vec![b'x'; 1024 * 1024 + 1], vec![b'\n']].concat(),
        b" \n".repeat(1024 * 1024 + 100)];
    for hole in holes { std::fs::write(&path, [hole, good.as_bytes().to_vec()].concat()).unwrap();
        let material = material_from_selection(naming_request("hole"), read_current(&path, "claude", Instant::now() + Duration::from_secs(5)));
        assert!(!material.instruction_history_complete); assert!(material.naming_plan.unwrap().coverage.source_unknown);
    }
    std::fs::write(&path, format!("{good}{{\"partial\":" )).unwrap();
    assert!(read_current(&path, "claude", Instant::now() + Duration::from_secs(5)).plan.unwrap().coverage.source_unknown);
    assert!(read_current(&path, "claude", Instant::now()).plan.is_none());
    let output = frame("legacy", 0, &[user_record(0, "動画を編集する")], "live-native");
    let mut brief: LiveSessionBrief = serde_json::from_value(output["brief"].clone()).unwrap(); brief.naming_plan = None;
    assert!(!material_from_brief(naming_request("legacy-0"), brief, Vec::new()).instruction_history_complete);
}

#[test]
fn core_g1_unobserved_count_loss_is_not_complete() {
    let mut rows = Vec::new();
    for next in ["解説スライドを作る", "動画を編集してはいけません", "次は会議を予約してください"] {
        for count in [4, 5, 8] {
            let output = frame("core-count-red", 65_000, &core_count_records(next, count, "open"), "live-native");
            assert_eq!(output["brief"]["latestInstruction"], next, "general brief must retain the real instruction");
            let users: Vec<_> = output["cache_events"].as_array().unwrap().iter().filter(|e| e["kind"]["type"] == "userMessage").collect();
            assert_eq!(users.len(), count + 2);
            assert!(users.iter().skip(2).all(|e| e["kind"]["kind"] == "answer"), "real open-question Answer classification");
            rows.push(output);
        }
    }
    assert_eq!(rows.len(), 9); save_core_audit("K1_COUNT_AUDIT", &rows);
    let failures: Vec<_> = rows.iter().enumerate().filter(|(_, row)| row["material"]["instruction_history_complete"] != false).map(|(i, _)| i).collect();
    assert!(failures.is_empty(), "G1 count: unobserved B was evicted without a coverage-loss witness in {failures:?} / 9 cases");
}

#[test]
fn core_g1_zero_character_loss_is_not_complete() {
    let mut rows = Vec::new();
    for pad in ["あ", "😀", "e\u{301}"] {
        let control = core_control(1600, pad);
        let records = vec![user_record(0, "動画を編集する"), user_record(1, "動画を編集してはいけません"), user_record(2, &control)];
        // Only the complete final sequence is observed, never B on its own.
        rows.push(frame("core-budget-red", 65_000, &records, "live-native"));
    }
    assert_eq!(rows.len(), 3); save_core_audit("K1_BUDGET_AUDIT", &rows);
    let failures: Vec<_> = rows.iter().enumerate().filter(|(_, row)| row["material"]["instruction_history_complete"] != false).map(|(i, _)| i).collect();
    assert!(failures.is_empty(), "G1 budget0: a wholly omitted prohibition has no coverage-loss witness in {failures:?} / 3 cases");
}

#[test]
fn core_k1_record_real_adapter_pipeline() {
    let mut cases = Vec::new();
    let readers = ["live-cached", "live-native", "transcript"];
    for next in ["解説スライドを作る", "動画を編集してはいけません", "次は会議を予約してください"] {
        for count in [0, 1, 3, 4, 5, 8] { for observed in [false, true] { for mode in ["open", "closed", "mixed"] { for reader in readers {
            let id = format!("core-count-{}", cases.len());
            let first = vec![user_record(0, "動画を編集する")];
            let records = core_count_records(next, count, mode);
            let mut frames = vec![frame(&id, 0, &first, reader)];
            if observed { frames.push(frame(&id, 60_000, &records[..2], reader)); }
            frames.push(frame(&id, 65_000, &records, reader));
            let mut recovered = records.clone(); recovered.push(resolved_record()); recovered.push(user_record(1000, "解説スライドを作る"));
            frames.push(frame(&id, 170_000, &recovered, reader));
            cases.push(json!({"id":id,"family":"count","reader":reader,"count":count,"observed":observed,"mode":mode,"frames":frames}));
        } } } }
    }
    assert_eq!(cases.len(), 324);
    for remaining in [0, 1, 7, 21, 79] { for delta in [-1i32, 0, 1] { for pad in ["あ", "😀", "e\u{301}"] { for reader in readers {
        let id = format!("core-budget-{}", cases.len());
        let control = core_control((1600 - remaining as i32 + delta) as usize, pad);
        let first = vec![user_record(0, "動画を編集する")];
        let records = vec![first[0].clone(), user_record(1, "動画を編集してはいけません"), user_record(2, &control)];
        let mut recovered = records.clone(); recovered.push(user_record(1000, "解説スライドを作る"));
        cases.push(json!({"id":id,"family":"budget","reader":reader,"remaining":remaining,"delta":delta,"pad":pad,
            "frames":[frame(&id,0,&first,reader),frame(&id,65_000,&records,reader),frame(&id,170_000,&recovered,reader)]}));
    } } } }
    assert_eq!(cases.len(), 459);
    for text in ["その作業は中止してください", "この作業は取りやめてください", "次の仕事は会議の予約です", "その案件は別の仕事に切り替えてください"] {
        assert!(!text.contains('を') && !text.contains("について") && !text.contains("に対して"));
        for mode in ["open", "mixed", "closed", "ordinary"] { for reader in readers {
            let id = format!("core-reply-{}", cases.len()); let first = vec![user_record(0, "動画を編集する")];
            let mut records = first.clone();
            if mode != "ordinary" { records.push(question_record()); }
            if mode == "closed" { records.push(resolved_record()); }
            records.push(answer_record(text, mode));
            let after = frame(&id,65_000,&records,reader);
            if mode == "open" || mode == "mixed" {
                assert_eq!(after["brief"]["latestInstruction"], "動画を編集する");
                assert_eq!(after["cache_events"].as_array().unwrap().iter().rev().find(|e| e["kind"]["type"] == "userMessage").unwrap()["kind"]["kind"], "answer");
            }
            let mut recovered = records.clone(); recovered.push(resolved_record()); recovered.push(user_record(1000, "解説スライドを作る"));
            cases.push(json!({"id":id,"family":"reply","reader":reader,"mode":mode,"frames":[frame(&id,0,&first,reader),after,frame(&id,170_000,&recovered,reader)]}));
        } }
    }
    assert_eq!(cases.len(), 507);
    if let Ok(path) = std::env::var("K1_RECORD_NATIVE") {
        std::fs::write(path, serde_json::to_string_pretty(&json!({"schema":"K1-core-native-v1",
            "product_head":std::env::var("K1_PRODUCT_SHA").unwrap_or_default(),
            "test_source_head":std::env::var("K1_TEST_SHA").unwrap_or_default(), "cases":cases})).unwrap()).unwrap();
    }
}
