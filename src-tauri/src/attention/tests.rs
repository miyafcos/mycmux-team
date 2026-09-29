use std::collections::{BTreeMap, BTreeSet};

use rusqlite::Connection;

use crate::livebrief::{
    semantic_question_excerpt, PendingInputKind, SemanticEventEnvelope, SemanticEventKind,
};

use super::model::{
    AttentionCard, AttentionKind, CardState, EvidenceRef, PrimaryAction, ReplyRoute,
    ResolutionPredicate, SessionRef, Severity, Waiting,
};
use super::rules::{
    evaluate, evaluate_resolutions, AttentionInput, AttentionObservation, AttentionSnapshot,
    ObservationKind,
};
use super::store;

fn observation(kind: AttentionKind) -> AttentionObservation {
    let key = format!("{}:case", kind.as_str());
    AttentionObservation {
        key: key.clone(),
        fingerprint: key.clone(),
        kind: ObservationKind::Attention(kind),
        workorder_id: None,
        session: Some(SessionRef::Pty {
            pty_session_id: "pty-a".into(),
        }),
        why_now: "now".into(),
        impact: "impact".into(),
        evidence: vec![EvidenceRef {
            source: "test".into(),
            kind: "event".into(),
            ref_id: "event-a".into(),
            detail: "evidence".into(),
        }],
        primary_action: Some(PrimaryAction::OpenSession {
            session: SessionRef::Pty {
                pty_session_id: "pty-a".into(),
            },
        }),
        reply_route: ReplyRoute::Session {
            session: SessionRef::Pty {
                pty_session_id: "pty-a".into(),
            },
        },
        resolution_predicate: ResolutionPredicate::ObservationMissing {
            observation_key: key,
        },
    }
}

fn input(observation: AttentionObservation) -> AttentionInput {
    let mut observations = BTreeMap::new();
    observations.insert(observation.key.clone(), observation);
    AttentionInput {
        previous: AttentionSnapshot::default(),
        current: AttentionSnapshot {
            observations,
            active_workorders: BTreeSet::new(),
        },
        existing_cards: Vec::new(),
        tracked_pty_sessions: BTreeSet::from(["pty-a".to_owned()]),
        now: 100,
    }
}

fn card(kind: AttentionKind, fingerprint: &str, workorder_id: Option<&str>) -> AttentionCard {
    let mut observation = observation(kind);
    observation.fingerprint = fingerprint.into();
    observation.workorder_id = workorder_id.map(str::to_owned);
    observation.session = None;
    observation.primary_action = Some(PrimaryAction::ReviewConflict {
        workorder_id: workorder_id.unwrap_or("workorder-a").into(),
    });
    observation.reply_route = ReplyRoute::WorkOrder {
        workorder_id: workorder_id.unwrap_or("workorder-a").into(),
    };
    observation.resolution_predicate = ResolutionPredicate::WorkOrderInactive {
        workorder_id: workorder_id.unwrap_or("workorder-a").into(),
    };
    let mut value = input(observation);
    value.tracked_pty_sessions.clear();
    evaluate(&value)
        .pop()
        .expect("workorder observation qualifies")
        .card
}

#[test]
fn all_four_qualification_conditions_are_required() {
    let base = observation(AttentionKind::AgentAsked);
    let mut no_transition = input(base.clone());
    no_transition.previous = no_transition.current.clone();
    assert!(evaluate(&no_transition).is_empty());

    let mut no_action = input(base.clone());
    no_action
        .current
        .observations
        .values_mut()
        .next()
        .unwrap()
        .primary_action = None;
    assert!(evaluate(&no_action).is_empty());

    let mut no_evidence = input(base.clone());
    no_evidence
        .current
        .observations
        .values_mut()
        .next()
        .unwrap()
        .evidence
        .clear();
    assert!(evaluate(&no_evidence).is_empty());

    let mut untracked = input(base);
    untracked.tracked_pty_sessions.clear();
    assert!(evaluate(&untracked).is_empty());
}

#[test]
fn eight_silent_conditions_are_explicitly_ignored() {
    let silent = [
        ObservationKind::ToolProgress,
        ObservationKind::IntermediateTestPassed,
        ObservationKind::RepeatedError,
        ObservationKind::NoActionReport,
        ObservationKind::UnsupportedInference,
        ObservationKind::UnrelatedObservation,
        ObservationKind::DuplicateCause,
        ObservationKind::LongRunning,
    ];
    for kind in silent {
        let mut item = observation(AttentionKind::AgentAsked);
        item.kind = kind;
        assert!(evaluate(&input(item)).is_empty());
    }
}

#[test]
fn all_ten_native_attention_kinds_produce_the_adr_axes() {
    let kinds = [
        AttentionKind::AgentAsked,
        AttentionKind::WorkStopped,
        AttentionKind::ReportsComplete,
        AttentionKind::CompletionWithoutTests,
        AttentionKind::BudgetReached,
        AttentionKind::OutOfScopeWrite,
        AttentionKind::ConflictDetected,
        AttentionKind::GoalReached,
        AttentionKind::NextItemReady,
        AttentionKind::WorkOrderStalled,
    ];
    for kind in kinds {
        let actual = evaluate(&input(observation(kind)));
        assert_eq!(actual.len(), 1, "{kind:?}");
        assert_eq!(actual[0].card.kind, kind);
        assert_eq!(
            (actual[0].card.waiting, actual[0].card.severity),
            kind.native_axes().unwrap()
        );
        assert_eq!(actual[0].card.actor, None);
        assert_eq!(actual[0].card.freshness, None);
    }
}

#[test]
fn repeated_fingerprint_upserts_in_place() {
    let conn = Connection::open_in_memory().unwrap();
    let first = card(AttentionKind::AgentAsked, "same-cause", Some("workorder-a"));
    store::upsert(&conn, &first).unwrap();
    let mut second = first.clone();
    second.source_rank = Some(2);
    second.why_now = "updated".into();
    second.last_seen_at = 101;
    store::upsert(&conn, &second).unwrap();
    let cards = store::list_all_cards(&conn).unwrap();
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0].revision, 2);
    assert_eq!(cards[0].source_rank, Some(2));
    assert_eq!(cards[0].waiting, Waiting::Human);
    assert_eq!(cards[0].severity, Severity::Blocking);
    assert_eq!(cards[0].why_now, "updated");
}

#[test]
fn stopped_session_revision_updates_the_existing_cause_card() {
    let conn = Connection::open_in_memory().unwrap();
    let mut first = observation(AttentionKind::WorkStopped);
    first.key = "work-stopped:pty-a:1".into();
    first.fingerprint = "work-stopped:pty-a".into();
    first.resolution_predicate = ResolutionPredicate::ObservationMissing {
        observation_key: first.key.clone(),
    };
    first.evidence[0].ref_id = "pty-a:1".into();
    let mut first_input = input(first);
    first_input.now = 100;
    store::apply_with_connection(&conn, &first_input, true).unwrap();
    let first_card = store::list_open_cards(&conn).unwrap().pop().unwrap();

    let mut second = observation(AttentionKind::WorkStopped);
    second.key = "work-stopped:pty-a:2".into();
    second.fingerprint = "work-stopped:pty-a".into();
    second.resolution_predicate = ResolutionPredicate::ObservationMissing {
        observation_key: second.key.clone(),
    };
    second.evidence[0].ref_id = "pty-a:2".into();
    let mut second_input = input(second);
    second_input.existing_cards = store::list_all_cards(&conn).unwrap();
    second_input.now = 200;
    store::apply_with_connection(&conn, &second_input, true).unwrap();

    let cards = store::list_open_cards(&conn).unwrap();
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0].id, first_card.id);
    assert_eq!(cards[0].first_seen_at, first_card.first_seen_at);
    assert_eq!(cards[0].last_seen_at, 200);
}

#[test]
fn last_seen_at_uses_service_time_not_evidence_content() {
    let mut numeric_evidence = observation(AttentionKind::AgentAsked);
    numeric_evidence.evidence[0].ref_id = "prompt:999999999999".into();
    let mut numeric_input = input(numeric_evidence);
    numeric_input.now = 1_700_000_000_000;

    let mut opaque_evidence = observation(AttentionKind::AgentAsked);
    opaque_evidence.evidence[0].ref_id = "prompt:opaque-value".into();
    let mut opaque_input = input(opaque_evidence);
    opaque_input.now = 1_700_000_000_000;

    let numeric_card = evaluate(&numeric_input).pop().unwrap().card;
    let opaque_card = evaluate(&opaque_input).pop().unwrap().card;
    assert_eq!(numeric_card.last_seen_at, numeric_input.now);
    assert_eq!(opaque_card.last_seen_at, opaque_input.now);
    assert_eq!(numeric_card.last_seen_at, opaque_card.last_seen_at);
}

#[test]
fn four_open_cards_bundle_to_one_stalled_card() {
    let conn = Connection::open_in_memory().unwrap();
    for index in 0..4 {
        store::upsert(
            &conn,
            &card(
                AttentionKind::AgentAsked,
                &format!("cause-{index}"),
                Some("workorder-a"),
            ),
        )
        .unwrap();
    }
    let empty = AttentionInput {
        previous: AttentionSnapshot::default(),
        current: AttentionSnapshot::default(),
        existing_cards: Vec::new(),
        tracked_pty_sessions: BTreeSet::new(),
        now: 100,
    };
    store::apply_with_connection(&conn, &empty, true).unwrap();
    let cards = store::list_all_cards(&conn).unwrap();
    assert_eq!(
        cards
            .iter()
            .filter(|item| item.state == CardState::Bundled)
            .count(),
        4
    );
    assert_eq!(
        cards
            .iter()
            .filter(|item| item.state == CardState::Open
                && item.kind == AttentionKind::WorkOrderStalled)
            .count(),
        1
    );
    let stalled = cards
        .iter()
        .find(|item| item.state == CardState::Open && item.kind == AttentionKind::WorkOrderStalled)
        .unwrap();
    assert_eq!(stalled.waiting, Waiting::Work);
    assert_eq!(stalled.severity, Severity::Warning);
}

#[test]
fn resolution_evaluation_is_pure_and_deterministic() {
    let item = card(
        AttentionKind::AgentAsked,
        "resolved-cause",
        Some("workorder-a"),
    );
    let input = AttentionInput {
        previous: AttentionSnapshot::default(),
        current: AttentionSnapshot::default(),
        existing_cards: vec![item],
        tracked_pty_sessions: BTreeSet::new(),
        now: 100,
    };
    assert_eq!(evaluate_resolutions(&input), evaluate_resolutions(&input));
}

#[test]
fn unavailable_primary_action_never_becomes_a_card() {
    let mut item = observation(AttentionKind::AgentAsked);
    item.primary_action = None;
    assert!(evaluate(&input(item)).is_empty());
}

#[test]
fn disabled_cards_do_not_create_or_update_until_reenabled() {
    let conn = Connection::open_in_memory().unwrap();
    let item = observation(AttentionKind::AgentAsked);
    let input = input(item);

    let disabled = store::apply_with_connection(&conn, &input, false).unwrap();
    assert!(!disabled.changed);
    assert!(disabled.cards.is_empty());
    assert!(store::list_all_cards(&conn).unwrap().is_empty());

    let enabled = store::apply_with_connection(&conn, &input, true).unwrap();
    assert!(enabled.changed);
    assert_eq!(enabled.cards.len(), 1);
}

#[test]
fn untracked_session_is_silent_until_tracking_is_enabled() {
    let item = observation(AttentionKind::AgentAsked);
    let mut untracked = input(item.clone());
    untracked.tracked_pty_sessions.clear();
    assert!(evaluate(&untracked).is_empty());
    assert_eq!(evaluate(&input(item)).len(), 1);
}

#[test]
fn detailed_evidence_keeps_the_same_fingerprint_and_card_id() {
    let mut item = observation(AttentionKind::AgentAsked);
    item.evidence[0].detail = "質問本文: どの方法で進めますか".into();
    let first = evaluate(&input(item.clone())).pop().unwrap().card;
    item.evidence[0].detail = "質問本文: 先に検証してから進めますか".into();
    let second = evaluate(&input(item)).pop().unwrap().card;
    assert_eq!(first.fingerprint, second.fingerprint);
    assert_eq!(first.id, second.id);
    assert_ne!(first.evidence[0].detail, second.evidence[0].detail);
}

#[test]
fn stopped_evidence_states_unavailable_exit_reason_and_last_output() {
    let evidence = super::stopped_evidence("pty-a", "pty-a:1", "Exited", "最後の出力".into());
    assert_eq!(evidence.len(), 3);
    assert!(evidence
        .iter()
        .any(|item| item.detail.contains("終了コード・終了理由: 取得できず")));
    assert!(evidence
        .iter()
        .any(|item| item.detail.contains("最終出力: 最後の出力")));
}

#[test]
fn next_item_evidence_keeps_the_objective_and_contract_goal() {
    let observation = store::workorder_observation(
        AttentionKind::NextItemReady,
        "workorder-a",
        "next:item-a",
        "次の作業を始められる状態になりました",
        "開始には人の判断が必要です",
        PrimaryAction::RetryWorkItem {
            workorder_id: "workorder-a".into(),
            work_item_id: "item-a".into(),
        },
        Some(SessionRef::Logical {
            logical_session_id: "agent-a".into(),
        }),
        "提出物を確認する",
        vec![EvidenceRef {
            source: "workorder".into(),
            kind: "workItemObjective".into(),
            ref_id: "objective".into(),
            detail: "作業: 検証する".into(),
        }],
    );
    assert!(observation
        .evidence
        .iter()
        .any(|item| item.detail == "作業: 検証する"));
    assert!(observation
        .evidence
        .iter()
        .any(|item| item.kind == "contractGoal" && item.detail.contains("提出物を確認する")));
}

#[test]
fn semantic_question_fixture_preserves_agent_asked_text() {
    let events = vec![SemanticEventEnvelope {
        event_id: "question-1".into(),
        source_revision: 1,
        occurred_at: 1,
        source_byte_start: 0,
        source_byte_end: 1,
        kind: SemanticEventKind::Question {
            prompt_event_id: "prompt-1".into(),
            provider_call_id: "call-1".into(),
            prompt: "先に検証しますか".into(),
            kind: PendingInputKind::Choice,
            options: Vec::new(),
        },
    }];
    assert_eq!(
        semantic_question_excerpt(&events, "prompt-1").as_deref(),
        Some("先に検証しますか")
    );
}
