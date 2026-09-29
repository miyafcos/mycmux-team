//! Versioned, idempotent corrections for derived rows.
use rusqlite::{params, Connection};
const VERSION: i64 = 2;
pub fn internal_origin(conn: &Connection) -> Result<(), String> {
    let current = conn.query_row("SELECT value FROM index_state WHERE key='internal_backfill_version'", [], |r| r.get::<_, String>(0)).ok().and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    if current >= VERSION { return Ok(()); }
    conn.execute("UPDATE session SET origin='ailog-internal' WHERE ((kind='codex' AND first_prompt LIKE '[mycmux-ailog-summarizer]%') OR first_prompt LIKE '[mycmux-next-action]%') AND COALESCE(origin,'unknown') <> 'ailog-internal'", []).map_err(|err| format!("mark internal sessions: {err}"))?;
    conn.execute("INSERT INTO index_state(key,value) VALUES ('internal_backfill_version',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![VERSION.to_string()]).map_err(|err| format!("record internal origin backfill: {err}"))?;
    Ok(())
}
