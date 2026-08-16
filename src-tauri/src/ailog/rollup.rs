//! Incrementally maintained daily aggregates for the high-volume reports.
//!
//! The table deliberately retains the session key.  That lets readers retain
//! exact distinct-session counts and join session-level metadata without
//! scanning every individual turn in complete days.

use rusqlite::{params, Connection, OptionalExtension};

use crate::ailog::query::DAY_BOUNDARY_OFFSET_MIN;

pub const VERSION: &str = "1";
const DAY_MS: i64 = 86_400_000;

fn day_expr(column: &str) -> String {
    format!(
        "(({column} + {}) / {DAY_MS})",
        DAY_BOUNDARY_OFFSET_MIN * 60_000
    )
}

/// Mark every day touched by a session before deleting or replacing its turns.
/// This preserves the old day in the dirty set when a reset removes every turn
/// that had contributed to it.
pub fn mark_session_dirty(conn: &Connection, kind: &str, session_id: &str) -> Result<(), String> {
    let expression = day_expr("ts");
    conn.execute(
        &format!(
            "INSERT OR IGNORE INTO rollup_dirty(day) \
             SELECT DISTINCT {expression} FROM turn WHERE kind = ?1 AND session_id = ?2"
        ),
        params![kind, session_id],
    )
    .map_err(|err| format!("mark rollup session days dirty: {err}"))?;
    Ok(())
}

/// Mark every indexed day dirty.  This is used after a global repricing or a
/// derived-session migration; readers never call it.
pub fn mark_all_dirty(conn: &Connection) -> Result<(), String> {
    let expression = day_expr("ts");
    conn.execute(
        &format!("INSERT OR IGNORE INTO rollup_dirty(day) SELECT DISTINCT {expression} FROM turn"),
        [],
    )
    .map_err(|err| format!("mark all rollup days dirty: {err}"))?;
    Ok(())
}

/// Rebuild the supplied daily aggregates inside the caller's writer
/// transaction.  The aggregate is intentionally built from the canonical raw
/// tables, so an interrupted index never leaves a partially updated ready
/// rollup visible to query-only readers.
pub fn rebuild_days(conn: &Connection, days: &[i64]) -> Result<usize, String> {
    if days.is_empty() {
        return Ok(0);
    }

    let mut unique = days.to_vec();
    unique.sort_unstable();
    unique.dedup();
    let placeholders = vec!["?"; unique.len()].join(",");
    let expression = day_expr("t.ts");
    let delete_sql = format!("DELETE FROM rollup_turn_session_day WHERE day IN ({placeholders})");
    conn.execute(&delete_sql, rusqlite::params_from_iter(unique.iter()))
        .map_err(|err| format!("clear dirty rollup days: {err}"))?;

    let insert_sql = format!(
        "INSERT INTO rollup_turn_session_day (\
             day, kind, session_id, model, model_family, effort, origin, is_sidechain, \
             turns, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, \
             cost_usd, ingest_cost_usd, generate_cost_usd, duration_ms, timed_turns, tool_calls, tool_errors, \
             first_ts, last_ts\
         ) \
         SELECT {expression}, t.kind, t.session_id, COALESCE(t.model, ''), \
                COALESCE(t.model_family, ''), COALESCE(t.effort, ''), \
                COALESCE(s.origin, 'unknown'), COALESCE(s.is_sidechain, 0), \
                COUNT(*), \
                COALESCE(SUM(t.input_tokens), 0), COALESCE(SUM(t.output_tokens), 0), \
                COALESCE(SUM(t.cache_read_tokens), 0), \
                COALESCE(SUM(t.cache_write_5m_tokens + t.cache_write_1h_tokens), 0), \
                COALESCE(SUM(t.reasoning_tokens), 0), \
                COALESCE(SUM(t.cost_usd), 0), COALESCE(SUM(t.ingest_cost_usd), 0), \
                COALESCE(SUM(t.generate_cost_usd), 0), \
                COALESCE(SUM(COALESCE(t.duration_ms, 0)), 0), \
                COALESCE(SUM(CASE WHEN COALESCE(t.duration_ms, 0) > 0 THEN 1 ELSE 0 END), 0), \
                COALESCE(SUM(t.tool_calls), 0), COALESCE(SUM(t.tool_errors), 0), \
                MIN(t.ts), MAX(t.ts) \
           FROM turn t \
           JOIN session s ON s.kind = t.kind AND s.session_id = t.session_id \
          WHERE {expression} IN ({placeholders}) \
          GROUP BY {expression}, t.kind, t.session_id, COALESCE(t.model, ''), \
                   COALESCE(t.model_family, ''), COALESCE(t.effort, ''), \
                   COALESCE(s.origin, 'unknown'), COALESCE(s.is_sidechain, 0)"
    );
    let inserted = conn
        .execute(&insert_sql, rusqlite::params_from_iter(unique.iter()))
        .map_err(|err| format!("rebuild rollup days: {err}"))?;
    Ok(inserted)
}

/// Rebuild all currently dirty days, clear the dirty set, and record the
/// version only after the transaction contains a coherent rollup.
pub fn rebuild_dirty(conn: &Connection) -> Result<usize, String> {
    let days = {
        let mut stmt = conn
            .prepare("SELECT day FROM rollup_dirty ORDER BY day")
            .map_err(|err| format!("prepare dirty rollup days: {err}"))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, i64>(0))
            .map_err(|err| format!("read dirty rollup days: {err}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("collect dirty rollup day: {err}"))?
    };
    let inserted = rebuild_days(conn, &days)?;
    conn.execute("DELETE FROM rollup_dirty", [])
        .map_err(|err| format!("clear rebuilt rollup days: {err}"))?;
    conn.execute(
        "INSERT INTO index_state(key, value) VALUES ('rollup_version', ?1) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![VERSION],
    )
    .map_err(|err| format!("record rollup version: {err}"))?;
    Ok(inserted)
}

pub fn version_matches(conn: &Connection) -> Result<bool, String> {
    let current = conn
        .query_row(
            "SELECT value FROM index_state WHERE key = 'rollup_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| format!("read rollup version: {err}"))?;
    Ok(current.as_deref() == Some(VERSION))
}

/// Readers use this pure check to decide whether the complete-day path is safe.
/// They must never attempt a rebuild themselves.
pub fn ready(conn: &Connection) -> Result<bool, String> {
    if !version_matches(conn)? {
        return Ok(false);
    }
    let dirty: i64 = conn
        .query_row("SELECT COUNT(*) FROM rollup_dirty", [], |row| row.get(0))
        .map_err(|err| format!("count dirty rollup days: {err}"))?;
    Ok(dirty == 0)
}
