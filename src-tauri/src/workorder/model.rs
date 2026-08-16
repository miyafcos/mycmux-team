//! Pure WorkOrder domain types and validation.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde::{Deserialize, Serialize};

macro_rules! id_newtype {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            pub fn try_new(value: &str) -> Result<Self, ModelError> {
                if value.trim().is_empty() {
                    return Err(ModelError::EmptyIdentifier(stringify!($name)));
                }
                Ok(Self(value.to_owned()))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str(&self.0)
            }
        }
    };
}

id_newtype!(WorkOrderId);
id_newtype!(WorkItemId);
id_newtype!(LogicalSessionId);
id_newtype!(EventId);
id_newtype!(ReportEnvelopeId);
id_newtype!(GateId);
id_newtype!(DecisionId);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ModelError {
    EmptyIdentifier(&'static str),
    InvalidWorkOrderTransition {
        from: WorkOrderState,
        to: WorkOrderState,
    },
    InvalidWorkItemTransition {
        from: WorkItemState,
        to: WorkItemState,
    },
}

impl std::fmt::Display for ModelError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyIdentifier(name) => write!(formatter, "{name} must not be empty"),
            Self::InvalidWorkOrderTransition { from, to } => {
                write!(formatter, "invalid WorkOrder transition {from:?} -> {to:?}")
            }
            Self::InvalidWorkItemTransition { from, to } => {
                write!(formatter, "invalid WorkItem transition {from:?} -> {to:?}")
            }
        }
    }
}

impl std::error::Error for ModelError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionRole {
    Source,
    Worker,
    Integrator,
    Reviewer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkOrderState {
    Draft,
    AwaitingGo,
    Running,
    NeedsDecision,
    Integrating,
    Verifying,
    Done,
    Failed,
    Cancelled,
}

impl WorkOrderState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::AwaitingGo => "awaiting_go",
            Self::Running => "running",
            Self::NeedsDecision => "needs_decision",
            Self::Integrating => "integrating",
            Self::Verifying => "verifying",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemState {
    Pending,
    Ready,
    Dispatched,
    Running,
    Reported,
    Verified,
    Failed,
    Cancelled,
}

impl WorkItemState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Ready => "ready",
            Self::Dispatched => "dispatched",
            Self::Running => "running",
            Self::Reported => "reported",
            Self::Verified => "verified",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Verified | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportOutcome {
    Succeeded,
    Failed,
    Blocked,
    Progress,
}

impl ReportOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Blocked => "blocked",
            Self::Progress => "progress",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GateStatus {
    Pending,
    Pass,
    Fail,
}

impl GateStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Pass => "pass",
            Self::Fail => "fail",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoordinationBudget {
    pub max_new_pty: u32,
    pub max_work_items: u32,
    pub max_replans: u32,
    pub max_packets: u32,
    pub max_roundtrips_per_edge: u32,
}

impl Default for CoordinationBudget {
    fn default() -> Self {
        Self {
            max_new_pty: 4,
            max_work_items: 8,
            max_replans: 2,
            max_packets: 12,
            max_roundtrips_per_edge: 1,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionBinding {
    pub logical_session_id: LogicalSessionId,
    pub roles: BTreeSet<SessionRole>,
    pub label_snapshot: Option<String>,
    /// The livebrief `"{native_id}:{index}"` identifier, preserved verbatim.
    pub snapshot_event_id: Option<EventId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Criterion {
    pub id: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactSpec {
    pub path: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PathScope {
    pub path_prefix: String,
    pub worktree: Option<String>,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Gate {
    pub id: GateId,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkItem {
    pub id: WorkItemId,
    pub objective: String,
    pub assignee: Option<LogicalSessionId>,
    pub dependencies: Vec<WorkItemId>,
    pub expected_artifacts: Vec<ArtifactSpec>,
    pub write_scope: Vec<PathScope>,
    pub gates: Vec<Gate>,
    pub required: bool,
    pub state: WorkItemState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanDraft {
    pub goal: String,
    pub acceptance_criteria: Vec<Criterion>,
    pub bindings: Vec<SessionBinding>,
    pub work_items: Vec<WorkItem>,
    pub budgets: CoordinationBudget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkOrder {
    pub id: WorkOrderId,
    pub goal: String,
    pub acceptance_criteria: Vec<Criterion>,
    pub plan_version: u32,
    pub state: WorkOrderState,
    pub bindings: Vec<SessionBinding>,
    pub work_items: Vec<WorkItem>,
    pub budgets: CoordinationBudget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanSnapshot {
    pub id: WorkOrderId,
    pub plan_version: u32,
    pub goal: String,
    pub acceptance_criteria: Vec<Criterion>,
    pub budgets: CoordinationBudget,
    pub sealed_at: Option<i64>,
    pub bindings: Vec<SessionBinding>,
    pub work_items: Vec<WorkItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReportEnvelope {
    pub id: ReportEnvelopeId,
    pub work_order_id: WorkOrderId,
    pub plan_version: u32,
    pub work_item_id: WorkItemId,
    pub logical_session_id: LogicalSessionId,
    pub terminal: bool,
    pub outcome: ReportOutcome,
    pub verified_facts: Vec<serde_json::Value>,
    pub unverified_claims: Vec<serde_json::Value>,
    pub open_questions: Vec<String>,
    pub evidence_event_ids: Vec<EventId>,
    pub received_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionKind {
    Conflict,
    Question,
    BudgetExceeded,
}

impl DecisionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Conflict => "conflict",
            Self::Question => "question",
            Self::BudgetExceeded => "budget_exceeded",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecisionItem {
    pub id: DecisionId,
    pub work_order_id: WorkOrderId,
    pub plan_version: u32,
    pub kind: DecisionKind,
    pub summary: String,
    pub evidence: serde_json::Value,
    pub resolved_at: Option<i64>,
    pub resolution: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PlanViolation {
    IntegratorBindingCount {
        count: usize,
    },
    MissingDependency {
        work_item_id: WorkItemId,
        dependency: WorkItemId,
    },
    DependencyCycle {
        work_item_id: WorkItemId,
    },
    UnknownAssignee {
        work_item_id: WorkItemId,
        assignee: LogicalSessionId,
    },
    OverlappingWorkerWriteScope {
        left: LogicalSessionId,
        right: LogicalSessionId,
        path_prefix: String,
    },
    WorkItemBudgetExceeded {
        actual: usize,
        maximum: u32,
    },
    MissingRequiredWorkItem,
    EmptyGoal,
    MissingAcceptanceCriteria,
}

pub fn can_transition(from: WorkOrderState, to: WorkOrderState) -> bool {
    matches!(
        (from, to),
        (
            WorkOrderState::Draft,
            WorkOrderState::AwaitingGo | WorkOrderState::Cancelled
        ) | (
            WorkOrderState::AwaitingGo,
            WorkOrderState::Draft | WorkOrderState::Running | WorkOrderState::Cancelled
        ) | (
            WorkOrderState::Running,
            WorkOrderState::NeedsDecision
                | WorkOrderState::Integrating
                | WorkOrderState::Failed
                | WorkOrderState::Cancelled
        ) | (
            WorkOrderState::NeedsDecision,
            WorkOrderState::Running | WorkOrderState::Failed | WorkOrderState::Cancelled
        ) | (
            WorkOrderState::Integrating,
            WorkOrderState::Verifying
                | WorkOrderState::NeedsDecision
                | WorkOrderState::Failed
                | WorkOrderState::Cancelled
        ) | (
            WorkOrderState::Verifying,
            WorkOrderState::Done
                | WorkOrderState::NeedsDecision
                | WorkOrderState::Failed
                | WorkOrderState::Cancelled
        )
    )
}

pub fn transition(from: WorkOrderState, to: WorkOrderState) -> Result<WorkOrderState, ModelError> {
    if can_transition(from, to) {
        Ok(to)
    } else {
        Err(ModelError::InvalidWorkOrderTransition { from, to })
    }
}

pub fn can_transition_work_item(from: WorkItemState, to: WorkItemState) -> bool {
    matches!(
        (from, to),
        (
            WorkItemState::Pending,
            WorkItemState::Ready | WorkItemState::Cancelled
        ) | (
            WorkItemState::Ready,
            WorkItemState::Dispatched | WorkItemState::Cancelled
        ) | (
            WorkItemState::Dispatched,
            WorkItemState::Running | WorkItemState::Cancelled
        ) | (
            WorkItemState::Running,
            WorkItemState::Reported | WorkItemState::Cancelled
        ) | (
            WorkItemState::Reported,
            WorkItemState::Verified | WorkItemState::Failed | WorkItemState::Cancelled
        )
    )
}

pub fn transition_work_item(
    from: WorkItemState,
    to: WorkItemState,
) -> Result<WorkItemState, ModelError> {
    if can_transition_work_item(from, to) {
        Ok(to)
    } else {
        Err(ModelError::InvalidWorkItemTransition { from, to })
    }
}

pub fn validate_plan(plan: &PlanDraft) -> Result<(), Vec<PlanViolation>> {
    let mut violations = Vec::new();
    let integrator_count = plan
        .bindings
        .iter()
        .filter(|binding| binding.roles.contains(&SessionRole::Integrator))
        .count();
    if integrator_count != 1 {
        violations.push(PlanViolation::IntegratorBindingCount {
            count: integrator_count,
        });
    }

    let item_ids: BTreeSet<WorkItemId> =
        plan.work_items.iter().map(|item| item.id.clone()).collect();
    for item in &plan.work_items {
        for dependency in &item.dependencies {
            if !item_ids.contains(dependency) {
                violations.push(PlanViolation::MissingDependency {
                    work_item_id: item.id.clone(),
                    dependency: dependency.clone(),
                });
            }
        }
    }

    let dependency_map: BTreeMap<WorkItemId, Vec<WorkItemId>> = plan
        .work_items
        .iter()
        .map(|item| (item.id.clone(), item.dependencies.clone()))
        .collect();
    let mut visiting = Vec::new();
    let mut visited = BTreeSet::new();
    let mut cycle_members = BTreeSet::new();
    for item in &plan.work_items {
        collect_cycle_members(
            &item.id,
            &dependency_map,
            &mut visiting,
            &mut visited,
            &mut cycle_members,
        );
    }
    for work_item_id in cycle_members {
        violations.push(PlanViolation::DependencyCycle { work_item_id });
    }

    let binding_ids: HashSet<LogicalSessionId> = plan
        .bindings
        .iter()
        .map(|binding| binding.logical_session_id.clone())
        .collect();
    for item in &plan.work_items {
        if let Some(assignee) = &item.assignee {
            if !binding_ids.contains(assignee) {
                violations.push(PlanViolation::UnknownAssignee {
                    work_item_id: item.id.clone(),
                    assignee: assignee.clone(),
                });
            }
        }
    }

    let worker_ids: BTreeSet<LogicalSessionId> = plan
        .bindings
        .iter()
        .filter(|binding| binding.roles.contains(&SessionRole::Worker))
        .map(|binding| binding.logical_session_id.clone())
        .collect();
    if worker_ids.len() >= 2 {
        let mut scopes_by_worker: BTreeMap<LogicalSessionId, Vec<PathScope>> = BTreeMap::new();
        for worker_id in &worker_ids {
            let scopes = plan
                .work_items
                .iter()
                .filter(|item| item.assignee.as_ref() == Some(worker_id))
                .flat_map(|item| item.write_scope.iter().cloned())
                .collect();
            scopes_by_worker.insert(worker_id.clone(), scopes);
        }
        let workers: Vec<_> = worker_ids.into_iter().collect();
        for (index, left) in workers.iter().enumerate() {
            for right in workers.iter().skip(index + 1) {
                for left_scope in scopes_by_worker.get(left).into_iter().flatten() {
                    for right_scope in scopes_by_worker.get(right).into_iter().flatten() {
                        if scopes_overlap(&left_scope.path_prefix, &right_scope.path_prefix) {
                            violations.push(PlanViolation::OverlappingWorkerWriteScope {
                                left: left.clone(),
                                right: right.clone(),
                                path_prefix: shared_prefix(
                                    &left_scope.path_prefix,
                                    &right_scope.path_prefix,
                                ),
                            });
                        }
                    }
                }
            }
        }
    }

    if plan.work_items.len() > plan.budgets.max_work_items as usize {
        violations.push(PlanViolation::WorkItemBudgetExceeded {
            actual: plan.work_items.len(),
            maximum: plan.budgets.max_work_items,
        });
    }
    if !plan.work_items.iter().any(|item| item.required) {
        violations.push(PlanViolation::MissingRequiredWorkItem);
    }
    if plan.goal.is_empty() {
        violations.push(PlanViolation::EmptyGoal);
    }
    if plan.acceptance_criteria.is_empty() {
        violations.push(PlanViolation::MissingAcceptanceCriteria);
    }

    if violations.is_empty() {
        Ok(())
    } else {
        Err(violations)
    }
}

fn collect_cycle_members(
    node: &WorkItemId,
    graph: &BTreeMap<WorkItemId, Vec<WorkItemId>>,
    visiting: &mut Vec<WorkItemId>,
    visited: &mut BTreeSet<WorkItemId>,
    cycle_members: &mut BTreeSet<WorkItemId>,
) {
    if visited.contains(node) {
        return;
    }
    if let Some(cycle_start) = visiting.iter().position(|member| member == node) {
        cycle_members.extend(visiting[cycle_start..].iter().cloned());
        return;
    }
    visiting.push(node.clone());
    if let Some(dependencies) = graph.get(node) {
        for dependency in dependencies {
            if graph.contains_key(dependency) {
                collect_cycle_members(dependency, graph, visiting, visited, cycle_members);
            }
        }
    }
    visiting.pop();
    visited.insert(node.clone());
}

fn normalize_scope(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_owned()
}

pub(crate) fn scopes_overlap(left: &str, right: &str) -> bool {
    let left = normalize_scope(left);
    let right = normalize_scope(right);
    left == right
        || left
            .strip_prefix(&right)
            .is_some_and(|suffix| suffix.starts_with('/'))
        || right
            .strip_prefix(&left)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn shared_prefix(left: &str, right: &str) -> String {
    let left = normalize_scope(left);
    let right = normalize_scope(right);
    if left == right || left.starts_with(&(right.clone() + "/")) {
        right
    } else {
        left
    }
}
