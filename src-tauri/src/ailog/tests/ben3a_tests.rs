//! Ailog 便3a: default price corrections, catalog migration, and Grok class.

use rusqlite::{params, Connection};

use crate::ailog::price::{self, ModelClass, PriceTable, DEFAULT_PRICES};

fn memory_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::ailog::schema::init(&conn).unwrap();
    conn
}

fn price_row(conn: &Connection, model: &str) -> (f64, f64, f64, String) {
    conn.query_row(
        "SELECT input_per_mtok, output_per_mtok, cache_read_per_mtok, source \
         FROM price WHERE model = ?1",
        params![model],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )
    .unwrap()
}

fn generation(conn: &Connection) -> u64 {
    conn.query_row(
        "SELECT value FROM index_state WHERE key = 'price_generation'",
        [],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|value| value.parse().ok())
    .unwrap_or(0)
}

fn default_by_name(name: &str) -> price::Price {
    DEFAULT_PRICES
        .iter()
        .find(|(model, _)| *model == name)
        .map(|(_, price)| *price)
        .unwrap()
}

// T1
#[test]
fn t1_terra_and_luna_default_rates() {
    let terra = default_by_name("gpt-5.6-terra");
    assert_eq!(terra.input, 2.0);
    assert_eq!(terra.output, 12.0);
    assert_eq!(terra.cache_read, 0.20);

    let luna = default_by_name("gpt-5.6-luna");
    assert_eq!(luna.input, 0.20);
    assert_eq!(luna.output, 1.20);
    assert_eq!(luna.cache_read, 0.02);
}

// T2
#[test]
fn t2_gpt55_and_gpt54_exist_spark_and_grok_do_not() {
    let names: Vec<&str> = DEFAULT_PRICES.iter().map(|(model, _)| *model).collect();
    assert!(names.contains(&"gpt-5.5"));
    assert!(names.contains(&"gpt-5.4"));
    assert!(!names.iter().any(|name| name.contains("spark")));
    assert!(!names.iter().any(|name| name.to_ascii_lowercase().contains("grok")));
}

// T3
#[test]
fn t3_migrate_updates_stale_default_rows() {
    let conn = memory_db();
    conn.execute(
        "UPDATE price SET input_per_mtok = 2.5, output_per_mtok = 15.0, \
         cache_read_per_mtok = 0.20, cache_write_5m_per_mtok = 2.5, \
         cache_write_1h_per_mtok = 2.5 \
         WHERE model = 'gpt-5.6-terra' AND source = 'default'",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE price SET input_per_mtok = 1.0, output_per_mtok = 6.0, \
         cache_read_per_mtok = 0.02, cache_write_5m_per_mtok = 1.0, \
         cache_write_1h_per_mtok = 1.0 \
         WHERE model = 'gpt-5.6-luna' AND source = 'default'",
        [],
    )
    .unwrap();

    crate::ailog::migrate::apply(&conn).unwrap();

    let terra = price_row(&conn, "gpt-5.6-terra");
    assert_eq!(terra.0, 2.0);
    assert_eq!(terra.1, 12.0);
    assert_eq!(terra.2, 0.20);
    assert_eq!(terra.3, "default");

    let luna = price_row(&conn, "gpt-5.6-luna");
    assert_eq!(luna.0, 0.20);
    assert_eq!(luna.1, 1.20);
    assert_eq!(luna.2, 0.02);
    assert_eq!(luna.3, "default");
}

// T4
#[test]
fn t4_user_price_rows_are_untouched() {
    let conn = memory_db();
    conn.execute(
        "UPDATE price SET input_per_mtok = 99.0, output_per_mtok = 88.0, \
         cache_read_per_mtok = 77.0, cache_write_5m_per_mtok = 66.0, \
         cache_write_1h_per_mtok = 55.0, source = 'user', updated_at = 111 \
         WHERE model = 'gpt-5.6-terra'",
        [],
    )
    .unwrap();
    let before: (f64, f64, f64, f64, f64, String, i64) = conn
        .query_row(
            "SELECT input_per_mtok, output_per_mtok, cache_read_per_mtok, \
             cache_write_5m_per_mtok, cache_write_1h_per_mtok, source, updated_at \
             FROM price WHERE model = 'gpt-5.6-terra'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .unwrap();

    crate::ailog::migrate::apply(&conn).unwrap();

    let after: (f64, f64, f64, f64, f64, String, i64) = conn
        .query_row(
            "SELECT input_per_mtok, output_per_mtok, cache_read_per_mtok, \
             cache_write_5m_per_mtok, cache_write_1h_per_mtok, source, updated_at \
             FROM price WHERE model = 'gpt-5.6-terra'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(before, after);
}

// T5
#[test]
fn t5_migrate_increments_price_generation() {
    let conn = memory_db();
    let before = generation(&conn);
    crate::ailog::migrate::apply(&conn).unwrap();
    let after = generation(&conn);
    assert!(after > before, "generation {after} should exceed {before}");
}

// T6
#[test]
fn t6_migrate_is_idempotent() {
    let conn = memory_db();
    crate::ailog::migrate::apply(&conn).unwrap();
    let gen_once = generation(&conn);
    let rows_once: Vec<(String, f64, f64, f64, f64, f64, String, i64)> = {
        let mut stmt = conn
            .prepare(
                "SELECT model, input_per_mtok, output_per_mtok, cache_read_per_mtok, \
                 cache_write_5m_per_mtok, cache_write_1h_per_mtok, source, updated_at \
                 FROM price ORDER BY model",
            )
            .unwrap();
        stmt.query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
            ))
        })
        .unwrap()
        .map(|row| row.unwrap())
        .collect()
    };

    crate::ailog::migrate::apply(&conn).unwrap();

    let gen_twice = generation(&conn);
    let rows_twice: Vec<(String, f64, f64, f64, f64, f64, String, i64)> = {
        let mut stmt = conn
            .prepare(
                "SELECT model, input_per_mtok, output_per_mtok, cache_read_per_mtok, \
                 cache_write_5m_per_mtok, cache_write_1h_per_mtok, source, updated_at \
                 FROM price ORDER BY model",
            )
            .unwrap();
        stmt.query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
            ))
        })
        .unwrap()
        .map(|row| row.unwrap())
        .collect()
    };
    assert_eq!(gen_once, gen_twice);
    assert_eq!(rows_once, rows_twice);
}

// T12
#[test]
fn t12_classify_grok_as_reported() {
    let table = PriceTable::from_defaults();
    assert_eq!(table.classify("grok-4.6-build"), ModelClass::Reported);
    assert_eq!(table.classify("grok-4.6"), ModelClass::Reported);
    assert_ne!(table.classify("grok-4.6-build"), ModelClass::Unknown);
}
