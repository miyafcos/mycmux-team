use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, Connection, OptionalExtension};

use crate::workorder;

use super::model::{
    card_id, AttentionCard, AttentionKind, CardState, EvidenceRef, PrimaryAction, ReplyRoute,
    ResolutionPredicate,
};
use super::rules::{
    evaluate, evaluate_resolutions, AttentionInput, AttentionObservation, ObservationKind,
};
use super::schema;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvaluationResult {
    pub changed: bool,
    pub cards: Vec<AttentionCard>,
}

pub fn open() -> Result<Connection, String> {
    let path = workorder::db_path().map_err(|error| error.to_string())?;
    workorder::ensure_initialized(&path).map_err(|error| error.to_string())?;
    let conn = Connection::open(path).map_err(|error| error.to_string())?;
    schema::init(&conn).map_err(|error| error.to_string())?;
    Ok(conn)
}

pub(crate) fn init_for_test(conn: &Connection) -> Result<(), String> {
    schema::init(conn).map_err(|error| error.to_string())
}

pub fn list_open_cards(conn: &Connection) -> Result<Vec<AttentionCard>, String> {
    list_cards_by_state(conn, CardState::Open)
}

pub(crate) fn list_all_cards(conn: &Connection) -> Result<Vec<AttentionCard>, String> {
    let mut cards = Vec::new();
    for state in [
        CardState::Open,
        CardState::Resolved,
        CardState::Superseded,
        CardState::Bundled,
    ] {
        cards.extend(list_cards_by_state(conn, state)?);
    }
    Ok(cards)
}

fn list_cards_by_state(conn: &Connection, state: CardState) -> Result<Vec<AttentionCard>, String> {
    let mut statement = conn.prepare(
        "SELECT id, fingerprint, kind, workorder_id, session_json, why_now, impact, primary_action_json, \
         reply_route_json, resolution_predicate_json, state, first_seen_at, last_seen_at, revision, resolved_at \
         FROM attention_cards WHERE state=?1 ORDER BY last_seen_at DESC, id ASC",
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([state.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, i64>(11)?,
                row.get::<_, i64>(12)?,
                row.get::<_, u32>(13)?,
                row.get::<_, Option<i64>>(14)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut cards = Vec::new();
    for row in rows {
        let (
            id,
            fingerprint,
            kind,
            workorder_id,
            session_json,
            why_now,
            impact,
            action_json,
            route_json,
            predicate_json,
            state,
            first_seen_at,
            last_seen_at,
            revision,
            resolved_at,
        ) = row.map_err(|error| error.to_string())?;
        let evidence = evidence_for(conn, &id)?;
        cards.push(AttentionCard {
            id,
            fingerprint,
            kind: from_json(&kind)?,
            workorder_id,
            session: session_json.as_deref().map(from_json).transpose()?,
            why_now,
            impact,
            evidence,
            primary_action: from_json(&action_json)?,
            reply_route: from_json(&route_json)?,
            resolution_predicate: from_json(&predicate_json)?,
            state: card_state_from_db(&state)?,
            first_seen_at,
            last_seen_at,
            revision,
            resolved_at,
        });
    }
    Ok(cards)
}

fn evidence_for(conn: &Connection, card_id: &str) -> Result<Vec<EvidenceRef>, String> {
    let mut statement = conn.prepare(
        "SELECT source, kind, ref_id, detail FROM attention_card_evidence WHERE card_id=?1 ORDER BY ordinal",
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([card_id], |row| {
            Ok(EvidenceRef {
                source: row.get(0)?,
                kind: row.get(1)?,
                ref_id: row.get(2)?,
                detail: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn set_tracked(
    conn: &Connection,
    pty_session_id: &str,
    tracked: bool,
    now: i64,
) -> Result<(), String> {
    if tracked {
        conn.execute("INSERT INTO tracked_sessions(pty_session_id, tracked_at) VALUES (?1, ?2) ON CONFLICT(pty_session_id) DO NOTHING", params![pty_session_id, now])
    } else {
        conn.execute("DELETE FROM tracked_sessions WHERE pty_session_id=?1", [pty_session_id])
    }.map_err(|error| error.to_string())?;
    Ok(())
}

pub fn list_tracked(conn: &Connection) -> Result<BTreeSet<String>, String> {
    let mut statement = conn
        .prepare("SELECT pty_session_id FROM tracked_sessions ORDER BY pty_session_id")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<BTreeSet<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn resolve_card(conn: &Connection, id: &str, now: i64) -> Result<bool, String> {
    let updated = conn.execute(
        "UPDATE attention_cards SET state='resolved', resolved_at=?2 WHERE id=?1 AND state='open'",
        params![id, now],
    ).map_err(|error| error.to_string())?;
    Ok(updated > 0)
}

pub(crate) fn apply_with_connection(
    conn: &Connection,
    input: &AttentionInput,
) -> Result<EvaluationResult, String> {
    init_for_test(conn)?;
    let candidates = evaluate(input);
    let refreshed_fingerprints = candidates
        .iter()
        .map(|candidate| candidate.card.fingerprint.clone())
        .collect::<BTreeSet<_>>();
    let mut changed = false;
    for candidate in candidates {
        changed |= upsert(conn, &candidate.card)?;
    }
    for id in evaluate_resolutions(input) {
        let is_refreshed = input
            .existing_cards
            .iter()
            .any(|card| card.id == id && refreshed_fingerprints.contains(&card.fingerprint));
        if is_refreshed {
            continue;
        }
        changed |= resolve_card(conn, &id, input.now)?;
    }
    changed |= bundle_stalled(conn, input.now)?;
    Ok(EvaluationResult {
        changed,
        cards: list_open_cards(conn)?,
    })
}

pub(crate) fn upsert(conn: &Connection, card: &AttentionCard) -> Result<bool, String> {
    init_for_test(conn)?;
    let existing: Option<(String, u32)> = conn
        .query_row(
            "SELECT id, revision FROM attention_cards WHERE fingerprint=?1",
            [card.fingerprint.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some((id, revision)) = existing {
        conn.execute(
            "UPDATE attention_cards SET last_seen_at=?2, revision=?3, state='open', resolved_at=NULL WHERE id=?1",
            params![id, card.last_seen_at, revision.saturating_add(1)],
        ).map_err(|error| error.to_string())?;
        replace_evidence(conn, &id, &card.evidence)?;
        return Ok(true);
    }
    conn.execute(
        "INSERT INTO attention_cards(id, fingerprint, kind, workorder_id, session_json, why_now, impact, primary_action_json, \
         reply_route_json, resolution_predicate_json, state, first_seen_at, last_seen_at, revision, resolved_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            card.id, card.fingerprint, to_json(&card.kind)?, card.workorder_id,
            card.session.as_ref().map(to_json).transpose()?, card.why_now, card.impact,
            to_json(&card.primary_action)?, to_json(&card.reply_route)?, to_json(&card.resolution_predicate)?,
            card.state.as_str(), card.first_seen_at, card.last_seen_at, card.revision, card.resolved_at,
        ],
    ).map_err(|error| error.to_string())?;
    replace_evidence(conn, &card.id, &card.evidence)?;
    Ok(true)
}

fn replace_evidence(
    conn: &Connection,
    card_id: &str,
    evidence: &[EvidenceRef],
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM attention_card_evidence WHERE card_id=?1",
        [card_id],
    )
    .map_err(|error| error.to_string())?;
    for (ordinal, item) in evidence.iter().enumerate() {
        conn.execute(
            "INSERT INTO attention_card_evidence(card_id, ordinal, source, kind, ref_id, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![card_id, ordinal as i64, item.source, item.kind, item.ref_id, item.detail],
        ).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn bundle_stalled(conn: &Connection, now: i64) -> Result<bool, String> {
    let mut statement = conn.prepare(
        "SELECT workorder_id FROM attention_cards WHERE state='open' AND workorder_id IS NOT NULL GROUP BY workorder_id HAVING COUNT(*) > 3",
    ).map_err(|error| error.to_string())?;
    let workorders = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut changed = false;
    for workorder_id in workorders {
        let mut ids = conn
            .prepare(
                "SELECT id FROM attention_cards WHERE state='open' AND workorder_id=?1 ORDER BY id",
            )
            .map_err(|error| error.to_string())?;
        let source_ids = ids
            .query_map([&workorder_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        if source_ids.len() <= 3 {
            continue;
        }
        conn.execute(
            "UPDATE attention_cards SET state='bundled' WHERE state='open' AND workorder_id=?1",
            [&workorder_id],
        )
        .map_err(|error| error.to_string())?;
        let fingerprint = format!("workorder-stalled:{workorder_id}");
        let card = AttentionCard {
            id: card_id(&fingerprint),
            fingerprint,
            kind: AttentionKind::WorkOrderStalled,
            workorder_id: Some(workorder_id.clone()),
            session: None,
            why_now: "同じ実行契約で対応待ちが重なりました".into(),
            impact: "次の判断がないと作業を進められません".into(),
            evidence: source_ids
                .iter()
                .map(|id| EvidenceRef {
                    source: "attention".into(),
                    kind: "card".into(),
                    ref_id: id.clone(),
                    detail: "束ねた気づき".into(),
                })
                .collect(),
            primary_action: PrimaryAction::ReviewConflict {
                workorder_id: workorder_id.clone(),
            },
            reply_route: ReplyRoute::WorkOrder {
                workorder_id: workorder_id.clone(),
            },
            resolution_predicate: ResolutionPredicate::WorkOrderInactive { workorder_id },
            state: CardState::Open,
            first_seen_at: now,
            last_seen_at: now,
            revision: 1,
            resolved_at: None,
        };
        upsert(conn, &card)?;
        changed = true;
    }
    Ok(changed)
}

pub fn workorder_observations(
    file_changes: &BTreeMap<String, Vec<(String, String)>>,
) -> Result<(Vec<AttentionObservation>, BTreeSet<String>), String> {
    let path = workorder::db_path().map_err(|error| error.to_string())?;
    let conn = workorder::reader(&path).map_err(|error| error.to_string())?;
    let mut statement = conn.prepare(
        "SELECT wo.id, wo.plan_version FROM work_orders wo JOIN work_order_versions v ON v.work_order_id=wo.id AND v.plan_version=wo.plan_version WHERE v.sealed_at IS NOT NULL AND wo.state NOT IN ('done','failed','cancelled')",
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let workorders = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut observations = Vec::new();
    let mut active = BTreeSet::new();
    for (workorder_id, version) in workorders {
        active.insert(workorder_id.clone());
        let id =
            workorder::WorkOrderId::try_new(&workorder_id).map_err(|error| error.to_string())?;
        let plan = workorder::load_plan(&conn, &id, version).map_err(|error| error.to_string())?;
        let coverage =
            workorder::source_coverage(&conn, &id, version).map_err(|error| error.to_string())?;
        if coverage.target > 0 && coverage.acquired == coverage.target && coverage.failed == 0 {
            observations.push(workorder_observation(
                AttentionKind::ReportsComplete,
                &workorder_id,
                "reports-complete",
                "必要な報告がそろいました",
                "次の確認に進めます",
                PrimaryAction::ReviewConflict {
                    workorder_id: workorder_id.clone(),
                },
            ));
        }
        let done =
            workorder::done_inputs(&conn, &id, version).map_err(|error| error.to_string())?;
        for item in &done.required_items {
            if item.terminal_report_received
                && item.outcome == Some(workorder::ReportOutcome::Succeeded)
                && item
                    .gates
                    .iter()
                    .any(|gate| gate.status != workorder::GateStatus::Pass)
            {
                observations.push(workorder_observation(
                    AttentionKind::CompletionWithoutTests,
                    &workorder_id,
                    &format!("missing-tests:{}", item.work_item_id.as_str()),
                    "完了の報告はありますが確認が終わっていません",
                    "確認が済むまで完了として扱えません",
                    PrimaryAction::RetryWorkItem {
                        workorder_id: workorder_id.clone(),
                        work_item_id: item.work_item_id.as_str().to_owned(),
                    },
                ));
            }
        }
        let spawn_count: u32 = conn.query_row("SELECT COUNT(*) FROM dispatch_outbox WHERE work_order_id=?1 AND plan_version=?2 AND intent_kind='spawn' AND status='delivered'", params![workorder_id, version], |row| row.get(0)).map_err(|error| error.to_string())?;
        let replan_count = version.saturating_sub(1);
        if spawn_count >= plan.budgets.max_new_pty || replan_count >= plan.budgets.max_replans {
            observations.push(workorder_observation(
                AttentionKind::BudgetReached,
                &workorder_id,
                "budget",
                "使える枠に達しました",
                "追加の開始や再計画には判断が必要です",
                PrimaryAction::RaiseBudget {
                    workorder_id: workorder_id.clone(),
                },
            ));
        }
        for decision in
            workorder::open_decisions(&conn, &id, version).map_err(|error| error.to_string())?
        {
            if decision.kind == workorder::DecisionKind::Conflict {
                observations.push(workorder_observation(
                    AttentionKind::ConflictDetected,
                    &workorder_id,
                    &format!("conflict:{}", decision.id.as_str()),
                    "作業どうしの食い違いを検知しました",
                    "判断するまで安全に進められません",
                    PrimaryAction::ReviewConflict {
                        workorder_id: workorder_id.clone(),
                    },
                ));
            }
        }
        if workorder::is_machine_done(&conn, &id).map_err(|error| error.to_string())? {
            observations.push(workorder_observation(
                AttentionKind::GoalReached,
                &workorder_id,
                "goal",
                "完了条件が満たされました",
                "完了を確認できます",
                PrimaryAction::AcknowledgeGoalReached {
                    workorder_id: workorder_id.clone(),
                },
            ));
        }
        for item in &plan.work_items {
            if item.state != workorder::WorkItemState::Pending || item.dependencies.is_empty() {
                continue;
            }
            let ready = item.dependencies.iter().all(|dependency| {
                plan.work_items.iter().any(|candidate| {
                    candidate.id == *dependency
                        && candidate.state == workorder::WorkItemState::Verified
                })
            });
            if ready {
                observations.push(workorder_observation(
                    AttentionKind::NextItemReady,
                    &workorder_id,
                    &format!("next:{}", item.id.as_str()),
                    "次の作業を始められる状態になりました",
                    "開始には人の判断が必要です",
                    PrimaryAction::RetryWorkItem {
                        workorder_id: workorder_id.clone(),
                        work_item_id: item.id.as_str().to_owned(),
                    },
                ));
            }
        }
        for item in &plan.work_items {
            let Some(assignee) = &item.assignee else {
                continue;
            };
            let Some(changes) = file_changes.get(assignee.as_str()) else {
                continue;
            };
            for (event_id, changed_path) in changes {
                let allowed = item.write_scope.iter().any(|scope| {
                    changed_path
                        .replace('\\', "/")
                        .starts_with(&scope.path_prefix.replace('\\', "/"))
                });
                if !allowed {
                    observations.push(workorder_observation(
                        AttentionKind::OutOfScopeWrite,
                        &workorder_id,
                        &format!("scope:{}:{event_id}", item.id.as_str()),
                        "決めた作業先の外で変更を検知しました",
                        "範囲を確認するまで変更を進められません",
                        PrimaryAction::ReviewConflict {
                            workorder_id: workorder_id.clone(),
                        },
                    ));
                }
            }
        }
    }
    Ok((observations, active))
}

fn workorder_observation(
    kind: AttentionKind,
    workorder_id: &str,
    suffix: &str,
    why_now: &str,
    impact: &str,
    primary_action: PrimaryAction,
) -> AttentionObservation {
    let key = format!("{}:{workorder_id}:{suffix}", kind.as_str());
    AttentionObservation {
        fingerprint: key.clone(),
        key: key.clone(),
        kind: ObservationKind::Attention(kind),
        workorder_id: Some(workorder_id.to_owned()),
        session: None,
        why_now: why_now.into(),
        impact: impact.into(),
        evidence: vec![EvidenceRef {
            source: "workorder".into(),
            kind: "state".into(),
            ref_id: key.clone(),
            detail: why_now.into(),
        }],
        primary_action: Some(primary_action),
        reply_route: ReplyRoute::WorkOrder {
            workorder_id: workorder_id.to_owned(),
        },
        resolution_predicate: ResolutionPredicate::WorkOrderInactive {
            workorder_id: workorder_id.to_owned(),
        },
    }
}

fn to_json<T: serde::Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| error.to_string())
}
fn from_json<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, String> {
    serde_json::from_str(value).map_err(|error| error.to_string())
}

fn card_state_from_db(value: &str) -> Result<CardState, String> {
    match value {
        "open" => Ok(CardState::Open),
        "resolved" => Ok(CardState::Resolved),
        "superseded" => Ok(CardState::Superseded),
        "bundled" => Ok(CardState::Bundled),
        _ => Err(format!("invalid attention card state: {value}")),
    }
}
