//! Contract-bounded DAG advancement for sealed WorkOrders.
//!
//! The decision half is pure. The executor half persists a normal state-machine
//! transition and an idempotent spawn intent for each selected item, then hands
//! the resulting requests to the Tauri command layer for emission.

use std::collections::BTreeMap;
use std::path::Path;

use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::executor::{mark_spawn_in_flight, spawn_request_template, write_item_handoff};
use super::store::{insert_spawn_outbox, record_audit, transition_work_item_state};
use super::{
    load_plan, render_work_item_prompt, scopes_overlap, ExecutorError, PlanSnapshot, SpawnRequest,
    WorkItem, WorkItemId, WorkItemState, WorkOrderId,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvanceInput {
    pub plan: PlanSnapshot,
    pub spawn_in_use: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvanceDecision {
    pub dispatch: Vec<WorkItemId>,
    pub blocked: Vec<BlockedItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedItem {
    pub work_item_id: WorkItemId,
    pub reason: BlockedReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockedReason {
    DependencyUnverified { missing: Vec<WorkItemId> },
    WriteConflict { with: Vec<WorkItemId> },
    SessionBudgetExhausted { limit: u32, in_use: u32 },
    NoDependencies,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AdvanceOutcome {
    pub dispatched: Vec<WorkItemId>,
    pub blocked: Vec<BlockedItem>,
    pub spawn_requests: Vec<SpawnRequest>,
}

/// Decide the next contract-approved work without reading clocks, the database,
/// or the filesystem. `plan.work_items` order is the sealed plan order.
pub fn decide_advance(input: &AdvanceInput) -> AdvanceDecision {
    let states = input
        .plan
        .work_items
        .iter()
        .map(|item| (item.id.clone(), item.state))
        .collect::<BTreeMap<_, _>>();
    let active = input
        .plan
        .work_items
        .iter()
        .filter(|item| {
            matches!(
                item.state,
                WorkItemState::Ready
                    | WorkItemState::Dispatched
                    | WorkItemState::Running
                    | WorkItemState::Reported
            )
        })
        .collect::<Vec<_>>();
    let mut dispatch = Vec::new();
    let mut selected = Vec::<&WorkItem>::new();
    let mut blocked = Vec::new();

    for item in &input.plan.work_items {
        if item.state != WorkItemState::Pending {
            continue;
        }
        if item.dependencies.is_empty() {
            blocked.push(BlockedItem {
                work_item_id: item.id.clone(),
                reason: BlockedReason::NoDependencies,
            });
            continue;
        }
        let missing = item
            .dependencies
            .iter()
            .filter(|dependency| states.get(*dependency) != Some(&WorkItemState::Verified))
            .cloned()
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            blocked.push(BlockedItem {
                work_item_id: item.id.clone(),
                reason: BlockedReason::DependencyUnverified { missing },
            });
            continue;
        }
        let with_active = active
            .iter()
            .filter(|other| scopes_conflict(item, other))
            .map(|other| other.id.clone())
            .collect::<Vec<_>>();
        if !with_active.is_empty() {
            blocked.push(BlockedItem {
                work_item_id: item.id.clone(),
                reason: BlockedReason::WriteConflict { with: with_active },
            });
            continue;
        }
        let with_selected = selected
            .iter()
            .filter(|other| scopes_conflict(item, other))
            .map(|other| other.id.clone())
            .collect::<Vec<_>>();
        if !with_selected.is_empty() {
            blocked.push(BlockedItem {
                work_item_id: item.id.clone(),
                reason: BlockedReason::WriteConflict {
                    with: with_selected,
                },
            });
            continue;
        }
        let in_use = input
            .spawn_in_use
            .saturating_add(u32::try_from(dispatch.len()).unwrap_or(u32::MAX));
        if in_use >= input.plan.budgets.max_new_pty {
            blocked.push(BlockedItem {
                work_item_id: item.id.clone(),
                reason: BlockedReason::SessionBudgetExhausted {
                    limit: input.plan.budgets.max_new_pty,
                    in_use,
                },
            });
            continue;
        }
        dispatch.push(item.id.clone());
        selected.push(item);
    }

    AdvanceDecision { dispatch, blocked }
}

/// Persist the next dispatches for the sealed current plan. It never emits a
/// frontend event itself; callers emit `spawn_requests` after this returns.
pub fn advance(
    conn: &mut Connection,
    work_order_id: &WorkOrderId,
    handoff_dir: &Path,
    now_ms: i64,
) -> Result<AdvanceOutcome, ExecutorError> {
    let plan_version = current_plan_version(conn, work_order_id)?;
    let order_state: String = conn.query_row(
        "SELECT state FROM work_orders WHERE id=?1",
        [work_order_id.as_str()],
        |row| row.get(0),
    )?;
    let snapshot = load_plan(conn, work_order_id, plan_version)?;
    if snapshot.sealed_at.is_none()
        || matches!(order_state.as_str(), "cancelled" | "done" | "failed")
    {
        return Ok(AdvanceOutcome::default());
    }
    let decision = decide_advance(&AdvanceInput {
        plan: snapshot.clone(),
        spawn_in_use: spawn_in_use(conn, work_order_id, plan_version)?,
    });
    if decision.dispatch.is_empty() {
        return Ok(AdvanceOutcome {
            dispatched: Vec::new(),
            blocked: decision.blocked,
            spawn_requests: Vec::new(),
        });
    }
    let template = spawn_request_template(conn, work_order_id, plan_version)?;
    let mut outcome = AdvanceOutcome {
        dispatched: Vec::new(),
        blocked: decision.blocked,
        spawn_requests: Vec::new(),
    };

    for work_item_id in decision.dispatch {
        let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let live_plan = load_plan(&transaction, work_order_id, plan_version)?;
        if live_plan.sealed_at.is_none() {
            transaction.commit()?;
            continue;
        }
        let live_decision = decide_advance(&AdvanceInput {
            plan: live_plan.clone(),
            spawn_in_use: spawn_in_use(&transaction, work_order_id, plan_version)?,
        });
        if !live_decision.dispatch.contains(&work_item_id) {
            transaction.commit()?;
            continue;
        }
        let item = live_plan
            .work_items
            .iter()
            .find(|item| item.id == work_item_id)
            .cloned()
            .ok_or_else(|| ExecutorError::InvalidPlan("selected work item is missing".into()))?;

        transition_work_item_state(
            &transaction,
            work_order_id,
            plan_version,
            &item.id,
            WorkItemState::Ready,
            now_ms,
        )?;
        transition_work_item_state(
            &transaction,
            work_order_id,
            plan_version,
            &item.id,
            WorkItemState::Dispatched,
            now_ms,
        )?;
        if insert_spawn_outbox(&transaction, work_order_id, plan_version, &item, now_ms)? == 0 {
            transaction.rollback()?;
            continue;
        }

        let prompt =
            render_work_item_prompt(&live_plan.goal, &live_plan.acceptance_criteria, &item);
        let handoff_path =
            write_item_handoff(handoff_dir, work_order_id, plan_version, &item.id, &prompt)?;
        let request = item_spawn_request(
            &template,
            work_order_id,
            plan_version,
            &item,
            handoff_path.to_string_lossy().into_owned(),
            &live_plan.goal,
        );
        mark_spawn_in_flight(
            &transaction,
            work_order_id,
            plan_version,
            &item.id,
            &request,
            now_ms,
        )?;
        record_audit(
            &transaction,
            work_order_id,
            plan_version,
            now_ms,
            "engine",
            "advance_spawn",
            serde_json::json!({
                "verified_dependencies": item.dependencies,
                "work_item_id": item.id,
                "idempotency_key": request.request_id,
            }),
        )?;
        transaction.commit()?;
        outcome.dispatched.push(item.id);
        outcome.spawn_requests.push(request);
    }
    Ok(outcome)
}

fn current_plan_version(
    conn: &Connection,
    work_order_id: &WorkOrderId,
) -> Result<u32, ExecutorError> {
    let plan_version: i64 = conn.query_row(
        "SELECT plan_version FROM work_orders WHERE id=?1",
        [work_order_id.as_str()],
        |row| row.get(0),
    )?;
    u32::try_from(plan_version)
        .map_err(|_| ExecutorError::InvalidPlan("plan version is outside u32".into()))
}

fn spawn_in_use(
    conn: &Connection,
    work_order_id: &WorkOrderId,
    plan_version: u32,
) -> Result<u32, ExecutorError> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM dispatch_outbox \
         WHERE work_order_id=?1 AND plan_version=?2 AND intent_kind='spawn' \
           AND status IN ('pending', 'in_flight', 'delivered')",
        params![work_order_id.as_str(), i64::from(plan_version)],
        |row| row.get(0),
    )?;
    u32::try_from(count)
        .map_err(|_| ExecutorError::InvalidPlan("spawn intent count exceeds u32".into()))
}

fn item_spawn_request(
    template: &SpawnRequest,
    work_order_id: &WorkOrderId,
    plan_version: u32,
    item: &WorkItem,
    handoff_path: String,
    goal: &str,
) -> SpawnRequest {
    let mut launch_env = template.launch_env.clone();
    launch_env.insert("MYCMUX_HANDOFF_PROMPT_FILE".to_owned(), handoff_path);
    SpawnRequest {
        request_id: super::deterministic_request_id(work_order_id, plan_version, &item.id),
        work_order_id: work_order_id.as_str().to_owned(),
        plan_version,
        work_item_id: item.id.as_str().to_owned(),
        cwd: template.cwd.clone(),
        agent_kind: template.agent_kind.clone(),
        launch_env,
        label: format!("WorkOrder: {goal} — {}", item.objective),
    }
}

fn scopes_conflict(left: &WorkItem, right: &WorkItem) -> bool {
    left.write_scope.iter().any(|left_scope| {
        right
            .write_scope
            .iter()
            .any(|right_scope| scopes_overlap(&left_scope.path_prefix, &right_scope.path_prefix))
    })
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};

    use rusqlite::{params, Connection};
    use tempfile::tempdir;

    use super::*;
    use crate::workorder::{
        create_draft, record_gate_result, record_report, schema, seal_plan, Criterion, Gate,
        GateId, GateStatus, LogicalSessionId, PathScope, PlanDraft, ReportEnvelope,
        ReportEnvelopeId, ReportOutcome, SessionBinding, SessionRole, SpawnResult, WorkItem,
        WorkOrderId,
    };

    fn order_id() -> WorkOrderId {
        WorkOrderId::try_new("advance-order").unwrap()
    }

    fn item_id(value: &str) -> WorkItemId {
        WorkItemId::try_new(value).unwrap()
    }

    fn session_id(value: &str) -> LogicalSessionId {
        LogicalSessionId::try_new(value).unwrap()
    }

    fn gate_id(value: &str) -> GateId {
        GateId::try_new(value).unwrap()
    }

    fn work_item(
        id: &str,
        assignee: Option<LogicalSessionId>,
        dependencies: Vec<WorkItemId>,
        scope: &str,
    ) -> WorkItem {
        WorkItem {
            id: item_id(id),
            objective: format!("complete {id}"),
            assignee,
            dependencies,
            expected_artifacts: Vec::new(),
            write_scope: vec![PathScope {
                path_prefix: scope.into(),
                worktree: None,
                branch: None,
            }],
            gates: vec![Gate {
                id: gate_id(&format!("{id}-gate")),
                description: format!("verify {id}"),
            }],
            required: true,
            state: WorkItemState::Pending,
        }
    }

    fn plan(max_new_pty: u32, include_c: bool, b_scope: &str, c_scope: &str) -> PlanDraft {
        let mut work_items = vec![
            work_item("a", None, Vec::new(), "src/a"),
            work_item(
                "b",
                Some(session_id("worker-1")),
                vec![item_id("a")],
                b_scope,
            ),
        ];
        if include_c {
            work_items.push(work_item(
                "c",
                Some(session_id("worker-1")),
                Vec::new(),
                c_scope,
            ));
        }
        PlanDraft {
            goal: "finish the DAG".into(),
            acceptance_criteria: vec![Criterion {
                id: "done".into(),
                description: "all required items verified".into(),
            }],
            bindings: vec![
                SessionBinding {
                    logical_session_id: session_id("integrator"),
                    roles: BTreeSet::from([SessionRole::Integrator]),
                    label_snapshot: None,
                    snapshot_event_id: None,
                },
                SessionBinding {
                    logical_session_id: session_id("worker-1"),
                    roles: BTreeSet::from([SessionRole::Worker]),
                    label_snapshot: None,
                    snapshot_event_id: None,
                },
            ],
            work_items,
            budgets: super::super::CoordinationBudget {
                max_new_pty,
                max_work_items: 8,
                max_replans: 2,
                max_packets: 12,
                max_roundtrips_per_edge: 1,
            },
        }
    }

    fn memory_connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema::init(&conn).unwrap();
        conn
    }

    fn seed_initial_spawn_request(conn: &Connection, id: &WorkOrderId) {
        let request = SpawnRequest {
            request_id: super::super::deterministic_request_id(id, 1, &item_id("a")),
            work_order_id: id.as_str().to_owned(),
            plan_version: 1,
            work_item_id: "a".into(),
            cwd: "C:\\sealed-worktree".into(),
            agent_kind: "codex".into(),
            launch_env: BTreeMap::from([("MYCMUX_AGENT_KIND".into(), "codex".into())]),
            label: "WorkOrder: finish the DAG".into(),
        };
        conn.execute(
            "UPDATE dispatch_outbox SET payload_json=?3, status='in_flight' \
             WHERE work_order_id=?1 AND plan_version=1 AND work_item_id=?2 AND intent_kind='spawn'",
            params![id.as_str(), "a", serde_json::to_string(&request).unwrap()],
        )
        .unwrap();
    }

    fn seal(conn: &mut Connection, plan: &PlanDraft) -> WorkOrderId {
        let id = order_id();
        create_draft(conn, &id, plan, 1).unwrap();
        seal_plan(conn, &id, Default::default(), 2).unwrap();
        seed_initial_spawn_request(conn, &id);
        id
    }

    fn complete_a(conn: &mut Connection, id: &WorkOrderId) {
        super::super::record_spawn_result(
            conn,
            &super::super::deterministic_request_id(id, 1, &item_id("a")),
            SpawnResult {
                session_id: Some("session-a".into()),
                error: None,
            },
            3,
        )
        .unwrap();
        record_report(
            conn,
            &ReportEnvelope {
                id: ReportEnvelopeId::try_new("report-a").unwrap(),
                work_order_id: id.clone(),
                plan_version: 1,
                work_item_id: item_id("a"),
                logical_session_id: session_id("session-a"),
                terminal: true,
                outcome: ReportOutcome::Succeeded,
                verified_facts: vec![serde_json::json!({"artifact": "a"})],
                unverified_claims: Vec::new(),
                open_questions: Vec::new(),
                evidence_event_ids: Vec::new(),
                received_at: 4,
            },
        )
        .unwrap();
        record_gate_result(
            conn,
            id,
            1,
            &item_id("a"),
            &gate_id("a-gate"),
            GateStatus::Pass,
            &serde_json::json!({"gate": "pass"}),
            5,
        )
        .unwrap();
    }

    fn item_state(conn: &Connection, id: &WorkOrderId, item: &str) -> String {
        conn.query_row(
            "SELECT state FROM work_items WHERE work_order_id=?1 AND plan_version=1 AND id=?2",
            params![id.as_str(), item],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn spawn_outbox_count(conn: &Connection, id: &WorkOrderId, item: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM dispatch_outbox \
             WHERE work_order_id=?1 AND plan_version=1 AND work_item_id=?2 AND intent_kind='spawn'",
            params![id.as_str(), item],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn verified_dependency_dispatches_once_and_moves_to_dispatched() {
        let mut conn = memory_connection();
        let id = seal(&mut conn, &plan(4, false, "src/b", "src/c"));
        complete_a(&mut conn, &id);

        let temp = tempdir().unwrap();
        let outcome = advance(&mut conn, &id, temp.path(), 6).unwrap();

        assert_eq!(outcome.dispatched, vec![item_id("b")]);
        assert_eq!(outcome.spawn_requests.len(), 1);
        assert_eq!(spawn_outbox_count(&conn, &id, "b"), 1);
        assert_eq!(item_state(&conn, &id, "b"), "dispatched");
    }

    #[test]
    fn advance_is_idempotent_after_a_new_connection() {
        let temp = tempdir().unwrap();
        let database = temp.path().join("advance.db");
        let mut conn = Connection::open(&database).unwrap();
        schema::init(&conn).unwrap();
        let id = seal(&mut conn, &plan(4, false, "src/b", "src/c"));
        complete_a(&mut conn, &id);

        assert_eq!(
            advance(&mut conn, &id, temp.path(), 6)
                .unwrap()
                .spawn_requests
                .len(),
            1
        );
        assert!(advance(&mut conn, &id, temp.path(), 7)
            .unwrap()
            .spawn_requests
            .is_empty());
        drop(conn);

        let mut reopened = Connection::open(&database).unwrap();
        schema::init(&reopened).unwrap();
        assert!(advance(&mut reopened, &id, temp.path(), 8)
            .unwrap()
            .spawn_requests
            .is_empty());
        assert_eq!(spawn_outbox_count(&reopened, &id, "b"), 1);
    }

    #[test]
    fn write_conflict_blocks_until_active_item_is_verified() {
        let mut conn = memory_connection();
        let id = seal(&mut conn, &plan(4, true, "src/shared", "src/shared"));
        complete_a(&mut conn, &id);
        transition_work_item_state(&conn, &id, 1, &item_id("c"), WorkItemState::Dispatched, 6)
            .unwrap();
        transition_work_item_state(&conn, &id, 1, &item_id("c"), WorkItemState::Running, 7)
            .unwrap();

        let temp = tempdir().unwrap();
        let blocked = advance(&mut conn, &id, temp.path(), 8).unwrap();
        assert!(matches!(
            blocked.blocked.as_slice(),
            [BlockedItem { work_item_id, reason: BlockedReason::WriteConflict { with } }]
                if work_item_id == &item_id("b") && with == &vec![item_id("c")]
        ));

        transition_work_item_state(&conn, &id, 1, &item_id("c"), WorkItemState::Reported, 9)
            .unwrap();
        transition_work_item_state(&conn, &id, 1, &item_id("c"), WorkItemState::Verified, 10)
            .unwrap();
        assert_eq!(
            advance(&mut conn, &id, temp.path(), 11).unwrap().dispatched,
            vec![item_id("b")]
        );
    }

    #[test]
    fn exhausted_spawn_budget_blocks_dispatch() {
        let mut conn = memory_connection();
        let id = seal(&mut conn, &plan(1, false, "src/b", "src/c"));
        complete_a(&mut conn, &id);

        let outcome = advance(&mut conn, &id, tempdir().unwrap().path(), 6).unwrap();
        assert!(matches!(
            outcome.blocked.as_slice(),
            [BlockedItem { work_item_id, reason: BlockedReason::SessionBudgetExhausted { limit: 1, in_use: 1 } }]
                if work_item_id == &item_id("b")
        ));
        assert_eq!(spawn_outbox_count(&conn, &id, "b"), 0);
    }

    #[test]
    fn pure_decision_is_deterministic_and_has_no_clock_input() {
        let mut conn = memory_connection();
        let id = seal(&mut conn, &plan(4, false, "src/b", "src/c"));
        complete_a(&mut conn, &id);
        let input = AdvanceInput {
            plan: load_plan(&conn, &id, 1).unwrap(),
            spawn_in_use: 1,
        };

        assert_eq!(decide_advance(&input), decide_advance(&input));
    }

    #[test]
    fn unsealed_and_cancelled_orders_are_no_ops() {
        let mut conn = memory_connection();
        let id = order_id();
        let plan = plan(4, false, "src/b", "src/c");
        create_draft(&conn, &id, &plan, 1).unwrap();
        let temp = tempdir().unwrap();
        assert_eq!(
            advance(&mut conn, &id, temp.path(), 2).unwrap(),
            AdvanceOutcome::default()
        );

        seal_plan(&mut conn, &id, Default::default(), 3).unwrap();
        conn.execute(
            "UPDATE work_orders SET state='cancelled' WHERE id=?1",
            [id.as_str()],
        )
        .unwrap();
        let before: i64 = conn
            .query_row("SELECT COUNT(*) FROM workorder_audit", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            advance(&mut conn, &id, temp.path(), 4).unwrap(),
            AdvanceOutcome::default()
        );
        let after: i64 = conn
            .query_row("SELECT COUNT(*) FROM workorder_audit", [], |row| row.get(0))
            .unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn report_gate_verified_transition_advances_the_next_item() {
        let mut conn = memory_connection();
        let id = seal(&mut conn, &plan(4, false, "src/b", "src/c"));
        complete_a(&mut conn, &id);
        assert_eq!(item_state(&conn, &id, "a"), "verified");

        let outcome = advance(&mut conn, &id, tempdir().unwrap().path(), 6).unwrap();
        assert_eq!(outcome.dispatched, vec![item_id("b")]);
        assert_eq!(
            outcome.spawn_requests[0].label,
            "WorkOrder: finish the DAG — complete b"
        );
    }

    #[test]
    fn cancelled_and_dependency_free_pending_items_are_never_candidates() {
        let mut conn = memory_connection();
        let id = seal(&mut conn, &plan(4, false, "src/b", "src/c"));
        let mut snapshot = load_plan(&conn, &id, 1).unwrap();
        snapshot.work_items[0].state = WorkItemState::Pending;
        snapshot.work_items[1].state = WorkItemState::Cancelled;
        let decision = decide_advance(&AdvanceInput {
            plan: snapshot,
            spawn_in_use: 0,
        });

        assert!(decision.dispatch.is_empty());
        assert!(matches!(
            decision.blocked.as_slice(),
            [BlockedItem { work_item_id, reason: BlockedReason::NoDependencies }]
                if work_item_id == &item_id("a")
        ));
    }
}
