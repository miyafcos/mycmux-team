use std::collections::BTreeMap;
use std::sync::{Arc, Barrier};

use rand::seq::SliceRandom;
use rand::{rngs::StdRng, SeedableRng};
use rusqlite::Connection;

use super::*;

fn launch(pane: &str, generation: u64) -> LaunchKey {
    LaunchKey::new(
        AppInstanceId::try_new("app-a").unwrap(),
        PaneId::try_new(pane).unwrap(),
        Provider::Codex,
        LaunchGeneration::new(generation),
    )
}

fn observation(
    launch: &LaunchKey,
    turn: &str,
    state: NormalizedState,
    source: ObservationSource,
    received_at: u64,
    source_event_id: &str,
) -> Observation {
    Observation::new(
        IdentityKey::new(
            launch.clone(),
            ProviderSessionId::try_new("session-a").unwrap(),
            ProviderTurnId::provider(turn).unwrap(),
            state,
        ),
        source,
        MonotonicTime::new(received_at),
        SourceEventId::try_new(source_event_id).unwrap(),
        Some(PayloadHash::try_new(format!("hash-{source_event_id}")).unwrap()),
    )
}

fn ledger() -> Ledger {
    Ledger::from_connection(Connection::open_in_memory().unwrap()).unwrap()
}

fn reserve(
    reconciler: &mut Reconciler,
    ledger: &mut Ledger,
    observation: Observation,
) -> Option<ReservedObservation> {
    match ledger.reconcile(reconciler, observation).unwrap() {
        PersistedReconcileOutcome::Accepted(reserved) => Some(reserved),
        PersistedReconcileOutcome::Rejected { .. } => None,
    }
}

fn reserve_promotions(
    reconciler: &mut Reconciler,
    ledger: &mut Ledger,
    now: u64,
) -> Vec<ReservedObservation> {
    ledger
        .advance_and_reserve(reconciler, MonotonicTime::new(now))
        .unwrap()
}

fn notification_count(results: &[ReservedObservation]) -> usize {
    results
        .iter()
        .flat_map(|result| result.intents.iter())
        .filter(|intent| **intent == Intent::EmitNotification)
        .count()
}

#[test]
fn same_hook_observation_delivered_100_times_produces_exactly_one_notification_intent() {
    let launch = launch("pane-a", 1);
    let event = observation(
        &launch,
        "turn-a",
        NormalizedState::TurnEnded,
        ObservationSource::Hook,
        100,
        "hook-a",
    );
    let mut reconciler = Reconciler::new();
    assert!(reconciler.register_launch(launch, HookMode::Installed));
    let mut ledger = ledger();
    let mut results = Vec::new();
    for _ in 0..100 {
        if let Some(result) = reserve(&mut reconciler, &mut ledger, event.clone()) {
            results.push(result);
        }
    }
    assert_eq!(notification_count(&results), 1);
    assert_eq!(ledger.count_records().unwrap(), 1);
    let record = ledger
        .load(&results[0].canonical.canonical_event_id)
        .unwrap()
        .unwrap();
    assert_eq!(record.source_event_ids, vec!["hook-a"]);
    assert_eq!(record.payload_hashes, vec!["hash-hook-a"]);
}

#[test]
fn hook_arriving_zero_to_ten_seconds_after_rollout_merges_without_double_firing() {
    for delay in [0, 2_999, 3_000, 10_000] {
        let launch = launch(&format!("pane-{delay}"), 1);
        let mut reconciler = Reconciler::new();
        reconciler.register_launch(launch.clone(), HookMode::Installed);
        let mut ledger = ledger();
        let mut results = Vec::new();
        results.push(
            reserve(
                &mut reconciler,
                &mut ledger,
                observation(
                    &launch,
                    "turn-a",
                    NormalizedState::TurnEnded,
                    ObservationSource::Rollout,
                    100,
                    "rollout-a",
                ),
            )
            .unwrap(),
        );
        if delay >= ROLLOUT_GRACE_MS {
            results.extend(reserve_promotions(
                &mut reconciler,
                &mut ledger,
                100 + ROLLOUT_GRACE_MS,
            ));
        }
        results.push(
            reserve(
                &mut reconciler,
                &mut ledger,
                observation(
                    &launch,
                    "turn-a",
                    NormalizedState::TurnEnded,
                    ObservationSource::Hook,
                    100 + delay,
                    "hook-a",
                ),
            )
            .unwrap(),
        );
        assert_eq!(notification_count(&results), 1, "delay={delay}");
        assert_eq!(
            results.last().unwrap().canonical.state,
            NormalizedState::TurnEnded
        );
    }
}

#[test]
fn rollout_rescan_after_hook_confirmation_produces_no_new_intent() {
    let launch = launch("pane-a", 1);
    let mut reconciler = Reconciler::new();
    reconciler.register_launch(launch.clone(), HookMode::Installed);
    let mut ledger = ledger();
    let first = reserve(
        &mut reconciler,
        &mut ledger,
        observation(
            &launch,
            "turn-a",
            NormalizedState::TurnEnded,
            ObservationSource::Hook,
            100,
            "hook-a",
        ),
    )
    .unwrap();
    assert_eq!(notification_count(&[first]), 1);
    let rescan = reserve(
        &mut reconciler,
        &mut ledger,
        observation(
            &launch,
            "turn-a",
            NormalizedState::TurnEnded,
            ObservationSource::Rollout,
            200,
            "rollout-a",
        ),
    )
    .unwrap();
    assert!(rescan.intents.is_empty());
}

#[test]
fn observations_in_reverse_order_converge_to_the_same_state_as_in_order() {
    let launch = launch("pane-a", 1);
    let active = observation(
        &launch,
        "turn-a",
        NormalizedState::TurnActive,
        ObservationSource::Hook,
        100,
        "active-a",
    );
    let ended = observation(
        &launch,
        "turn-a",
        NormalizedState::TurnEnded,
        ObservationSource::Hook,
        200,
        "ended-a",
    );
    let run = |events: Vec<Observation>| {
        let mut reconciler = Reconciler::new();
        reconciler.register_launch(launch.clone(), HookMode::Installed);
        let mut ledger = ledger();
        let mut intents = Vec::new();
        for event in events {
            if let Some(result) = reserve(&mut reconciler, &mut ledger, event) {
                intents.extend(result.intents);
            }
        }
        (reconciler.canonical_for(&launch).unwrap().state, intents)
    };
    assert_eq!(
        run(vec![active.clone(), ended.clone()]),
        run(vec![ended, active])
    );
}

#[test]
fn pane_close_concurrent_with_terminal_records_but_does_not_notify() {
    let launch = launch("pane-a", 1);
    let mut reconciler = Reconciler::new();
    reconciler.register_launch(launch.clone(), HookMode::Installed);
    assert!(reconciler.mark_pane_closed(&launch, MonotonicTime::new(100)));
    let mut ledger = ledger();
    let result = reserve(
        &mut reconciler,
        &mut ledger,
        observation(
            &launch,
            "turn-a",
            NormalizedState::TurnEnded,
            ObservationSource::Hook,
            100,
            "hook-a",
        ),
    )
    .unwrap();
    assert!(!result.intents.contains(&Intent::EmitNotification));
    assert!(result.intents.contains(&Intent::CreateCard));
    let record = ledger
        .load(&result.canonical.canonical_event_id)
        .unwrap()
        .unwrap();
    assert!(record.native_notification_emitted_at.is_none());
    assert!(record.native_notification_suppressed_at.is_some());
}

#[test]
fn immediate_relaunch_same_pane_old_generation_never_completes_new_generation() {
    let old = launch("pane-a", 1);
    let new = launch("pane-a", 2);
    let mut reconciler = Reconciler::new();
    reconciler.register_launch(old.clone(), HookMode::Installed);
    reconciler.register_launch(new.clone(), HookMode::Installed);
    let outcome = reconciler.ingest(observation(
        &old,
        "turn-old",
        NormalizedState::TurnEnded,
        ObservationSource::Hook,
        100,
        "old-hook",
    ));
    assert!(matches!(
        outcome,
        ReconcileOutcome::Rejected {
            reason: RejectionReason::StaleLaunch,
            ..
        }
    ));
    assert!(reconciler.canonical_for(&new).is_none());
}

#[test]
fn simulated_process_restart_reload_ledger_does_not_renotify() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("agent-state.db");
    let launch = launch("pane-a", 1);
    let canonical_event_id;
    {
        let mut reconciler = Reconciler::new();
        reconciler.register_launch(launch.clone(), HookMode::Installed);
        let mut ledger = Ledger::from_connection(Connection::open(&database).unwrap()).unwrap();
        let result = reserve(
            &mut reconciler,
            &mut ledger,
            observation(
                &launch,
                "turn-a",
                NormalizedState::TurnEnded,
                ObservationSource::Hook,
                100,
                "hook-a",
            ),
        )
        .unwrap();
        canonical_event_id = result.canonical.canonical_event_id.clone();
        assert_eq!(notification_count(&[result]), 1);
    }
    let mut reconciler = Reconciler::new();
    reconciler.register_launch(launch.clone(), HookMode::Unavailable);
    let mut ledger = Ledger::from_connection(Connection::open(&database).unwrap()).unwrap();
    assert!(ledger.load(&canonical_event_id).unwrap().is_some());
    let replay = reserve(
        &mut reconciler,
        &mut ledger,
        observation(
            &launch,
            "turn-a",
            NormalizedState::TurnEnded,
            ObservationSource::Rollout,
            200,
            "rollout-rescan",
        ),
    )
    .unwrap();
    assert!(replay.intents.is_empty());
}

#[test]
fn attention_required_beats_provisional_turn_ended() {
    let launch = launch("pane-a", 1);
    let mut reconciler = Reconciler::new();
    reconciler.register_launch(launch.clone(), HookMode::Installed);
    let mut ledger = ledger();
    let rollout = reserve(
        &mut reconciler,
        &mut ledger,
        observation(
            &launch,
            "turn-a",
            NormalizedState::TurnEnded,
            ObservationSource::Rollout,
            100,
            "rollout-a",
        ),
    )
    .unwrap();
    assert_eq!(rollout.canonical.confirmation, Confirmation::Provisional);
    let hook = reserve(
        &mut reconciler,
        &mut ledger,
        observation(
            &launch,
            "turn-a",
            NormalizedState::AttentionRequired,
            ObservationSource::Hook,
            200,
            "hook-a",
        ),
    )
    .unwrap();
    assert_eq!(hook.canonical.state, NormalizedState::AttentionRequired);
    assert_eq!(hook.canonical.confirmation, Confirmation::Confirmed);
}

#[test]
fn late_hook_after_grace_corrects_state_without_renotifying() {
    let launch = launch("pane-a", 1);
    let mut reconciler = Reconciler::new();
    reconciler.register_launch(launch.clone(), HookMode::Installed);
    let mut ledger = ledger();
    let provisional = reserve(
        &mut reconciler,
        &mut ledger,
        observation(
            &launch,
            "turn-a",
            NormalizedState::TurnEnded,
            ObservationSource::Rollout,
            100,
            "rollout-a",
        ),
    )
    .unwrap();
    assert!(provisional.intents.is_empty());
    let promoted = reserve_promotions(&mut reconciler, &mut ledger, 3_100);
    assert_eq!(notification_count(&promoted), 1);
    let late = reserve(
        &mut reconciler,
        &mut ledger,
        observation(
            &launch,
            "turn-a",
            NormalizedState::AttentionRequired,
            ObservationSource::Hook,
            10_100,
            "hook-late",
        ),
    )
    .unwrap();
    assert_eq!(late.canonical.state, NormalizedState::AttentionRequired);
    assert!(late.intents.is_empty());
}

#[test]
fn twenty_panes_firing_concurrently_keep_states_independent() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("agent-state.db");
    drop(Ledger::from_connection(Connection::open(&database).unwrap()).unwrap());
    let barrier = Arc::new(Barrier::new(20));
    let mut handles = Vec::new();
    for index in 0..20 {
        let database = database.clone();
        let barrier = barrier.clone();
        handles.push(std::thread::spawn(move || {
            let launch = launch(&format!("pane-{index}"), 1);
            let mut reconciler = Reconciler::new();
            reconciler.register_launch(launch.clone(), HookMode::Installed);
            let mut ledger = Ledger::from_connection(Connection::open(database).unwrap()).unwrap();
            barrier.wait();
            reserve(
                &mut reconciler,
                &mut ledger,
                observation(
                    &launch,
                    &format!("turn-{index}"),
                    NormalizedState::TurnEnded,
                    ObservationSource::Hook,
                    100 + index,
                    &format!("hook-{index}"),
                ),
            )
            .unwrap()
        }));
    }
    let results = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(notification_count(&results), 20);
    let ledger = Ledger::from_connection(Connection::open(database).unwrap()).unwrap();
    assert_eq!(ledger.count_records().unwrap(), 20);
}

#[test]
fn shuffled_permutations_are_deterministic() {
    let launch = launch("pane-a", 1);
    let events = vec![
        observation(
            &launch,
            "turn-a",
            NormalizedState::TurnActive,
            ObservationSource::Hook,
            10,
            "hook-active",
        ),
        observation(
            &launch,
            "turn-a",
            NormalizedState::TurnEnded,
            ObservationSource::Rollout,
            20,
            "rollout-ended",
        ),
        observation(
            &launch,
            "turn-a",
            NormalizedState::TurnEnded,
            ObservationSource::Title,
            30,
            "title-ended",
        ),
        observation(
            &launch,
            "turn-a",
            NormalizedState::AttentionRequired,
            ObservationSource::Hook,
            40,
            "hook-attention",
        ),
    ];
    let mut expected: Option<(BTreeMap<String, NormalizedState>, Vec<(String, Intent)>)> = None;
    let mut rng = StdRng::seed_from_u64(0x5eed);
    for _ in 0..100 {
        let mut shuffled = events.clone();
        shuffled.shuffle(&mut rng);
        let mut reconciler = Reconciler::new();
        reconciler.register_launch(launch.clone(), HookMode::Installed);
        let mut ledger = ledger();
        let mut intents = Vec::new();
        for event in shuffled {
            if let Some(result) = reserve(&mut reconciler, &mut ledger, event) {
                intents.extend(
                    result
                        .intents
                        .into_iter()
                        .map(|intent| (result.canonical.canonical_event_id.clone(), intent)),
                );
            }
        }
        intents.sort();
        let states = super::reconciler::canonical_signature(&reconciler)
            .into_iter()
            .map(|(id, state, _)| (id, state))
            .collect::<BTreeMap<_, _>>();
        let value = (states, intents);
        if let Some(expected) = &expected {
            assert_eq!(&value, expected);
        } else {
            expected = Some(value);
        }
    }
}

#[test]
fn no_hooks_rollout_terminal_confirms_immediately() {
    let launch = launch("pane-a", 1);
    let mut reconciler = Reconciler::new();
    reconciler.register_launch(launch.clone(), HookMode::Unavailable);
    let mut ledger = ledger();
    let result = reserve(
        &mut reconciler,
        &mut ledger,
        observation(
            &launch,
            "turn-a",
            NormalizedState::TurnEnded,
            ObservationSource::Rollout,
            100,
            "rollout-a",
        ),
    )
    .unwrap();
    assert_eq!(result.canonical.confirmation, Confirmation::Confirmed);
    assert!(result.intents.contains(&Intent::EmitNotification));
}

#[test]
fn exact_grace_deadline_promotes_provisional_rollout() {
    let launch = launch("pane-a", 1);
    let mut reconciler = Reconciler::new();
    reconciler.register_launch(launch.clone(), HookMode::Installed);
    let mut ledger = ledger();
    reserve(
        &mut reconciler,
        &mut ledger,
        observation(
            &launch,
            "turn-a",
            NormalizedState::TurnEnded,
            ObservationSource::Rollout,
            100,
            "rollout-a",
        ),
    )
    .unwrap();
    assert!(reserve_promotions(&mut reconciler, &mut ledger, 3_099).is_empty());
    let promoted = reserve_promotions(&mut reconciler, &mut ledger, 3_100);
    assert_eq!(promoted.len(), 1);
    assert_eq!(promoted[0].canonical.confirmation, Confirmation::Confirmed);
}

#[test]
fn title_hint_alone_never_justifies_notification() {
    let launch = launch("pane-a", 1);
    let mut reconciler = Reconciler::new();
    reconciler.register_launch(launch.clone(), HookMode::Unavailable);
    let mut ledger = ledger();
    let result = reserve(
        &mut reconciler,
        &mut ledger,
        observation(
            &launch,
            "turn-a",
            NormalizedState::TurnEnded,
            ObservationSource::Title,
            100,
            "title-a",
        ),
    )
    .unwrap();
    assert!(result.intents.is_empty());
}

#[test]
fn process_exit_is_not_turn_success() {
    let launch = launch("pane-a", 1);
    let mut reconciler = Reconciler::new();
    reconciler.register_launch(launch.clone(), HookMode::Unavailable);
    let outcome = reconciler.ingest(observation(
        &launch,
        "turn-a",
        NormalizedState::ProcessExited,
        ObservationSource::Process,
        100,
        "process-a",
    ));
    let ReconcileOutcome::Accepted(accepted) = outcome else {
        panic!("process exit should be accepted");
    };
    assert_eq!(accepted.canonical.state, NormalizedState::ProcessExited);
    assert_ne!(accepted.canonical.state, NormalizedState::TurnEnded);
}

#[test]
fn same_turn_cannot_return_active_after_terminal() {
    let launch = launch("pane-a", 1);
    let mut reconciler = Reconciler::new();
    reconciler.register_launch(launch.clone(), HookMode::Installed);
    assert!(matches!(
        reconciler.ingest(observation(
            &launch,
            "turn-a",
            NormalizedState::TurnEnded,
            ObservationSource::Hook,
            100,
            "ended-a",
        )),
        ReconcileOutcome::Accepted(_)
    ));
    let outcome = reconciler.ingest(observation(
        &launch,
        "turn-a",
        NormalizedState::TurnActive,
        ObservationSource::Hook,
        200,
        "active-a",
    ));
    assert!(matches!(
        outcome,
        ReconcileOutcome::Rejected {
            reason: RejectionReason::ActiveAfterTerminal,
            ..
        }
    ));
    assert_eq!(
        reconciler.canonical_for(&launch).unwrap().state,
        NormalizedState::TurnEnded
    );
}

#[test]
fn rejected_observation_changes_nothing_and_emits_no_intents() {
    let launch = launch("pane-a", 1);
    let mut reconciler = Reconciler::new();
    reconciler.register_launch(launch.clone(), HookMode::Installed);
    let outcome = reconciler.ingest(observation(
        &launch,
        "turn-a",
        NormalizedState::TurnEnded,
        ObservationSource::Process,
        100,
        "invalid-process",
    ));
    assert!(matches!(
        outcome,
        ReconcileOutcome::Rejected {
            reason: RejectionReason::InvalidProcessObservation,
            canonical: None
        }
    ));
    assert!(reconciler.canonical_for(&launch).is_none());
}

#[test]
fn synthetic_turn_ids_are_issued_monotonically_per_launch() {
    let launch = launch("pane-a", 1);
    let mut reconciler = Reconciler::new();
    reconciler.register_launch(launch.clone(), HookMode::Installed);
    assert_eq!(
        reconciler.issue_synthetic_turn(&launch),
        Some(ProviderTurnId::Synthetic(1))
    );
    assert_eq!(
        reconciler.issue_synthetic_turn(&launch),
        Some(ProviderTurnId::Synthetic(2))
    );
}

#[test]
fn caller_result_and_acknowledgement_are_recorded_without_clearing_reservation() {
    let launch = launch("pane-a", 1);
    let mut reconciler = Reconciler::new();
    reconciler.register_launch(launch.clone(), HookMode::Installed);
    let mut ledger = ledger();
    let result = reserve(
        &mut reconciler,
        &mut ledger,
        observation(
            &launch,
            "turn-a",
            NormalizedState::TurnEnded,
            ObservationSource::Hook,
            100,
            "hook-a",
        ),
    )
    .unwrap();
    ledger
        .record_intent_result(
            &result.canonical.canonical_event_id,
            Intent::EmitNotification,
            false,
            MonotonicTime::new(110),
            Some("platform rejected"),
        )
        .unwrap();
    assert!(ledger
        .acknowledge(
            &result.canonical.canonical_event_id,
            MonotonicTime::new(120)
        )
        .unwrap());
    let record = ledger
        .load(&result.canonical.canonical_event_id)
        .unwrap()
        .unwrap();
    assert_eq!(record.native_notification_emitted_at, Some(100));
    assert_eq!(record.acknowledged_at, Some(120));
}
