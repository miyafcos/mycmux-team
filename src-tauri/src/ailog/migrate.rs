//! Additive schema extensions for the AI log cache.

use rusqlite::{params, Connection};

const VERSION: i64 = 1;

pub fn apply(conn: &Connection) -> Result<(), String> {
    let current = conn
        .query_row(
            "SELECT value FROM index_state WHERE key='schema_ext_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    if current >= VERSION { return Ok(()); }
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS ix_tool_event_ts ON tool_event(ts);
         CREATE INDEX IF NOT EXISTS ix_file_touch_last_ts ON file_touch(last_ts);
         CREATE INDEX IF NOT EXISTS ix_source_file_session ON source_file(kind, session_id);
         CREATE INDEX IF NOT EXISTS ix_turn_session_ts ON turn(kind, session_id, ts);",
    ).map_err(|err| format!("apply ailog indexes: {err}"))?;
    conn.execute(
        "INSERT INTO index_state(key,value) VALUES ('schema_ext_version',?1) \
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![VERSION.to_string()],
    ).map_err(|err| format!("record ailog schema extension: {err}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    #[test]
    fn indexes_are_idempotent_and_preserve_rows() {
        let conn = Connection::open_in_memory().unwrap();
        crate::ailog::schema::init(&conn).unwrap();
        conn.execute("INSERT INTO session(kind,session_id) VALUES ('codex','s')", []).unwrap();
        super::apply(&conn).unwrap(); super::apply(&conn).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN ('ix_tool_event_ts','ix_file_touch_last_ts','ix_source_file_session','ix_turn_session_ts')", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 4);
        assert_eq!(conn.query_row::<String,_,_>("SELECT value FROM index_state WHERE key='schema_ext_version'", [], |r| r.get(0)).unwrap(), "1");
    }
}
