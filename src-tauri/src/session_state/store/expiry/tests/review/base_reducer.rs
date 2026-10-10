// Exact reducer function from a30907c44; helpers/types stay production-identical.
// Function SHA256: d5ef3b2ae1f0f1a9afda95d05a41cd1de3757426668dca118e506ecee5cf8529
use crate::session_state::*;

pub fn reduce(previous: &SessionView, evidence: &Evidence) -> SessionView {
    if !evidence_epoch_is_current(previous, evidence)
        || !process_evidence_is_current(previous, evidence)
    {
        return previous.clone();
    }

    let mut view = match (previous.session_epoch, evidence.session_epoch) {
        (Some(current), Some(incoming)) if incoming > current => {
            reset_for_epoch(previous, incoming)
        }
        _ => previous.clone(),
    };
    if view.session_epoch.is_none() {
        view.session_epoch = evidence.session_epoch;
    }

    // Exit is terminal within a PTY epoch. A late create/reattach completion
    // or buffered output must not revive a process already reported exited.
    // A new epoch was reset above, so dormancy can still recreate the same id.
    if view.lifecycle == Lifecycle::Exited {
        return view;
    }

    let before = view.clone();
    match &evidence.signal {
        EvidenceSignal::MonitorStatus { status } => {
            if evidence.observed_at < view.last_monitor_at {
                return previous.clone();
            }
            view.last_monitor_at = evidence.observed_at;
            view.lifecycle = Lifecycle::Alive;
            view.process = evidence.process.clone().or(view.process);
            view.activity = match status {
                MonitorStatus::Working => {
                    if view.last_output_at > 0
                        && evidence.observed_at.saturating_sub(view.last_output_at) <= 5_000
                    {
                        Activity::Streaming
                    } else {
                        Activity::RunningSilent
                    }
                }
                MonitorStatus::Idle => Activity::Idle,
                MonitorStatus::Unknown => Activity::Unknown,
            };
            view.health = if *status == MonitorStatus::Unknown {
                Health::Degraded
            } else {
                Health::Fresh
            };
        }
        EvidenceSignal::WorkDone { .. } => {
            view.activity = Activity::Idle;
            view.lifecycle = Lifecycle::Alive;
            view.health = Health::Fresh;
        }
        EvidenceSignal::LastOutput { origin } => {
            if *origin != OutputOrigin::Pty || evidence.observed_at <= view.last_output_at {
                return previous.clone();
            }
            view.last_output_at = evidence.observed_at;
            view.activity = Activity::Streaming;
            view.lifecycle = Lifecycle::Alive;
            view.health = Health::Fresh;
        }
        EvidenceSignal::ScreenScan {
            attention,
            attention_id,
            detail,
            confidence,
            stale_after,
            complete,
            resync,
        } => {
            if *resync || !*complete {
                view.health = Health::Degraded;
            } else {
                apply_attention(
                    &mut view,
                    evidence,
                    AttentionUpdate {
                        kind: *attention,
                        supplied_id: attention_id.as_ref(),
                        detail,
                        confidence: *confidence,
                        stale_after: *stale_after,
                    },
                );
                view.health = Health::Fresh;
            }
        }
        EvidenceSignal::Hook {
            attention,
            attention_id,
            detail,
            confidence,
            stale_after,
        } => {
            apply_attention(
                &mut view,
                evidence,
                AttentionUpdate {
                    kind: *attention,
                    supplied_id: attention_id.as_ref(),
                    detail,
                    confidence: *confidence,
                    stale_after: *stale_after,
                },
            );
            view.health = Health::Fresh;
        }
        EvidenceSignal::SocketLifecycle { lifecycle } => {
            view.lifecycle = *lifecycle;
            view.health = if *lifecycle == Lifecycle::Orphaned {
                Health::Degraded
            } else {
                Health::Fresh
            };
            if *lifecycle == Lifecycle::Exited {
                view.activity = Activity::Idle;
            }
        }
    }

    let state_changed = if matches!(&evidence.signal, EvidenceSignal::LastOutput { .. }) {
            let mut without_last_output_at = view.clone();
            without_last_output_at.last_output_at = before.last_output_at;
            without_last_output_at != before
    } else {
        view != before
    };
    if state_changed {
        view.session_revision = previous.session_revision.saturating_add(1);
        view.last_evidence_at = view.last_evidence_at.max(evidence.observed_at);
    }
    view
}
