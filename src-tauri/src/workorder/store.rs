//! Thin SQLite persistence layer for the WorkOrder domain.
//!
//! It intentionally has no pool and no Tauri state. Every mutation receives
//! its timestamp from the caller, which keeps the store deterministic in tests.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::de::DeserializeOwned;

use super::{
    can_transition_work_item, done::DoneInputs, done::RequiredItemStatus, transition,
    transition_work_item, validate_plan, DecisionId, DecisionItem, EventId, GateId, GateStatus,
    LogicalSessionId, ModelError, PlanDraft, PlanSnapshot, PlanViolation, ReportEnvelope,
    ReportOutcome, SessionRole, WorkItem, WorkItemId, WorkItemState, WorkOrderId, WorkOrderState,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    Database(String),
    Runtime(String),
    Serialization(String),
    Model(ModelError),
    PlanInvalid(Vec<PlanViolation>),
    SourcesNotReady {
        missing: Vec<LogicalSessionId>,
    },
    InvalidState {
        current: WorkOrderState,
        operation: &'static str,
    },
    NotFound(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database(message)
            | Self::Runtime(message)
            | Self::Serialization(message)
            | Self::NotFound(message) => formatter.write_str(message),
            Self::Model(error) => error.fmt(formatter),
            Self::PlanInvalid(violations) => write!(formatter, "invalid plan: {violations:?}"),
            Self::SourcesNotReady { missing } => {
                write!(formatter, "source snapshots not ready: {missing:?}")
            }
            Self::InvalidState { current, operation } => {
                write!(
                    formatter,
                    "cannot {operation} while WorkOrder is {current:?}"
                )
            }
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(error.to_string())
    }
}

impl From<ModelError> for StoreError {
    fn from(error: ModelError) -> Self {
        Self::Model(error)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceSnapshotStatus {
    Pending,
    Acquired,
    Failed,
}

impl SourceSnapshotStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Acquired => "acquired",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceCoverage {
    pub target: u32,
    pub acquired: u32,
    pub missing: u32,
    pub failed: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SealOptions {
    pub override_missing_sources: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SealOutcome {
    Sealed { outbox_created: u32 },
    AlreadySealed { outbox_created: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordReportOutcome {
    Recorded,
    Duplicate,
}

fn initialized_paths() -> &'static Mutex<HashSet<PathBuf>> {
    static PATHS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    PATHS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn db_path() -> Result<PathBuf, StoreError> {
    Ok(crate::test_profile::runtime_dir()
        .map_err(StoreError::Runtime)?
        .join("workorders.db"))
}

pub fn ensure_initialized(path: &Path) -> Result<(), StoreError> {
    let normalized = path.to_path_buf();
    let mut paths = initialized_paths()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if paths.contains(&normalized) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| StoreError::Runtime(format!("create {parent:?}: {error}")))?;
    }
    let conn = Connection::open(path)
        .map_err(|error| StoreError::Database(format!("open {path:?}: {error}")))?;
    configure_connection(&conn)?;
    super::schema::init(&conn)?;
    paths.insert(normalized);
    Ok(())
}

pub fn reader(path: &Path) -> Result<Connection, StoreError> {
    ensure_initialized(path)?;
    let conn = Connection::open(path)
        .map_err(|error| StoreError::Database(format!("open reader {path:?}: {error}")))?;
    configure_connection(&conn)?;
    conn.execute_batch("PRAGMA query_only=ON")
        .map_err(|error| StoreError::Database(format!("set query_only reader: {error}")))?;
    Ok(conn)
}

pub fn writer(path: &Path) -> Result<Connection, StoreError> {
    ensure_initialized(path)?;
    let conn = Connection::open(path)
        .map_err(|error| StoreError::Database(format!("open writer {path:?}: {error}")))?;
    configure_connection(&conn)?;
    Ok(conn)
}

fn configure_connection(conn: &Connection) -> Result<(), StoreError> {
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

pub fn create_draft(
    conn: &Connection,
    id: &WorkOrderId,
    plan: &PlanDraft,
    now_ms: i64,
) -> Result<(), StoreError> {
    validate_plan(plan).map_err(StoreError::PlanInvalid)?;
    let transaction = conn.unchecked_transaction()?;
    transaction.execute(
        "INSERT INTO work_orders(id, goal, state, plan_version, created_at, updated_at, closed_reason) \
         VALUES (?1, ?2, ?3, 1, ?4, ?4, NULL)",
        params![id.as_str(), plan.goal, WorkOrderState::Draft.as_str(), now_ms],
    )?;
    insert_plan(&transaction, id, 1, plan, now_ms)?;
    transaction.commit()?;
    Ok(())
}

pub fn load_plan(
    conn: &Connection,
    id: &WorkOrderId,
    plan_version: u32,
) -> Result<PlanSnapshot, StoreError> {
    let (goal, acceptance_criteria_json, budgets_json, sealed_at): (
        String,
        String,
        String,
        Option<i64>,
    ) = conn
        .query_row(
            "SELECT goal, acceptance_criteria_json, budgets_json, sealed_at \
             FROM work_order_versions WHERE work_order_id=?1 AND plan_version=?2",
            params![id.as_str(), i64::from(plan_version)],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound(format!("plan {} v{plan_version}", id.as_str())))?;

    let mut bindings = Vec::new();
    let mut binding_rows = conn.prepare(
        "SELECT logical_session_id, roles_json, label_snapshot, snapshot_event_id \
         FROM session_bindings WHERE work_order_id=?1 AND plan_version=?2 ORDER BY logical_session_id",
    )?;
    let rows = binding_rows.query_map(params![id.as_str(), i64::from(plan_version)], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
        ))
    })?;
    for row in rows {
        let (logical_session_id, roles_json, label_snapshot, snapshot_event_id) = row?;
        bindings.push(super::SessionBinding {
            logical_session_id: LogicalSessionId::try_new(&logical_session_id)?,
            roles: from_json(&roles_json)?,
            label_snapshot,
            snapshot_event_id: snapshot_event_id
                .as_deref()
                .map(EventId::try_new)
                .transpose()?,
        });
    }

    let mut work_items = Vec::new();
    let mut item_rows = conn.prepare(
        "SELECT id, objective, assignee_logical_session_id, dependencies_json, \
                expected_artifacts_json, write_scope_json, gates_json, required, state \
         FROM work_items WHERE work_order_id=?1 AND plan_version=?2 ORDER BY ordinal, id",
    )?;
    let rows = item_rows.query_map(params![id.as_str(), i64::from(plan_version)], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, i64>(7)?,
            row.get::<_, String>(8)?,
        ))
    })?;
    for row in rows {
        let (
            item_id,
            objective,
            assignee,
            dependencies,
            artifacts,
            write_scope,
            gates,
            required,
            state,
        ) = row?;
        work_items.push(WorkItem {
            id: WorkItemId::try_new(&item_id)?,
            objective,
            assignee: assignee
                .as_deref()
                .map(LogicalSessionId::try_new)
                .transpose()?,
            dependencies: from_json(&dependencies)?,
            expected_artifacts: from_json(&artifacts)?,
            write_scope: from_json(&write_scope)?,
            gates: from_json(&gates)?,
            required: required != 0,
            state: from_db_enum(&state)?,
        });
    }

    Ok(PlanSnapshot {
        id: id.clone(),
        plan_version,
        goal,
        acceptance_criteria: from_json(&acceptance_criteria_json)?,
        budgets: from_json(&budgets_json)?,
        sealed_at,
        bindings,
        work_items,
    })
}

pub fn record_source_snapshot(
    conn: &Connection,
    id: &WorkOrderId,
    plan_version: u32,
    logical_session_id: &LogicalSessionId,
    status: SourceSnapshotStatus,
    snapshot_event_id: Option<&EventId>,
    failure_reason: Option<&str>,
    now_ms: i64,
) -> Result<(), StoreError> {
    let sealed_at: Option<i64> = conn
        .query_row(
            "SELECT sealed_at FROM work_order_versions WHERE work_order_id=?1 AND plan_version=?2",
            params![id.as_str(), i64::from(plan_version)],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    if sealed_at.is_some() {
        let state: String = conn.query_row(
            "SELECT state FROM work_orders WHERE id=?1",
            [id.as_str()],
            |row| row.get(0),
        )?;
        return Err(StoreError::InvalidState {
            current: from_db_enum(&state)?,
            operation: "record source snapshot for sealed plan",
        });
    }
    if !source_ids(conn, id, plan_version)?.contains(logical_session_id) {
        return Err(StoreError::NotFound(format!(
            "source binding {} for {} v{plan_version}",
            logical_session_id.as_str(),
            id.as_str()
        )));
    }
    conn.execute(
        "INSERT INTO source_snapshots(work_order_id, plan_version, logical_session_id, status, \
             snapshot_event_id, acquired_at, failure_reason, advanced_since_seal) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0) \
         ON CONFLICT(work_order_id, plan_version, logical_session_id) DO UPDATE SET \
             status=excluded.status, snapshot_event_id=excluded.snapshot_event_id, \
             acquired_at=excluded.acquired_at, failure_reason=excluded.failure_reason",
        params![
            id.as_str(),
            i64::from(plan_version),
            logical_session_id.as_str(),
            status.as_str(),
            snapshot_event_id.map(EventId::as_str),
            if status == SourceSnapshotStatus::Acquired {
                Some(now_ms)
            } else {
                None
            },
            failure_reason,
        ],
    )?;
    Ok(())
}

pub fn source_coverage(
    conn: &Connection,
    id: &WorkOrderId,
    plan_version: u32,
) -> Result<SourceCoverage, StoreError> {
    let sources = source_ids(conn, id, plan_version)?;
    let mut acquired = 0_u32;
    let mut failed = 0_u32;
    for source in &sources {
        let status: Option<String> = conn
            .query_row(
                "SELECT status FROM source_snapshots \
                 WHERE work_order_id=?1 AND plan_version=?2 AND logical_session_id=?3",
                params![id.as_str(), i64::from(plan_version), source.as_str()],
                |row| row.get(0),
            )
            .optional()?;
        match status.as_deref() {
            Some("acquired") => acquired += 1,
            Some("failed") => failed += 1,
            _ => {}
        }
    }
    let target = u32::try_from(sources.len())
        .map_err(|_| StoreError::Database("source binding count exceeds u32".into()))?;
    Ok(SourceCoverage {
        target,
        acquired,
        missing: target.saturating_sub(acquired).saturating_sub(failed),
        failed,
    })
}

pub fn seal_plan(
    conn: &mut Connection,
    id: &WorkOrderId,
    opts: SealOptions,
    now_ms: i64,
) -> Result<SealOutcome, StoreError> {
    let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (plan_version, state): (i64, String) = transaction
        .query_row(
            "SELECT plan_version, state FROM work_orders WHERE id=?1",
            [id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound(format!("work order {}", id.as_str())))?;
    let plan_version = u32::try_from(plan_version)
        .map_err(|_| StoreError::Database("plan version is negative or too large".into()))?;
    let sealed_at: Option<i64> = transaction.query_row(
        "SELECT sealed_at FROM work_order_versions WHERE work_order_id=?1 AND plan_version=?2",
        params![id.as_str(), i64::from(plan_version)],
        |row| row.get(0),
    )?;
    if sealed_at.is_some() {
        transaction.commit()?;
        return Ok(SealOutcome::AlreadySealed { outbox_created: 0 });
    }
    let state: WorkOrderState = from_db_enum(&state)?;
    if !matches!(state, WorkOrderState::Draft | WorkOrderState::AwaitingGo) {
        return Err(StoreError::InvalidState {
            current: state,
            operation: "seal plan",
        });
    }
    // A Draft is accepted as a convenience for a freshly compiled plan, but
    // still traverses the only permitted logical route to Running.
    let awaiting_go = if state == WorkOrderState::Draft {
        transition(state, WorkOrderState::AwaitingGo)?
    } else {
        state
    };
    let running = transition(awaiting_go, WorkOrderState::Running)?;
    let snapshot = load_plan(&transaction, id, plan_version)?;
    let plan = PlanDraft {
        goal: snapshot.goal,
        acceptance_criteria: snapshot.acceptance_criteria,
        bindings: snapshot.bindings,
        work_items: snapshot.work_items,
        budgets: snapshot.budgets,
    };
    validate_plan(&plan).map_err(StoreError::PlanInvalid)?;
    let mut missing = Vec::new();
    for source in source_ids(&transaction, id, plan_version)? {
        let status: Option<String> = transaction
            .query_row(
                "SELECT status FROM source_snapshots \
                 WHERE work_order_id=?1 AND plan_version=?2 AND logical_session_id=?3",
                params![id.as_str(), i64::from(plan_version), source.as_str()],
                |row| row.get(0),
            )
            .optional()?;
        if status.as_deref() != Some("acquired") {
            missing.push(source);
        }
    }
    if !missing.is_empty() && !opts.override_missing_sources {
        return Err(StoreError::SourcesNotReady { missing });
    }
    if !missing.is_empty() {
        record_audit(
            &transaction,
            id,
            plan_version,
            now_ms,
            "user",
            "override_missing_source",
            serde_json::json!({"missing_sources": missing}),
        )?;
    }
    // The binding is the sealed reference contract. Copy the event boundary
    // collected immediately before GO into it only after source coverage has
    // been accepted, so a failed GO never advances a binding implicitly.
    for binding in plan
        .bindings
        .iter()
        .filter(|binding| binding.roles.contains(&SessionRole::Source))
    {
        let snapshot_event_id: Option<String> = transaction
            .query_row(
                "SELECT snapshot_event_id FROM source_snapshots \
                 WHERE work_order_id=?1 AND plan_version=?2 AND logical_session_id=?3",
                params![
                    id.as_str(),
                    i64::from(plan_version),
                    binding.logical_session_id.as_str()
                ],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        transaction.execute(
            "UPDATE session_bindings SET snapshot_event_id=?4 \
             WHERE work_order_id=?1 AND plan_version=?2 AND logical_session_id=?3",
            params![
                id.as_str(),
                i64::from(plan_version),
                binding.logical_session_id.as_str(),
                snapshot_event_id,
            ],
        )?;
    }
    transaction.execute(
        "UPDATE work_order_versions SET sealed_at=?3 WHERE work_order_id=?1 AND plan_version=?2",
        params![id.as_str(), i64::from(plan_version), now_ms],
    )?;
    let mut outbox_created = 0_u32;
    for item in &plan.work_items {
        if item.dependencies.is_empty() {
            outbox_created += insert_dispatch_outbox(&transaction, id, plan_version, item, now_ms)?;
        }
        let item_state = if item.dependencies.is_empty() {
            WorkItemState::Ready
        } else {
            WorkItemState::Pending
        };
        transaction.execute(
            "UPDATE work_items SET state=?4, updated_at=?5 \
             WHERE work_order_id=?1 AND plan_version=?2 AND id=?3",
            params![
                id.as_str(),
                i64::from(plan_version),
                item.id.as_str(),
                item_state.as_str(),
                now_ms,
            ],
        )?;
    }
    transaction.execute(
        "UPDATE work_orders SET state=?2, updated_at=?3 WHERE id=?1",
        params![id.as_str(), running.as_str(), now_ms],
    )?;
    record_audit(
        &transaction,
        id,
        plan_version,
        now_ms,
        "engine",
        "seal",
        serde_json::json!({"outbox_created": outbox_created}),
    )?;
    transaction.commit()?;
    Ok(SealOutcome::Sealed { outbox_created })
}

pub fn record_report(
    conn: &Connection,
    envelope: &ReportEnvelope,
) -> Result<RecordReportOutcome, StoreError> {
    let transaction = conn.unchecked_transaction()?;
    let inserted = transaction.execute(
        "INSERT INTO report_envelopes(id, work_order_id, plan_version, work_item_id, \
             logical_session_id, terminal, outcome, verified_facts_json, unverified_claims_json, \
             open_questions_json, evidence_event_ids_json, received_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) \
         ON CONFLICT(id) DO NOTHING",
        params![
            envelope.id.as_str(),
            envelope.work_order_id.as_str(),
            i64::from(envelope.plan_version),
            envelope.work_item_id.as_str(),
            envelope.logical_session_id.as_str(),
            i64::from(envelope.terminal),
            envelope.outcome.as_str(),
            to_json(&envelope.verified_facts)?,
            to_json(&envelope.unverified_claims)?,
            to_json(&envelope.open_questions)?,
            to_json(&envelope.evidence_event_ids)?,
            envelope.received_at,
        ],
    )?;
    if inserted == 0 {
        transaction.commit()?;
        return Ok(RecordReportOutcome::Duplicate);
    }
    if envelope.terminal && envelope.outcome == ReportOutcome::Succeeded {
        let state: String = transaction.query_row(
            "SELECT state FROM work_items WHERE work_order_id=?1 AND plan_version=?2 AND id=?3",
            params![
                envelope.work_order_id.as_str(),
                i64::from(envelope.plan_version),
                envelope.work_item_id.as_str(),
            ],
            |row| row.get(0),
        )?;
        let state: WorkItemState = from_db_enum(&state)?;
        let current_order_state: String = transaction.query_row(
            "SELECT state FROM work_orders WHERE id=?1",
            [envelope.work_order_id.as_str()],
            |row| row.get(0),
        )?;
        let current_order_state: WorkOrderState = from_db_enum(&current_order_state)?;
        let next = transition_work_item(state, WorkItemState::Reported).map_err(|_| {
            StoreError::InvalidState {
                current: current_order_state,
                operation: "record report",
            }
        })?;
        transaction.execute(
            "UPDATE work_items SET state=?4, updated_at=?5 \
             WHERE work_order_id=?1 AND plan_version=?2 AND id=?3",
            params![
                envelope.work_order_id.as_str(),
                i64::from(envelope.plan_version),
                envelope.work_item_id.as_str(),
                next.as_str(),
                envelope.received_at,
            ],
        )?;
        maybe_mark_verified(
            &transaction,
            &envelope.work_order_id,
            envelope.plan_version,
            &envelope.work_item_id,
            envelope.received_at,
        )?;
    }
    transaction.commit()?;
    Ok(RecordReportOutcome::Recorded)
}

pub fn record_gate_result(
    conn: &Connection,
    id: &WorkOrderId,
    plan_version: u32,
    work_item_id: &WorkItemId,
    gate_id: &GateId,
    status: GateStatus,
    evidence: &serde_json::Value,
    now_ms: i64,
) -> Result<(), StoreError> {
    conn.execute(
        "INSERT INTO gate_results(work_order_id, plan_version, work_item_id, gate_id, status, evidence_json, recorded_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT(work_order_id, plan_version, work_item_id, gate_id) DO UPDATE SET \
             status=excluded.status, evidence_json=excluded.evidence_json, recorded_at=excluded.recorded_at",
        params![
            id.as_str(),
            i64::from(plan_version),
            work_item_id.as_str(),
            gate_id.as_str(),
            status.as_str(),
            to_json(evidence)?,
            now_ms,
        ],
    )?;
    maybe_mark_verified(conn, id, plan_version, work_item_id, now_ms)?;
    Ok(())
}

pub fn open_decisions(
    conn: &Connection,
    id: &WorkOrderId,
    plan_version: u32,
) -> Result<Vec<DecisionItem>, StoreError> {
    let mut statement = conn.prepare(
        "SELECT id, kind, summary, evidence_json, resolved_at, resolution \
         FROM decision_items WHERE work_order_id=?1 AND plan_version=?2 AND resolved_at IS NULL ORDER BY id",
    )?;
    let rows = statement.query_map(params![id.as_str(), i64::from(plan_version)], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<i64>>(4)?,
            row.get::<_, Option<String>>(5)?,
        ))
    })?;
    let mut decisions = Vec::new();
    for row in rows {
        let (decision_id, kind, summary, evidence, resolved_at, resolution) = row?;
        decisions.push(DecisionItem {
            id: DecisionId::try_new(&decision_id)?,
            work_order_id: id.clone(),
            plan_version,
            kind: from_db_enum(&kind)?,
            summary,
            evidence: from_json(&evidence)?,
            resolved_at,
            resolution,
        });
    }
    Ok(decisions)
}

pub fn done_inputs(
    conn: &Connection,
    id: &WorkOrderId,
    plan_version: u32,
) -> Result<DoneInputs, StoreError> {
    let plan = load_plan(conn, id, plan_version)?;
    let mut required_items = Vec::new();
    for item in plan.work_items.iter().filter(|item| item.required) {
        let terminal_outcome: Option<String> = conn
            .query_row(
                "SELECT outcome FROM report_envelopes WHERE work_order_id=?1 AND plan_version=?2 \
                 AND work_item_id=?3 AND terminal=1 ORDER BY received_at DESC, id DESC LIMIT 1",
                params![id.as_str(), i64::from(plan_version), item.id.as_str()],
                |row| row.get(0),
            )
            .optional()?;
        let mut gates = Vec::with_capacity(item.gates.len());
        for gate in &item.gates {
            let status: Option<String> = conn
                .query_row(
                    "SELECT status FROM gate_results WHERE work_order_id=?1 AND plan_version=?2 \
                     AND work_item_id=?3 AND gate_id=?4",
                    params![
                        id.as_str(),
                        i64::from(plan_version),
                        item.id.as_str(),
                        gate.id.as_str()
                    ],
                    |row| row.get(0),
                )
                .optional()?;
            gates.push(super::RequiredGateStatus {
                gate_id: gate.id.clone(),
                status: match status {
                    Some(status) => from_db_enum(&status)?,
                    None => GateStatus::Pending,
                },
            });
        }
        required_items.push(RequiredItemStatus {
            work_item_id: item.id.clone(),
            terminal_report_received: terminal_outcome.is_some(),
            outcome: terminal_outcome.as_deref().map(from_db_enum).transpose()?,
            gates,
        });
    }
    let integrator_ids: Vec<_> = plan
        .bindings
        .iter()
        .filter(|binding| binding.roles.contains(&SessionRole::Integrator))
        .map(|binding| binding.logical_session_id.as_str())
        .collect();
    let integrator_report_received =
        integrator_ids.iter().try_fold(false, |found, session_id| {
            if found {
                return Ok(true);
            }
            conn.query_row(
                "SELECT 1 FROM report_envelopes WHERE work_order_id=?1 AND plan_version=?2 \
             AND logical_session_id=?3 AND terminal=1 LIMIT 1",
                params![id.as_str(), i64::from(plan_version), session_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map(|value| value.is_some())
        })?;
    let open_decision_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM decision_items WHERE work_order_id=?1 AND plan_version=?2 AND resolved_at IS NULL",
        params![id.as_str(), i64::from(plan_version)],
        |row| row.get(0),
    )?;
    Ok(DoneInputs {
        required_items,
        integrator_report_received,
        open_decision_count: u32::try_from(open_decision_count)
            .map_err(|_| StoreError::Database("open decision count exceeds u32".into()))?,
    })
}

/// Adds an unsealed proposal version without activating it. Version activation
/// and writing `work_order_versions.superseded_at` are Stage 1 responsibilities;
/// Stage 0 only accumulates the proposed version.
pub fn bump_plan_version(
    conn: &mut Connection,
    id: &WorkOrderId,
    plan: &PlanDraft,
    now_ms: i64,
) -> Result<u32, StoreError> {
    validate_plan(plan).map_err(StoreError::PlanInvalid)?;
    let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let exists: Option<i64> = transaction
        .query_row(
            "SELECT 1 FROM work_orders WHERE id=?1",
            [id.as_str()],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Err(StoreError::NotFound(format!("work order {}", id.as_str())));
    }
    let previous: i64 = transaction.query_row(
        "SELECT MAX(plan_version) FROM work_order_versions WHERE work_order_id=?1",
        [id.as_str()],
        |row| row.get(0),
    )?;
    let next = u32::try_from(previous)
        .map_err(|_| StoreError::Database("plan version is negative or too large".into()))?
        .checked_add(1)
        .ok_or_else(|| StoreError::Database("plan version exceeds u32".into()))?;
    insert_plan(&transaction, id, next, plan, now_ms)?;
    transaction.commit()?;
    Ok(next)
}

pub fn mark_source_advanced_since_seal(
    conn: &Connection,
    id: &WorkOrderId,
    plan_version: u32,
    logical_session_id: &LogicalSessionId,
) -> Result<(), StoreError> {
    conn.execute(
        "UPDATE source_snapshots SET advanced_since_seal=1 \
         WHERE work_order_id=?1 AND plan_version=?2 AND logical_session_id=?3",
        params![
            id.as_str(),
            i64::from(plan_version),
            logical_session_id.as_str()
        ],
    )?;
    Ok(())
}

fn insert_plan(
    conn: &Connection,
    id: &WorkOrderId,
    plan_version: u32,
    plan: &PlanDraft,
    now_ms: i64,
) -> Result<(), StoreError> {
    conn.execute(
        "INSERT INTO work_order_versions(work_order_id, plan_version, goal, acceptance_criteria_json, budgets_json, sealed_at, superseded_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL)",
        params![
            id.as_str(),
            i64::from(plan_version),
            plan.goal,
            to_json(&plan.acceptance_criteria)?,
            to_json(&plan.budgets)?,
        ],
    )?;
    for binding in &plan.bindings {
        conn.execute(
            "INSERT INTO session_bindings(work_order_id, plan_version, logical_session_id, roles_json, label_snapshot, snapshot_event_id) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id.as_str(),
                i64::from(plan_version),
                binding.logical_session_id.as_str(),
                to_json(&binding.roles)?,
                binding.label_snapshot,
                binding.snapshot_event_id.as_ref().map(EventId::as_str),
            ],
        )?;
    }
    for (ordinal, item) in plan.work_items.iter().enumerate() {
        conn.execute(
            "INSERT INTO work_items(work_order_id, plan_version, ordinal, id, objective, assignee_logical_session_id, \
                 dependencies_json, expected_artifacts_json, write_scope_json, gates_json, required, state, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                id.as_str(),
                i64::from(plan_version),
                i64::try_from(ordinal)
                    .map_err(|_| StoreError::Database("work item ordinal exceeds i64".into()))?,
                item.id.as_str(),
                item.objective,
                item.assignee.as_ref().map(LogicalSessionId::as_str),
                to_json(&item.dependencies)?,
                to_json(&item.expected_artifacts)?,
                to_json(&item.write_scope)?,
                to_json(&item.gates)?,
                i64::from(item.required),
                // A plan is always persisted as a new Draft. Callers cannot
                // smuggle a terminal item state into a future sealed version.
                WorkItemState::Pending.as_str(),
                now_ms,
            ],
        )?;
    }
    Ok(())
}

fn source_ids(
    conn: &Connection,
    id: &WorkOrderId,
    plan_version: u32,
) -> Result<Vec<LogicalSessionId>, StoreError> {
    let mut statement = conn.prepare(
        "SELECT logical_session_id, roles_json FROM session_bindings \
         WHERE work_order_id=?1 AND plan_version=?2 ORDER BY logical_session_id",
    )?;
    let rows = statement.query_map(params![id.as_str(), i64::from(plan_version)], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut sources = Vec::new();
    for row in rows {
        let (logical_session_id, roles_json) = row?;
        let roles: std::collections::BTreeSet<SessionRole> = from_json(&roles_json)?;
        if roles.contains(&SessionRole::Source) {
            sources.push(LogicalSessionId::try_new(&logical_session_id)?);
        }
    }
    Ok(sources)
}

pub(super) fn record_audit(
    conn: &Connection,
    id: &WorkOrderId,
    plan_version: u32,
    now_ms: i64,
    actor: &str,
    action: &str,
    detail: serde_json::Value,
) -> Result<(), StoreError> {
    conn.execute(
        "INSERT INTO workorder_audit(work_order_id, plan_version, at, actor, action, detail_json) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            id.as_str(),
            i64::from(plan_version),
            now_ms,
            actor,
            action,
            to_json(&detail)?,
        ],
    )?;
    Ok(())
}

pub(super) fn insert_dispatch_outbox(
    conn: &Connection,
    id: &WorkOrderId,
    plan_version: u32,
    item: &WorkItem,
    now_ms: i64,
) -> Result<u32, StoreError> {
    // An assignee already names a destination session, so Stage 1 must send to
    // it. Without an assignee, Stage 1 must spawn a session before dispatching.
    let intent_kind = if item.assignee.is_some() {
        "send"
    } else {
        "spawn"
    };
    let payload = serde_json::json!({
        "work_order_id": id,
        "plan_version": plan_version,
        "work_item_id": item.id,
    });
    let changed = conn.execute(
        "INSERT INTO dispatch_outbox(work_order_id, plan_version, work_item_id, intent_kind, \
             payload_json, status, attempts, last_error, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, NULL, ?6, ?6) \
         ON CONFLICT(work_order_id, plan_version, work_item_id, intent_kind) DO NOTHING",
        params![
            id.as_str(),
            i64::from(plan_version),
            item.id.as_str(),
            intent_kind,
            to_json(&payload)?,
            now_ms,
        ],
    )?;
    u32::try_from(changed).map_err(|_| StoreError::Database("outbox row count exceeds u32".into()))
}

pub(super) fn insert_spawn_outbox(
    conn: &Connection,
    id: &WorkOrderId,
    plan_version: u32,
    item: &WorkItem,
    now_ms: i64,
) -> Result<u32, StoreError> {
    let payload = serde_json::json!({
        "work_order_id": id,
        "plan_version": plan_version,
        "work_item_id": item.id,
    });
    let changed = conn.execute(
        "INSERT INTO dispatch_outbox(work_order_id, plan_version, work_item_id, intent_kind, \
             payload_json, status, attempts, last_error, created_at, updated_at) \
         VALUES (?1, ?2, ?3, 'spawn', ?4, 'pending', 0, NULL, ?5, ?5) \
         ON CONFLICT(work_order_id, plan_version, work_item_id, intent_kind) DO NOTHING",
        params![
            id.as_str(),
            i64::from(plan_version),
            item.id.as_str(),
            to_json(&payload)?,
            now_ms,
        ],
    )?;
    u32::try_from(changed).map_err(|_| StoreError::Database("outbox row count exceeds u32".into()))
}

pub(super) fn transition_work_item_state(
    conn: &Connection,
    id: &WorkOrderId,
    plan_version: u32,
    work_item_id: &WorkItemId,
    to: WorkItemState,
    now_ms: i64,
) -> Result<WorkItemState, StoreError> {
    let current: String = conn
        .query_row(
            "SELECT state FROM work_items WHERE work_order_id=?1 AND plan_version=?2 AND id=?3",
            params![id.as_str(), i64::from(plan_version), work_item_id.as_str()],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound(format!("work item {}", work_item_id.as_str())))?;
    let current: WorkItemState = from_db_enum(&current)?;
    let next = transition_work_item(current, to)?;
    let changed = conn.execute(
        "UPDATE work_items SET state=?4, updated_at=?5 \
         WHERE work_order_id=?1 AND plan_version=?2 AND id=?3 AND state=?6",
        params![
            id.as_str(),
            i64::from(plan_version),
            work_item_id.as_str(),
            next.as_str(),
            now_ms,
            current.as_str(),
        ],
    )?;
    if changed != 1 {
        return Err(StoreError::Database(
            "work item state changed concurrently".into(),
        ));
    }
    Ok(next)
}

// 親裁定: Reported から Verified への自動昇格は、(1) gates が1件以上
// 定義され、(2) 定義された全 gate に結果行があり、全て Pass の場合だけ行う。
// 結果行の欠落は合格と読まず、条件外では Reported のまま据え置く。
fn maybe_mark_verified(
    conn: &Connection,
    id: &WorkOrderId,
    plan_version: u32,
    work_item_id: &WorkItemId,
    now_ms: i64,
) -> Result<(), StoreError> {
    let (gates_json, state): (String, String) = conn
        .query_row(
            "SELECT gates_json, state FROM work_items WHERE work_order_id=?1 AND plan_version=?2 AND id=?3",
            params![id.as_str(), i64::from(plan_version), work_item_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound(format!("work item {}", work_item_id.as_str())))?;
    let state: WorkItemState = from_db_enum(&state)?;
    if state != WorkItemState::Reported {
        return Ok(());
    }
    let gates: Vec<super::Gate> = from_json(&gates_json)?;
    let all_pass = !gates.is_empty() && gates.iter().try_fold(true, |all_pass, gate| {
        if !all_pass {
            return Ok(false);
        }
        conn.query_row(
            "SELECT status FROM gate_results WHERE work_order_id=?1 AND plan_version=?2 AND work_item_id=?3 AND gate_id=?4",
            params![id.as_str(), i64::from(plan_version), work_item_id.as_str(), gate.id.as_str()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map(|status| status.as_deref() == Some("pass"))
    })?;
    if all_pass && can_transition_work_item(state, WorkItemState::Verified) {
        conn.execute(
            "UPDATE work_items SET state='verified', updated_at=?4 \
             WHERE work_order_id=?1 AND plan_version=?2 AND id=?3",
            params![
                id.as_str(),
                i64::from(plan_version),
                work_item_id.as_str(),
                now_ms
            ],
        )?;
    }
    Ok(())
}

fn to_json<T: serde::Serialize>(value: &T) -> Result<String, StoreError> {
    serde_json::to_string(value).map_err(|error| StoreError::Serialization(error.to_string()))
}

fn from_json<T: DeserializeOwned>(value: &str) -> Result<T, StoreError> {
    serde_json::from_str(value).map_err(|error| StoreError::Serialization(error.to_string()))
}

fn from_db_enum<T: DeserializeOwned>(value: &str) -> Result<T, StoreError> {
    serde_json::from_value(serde_json::Value::String(value.to_owned()))
        .map_err(|error| StoreError::Serialization(error.to_string()))
}
