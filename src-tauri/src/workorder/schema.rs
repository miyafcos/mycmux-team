//! SQLite schema for the WorkOrder domain authority.

use rusqlite::Connection;

const DDL: &str = r#"
CREATE TABLE IF NOT EXISTS workorder_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS autonomy_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS work_orders (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  state TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_reason TEXT
);

CREATE TABLE IF NOT EXISTS work_order_versions (
  work_order_id TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  plan_version INTEGER NOT NULL,
  goal TEXT NOT NULL,
  acceptance_criteria_json TEXT NOT NULL,
  budgets_json TEXT NOT NULL,
  sealed_at INTEGER,
  superseded_at INTEGER,
  PRIMARY KEY (work_order_id, plan_version)
);

CREATE TABLE IF NOT EXISTS session_bindings (
  work_order_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  logical_session_id TEXT NOT NULL,
  roles_json TEXT NOT NULL,
  label_snapshot TEXT,
  snapshot_event_id TEXT,
  PRIMARY KEY (work_order_id, plan_version, logical_session_id),
  FOREIGN KEY (work_order_id, plan_version)
    REFERENCES work_order_versions(work_order_id, plan_version) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS work_items (
  work_order_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  id TEXT NOT NULL,
  objective TEXT NOT NULL,
  assignee_logical_session_id TEXT,
  dependencies_json TEXT NOT NULL,
  expected_artifacts_json TEXT NOT NULL,
  write_scope_json TEXT NOT NULL,
  gates_json TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (work_order_id, plan_version, id),
  FOREIGN KEY (work_order_id, plan_version)
    REFERENCES work_order_versions(work_order_id, plan_version) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dispatch_outbox (
  work_order_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  work_item_id TEXT NOT NULL,
  intent_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (work_order_id, plan_version, work_item_id, intent_kind)
);

CREATE TABLE IF NOT EXISTS report_envelopes (
  id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  work_item_id TEXT NOT NULL,
  logical_session_id TEXT NOT NULL,
  terminal INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  verified_facts_json TEXT NOT NULL,
  unverified_claims_json TEXT NOT NULL,
  open_questions_json TEXT NOT NULL,
  evidence_event_ids_json TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_envelopes_item
  ON report_envelopes(work_order_id, plan_version, work_item_id);

CREATE TABLE IF NOT EXISTS source_snapshots (
  work_order_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  logical_session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  snapshot_event_id TEXT,
  acquired_at INTEGER,
  failure_reason TEXT,
  advanced_since_seal INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (work_order_id, plan_version, logical_session_id)
);

-- `gate_results`, `decision_items`, and `workorder_audit` are additions to
-- Oracle's seven tables under spec §6. They are indispensable for computing
-- Done from machine evidence rather than an LLM completion claim.
CREATE TABLE IF NOT EXISTS gate_results (
  work_order_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  work_item_id TEXT NOT NULL,
  gate_id TEXT NOT NULL,
  status TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (work_order_id, plan_version, work_item_id, gate_id)
);

CREATE TABLE IF NOT EXISTS decision_items (
  id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  resolved_at INTEGER,
  resolution TEXT
);
CREATE INDEX IF NOT EXISTS idx_decision_items_open
  ON decision_items(work_order_id, plan_version, resolved_at);

CREATE TABLE IF NOT EXISTS workorder_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id TEXT NOT NULL,
  plan_version INTEGER,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
"#;

/// Apply the initial, additive schema. This is intentionally idempotent.
pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch(DDL)?;
    ensure_work_item_ordinal(conn)?;
    conn.execute(
        "INSERT INTO workorder_meta(key, value) VALUES ('schema_version', '1') \
         ON CONFLICT(key) DO NOTHING",
        [],
    )?;
    Ok(())
}

fn ensure_work_item_ordinal(conn: &Connection) -> rusqlite::Result<()> {
    let mut statement = conn.prepare("PRAGMA table_info(work_items)")?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    let has_ordinal = columns
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .any(|name| name == "ordinal");
    if !has_ordinal {
        conn.execute(
            "ALTER TABLE work_items ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
        conn.execute(
            "UPDATE work_items AS target SET ordinal=( \
                 SELECT COUNT(*) - 1 FROM work_items AS earlier \
                 WHERE earlier.work_order_id=target.work_order_id \
                   AND earlier.plan_version=target.plan_version \
                   AND earlier.rowid <= target.rowid \
             )",
            [],
        )?;
    }
    Ok(())
}
