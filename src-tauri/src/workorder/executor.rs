//! Side-effecting WorkOrder execution, kept separate from the Stage 0 store.
//!
//! This module only ever creates the single integrator tab request. It has no
//! PTY write/send dependency, so source sessions cannot receive instructions
//! through the WorkOrder executor.

use std::collections::BTreeMap;
use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::livebrief::LiveBriefService;

use super::store::transition_work_item_state;
use super::{
    build_source_digests, done_inputs, is_done, load_plan, record_source_snapshot,
    render_integrator_prompt, seal_plan, source_coverage, LogicalSessionId, PlanSnapshot,
    SealOptions, SealOutcome, SessionRole, SourceCoverage, SourceDigest, SourceSnapshotStatus,
    StoreError, WorkItemId, WorkOrderId,
};
use super::{ensure_worktree, plan_for, WorktreeError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoOptions {
    #[serde(default)]
    pub override_missing_sources: bool,
    #[serde(default = "default_agent_kind")]
    pub agent_kind: String,
    /// Directory the operator is actually working in. The repository that owns
    /// it is resolved at run time; there is no build-time fallback.
    #[serde(default)]
    pub cwd: Option<String>,
}

fn default_agent_kind() -> String {
    "codex".to_owned()
}

impl Default for GoOptions {
    fn default() -> Self {
        Self {
            override_missing_sources: false,
            agent_kind: default_agent_kind(),
            cwd: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    pub request_id: String,
    pub work_order_id: String,
    pub plan_version: u32,
    pub work_item_id: String,
    pub cwd: String,
    pub agent_kind: String,
    pub launch_env: std::collections::BTreeMap<String, String>,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoOutcome {
    pub sealed: SealOutcome,
    pub spawn_request_id: Option<String>,
    pub coverage: SourceCoverage,
    pub spawn_request: Option<SpawnRequest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResult {
    pub session_id: Option<String>,
    pub error: Option<String>,
}

pub struct GoContext<'a> {
    pub conn: &'a mut Connection,
    pub repo_root: PathBuf,
    pub handoff_dir: PathBuf,
    pub now_ms: i64,
}

#[derive(Debug)]
pub enum ExecutorError {
    Store(StoreError),
    Worktree(WorktreeError),
    Io(String),
    InvalidPlan(String),
    SpawnResult(String),
}

impl std::fmt::Display for ExecutorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(error) => error.fmt(formatter),
            Self::Worktree(error) => error.fmt(formatter),
            Self::Io(message) | Self::InvalidPlan(message) | Self::SpawnResult(message) => {
                formatter.write_str(message)
            }
        }
    }
}

impl std::error::Error for ExecutorError {}

impl From<StoreError> for ExecutorError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

impl From<WorktreeError> for ExecutorError {
    fn from(error: WorktreeError) -> Self {
        Self::Worktree(error)
    }
}

impl From<rusqlite::Error> for ExecutorError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Store(StoreError::Database(error.to_string()))
    }
}

/// Live entry point: source snapshots are refreshed before any prompt, branch,
/// worktree, seal, or launch request is created.
pub async fn go(
    ctx: &mut GoContext<'_>,
    service: &LiveBriefService,
    work_order_id: &WorkOrderId,
    opts: GoOptions,
) -> Result<GoOutcome, ExecutorError> {
    let snapshot = current_plan(ctx.conn, work_order_id)?;
    let ids = source_ids(&snapshot);
    let mut digests = build_source_digests(service, &ids);
    apply_binding_labels(&snapshot, &mut digests);
    go_with_digests(ctx, work_order_id, opts, digests).await
}

/// Testable execution core. `digests` must come from livebrief in production;
/// accepting them here keeps the side-effect tests independent of PTY metadata.
pub async fn go_with_digests(
    ctx: &mut GoContext<'_>,
    work_order_id: &WorkOrderId,
    opts: GoOptions,
    digests: Vec<SourceDigest>,
) -> Result<GoOutcome, ExecutorError> {
    let snapshot = current_plan(ctx.conn, work_order_id)?;
    if snapshot.sealed_at.is_some() {
        // A repeat click/restart never refreshes immutable source references or
        // creates another worktree. Asking the store returns the authoritative
        // AlreadySealed outcome without a second spawn request.
        let coverage = source_coverage(ctx.conn, work_order_id, snapshot.plan_version)?;
        let sealed = seal_plan(ctx.conn, work_order_id, SealOptions::default(), ctx.now_ms)?;
        return Ok(GoOutcome {
            sealed,
            spawn_request_id: None,
            coverage,
            spawn_request: None,
        });
    }
    record_digests(ctx.conn, &snapshot, &digests, ctx.now_ms)?;
    let coverage = source_coverage(ctx.conn, work_order_id, snapshot.plan_version)?;
    if (coverage.missing > 0 || coverage.failed > 0) && !opts.override_missing_sources {
        let missing = source_ids(&snapshot)
            .into_iter()
            .filter(|id| {
                !digests
                    .iter()
                    .any(|digest| digest.logical_session_id == *id && digest.acquired)
            })
            .collect();
        return Err(ExecutorError::Store(StoreError::SourcesNotReady {
            missing,
        }));
    }

    let integrator_item = integrator_spawn_item(&snapshot)?;

    let prompt = render_integrator_prompt(&snapshot.goal, &digests, &snapshot.acceptance_criteria);
    let handoff_path = write_handoff(
        &ctx.handoff_dir,
        work_order_id,
        snapshot.plan_version,
        &prompt,
    )?;

    // Worktree preparation is deliberately before the seal. A failure leaves
    // the plan unsealed and produces neither an outbox launch nor a PTY.
    let worktree = ensure_worktree(&plan_for(work_order_id, &ctx.repo_root)).await?;
    let sealed = seal_plan(
        ctx.conn,
        work_order_id,
        SealOptions {
            override_missing_sources: opts.override_missing_sources,
        },
        ctx.now_ms,
    )?;
    if matches!(sealed, SealOutcome::AlreadySealed { .. }) {
        return Ok(GoOutcome {
            sealed,
            spawn_request_id: None,
            coverage,
            spawn_request: None,
        });
    }

    let request_id =
        deterministic_request_id(work_order_id, snapshot.plan_version, &integrator_item);
    let mut launch_env = BTreeMap::new();
    launch_env.insert("MYCMUX_AGENT_KIND".to_owned(), opts.agent_kind.clone());
    launch_env.insert("MYCMUX_HANDOFF".to_owned(), opts.agent_kind.clone());
    launch_env.insert(
        "MYCMUX_HANDOFF_PROMPT_FILE".to_owned(),
        handoff_path.to_string_lossy().into_owned(),
    );
    let request = SpawnRequest {
        request_id: request_id.clone(),
        work_order_id: work_order_id.as_str().to_owned(),
        plan_version: snapshot.plan_version,
        work_item_id: integrator_item.as_str().to_owned(),
        cwd: worktree.to_string_lossy().into_owned(),
        agent_kind: opts.agent_kind,
        launch_env,
        label: format!("WorkOrder: {}", snapshot.goal),
    };
    mark_spawn_in_flight(
        ctx.conn,
        work_order_id,
        snapshot.plan_version,
        &integrator_item,
        &request,
        ctx.now_ms,
    )?;
    transition_work_item_state(
        ctx.conn,
        work_order_id,
        snapshot.plan_version,
        &integrator_item,
        super::WorkItemState::Dispatched,
        ctx.now_ms,
    )?;
    Ok(GoOutcome {
        sealed,
        spawn_request_id: Some(request_id),
        coverage,
        spawn_request: Some(request),
    })
}

pub fn deterministic_request_id(
    work_order_id: &WorkOrderId,
    plan_version: u32,
    work_item_id: &WorkItemId,
) -> String {
    format!(
        "{}:{}:{}:spawn",
        work_order_id.as_str(),
        plan_version,
        work_item_id.as_str()
    )
}

/// Stores a frontend acknowledgement. This has no PTY write path: the frontend
/// creates the one background tab, then reports the result here.
pub fn record_spawn_result(
    conn: &mut Connection,
    request_id: &str,
    result: SpawnResult,
    now_ms: i64,
) -> Result<(), ExecutorError> {
    let (work_order_id, plan_version, work_item_id) = parse_spawn_request_id(request_id)?;
    let order_id = WorkOrderId::try_new(&work_order_id).map_err(StoreError::from)?;
    let item_id = WorkItemId::try_new(&work_item_id).map_err(StoreError::from)?;
    let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let status: Option<String> = transaction
        .query_row(
            "SELECT status FROM dispatch_outbox WHERE work_order_id=?1 AND plan_version=?2 AND work_item_id=?3 AND intent_kind='spawn'",
            params![order_id.as_str(), i64::from(plan_version), item_id.as_str()],
            |row| row.get(0),
        )
        .optional()?;
    if status.as_deref() != Some("in_flight") {
        return Err(ExecutorError::SpawnResult(format!(
            "spawn request is not in flight: {request_id}"
        )));
    }
    if let Some(session_id) = result.session_id.filter(|value| !value.trim().is_empty()) {
        let snapshot = load_plan(&transaction, &order_id, plan_version)?;
        let item_is_integrator = snapshot.work_items.iter().any(|item| {
            item.id == item_id && item.assignee.is_none() && item.dependencies.is_empty()
        });
        if item_is_integrator {
            let placeholder = integrator_binding_id(&transaction, &order_id, plan_version)?;
            let changed = transaction.execute(
                "UPDATE session_bindings SET logical_session_id=?4 WHERE work_order_id=?1 AND plan_version=?2 AND logical_session_id=?3",
                params![order_id.as_str(), i64::from(plan_version), placeholder.as_str(), session_id],
            )?;
            if changed != 1 {
                return Err(ExecutorError::SpawnResult(
                    "integrator binding was not recorded".into(),
                ));
            }
        } else {
            let changed = transaction.execute(
                "UPDATE work_items SET assignee_logical_session_id=?4, updated_at=?5 \
                 WHERE work_order_id=?1 AND plan_version=?2 AND id=?3",
                params![
                    order_id.as_str(),
                    i64::from(plan_version),
                    item_id.as_str(),
                    session_id,
                    now_ms,
                ],
            )?;
            if changed != 1 {
                return Err(ExecutorError::SpawnResult(
                    "work item was not recorded".into(),
                ));
            }
        }
        let current_state: String = transaction.query_row(
            "SELECT state FROM work_items WHERE work_order_id=?1 AND plan_version=?2 AND id=?3",
            params![order_id.as_str(), i64::from(plan_version), item_id.as_str()],
            |row| row.get(0),
        )?;
        if current_state == super::WorkItemState::Ready.as_str() {
            transition_work_item_state(
                &transaction,
                &order_id,
                plan_version,
                &item_id,
                super::WorkItemState::Dispatched,
                now_ms,
            )?;
        }
        transition_work_item_state(
            &transaction,
            &order_id,
            plan_version,
            &item_id,
            super::WorkItemState::Running,
            now_ms,
        )?;
        transaction.execute(
            "UPDATE dispatch_outbox SET status='delivered', last_error=NULL, updated_at=?4 WHERE work_order_id=?1 AND plan_version=?2 AND work_item_id=?3 AND intent_kind='spawn'",
            params![order_id.as_str(), i64::from(plan_version), item_id.as_str(), now_ms],
        )?;
    } else {
        let reason = result
            .error
            .unwrap_or_else(|| "frontend did not return a session id".into());
        transaction.execute(
            "UPDATE dispatch_outbox SET status='failed', last_error=?4, updated_at=?5 WHERE work_order_id=?1 AND plan_version=?2 AND work_item_id=?3 AND intent_kind='spawn'",
            params![order_id.as_str(), i64::from(plan_version), item_id.as_str(), reason, now_ms],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

/// Reissue the sealed integrator launch without refreshing sources, resealing
/// the plan, or changing its version. The complete original request is kept in
/// the outbox so retry never needs to infer a worktree or launch target.
pub fn retry_spawn(
    conn: &mut Connection,
    work_order_id: &WorkOrderId,
    now_ms: i64,
) -> Result<SpawnRequest, ExecutorError> {
    let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let snapshot = current_plan(&transaction, work_order_id)?;
    if snapshot.sealed_at.is_none() {
        return Err(ExecutorError::InvalidPlan(
            "cannot retry an unsealed WorkOrder".into(),
        ));
    }
    let item_id = integrator_spawn_item(&snapshot)?;
    let (status, payload): (String, String) = transaction
        .query_row(
            "SELECT status, payload_json FROM dispatch_outbox \
             WHERE work_order_id=?1 AND plan_version=?2 AND work_item_id=?3 AND intent_kind='spawn'",
            params![work_order_id.as_str(), i64::from(snapshot.plan_version), item_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| ExecutorError::InvalidPlan("integrator spawn request is missing".into()))?;
    if !matches!(status.as_str(), "pending" | "in_flight" | "failed") {
        return Err(ExecutorError::InvalidPlan(format!(
            "integrator spawn request cannot retry from {status}"
        )));
    }
    let request: SpawnRequest = serde_json::from_str(&payload).map_err(|error| {
        ExecutorError::InvalidPlan(format!("stored spawn request is invalid: {error}"))
    })?;
    let expected_request_id =
        deterministic_request_id(work_order_id, snapshot.plan_version, &item_id);
    if request.request_id != expected_request_id
        || request.work_order_id != work_order_id.as_str()
        || request.plan_version != snapshot.plan_version
        || request.work_item_id != item_id.as_str()
    {
        return Err(ExecutorError::InvalidPlan(
            "stored spawn request does not match its outbox row".into(),
        ));
    }

    // Leave a recoverable pending record before claiming it for this emit. The
    // two updates stay in one transaction, so no other caller can interleave.
    transaction.execute(
        "UPDATE dispatch_outbox SET status='pending', last_error=NULL, updated_at=?4 \
         WHERE work_order_id=?1 AND plan_version=?2 AND work_item_id=?3 AND intent_kind='spawn'",
        params![
            work_order_id.as_str(),
            i64::from(snapshot.plan_version),
            item_id.as_str(),
            now_ms
        ],
    )?;
    let changed = transaction.execute(
        "UPDATE dispatch_outbox SET status='in_flight', attempts=attempts+1, last_error=NULL, updated_at=?4 \
         WHERE work_order_id=?1 AND plan_version=?2 AND work_item_id=?3 AND intent_kind='spawn' AND status='pending'",
        params![work_order_id.as_str(), i64::from(snapshot.plan_version), item_id.as_str(), now_ms],
    )?;
    if changed != 1 {
        return Err(ExecutorError::InvalidPlan(
            "expected exactly one pending integrator spawn request".into(),
        ));
    }
    transaction.commit()?;
    Ok(request)
}

/// Preserve an undelivered launch as pending when the application event could
/// not be emitted. This does not call the frontend or alter the sealed plan.
pub fn requeue_spawn_request(
    conn: &mut Connection,
    request_id: &str,
    reason: &str,
    now_ms: i64,
) -> Result<(), ExecutorError> {
    let (work_order_id, plan_version, work_item_id) = parse_spawn_request_id(request_id)?;
    let order_id = WorkOrderId::try_new(&work_order_id).map_err(StoreError::from)?;
    let item_id = WorkItemId::try_new(&work_item_id).map_err(StoreError::from)?;
    let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let changed = transaction.execute(
        "UPDATE dispatch_outbox SET status='pending', last_error=?4, updated_at=?5 \
         WHERE work_order_id=?1 AND plan_version=?2 AND work_item_id=?3 AND intent_kind='spawn' AND status='in_flight'",
        params![order_id.as_str(), i64::from(plan_version), item_id.as_str(), reason, now_ms],
    )?;
    if changed != 1 {
        return Err(ExecutorError::SpawnResult(
            "expected exactly one in-flight integrator spawn request to requeue".into(),
        ));
    }
    transaction.commit()?;
    Ok(())
}

fn current_plan(
    conn: &Connection,
    work_order_id: &WorkOrderId,
) -> Result<PlanSnapshot, ExecutorError> {
    let version: i64 = conn.query_row(
        "SELECT plan_version FROM work_orders WHERE id=?1",
        [work_order_id.as_str()],
        |row| row.get(0),
    )?;
    let version = u32::try_from(version)
        .map_err(|_| ExecutorError::InvalidPlan("plan version is outside u32".into()))?;
    Ok(load_plan(conn, work_order_id, version)?)
}

fn source_ids(snapshot: &PlanSnapshot) -> Vec<LogicalSessionId> {
    snapshot
        .bindings
        .iter()
        .filter(|binding| binding.roles.contains(&SessionRole::Source))
        .map(|binding| binding.logical_session_id.clone())
        .collect()
}

fn apply_binding_labels(snapshot: &PlanSnapshot, digests: &mut [SourceDigest]) {
    for digest in digests {
        digest.label = snapshot
            .bindings
            .iter()
            .find(|binding| binding.logical_session_id == digest.logical_session_id)
            .and_then(|binding| binding.label_snapshot.clone());
    }
}

fn record_digests(
    conn: &Connection,
    snapshot: &PlanSnapshot,
    digests: &[SourceDigest],
    now_ms: i64,
) -> Result<(), ExecutorError> {
    for source_id in source_ids(snapshot) {
        let digest = digests
            .iter()
            .find(|digest| digest.logical_session_id == source_id);
        let (status, event_id, reason) = match digest {
            Some(digest) if digest.acquired => (
                SourceSnapshotStatus::Acquired,
                digest.snapshot_event_id.as_ref(),
                None,
            ),
            Some(digest) => (
                SourceSnapshotStatus::Failed,
                None,
                digest.failure_reason.as_deref(),
            ),
            None => (
                SourceSnapshotStatus::Failed,
                None,
                Some("no source digest returned"),
            ),
        };
        record_source_snapshot(
            conn,
            &snapshot.id,
            snapshot.plan_version,
            &source_id,
            status,
            event_id,
            reason,
            now_ms,
        )?;
    }
    Ok(())
}

fn write_handoff(
    handoff_dir: &std::path::Path,
    work_order_id: &WorkOrderId,
    plan_version: u32,
    prompt: &str,
) -> Result<PathBuf, ExecutorError> {
    std::fs::create_dir_all(handoff_dir).map_err(|error| {
        ExecutorError::Io(format!("create workorder handoff directory: {error}"))
    })?;
    let path = handoff_dir.join(format!(
        "workorder-{}-v{plan_version}.md",
        work_order_id.as_str()
    ));
    std::fs::write(&path, prompt)
        .map_err(|error| ExecutorError::Io(format!("write workorder handoff: {error}")))?;
    Ok(path)
}

pub(crate) fn write_item_handoff(
    handoff_dir: &std::path::Path,
    work_order_id: &WorkOrderId,
    plan_version: u32,
    work_item_id: &WorkItemId,
    prompt: &str,
) -> Result<PathBuf, ExecutorError> {
    std::fs::create_dir_all(handoff_dir).map_err(|error| {
        ExecutorError::Io(format!("create workorder handoff directory: {error}"))
    })?;
    let safe_item_id = work_item_id
        .as_str()
        .chars()
        .map(|character| match character {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => character,
            _ => '_',
        })
        .collect::<String>();
    let path = handoff_dir.join(format!(
        "workorder-{}-v{plan_version}-{safe_item_id}.md",
        work_order_id.as_str()
    ));
    std::fs::write(&path, prompt)
        .map_err(|error| ExecutorError::Io(format!("write workorder item handoff: {error}")))?;
    Ok(path)
}

pub(crate) fn spawn_request_template(
    conn: &Connection,
    work_order_id: &WorkOrderId,
    plan_version: u32,
) -> Result<SpawnRequest, ExecutorError> {
    let payload: Option<String> = conn
        .query_row(
            "SELECT payload_json FROM dispatch_outbox \
             WHERE work_order_id=?1 AND plan_version=?2 AND intent_kind='spawn' \
             ORDER BY created_at, work_item_id LIMIT 1",
            params![work_order_id.as_str(), i64::from(plan_version)],
            |row| row.get(0),
        )
        .optional()?;
    let payload = payload.ok_or_else(|| {
        ExecutorError::InvalidPlan(
            "no prior spawn request provides the sealed launch target".into(),
        )
    })?;
    serde_json::from_str(&payload).map_err(|error| {
        ExecutorError::InvalidPlan(format!("stored spawn request is invalid: {error}"))
    })
}

fn integrator_spawn_item(snapshot: &PlanSnapshot) -> Result<WorkItemId, ExecutorError> {
    let items = snapshot
        .work_items
        .iter()
        .filter(|item| item.assignee.is_none() && item.dependencies.is_empty())
        .map(|item| item.id.clone())
        .collect::<Vec<_>>();
    match items.as_slice() {
        [item] => Ok(item.clone()),
        [] => Err(ExecutorError::InvalidPlan(
            "plan has no unassigned integrator spawn item".into(),
        )),
        _ => Err(ExecutorError::InvalidPlan(
            "plan has more than one unassigned integrator spawn item".into(),
        )),
    }
}

pub(crate) fn mark_spawn_in_flight(
    conn: &Connection,
    work_order_id: &WorkOrderId,
    plan_version: u32,
    item_id: &WorkItemId,
    request: &SpawnRequest,
    now_ms: i64,
) -> Result<(), ExecutorError> {
    let payload = serde_json::to_string(request)
        .map_err(|error| ExecutorError::InvalidPlan(format!("serialize spawn request: {error}")))?;
    let changed = conn.execute(
        "UPDATE dispatch_outbox SET payload_json=?4, status='in_flight', attempts=attempts+1, last_error=NULL, updated_at=?5 \
         WHERE work_order_id=?1 AND plan_version=?2 AND work_item_id=?3 AND intent_kind='spawn' AND status='pending'",
        params![work_order_id.as_str(), i64::from(plan_version), item_id.as_str(), payload, now_ms],
    )?;
    if changed != 1 {
        return Err(ExecutorError::InvalidPlan(
            "expected exactly one pending spawn request".into(),
        ));
    }
    Ok(())
}

pub(crate) fn parse_spawn_request_id(
    request_id: &str,
) -> Result<(String, u32, String), ExecutorError> {
    let mut parts = request_id.rsplitn(4, ':');
    let intent = parts.next();
    let work_item_id = parts.next();
    let plan_version = parts.next();
    let work_order_id = parts.next();
    if intent != Some("spawn") {
        return Err(ExecutorError::SpawnResult(format!(
            "invalid spawn request id: {request_id}"
        )));
    }
    let plan_version = plan_version
        .ok_or_else(|| {
            ExecutorError::SpawnResult(format!("invalid spawn request id: {request_id}"))
        })?
        .parse::<u32>()
        .map_err(|_| {
            ExecutorError::SpawnResult(format!("invalid spawn request id: {request_id}"))
        })?;
    Ok((
        work_order_id
            .ok_or_else(|| {
                ExecutorError::SpawnResult(format!("invalid spawn request id: {request_id}"))
            })?
            .to_owned(),
        plan_version,
        work_item_id
            .ok_or_else(|| {
                ExecutorError::SpawnResult(format!("invalid spawn request id: {request_id}"))
            })?
            .to_owned(),
    ))
}

fn integrator_binding_id(
    conn: &Connection,
    work_order_id: &WorkOrderId,
    plan_version: u32,
) -> Result<LogicalSessionId, ExecutorError> {
    let snapshot = load_plan(conn, work_order_id, plan_version)?;
    snapshot
        .bindings
        .into_iter()
        .find(|binding| binding.roles.contains(&SessionRole::Integrator))
        .map(|binding| binding.logical_session_id)
        .ok_or_else(|| ExecutorError::SpawnResult("integrator binding is missing".into()))
}

pub fn is_machine_done(conn: &Connection, id: &WorkOrderId) -> Result<bool, ExecutorError> {
    let snapshot = current_plan(conn, id)?;
    Ok(is_done(&done_inputs(conn, id, snapshot.plan_version)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workorder::{
        create_draft, record_report, schema, Criterion, Gate, LogicalSessionId, PathScope,
        PlanDraft, ReportEnvelope, ReportEnvelopeId, ReportOutcome, SessionBinding, WorkItem,
        WorkItemState, WorkOrderState,
    };
    use std::process::Command;
    use tempfile::tempdir;

    fn id(value: &str) -> LogicalSessionId {
        LogicalSessionId::try_new(value).unwrap()
    }

    fn plan() -> PlanDraft {
        PlanDraft {
            goal: "integrate sources".into(),
            acceptance_criteria: vec![Criterion {
                id: "c1".into(),
                description: "pass".into(),
            }],
            bindings: vec![
                SessionBinding {
                    logical_session_id: id("source-1"),
                    roles: [SessionRole::Source].into_iter().collect(),
                    label_snapshot: Some("Source A".into()),
                    snapshot_event_id: None,
                },
                SessionBinding {
                    logical_session_id: id("integrator-pending"),
                    roles: [SessionRole::Integrator].into_iter().collect(),
                    label_snapshot: Some("Integrator".into()),
                    snapshot_event_id: None,
                },
            ],
            work_items: vec![WorkItem {
                id: WorkItemId::try_new("integrate").unwrap(),
                objective: "integrate".into(),
                assignee: None,
                dependencies: Vec::new(),
                expected_artifacts: Vec::new(),
                write_scope: vec![PathScope {
                    path_prefix: ".".into(),
                    worktree: None,
                    branch: None,
                }],
                gates: vec![Gate {
                    id: super::super::GateId::try_new("gate").unwrap(),
                    description: "pass".into(),
                }],
                required: true,
                state: WorkItemState::Pending,
            }],
            budgets: Default::default(),
        }
    }

    fn source(acquired: bool) -> SourceDigest {
        SourceDigest {
            logical_session_id: id("source-1"),
            label: Some("Source A".into()),
            snapshot_event_id: None,
            current_task: Some("task".into()),
            latest_instruction: None,
            activity: None,
            open_questions: Vec::new(),
            acquired,
            failure_reason: (!acquired).then(|| "unavailable".into()),
        }
    }

    fn setup() -> (Connection, WorkOrderId) {
        let conn = Connection::open_in_memory().unwrap();
        schema::init(&conn).unwrap();
        let order = WorkOrderId::try_new("12345678-order").unwrap();
        create_draft(&conn, &order, &plan(), 1).unwrap();
        (conn, order)
    }

    fn initialize_repository(root: &std::path::Path) {
        std::fs::create_dir_all(root).unwrap();
        assert!(Command::new("git")
            .current_dir(root)
            .args(["init"])
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .current_dir(root)
            .args([
                "-c",
                "user.name=test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "init",
            ])
            .status()
            .unwrap()
            .success());
    }

    #[tokio::test]
    async fn missing_required_source_has_no_seal_outbox_or_worktree() {
        let (mut conn, order) = setup();
        let temp = tempdir().unwrap();
        let root = temp.path().join("repo");
        initialize_repository(&root);
        let handoff_dir = temp.path().join("handoffs");
        let planned = plan_for(&order, &root).path;
        let mut ctx = GoContext {
            conn: &mut conn,
            repo_root: root,
            handoff_dir: handoff_dir.clone(),
            now_ms: 2,
        };
        let error = go_with_digests(&mut ctx, &order, GoOptions::default(), vec![source(false)])
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            ExecutorError::Store(StoreError::SourcesNotReady { missing }) if missing == vec![id("source-1")]
        ));
        assert_eq!(
            ctx.conn
                .query_row(
                    "SELECT state FROM work_orders WHERE id=?1",
                    [order.as_str()],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            WorkOrderState::Draft.as_str()
        );
        assert_eq!(
            ctx.conn
                .query_row("SELECT COUNT(*) FROM dispatch_outbox", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            ctx.conn
                .query_row(
                    "SELECT sealed_at IS NULL FROM work_order_versions",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            ctx.conn
                .query_row("SELECT status FROM source_snapshots", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "failed"
        );
        assert!(!planned.exists());
        assert!(!handoff_dir.join("workorder-12345678-order-v1.md").exists());
    }

    #[tokio::test]
    async fn worktree_failure_does_not_seal_or_emit_request() {
        let (mut conn, order) = setup();
        let temp = tempdir().unwrap();
        let mut ctx = GoContext {
            conn: &mut conn,
            repo_root: temp.path().join("not-a-repo"),
            handoff_dir: temp.path().join("handoffs"),
            now_ms: 2,
        };
        assert!(
            go_with_digests(&mut ctx, &order, GoOptions::default(), vec![source(true)])
                .await
                .is_err()
        );
        assert_eq!(
            ctx.conn
                .query_row("SELECT COUNT(*) FROM dispatch_outbox", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            ctx.conn
                .query_row(
                    "SELECT sealed_at IS NULL FROM work_order_versions",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn request_id_is_deterministic() {
        let order = WorkOrderId::try_new("12345678-order").unwrap();
        let item = WorkItemId::try_new("integrate").unwrap();
        let request_id = deterministic_request_id(&order, 1, &item);
        assert_eq!(request_id, "12345678-order:1:integrate:spawn");
        assert_eq!(
            parse_spawn_request_id(&request_id).unwrap(),
            ("12345678-order".into(), 1, "integrate".into())
        );
        assert_ne!(request_id, deterministic_request_id(&order, 2, &item));
        assert_ne!(
            request_id,
            deterministic_request_id(&WorkOrderId::try_new("other-order").unwrap(), 1, &item)
        );
        assert_ne!(
            request_id,
            deterministic_request_id(&order, 1, &WorkItemId::try_new("other-item").unwrap())
        );
    }

    #[tokio::test]
    async fn go_seals_the_source_event_boundary_in_bindings_and_snapshots() {
        let (mut conn, order) = setup();
        let temp = tempdir().unwrap();
        let root = temp.path().join("repo");
        initialize_repository(&root);
        let mut digest = source(true);
        digest.snapshot_event_id = Some(super::super::EventId::try_new("source-1:42").unwrap());
        let mut ctx = GoContext {
            conn: &mut conn,
            repo_root: root,
            handoff_dir: temp.path().join("handoffs"),
            now_ms: 2,
        };
        go_with_digests(&mut ctx, &order, GoOptions::default(), vec![digest])
            .await
            .unwrap();
        let binding_event: Option<String> = ctx.conn.query_row(
            "SELECT snapshot_event_id FROM session_bindings WHERE logical_session_id='source-1'",
            [],
            |row| row.get(0),
        ).unwrap();
        let snapshot_event: Option<String> = ctx.conn.query_row(
            "SELECT snapshot_event_id FROM source_snapshots WHERE logical_session_id='source-1'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(binding_event.as_deref(), Some("source-1:42"));
        assert_eq!(snapshot_event, binding_event);
    }

    #[tokio::test]
    async fn double_go_emits_one_integrator_spawn_request() {
        let (mut conn, order) = setup();
        let temp = tempdir().unwrap();
        let root = temp.path().join("repo");
        initialize_repository(&root);
        let request_id = {
            let mut ctx = GoContext {
                conn: &mut conn,
                repo_root: root.clone(),
                handoff_dir: temp.path().join("handoffs"),
                now_ms: 2,
            };
            let first = go_with_digests(&mut ctx, &order, GoOptions::default(), vec![source(true)])
                .await
                .unwrap();
            first.spawn_request_id.unwrap()
        };
        let mut ctx = GoContext {
            conn: &mut conn,
            repo_root: root,
            handoff_dir: temp.path().join("handoffs"),
            now_ms: 3,
        };
        let second = go_with_digests(&mut ctx, &order, GoOptions::default(), vec![source(true)])
            .await
            .unwrap();
        assert!(matches!(second.sealed, SealOutcome::AlreadySealed { .. }));
        assert_eq!(second.spawn_request_id, None);
        assert_eq!(
            ctx.conn
                .query_row("SELECT COUNT(*) FROM dispatch_outbox", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(request_id, "12345678-order:1:integrate:spawn");
    }

    #[tokio::test]
    async fn spawn_result_records_delivery_or_failure() {
        let (mut conn, order) = setup();
        let temp = tempdir().unwrap();
        let root = temp.path().join("repo");
        initialize_repository(&root);
        let request_id = {
            let mut ctx = GoContext {
                conn: &mut conn,
                repo_root: root,
                handoff_dir: temp.path().join("handoffs"),
                now_ms: 2,
            };
            go_with_digests(&mut ctx, &order, GoOptions::default(), vec![source(true)])
                .await
                .unwrap()
                .spawn_request_id
                .unwrap()
        };
        record_spawn_result(
            &mut conn,
            &request_id,
            SpawnResult {
                session_id: Some("integrator-live".into()),
                error: None,
            },
            3,
        )
        .unwrap();
        assert_eq!(
            conn.query_row("SELECT status FROM dispatch_outbox", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            "delivered"
        );
        assert_eq!(
            conn.query_row("SELECT logical_session_id FROM session_bindings WHERE roles_json LIKE '%integrator%'", [], |row| row.get::<_, String>(0)).unwrap(),
            "integrator-live"
        );

        let (mut failed_conn, failed_order) = setup();
        let failed_temp = tempdir().unwrap();
        let failed_root = failed_temp.path().join("repo");
        initialize_repository(&failed_root);
        let failed_request_id = {
            let mut ctx = GoContext {
                conn: &mut failed_conn,
                repo_root: failed_root,
                handoff_dir: failed_temp.path().join("handoffs"),
                now_ms: 2,
            };
            go_with_digests(
                &mut ctx,
                &failed_order,
                GoOptions::default(),
                vec![source(true)],
            )
            .await
            .unwrap()
            .spawn_request_id
            .unwrap()
        };
        record_spawn_result(
            &mut failed_conn,
            &failed_request_id,
            SpawnResult {
                session_id: None,
                error: Some("frontend failed".into()),
            },
            3,
        )
        .unwrap();
        let row: (String, String) = failed_conn
            .query_row(
                "SELECT status, last_error FROM dispatch_outbox",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(row, ("failed".into(), "frontend failed".into()));
    }

    #[tokio::test]
    async fn retry_spawn_reclaims_in_flight_and_failed_requests_without_resealing() {
        let (mut conn, order) = setup();
        let temp = tempdir().unwrap();
        let root = temp.path().join("repo");
        initialize_repository(&root);
        let initial = {
            let mut ctx = GoContext {
                conn: &mut conn,
                repo_root: root,
                handoff_dir: temp.path().join("handoffs"),
                now_ms: 2,
            };
            go_with_digests(&mut ctx, &order, GoOptions::default(), vec![source(true)])
                .await
                .unwrap()
                .spawn_request
                .unwrap()
        };
        assert_eq!(retry_spawn(&mut conn, &order, 3).unwrap(), initial);
        record_spawn_result(
            &mut conn,
            &initial.request_id,
            SpawnResult {
                session_id: None,
                error: Some("frontend failed".into()),
            },
            4,
        )
        .unwrap();
        assert_eq!(retry_spawn(&mut conn, &order, 5).unwrap(), initial);
        let row: (String, i64, Option<String>, i64) = conn
            .query_row(
                "SELECT status, attempts, last_error, plan_version FROM dispatch_outbox",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(row, ("in_flight".into(), 3, None, 1));
    }

    #[tokio::test]
    async fn requeue_spawn_request_preserves_a_recoverable_pending_record() {
        let (mut conn, order) = setup();
        let temp = tempdir().unwrap();
        let root = temp.path().join("repo");
        initialize_repository(&root);
        let request_id = {
            let mut ctx = GoContext {
                conn: &mut conn,
                repo_root: root,
                handoff_dir: temp.path().join("handoffs"),
                now_ms: 2,
            };
            go_with_digests(&mut ctx, &order, GoOptions::default(), vec![source(true)])
                .await
                .unwrap()
                .spawn_request_id
                .unwrap()
        };
        requeue_spawn_request(&mut conn, &request_id, "event emission failed", 3).unwrap();
        let row: (String, i64, String) = conn
            .query_row(
                "SELECT status, attempts, last_error FROM dispatch_outbox",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, ("pending".into(), 1, "event emission failed".into()));
    }

    #[test]
    fn executor_has_no_source_session_send_path() {
        // GoContext contains only storage, paths, and time. This source-level
        // guard catches direct imports and super-module reexports of the PTY
        // write primitives that would violate the source-session boundary.
        let source = include_str!("executor.rs");
        for forbidden in [
            "send_text",
            "write_to_session",
            "send_intervention",
            "send_keys",
            "write_pty",
        ] {
            let call = format!("{forbidden}(");
            assert!(
                !source.contains(&call),
                "executor must not call {forbidden}"
            );
        }
    }

    #[test]
    fn unverified_integrator_claim_does_not_complete_workorder() {
        let (conn, order) = setup();
        let claim = ReportEnvelope {
            id: ReportEnvelopeId::try_new("claim").unwrap(),
            work_order_id: order.clone(),
            plan_version: 1,
            work_item_id: WorkItemId::try_new("integrate").unwrap(),
            logical_session_id: id("integrator-pending"),
            terminal: false,
            outcome: ReportOutcome::Progress,
            verified_facts: Vec::new(),
            unverified_claims: vec![serde_json::json!("完了しました")],
            open_questions: Vec::new(),
            evidence_event_ids: Vec::new(),
            received_at: 2,
        };
        record_report(&conn, &claim).unwrap();
        assert!(!is_machine_done(&conn, &order).unwrap());
    }
}
