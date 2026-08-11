//! SQLite schema for the AI log index, versioned via `PRAGMA user_version`.

use rusqlite::Connection;

/// Bump when the DDL below changes in a way existing rows cannot satisfy.
/// `init` recreates the whole database from scratch on mismatch, which is safe
/// because every row is derived from transcripts that are still on disk.
pub const USER_VERSION: i32 = 2;

const DDL: &str = r#"
CREATE TABLE IF NOT EXISTS source_file (
  path           TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  mtime_ns       INTEGER NOT NULL,
  parsed_bytes   INTEGER NOT NULL,
  parsed_lines   INTEGER NOT NULL,
  session_id     TEXT,
  last_indexed   INTEGER NOT NULL,
  parse_error    TEXT
);

CREATE TABLE IF NOT EXISTS session (
  kind           TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  cwd            TEXT,
  project_key    TEXT,
  project_label  TEXT,
  git_branch     TEXT,
  ai_title       TEXT,
  first_prompt   TEXT,
  slug           TEXT,
  entrypoint     TEXT,
  origin         TEXT,
  is_sidechain   INTEGER NOT NULL DEFAULT 0,
  agent_names    TEXT,
  cli_version    TEXT,
  plan_type      TEXT,
  started_at     INTEGER,
  ended_at       INTEGER,
  wall_ms        INTEGER,
  active_ms      INTEGER,
  turn_count     INTEGER NOT NULL DEFAULT 0,
  user_msg_count INTEGER NOT NULL DEFAULT 0,
  compact_count  INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL NOT NULL DEFAULT 0,
  primary_model  TEXT,
  model_count    INTEGER NOT NULL DEFAULT 0,
  work_tags      TEXT,
  goal_key       TEXT,
  goal_cluster   TEXT,
  goal_summary   TEXT,
  read_chars     INTEGER NOT NULL DEFAULT 0,
  exec_chars     INTEGER NOT NULL DEFAULT 0,
  write_chars    INTEGER NOT NULL DEFAULT 0,
  fetch_chars    INTEGER NOT NULL DEFAULT 0,
  other_chars    INTEGER NOT NULL DEFAULT 0,
  prompt_chars   INTEGER NOT NULL DEFAULT 0,
  read_files     INTEGER NOT NULL DEFAULT 0,
  written_files  INTEGER NOT NULL DEFAULT 0,
  ends_on_tool   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, session_id)
);
CREATE INDEX IF NOT EXISTS ix_session_started ON session(started_at);
CREATE INDEX IF NOT EXISTS ix_session_project ON session(project_key, started_at);

CREATE TABLE IF NOT EXISTS turn (
  kind           TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  request_id     TEXT,
  ts             INTEGER NOT NULL,
  model          TEXT,
  model_family   TEXT,
  model_variant  TEXT,
  effort         TEXT,
  service_tier   TEXT,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens      INTEGER NOT NULL DEFAULT 0,
  duration_ms    INTEGER,
  tool_calls     INTEGER NOT NULL DEFAULT 0,
  tool_errors    INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL NOT NULL DEFAULT 0,
  ingest_cost_usd  REAL NOT NULL DEFAULT 0,
  generate_cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, session_id, seq)
);
CREATE INDEX IF NOT EXISTS ix_turn_ts ON turn(ts);
CREATE INDEX IF NOT EXISTS ix_turn_model ON turn(model, ts);
CREATE INDEX IF NOT EXISTS ix_turn_family ON turn(model_family, ts);
CREATE UNIQUE INDEX IF NOT EXISTS ux_turn_request ON turn(kind, session_id, request_id);

CREATE TABLE IF NOT EXISTS tool_event (
  kind        TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  name        TEXT NOT NULL,
  is_error    INTEGER NOT NULL DEFAULT 0,
  target      TEXT,
  call_id     TEXT,
  turn_key    TEXT,
  PRIMARY KEY (kind, session_id, seq)
);
CREATE INDEX IF NOT EXISTS ix_tool_name ON tool_event(name, ts);
CREATE INDEX IF NOT EXISTS ix_tool_call ON tool_event(kind, session_id, call_id);
CREATE INDEX IF NOT EXISTS ix_tool_turn ON tool_event(kind, session_id, turn_key);

CREATE TABLE IF NOT EXISTS file_touch (
  kind        TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  path        TEXT NOT NULL,
  edit_count  INTEGER NOT NULL DEFAULT 0,
  read_count  INTEGER NOT NULL DEFAULT 0,
  first_ts    INTEGER,
  last_ts     INTEGER,
  PRIMARY KEY (kind, session_id, path)
);

CREATE TABLE IF NOT EXISTS rework (
  kind              TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  tool_error_count  INTEGER NOT NULL DEFAULT 0,
  tool_call_count   INTEGER NOT NULL DEFAULT 0,
  tool_error_rate   REAL NOT NULL DEFAULT 0,
  correction_count  INTEGER NOT NULL DEFAULT 0,
  max_file_edits    INTEGER NOT NULL DEFAULT 0,
  churn_files       INTEGER NOT NULL DEFAULT 0,
  retry_bash        INTEGER NOT NULL DEFAULT 0,
  abandoned         INTEGER NOT NULL DEFAULT 0,
  score             REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, session_id)
);

CREATE TABLE IF NOT EXISTS summary (
  kind         TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  model_used   TEXT,
  findings     TEXT,
  rework_note  TEXT,
  cost_note    TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  goal_summary TEXT,
  goal_cluster TEXT,
  summary TEXT,
  cluster TEXT,
  model TEXT,
  PRIMARY KEY (kind, session_id)
);

CREATE TABLE IF NOT EXISTS price (
  model            TEXT PRIMARY KEY,
  input_per_mtok   REAL NOT NULL,
  output_per_mtok  REAL NOT NULL,
  cache_read_per_mtok REAL NOT NULL,
  cache_write_5m_per_mtok REAL NOT NULL,
  cache_write_1h_per_mtok REAL NOT NULL,
  source           TEXT,
  updated_at       INTEGER
);

CREATE TABLE IF NOT EXISTS index_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
"#;

/// Tables recreated when `user_version` does not match. Ordered so that a
/// straight `DROP TABLE` sequence never trips a dependency.
const TABLES: &[&str] = &[
    "source_file",
    "session",
    "turn",
    "tool_event",
    "file_touch",
    "rework",
    "summary",
    "index_state",
];

/// Apply pragmas and DDL. Safe to call on every connection.
pub fn init(conn: &Connection) -> Result<(), String> {
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|err| format!("set journal_mode: {err}"))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|err| format!("set synchronous: {err}"))?;

    let current: i32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|err| format!("read user_version: {err}"))?;

    if current != 0 && current != USER_VERSION {
        // Everything here is derived data; rebuilding is cheaper and safer
        // than writing migrations for a cache. `price` survives so a user's
        // hand-edited rates are not silently discarded.
        for table in TABLES {
            conn.execute(&format!("DROP TABLE IF EXISTS {table}"), [])
                .map_err(|err| format!("drop {table}: {err}"))?;
        }
    }

    conn.execute_batch(DDL)
        .map_err(|err| format!("apply schema: {err}"))?;
    ensure_f3_columns(conn)?;
    conn.pragma_update(None, "user_version", USER_VERSION)
        .map_err(|err| format!("write user_version: {err}"))?;

    crate::ailog::price::seed_defaults(conn)?;
    Ok(())
}

/// F3 was reserved in the v2 schema, so upgrade its placeholder columns
/// without bumping `user_version` (which would force a full re-index).
fn ensure_f3_columns(conn: &Connection) -> Result<(), String> {
    for (table, column) in [
        ("session", "goal_summary"),
        ("session", "goal_cluster"),
        ("summary", "goal_summary"),
        ("summary", "goal_cluster"),
        ("summary", "summary"),
        ("summary", "cluster"),
        ("summary", "model"),
    ] {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(|err| format!("inspect {table}: {err}"))?;
        let present = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|err| format!("read {table} columns: {err}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("collect {table} columns: {err}"))?
            .iter()
            .any(|name| name == column);
        if !present {
            conn.execute(
                &format!("ALTER TABLE {table} ADD COLUMN {column} TEXT"),
                [],
            )
            .map_err(|err| format!("add {table}.{column}: {err}"))?;
        }
    }
    Ok(())
}
