use rusqlite::Connection;

const DDL: &str = r#"
CREATE TABLE IF NOT EXISTS attention_cards (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  waiting TEXT NOT NULL,
  severity TEXT NOT NULL,
  actor TEXT,
  freshness TEXT,
  source_rank INTEGER,
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
    conn.execute_batch(DDL)?;
    ensure_order_columns(conn)?;
    backfill_order_axes(conn)?;
    bump_shared_schema_version(conn)
}

fn ensure_order_columns(conn: &Connection) -> rusqlite::Result<()> {
    let mut statement = conn.prepare("PRAGMA table_info(attention_cards)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for (name, definition) in [
        ("waiting", "TEXT"),
        ("severity", "TEXT"),
        ("actor", "TEXT"),
        ("freshness", "TEXT"),
        ("source_rank", "INTEGER"),
    ] {
        if !columns.iter().any(|column| column == name) {
            conn.execute(
                &format!("ALTER TABLE attention_cards ADD COLUMN {name} {definition}"),
                [],
            )?;
        }
    }
    Ok(())
}

fn backfill_order_axes(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
UPDATE attention_cards SET
  waiting = CASE kind
    WHEN '"agentAsked"' THEN '"human"'
    WHEN '"workStopped"' THEN '"work"'
    WHEN '"outOfScopeWrite"' THEN '"work"'
    WHEN '"conflictDetected"' THEN '"work"'
    WHEN '"workOrderStalled"' THEN '"work"'
    WHEN '"completionWithoutTests"' THEN '"work"'
    WHEN '"budgetReached"' THEN '"work"'
    WHEN '"nextItemReady"' THEN '"none"'
    WHEN '"reportsComplete"' THEN '"none"'
    WHEN '"goalReached"' THEN '"none"'
    ELSE waiting
  END,
  severity = CASE kind
    WHEN '"agentAsked"' THEN '"blocking"'
    WHEN '"workStopped"' THEN '"blocking"'
    WHEN '"outOfScopeWrite"' THEN '"blocking"'
    WHEN '"conflictDetected"' THEN '"blocking"'
    WHEN '"workOrderStalled"' THEN '"warning"'
    WHEN '"completionWithoutTests"' THEN '"warning"'
    WHEN '"budgetReached"' THEN '"warning"'
    WHEN '"nextItemReady"' THEN '"advisory"'
    WHEN '"reportsComplete"' THEN '"advisory"'
    WHEN '"goalReached"' THEN '"advisory"'
    ELSE severity
  END
WHERE waiting IS NULL OR severity IS NULL;
"#,
    )?;
    let incomplete: i64 = conn.query_row(
        "SELECT COUNT(*) FROM attention_cards WHERE waiting IS NULL OR severity IS NULL",
        [],
        |row| row.get(0),
    )?;
    if incomplete != 0 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(())
}

fn bump_shared_schema_version(conn: &Connection) -> rusqlite::Result<()> {
    let has_meta: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='workorder_meta')",
        [],
        |row| row.get(0),
    )?;
    if has_meta {
        conn.execute(
            "INSERT INTO workorder_meta(key, value) VALUES ('schema_version', '2') \
             ON CONFLICT(key) DO UPDATE SET value=CASE \
               WHEN CAST(value AS INTEGER) < 2 THEN '2' ELSE value END",
            [],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::{params, Connection};

    use super::*;

    #[test]
    fn init_adds_source_rank_to_an_existing_attention_table() {
        let conn = Connection::open_in_memory().unwrap();
        let legacy_ddl = DDL.replace("  source_rank INTEGER,\n", "");
        conn.execute_batch(&legacy_ddl).unwrap();

        init(&conn).unwrap();
        let mut statement = conn.prepare("PRAGMA table_info(attention_cards)").unwrap();
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(columns.iter().any(|column| column == "source_rank"));
    }

    #[test]
    fn migration_backfills_native_axes_once_and_bumps_schema_version() {
        let conn = Connection::open_in_memory().unwrap();
        let legacy_ddl = DDL
            .replace("  waiting TEXT NOT NULL,\n", "")
            .replace("  severity TEXT NOT NULL,\n", "")
            .replace("  actor TEXT,\n", "")
            .replace("  freshness TEXT,\n", "");
        conn.execute_batch(&legacy_ddl).unwrap();
        conn.execute_batch(
            "CREATE TABLE workorder_meta (key TEXT PRIMARY KEY, value TEXT); \
             INSERT INTO workorder_meta(key, value) VALUES ('schema_version', '1');",
        )
        .unwrap();
        let cases = [
            ("agentAsked", "human", "blocking"),
            ("workStopped", "work", "blocking"),
            ("outOfScopeWrite", "work", "blocking"),
            ("conflictDetected", "work", "blocking"),
            ("workOrderStalled", "work", "warning"),
            ("completionWithoutTests", "work", "warning"),
            ("budgetReached", "work", "warning"),
            ("nextItemReady", "none", "advisory"),
            ("reportsComplete", "none", "advisory"),
            ("goalReached", "none", "advisory"),
        ];
        for (index, (kind, _, _)) in cases.iter().enumerate() {
            conn.execute(
                "INSERT INTO attention_cards( \
                   id, fingerprint, kind, source_rank, workorder_id, session_json, why_now, impact, \
                   primary_action_json, reply_route_json, resolution_predicate_json, state, \
                   first_seen_at, last_seen_at, revision, resolved_at \
                 ) VALUES (?1, ?2, ?3, NULL, NULL, NULL, 'now', 'impact', '{}', '{}', '{}', \
                   'open', 1, 1, 1, NULL)",
                params![format!("id-{index}"), format!("fingerprint-{index}"), format!("\"{kind}\"")],
            )
            .unwrap();
        }

        init(&conn).unwrap();
        init(&conn).unwrap();

        for (index, (_, waiting, severity)) in cases.iter().enumerate() {
            let actual: (String, String) = conn
                .query_row(
                    "SELECT waiting, severity FROM attention_cards WHERE id=?1",
                    [format!("id-{index}")],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(
                actual,
                (format!("\"{waiting}\""), format!("\"{severity}\""))
            );
        }
        let version: String = conn
            .query_row(
                "SELECT value FROM workorder_meta WHERE key='schema_version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, "2");
    }
}
