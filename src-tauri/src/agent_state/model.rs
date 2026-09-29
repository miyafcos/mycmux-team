use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;

macro_rules! opaque_id {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn try_new(value: impl Into<String>) -> Result<Self, IdentityError> {
                let value = value.into();
                if value.trim().is_empty() {
                    return Err(IdentityError::Empty(stringify!($name)));
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
    };
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityError {
    Empty(&'static str),
}

impl fmt::Display for IdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty(kind) => write!(formatter, "{kind} must not be empty"),
        }
    }
}

impl std::error::Error for IdentityError {}

opaque_id!(AppInstanceId);
opaque_id!(PaneId);
opaque_id!(TerminalSessionId);
opaque_id!(LaunchId);
opaque_id!(ProviderSessionId);
opaque_id!(SourceEventId);
opaque_id!(PayloadHash);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Claude,
    Codex,
    Grok,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Grok => "grok",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NormalizedState {
    TurnActive,
    AttentionRequired,
    TurnEnded,
    ProcessExited,
    SessionTerminated,
    Failed,
    Cancelled,
    RateLimited,
}

impl NormalizedState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TurnActive => "turn_active",
            Self::AttentionRequired => "attention_required",
            Self::TurnEnded => "turn_ended",
            Self::ProcessExited => "process_exited",
            Self::SessionTerminated => "session_terminated",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::RateLimited => "rate_limited",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "turn_active" => Some(Self::TurnActive),
            "attention_required" => Some(Self::AttentionRequired),
            "turn_ended" => Some(Self::TurnEnded),
            "process_exited" => Some(Self::ProcessExited),
            "session_terminated" => Some(Self::SessionTerminated),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            "rate_limited" => Some(Self::RateLimited),
            _ => None,
        }
    }

    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::TurnActive | Self::AttentionRequired)
    }

    pub fn is_visible(self) -> bool {
        self != Self::TurnActive
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationSource {
    Hook,
    Rollout,
    Process,
    Title,
}

impl ObservationSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hook => "hook",
            Self::Rollout => "rollout",
            Self::Process => "process",
            Self::Title => "title",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct LaunchGeneration(u64);

impl LaunchGeneration {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MonotonicTime(u64);

impl MonotonicTime {
    pub const fn new(milliseconds: u64) -> Self {
        Self(milliseconds)
    }

    pub const fn get(self) -> u64 {
        self.0
    }

    pub const fn saturating_add(self, milliseconds: u64) -> Self {
        Self(self.0.saturating_add(milliseconds))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ProviderTurnId {
    Provider(String),
    Synthetic(u64),
}

impl ProviderTurnId {
    pub fn provider(value: impl Into<String>) -> Result<Self, IdentityError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(IdentityError::Empty("ProviderTurnId"));
        }
        Ok(Self::Provider(value))
    }

    pub(crate) fn stable_value(&self) -> String {
        match self {
            Self::Provider(value) => format!("provider:{value}"),
            Self::Synthetic(value) => format!("synthetic:{value}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct LaunchKey {
    app_instance_id: AppInstanceId,
    terminal_session_id: TerminalSessionId,
    provider: Provider,
    launch_id: LaunchId,
    generation: LaunchGeneration,
    pane_id: Option<PaneId>,
}

impl LaunchKey {
    pub fn new(
        app_instance_id: AppInstanceId,
        terminal_session_id: TerminalSessionId,
        provider: Provider,
        launch_id: LaunchId,
        generation: LaunchGeneration,
        pane_id: Option<PaneId>,
    ) -> Self {
        Self {
            app_instance_id,
            terminal_session_id,
            provider,
            launch_id,
            generation,
            pane_id,
        }
    }

    pub fn app_instance_id(&self) -> &AppInstanceId {
        &self.app_instance_id
    }

    pub fn terminal_session_id(&self) -> &TerminalSessionId {
        &self.terminal_session_id
    }

    pub fn launch_id(&self) -> &LaunchId {
        &self.launch_id
    }

    pub fn pane_id(&self) -> Option<&PaneId> {
        self.pane_id.as_ref()
    }

    pub const fn provider(&self) -> Provider {
        self.provider
    }

    pub const fn generation(&self) -> LaunchGeneration {
        self.generation
    }

    pub(crate) fn slot(&self) -> LaunchSlot {
        LaunchSlot {
            app_instance_id: self.app_instance_id.clone(),
            terminal_session_id: self.terminal_session_id.clone(),
            provider: self.provider,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct LaunchSlot {
    pub app_instance_id: AppInstanceId,
    pub terminal_session_id: TerminalSessionId,
    pub provider: Provider,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct IdentityKey {
    launch: LaunchKey,
    provider_session_id: ProviderSessionId,
    provider_turn_id: ProviderTurnId,
    event_kind: NormalizedState,
}

impl IdentityKey {
    pub fn new(
        launch: LaunchKey,
        provider_session_id: ProviderSessionId,
        provider_turn_id: ProviderTurnId,
        event_kind: NormalizedState,
    ) -> Self {
        Self {
            launch,
            provider_session_id,
            provider_turn_id,
            event_kind,
        }
    }

    pub fn launch(&self) -> &LaunchKey {
        &self.launch
    }

    pub fn provider_session_id(&self) -> &ProviderSessionId {
        &self.provider_session_id
    }

    pub fn provider_turn_id(&self) -> &ProviderTurnId {
        &self.provider_turn_id
    }

    pub const fn event_kind(&self) -> NormalizedState {
        self.event_kind
    }

    pub fn observation_id(&self) -> String {
        stable_hash(&[
            self.launch.app_instance_id.as_str(),
            self.launch.terminal_session_id.as_str(),
            self.launch.provider.as_str(),
            self.launch.launch_id.as_str(),
            self.provider_session_id.as_str(),
            &self.provider_turn_id.stable_value(),
            self.event_kind.as_str(),
        ])
    }

    pub fn canonical_event_id(&self) -> String {
        stable_hash(&[
            self.launch.app_instance_id.as_str(),
            self.launch.terminal_session_id.as_str(),
            self.launch.provider.as_str(),
            self.launch.launch_id.as_str(),
            self.provider_session_id.as_str(),
            &self.provider_turn_id.stable_value(),
        ])
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observation {
    identity: IdentityKey,
    source: ObservationSource,
    received_at: MonotonicTime,
    source_event_id: SourceEventId,
    provider_payload_hash: Option<PayloadHash>,
}

impl Observation {
    pub fn new(
        identity: IdentityKey,
        source: ObservationSource,
        received_at: MonotonicTime,
        source_event_id: SourceEventId,
        provider_payload_hash: Option<PayloadHash>,
    ) -> Self {
        Self {
            identity,
            source,
            received_at,
            source_event_id,
            provider_payload_hash,
        }
    }

    pub fn identity(&self) -> &IdentityKey {
        &self.identity
    }

    pub const fn source(&self) -> ObservationSource {
        self.source
    }

    pub const fn state(&self) -> NormalizedState {
        self.identity.event_kind
    }

    pub const fn received_at(&self) -> MonotonicTime {
        self.received_at
    }

    pub fn source_event_id(&self) -> &SourceEventId {
        &self.source_event_id
    }

    pub fn provider_payload_hash(&self) -> Option<&PayloadHash> {
        self.provider_payload_hash.as_ref()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookMode {
    Installed,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Intent {
    CreateCard,
    IncrementUnread,
    EmitNotification,
}

impl Intent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CreateCard => "create_card",
            Self::IncrementUnread => "increment_unread",
            Self::EmitNotification => "emit_notification",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Confirmation {
    Provisional,
    Confirmed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalState {
    pub canonical_event_id: String,
    pub state: NormalizedState,
    pub state_version: u64,
    pub confirmation: Confirmation,
    pub last_received_at: MonotonicTime,
    pub authority_source: ObservationSource,
    pub launch: LaunchKey,
    pub provider_session_id: ProviderSessionId,
    pub provider_turn_id: ProviderTurnId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RejectionReason {
    UnknownLaunch,
    StaleLaunch,
    FutureLaunch,
    Duplicate,
    ConflictingDuplicate,
    InvalidProcessObservation,
    ActiveAfterTerminal,
    NonTerminalAfterPaneClose,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcceptedObservation {
    pub canonical: CanonicalState,
    pub intents: Vec<Intent>,
    pub(crate) observation: Observation,
    pub(crate) suppress_notification: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReconcileOutcome {
    Accepted(AcceptedObservation),
    Rejected {
        reason: RejectionReason,
        canonical: Option<CanonicalState>,
    },
}

fn stable_hash(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update((part.len() as u64).to_le_bytes());
        hasher.update(part.as_bytes());
    }
    hex::encode(hasher.finalize())
}
