use std::collections::BTreeSet;
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::Connection;

use super::*;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn work_order_id(value: &str) -> WorkOrderId {
    WorkOrderId::try_new(value).unwrap()
}

fn work_item_id(value: &str) -> WorkItemId {
    WorkItemId::try_new(value).unwrap()
}

fn session_id(value: &str) -> LogicalSessionId {
    LogicalSessionId::try_new(value).unwrap()
}

fn gate_id(value: &str) -> GateId {
    GateId::try_new(value).unwrap()
}

fn report_id(value: &str) -> ReportEnvelopeId {
    ReportEnvelopeId::try_new(value).unwrap()
}

fn roles(values: &[SessionRole]) -> BTreeSet<SessionRole> {
    values.iter().copied().collect()
}

fn sample_plan() -> PlanDraft {
    PlanDraft {
        goal: "implement WorkOrder domain".into(),
        acceptance_criteria: vec![Criterion {
            id: "accepted".into(),
            description: "all required gates pass".into(),
        }],
        bindings: vec![
            SessionBinding {
                logical_session_id: session_id("source-1"),
                roles: roles(&[SessionRole::Source]),
                label_snapshot: Some("source one".into()),
                snapshot_event_id: None,
            },
            SessionBinding {
                logical_session_id: session_id("source-2"),
                roles: roles(&[SessionRole::Source]),
                label_snapshot: Some("source two".into()),
                snapshot_event_id: None,
            },
            SessionBinding {
                logical_session_id: session_id("source-3"),
                roles: roles(&[SessionRole::Source]),
                label_snapshot: Some("source three".into()),
                snapshot_event_id: None,
            },
            SessionBinding {
                logical_session_id: session_id("worker"),
                roles: roles(&[SessionRole::Worker]),
                label_snapshot: None,
                snapshot_event_id: None,
            },
            SessionBinding {
                logical_session_id: session_id("integrator"),
                roles: roles(&[SessionRole::Integrator]),
                label_snapshot: None,
                snapshot_event_id: None,
            },
        ],
        work_items: vec![WorkItem {
            id: work_item_id("item-1"),
            objective: "implement the work item".into(),
            assignee: Some(session_id("worker")),
            dependencies: Vec::new(),
            expected_artifacts: vec![ArtifactSpec {
                path: "src-tauri/src/workorder/model.rs".into(),
                description: "typed model".into(),
            }],
            write_scope: vec![PathScope {
                path_prefix: "src-tauri/src/workorder".into(),
                worktree: Some("master".into()),
                branch: Some("master".into()),
            }],
            gates: vec![Gate {
                id: gate_id("gate-1"),
                description: "unit tests pass".into(),
            }],
            required: true,
            state: WorkItemState::Pending,
        }],
        budgets: CoordinationBudget::default(),
    }
}

fn three_item_plan() -> PlanDraft {
    let mut plan = sample_plan();
    let mut second = plan.work_items[0].clone();
    second.id = work_item_id("item-2");
    second.objective = "second independent work item".into();
    second.expected_artifacts[0].path = "src-tauri/src/workorder/schema.rs".into();

    let mut third = plan.work_items[0].clone();
    third.id = work_item_id("item-3");
    third.objective = "third dependent work item".into();
    third.dependencies = vec![work_item_id("item-2")];
    third.expected_artifacts[0].path = "src-tauri/src/workorder/store.rs".into();

    plan.work_items.extend([second, third]);
    plan
}

fn memory_connection() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    super::schema::init(&conn).unwrap();
    conn
}

fn record_all_sources(conn: &Connection, id: &WorkOrderId, plan: &PlanDraft) {
    for binding in plan
        .bindings
        .iter()
        .filter(|binding| binding.roles.contains(&SessionRole::Source))
    {
        record_source_snapshot(
            conn,
            id,
            1,
            &binding.logical_session_id,
            SourceSnapshotStatus::Acquired,
            None,
            None,
            101,
        )
        .unwrap();
    }
}

fn sealed_connection() -> (Connection, WorkOrderId, PlanDraft) {
    let mut conn = memory_connection();
    let order_id = work_order_id("order-1");
    let plan = sample_plan();
    create_draft(&conn, &order_id, &plan, 100).unwrap();
    record_all_sources(&conn, &order_id, &plan);
    assert_eq!(
        seal_plan(&mut conn, &order_id, SealOptions::default(), 102).unwrap(),
        SealOutcome::Sealed { outbox_created: 1 }
    );
    (conn, order_id, plan)
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).unwrap()
}

type OutboxRow = (
    String,
    i64,
    String,
    String,
    String,
    String,
    i64,
    Option<String>,
    i64,
    i64,
);

fn outbox_rows(conn: &Connection) -> Vec<OutboxRow> {
    let mut statement = conn
        .prepare(
            "SELECT work_order_id, plan_version, work_item_id, intent_kind, payload_json, \
                    status, attempts, last_error, created_at, updated_at \
             FROM dispatch_outbox ORDER BY work_item_id, intent_kind",
        )
        .unwrap();
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
            ))
        })
        .unwrap();
    rows.map(|row| row.unwrap()).collect()
}

fn work_item_state(conn: &Connection, order_id: &WorkOrderId, item_id: &WorkItemId) -> String {
    conn.query_row(
        "SELECT state FROM work_items WHERE work_order_id=?1 AND plan_version=1 AND id=?2",
        [order_id.as_str(), item_id.as_str()],
        |row| row.get(0),
    )
    .unwrap()
}

fn set_work_item_running_for_report_test(conn: &Connection, order_id: &WorkOrderId) {
    // Stage 0 has no public dispatch/transition API. This fixture establishes
    // the valid precondition that a worker report follows a Running item.
    conn.execute(
        "UPDATE work_items SET state='running' WHERE work_order_id=?1 AND plan_version=1 AND id='item-1'",
        [order_id.as_str()],
    )
    .unwrap();
}

fn report_envelope(
    report: &str,
    order_id: &WorkOrderId,
    terminal: bool,
    outcome: ReportOutcome,
) -> ReportEnvelope {
    ReportEnvelope {
        id: report_id(report),
        work_order_id: order_id.clone(),
        plan_version: 1,
        work_item_id: work_item_id("item-1"),
        logical_session_id: session_id("worker"),
        terminal,
        outcome,
        verified_facts: Vec::new(),
        unverified_claims: Vec::new(),
        open_questions: Vec::new(),
        evidence_event_ids: Vec::new(),
        received_at: 103,
    }
}

fn test_directory(name: &str) -> std::path::PathBuf {
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let directory = std::env::temp_dir().join(format!(
        "mycmux-workorder-{name}-{}-{sequence}",
        std::process::id()
    ));
    std::fs::create_dir_all(&directory).unwrap();
    directory
}

#[test]
fn schema_init_is_idempotent() {
    let conn = Connection::open_in_memory().unwrap();
    super::schema::init(&conn).unwrap();
    super::schema::init(&conn).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT value FROM workorder_meta WHERE key='schema_version'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "1"
    );
}

#[test]
fn workorder_transition_table_accepts_only_specified_edges() {
    let work_order_states = [
        WorkOrderState::Draft,
        WorkOrderState::AwaitingGo,
        WorkOrderState::Running,
        WorkOrderState::NeedsDecision,
        WorkOrderState::Integrating,
        WorkOrderState::Verifying,
        WorkOrderState::Done,
        WorkOrderState::Failed,
        WorkOrderState::Cancelled,
    ];
    // This table is intentionally independent from can_transition: it mirrors
    // spec §3.1 so any extra implementation edge fails this test.
    let allowed_work_order_edges = [
        (WorkOrderState::Draft, WorkOrderState::AwaitingGo),
        (WorkOrderState::Draft, WorkOrderState::Cancelled),
        (WorkOrderState::AwaitingGo, WorkOrderState::Draft),
        (WorkOrderState::AwaitingGo, WorkOrderState::Running),
        (WorkOrderState::AwaitingGo, WorkOrderState::Cancelled),
        (WorkOrderState::Running, WorkOrderState::NeedsDecision),
        (WorkOrderState::Running, WorkOrderState::Integrating),
        (WorkOrderState::Running, WorkOrderState::Failed),
        (WorkOrderState::Running, WorkOrderState::Cancelled),
        (WorkOrderState::NeedsDecision, WorkOrderState::Running),
        (WorkOrderState::NeedsDecision, WorkOrderState::Failed),
        (WorkOrderState::NeedsDecision, WorkOrderState::Cancelled),
        (WorkOrderState::Integrating, WorkOrderState::Verifying),
        (WorkOrderState::Integrating, WorkOrderState::NeedsDecision),
        (WorkOrderState::Integrating, WorkOrderState::Failed),
        (WorkOrderState::Integrating, WorkOrderState::Cancelled),
        (WorkOrderState::Verifying, WorkOrderState::Done),
        (WorkOrderState::Verifying, WorkOrderState::NeedsDecision),
        (WorkOrderState::Verifying, WorkOrderState::Failed),
        (WorkOrderState::Verifying, WorkOrderState::Cancelled),
    ];
    for from in work_order_states {
        for to in work_order_states {
            let allowed = allowed_work_order_edges.contains(&(from, to));
            assert_eq!(can_transition(from, to), allowed, "{from:?} -> {to:?}");
            assert_eq!(transition(from, to).is_ok(), allowed, "{from:?} -> {to:?}");
        }
    }

    let work_item_states = [
        WorkItemState::Pending,
        WorkItemState::Ready,
        WorkItemState::Dispatched,
        WorkItemState::Running,
        WorkItemState::Reported,
        WorkItemState::Verified,
        WorkItemState::Failed,
        WorkItemState::Cancelled,
    ];
    let allowed_work_item_edges = [
        (WorkItemState::Pending, WorkItemState::Ready),
        (WorkItemState::Pending, WorkItemState::Cancelled),
        (WorkItemState::Ready, WorkItemState::Dispatched),
        (WorkItemState::Ready, WorkItemState::Cancelled),
        (WorkItemState::Dispatched, WorkItemState::Running),
        (WorkItemState::Dispatched, WorkItemState::Cancelled),
        (WorkItemState::Running, WorkItemState::Reported),
        (WorkItemState::Running, WorkItemState::Cancelled),
        (WorkItemState::Reported, WorkItemState::Verified),
        (WorkItemState::Reported, WorkItemState::Failed),
        (WorkItemState::Reported, WorkItemState::Cancelled),
    ];
    for from in work_item_states {
        for to in work_item_states {
            let allowed = allowed_work_item_edges.contains(&(from, to));
            assert_eq!(
                can_transition_work_item(from, to),
                allowed,
                "{from:?} -> {to:?}"
            );
            assert_eq!(
                transition_work_item(from, to).is_ok(),
                allowed,
                "{from:?} -> {to:?}"
            );
        }
    }
}

#[test]
fn validate_plan_reports_every_required_violation_and_accepts_normal_plan() {
    let normal = sample_plan();
    assert_eq!(validate_plan(&normal), Ok(()));

    let mut no_integrator = normal.clone();
    no_integrator
        .bindings
        .retain(|binding| !binding.roles.contains(&SessionRole::Integrator));
    assert_eq!(
        validate_plan(&no_integrator),
        Err(vec![PlanViolation::IntegratorBindingCount { count: 0 }])
    );

    let mut two_integrators = normal.clone();
    two_integrators.bindings.push(SessionBinding {
        logical_session_id: session_id("integrator-2"),
        roles: roles(&[SessionRole::Integrator]),
        label_snapshot: None,
        snapshot_event_id: None,
    });
    assert_eq!(
        validate_plan(&two_integrators),
        Err(vec![PlanViolation::IntegratorBindingCount { count: 2 }])
    );

    let mut missing_dependency = normal.clone();
    missing_dependency.work_items[0]
        .dependencies
        .push(work_item_id("not-in-plan"));
    assert_eq!(
        validate_plan(&missing_dependency),
        Err(vec![PlanViolation::MissingDependency {
            work_item_id: work_item_id("item-1"),
            dependency: work_item_id("not-in-plan"),
        }])
    );

    let mut cycle = normal.clone();
    cycle.work_items.push(WorkItem {
        id: work_item_id("item-2"),
        objective: "second".into(),
        assignee: Some(session_id("worker")),
        dependencies: vec![work_item_id("item-1")],
        expected_artifacts: Vec::new(),
        write_scope: Vec::new(),
        gates: Vec::new(),
        required: true,
        state: WorkItemState::Pending,
    });
    cycle.work_items[0]
        .dependencies
        .push(work_item_id("item-2"));
    assert_eq!(
        validate_plan(&cycle),
        Err(vec![
            PlanViolation::DependencyCycle {
                work_item_id: work_item_id("item-1"),
            },
            PlanViolation::DependencyCycle {
                work_item_id: work_item_id("item-2"),
            },
        ])
    );

    let mut overlapping_workers = normal.clone();
    overlapping_workers.bindings.push(SessionBinding {
        logical_session_id: session_id("worker-2"),
        roles: roles(&[SessionRole::Worker]),
        label_snapshot: None,
        snapshot_event_id: None,
    });
    overlapping_workers.work_items.push(WorkItem {
        id: work_item_id("item-2"),
        objective: "second writer".into(),
        assignee: Some(session_id("worker-2")),
        dependencies: Vec::new(),
        expected_artifacts: Vec::new(),
        write_scope: vec![PathScope {
            path_prefix: "src-tauri/src/workorder/model.rs".into(),
            worktree: Some("master".into()),
            branch: Some("master".into()),
        }],
        gates: Vec::new(),
        required: true,
        state: WorkItemState::Pending,
    });
    assert_eq!(
        validate_plan(&overlapping_workers),
        Err(vec![PlanViolation::OverlappingWorkerWriteScope {
            left: session_id("worker"),
            right: session_id("worker-2"),
            path_prefix: "src-tauri/src/workorder".into(),
        }])
    );

    let mut over_budget = normal;
    over_budget.budgets.max_work_items = 0;
    assert_eq!(
        validate_plan(&over_budget),
        Err(vec![PlanViolation::WorkItemBudgetExceeded {
            actual: 1,
            maximum: 0,
        }])
    );

    let mut all_at_once = sample_plan();
    all_at_once.goal.clear();
    all_at_once.acceptance_criteria.clear();
    all_at_once
        .bindings
        .retain(|binding| !binding.roles.contains(&SessionRole::Integrator));
    all_at_once.work_items[0].required = false;
    all_at_once.work_items[0].assignee = Some(session_id("unknown"));
    all_at_once.work_items[0]
        .dependencies
        .push(work_item_id("not-in-plan"));
    all_at_once.budgets.max_work_items = 0;
    assert_eq!(
        validate_plan(&all_at_once),
        Err(vec![
            PlanViolation::IntegratorBindingCount { count: 0 },
            PlanViolation::MissingDependency {
                work_item_id: work_item_id("item-1"),
                dependency: work_item_id("not-in-plan"),
            },
            PlanViolation::UnknownAssignee {
                work_item_id: work_item_id("item-1"),
                assignee: session_id("unknown"),
            },
            PlanViolation::WorkItemBudgetExceeded {
                actual: 1,
                maximum: 0,
            },
            PlanViolation::MissingRequiredWorkItem,
            PlanViolation::EmptyGoal,
            PlanViolation::MissingAcceptanceCriteria,
        ])
    );
}

#[test]
fn ensure_initialized_is_idempotent_for_the_same_path() {
    let directory = test_directory("ensure-initialized");
    let path = directory.join("workorders.db");
    ensure_initialized(&path).unwrap();
    ensure_initialized(&path).unwrap();

    let conn = reader(&path).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT value FROM workorder_meta WHERE key='schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap(),
        "1"
    );
}

#[test]
fn reader_rejects_inserts_with_query_only_enabled() {
    let directory = test_directory("reader-query-only");
    let path = directory.join("workorders.db");
    let conn = reader(&path).unwrap();

    assert_eq!(
        conn.query_row("PRAGMA query_only", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        1
    );
    let error = conn
        .execute(
            "INSERT INTO workorder_meta(key, value) VALUES ('reader-write', 'blocked')",
            [],
        )
        .unwrap_err();
    assert_eq!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::ReadOnly)
    );
}

#[test]
fn db_path_joins_workorders_database_name_without_environment_changes() {
    assert_eq!(
        db_path().unwrap(),
        crate::test_profile::runtime_dir()
            .unwrap()
            .join("workorders.db")
    );
}

#[test]
fn seal_plan_is_idempotent_for_double_go_click() {
    let (mut conn, order_id, _) = sealed_connection();
    let before: (i64, String) = conn
        .query_row(
            "SELECT COUNT(*), payload_json FROM dispatch_outbox",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        seal_plan(&mut conn, &order_id, SealOptions::default(), 103).unwrap(),
        SealOutcome::AlreadySealed { outbox_created: 0 }
    );
    let after: (i64, String) = conn
        .query_row(
            "SELECT COUNT(*), payload_json FROM dispatch_outbox",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(before, after);
}

#[test]
fn seal_plan_is_idempotent_after_reopening_database() {
    let directory = test_directory("restart");
    let path = directory.join("workorders.db");
    let order_id = work_order_id("order-restart");
    let plan = sample_plan();
    {
        let mut conn = Connection::open(&path).unwrap();
        super::schema::init(&conn).unwrap();
        create_draft(&conn, &order_id, &plan, 100).unwrap();
        record_all_sources(&conn, &order_id, &plan);
        assert!(matches!(
            seal_plan(&mut conn, &order_id, SealOptions::default(), 102),
            Ok(SealOutcome::Sealed { .. })
        ));
    }
    let mut reopened = Connection::open(&path).unwrap();
    super::schema::init(&reopened).unwrap();
    let before: (i64, String) = reopened
        .query_row(
            "SELECT COUNT(*), COALESCE(group_concat(payload_json, '|'), '') FROM dispatch_outbox",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        seal_plan(&mut reopened, &order_id, SealOptions::default(), 103).unwrap(),
        SealOutcome::AlreadySealed { outbox_created: 0 }
    );
    let after: (i64, String) = reopened
        .query_row(
            "SELECT COUNT(*), COALESCE(group_concat(payload_json, '|'), '') FROM dispatch_outbox",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(before, after);
    drop(reopened);
    std::fs::remove_dir_all(&directory).unwrap();
}

#[test]
fn insert_dispatch_outbox_conflict_do_nothing_is_effective() {
    let conn = memory_connection();
    let order_id = work_order_id("order-direct-outbox");
    let plan = sample_plan();
    create_draft(&conn, &order_id, &plan, 100).unwrap();

    assert_eq!(
        super::store::insert_dispatch_outbox(&conn, &order_id, 1, &plan.work_items[0], 101)
            .unwrap(),
        1
    );
    assert_eq!(
        super::store::insert_dispatch_outbox(&conn, &order_id, 1, &plan.work_items[0], 102)
            .unwrap(),
        0
    );
    assert_eq!(
        outbox_rows(&conn),
        vec![
            ((
                order_id.as_str().to_owned(),
                1,
                "item-1".into(),
                "send".into(),
                serde_json::json!({
                    "plan_version": 1,
                    "work_item_id": "item-1",
                    "work_order_id": "order-direct-outbox",
                })
                .to_string(),
                "pending".into(),
                0,
                None,
                101,
                101,
            ))
        ]
    );
}

#[test]
fn seal_plan_is_idempotent_with_three_items_and_a_dependency() {
    let mut conn = memory_connection();
    let order_id = work_order_id("order-three-items");
    let plan = three_item_plan();
    create_draft(&conn, &order_id, &plan, 100).unwrap();
    record_all_sources(&conn, &order_id, &plan);

    assert_eq!(
        seal_plan(&mut conn, &order_id, SealOptions::default(), 101).unwrap(),
        SealOutcome::Sealed { outbox_created: 2 }
    );
    let before = outbox_rows(&conn);
    assert_eq!(before.len(), 2);
    assert!(before.iter().all(|row| row.2 != "item-3"));
    assert_eq!(
        work_item_state(&conn, &order_id, &work_item_id("item-1")),
        "ready"
    );
    assert_eq!(
        work_item_state(&conn, &order_id, &work_item_id("item-2")),
        "ready"
    );
    assert_eq!(
        work_item_state(&conn, &order_id, &work_item_id("item-3")),
        "pending"
    );

    assert_eq!(
        seal_plan(&mut conn, &order_id, SealOptions::default(), 102).unwrap(),
        SealOutcome::AlreadySealed { outbox_created: 0 }
    );
    assert_eq!(outbox_rows(&conn), before);
}

#[test]
fn create_draft_has_zero_pre_go_side_effects() {
    let conn = memory_connection();
    let plan = sample_plan();
    create_draft(&conn, &work_order_id("order-draft"), &plan, 100).unwrap();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM dispatch_outbox"), 0);
}

#[test]
fn seal_plan_rejects_missing_required_sources_without_writes() {
    let mut conn = memory_connection();
    let plan = sample_plan();
    let order_id = work_order_id("order-missing");
    create_draft(&conn, &order_id, &plan, 100).unwrap();
    assert!(matches!(
        seal_plan(&mut conn, &order_id, SealOptions::default(), 101),
        Err(StoreError::SourcesNotReady { .. })
    ));
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM dispatch_outbox"), 0);
    assert_eq!(
        conn.query_row(
            "SELECT sealed_at FROM work_order_versions WHERE work_order_id=?1 AND plan_version=1",
            [order_id.as_str()],
            |row| row.get::<_, Option<i64>>(0)
        )
        .unwrap(),
        None
    );
}

#[test]
fn seal_plan_records_single_override_for_missing_sources() {
    let mut conn = memory_connection();
    let plan = sample_plan();
    let order_id = work_order_id("order-override");
    create_draft(&conn, &order_id, &plan, 100).unwrap();
    assert!(matches!(
        seal_plan(
            &mut conn,
            &order_id,
            SealOptions {
                override_missing_sources: true
            },
            101
        ),
        Ok(SealOutcome::Sealed { .. })
    ));
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM workorder_audit WHERE action='override_missing_source'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}

#[test]
fn override_audit_records_exactly_the_unacquired_source_sessions() {
    let mut conn = memory_connection();
    let plan = sample_plan();
    let order_id = work_order_id("order-override-detail");
    create_draft(&conn, &order_id, &plan, 100).unwrap();
    record_source_snapshot(
        &conn,
        &order_id,
        1,
        &session_id("source-1"),
        SourceSnapshotStatus::Acquired,
        None,
        None,
        101,
    )
    .unwrap();

    seal_plan(
        &mut conn,
        &order_id,
        SealOptions {
            override_missing_sources: true,
        },
        102,
    )
    .unwrap();
    let detail: String = conn
        .query_row(
            "SELECT detail_json FROM workorder_audit WHERE action='override_missing_source'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&detail).unwrap(),
        serde_json::json!({"missing_sources": ["source-2", "source-3"]})
    );
}

#[test]
fn missing_required_sources_rejection_keeps_draft_and_audit_empty() {
    let mut conn = memory_connection();
    let plan = sample_plan();
    let order_id = work_order_id("order-missing-audit");
    create_draft(&conn, &order_id, &plan, 100).unwrap();

    assert_eq!(
        seal_plan(&mut conn, &order_id, SealOptions::default(), 101),
        Err(StoreError::SourcesNotReady {
            missing: vec![
                session_id("source-1"),
                session_id("source-2"),
                session_id("source-3"),
            ],
        })
    );
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM workorder_audit"), 0);
    assert_eq!(
        conn.query_row(
            "SELECT state FROM work_orders WHERE id=?1",
            [order_id.as_str()],
            |row| row.get::<_, String>(0),
        )
        .unwrap(),
        "draft"
    );
}

#[test]
fn source_coverage_counts_target_acquired_and_missing() {
    let conn = memory_connection();
    let plan = sample_plan();
    let order_id = work_order_id("order-coverage");
    create_draft(&conn, &order_id, &plan, 100).unwrap();
    for source in [session_id("source-1"), session_id("source-2")] {
        record_source_snapshot(
            &conn,
            &order_id,
            1,
            &source,
            SourceSnapshotStatus::Acquired,
            None,
            None,
            101,
        )
        .unwrap();
    }
    assert_eq!(
        source_coverage(&conn, &order_id, 1).unwrap(),
        SourceCoverage {
            target: 3,
            acquired: 2,
            missing: 1,
            failed: 0,
        }
    );
}

#[test]
fn source_coverage_counts_failed_snapshots_separately_from_missing() {
    let conn = memory_connection();
    let plan = sample_plan();
    let order_id = work_order_id("order-coverage-failed");
    create_draft(&conn, &order_id, &plan, 100).unwrap();
    record_source_snapshot(
        &conn,
        &order_id,
        1,
        &session_id("source-1"),
        SourceSnapshotStatus::Acquired,
        None,
        None,
        101,
    )
    .unwrap();
    record_source_snapshot(
        &conn,
        &order_id,
        1,
        &session_id("source-2"),
        SourceSnapshotStatus::Failed,
        None,
        Some("snapshot unavailable"),
        101,
    )
    .unwrap();

    assert_eq!(
        source_coverage(&conn, &order_id, 1).unwrap(),
        SourceCoverage {
            target: 3,
            acquired: 1,
            missing: 1,
            failed: 1,
        }
    );
}

#[test]
fn record_report_deduplicates_envelope_id() {
    let (conn, order_id, _) = sealed_connection();
    set_work_item_running_for_report_test(&conn, &order_id);
    record_gate_result(
        &conn,
        &order_id,
        1,
        &work_item_id("item-1"),
        &gate_id("gate-1"),
        GateStatus::Pass,
        &serde_json::json!({"test": "pass"}),
        103,
    )
    .unwrap();
    let envelope = ReportEnvelope {
        id: report_id("report-1"),
        work_order_id: order_id.clone(),
        plan_version: 1,
        work_item_id: work_item_id("item-1"),
        logical_session_id: session_id("worker"),
        terminal: true,
        outcome: ReportOutcome::Succeeded,
        verified_facts: vec![serde_json::json!({"test": "pass"})],
        unverified_claims: vec![serde_json::json!("done")],
        open_questions: Vec::new(),
        evidence_event_ids: Vec::new(),
        received_at: 103,
    };
    assert_eq!(
        record_report(&conn, &envelope).unwrap(),
        RecordReportOutcome::Recorded
    );
    assert_eq!(
        record_report(&conn, &envelope).unwrap(),
        RecordReportOutcome::Duplicate
    );
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM report_envelopes"), 1);
    assert_eq!(
        conn.query_row(
            "SELECT state FROM work_items WHERE work_order_id=?1 AND plan_version=1 AND id='item-1'",
            [order_id.as_str()],
            |row| row.get::<_, String>(0),
        )
        .unwrap(),
        "verified"
    );
}

#[test]
fn report_without_gates_does_not_reach_verified() {
    let mut conn = memory_connection();
    let order_id = work_order_id("order-no-gates");
    let mut plan = sample_plan();
    plan.work_items[0].gates.clear();
    create_draft(&conn, &order_id, &plan, 100).unwrap();
    record_all_sources(&conn, &order_id, &plan);
    seal_plan(&mut conn, &order_id, SealOptions::default(), 102).unwrap();
    set_work_item_running_for_report_test(&conn, &order_id);

    record_report(
        &conn,
        &report_envelope("report-no-gates", &order_id, true, ReportOutcome::Succeeded),
    )
    .unwrap();
    assert_eq!(
        work_item_state(&conn, &order_id, &work_item_id("item-1")),
        "reported"
    );
}

#[test]
fn report_with_unrecorded_gate_does_not_reach_verified() {
    let (conn, order_id, _) = sealed_connection();
    set_work_item_running_for_report_test(&conn, &order_id);

    record_report(
        &conn,
        &report_envelope(
            "report-unrecorded-gate",
            &order_id,
            true,
            ReportOutcome::Succeeded,
        ),
    )
    .unwrap();
    assert_eq!(
        work_item_state(&conn, &order_id, &work_item_id("item-1")),
        "reported"
    );
    record_gate_result(
        &conn,
        &order_id,
        1,
        &work_item_id("item-1"),
        &gate_id("gate-1"),
        GateStatus::Pass,
        &serde_json::json!({"gate": "pass"}),
        104,
    )
    .unwrap();
    assert_eq!(
        work_item_state(&conn, &order_id, &work_item_id("item-1")),
        "verified"
    );
}

#[test]
fn terminal_failed_report_does_not_change_work_item_state() {
    let (conn, order_id, _) = sealed_connection();
    set_work_item_running_for_report_test(&conn, &order_id);

    record_report(
        &conn,
        &report_envelope("report-failed", &order_id, true, ReportOutcome::Failed),
    )
    .unwrap();
    assert_eq!(
        work_item_state(&conn, &order_id, &work_item_id("item-1")),
        "running"
    );
}

#[test]
fn nonterminal_report_does_not_change_work_item_state() {
    let (conn, order_id, _) = sealed_connection();
    set_work_item_running_for_report_test(&conn, &order_id);

    record_report(
        &conn,
        &report_envelope("report-progress", &order_id, false, ReportOutcome::Progress),
    )
    .unwrap();
    assert_eq!(
        work_item_state(&conn, &order_id, &work_item_id("item-1")),
        "running"
    );
}

#[test]
fn unverified_completion_claim_never_makes_done() {
    let (conn, order_id, _) = sealed_connection();
    let envelope = ReportEnvelope {
        id: report_id("report-claim"),
        work_order_id: order_id.clone(),
        plan_version: 1,
        work_item_id: work_item_id("item-1"),
        logical_session_id: session_id("worker"),
        terminal: false,
        outcome: ReportOutcome::Progress,
        verified_facts: Vec::new(),
        unverified_claims: vec![serde_json::json!("テストは通った")],
        open_questions: Vec::new(),
        evidence_event_ids: Vec::new(),
        received_at: 103,
    };
    record_report(&conn, &envelope).unwrap();
    let inputs = done_inputs(&conn, &order_id, 1).unwrap();
    assert!(!is_done(&inputs));
    assert_eq!(
        done_blockers(&inputs),
        vec![
            DoneBlocker::RequiredItemMissingSucceededTerminalReport {
                work_item_id: work_item_id("item-1"),
            },
            DoneBlocker::RequiredItemGateNotPassed {
                work_item_id: work_item_id("item-1"),
                gate_id: gate_id("gate-1"),
                status: GateStatus::Pending,
            },
            DoneBlocker::IntegratorReportMissing,
        ]
    );
}

#[test]
fn pending_required_gate_blocks_done() {
    let inputs = DoneInputs {
        required_items: vec![RequiredItemStatus {
            work_item_id: work_item_id("item-1"),
            terminal_report_received: true,
            outcome: Some(ReportOutcome::Succeeded),
            gates: vec![RequiredGateStatus {
                gate_id: gate_id("gate-1"),
                status: GateStatus::Pending,
            }],
        }],
        integrator_report_received: true,
        open_decision_count: 0,
    };
    assert!(!is_done(&inputs));
    assert!(done_blockers(&inputs).iter().any(|blocker| matches!(
        blocker,
        DoneBlocker::RequiredItemGateNotPassed {
            status: GateStatus::Pending,
            ..
        }
    )));
}

#[test]
fn open_decision_blocks_done() {
    let inputs = DoneInputs {
        required_items: vec![RequiredItemStatus {
            work_item_id: work_item_id("item-1"),
            terminal_report_received: true,
            outcome: Some(ReportOutcome::Succeeded),
            gates: vec![RequiredGateStatus {
                gate_id: gate_id("gate-1"),
                status: GateStatus::Pass,
            }],
        }],
        integrator_report_received: true,
        open_decision_count: 1,
    };
    assert!(!is_done(&inputs));
    assert!(done_blockers(&inputs)
        .iter()
        .any(|blocker| matches!(blocker, DoneBlocker::OpenDecisions { count: 1 })));
}

#[test]
fn all_machine_completion_conditions_are_required_for_done() {
    let inputs = DoneInputs {
        required_items: vec![RequiredItemStatus {
            work_item_id: work_item_id("item-1"),
            terminal_report_received: true,
            outcome: Some(ReportOutcome::Succeeded),
            gates: vec![RequiredGateStatus {
                gate_id: gate_id("gate-1"),
                status: GateStatus::Pass,
            }],
        }],
        integrator_report_received: true,
        open_decision_count: 0,
    };
    assert!(is_done(&inputs));
    assert!(done_blockers(&inputs).is_empty());
}

#[test]
fn bump_plan_version_preserves_sealed_old_version_and_outbox() {
    let (mut conn, order_id, mut plan) = sealed_connection();
    let old = load_plan(&conn, &order_id, 1).unwrap();
    let old_outbox: String = conn
        .query_row(
            "SELECT payload_json FROM dispatch_outbox WHERE work_order_id=?1 AND plan_version=1",
            [order_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    plan.goal = "replanned objective".into();
    plan.work_items[0].objective = "new work item objective".into();
    let version = bump_plan_version(&mut conn, &order_id, &plan, 103).unwrap();
    assert_eq!(version, 2);
    assert_eq!(load_plan(&conn, &order_id, 1).unwrap(), old);
    assert_eq!(
        conn.query_row(
            "SELECT payload_json FROM dispatch_outbox WHERE work_order_id=?1 AND plan_version=1",
            [order_id.as_str()],
            |row| row.get::<_, String>(0),
        )
        .unwrap(),
        old_outbox
    );
    assert_eq!(
        load_plan(&conn, &order_id, 2).unwrap().goal,
        "replanned objective"
    );
}

#[test]
fn advanced_source_does_not_mutate_sealed_bindings_or_outbox() {
    let (conn, order_id, _) = sealed_connection();
    let before: (i64, String) = conn.query_row(
        "SELECT (SELECT COUNT(*) FROM session_bindings WHERE work_order_id=?1 AND plan_version=1), \
                (SELECT payload_json FROM dispatch_outbox WHERE work_order_id=?1 AND plan_version=1)",
        [order_id.as_str()],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert!(matches!(
        record_source_snapshot(
            &conn,
            &order_id,
            1,
            &session_id("source-1"),
            SourceSnapshotStatus::Acquired,
            None,
            None,
            104,
        ),
        Err(StoreError::InvalidState { .. })
    ));
    mark_source_advanced_since_seal(&conn, &order_id, 1, &session_id("source-1")).unwrap();
    let advanced: i64 = conn.query_row(
        "SELECT advanced_since_seal FROM source_snapshots WHERE work_order_id=?1 AND plan_version=1 AND logical_session_id='source-1'",
        [order_id.as_str()],
        |row| row.get(0),
    ).unwrap();
    let after: (i64, String) = conn.query_row(
        "SELECT (SELECT COUNT(*) FROM session_bindings WHERE work_order_id=?1 AND plan_version=1), \
                (SELECT payload_json FROM dispatch_outbox WHERE work_order_id=?1 AND plan_version=1)",
        [order_id.as_str()],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert_eq!(advanced, 1);
    assert_eq!(before, after);
}

#[test]
fn serde_round_trip_preserves_budget_work_item_and_session_role() {
    let budget = CoordinationBudget::default();
    let item = sample_plan().work_items.remove(0);
    let role = SessionRole::Reviewer;
    assert_eq!(
        serde_json::from_str::<CoordinationBudget>(&serde_json::to_string(&budget).unwrap())
            .unwrap(),
        budget
    );
    assert_eq!(
        serde_json::from_str::<WorkItem>(&serde_json::to_string(&item).unwrap()).unwrap(),
        item
    );
    assert_eq!(
        serde_json::from_str::<SessionRole>(&serde_json::to_string(&role).unwrap()).unwrap(),
        role
    );
}

#[test]
fn identifier_newtypes_serialize_as_transparent_json_strings() {
    macro_rules! assert_transparent_string {
        ($id:ident, $value:literal) => {{
            let id = $id::try_new($value).unwrap();
            let json = serde_json::to_string(&id).unwrap();
            assert_eq!(json, format!("{:?}", $value));
            assert_eq!(serde_json::from_str::<$id>(&json).unwrap(), id);
        }};
    }

    assert_transparent_string!(WorkOrderId, "order-1");
    assert_transparent_string!(WorkItemId, "item-1");
    assert_transparent_string!(LogicalSessionId, "session-1");
    assert_transparent_string!(EventId, "event-1");
    assert_transparent_string!(ReportEnvelopeId, "report-1");
    assert_transparent_string!(GateId, "gate-1");
    assert_transparent_string!(DecisionId, "decision-1");
}

#[test]
fn session_role_serde_round_trips_every_variant() {
    for (role, wire) in [
        (SessionRole::Source, r#""source""#),
        (SessionRole::Worker, r#""worker""#),
        (SessionRole::Integrator, r#""integrator""#),
        (SessionRole::Reviewer, r#""reviewer""#),
    ] {
        assert_eq!(serde_json::to_string(&role).unwrap(), wire);
        assert_eq!(serde_json::from_str::<SessionRole>(wire).unwrap(), role);
    }
}
