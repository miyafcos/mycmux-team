use rusqlite::Connection;

const DDL: &str = r#"
CREATE TABLE IF NOT EXISTS agent_state_ledger (
  canonical_event_id TEXT PRIMARY KEY,
  app_instance_id TEXT NOT NULL,
  pane_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  launch_generation INTEGER NOT NULL CHECK (launch_generation >= 0),
  provider_session_id TEXT NOT NULL,
  provider_turn_id TEXT NOT NULL,
  source_event_ids_json TEXT NOT NULL,
  payload_hashes_json TEXT NOT NULL,
  current_state TEXT NOT NULL CHECK (current_state IN (
    'turn_active', 'attention_required', 'turn_ended', 'process_exited',
    'session_terminated', 'failed', 'cancelled', 'rate_limited'
  )),
  confirmation TEXT NOT NULL CHECK (confirmation IN ('provisional', 'confirmed')),
  state_version INTEGER NOT NULL CHECK (state_version >= 1),
  card_created_at INTEGER,
  unread_incremented_at INTEGER,
  native_notification_emitted_at INTEGER,
  native_notification_suppressed_at INTEGER,
  acknowledged_at INTEGER,
  UNIQUE (
    app_instance_id, pane_id, provider, launch_generation,
    provider_session_id, provider_turn_id
  )
);

CREATE TABLE IF NOT EXISTS agent_state_observations (
  canonical_event_id TEXT NOT NULL REFERENCES agent_state_ledger(canonical_event_id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('hook', 'rollout', 'process', 'title')),
  event_kind TEXT NOT NULL,
  received_at INTEGER NOT NULL CHECK (received_at >= 0),
  payload_hash TEXT,
  PRIMARY KEY (observation_id, source_event_id),
  UNIQUE (source_event_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_state_observations_event
  ON agent_state_observations(canonical_event_id, received_at);

CREATE TABLE IF NOT EXISTS agent_state_intent_reports (
  canonical_event_id TEXT NOT NULL REFERENCES agent_state_ledger(canonical_event_id) ON DELETE CASCADE,
  intent_kind TEXT NOT NULL,
  succeeded INTEGER NOT NULL CHECK (succeeded IN (0, 1)),
  reported_at INTEGER NOT NULL,
  detail TEXT,
  PRIMARY KEY (canonical_event_id, intent_kind)
);
"#;

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.execute_batch(DDL)
}
