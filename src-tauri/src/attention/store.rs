use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, Connection, OptionalExtension};

use crate::workorder;

use super::model::{
    card_id, AttentionCard, AttentionKind, CardState, EvidenceRef, PrimaryAction, ReplyRoute,
    ResolutionPredicate, SessionRef, Severity, Waiting,
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
        "SELECT id, fingerprint, kind, waiting, severity, actor, freshness, source_rank, workorder_id, session_json, \
         why_now, impact, primary_action_json, reply_route_json, resolution_predicate_json, state, first_seen_at, \
         last_seen_at, revision, resolved_at \
         FROM attention_cards WHERE state=?1 ORDER BY last_seen_at DESC, id ASC",
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([state.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<u32>>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, String>(11)?,
                row.get::<_, String>(12)?,
                row.get::<_, String>(13)?,
                row.get::<_, String>(14)?,
                row.get::<_, String>(15)?,
                row.get::<_, i64>(16)?,
                row.get::<_, i64>(17)?,
                row.get::<_, u32>(18)?,
                row.get::<_, Option<i64>>(19)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut cards = Vec::new();
    for row in rows {
        let (
            id,
            fingerprint,
            kind,
            waiting,
            severity,
            actor,
            freshness,
            source_rank,
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
            waiting: from_json(&waiting)?,
            severity: from_json(&severity)?,
            actor: actor.as_deref().map(from_json).transpose()?,
            freshness: freshness.as_deref().map(from_json).transpose()?,
            source_rank,
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
    attention_cards_enabled: bool,
) -> Result<EvaluationResult, String> {
    #[cfg(test)]
    init_for_test(conn)?;
    if !attention_cards_enabled {
        return Ok(EvaluationResult {
            changed: false,
            cards: list_open_cards(conn)?,
        });
    }
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
    #[cfg(test)]
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
            "UPDATE attention_cards SET kind=?2, waiting=?3, severity=?4, actor=?5, freshness=?6, \
             source_rank=?7, workorder_id=?8, session_json=?9, why_now=?10, impact=?11, \
             primary_action_json=?12, reply_route_json=?13, resolution_predicate_json=?14, \
             last_seen_at=?15, revision=?16, state='open', \
             resolved_at=NULL WHERE id=?1",
            params![
                id,
                to_json(&card.kind)?,
                to_json(&card.waiting)?,
                to_json(&card.severity)?,
                card.actor.as_ref().map(to_json).transpose()?,
                card.freshness.as_ref().map(to_json).transpose()?,
                card.source_rank,
                card.workorder_id,
                card.session.as_ref().map(to_json).transpose()?,
                card.why_now,
                card.impact,
                to_json(&card.primary_action)?,
                to_json(&card.reply_route)?,
                to_json(&card.resolution_predicate)?,
                card.last_seen_at,
                revision.saturating_add(1),
            ],
        )
        .map_err(|error| error.to_string())?;
        replace_evidence(conn, &id, &card.evidence)?;
        return Ok(true);
    }
    conn.execute(
        "INSERT INTO attention_cards(id, fingerprint, kind, waiting, severity, actor, freshness, source_rank, \
         workorder_id, session_json, why_now, impact, primary_action_json, reply_route_json, \
         resolution_predicate_json, state, first_seen_at, last_seen_at, revision, resolved_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
        params![
            card.id, card.fingerprint, to_json(&card.kind)?, to_json(&card.waiting)?,
            to_json(&card.severity)?, card.actor.as_ref().map(to_json).transpose()?,
            card.freshness.as_ref().map(to_json).transpose()?, card.source_rank, card.workorder_id,
            card.session.as_ref().map(to_json).transpose()?, card.why_now, card.impact,
            to_json(&card.primary_action)?, to_json(&card.reply_route)?,
            to_json(&card.resolution_predicate)?, card.state.as_str(), card.first_seen_at,
            card.last_seen_at, card.revision, card.resolved_at,
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
            waiting: Waiting::Work,
            severity: Severity::Warning,
            actor: None,
            freshness: None,
            source_rank: None,
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
    workorder_observations_with_connection(&conn, file_changes)
}

pub(crate) fn workorder_observations_with_connection(
    conn: &Connection,
    file_changes: &BTreeMap<String, Vec<(String, String)>>,
) -> Result<(Vec<AttentionObservation>, BTreeSet<String>), String> {
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
        let contract_session = plan.bindings.first().map(|binding| SessionRef::Logical {
            logical_session_id: binding.logical_session_id.as_str().to_owned(),
        });
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
                contract_session.clone(),
                &plan.goal,
                vec![workorder_evidence("state", "必要な報告がそろいました")],
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
                let missing_gates = plan
                    .work_items
                    .iter()
                    .find(|candidate| candidate.id == item.work_item_id)
                    .map(|candidate| {
                        candidate
                            .gates
                            .iter()
                            .zip(&item.gates)
                            .filter(|(_, gate)| gate.status != workorder::GateStatus::Pass)
                            .map(|(gate, _)| gate.description.clone())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
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
                    contract_session.clone(),
                    &plan.goal,
                    vec![workorder_evidence(
                        "missingGates",
                        if missing_gates.is_empty() {
                            "未通過ゲート: 取得できず".to_owned()
                        } else {
                            format!("未通過ゲート: {}", missing_gates.join(" / "))
                        },
                    )],
                ));
            }
        }
        let spawn_count: u32 = conn.query_row("SELECT COUNT(*) FROM dispatch_outbox WHERE work_order_id=?1 AND plan_version=?2 AND intent_kind='spawn' AND status='delivered'", params![workorder_id, version], |row| row.get(0)).map_err(|error| error.to_string())?;
        let replan_count = version.saturating_sub(1);
        if spawn_count >= plan.budgets.max_new_pty || replan_count >= plan.budgets.max_replans {
            let mut reached = Vec::new();
            if spawn_count >= plan.budgets.max_new_pty {
                reached.push(format!(
                    "新規セッション: {spawn_count}/{}",
                    plan.budgets.max_new_pty
                ));
            }
            if replan_count >= plan.budgets.max_replans {
                reached.push(format!(
                    "再計画: {replan_count}/{}",
                    plan.budgets.max_replans
                ));
            }
            observations.push(workorder_observation(
                AttentionKind::BudgetReached,
                &workorder_id,
                "budget",
                "使える枠に達しました",
                "追加の開始や再計画には判断が必要です",
                PrimaryAction::RaiseBudget {
                    workorder_id: workorder_id.clone(),
                },
                contract_session.clone(),
                &plan.goal,
                vec![workorder_evidence(
                    "budget",
                    format!("上限到達: {}", reached.join(" / ")),
                )],
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
                    contract_session.clone(),
                    &plan.goal,
                    vec![workorder_evidence(
                        "conflict",
                        "作業どうしの食い違いを検知しました",
                    )],
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
                contract_session.clone(),
                &plan.goal,
                vec![workorder_evidence(
                    "passedGates",
                    format!(
                        "通過ゲート: {}",
                        plan.work_items
                            .iter()
                            .filter(|item| item.required)
                            .flat_map(|item| item
                                .gates
                                .iter()
                                .map(|gate| gate.description.as_str()))
                            .collect::<Vec<_>>()
                            .join(" / ")
                    ),
                )],
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
                    item.assignee
                        .as_ref()
                        .map(|assignee| SessionRef::Logical {
                            logical_session_id: assignee.as_str().to_owned(),
                        })
                        .or_else(|| contract_session.clone()),
                    &plan.goal,
                    vec![
                        workorder_evidence(
                            "workItemObjective",
                            format!("作業: {}", item.objective),
                        ),
                        workorder_evidence("contractGoal", format!("契約ゴール: {}", plan.goal)),
                    ],
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
                        item.assignee
                            .as_ref()
                            .map(|assignee| SessionRef::Logical {
                                logical_session_id: assignee.as_str().to_owned(),
                            })
                            .or_else(|| contract_session.clone()),
                        &plan.goal,
                        vec![
                            workorder_evidence("outOfScopePath", format!("変更先: {changed_path}")),
                            workorder_evidence(
                                "declaredScope",
                                format!(
                                    "宣言範囲: {}",
                                    item.write_scope
                                        .iter()
                                        .map(|scope| scope.path_prefix.as_str())
                                        .collect::<Vec<_>>()
                                        .join(" / ")
                                ),
                            ),
                        ],
                    ));
                }
            }
        }
    }
    Ok((observations, active))
}

pub(crate) fn workorder_observation(
    kind: AttentionKind,
    workorder_id: &str,
    suffix: &str,
    why_now: &str,
    impact: &str,
    primary_action: PrimaryAction,
    session: Option<SessionRef>,
    goal: &str,
    mut evidence: Vec<EvidenceRef>,
) -> AttentionObservation {
    let key = format!("{}:{workorder_id}:{suffix}", kind.as_str());
    if !evidence.iter().any(|item| item.kind == "contractGoal") {
        evidence.push(workorder_evidence(
            "contractGoal",
            format!("契約ゴール: {goal}"),
        ));
    }
    AttentionObservation {
        fingerprint: key.clone(),
        key: key.clone(),
        kind: ObservationKind::Attention(kind),
        workorder_id: Some(workorder_id.to_owned()),
        session,
        why_now: why_now.into(),
        impact: impact.into(),
        evidence,
        primary_action: Some(primary_action),
        reply_route: ReplyRoute::WorkOrder {
            workorder_id: workorder_id.to_owned(),
        },
        resolution_predicate: ResolutionPredicate::WorkOrderInactive {
            workorder_id: workorder_id.to_owned(),
        },
    }
}

fn workorder_evidence(kind: &str, detail: impl Into<String>) -> EvidenceRef {
    EvidenceRef {
        source: "workorder".into(),
        kind: kind.into(),
        ref_id: kind.into(),
        detail: compact_detail(detail.into()),
    }
}

fn compact_detail(detail: String) -> String {
    let mut value = detail
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .join("\n");
    if value.chars().count() > 200 {
        value = format!("{}…", value.chars().take(199).collect::<String>());
    }
    value
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
