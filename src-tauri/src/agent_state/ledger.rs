use std::fmt;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use crate::workorder;

use super::model::*;
use super::reconciler::Reconciler;
use super::schema;

#[derive(Debug)]
pub enum LedgerError {
    Database(String),
    Runtime(String),
    Serialization(String),
    InvalidState(String),
}

impl fmt::Display for LedgerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Database(message) => write!(formatter, "database: {message}"),
            Self::Runtime(message) => write!(formatter, "runtime: {message}"),
            Self::Serialization(message) => write!(formatter, "serialization: {message}"),
            Self::InvalidState(message) => write!(formatter, "invalid state: {message}"),
        }
    }
}

impl std::error::Error for LedgerError {}

impl From<rusqlite::Error> for LedgerError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(error.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerRecord {
    pub canonical_event_id: String,
    pub source_event_ids: Vec<String>,
    pub payload_hashes: Vec<String>,
    pub current_state: NormalizedState,
    pub confirmation: Confirmation,
    pub state_version: u64,
    pub card_created_at: Option<u64>,
    pub unread_incremented_at: Option<u64>,
    pub native_notification_emitted_at: Option<u64>,
    pub native_notification_suppressed_at: Option<u64>,
    pub acknowledged_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReservedObservation {
    pub canonical: CanonicalState,
    pub intents: Vec<Intent>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PersistedReconcileOutcome {
    Accepted(ReservedObservation),
    Rejected {
        reason: RejectionReason,
        canonical: Option<CanonicalState>,
    },
}

pub struct Ledger {
    connection: Connection,
}

impl Ledger {
    pub fn open() -> Result<Self, LedgerError> {
        let path = workorder::db_path().map_err(|error| LedgerError::Runtime(error.to_string()))?;
        workorder::ensure_initialized(&path)
            .map_err(|error| LedgerError::Runtime(error.to_string()))?;
        let connection = Connection::open(path)?;
        Self::from_connection(connection)
    }

    pub fn from_connection(connection: Connection) -> Result<Self, LedgerError> {
        schema::init(&connection)?;
        Ok(Self { connection })
    }

    /// Reconciles against a clone and publishes the in-memory transition only
    /// after the ledger transaction has committed its side-effect claims.
    pub fn reconcile(
        &mut self,
        reconciler: &mut Reconciler,
        observation: Observation,
    ) -> Result<PersistedReconcileOutcome, LedgerError> {
        let mut candidate = reconciler.clone();
        match candidate.ingest(observation) {
            ReconcileOutcome::Accepted(accepted) => {
                let reserved = self.accept_and_reserve(accepted)?;
                *reconciler = candidate;
                Ok(PersistedReconcileOutcome::Accepted(reserved))
            }
            ReconcileOutcome::Rejected { reason, canonical } => {
                Ok(PersistedReconcileOutcome::Rejected { reason, canonical })
            }
        }
    }

    pub fn advance_and_reserve(
        &mut self,
        reconciler: &mut Reconciler,
        now: MonotonicTime,
    ) -> Result<Vec<ReservedObservation>, LedgerError> {
        let mut candidate = reconciler.clone();
        let accepted = candidate.advance_time(now);
        let mut reserved = Vec::with_capacity(accepted.len());
        for observation in accepted {
            reserved.push(self.accept_and_reserve(observation)?);
        }
        *reconciler = candidate;
        Ok(reserved)
    }

    pub fn accept_and_reserve(
        &mut self,
        accepted: AcceptedObservation,
    ) -> Result<ReservedObservation, LedgerError> {
        let at = accepted.observation.received_at().get();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<(String, String, u64)> = transaction
            .query_row(
                "SELECT current_state, confirmation, state_version FROM agent_state_ledger WHERE canonical_event_id=?1",
                [&accepted.canonical.canonical_event_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let state_changed = existing
            .as_ref()
            .map(|(state, confirmation, _)| {
                state != accepted.canonical.state.as_str()
                    || confirmation != confirmation_str(accepted.canonical.confirmation)
            })
            .unwrap_or(true);
        let state_version = existing
            .as_ref()
            .map(|(_, _, version)| {
                if state_changed {
                    version.saturating_add(1)
                } else {
                    *version
                }
            })
            .unwrap_or(1);
        let identity = accepted.observation.identity();
        transaction.execute(
            "INSERT INTO agent_state_ledger(
               canonical_event_id, app_instance_id, pane_id, provider, launch_generation,
               provider_session_id, provider_turn_id, source_event_ids_json, payload_hashes_json,
               current_state, confirmation, state_version
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '[]', '[]', ?8, ?9, ?10)
             ON CONFLICT(canonical_event_id) DO UPDATE SET
               current_state=excluded.current_state,
               confirmation=excluded.confirmation,
               state_version=?10",
            params![
                accepted.canonical.canonical_event_id,
                identity.launch().app_instance_id().as_str(),
                identity.launch().pane_id().as_str(),
                identity.launch().provider().as_str(),
                identity.launch().generation().get(),
                identity.provider_session_id().as_str(),
                identity.provider_turn_id().stable_value(),
                accepted.canonical.state.as_str(),
                confirmation_str(accepted.canonical.confirmation),
                state_version,
            ],
        )?;
        transaction.execute(
            "INSERT INTO agent_state_observations(
               canonical_event_id, observation_id, source_event_id, source,
               event_kind, received_at, payload_hash
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT DO NOTHING",
            params![
                accepted.canonical.canonical_event_id,
                identity.observation_id(),
                accepted.observation.source_event_id().as_str(),
                accepted.observation.source().as_str(),
                accepted.observation.state().as_str(),
                at,
                accepted
                    .observation
                    .provider_payload_hash()
                    .map(PayloadHash::as_str),
            ],
        )?;
        let source_event_ids = collect_column(
            &transaction,
            "SELECT DISTINCT source_event_id FROM agent_state_observations WHERE canonical_event_id=?1 ORDER BY source_event_id",
            &accepted.canonical.canonical_event_id,
        )?;
        let payload_hashes = collect_column(
            &transaction,
            "SELECT DISTINCT payload_hash FROM agent_state_observations WHERE canonical_event_id=?1 AND payload_hash IS NOT NULL ORDER BY payload_hash",
            &accepted.canonical.canonical_event_id,
        )?;
        transaction.execute(
            "UPDATE agent_state_ledger SET source_event_ids_json=?2, payload_hashes_json=?3 WHERE canonical_event_id=?1",
            params![
                accepted.canonical.canonical_event_id,
                to_json(&source_event_ids)?,
                to_json(&payload_hashes)?,
            ],
        )?;

        if accepted.suppress_notification {
            transaction.execute(
                "UPDATE agent_state_ledger SET native_notification_suppressed_at=COALESCE(native_notification_suppressed_at, ?2) WHERE canonical_event_id=?1",
                params![accepted.canonical.canonical_event_id, at],
            )?;
        }

        let mut reserved = Vec::new();
        for intent in accepted.intents {
            let updated = match intent {
                Intent::CreateCard => transaction.execute(
                    "UPDATE agent_state_ledger SET card_created_at=?2 WHERE canonical_event_id=?1 AND card_created_at IS NULL",
                    params![accepted.canonical.canonical_event_id, at],
                )?,
                Intent::IncrementUnread => transaction.execute(
                    "UPDATE agent_state_ledger SET unread_incremented_at=?2 WHERE canonical_event_id=?1 AND unread_incremented_at IS NULL",
                    params![accepted.canonical.canonical_event_id, at],
                )?,
                Intent::EmitNotification => transaction.execute(
                    "UPDATE agent_state_ledger SET native_notification_emitted_at=?2 WHERE canonical_event_id=?1 AND native_notification_emitted_at IS NULL AND native_notification_suppressed_at IS NULL",
                    params![accepted.canonical.canonical_event_id, at],
                )?,
            };
            if updated == 1 {
                reserved.push(intent);
            }
        }
        transaction.commit()?;
        let mut canonical = accepted.canonical;
        canonical.state_version = state_version;
        Ok(ReservedObservation {
            canonical,
            intents: reserved,
        })
    }

    pub fn record_intent_result(
        &self,
        canonical_event_id: &str,
        intent: Intent,
        succeeded: bool,
        reported_at: MonotonicTime,
        detail: Option<&str>,
    ) -> Result<(), LedgerError> {
        self.connection.execute(
            "INSERT INTO agent_state_intent_reports(canonical_event_id, intent_kind, succeeded, reported_at, detail)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(canonical_event_id, intent_kind) DO UPDATE SET
               succeeded=excluded.succeeded, reported_at=excluded.reported_at, detail=excluded.detail",
            params![
                canonical_event_id,
                intent.as_str(),
                i64::from(succeeded),
                reported_at.get(),
                detail,
            ],
        )?;
        Ok(())
    }

    pub fn acknowledge(
        &self,
        canonical_event_id: &str,
        at: MonotonicTime,
    ) -> Result<bool, LedgerError> {
        Ok(self.connection.execute(
            "UPDATE agent_state_ledger SET acknowledged_at=COALESCE(acknowledged_at, ?2) WHERE canonical_event_id=?1",
            params![canonical_event_id, at.get()],
        )? == 1)
    }

    pub fn load(&self, canonical_event_id: &str) -> Result<Option<LedgerRecord>, LedgerError> {
        let row = self
            .connection
            .query_row(
                "SELECT source_event_ids_json, payload_hashes_json, current_state, confirmation,
                        state_version, card_created_at, unread_incremented_at,
                        native_notification_emitted_at, native_notification_suppressed_at,
                        acknowledged_at
                 FROM agent_state_ledger WHERE canonical_event_id=?1",
                [canonical_event_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, u64>(4)?,
                        row.get::<_, Option<u64>>(5)?,
                        row.get::<_, Option<u64>>(6)?,
                        row.get::<_, Option<u64>>(7)?,
                        row.get::<_, Option<u64>>(8)?,
                        row.get::<_, Option<u64>>(9)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            source_ids,
            hashes,
            state,
            confirmation,
            version,
            card,
            unread,
            notification,
            suppressed,
            acknowledged,
        )) = row
        else {
            return Ok(None);
        };
        Ok(Some(LedgerRecord {
            canonical_event_id: canonical_event_id.to_owned(),
            source_event_ids: from_json(&source_ids)?,
            payload_hashes: from_json(&hashes)?,
            current_state: NormalizedState::from_str(&state)
                .ok_or_else(|| LedgerError::InvalidState(state.clone()))?,
            confirmation: parse_confirmation(&confirmation)?,
            state_version: version,
            card_created_at: card,
            unread_incremented_at: unread,
            native_notification_emitted_at: notification,
            native_notification_suppressed_at: suppressed,
            acknowledged_at: acknowledged,
        }))
    }

    #[cfg(test)]
    pub(crate) fn count_records(&self) -> Result<u64, LedgerError> {
        Ok(self
            .connection
            .query_row("SELECT COUNT(*) FROM agent_state_ledger", [], |row| {
                row.get(0)
            })?)
    }
}

fn collect_column(
    transaction: &rusqlite::Transaction<'_>,
    sql: &str,
    canonical_event_id: &str,
) -> Result<Vec<String>, LedgerError> {
    let mut statement = transaction.prepare(sql)?;
    let values = statement
        .query_map([canonical_event_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(values)
}

fn confirmation_str(confirmation: Confirmation) -> &'static str {
    match confirmation {
        Confirmation::Provisional => "provisional",
        Confirmation::Confirmed => "confirmed",
    }
}

fn parse_confirmation(value: &str) -> Result<Confirmation, LedgerError> {
    match value {
        "provisional" => Ok(Confirmation::Provisional),
        "confirmed" => Ok(Confirmation::Confirmed),
        _ => Err(LedgerError::InvalidState(value.to_owned())),
    }
}

fn to_json<T: serde::Serialize>(value: &T) -> Result<String, LedgerError> {
    serde_json::to_string(value).map_err(|error| LedgerError::Serialization(error.to_string()))
}

fn from_json<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, LedgerError> {
    serde_json::from_str(value).map_err(|error| LedgerError::Serialization(error.to_string()))
}
