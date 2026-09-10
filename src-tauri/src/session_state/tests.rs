use super::*;

const EPOCH: u64 = 100;
const STALE_AFTER: u64 = 30_000;

fn screen(
    observed_at: u64,
    epoch: u64,
    attention: AttentionKind,
    attention_id: Option<&str>,
    detail: Option<&str>,
    complete: bool,
    resync: bool,
) -> Evidence {
    Evidence {
        observed_at,
        source: EvidenceSource::ScreenScan,
        session_epoch: Some(epoch),
        process: None,
        signal: EvidenceSignal::ScreenScan {
            attention,
            attention_id: attention_id.map(str::to_string),
            detail: detail.map(str::to_string),
            confidence: 0.7,
            stale_after: STALE_AFTER,
            complete,
            resync,
        },
    }
}

fn hook(
    observed_at: u64,
    epoch: u64,
    attention: AttentionKind,
    attention_id: &str,
    detail: &str,
) -> Evidence {
    Evidence {
        observed_at,
        source: EvidenceSource::Hook,
        session_epoch: Some(epoch),
        process: None,
        signal: EvidenceSignal::Hook {
            attention,
            attention_id: Some(attention_id.to_string()),
            detail: Some(detail.to_string()),
            confidence: 0.95,
            stale_after: 60_000,
        },
    }
}

fn lifecycle(observed_at: u64, epoch: u64, state: Lifecycle) -> Evidence {
    Evidence {
        observed_at,
        source: EvidenceSource::SocketLifecycle,
        session_epoch: Some(epoch),
        process: None,
        signal: EvidenceSignal::SocketLifecycle { lifecycle: state },
    }
}

fn replay(evidence: &[Evidence]) -> SessionView {
    evidence
        .iter()
        .fold(SessionView::new("session-a"), |view, item| {
            reduce(&view, item)
        })
}

fn assert_deterministic(evidence: &[Evidence]) -> SessionView {
    let first = replay(evidence);
    let second = replay(evidence);
    assert_eq!(first, second);
    first
}

#[test]
fn replay_ansi_split_waits_for_a_complete_scan() {
    let view = assert_deterministic(&[
        screen(10, EPOCH, AttentionKind::None, None, None, false, false),
        screen(
            11,
            EPOCH,
            AttentionKind::Approval,
            Some("approval-1"),
            Some("Allow this command? (y/n)"),
            true,
            false,
        ),
    ]);
    assert_eq!(view.attention.kind, AttentionKind::Approval);
    assert_eq!(view.attention.attention_id.as_deref(), Some("approval-1"));
}

#[test]
fn replay_large_output_before_approval_keeps_both_axes() {
    let mut evidence: Vec<_> = (1..=20)
        .map(|at| Evidence::last_output(at, EPOCH, OutputOrigin::Pty))
        .collect();
    evidence.push(screen(
        21,
        EPOCH,
        AttentionKind::Approval,
        Some("approval-2"),
        Some("Proceed?"),
        true,
        false,
    ));
    let view = assert_deterministic(&evidence);
    assert_eq!(view.activity, Activity::Streaming);
    assert_eq!(view.attention.kind, AttentionKind::Approval);
}

#[test]
fn replay_spinner_after_prompt_does_not_clear_attention() {
    let view = assert_deterministic(&[
        screen(
            10,
            EPOCH,
            AttentionKind::Input,
            Some("input-1"),
            Some("Type your answer"),
            true,
            false,
        ),
        Evidence::last_output(11, EPOCH, OutputOrigin::Pty),
        Evidence::last_output(12, EPOCH, OutputOrigin::Pty),
    ]);
    assert_eq!(view.activity, Activity::Streaming);
    assert_eq!(view.attention.kind, AttentionKind::Input);
}

#[test]
fn replay_unmounted_waiting_is_renderer_independent() {
    let view = assert_deterministic(&[hook(
        10,
        EPOCH,
        AttentionKind::Approval,
        "hook-approval",
        "Approve deployment?",
    )]);
    assert_eq!(derive_ui_state(&view), UiSessionState::Waiting);
    assert_eq!(view.attention.sources, vec![EvidenceSource::Hook]);
}

#[test]
fn rate_limited_screen_scan_is_waiting() {
    let view = replay(&[screen(
        10,
        EPOCH,
        AttentionKind::RateLimited,
        Some("rate-limit"),
        Some("usage limit reached"),
        true,
        false,
    )]);
    assert_eq!(view.attention.kind, AttentionKind::RateLimited);
    assert_eq!(derive_ui_state(&view), UiSessionState::Waiting);
}

#[test]
fn replay_hook_and_scan_merge_independent_of_arrival_order() {
    let scan = screen(
        10,
        EPOCH,
        AttentionKind::Approval,
        Some("shared-approval"),
        Some("Proceed?"),
        true,
        false,
    );
    let hook = hook(
        11,
        EPOCH,
        AttentionKind::Approval,
        "shared-approval",
        "Hook requires confirmation",
    );
    let forward = replay(&[scan.clone(), hook.clone()]);
    let reverse = replay(&[hook, scan]);
    assert_eq!(forward, reverse);
    assert_eq!(
        forward.attention.sources,
        vec![EvidenceSource::Hook, EvidenceSource::ScreenScan]
    );
    assert_eq!(
        forward.attention.detail.as_deref(),
        Some("Hook requires confirmation")
    );
}

#[test]
fn replay_output_after_work_done_does_not_set_attention() {
    let view = assert_deterministic(&[
        Evidence::work_done(10, EPOCH, "claude".into(), "pwsh".into()),
        Evidence::last_output(11, EPOCH, OutputOrigin::Pty),
    ]);
    assert_eq!(view.activity, Activity::Streaming);
    assert_eq!(view.attention.kind, AttentionKind::None);
}

#[test]
fn replay_pid_reuse_requires_process_start_time() {
    let original = Evidence::monitor_status(
        10,
        EPOCH,
        MonitorStatus::Working,
        Some(ProcessIdentity {
            pid: 42,
            started_at: 200,
        }),
    );
    let stale_reused_pid = Evidence::monitor_status(
        20,
        EPOCH,
        MonitorStatus::Idle,
        Some(ProcessIdentity {
            pid: 42,
            started_at: 100,
        }),
    );
    let newer_reused_pid = Evidence::monitor_status(
        30,
        EPOCH,
        MonitorStatus::Idle,
        Some(ProcessIdentity {
            pid: 42,
            started_at: 300,
        }),
    );
    let before_reuse = replay(&[original.clone(), stale_reused_pid]);
    assert_eq!(before_reuse.activity, Activity::RunningSilent);
    assert_eq!(before_reuse.process.unwrap().started_at, 200);
    let after_reuse = assert_deterministic(&[original, newer_reused_pid]);
    assert_eq!(after_reuse.activity, Activity::Idle);
    assert_eq!(after_reuse.process.unwrap().started_at, 300);
}

#[test]
fn replay_old_event_after_restart_cannot_mutate_new_epoch() {
    let view = assert_deterministic(&[
        lifecycle(100, 2, Lifecycle::Alive),
        screen(
            200,
            1,
            AttentionKind::Approval,
            Some("old"),
            Some("Stale prompt"),
            true,
            false,
        ),
    ]);
    assert_eq!(view.session_epoch, Some(2));
    assert_eq!(view.attention.kind, AttentionKind::None);
}

#[test]
fn replay_resync_scan_cannot_clear_waiting() {
    let view = assert_deterministic(&[
        screen(
            10,
            EPOCH,
            AttentionKind::Approval,
            Some("approval-3"),
            Some("Continue?"),
            true,
            false,
        ),
        screen(20, EPOCH, AttentionKind::None, None, None, true, true),
    ]);
    assert_eq!(view.attention.kind, AttentionKind::Approval);
    assert_eq!(view.health, Health::Degraded);
}

#[test]
fn regression_0727_timestamp_refresh_does_not_clear_attention() {
    let view = assert_deterministic(&[
        screen(
            10,
            EPOCH,
            AttentionKind::Approval,
            Some("approval-stable"),
            Some("Proceed?"),
            true,
            false,
        ),
        Evidence::monitor_status(
            10_000,
            EPOCH,
            MonitorStatus::Working,
            Some(ProcessIdentity {
                pid: 77,
                started_at: 5,
            }),
        ),
    ]);
    assert_eq!(
        view.attention.attention_id.as_deref(),
        Some("approval-stable")
    );
    assert_eq!(view.attention.kind, AttentionKind::Approval);
}

#[test]
fn regression_0729_internal_output_cannot_form_an_activity_loop() {
    let view = assert_deterministic(&[
        screen(
            10,
            EPOCH,
            AttentionKind::Approval,
            Some("approval-loop"),
            Some("Approve?"),
            true,
            false,
        ),
        Evidence::last_output(11, EPOCH, OutputOrigin::Pty),
        Evidence::last_output(11, EPOCH, OutputOrigin::Pty),
        Evidence::last_output(12, EPOCH, OutputOrigin::Internal),
        Evidence::last_output(13, EPOCH, OutputOrigin::Replay),
        Evidence::monitor_status(
            20,
            EPOCH,
            MonitorStatus::Idle,
            Some(ProcessIdentity {
                pid: 88,
                started_at: 5,
            }),
        ),
    ]);
    assert_eq!(view.activity, Activity::Idle);
    assert_eq!(view.last_output_at, 11);
    assert_eq!(view.attention.kind, AttentionKind::Approval);
}

#[test]
fn screen_clear_removes_only_its_source() {
    let view = assert_deterministic(&[
        screen(
            10,
            EPOCH,
            AttentionKind::Approval,
            Some("shared"),
            Some("Proceed?"),
            true,
            false,
        ),
        hook(
            11,
            EPOCH,
            AttentionKind::Approval,
            "shared",
            "Hook confirmation",
        ),
        screen(12, EPOCH, AttentionKind::None, None, None, true, false),
    ]);
    assert_eq!(view.attention.kind, AttentionKind::Approval);
    assert_eq!(view.attention.sources, vec![EvidenceSource::Hook]);
}

#[test]
fn evidence_ledger_is_bounded_and_sorted_by_session() {
    let store = SessionStateStore::new();
    for observed_at in 1..=40 {
        store.ingest(
            "session-b",
            Evidence::last_output(observed_at, EPOCH, OutputOrigin::Pty),
        );
    }
    store.ingest("session-a", lifecycle(1, EPOCH, Lifecycle::Alive));
    let snapshot = store.snapshot(None);
    assert_eq!(snapshot.sessions[0].session_id, "session-a");
    assert_eq!(snapshot.sessions[1].session_id, "session-b");
    assert_eq!(snapshot.sessions[0].input_revision, None);
    assert_eq!(snapshot.sessions[1].recent_evidence.len(), LEDGER_CAPACITY);
    assert_eq!(snapshot.sessions[1].recent_evidence[0].observed_at, 9);
}

#[test]
fn snapshot_can_bind_each_session_to_its_pty_input_revision() {
    let store = SessionStateStore::new();
    store.ingest("session-a", lifecycle(1, EPOCH, Lifecycle::Alive));
    store.ingest("session-b", lifecycle(1, EPOCH, Lifecycle::Alive));

    let snapshot = store.snapshot_with_input_revisions(None, |session_id| match session_id {
        "session-a" => Some(5),
        "session-b" => Some(8),
        _ => None,
    });

    assert_eq!(snapshot.sessions[0].input_revision, Some(5));
    assert_eq!(snapshot.sessions[1].input_revision, Some(8));
}

#[test]
fn current_view_guard_blocks_same_session_updates_until_operation_finishes() {
    let store = SessionStateStore::new();
    store.ingest("session-a", lifecycle(1, EPOCH, Lifecycle::Alive));
    let updating_store = store.clone();

    store.with_current_view("session-a", |_| {
        assert!(matches!(
            updating_store.sessions.try_get_mut("session-a"),
            dashmap::try_result::TryResult::Locked
        ));
    });

    assert!(matches!(
        store.sessions.try_get_mut("session-a"),
        dashmap::try_result::TryResult::Present(_)
    ));
}


fn hook_clear(observed_at: u64) -> Evidence {
    Evidence {
        observed_at,
        source: EvidenceSource::Hook,
        session_epoch: Some(EPOCH),
        process: None,
        signal: EvidenceSignal::Hook {
            attention: AttentionKind::None,
            attention_id: None,
            detail: None,
            confidence: 1.0,
            stale_after: STALE_AFTER,
        },
    }
}

#[test]
fn hook_turn_active_clears_screen_scan_approval() {
    let approval = screen(
        10,
        EPOCH,
        AttentionKind::Approval,
        Some("approval"),
        Some("Proceed?"),
        true,
        false,
    );
    for merged in [false, true] {
        let mut events = vec![approval.clone()];
        if merged {
            events.push(hook(
                11,
                EPOCH,
                AttentionKind::Approval,
                "approval",
                "Proceed?",
            ));
        }
        events.push(hook_clear(12));
        let cleared = assert_deterministic(&events);
        assert_eq!(cleared.attention.kind, AttentionKind::None);
        assert_eq!(cleared.attention.attention_id, None);
        assert_eq!(cleared.attention.detail, None);
        assert!(cleared.attention.sources.is_empty());
        assert_eq!(cleared.attention.observed_at, 12);
        assert_eq!(cleared.attention.state_since, 12);
    }
}

#[test]
fn screen_scan_can_raise_approval_again_after_hook_clear() {
    let mut events = vec![
        screen(
            10,
            EPOCH,
            AttentionKind::Approval,
            Some("approval"),
            None,
            true,
            false,
        ),
        hook_clear(12),
        screen(
            11,
            EPOCH,
            AttentionKind::Approval,
            Some("approval"),
            None,
            true,
            false,
        ),
    ];
    assert_eq!(replay(&events).attention.kind, AttentionKind::None);
    events.push(screen(
        13,
        EPOCH,
        AttentionKind::Approval,
        Some("approval"),
        None,
        true,
        false,
    ));
    let raised = assert_deterministic(&events);
    assert_eq!(raised.attention.kind, AttentionKind::Approval);
    assert_eq!(raised.attention.sources, vec![EvidenceSource::ScreenScan]);
}

#[test]
fn hook_turn_ended_sets_done_and_next_turn_active_clears_it() {
    let ended = hook(
        10,
        EPOCH,
        AttentionKind::Done,
        "agent-hook:launch:turn-1",
        "Turn ended",
    );
    let done = replay(&[ended.clone()]);
    assert_eq!(done.attention.kind, AttentionKind::Done);
    assert_eq!(
        done.attention.attention_id.as_deref(),
        Some("agent-hook:launch:turn-1")
    );
    let cleared = assert_deterministic(&[ended, hook_clear(11)]);
    assert_eq!(cleared.attention.kind, AttentionKind::None);
    assert_eq!(cleared.attention.attention_id, None);
}

#[test]
fn older_hook_none_cannot_clear_newer_input() {
    let input = hook(20, EPOCH, AttentionKind::Input, "input-new", "Answer?");
    let before = replay(&[input.clone()]);
    let after = assert_deterministic(&[input, hook_clear(19)]);
    assert_eq!(after, before);
}

#[test]
fn derive_ui_state_maps_done_to_done() {
    let view = replay(&[
        Evidence::last_output(9, EPOCH, OutputOrigin::Pty),
        hook(10, EPOCH, AttentionKind::Done, "done", "Turn ended"),
    ]);
    assert_eq!(derive_ui_state(&view), UiSessionState::Done);
}

#[test]
fn hook_clear_removes_codex_rollout_done_without_pinning_its_identity() {
    let mut rollout = hook(
        10,
        EPOCH,
        AttentionKind::Done,
        "codex:rollout:turn:done",
        "Turn ended",
    );
    rollout.source = EvidenceSource::CodexRollout;
    let done = replay(&[rollout]);
    let hook_done = reduce(
        &done,
        &hook(
            11,
            EPOCH,
            AttentionKind::Done,
            "agent-hook:launch:event",
            "Turn ended",
        ),
    );
    assert_eq!(hook_done.attention.kind, AttentionKind::Done);
    assert_eq!(
        hook_done.attention.attention_id.as_deref(),
        Some("codex:rollout:turn:done")
    );
    assert_eq!(
        hook_done.attention.sources,
        vec![EvidenceSource::Hook, EvidenceSource::CodexRollout]
    );
    let cleared = reduce(&hook_done, &hook_clear(12));
    assert_eq!(cleared.attention.kind, AttentionKind::None);
    assert!(cleared.attention.sources.is_empty());
}

#[test]
fn done_alias_preserves_first_id_in_both_source_orders() {
    for hook_first in [false, true] {
        for second_at in [10, 20] {
            let mut first = hook(10, EPOCH, AttentionKind::Done, "first-done", "Turn ended");
            let mut second = hook(second_at, EPOCH, AttentionKind::Done, "alias-done", "Turn ended");
            if hook_first {
                second.source = EvidenceSource::CodexRollout;
            } else {
                first.source = EvidenceSource::CodexRollout;
            }
            if let EvidenceSignal::Hook { stale_after, .. } = &mut first.signal {
                *stale_after = STALE_AFTER;
            }
            let merged = assert_deterministic(&[first, second]);
            assert_eq!(merged.attention.attention_id.as_deref(), Some("first-done"));
            assert_eq!(
                merged.attention.sources,
                vec![EvidenceSource::Hook, EvidenceSource::CodexRollout]
            );
            assert_eq!(merged.attention.state_since, 10);
            assert_eq!(merged.attention.observed_at, second_at);
            assert_eq!(merged.attention.stale_after, 60_000);
        }
    }
}

#[test]
fn older_done_with_another_id_does_not_refresh_attention() {
    let current = hook(20, EPOCH, AttentionKind::Done, "current-done", "Turn ended");
    let mut older = hook(19, EPOCH, AttentionKind::Done, "older-done", "Turn ended");
    older.source = EvidenceSource::CodexRollout;
    let before = replay(&[current.clone()]);
    let after = assert_deterministic(&[current, older]);
    assert_eq!(after.attention, before.attention);
}

#[test]
fn done_after_none_gets_a_new_id_with_or_without_hook_alias() {
    for with_hook_alias in [false, true] {
        let mut first = hook(10, EPOCH, AttentionKind::Done, "rollout-turn-1", "Turn ended");
        first.source = EvidenceSource::CodexRollout;
        let mut events = vec![first];
        if with_hook_alias {
            events.push(hook(11, EPOCH, AttentionKind::Done, "hook-turn-1", "Turn ended"));
        }
        let mut clear = hook_clear(20);
        if !with_hook_alias {
            clear.source = EvidenceSource::CodexRollout;
        }
        events.push(clear);
        assert_eq!(replay(&events).attention.kind, AttentionKind::None);
        let mut next = hook(30, EPOCH, AttentionKind::Done, "rollout-turn-2", "Turn ended");
        next.source = EvidenceSource::CodexRollout;
        events.push(next);
        let done = assert_deterministic(&events);
        assert_eq!(done.attention.attention_id.as_deref(), Some("rollout-turn-2"));
        assert_eq!(done.attention.sources, vec![EvidenceSource::CodexRollout]);
        assert_eq!(done.attention.state_since, 30);
    }
}
