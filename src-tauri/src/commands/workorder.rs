//! Tauri boundary for the WorkOrder execution lane.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, State};
use uuid::Uuid;

use crate::workorder::{
    build_source_digests, create_draft, load_plan, record_source_snapshot, source_coverage, writer,
    AdvanceOutcome, BlockedItem, GateId, GateStatus, GoContext, GoOptions, PlanDraft,
    ReportEnvelope, SessionRole, SourceCoverage, SourceDigest, SourceSnapshotStatus, SpawnRequest,
    WorkItemId, WorkOrderId,
};
use crate::{test_profile, AppState};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkOrderIdResponse {
    pub work_order_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcesResponse {
    pub coverage: CoverageResponse,
    pub sources: Vec<SourceDigest>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageResponse {
    pub target: u32,
    pub acquired: u32,
    pub missing: u32,
    pub failed: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxStatusResponse {
    pub work_item_id: String,
    pub intent_kind: String,
    pub status: String,
    pub reason: Option<String>,
}

impl From<SourceCoverage> for CoverageResponse {
    fn from(value: SourceCoverage) -> Self {
        Self {
            target: value.target,
            acquired: value.acquired,
            missing: value.missing,
            failed: value.failed,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoResponse {
    pub sealed: String,
    pub spawn_request_id: Option<String>,
    pub coverage: CoverageResponse,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelResponse {
    pub deleted_draft: bool,
    pub stop_targets: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrySpawnResponse {
    pub spawn_request_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvanceResponse {
    pub dispatched: Vec<String>,
    pub blocked: Vec<BlockedItem>,
}

impl From<AdvanceOutcome> for AdvanceResponse {
    fn from(value: AdvanceOutcome) -> Self {
        Self {
            dispatched: value
                .dispatched
                .into_iter()
                .map(|work_item_id| work_item_id.as_str().to_owned())
                .collect(),
            blocked: value.blocked,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResultInput {
    pub session_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateResultInput {
    pub work_order_id: String,
    pub plan_version: u32,
    pub work_item_id: String,
    pub gate_id: String,
    pub status: GateStatus,
    pub evidence: Value,
}

/// WorkOrder plans predate the frontend's camelCase IPC convention. Convert
/// object keys at this one boundary, keeping the Stage 0 domain types unchanged.
fn decode_plan(mut value: Value) -> Result<PlanDraft, String> {
    camel_keys_to_snake(&mut value);
    serde_json::from_value(value).map_err(|error| format!("invalid WorkOrder plan: {error}"))
}

fn camel_keys_to_snake(value: &mut Value) {
    match value {
        Value::Array(values) => values.iter_mut().for_each(camel_keys_to_snake),
        Value::Object(values) => {
            let entries = std::mem::take(values)
                .into_iter()
                .map(|(key, mut child)| {
                    camel_keys_to_snake(&mut child);
                    (camel_to_snake(&key), child)
                })
                .collect();
            *values = entries;
        }
        _ => {}
    }
}

fn camel_to_snake(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    for character in value.chars() {
        if character.is_ascii_uppercase() {
            result.push('_');
            result.push(character.to_ascii_lowercase());
        } else {
            result.push(character);
        }
    }
    result
}

fn snake_keys_to_camel(value: &mut Value) {
    match value {
        Value::Array(values) => values.iter_mut().for_each(snake_keys_to_camel),
        Value::Object(values) => {
            let entries = std::mem::take(values)
                .into_iter()
                .map(|(key, mut child)| {
                    snake_keys_to_camel(&mut child);
                    (snake_to_camel(&key), child)
                })
                .collect();
            *values = entries;
        }
        _ => {}
    }
}

fn snake_to_camel(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut uppercase_next = false;
    for character in value.chars() {
        if character == '_' {
            uppercase_next = true;
        } else if uppercase_next {
            result.push(character.to_ascii_uppercase());
            uppercase_next = false;
        } else {
            result.push(character);
        }
    }
    result
}

fn now_ms() -> Result<i64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("system clock before Unix epoch: {error}"))?;
    i64::try_from(duration.as_millis()).map_err(|_| "current time exceeds i64 milliseconds".into())
}

fn database_path() -> Result<PathBuf, String> {
    crate::workorder::db_path().map_err(|error| error.to_string())
}

fn handoff_dir() -> Result<PathBuf, String> {
    Ok(test_profile::runtime_dir()
        .map_err(|error| error.to_string())?
        .join("workorder-handoffs"))
}

fn emit_spawn_requests(
    app: &tauri::AppHandle,
    conn: &mut rusqlite::Connection,
    requests: Vec<SpawnRequest>,
) -> Result<(), String> {
    for request in requests {
        if let Err(error) = app.emit("workorder://spawn-request", request.clone()) {
            let reason = format!("emit workorder spawn request: {error}");
            crate::workorder::requeue_spawn_request(conn, &request.request_id, &reason, now_ms()?)
                .map_err(|requeue_error| {
                    format!("{reason}; requeue spawn request: {requeue_error}")
                })?;
            return Err(reason);
        }
    }
    Ok(())
}

fn advance_current(
    app: &tauri::AppHandle,
    conn: &mut rusqlite::Connection,
    id: &WorkOrderId,
) -> Result<AdvanceResponse, String> {
    let outcome = crate::workorder::advance(conn, id, &handoff_dir()?, now_ms()?)
        .map_err(|error| error.to_string())?;
    emit_spawn_requests(app, conn, outcome.spawn_requests.clone())?;
    Ok(outcome.into())
}

fn source_digests_for_plan(
    state: &AppState,
    plan: &crate::workorder::PlanSnapshot,
) -> Vec<SourceDigest> {
    let ids = plan
        .bindings
        .iter()
        .filter(|binding| binding.roles.contains(&SessionRole::Source))
        .map(|binding| binding.logical_session_id.clone())
        .collect::<Vec<_>>();
    let mut digests = build_source_digests(&state.livebrief_service, &ids);
    for digest in &mut digests {
        digest.label = plan
            .bindings
            .iter()
            .find(|binding| binding.logical_session_id == digest.logical_session_id)
            .and_then(|binding| binding.label_snapshot.clone());
    }
    digests
}

fn load_current_plan(
    conn: &rusqlite::Connection,
    id: &WorkOrderId,
) -> Result<crate::workorder::PlanSnapshot, String> {
    let version: i64 = conn
        .query_row(
            "SELECT plan_version FROM work_orders WHERE id=?1",
            [id.as_str()],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let version =
        u32::try_from(version).map_err(|_| "WorkOrder plan version is invalid".to_string())?;
    load_plan(conn, id, version).map_err(|error| error.to_string())
}

fn outbox_statuses(
    conn: &rusqlite::Connection,
    id: &WorkOrderId,
    plan_version: u32,
) -> Result<Vec<OutboxStatusResponse>, String> {
    let mut statement = conn
        .prepare(
            "SELECT work_item_id, intent_kind, status, last_error FROM dispatch_outbox \
             WHERE work_order_id=?1 AND plan_version=?2 ORDER BY work_item_id, intent_kind",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![id.as_str(), i64::from(plan_version)], |row| {
            Ok(OutboxStatusResponse {
                work_item_id: row.get(0)?,
                intent_kind: row.get(1)?,
                status: row.get(2)?,
                reason: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn delete_draft_and_source_snapshots(
    transaction: &rusqlite::Transaction<'_>,
    id: &WorkOrderId,
) -> rusqlite::Result<()> {
    transaction.execute(
        "DELETE FROM source_snapshots WHERE work_order_id=?1",
        [id.as_str()],
    )?;
    transaction.execute("DELETE FROM work_orders WHERE id=?1", [id.as_str()])?;
    Ok(())
}

#[tauri::command(async)]
pub async fn workorder_create_draft(plan: Value) -> Result<WorkOrderIdResponse, String> {
    let plan = decode_plan(plan)?;
    let id =
        WorkOrderId::try_new(&Uuid::new_v4().to_string()).map_err(|error| error.to_string())?;
    let conn = writer(&database_path()?).map_err(|error| error.to_string())?;
    create_draft(&conn, &id, &plan, now_ms()?).map_err(|error| error.to_string())?;
    Ok(WorkOrderIdResponse {
        work_order_id: id.as_str().to_owned(),
    })
}

#[tauri::command(async)]
pub async fn workorder_refresh_sources(
    state: State<'_, AppState>,
    id: String,
) -> Result<SourcesResponse, String> {
    let id = WorkOrderId::try_new(&id).map_err(|error| error.to_string())?;
    let conn = writer(&database_path()?).map_err(|error| error.to_string())?;
    let plan = load_current_plan(&conn, &id)?;
    let digests = source_digests_for_plan(&state, &plan);
    let now = now_ms()?;
    for digest in &digests {
        let (status, event_id, reason) = if digest.acquired {
            (
                SourceSnapshotStatus::Acquired,
                digest.snapshot_event_id.as_ref(),
                None,
            )
        } else {
            (
                SourceSnapshotStatus::Failed,
                None,
                digest.failure_reason.as_deref(),
            )
        };
        record_source_snapshot(
            &conn,
            &id,
            plan.plan_version,
            &digest.logical_session_id,
            status,
            event_id,
            reason,
            now,
        )
        .map_err(|error| error.to_string())?;
    }
    let coverage =
        source_coverage(&conn, &id, plan.plan_version).map_err(|error| error.to_string())?;
    Ok(SourcesResponse {
        coverage: coverage.into(),
        sources: digests,
    })
}

#[tauri::command(async)]
pub async fn workorder_preview(
    state: State<'_, AppState>,
    id: String,
    cwd: Option<String>,
) -> Result<Value, String> {
    let id = WorkOrderId::try_new(&id).map_err(|error| error.to_string())?;
    let conn = crate::workorder::reader(&database_path()?).map_err(|error| error.to_string())?;
    let plan = load_current_plan(&conn, &id)?;
    let digests = source_digests_for_plan(&state, &plan);
    let coverage =
        source_coverage(&conn, &id, plan.plan_version).map_err(|error| error.to_string())?;
    let outbox = outbox_statuses(&conn, &id, plan.plan_version)?;
    let prompt =
        crate::workorder::render_integrator_prompt(&plan.goal, &digests, &plan.acceptance_criteria);
    let mut plan_value = serde_json::to_value(&plan).map_err(|error| error.to_string())?;
    snake_keys_to_camel(&mut plan_value);
    // The card promises "writes to its own worktree, never your branch", so the
    // preview has to show the very path GO would use. When the working
    // directory is not a repository we say so instead of inventing a path.
    let write_target = match cwd {
        Some(cwd) => match crate::workorder::resolve_repo_root(PathBuf::from(cwd)).await {
            Ok(repo_root) => {
                let worktree = crate::workorder::plan_for(&id, &repo_root);
                serde_json::json!({
                    "branch": worktree.branch,
                    "path": worktree.path.to_string_lossy(),
                })
            }
            Err(error) => serde_json::json!({ "unavailable": error.to_string() }),
        },
        None => Value::Null,
    };
    Ok(serde_json::json!({
        "plan": plan_value,
        "coverage": CoverageResponse::from(coverage),
        "outbox": outbox,
        "sources": digests,
        "integratorPrompt": prompt,
        "writeTarget": write_target,
    }))
}

#[tauri::command(async)]
pub async fn workorder_go(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    options: Option<GoOptions>,
) -> Result<GoResponse, String> {
    let id = WorkOrderId::try_new(&id).map_err(|error| error.to_string())?;
    let mut conn = writer(&database_path()?).map_err(|error| error.to_string())?;
    let options = options.unwrap_or_default();
    let cwd = options
        .cwd
        .clone()
        .ok_or_else(|| "GO needs the working directory of the project to integrate".to_string())?;
    let repo_root = crate::workorder::resolve_repo_root(PathBuf::from(cwd))
        .await
        .map_err(|error| error.to_string())?;
    let handoff_dir = handoff_dir()?;
    let mut context = GoContext {
        conn: &mut conn,
        repo_root,
        handoff_dir: handoff_dir.clone(),
        now_ms: now_ms()?,
    };
    let outcome = crate::workorder::go(&mut context, &state.livebrief_service, &id, options)
        .await
        .map_err(|error| error.to_string())?;
    drop(context);
    if let Some(request) = outcome.spawn_request {
        emit_spawn_requests(&app, &mut conn, vec![request])?;
    }
    let _ = advance_current(&app, &mut conn, &id)?;
    let sealed = match outcome.sealed {
        crate::workorder::SealOutcome::Sealed { .. } => "sealed",
        crate::workorder::SealOutcome::AlreadySealed { .. } => "alreadySealed",
    };
    Ok(GoResponse {
        sealed: sealed.into(),
        spawn_request_id: outcome.spawn_request_id,
        coverage: outcome.coverage.into(),
    })
}

#[tauri::command(async)]
pub async fn workorder_spawn_result(
    app: tauri::AppHandle,
    request_id: String,
    result: SpawnResultInput,
) -> Result<(), String> {
    let mut conn = writer(&database_path()?).map_err(|error| error.to_string())?;
    crate::workorder::record_spawn_result(
        &mut conn,
        &request_id,
        crate::workorder::SpawnResult {
            session_id: result.session_id,
            error: result.error,
        },
        now_ms()?,
    )
    .map_err(|error| error.to_string())?;
    let (work_order_id, _, _) =
        crate::workorder::parse_spawn_request_id(&request_id).map_err(|error| error.to_string())?;
    let id = WorkOrderId::try_new(&work_order_id).map_err(|error| error.to_string())?;
    advance_current(&app, &mut conn, &id)?;
    Ok(())
}

#[tauri::command(async)]
pub async fn workorder_retry_spawn(
    app: tauri::AppHandle,
    work_order_id: String,
) -> Result<RetrySpawnResponse, String> {
    let id = WorkOrderId::try_new(&work_order_id).map_err(|error| error.to_string())?;
    let mut conn = writer(&database_path()?).map_err(|error| error.to_string())?;
    let request = crate::workorder::retry_spawn(&mut conn, &id, now_ms()?)
        .map_err(|error| error.to_string())?;
    emit_spawn_requests(&app, &mut conn, vec![request.clone()])?;
    Ok(RetrySpawnResponse {
        spawn_request_id: request.request_id,
    })
}

#[tauri::command(async)]
pub async fn workorder_advance(
    app: tauri::AppHandle,
    id: String,
) -> Result<AdvanceResponse, String> {
    let id = WorkOrderId::try_new(&id).map_err(|error| error.to_string())?;
    let mut conn = writer(&database_path()?).map_err(|error| error.to_string())?;
    advance_current(&app, &mut conn, &id)
}

#[tauri::command(async)]
pub async fn workorder_record_report(
    app: tauri::AppHandle,
    mut envelope: Value,
) -> Result<AdvanceResponse, String> {
    camel_keys_to_snake(&mut envelope);
    let envelope: ReportEnvelope = serde_json::from_value(envelope)
        .map_err(|error| format!("invalid WorkOrder report envelope: {error}"))?;
    let mut conn = writer(&database_path()?).map_err(|error| error.to_string())?;
    crate::workorder::record_report(&conn, &envelope).map_err(|error| error.to_string())?;
    advance_current(&app, &mut conn, &envelope.work_order_id)
}

#[tauri::command(async)]
pub async fn workorder_record_gate_result(
    app: tauri::AppHandle,
    input: GateResultInput,
) -> Result<AdvanceResponse, String> {
    let id = WorkOrderId::try_new(&input.work_order_id).map_err(|error| error.to_string())?;
    let work_item_id =
        WorkItemId::try_new(&input.work_item_id).map_err(|error| error.to_string())?;
    let gate_id = GateId::try_new(&input.gate_id).map_err(|error| error.to_string())?;
    let mut conn = writer(&database_path()?).map_err(|error| error.to_string())?;
    crate::workorder::record_gate_result(
        &conn,
        &id,
        input.plan_version,
        &work_item_id,
        &gate_id,
        input.status,
        &input.evidence,
        now_ms()?,
    )
    .map_err(|error| error.to_string())?;
    advance_current(&app, &mut conn, &id)
}

#[tauri::command(async)]
pub async fn workorder_cancel(id: String) -> Result<CancelResponse, String> {
    let id = WorkOrderId::try_new(&id).map_err(|error| error.to_string())?;
    let mut conn = writer(&database_path()?).map_err(|error| error.to_string())?;
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let version: i64 = transaction
        .query_row(
            "SELECT plan_version FROM work_orders WHERE id=?1",
            [id.as_str()],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let sealed: Option<i64> = transaction
        .query_row(
            "SELECT sealed_at FROM work_order_versions WHERE work_order_id=?1 AND plan_version=?2",
            params![id.as_str(), version],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .flatten();
    if sealed.is_none() {
        delete_draft_and_source_snapshots(&transaction, &id).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(CancelResponse {
            deleted_draft: true,
            stop_targets: Vec::new(),
        });
    }
    let plan = load_plan(
        &transaction,
        &id,
        u32::try_from(version).map_err(|_| "invalid plan version".to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let stop_targets = plan
        .bindings
        .into_iter()
        .filter(|binding| binding.roles.contains(&SessionRole::Integrator))
        .map(|binding| binding.logical_session_id.as_str().to_owned())
        .collect();
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(CancelResponse {
        deleted_draft: false,
        stop_targets,
    })
}

#[tauri::command(async)]
pub async fn workorder_activate_version(id: String, plan_version: u32) -> Result<(), String> {
    let id = WorkOrderId::try_new(&id).map_err(|error| error.to_string())?;
    let mut conn = writer(&database_path()?).map_err(|error| error.to_string())?;
    let now = now_ms()?;
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let current: i64 = transaction
        .query_row(
            "SELECT plan_version FROM work_orders WHERE id=?1",
            [id.as_str()],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let sealed_current: Option<i64> = transaction
        .query_row(
            "SELECT sealed_at FROM work_order_versions WHERE work_order_id=?1 AND plan_version=?2",
            params![id.as_str(), current],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .flatten();
    let sealed_target: Option<i64> = transaction
        .query_row(
            "SELECT sealed_at FROM work_order_versions WHERE work_order_id=?1 AND plan_version=?2",
            params![id.as_str(), i64::from(plan_version)],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .flatten();
    if sealed_current.is_some() || sealed_target.is_some() {
        return Err("cannot activate a version after GO".into());
    }
    transaction
        .execute(
            "UPDATE work_order_versions SET superseded_at=?3 WHERE work_order_id=?1 AND plan_version=?2",
            params![id.as_str(), current, now],
        )
        .map_err(|error| error.to_string())?;
    let changed = transaction
        .execute(
            "UPDATE work_order_versions SET superseded_at=NULL WHERE work_order_id=?1 AND plan_version=?2",
            params![id.as_str(), i64::from(plan_version)],
        )
        .map_err(|error| error.to_string())?;
    if changed != 1 {
        return Err(format!(
            "WorkOrder plan version {plan_version} was not found"
        ));
    }
    transaction
        .execute(
            "UPDATE work_orders SET plan_version=?2, updated_at=?3 WHERE id=?1",
            params![id.as_str(), i64::from(plan_version), now],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camel_case_plan_wire_decodes_to_stage_zero_types() {
        let plan = decode_plan(serde_json::json!({
            "goal": "goal",
            "acceptanceCriteria": [{"id": "c", "description": "done"}],
            "bindings": [{"logicalSessionId": "integrator", "roles": ["integrator"], "labelSnapshot": null, "snapshotEventId": null}],
            "workItems": [{"id": "item", "objective": "run", "assignee": null, "dependencies": [], "expectedArtifacts": [], "writeScope": [], "gates": [], "required": true, "state": "pending"}],
            "budgets": {"maxNewPty": 1, "maxWorkItems": 1, "maxReplans": 1, "maxPackets": 1, "maxRoundtripsPerEdge": 1}
        }))
        .unwrap();
        assert_eq!(plan.bindings[0].logical_session_id.as_str(), "integrator");
        assert_eq!(plan.budgets.max_new_pty, 1);
    }

    #[test]
    fn cancelling_a_draft_deletes_its_unreferenced_source_snapshots() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE work_orders (\
                id TEXT PRIMARY KEY, goal TEXT NOT NULL, state TEXT NOT NULL, plan_version INTEGER NOT NULL, \
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_reason TEXT\
             );\
             CREATE TABLE source_snapshots (\
                work_order_id TEXT NOT NULL, plan_version INTEGER NOT NULL, logical_session_id TEXT NOT NULL, \
                status TEXT NOT NULL, snapshot_event_id TEXT, acquired_at INTEGER, failure_reason TEXT, \
                advanced_since_seal INTEGER NOT NULL DEFAULT 0\
             );",
        )
        .unwrap();
        let id = WorkOrderId::try_new("draft-order").unwrap();
        conn.execute(
            "INSERT INTO work_orders(id, goal, state, plan_version, created_at, updated_at) \
             VALUES (?1, 'draft', 'draft', 1, 1, 1)",
            [id.as_str()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO source_snapshots(work_order_id, plan_version, logical_session_id, status, advanced_since_seal) \
             VALUES (?1, 1, 'source-1', 'acquired', 0)",
            [id.as_str()],
        )
        .unwrap();
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        delete_draft_and_source_snapshots(&transaction, &id).unwrap();
        transaction.commit().unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM work_orders", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM source_snapshots", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
