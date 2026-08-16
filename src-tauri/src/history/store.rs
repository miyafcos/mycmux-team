use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;

use super::capsule;
use super::model::{
    event_index, event_type, payload_json, searchable_text, HistoryError, IngestInput, IngestStats,
    MachineTurnCapsule, StoredEvent,
};
use super::schema;
use super::search;
use super::{Hit, SearchFilters};

pub(crate) fn db_path() -> Result<PathBuf, HistoryError> {
    Ok(crate::test_profile::runtime_dir()
        .map_err(HistoryError::Runtime)?
        .join("history.db"))
}

pub(crate) fn ingest_at(path: &Path, input: &IngestInput<'_>) -> Result<IngestStats, HistoryError> {
    if input.logical_session_id.trim().is_empty()
        || input.agent_session_id.trim().is_empty()
        || input.agent_kind.trim().is_empty()
        || input.events.is_empty()
    {
        return Ok(IngestStats::default());
    }
    let mut connection = writer(path)?;
    let source_log = input.source_log.to_string_lossy().into_owned();
    if new_events_after(
        input.events,
        high_water_mark(&connection, input.logical_session_id, &source_log)?,
    )
    .is_empty()
    {
        return Ok(IngestStats::default());
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let new_events = new_events_after(
        input.events,
        high_water_mark(&transaction, input.logical_session_id, &source_log)?,
    );
    if new_events.is_empty() {
        transaction.commit()?;
        return Ok(IngestStats::default());
    }
    let stats = append_events(&transaction, input, &source_log, &new_events)?;
    transaction.commit()?;
    Ok(stats)
}

pub(crate) fn search_at(
    path: &Path,
    query: &str,
    filters: &SearchFilters,
    limit: usize,
) -> Result<Vec<Hit>, HistoryError> {
    let connection = reader(path)?;
    search::run(&connection, query, filters, limit)
}

pub(crate) fn event_count_at(path: &Path) -> Result<i64, HistoryError> {
    let connection = reader(path)?;
    Ok(connection.query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))?)
}

pub(crate) fn logical_session_count_at(path: &Path) -> Result<i64, HistoryError> {
    let connection = reader(path)?;
    Ok(
        connection.query_row("SELECT COUNT(*) FROM logical_sessions", [], |row| {
            row.get(0)
        })?,
    )
}

pub(crate) fn capsules_at(path: &Path) -> Result<Vec<MachineTurnCapsule>, HistoryError> {
    let connection = reader(path)?;
    let mut statement = connection.prepare(
        "SELECT turn_id, logical_session_id, source_log, opened_by_event_id, closed_by_event_id, \
                state, started_at, ended_at, read_files_json, written_files_json, commands_json, \
                test_results_json, errors_json, evidence_event_ids_json \
         FROM turn_capsules ORDER BY started_at, turn_id",
    )?;
    let rows = statement.query_map([], |row| {
        let state = match row.get::<_, String>(5)?.as_str() {
            "open" => super::model::CapsuleState::Open,
            "closed" => super::model::CapsuleState::Closed,
            _other => {
                return Err(rusqlite::Error::InvalidColumnType(
                    5,
                    "state".to_string(),
                    rusqlite::types::Type::Text,
                ))
            }
        };
        Ok(MachineTurnCapsule {
            turn_id: row.get(0)?,
            logical_session_id: row.get(1)?,
            source_log: row.get(2)?,
            opened_by_event_id: row.get(3)?,
            closed_by_event_id: row.get(4)?,
            state,
            started_at: row.get(6)?,
            ended_at: row.get(7)?,
            read_files: parse_json(row.get(8)?)?,
            written_files: parse_json(row.get(9)?)?,
            commands: parse_json(row.get(10)?)?,
            test_results: parse_json(row.get(11)?)?,
            errors: parse_json(row.get(12)?)?,
            evidence_event_ids: parse_json(row.get(13)?)?,
            semantic: super::model::SemanticFields::default(),
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(HistoryError::from)
}

fn append_events(
    transaction: &Transaction<'_>,
    input: &IngestInput<'_>,
    source_log: &str,
    new_events: &[&super::model::JournalEvent],
) -> Result<IngestStats, HistoryError> {
    let first_seen_at = input
        .events
        .iter()
        .map(|event| event.envelope.occurred_at)
        .min()
        .unwrap_or_default();
    let last_seen_at = input
        .events
        .iter()
        .map(|event| event.envelope.occurred_at)
        .max()
        .unwrap_or_default();
    transaction.execute(
        "INSERT INTO logical_sessions(logical_session_id, agent_session_id, agent_kind, first_seen_at, last_seen_at) \
         VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(logical_session_id) DO UPDATE SET \
           agent_session_id=excluded.agent_session_id, \
           agent_kind=excluded.agent_kind, \
           last_seen_at=MAX(logical_sessions.last_seen_at, excluded.last_seen_at)",
        params![
            input.logical_session_id,
            input.agent_session_id,
            input.agent_kind,
            first_seen_at,
            last_seen_at
        ],
    )?;

    let existing_open = open_turn_anchor(transaction, input.logical_session_id, source_log)?;
    let input_events = new_events
        .iter()
        .map(|event| {
            Ok(StoredEvent {
                event_id: event.envelope.event_id.clone(),
                timestamp: event.envelope.occurred_at,
                payload_json: payload_json(&event.envelope)?,
            })
        })
        .collect::<Result<Vec<_>, HistoryError>>()?;
    let input_turn_ids = capsule::turn_ids(
        input.logical_session_id,
        &input_events,
        existing_open.as_ref().map(|anchor| anchor.turn_id.as_str()),
    );
    let mut stats = IngestStats {
        new_event_count: new_events.len(),
        event_insert_attempts: new_events.len(),
        ..IngestStats::default()
    };
    for (event, turn_id) in new_events.iter().zip(input_turn_ids) {
        let envelope = &event.envelope;
        let source_offset = i64::try_from(envelope.source_byte_start).map_err(|_| {
            HistoryError::Runtime("source offset exceeds SQLite INTEGER".to_string())
        })?;
        let changed = transaction.execute(
            "INSERT OR IGNORE INTO events( \
               event_id, logical_session_id, turn_id, event_type, timestamp, repo_id, cwd, branch, \
               pty_session_id, source_log, source_offset, source_event_index, source_hash, searchable_text, payload_json \
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                envelope.event_id,
                input.logical_session_id,
                turn_id,
                event_type(envelope)?,
                envelope.occurred_at,
                input.repo_id,
                input.cwd,
                input.branch,
                input.pty_session_id,
                source_log,
                source_offset,
                event_index(&envelope.event_id),
                event.source_hash,
                searchable_text(envelope)?,
                payload_json(envelope)?,
            ],
        )?;
        if changed == 1 {
            stats.event_inserts += 1;
            let row_id = transaction.last_insert_rowid();
            transaction.execute(
                "INSERT INTO events_fts(event_rowid, searchable_text) VALUES (?1, ?2)",
                params![row_id, searchable_text(envelope)?],
            )?;
        }
    }

    if stats.event_inserts == 0 {
        return Ok(stats);
    }
    let rebuild_from = existing_open
        .as_ref()
        .map(|anchor| anchor.source_offset)
        .or_else(|| {
            new_events
                .iter()
                .map(|event| event.envelope.source_byte_start)
                .min()
                .and_then(|offset| i64::try_from(offset).ok())
        })
        .ok_or_else(|| HistoryError::Runtime("missing incremental capsule offset".to_string()))?;
    let stored_events = load_source_events_from(
        transaction,
        input.logical_session_id,
        source_log,
        rebuild_from,
    )?;
    stats.capsule_events_read = stored_events.len();
    if existing_open.is_some() {
        transaction.execute(
            "DELETE FROM turn_capsules WHERE logical_session_id=?1 AND source_log=?2 AND state='open'",
            params![input.logical_session_id, source_log],
        )?;
    }
    for capsule in capsule::build_capsules(input.logical_session_id, source_log, &stored_events) {
        insert_capsule(transaction, &capsule)?;
        stats.capsule_rebuild_count += 1;
    }
    Ok(stats)
}

#[derive(Clone, Debug)]
struct OpenTurnAnchor {
    turn_id: String,
    source_offset: i64,
}

fn high_water_mark(
    connection: &Connection,
    logical_session_id: &str,
    source_log: &str,
) -> Result<Option<u64>, HistoryError> {
    let offset = connection.query_row(
        "SELECT MAX(source_offset) FROM events WHERE logical_session_id=?1 AND source_log=?2",
        params![logical_session_id, source_log],
        |row| row.get::<_, Option<i64>>(0),
    )?;
    offset
        .map(|value| {
            u64::try_from(value).map_err(|_| {
                HistoryError::Runtime("negative source offset in history database".to_string())
            })
        })
        .transpose()
}

fn new_events_after<'a>(
    events: &'a [super::model::JournalEvent],
    high_water: Option<u64>,
) -> Vec<&'a super::model::JournalEvent> {
    events
        .iter()
        .filter(|event| {
            high_water
                .map(|offset| event.envelope.source_byte_start > offset)
                .unwrap_or(true)
        })
        .collect()
}

fn open_turn_anchor(
    transaction: &Transaction<'_>,
    logical_session_id: &str,
    source_log: &str,
) -> Result<Option<OpenTurnAnchor>, HistoryError> {
    transaction
        .query_row(
            "SELECT c.turn_id, e.source_offset \
             FROM turn_capsules c \
             JOIN events e ON e.logical_session_id=c.logical_session_id \
               AND e.source_log=c.source_log AND e.event_id=c.opened_by_event_id \
             WHERE c.logical_session_id=?1 AND c.source_log=?2 AND c.state='open' \
             ORDER BY e.source_offset DESC, e.source_event_index DESC LIMIT 1",
            params![logical_session_id, source_log],
            |row| {
                Ok(OpenTurnAnchor {
                    turn_id: row.get(0)?,
                    source_offset: row.get(1)?,
                })
            },
        )
        .optional()
        .map_err(HistoryError::from)
}

fn load_source_events_from(
    transaction: &Transaction<'_>,
    logical_session_id: &str,
    source_log: &str,
    source_offset: i64,
) -> Result<Vec<StoredEvent>, HistoryError> {
    let mut statement = transaction.prepare(
        "SELECT event_id, timestamp, payload_json \
         FROM events WHERE logical_session_id=?1 AND source_log=?2 AND source_offset>=?3 \
         ORDER BY source_offset ASC, source_event_index ASC, event_id ASC",
    )?;
    let rows = statement.query_map(
        params![logical_session_id, source_log, source_offset],
        |row| {
            Ok(StoredEvent {
                event_id: row.get(0)?,
                timestamp: row.get(1)?,
                payload_json: row.get(2)?,
            })
        },
    )?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(HistoryError::from)
}

fn insert_capsule(
    transaction: &Transaction<'_>,
    capsule: &MachineTurnCapsule,
) -> Result<(), HistoryError> {
    transaction.execute(
        "INSERT INTO turn_capsules( \
           turn_id, logical_session_id, source_log, opened_by_event_id, closed_by_event_id, state, \
           started_at, ended_at, read_files_json, written_files_json, commands_json, test_results_json, \
           errors_json, evidence_event_ids_json, request_text, conclusion_text, decisions_json, \
           assumptions_json, open_questions_json, next_actions_json, semantic_derived_by, semantic_evidence_ids_json \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, \
                   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)",
        params![
            capsule.turn_id,
            capsule.logical_session_id,
            capsule.source_log,
            capsule.opened_by_event_id,
            capsule.closed_by_event_id,
            capsule.state.as_str(),
            capsule.started_at,
            capsule.ended_at,
            to_json(&capsule.read_files)?,
            to_json(&capsule.written_files)?,
            to_json(&capsule.commands)?,
            to_json(&capsule.test_results)?,
            to_json(&capsule.errors)?,
            to_json(&capsule.evidence_event_ids)?,
        ],
    )?;
    Ok(())
}

fn writer(path: &Path) -> Result<Connection, HistoryError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| HistoryError::Runtime(format!("create {parent:?}: {error}")))?;
    }
    let connection = Connection::open(path)
        .map_err(|error| HistoryError::Database(format!("open {path:?}: {error}")))?;
    configure(&connection)?;
    schema::init(&connection)?;
    Ok(connection)
}

fn reader(path: &Path) -> Result<Connection, HistoryError> {
    let _ = writer(path)?;
    let connection = Connection::open(path)
        .map_err(|error| HistoryError::Database(format!("open reader {path:?}: {error}")))?;
    configure(&connection)?;
    connection.execute_batch("PRAGMA query_only=ON")?;
    Ok(connection)
}

fn configure(connection: &Connection) -> Result<(), HistoryError> {
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

fn to_json(value: &impl Serialize) -> Result<Vec<u8>, HistoryError> {
    serde_json::to_vec(value).map_err(|error| HistoryError::Serialization(error.to_string()))
}

fn parse_json<T: serde::de::DeserializeOwned>(value: Vec<u8>) -> rusqlite::Result<T> {
    serde_json::from_slice(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            value.len(),
            rusqlite::types::Type::Blob,
            Box::new(error),
        )
    })
}
