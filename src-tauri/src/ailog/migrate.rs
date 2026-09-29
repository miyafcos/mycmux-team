//! Additive schema extensions for the AI log cache.

use rusqlite::{params, Connection, OptionalExtension};

use crate::ailog::price::{PriceTable, DEFAULT_PRICES};

const VERSION: i64 = 2;
const PRICE_CATALOG_VERSION: &str = "2";

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
    if current < VERSION {
        conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS ix_tool_event_ts ON tool_event(ts);
         CREATE INDEX IF NOT EXISTS ix_file_touch_last_ts ON file_touch(last_ts);
         CREATE INDEX IF NOT EXISTS ix_source_file_session ON source_file(kind, session_id);
         CREATE INDEX IF NOT EXISTS ix_turn_session_ts ON turn(kind, session_id, ts);",
    )
    .map_err(|err| format!("apply ailog indexes: {err}"))?;
        if current < 2 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS rollup_turn_session_day (
               day INTEGER NOT NULL,
               kind TEXT NOT NULL,
               session_id TEXT NOT NULL,
               model TEXT NOT NULL DEFAULT '',
               model_family TEXT NOT NULL DEFAULT '',
               effort TEXT NOT NULL DEFAULT '',
               origin TEXT NOT NULL DEFAULT 'unknown',
               is_sidechain INTEGER NOT NULL DEFAULT 0,
               turns INTEGER NOT NULL DEFAULT 0,
               input_tokens INTEGER NOT NULL DEFAULT 0,
               output_tokens INTEGER NOT NULL DEFAULT 0,
               cache_read_tokens INTEGER NOT NULL DEFAULT 0,
               cache_write_tokens INTEGER NOT NULL DEFAULT 0,
               reasoning_tokens INTEGER NOT NULL DEFAULT 0,
               cost_usd REAL NOT NULL DEFAULT 0,
               ingest_cost_usd REAL NOT NULL DEFAULT 0,
               generate_cost_usd REAL NOT NULL DEFAULT 0,
               duration_ms INTEGER NOT NULL DEFAULT 0,
               timed_turns INTEGER NOT NULL DEFAULT 0,
               tool_calls INTEGER NOT NULL DEFAULT 0,
               tool_errors INTEGER NOT NULL DEFAULT 0,
               first_ts INTEGER NOT NULL,
               last_ts INTEGER NOT NULL,
               PRIMARY KEY (day, kind, session_id, model, model_family, effort, origin, is_sidechain)
             ) WITHOUT ROWID;
             CREATE INDEX IF NOT EXISTS ix_rollup_turn_session_day_session
               ON rollup_turn_session_day(kind, session_id);
             CREATE TABLE IF NOT EXISTS rollup_dirty (day INTEGER PRIMARY KEY);",
        )
        .map_err(|err| format!("apply ailog rollup schema: {err}"))?;
        }
        conn.execute(
        "INSERT INTO index_state(key,value) VALUES ('schema_ext_version',?1) \
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![VERSION.to_string()],
    )
    .map_err(|err| format!("record ailog schema extension: {err}"))?;
    }
    apply_price_catalog(conn)?;
    Ok(())
}

fn apply_price_catalog(conn: &Connection) -> Result<(), String> {
    let current: Option<String> = conn
        .query_row(
            "SELECT value FROM index_state WHERE key = 'price_catalog_version'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("read price_catalog_version: {err}"))?;
    if current.as_deref() == Some(PRICE_CATALOG_VERSION) {
        return Ok(());
    }

    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("begin price catalog: {err}"))?;
    for (model, price) in DEFAULT_PRICES {
        tx.execute(
            "UPDATE price SET input_per_mtok = ?2, output_per_mtok = ?3, \
             cache_read_per_mtok = ?4, cache_write_5m_per_mtok = ?5, \
             cache_write_1h_per_mtok = ?6 \
             WHERE model = ?1 AND source = 'default'",
            params![
                model,
                price.input,
                price.output,
                price.cache_read,
                price.cache_write_5m,
                price.cache_write_1h,
            ],
        )
        .map_err(|err| format!("update default price {model}: {err}"))?;
    }
    tx.execute(
        "INSERT INTO index_state (key, value) VALUES ('price_generation', '1') \
         ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1",
        [],
    )
    .map_err(|err| format!("bump price generation: {err}"))?;
    let prices = PriceTable::load(&tx)?;
    crate::ailog::index::reprice_all_in_transaction(&tx, &prices)?;
    tx.execute(
        "INSERT INTO index_state(key,value) VALUES ('price_catalog_version', ?1) \
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![PRICE_CATALOG_VERSION],
    )
    .map_err(|err| format!("write price_catalog_version: {err}"))?;
    tx.commit()
        .map_err(|err| format!("commit price catalog: {err}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    #[test]
    fn indexes_are_idempotent_and_preserve_rows() {
        let conn = Connection::open_in_memory().unwrap();
        crate::ailog::schema::init(&conn).unwrap();
        conn.execute(
            "INSERT INTO session(kind,session_id) VALUES ('codex','s')",
            [],
        )
        .unwrap();
        super::apply(&conn).unwrap();
        super::apply(&conn).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN ('ix_tool_event_ts','ix_file_touch_last_ts','ix_source_file_session','ix_turn_session_ts')", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 4);
        assert_eq!(
            conn.query_row::<String, _, _>(
                "SELECT value FROM index_state WHERE key='schema_ext_version'",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            "2"
        );
        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' \
             AND name IN ('rollup_turn_session_day', 'rollup_dirty')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 2);
        let preserved: String = conn
            .query_row(
                "SELECT session_id FROM session WHERE kind='codex' AND session_id='s'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(preserved, "s");
    }
}
