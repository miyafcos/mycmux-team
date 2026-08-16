use rusqlite::Connection;

use super::model::HistoryError;

// `logical_session_id` is currently populated with `agent_session_id`.
// `logical_sessions` permits future remapping without rewriting immutable events.
// `pty_session_id` is diagnostic only, never a grouping key; it changes on restart.
const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS logical_sessions (
  logical_session_id TEXT PRIMARY KEY,
  agent_session_id TEXT NOT NULL,
  agent_kind TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE(agent_session_id, agent_kind)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL,
  logical_session_id TEXT NOT NULL,
  turn_id TEXT,
  event_type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  repo_id TEXT,
  cwd TEXT,
  branch TEXT,
  pty_session_id TEXT,
  source_log TEXT NOT NULL,
  source_offset INTEGER NOT NULL,
  source_event_index INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  searchable_text TEXT NOT NULL,
  payload_json BLOB NOT NULL,
  FOREIGN KEY(logical_session_id) REFERENCES logical_sessions(logical_session_id) ON DELETE RESTRICT,
  UNIQUE(source_log, source_offset, source_hash)
);

CREATE INDEX IF NOT EXISTS idx_history_events_session_time
  ON events(logical_session_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_history_events_watermark
  ON events(logical_session_id, source_log, source_offset DESC);
CREATE INDEX IF NOT EXISTS idx_history_events_repo_branch_time
  ON events(repo_id, branch, timestamp DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts
USING fts5(event_rowid UNINDEXED, searchable_text, tokenize='unicode61');

CREATE TABLE IF NOT EXISTS turn_capsules (
  turn_id TEXT PRIMARY KEY,
  logical_session_id TEXT NOT NULL,
  source_log TEXT NOT NULL,
  opened_by_event_id TEXT NOT NULL,
  closed_by_event_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('open', 'closed')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  read_files_json BLOB NOT NULL,
  written_files_json BLOB NOT NULL,
  commands_json BLOB NOT NULL,
  test_results_json BLOB NOT NULL,
  errors_json BLOB NOT NULL,
  evidence_event_ids_json BLOB NOT NULL,
  request_text TEXT,
  conclusion_text TEXT,
  decisions_json BLOB,
  assumptions_json BLOB,
  open_questions_json BLOB,
  next_actions_json BLOB,
  semantic_derived_by TEXT,
  semantic_evidence_ids_json BLOB,
  FOREIGN KEY(logical_session_id) REFERENCES logical_sessions(logical_session_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_history_capsules_session_log
  ON turn_capsules(logical_session_id, source_log, started_at);
"#;

pub(crate) fn init(connection: &Connection) -> Result<(), HistoryError> {
    connection.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;",
    )?;
    connection.execute_batch(SCHEMA)?;
    Ok(())
}
