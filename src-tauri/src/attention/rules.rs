use std::collections::{BTreeMap, BTreeSet};

use super::model::{
    card_id, AttentionCard, AttentionKind, CardState, EvidenceRef, PrimaryAction, ReplyRoute,
    ResolutionPredicate, SessionRef,
};

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObservationKind {
    Attention(AttentionKind),
    ToolProgress,
    IntermediateTestPassed,
    RepeatedError,
    NoActionReport,
    UnsupportedInference,
    UnrelatedObservation,
    DuplicateCause,
    LongRunning,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttentionObservation {
    pub key: String,
    pub fingerprint: String,
    pub kind: ObservationKind,
    pub workorder_id: Option<String>,
    pub session: Option<SessionRef>,
    pub why_now: String,
    pub impact: String,
    pub evidence: Vec<EvidenceRef>,
    pub primary_action: Option<PrimaryAction>,
    pub reply_route: ReplyRoute,
    pub resolution_predicate: ResolutionPredicate,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AttentionSnapshot {
    pub observations: BTreeMap<String, AttentionObservation>,
    pub active_workorders: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttentionInput {
    pub previous: AttentionSnapshot,
    pub current: AttentionSnapshot,
    pub existing_cards: Vec<AttentionCard>,
    pub tracked_pty_sessions: BTreeSet<String>,
    pub now: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttentionCandidate {
    pub card: AttentionCard,
    pub observation_key: String,
}

/// This is the sole qualification gate. Individual rules only describe facts;
/// they cannot bypass transition, action, evidence, tracking, or dedupe.
fn qualifies(input: &AttentionInput, observation: &AttentionObservation) -> bool {
    let ObservationKind::Attention(kind) = observation.kind else {
        return false;
    };
    let transitioned = input.previous.observations.get(&observation.key) != Some(observation);
    let related_to_tracking = observation.workorder_id.is_some()
        || matches!(observation.session.as_ref(), Some(SessionRef::Pty { pty_session_id }) if input.tracked_pty_sessions.contains(pty_session_id));
    let action_available =
        observation.primary_action.is_some() || matches!(kind, AttentionKind::GoalReached);
    // A matching fingerprint is still evaluated so the store can upsert the
    // existing card instead of creating a replacement card for the same cause.
    transitioned && related_to_tracking && !observation.evidence.is_empty() && action_available
}

pub fn evaluate(input: &AttentionInput) -> Vec<AttentionCandidate> {
    input
        .current
        .observations
        .values()
        .filter_map(|observation| {
            if !qualifies(input, observation) {
                return None;
            }
            let ObservationKind::Attention(kind) = observation.kind else {
                return None;
            };
            let primary_action = observation.primary_action.clone()?;
            Some(AttentionCandidate {
                observation_key: observation.key.clone(),
                card: AttentionCard {
                    id: card_id(&observation.fingerprint),
                    fingerprint: observation.fingerprint.clone(),
                    kind,
                    workorder_id: observation.workorder_id.clone(),
                    session: observation.session.clone(),
                    why_now: observation.why_now.clone(),
                    impact: observation.impact.clone(),
                    evidence: observation.evidence.clone(),
                    primary_action,
                    reply_route: observation.reply_route.clone(),
                    resolution_predicate: observation.resolution_predicate.clone(),
                    state: CardState::Open,
                    first_seen_at: input.now,
                    last_seen_at: input.now,
                    revision: 1,
                    resolved_at: None,
                },
            })
        })
        .collect()
}

pub fn evaluate_resolutions(input: &AttentionInput) -> Vec<String> {
    input
        .existing_cards
        .iter()
        .filter_map(|card| {
            if card.state != CardState::Open {
                return None;
            }
            let resolved = match &card.resolution_predicate {
                ResolutionPredicate::ObservationMissing { observation_key } => {
                    !input.current.observations.contains_key(observation_key)
                }
                ResolutionPredicate::WorkOrderInactive { workorder_id } => {
                    !input.current.active_workorders.contains(workorder_id)
                }
                ResolutionPredicate::UserAcknowledged => false,
            };
            resolved.then(|| card.id.clone())
        })
        .collect()
}
