//! Versioned, idempotent corrections for derived rows.
use rusqlite::{params, Connection};
const VERSION: i64 = 2;
const INTERNAL: &str = "((kind='codex' AND first_prompt LIKE '[mycmux-ailog-summarizer]%')
    OR first_prompt LIKE '[mycmux-next-action]%') AND COALESCE(origin,'unknown') <> 'ailog-internal'";

pub fn internal_origin(conn: &Connection) -> Result<(), String> {
    let current = conn.query_row("SELECT value FROM index_state WHERE key='internal_backfill_version'", [],
        |r| r.get::<_, String>(0)).ok().and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    if current >= VERSION { return Ok(()); }
    let tx = if conn.is_autocommit() {
        Some(super::db::write_transaction(conn).map_err(|e| e.to_string())?)
    } else { None };
    let has_rollups: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='rollup_dirty')",
        [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if has_rollups {
        let mut stmt = conn.prepare(&format!("SELECT kind,session_id FROM session WHERE {INTERNAL}"))
            .map_err(|e| e.to_string())?;
        let sessions = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        // Mark only affected sessions, before changing their visibility. No
        // global turn scan is introduced into foreground initialization.
        for session in sessions {
            let (kind, session_id) = session.map_err(|e| e.to_string())?;
            super::rollup::mark_session_dirty(conn, &kind, &session_id)?;
        }
    }
    conn.execute(&format!("UPDATE session SET origin='ailog-internal' WHERE {INTERNAL}"), [])
        .map_err(|err| format!("mark internal sessions: {err}"))?;
    conn.execute("INSERT INTO index_state(key,value) VALUES ('internal_backfill_version',?1)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![VERSION.to_string()])
        .map_err(|err| format!("record internal origin backfill: {err}"))?;
    if let Some(tx) = tx { tx.commit().map_err(|e| e.to_string())?; }
    Ok(())
}
