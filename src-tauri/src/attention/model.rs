use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceRef {
    pub source: String,
    pub kind: String,
    pub ref_id: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SessionRef {
    Pty { pty_session_id: String },
    Logical { logical_session_id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttentionKind {
    AgentAsked,
    WorkStopped,
    ReportsComplete,
    CompletionWithoutTests,
    BudgetReached,
    OutOfScopeWrite,
    ConflictDetected,
    GoalReached,
    NextItemReady,
    WorkOrderStalled,
}

impl AttentionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AgentAsked => "agent_asked",
            Self::WorkStopped => "work_stopped",
            Self::ReportsComplete => "reports_complete",
            Self::CompletionWithoutTests => "completion_without_tests",
            Self::BudgetReached => "budget_reached",
            Self::OutOfScopeWrite => "out_of_scope_write",
            Self::ConflictDetected => "conflict_detected",
            Self::GoalReached => "goal_reached",
            Self::NextItemReady => "next_item_ready",
            Self::WorkOrderStalled => "work_order_stalled",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PrimaryAction {
    OpenSession {
        session: SessionRef,
    },
    AnswerQuestion {
        session: SessionRef,
    },
    RetryWorkItem {
        workorder_id: String,
        work_item_id: String,
    },
    ReviewConflict {
        workorder_id: String,
    },
    RaiseBudget {
        workorder_id: String,
    },
    AcknowledgeGoalReached {
        workorder_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ReplyRoute {
    Session { session: SessionRef },
    WorkOrder { workorder_id: String },
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ResolutionPredicate {
    ObservationMissing { observation_key: String },
    WorkOrderInactive { workorder_id: String },
    UserAcknowledged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CardState {
    Open,
    Resolved,
    Superseded,
    Bundled,
}

impl CardState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Resolved => "resolved",
            Self::Superseded => "superseded",
            Self::Bundled => "bundled",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionCard {
    pub id: String,
    pub fingerprint: String,
    pub kind: AttentionKind,
    pub workorder_id: Option<String>,
    pub session: Option<SessionRef>,
    pub why_now: String,
    pub impact: String,
    pub evidence: Vec<EvidenceRef>,
    pub primary_action: PrimaryAction,
    pub reply_route: ReplyRoute,
    pub resolution_predicate: ResolutionPredicate,
    pub state: CardState,
    pub first_seen_at: i64,
    pub last_seen_at: i64,
    pub revision: u32,
    pub resolved_at: Option<i64>,
}

pub type AttentionCardView = AttentionCard;

pub fn card_id(fingerprint: &str) -> String {
    let digest = Sha256::digest(fingerprint.as_bytes());
    hex::encode(digest)[..16].to_owned()
}
