use std::collections::BTreeMap;

#[cfg(test)]
use std::collections::BTreeSet;

use super::model::*;

pub const ROLLOUT_GRACE_MS: u64 = 3_000;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct TurnScope {
    provider_session_id: ProviderSessionId,
    provider_turn_id: ProviderTurnId,
}

impl TurnScope {
    fn from_identity(identity: &IdentityKey) -> Self {
        Self {
            provider_session_id: identity.provider_session_id().clone(),
            provider_turn_id: identity.provider_turn_id().clone(),
        }
    }
}

#[derive(Debug, Clone)]
struct Evidence {
    source: ObservationSource,
    state: NormalizedState,
    received_at: MonotonicTime,
    source_event_id: SourceEventId,
    payload_hash: Option<PayloadHash>,
}

#[derive(Debug, Clone, Default)]
struct IdentityEvidence {
    items: Vec<Evidence>,
}

#[derive(Debug, Clone, Default)]
struct TurnRuntime {
    evidence: BTreeMap<IdentityKey, IdentityEvidence>,
    visible_intents_issued: bool,
    canonical: Option<CanonicalState>,
}

#[derive(Debug, Clone)]
struct LaunchRuntime {
    key: LaunchKey,
    hook_mode: HookMode,
    pane_closed_at: Option<MonotonicTime>,
    turns: BTreeMap<TurnScope, TurnRuntime>,
    current: Option<CanonicalState>,
    next_synthetic_turn: u64,
}

#[derive(Debug, Clone, Default)]
pub struct Reconciler {
    launches: BTreeMap<LaunchSlot, LaunchRuntime>,
}

impl Reconciler {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_launch(&mut self, key: LaunchKey, hook_mode: HookMode) -> bool {
        let slot = key.slot();
        match self.launches.get(&slot) {
            Some(existing) if existing.key.generation() > key.generation() => false,
            Some(existing) if existing.key.generation() == key.generation() => false,
            _ => {
                self.launches.insert(
                    slot,
                    LaunchRuntime {
                        key,
                        hook_mode,
                        pane_closed_at: None,
                        turns: BTreeMap::new(),
                        current: None,
                        next_synthetic_turn: 0,
                    },
                );
                true
            }
        }
    }

    pub fn issue_synthetic_turn(&mut self, launch: &LaunchKey) -> Option<ProviderTurnId> {
        let runtime = self.launches.get_mut(&launch.slot())?;
        if runtime.key.generation() != launch.generation() {
            return None;
        }
        runtime.next_synthetic_turn = runtime.next_synthetic_turn.saturating_add(1);
        Some(ProviderTurnId::Synthetic(runtime.next_synthetic_turn))
    }

    pub fn mark_session_closed(&mut self, launch: &LaunchKey, at: MonotonicTime) -> bool {
        let Some(runtime) = self.launches.get_mut(&launch.slot()) else {
            return false;
        };
        if runtime.key.generation() != launch.generation() {
            return false;
        }
        runtime.pane_closed_at = Some(at);
        true
    }

    pub fn mark_pane_closed(&mut self, launch: &LaunchKey, at: MonotonicTime) -> bool {
        self.mark_session_closed(launch, at)
    }

    pub fn canonical_for(&self, launch: &LaunchKey) -> Option<&CanonicalState> {
        self.launches
            .get(&launch.slot())
            .filter(|runtime| runtime.key.generation() == launch.generation())
            .and_then(|runtime| runtime.current.as_ref())
    }

    pub fn ingest(&mut self, observation: Observation) -> ReconcileOutcome {
        let launch = observation.identity().launch();
        let slot = launch.slot();
        let Some(runtime) = self.launches.get_mut(&slot) else {
            return rejected(RejectionReason::UnknownLaunch, None);
        };
        if launch.generation() < runtime.key.generation() {
            return rejected(RejectionReason::StaleLaunch, runtime.current.clone());
        }
        if launch.generation() > runtime.key.generation() {
            return rejected(RejectionReason::FutureLaunch, runtime.current.clone());
        }
        if observation.source() == ObservationSource::Process
            && observation.state() != NormalizedState::ProcessExited
        {
            return rejected(
                RejectionReason::InvalidProcessObservation,
                runtime.current.clone(),
            );
        }
        if runtime.pane_closed_at.is_some() && !observation.state().is_terminal() {
            return rejected(
                RejectionReason::NonTerminalAfterPaneClose,
                runtime.current.clone(),
            );
        }

        let turn_scope = TurnScope::from_identity(observation.identity());
        let turn = runtime.turns.entry(turn_scope.clone()).or_default();
        if observation.state() == NormalizedState::TurnActive
            && turn
                .evidence
                .keys()
                .any(|identity| identity.event_kind().is_terminal())
        {
            return rejected(
                RejectionReason::ActiveAfterTerminal,
                runtime.current.clone(),
            );
        }

        let identity_evidence = turn
            .evidence
            .entry(observation.identity().clone())
            .or_default();
        if let Some(existing) = identity_evidence
            .items
            .iter()
            .find(|item| item.source_event_id == *observation.source_event_id())
        {
            let same = existing.source == observation.source()
                && existing.payload_hash.as_ref() == observation.provider_payload_hash();
            return rejected(
                if same {
                    RejectionReason::Duplicate
                } else {
                    RejectionReason::ConflictingDuplicate
                },
                runtime.current.clone(),
            );
        }

        identity_evidence.items.push(Evidence {
            source: observation.source(),
            state: observation.state(),
            received_at: observation.received_at(),
            source_event_id: observation.source_event_id().clone(),
            payload_hash: observation.provider_payload_hash().cloned(),
        });

        let previous = turn.canonical.clone();
        let canonical = project_turn(&runtime.key, runtime.hook_mode, &turn_scope, turn);
        let should_issue = canonical.confirmation == Confirmation::Confirmed
            && canonical.state.is_visible()
            && source_can_emit_visible_intents(&canonical)
            && canonical_changed(previous.as_ref(), &canonical)
            && !turn.visible_intents_issued;
        // Title never justifies a visible intent at all; that exclusion lives in
        // source_can_emit_visible_intents and has already run by here. Repeating
        // it as a notification-only suppression made the outcome depend on which
        // observation happened to win authority last, so the same set of facts
        // could emit a notification or not depending on arrival order.
        let suppress_notification = runtime.pane_closed_at.is_some();
        let mut intents = Vec::new();
        if should_issue {
            intents.push(Intent::CreateCard);
            intents.push(Intent::IncrementUnread);
            if !suppress_notification {
                intents.push(Intent::EmitNotification);
            }
            turn.visible_intents_issued = true;
        }
        turn.canonical = Some(canonical.clone());

        if runtime
            .current
            .as_ref()
            .map(|current| canonical_is_newer(current, &canonical))
            .unwrap_or(true)
        {
            runtime.current = Some(canonical.clone());
        } else if runtime
            .current
            .as_ref()
            .map(|current| current.canonical_event_id == canonical.canonical_event_id)
            .unwrap_or(false)
        {
            runtime.current = Some(canonical.clone());
        }

        ReconcileOutcome::Accepted(AcceptedObservation {
            canonical,
            intents,
            observation,
            suppress_notification,
        })
    }

    pub fn advance_time(&mut self, now: MonotonicTime) -> Vec<AcceptedObservation> {
        let mut promoted = Vec::new();
        for runtime in self.launches.values_mut() {
            let scopes = runtime.turns.keys().cloned().collect::<Vec<_>>();
            for scope in scopes {
                let Some(turn) = runtime.turns.get_mut(&scope) else {
                    continue;
                };
                let Some(previous) = turn.canonical.clone() else {
                    continue;
                };
                if previous.confirmation != Confirmation::Provisional {
                    continue;
                }
                let deadline = provisional_deadline(turn);
                if deadline.map(|value| now >= value) != Some(true) {
                    continue;
                }
                let canonical =
                    project_turn_at(&runtime.key, runtime.hook_mode, &scope, turn, Some(now));
                if canonical.confirmation != Confirmation::Confirmed {
                    continue;
                }
                let source_allowed = source_can_emit_visible_intents(&canonical);
                let suppress_notification = runtime.pane_closed_at.is_some();
                let mut intents = Vec::new();
                if canonical.state.is_visible() && !turn.visible_intents_issued && source_allowed {
                    intents.push(Intent::CreateCard);
                    intents.push(Intent::IncrementUnread);
                    if !suppress_notification {
                        intents.push(Intent::EmitNotification);
                    }
                    turn.visible_intents_issued = true;
                }
                turn.canonical = Some(canonical.clone());
                if runtime
                    .current
                    .as_ref()
                    .map(|current| current.canonical_event_id == canonical.canonical_event_id)
                    .unwrap_or(false)
                {
                    runtime.current = Some(canonical.clone());
                }
                let observation = representative_observation(turn, &canonical, now);
                promoted.push(AcceptedObservation {
                    canonical,
                    intents,
                    observation,
                    suppress_notification,
                });
            }
        }
        promoted
    }
}

fn project_turn(
    launch: &LaunchKey,
    hook_mode: HookMode,
    scope: &TurnScope,
    turn: &TurnRuntime,
) -> CanonicalState {
    project_turn_at(launch, hook_mode, scope, turn, None)
}

fn project_turn_at(
    launch: &LaunchKey,
    hook_mode: HookMode,
    scope: &TurnScope,
    turn: &TurnRuntime,
    watermark: Option<MonotonicTime>,
) -> CanonicalState {
    let evidence = turn
        .evidence
        .values()
        .flat_map(|group| group.items.iter())
        .collect::<Vec<_>>();
    let chosen = choose_evidence(&evidence);
    let provisional = chosen.source == ObservationSource::Rollout
        && chosen.state.is_terminal()
        && hook_mode == HookMode::Installed
        && !evidence
            .iter()
            .any(|item| item.source == ObservationSource::Hook)
        && watermark
            .map(|now| now < chosen.received_at.saturating_add(ROLLOUT_GRACE_MS))
            .unwrap_or(true);
    CanonicalState {
        canonical_event_id: turn
            .evidence
            .keys()
            .next()
            .expect("turn contains evidence")
            .canonical_event_id(),
        state: chosen.state,
        state_version: turn.evidence.len() as u64,
        confirmation: if provisional {
            Confirmation::Provisional
        } else {
            Confirmation::Confirmed
        },
        last_received_at: chosen.received_at,
        authority_source: chosen.source,
        launch: launch.clone(),
        provider_session_id: scope.provider_session_id.clone(),
        provider_turn_id: scope.provider_turn_id.clone(),
    }
}

fn choose_evidence<'a>(evidence: &[&'a Evidence]) -> &'a Evidence {
    let hook = evidence
        .iter()
        .copied()
        .filter(|item| item.source == ObservationSource::Hook)
        .max_by_key(|item| (item.received_at, item.state));
    if let Some(hook) = hook {
        return hook;
    }
    evidence
        .iter()
        .copied()
        .filter(|item| item.source != ObservationSource::Title)
        .max_by_key(|item| (item.received_at, item.source, item.state))
        .or_else(|| {
            evidence
                .iter()
                .copied()
                .max_by_key(|item| (item.received_at, item.state))
        })
        .expect("turn contains evidence")
}

fn provisional_deadline(turn: &TurnRuntime) -> Option<MonotonicTime> {
    let evidence = turn
        .evidence
        .values()
        .flat_map(|group| group.items.iter())
        .collect::<Vec<_>>();
    let chosen = choose_evidence(&evidence);
    (chosen.source == ObservationSource::Rollout && chosen.state.is_terminal())
        .then(|| chosen.received_at.saturating_add(ROLLOUT_GRACE_MS))
}

fn representative_observation(
    turn: &TurnRuntime,
    canonical: &CanonicalState,
    now: MonotonicTime,
) -> Observation {
    let (identity, evidence) = turn
        .evidence
        .iter()
        .flat_map(|(identity, group)| group.items.iter().map(move |evidence| (identity, evidence)))
        .filter(|(_, evidence)| evidence.state == canonical.state)
        .max_by_key(|(_, evidence)| (evidence.received_at, evidence.source))
        .expect("canonical evidence exists");
    Observation::new(
        identity.clone(),
        evidence.source,
        now,
        evidence.source_event_id.clone(),
        evidence.payload_hash.clone(),
    )
}

fn source_can_emit_visible_intents(canonical: &CanonicalState) -> bool {
    match canonical.authority_source {
        ObservationSource::Hook => true,
        ObservationSource::Rollout => canonical.state.is_terminal(),
        ObservationSource::Process => canonical.state == NormalizedState::ProcessExited,
        ObservationSource::Title => false,
    }
}

fn canonical_changed(previous: Option<&CanonicalState>, current: &CanonicalState) -> bool {
    previous
        .map(|value| value.state != current.state || value.confirmation != current.confirmation)
        .unwrap_or(true)
}

fn canonical_is_newer(current: &CanonicalState, candidate: &CanonicalState) -> bool {
    if current.launch.generation() != candidate.launch.generation() {
        return current.launch.generation() < candidate.launch.generation();
    }
    current.canonical_event_id == candidate.canonical_event_id
        || candidate.last_received_at > current.last_received_at
}

fn rejected(reason: RejectionReason, canonical: Option<CanonicalState>) -> ReconcileOutcome {
    ReconcileOutcome::Rejected { reason, canonical }
}

#[cfg(test)]
pub(crate) fn canonical_signature(
    reconciler: &Reconciler,
) -> BTreeSet<(String, NormalizedState, Confirmation)> {
    reconciler
        .launches
        .values()
        .flat_map(|launch| launch.turns.values())
        .filter_map(|turn| turn.canonical.as_ref())
        .map(|state| {
            (
                state.canonical_event_id.clone(),
                state.state,
                state.confirmation,
            )
        })
        .collect()
}
