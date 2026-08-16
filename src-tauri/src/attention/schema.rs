use rusqlite::Connection;

const DDL: &str = r#"
CREATE TABLE IF NOT EXISTS attention_cards (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  workorder_id TEXT,
  session_json TEXT,
  why_now TEXT NOT NULL,
  impact TEXT NOT NULL,
  primary_action_json TEXT NOT NULL,
  reply_route_json TEXT NOT NULL,
  resolution_predicate_json TEXT NOT NULL,
  state TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS attention_card_evidence (
  card_id TEXT NOT NULL REFERENCES attention_cards(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  detail TEXT NOT NULL,
  PRIMARY KEY (card_id, ordinal)
);
CREATE TABLE IF NOT EXISTS tracked_sessions (
  pty_session_id TEXT PRIMARY KEY,
  tracked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS attention_snapshots (
  snapshot_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
"#;

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch(DDL)
}
