mod model;
mod rules;
mod schema;
pub(crate) mod store;

pub use model::*;

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
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
    let database = Arc::new(Mutex::new(None));
    tauri::async_runtime::spawn(async move {
        let mut sessions = sessions_by_id(initial.snapshot.sessions);
        let mut server_epoch = initial.snapshot.server_epoch;
        let mut seq = initial.snapshot.seq;
        let mut previous = baseline(&sessions, livebrief.clone(), database.clone()).await;
        let mut pending_evaluation = false;
        let debounce = tokio::time::sleep(Duration::from_secs(60 * 60));
        tokio::pin!(debounce);
        loop {
            tokio::select! {
                event = subscription.recv() => {
                    let Some(event) = event else { break; };
                    match event {
                        StatusEvent::ResyncRequired(_) => {
                            let snapshot = status_feed.resnapshot(&subscription);
                            sessions = sessions_by_id(snapshot.sessions);
                            server_epoch = snapshot.server_epoch;
                            seq = snapshot.seq;
                            previous = baseline(&sessions, livebrief.clone(), database.clone()).await;
                            pending_evaluation = false;
                        }
                        StatusEvent::Changed(change) => {
                            if change.server_epoch != server_epoch || change.seq != seq.saturating_add(1) {
                        let snapshot = status_feed.resnapshot(&subscription);
                        sessions = sessions_by_id(snapshot.sessions);
                        server_epoch = snapshot.server_epoch;
                        seq = snapshot.seq;
                        previous = baseline(&sessions, livebrief.clone(), database.clone()).await;
                                pending_evaluation = false;
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
                            pending_evaluation = true;
                            debounce.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(1));
                        }
                    }
                }
                _ = &mut debounce, if pending_evaluation => {
                    pending_evaluation = false;
                    let prior = previous.clone();
                    let status_snapshot = sessions.clone();
                    let service = livebrief.clone();
                    let database = database.clone();
                    let result = tauri::async_runtime::spawn_blocking(move || {
                        evaluate_transition(prior, status_snapshot, service, &database)
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
    database: Arc<Mutex<Option<rusqlite::Connection>>>,
) -> AttentionSnapshot {
    let statuses = sessions.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut database = database.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let conn = attention_connection(&mut database).ok()?;
        build_snapshot(&statuses, &livebrief, conn).ok()
    })
    .await
    .ok()
    .flatten()
    .unwrap_or_default()
}

fn evaluate_transition(
    previous: AttentionSnapshot,
    sessions: BTreeMap<String, FeedSession>,
    livebrief: LiveBriefService,
    database: &Mutex<Option<rusqlite::Connection>>,
) -> Result<(AttentionSnapshot, store::EvaluationResult), String> {
    let mut database = database.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let conn = attention_connection(&mut database)?;
    let current = build_snapshot(&sessions, &livebrief, conn)?;
    let tracked_pty_sessions = store::list_tracked(&conn)?;
    let input = AttentionInput {
        previous,
        current: current.clone(),
        existing_cards: store::list_all_cards(&conn)?,
        tracked_pty_sessions,
        now: now_ms(),
    };
    let attention_cards_enabled = crate::workorder::autonomy_settings(&conn)
        .map_err(|error| error.to_string())?
        .attention_cards;
    let result = store::apply_with_connection(&conn, &input, attention_cards_enabled)?;
    Ok((current, result))
}

fn attention_connection(database: &mut Option<rusqlite::Connection>) -> Result<&rusqlite::Connection, String> {
    if database.is_none() {
        *database = Some(store::open()?);
    }
    Ok(database.as_ref().expect("attention database initialized"))
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
    workorder_connection: &rusqlite::Connection,
) -> Result<AttentionSnapshot, String> {
    let briefs = livebrief.snapshots();
    let ids = briefs
        .iter()
        .map(|brief| brief.binding.pty_session_id.clone())
        .collect::<Vec<_>>();
    let event_tails = livebrief.events(&ids, 200);
    let briefs_by_pty = briefs
        .iter()
        .map(|brief| (brief.binding.pty_session_id.as_str(), brief))
        .collect::<BTreeMap<_, _>>();
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
            let last_output = briefs_by_pty
                .get(session.session_id.as_str())
                .and_then(|brief| brief.activity_text.as_deref())
                .map(compact_evidence_detail)
                .filter(|detail| !detail.is_empty())
                .unwrap_or_else(|| "取得できず".into());
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
                    stopped_evidence(
                        &session.session_id,
                        &format!("{}:{}", session.session_id, session.session_revision),
                        &format!("{:?}", session.status.lifecycle),
                        last_output,
                    ),
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
                    vec![EvidenceRef {
                        source: "livebrief".into(),
                        kind: "question".into(),
                        ref_id: prompt_id,
                        detail: format!("質問本文: {}", compact_evidence_detail(
                            livebrief.agent_asked_excerpt(
                                &brief.binding.pty_session_id,
                                brief.prompt_event_id.as_deref().unwrap_or_default(),
                            )
                            .as_deref()
                            .or(brief.pending_prompt.as_deref())
                            .unwrap_or("取得できず"),
                        )),
                    }],
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
    let (workorder_observations, active_workorders) = store::workorder_observations_with_connection(workorder_connection, &file_changes)?;
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
    evidence: Vec<EvidenceRef>,
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
        evidence,
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

fn compact_evidence_detail(value: &str) -> String {
    let mut detail = value
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .join("\n");
    if detail.chars().count() > 200 {
        detail = format!("{}…", detail.chars().take(199).collect::<String>());
    }
    detail
}

fn stopped_evidence(
    session_id: &str,
    lifecycle: &str,
    lifecycle_detail: &str,
    last_output: String,
) -> Vec<EvidenceRef> {
    vec![
        EvidenceRef {
            source: "status".into(),
            kind: "lifecycle".into(),
            ref_id: lifecycle.into(),
            detail: format!("終了状態: {lifecycle_detail}"),
        },
        EvidenceRef {
            source: "status".into(),
            kind: "exit".into(),
            ref_id: format!("{session_id}:exit"),
            detail: "終了コード・終了理由: 取得できず".into(),
        },
        EvidenceRef {
            source: "livebrief".into(),
            kind: "lastOutput".into(),
            ref_id: format!("{session_id}:last-output"),
            detail: format!("最終出力: {last_output}"),
        },
    ]
}

#[cfg(test)]
mod tests;
