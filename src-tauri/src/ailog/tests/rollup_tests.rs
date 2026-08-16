//! Acceptance tests for the session-preserving daily rollup.

use chrono::{TimeZone, Utc};

use super::fixtures::*;
use crate::ailog::{query, rollup, Filters, Range, KIND_CLAUDE};

const NOW: i64 = 1_800_000_000_000;

const PARTIAL_FINAL_EDGE_TURN: &[&str] = &[
    r#"{"type":"assistant","sessionId":"S5","requestId":"edge_1","timestamp":"2026-08-04T11:00:00.000Z","cwd":"C:\\proj\\epsilon","gitBranch":"edge","entrypoint":"cli","uuid":"edge-1","message":{"id":"edge-1","model":"claude-opus-5","role":"assistant","content":[],"usage":{"input_tokens":7,"output_tokens":11,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
];

const INCREMENTAL_FULL_DAY_TURN: &[&str] = &[
    r#"{"type":"assistant","sessionId":"S4","requestId":"q2","timestamp":"2026-08-03T01:00:00.000Z","cwd":"C:\\proj\\delta","entrypoint":"cli","uuid":"y2","message":{"id":"n2","model":"totally-unknown-model-x","role":"assistant","content":[],"usage":{"input_tokens":1000,"output_tokens":2000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
];

fn timestamp(day: u32, hour: u32) -> i64 {
    Utc.with_ymd_and_hms(2026, 8, day, hour, 0, 0)
        .single()
        .unwrap()
        .timestamp_millis()
}

fn report_value(report: impl serde::Serialize) -> serde_json::Value {
    let mut value = serde_json::to_value(report).unwrap();
    fn remove_timings(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(fields) => {
                fields.remove("timings");
                for child in fields.values_mut() {
                    remove_timings(child);
                }
            }
            serde_json::Value::Array(items) => {
                for child in items {
                    remove_timings(child);
                }
            }
            _ => {}
        }
    }
    remove_timings(&mut value);
    // Rollup and raw paths sum floats in different orders; ULP-level drift is
    // expected, so canonicalize every float to 12 significant digits.
    fn round_floats(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Number(n) => {
                if n.as_i64().is_none() && n.as_u64().is_none() {
                    if let Some(f) = n.as_f64() {
                        let rounded = if f == 0.0 {
                            0.0
                        } else {
                            let scale = 10f64.powf(11.0 - f.abs().log10().floor());
                            (f * scale).round() / scale
                        };
                        *value = serde_json::Value::from(rounded);
                    }
                }
            }
            serde_json::Value::Object(fields) => fields.values_mut().for_each(round_floats),
            serde_json::Value::Array(items) => items.iter_mut().for_each(round_floats),
            _ => {}
        }
    }
    round_floats(&mut value);
    value
}

fn corpus_range() -> Range {
    // Both range ends are inside a JST day, exercising the two raw edge spans.
    Range {
        from: Some(timestamp(1, 12)),
        to: Some(timestamp(4, 12)),
        preset: None,
    }
}

fn full_rollup_range() -> Range {
    Range {
        from: Some(timestamp(2, 15)),
        to: Some(timestamp(3, 14) + 3_599_999),
        preset: None,
    }
}

fn populate() -> Fixture {
    let fixture = Fixture::new();
    fixture.write("S1.jsonl", CLAUDE_SPLIT_REQUEST);
    fixture.write("S2.jsonl", CLAUDE_IO_SESSION);
    fixture.write("S3.jsonl", CLAUDE_MIXED_MODELS);
    fixture.write("S4.jsonl", CLAUDE_UNKNOWN_MODEL);
    fixture.write("S5.jsonl", PARTIAL_FINAL_EDGE_TURN);
    fixture.index(KIND_CLAUDE, false);
    fixture
}

fn force_raw(conn: &rusqlite::Connection) {
    conn.execute("INSERT OR IGNORE INTO rollup_dirty(day) VALUES (-1)", [])
        .unwrap();
}

fn restore_rollup(conn: &rusqlite::Connection) {
    conn.execute("DELETE FROM rollup_dirty WHERE day = -1", [])
        .unwrap();
    assert!(rollup::ready(conn).unwrap());
}

#[test]
fn series_and_supported_breakdowns_match_raw_with_partial_days() {
    let fixture = populate();
    let conn = fixture.conn();
    let range = corpus_range();
    let filters = Filters::default();

    let options = query::SeriesOptions {
        bucket: "day".to_string(),
        group_by: "model".to_string(),
    };
    let rolled = query::series(&conn, &range, &filters, &options, NOW).unwrap();
    assert_eq!(rolled.timings.path, "rollup");
    assert_eq!(
        rolled
            .buckets
            .iter()
            .map(|bucket| bucket.turns)
            .sum::<i64>(),
        5,
        "the raw first and final edge spans and the complete middle day all contribute"
    );
    force_raw(&conn);
    let raw = query::series(&conn, &range, &filters, &options, NOW).unwrap();
    assert_eq!(raw.timings.path, "raw");
    restore_rollup(&conn);
    assert_eq!(report_value(rolled), report_value(raw));

    let default_options = query::SeriesOptions::default();
    let rolled = query::series(&conn, &range, &filters, &default_options, NOW).unwrap();
    assert_eq!(rolled.timings.path, "rollup");
    force_raw(&conn);
    let raw = query::series(&conn, &range, &filters, &default_options, NOW).unwrap();
    restore_rollup(&conn);
    assert_eq!(report_value(rolled), report_value(raw));

    for dimension in ["model", "project", "branch", "effort", "origin"] {
        let rolled = query::breakdown(&conn, &range, &filters, dimension, NOW).unwrap();
        assert_eq!(rolled.timings.path, "rollup", "{dimension}");
        force_raw(&conn);
        let raw = query::breakdown(&conn, &range, &filters, dimension, NOW).unwrap();
        restore_rollup(&conn);
        assert_eq!(report_value(rolled), report_value(raw), "{dimension}");
    }
}

#[test]
fn overview_and_sessions_match_raw_with_partial_days() {
    let fixture = populate();
    let conn = fixture.conn();
    let range = corpus_range();
    let filters = Filters::default();
    let options = query::SessionsOptions {
        sort: "recent".to_string(),
        limit: 2,
        offset: 1,
    };

    let rolled_overview = query::overview(&conn, &range, &filters, NOW).unwrap();
    let rolled_sessions = query::sessions(&conn, &range, &filters, &options, NOW).unwrap();
    assert_eq!(rolled_overview.timings.path, "rollup");
    assert_eq!(rolled_sessions.timings.path, "rollup");
    force_raw(&conn);
    let raw_overview = query::overview(&conn, &range, &filters, NOW).unwrap();
    let raw_sessions = query::sessions(&conn, &range, &filters, &options, NOW).unwrap();
    restore_rollup(&conn);
    assert_eq!(report_value(rolled_overview), report_value(raw_overview));
    assert_eq!(report_value(rolled_sessions), report_value(raw_sessions));
}

#[test]
fn incremental_index_refreshes_the_rollup() {
    let fixture = Fixture::new();
    fixture.write("S4.jsonl", CLAUDE_UNKNOWN_MODEL);
    fixture.index(KIND_CLAUDE, false);
    fixture.append("S4.jsonl", INCREMENTAL_FULL_DAY_TURN);
    fixture.index(KIND_CLAUDE, false);
    let conn = fixture.conn();
    assert!(rollup::ready(&conn).unwrap());
    let rollup_turns: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(turns), 0) FROM rollup_turn_session_day",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rollup_turns, 2);

    let range = full_rollup_range();
    let filters = Filters::default();
    let rolled = query::breakdown(&conn, &range, &filters, "model", NOW).unwrap();
    assert_eq!(rolled.timings.path, "rollup");
    assert_eq!(rolled.rows.iter().map(|row| row.turns).sum::<i64>(), 2);
    force_raw(&conn);
    let raw = query::breakdown(&conn, &range, &filters, "model", NOW).unwrap();
    restore_rollup(&conn);
    assert_eq!(report_value(rolled), report_value(raw));
}

#[test]
fn ranges_without_a_complete_day_stay_raw() {
    let fixture = populate();
    let conn = fixture.conn();
    let range = Range {
        from: Some(timestamp(1, 12)),
        to: Some(timestamp(2, 12)),
        preset: None,
    };
    assert_eq!(
        query::series(
            &conn,
            &range,
            &Filters::default(),
            &query::SeriesOptions::default(),
            NOW,
        )
        .unwrap()
        .timings
        .path,
        "raw"
    );
    assert_eq!(
        query::breakdown(&conn, &range, &Filters::default(), "model", NOW)
            .unwrap()
            .timings
            .path,
        "raw"
    );
}

#[test]
fn unsupported_filters_and_dimensions_stay_raw() {
    let fixture = populate();
    let conn = fixture.conn();
    let range = corpus_range();
    let options = query::SeriesOptions::default();

    let min_cost = Filters {
        min_cost: Some(0.0),
        ..Filters::default()
    };
    assert_eq!(
        query::series(&conn, &range, &min_cost, &options, NOW)
            .unwrap()
            .timings
            .path,
        "raw"
    );
    assert_eq!(
        query::overview(&conn, &corpus_range(), &min_cost, NOW)
            .unwrap()
            .timings
            .path,
        "raw"
    );
    let text = Filters {
        query: Some("alpha".to_string()),
        ..Filters::default()
    };
    assert_eq!(
        query::sessions(
            &conn,
            &corpus_range(),
            &text,
            &query::SessionsOptions::default(),
            NOW
        )
        .unwrap()
        .timings
        .path,
        "raw"
    );
    assert_eq!(
        query::breakdown(&conn, &range, &text, "model", NOW)
            .unwrap()
            .timings
            .path,
        "raw"
    );
    for dimension in ["agent", "title", "tag", "kind"] {
        assert_eq!(
            query::breakdown(&conn, &range, &Filters::default(), dimension, NOW)
                .unwrap()
                .timings
                .path,
            "raw",
            "{dimension}"
        );
    }
}

#[test]
fn rollup_day_uses_the_shared_jst_boundary_constant() {
    let fixture = Fixture::new();
    fixture.write("S1.jsonl", CLAUDE_SPLIT_REQUEST);
    fixture.index(KIND_CLAUDE, false);
    let conn = fixture.conn();
    let (ts, day): (i64, i64) = conn
        .query_row(
            "SELECT t.ts, r.day FROM turn t JOIN rollup_turn_session_day r \
             ON r.kind = t.kind AND r.session_id = t.session_id LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        day,
        (ts + query::DAY_BOUNDARY_OFFSET_MIN * 60_000) / 86_400_000
    );
}

#[test]
fn price_edits_rebuild_rollup_costs() {
    let fixture = Fixture::new();
    fixture.write("S4.jsonl", CLAUDE_UNKNOWN_MODEL);
    fixture.index(KIND_CLAUDE, false);
    let mut conn = fixture.conn();
    query::set_price(
        &mut conn,
        &query::PriceEntry {
            model: "totally-unknown-model-x".to_string(),
            input_per_mtok: 1_000_000.0,
            output_per_mtok: 2_000_000.0,
            cache_read_per_mtok: 0.0,
            cache_write_5m_per_mtok: 0.0,
            cache_write_1h_per_mtok: 0.0,
            source: "user".to_string(),
            updated_at: 0,
        },
    )
    .unwrap();
    assert!(rollup::ready(&conn).unwrap());
    let cost: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(cost_usd), 0) FROM rollup_turn_session_day",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!((cost - 5_000.0).abs() < 1e-6);
    assert_eq!(
        query::series(
            &conn,
            &corpus_range(),
            &Filters::default(),
            &query::SeriesOptions::default(),
            NOW,
        )
        .unwrap()
        .timings
        .path,
        "rollup"
    );
}

#[test]
fn failed_price_edit_rolls_back_the_price_and_rollup_state() {
    let fixture = Fixture::new();
    fixture.write("S4.jsonl", CLAUDE_UNKNOWN_MODEL);
    fixture.index(KIND_CLAUDE, false);
    let mut conn = fixture.conn();
    conn.execute_batch(
        "CREATE TRIGGER reject_reprice BEFORE UPDATE ON turn
         BEGIN SELECT RAISE(ABORT, 'reject reprice'); END;",
    )
    .unwrap();

    assert!(query::set_price(
        &mut conn,
        &query::PriceEntry {
            model: "totally-unknown-model-x".to_string(),
            input_per_mtok: 1.0,
            output_per_mtok: 1.0,
            cache_read_per_mtok: 0.0,
            cache_write_5m_per_mtok: 0.0,
            cache_write_1h_per_mtok: 0.0,
            source: "user".to_string(),
            updated_at: 0,
        },
    )
    .is_err());
    let price_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM price WHERE model = 'totally-unknown-model-x'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(price_rows, 0);
    assert!(rollup::ready(&conn).unwrap());
}
