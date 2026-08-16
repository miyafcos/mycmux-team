mod model;
mod rules;
mod schema;
pub(crate) mod store;

pub use model::*;

use std::{
    collections::BTreeMap,
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Emitter};

use crate::livebrief::LiveBriefService;
use crate::session_state::Lifecycle;
use crate::status_feed::{FeedSession, StatusEvent, StatusFeed};

use self::model::{
    AttentionKind, EvidenceRef, PrimaryAction, ReplyRoute, ResolutionPredicate, SessionRef,
};
use self::rules::{AttentionInput, AttentionObservation, AttentionSnapshot, ObservationKind};

const CHANGED_EVENT: &str = "attention://cards-changed";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CardsChanged {
    cards: Vec<AttentionCardView>,
}

/// Starts one StatusFeed subscription. The initial snapshot is a baseline only;
/// evaluation happens solely after a later status transition.
pub fn start(app_handle: AppHandle, status_feed: StatusFeed, livebrief: LiveBriefService) {
    let (subscription, initial) = status_feed.subscribe();
    tauri::async_runtime::spawn(async move {
        let mut sessions = sessions_by_id(initial.snapshot.sessions);
        let mut server_epoch = initial.snapshot.server_epoch;
        let mut seq = initial.snapshot.seq;
        let mut previous = baseline(&sessions, livebrief.clone()).await;
        loop {
            let Some(event) = subscription.recv().await else {
                break;
            };
            match event {
                StatusEvent::ResyncRequired(_) => {
                    let snapshot = status_feed.resnapshot(&subscription);
                    sessions = sessions_by_id(snapshot.sessions);
                    server_epoch = snapshot.server_epoch;
                    seq = snapshot.seq;
                    previous = baseline(&sessions, livebrief.clone()).await;
                }
                StatusEvent::Changed(change) => {
                    if change.server_epoch != server_epoch || change.seq != seq.saturating_add(1) {
                        let snapshot = status_feed.resnapshot(&subscription);
                        sessions = sessions_by_id(snapshot.sessions);
                        server_epoch = snapshot.server_epoch;
                        seq = snapshot.seq;
                        previous = baseline(&sessions, livebrief.clone()).await;
                        continue;
                    }
                    server_epoch = change.server_epoch;
                    seq = change.seq;
                    sessions.insert(
                        change.session_id.clone(),
                        FeedSession {
                            session_id: change.session_id,
                            session_revision: change.session_revision,
                            status: change.status,
                        },
                    );
                    let prior = previous.clone();
                    let status_snapshot = sessions.clone();
                    let service = livebrief.clone();
                    let result = tauri::async_runtime::spawn_blocking(move || {
                        evaluate_transition(prior, status_snapshot, service)
                    })
                    .await;
                    let Ok(Ok((current, result))) = result else {
                        continue;
                    };
                    previous = current;
                    if result.changed {
                        let _ = app_handle.emit(
                            CHANGED_EVENT,
                            CardsChanged {
                                cards: result.cards,
                            },
                        );
                    }
                }
            }
        }
    });
}

async fn baseline(
    sessions: &BTreeMap<String, FeedSession>,
    livebrief: LiveBriefService,
) -> AttentionSnapshot {
    let statuses = sessions.clone();
    tauri::async_runtime::spawn_blocking(move || {
        build_snapshot(&statuses, &livebrief).unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

fn evaluate_transition(
    previous: AttentionSnapshot,
    sessions: BTreeMap<String, FeedSession>,
    livebrief: LiveBriefService,
) -> Result<(AttentionSnapshot, store::EvaluationResult), String> {
    let conn = store::open()?;
    let tracked_pty_sessions = store::list_tracked(&conn)?;
    let current = build_snapshot(&sessions, &livebrief)?;
    let input = AttentionInput {
        previous,
        current: current.clone(),
        existing_cards: store::list_all_cards(&conn)?,
        tracked_pty_sessions,
        now: now_ms(),
    };
    let result = store::apply_with_connection(&conn, &input)?;
    Ok((current, result))
}

fn sessions_by_id(sessions: Vec<FeedSession>) -> BTreeMap<String, FeedSession> {
    sessions
        .into_iter()
        .map(|session| (session.session_id.clone(), session))
        .collect()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

fn build_snapshot(
    sessions: &BTreeMap<String, FeedSession>,
    livebrief: &LiveBriefService,
) -> Result<AttentionSnapshot, String> {
    let briefs = livebrief.snapshots();
    let ids = briefs
        .iter()
        .map(|brief| brief.binding.pty_session_id.clone())
        .collect::<Vec<_>>();
    let event_tails = livebrief.events(&ids, 200);
    let mut observations = BTreeMap::new();
    let mut file_changes = BTreeMap::<String, Vec<(String, String)>>::new();
    let logical_by_pty = briefs
        .iter()
        .filter(|brief| !brief.binding.agent_session_id.is_empty())
        .map(|brief| {
            (
                brief.binding.pty_session_id.clone(),
                brief.binding.agent_session_id.clone(),
            )
        })
        .collect::<BTreeMap<_, _>>();

    for session in sessions.values() {
        let stopped = matches!(
            session.status.lifecycle,
            Lifecycle::Exited | Lifecycle::Orphaned
        );
        if stopped {
            let key = format!(
                "work-stopped:{}:{}",
                session.session_id, session.session_revision
            );
            observations.insert(
                key.clone(),
                session_observation(
                    key.clone(),
                    format!("work-stopped:{}", session.session_id),
                    AttentionKind::WorkStopped,
                    &session.session_id,
                    "作業中のセッションが停止しました",
                    "再開または確認が必要です",
                    EvidenceRef {
                        source: "status".into(),
                        kind: "lifecycle".into(),
                        ref_id: format!("{}:{}", session.session_id, session.session_revision),
                        detail: format!("{:?}", session.status.lifecycle),
                    },
                    PrimaryAction::OpenSession {
                        session: SessionRef::Pty {
                            pty_session_id: session.session_id.clone(),
                        },
                    },
                ),
            );
        }
    }
    for brief in &briefs {
        if brief.pending_prompt.is_some() || brief.operational_state == "needsHuman" {
            let prompt_id = brief
                .prompt_event_id
                .clone()
                .unwrap_or_else(|| format!("brief:{}", brief.brief_revision));
            let key = format!("agent-asked:{}:{prompt_id}", brief.binding.pty_session_id);
            observations.insert(
                key.clone(),
                session_observation(
                    key.clone(),
                    key.clone(),
                    AttentionKind::AgentAsked,
                    &brief.binding.pty_session_id,
                    "回答または承認を待っています",
                    "回答があるまで次に進めません",
                    EvidenceRef {
                        source: "livebrief".into(),
                        kind: "question".into(),
                        ref_id: prompt_id,
                        detail: brief
                            .pending_prompt
                            .clone()
                            .unwrap_or_else(|| "質問を検知しました".into()),
                    },
                    PrimaryAction::AnswerQuestion {
                        session: SessionRef::Pty {
                            pty_session_id: brief.binding.pty_session_id.clone(),
                        },
                    },
                ),
            );
        }
    }
    for tail in event_tails {
        let logical = logical_by_pty.get(&tail.pty_session_id);
        let Some(logical) = logical else {
            continue;
        };
        for event in tail.events {
            let value = serde_json::to_value(event).map_err(|error| error.to_string())?;
            if value
                .pointer("/kind/type")
                .and_then(serde_json::Value::as_str)
                != Some("fileChange")
            {
                continue;
            }
            let Some(path) = value
                .pointer("/kind/path")
                .and_then(serde_json::Value::as_str)
            else {
                continue;
            };
            let event_id = value
                .get("eventId")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("file-change");
            file_changes
                .entry(logical.clone())
                .or_default()
                .push((event_id.to_owned(), path.to_owned()));
        }
    }
    let (workorder_observations, active_workorders) = store::workorder_observations(&file_changes)?;
    for observation in workorder_observations {
        observations.insert(observation.key.clone(), observation);
    }
    Ok(AttentionSnapshot {
        observations,
        active_workorders,
    })
}

fn session_observation(
    key: String,
    fingerprint: String,
    kind: AttentionKind,
    pty_session_id: &str,
    why_now: &str,
    impact: &str,
    evidence: EvidenceRef,
    primary_action: PrimaryAction,
) -> AttentionObservation {
    AttentionObservation {
        fingerprint,
        key: key.clone(),
        kind: ObservationKind::Attention(kind),
        workorder_id: None,
        session: Some(SessionRef::Pty {
            pty_session_id: pty_session_id.to_owned(),
        }),
        why_now: why_now.into(),
        impact: impact.into(),
        evidence: vec![evidence],
        primary_action: Some(primary_action),
        reply_route: ReplyRoute::Session {
            session: SessionRef::Pty {
                pty_session_id: pty_session_id.to_owned(),
            },
        },
        resolution_predicate: ResolutionPredicate::ObservationMissing {
            observation_key: key,
        },
    }
}

#[cfg(test)]
mod tests;
