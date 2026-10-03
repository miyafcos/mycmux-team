//! Saved reports must survive connection/process boundaries without ever
//! masquerading as newly computed reports. All mutations use scratch indexes.

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use super::fixtures::*;
use crate::ailog::{db, query, report_cache, usage, Filters, Range, KIND_CLAUDE};

const NOW: i64 = 1_800_000_000_000;

fn fixture() -> Fixture {
    let fx = Fixture::new();
    fx.write("split.jsonl", CLAUDE_SPLIT_REQUEST);
    fx.write("io.jsonl", CLAUDE_IO_SESSION);
    fx.index(KIND_CLAUDE, false);
    fx
}

fn range() -> Range {
    Range {
        preset: Some("all".into()),
        anchor: Some(NOW),
        ..Default::default()
    }
}

fn filters(mode: report_cache::CacheMode) -> Filters {
    Filters {
        report_cache: Some(mode),
        ..Default::default()
    }
}

fn saved_copy(fx: &Fixture) -> Connection {
    let reader = db::reader(&fx.db).unwrap();
    query::overview(
        &reader,
        &range(),
        &filters(report_cache::CacheMode::Refresh),
        NOW,
    )
    .unwrap();
    let cache = report_cache::path(&reader).unwrap();
    drop(reader);
    Connection::open(cache).unwrap()
}

fn value(report: impl Serialize) -> serde_json::Value {
    let mut out = serde_json::to_value(report).unwrap();
    out.as_object_mut().unwrap().remove("cache");
    out
}

#[test]
fn five_reports_round_trip_after_reopening_a_query_only_source() {
    let fx = fixture();
    let conn = db::reader(&fx.db).unwrap();
    let fresh = filters(report_cache::CacheMode::Refresh);
    let series = query::SeriesOptions {
        bucket: "day".into(),
        group_by: "model_raw".into(),
    };
    let pivot = query::PivotOptions::default();
    let overview = query::overview(&conn, &range(), &fresh, NOW).unwrap();
    let timeline = query::series(&conn, &range(), &fresh, &series, NOW).unwrap();
    let breakdown = query::breakdown(&conn, &range(), &fresh, "project", NOW).unwrap();
    let cross = query::pivot(&conn, &range(), &fresh, &pivot, NOW).unwrap();
    let rhythm = usage::rhythm(&conn, &range(), &fresh, NOW).unwrap();
    assert!(overview.cache.is_none());
    let revision: String = conn
        .query_row(
            "SELECT value FROM index_state WHERE key='report_revision'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    drop(conn);

    let conn = db::reader(&fx.db).unwrap();
    let prefer = filters(report_cache::CacheMode::Prefer);
    let a = query::overview(&conn, &range(), &prefer, NOW).unwrap();
    let b = query::series(&conn, &range(), &prefer, &series, NOW).unwrap();
    let c = query::breakdown(&conn, &range(), &prefer, "project", NOW).unwrap();
    let d = query::pivot(&conn, &range(), &prefer, &pivot, NOW).unwrap();
    let e = usage::rhythm(&conn, &range(), &prefer, NOW).unwrap();
    for info in [&a.cache, &b.cache, &c.cache, &d.cache, &e.cache] {
        let info = info.as_ref().expect("persistent hit");
        assert!(!info.stale);
        assert!(info.saved_at > 0);
    }
    assert_eq!(value(a), value(overview));
    assert_eq!(value(b), value(timeline));
    assert_eq!(value(c), value(breakdown));
    assert_eq!(value(d), value(cross));
    assert_eq!(value(e), value(rhythm));
    assert_eq!(
        conn.query_row("PRAGMA query_only", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row(
            "SELECT value FROM index_state WHERE key='report_revision'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        revision
    );
}

#[test]
fn relative_period_preserves_saved_bounds_and_refresh_uses_the_new_anchor() {
    let fx = fixture();
    let conn = db::reader(&fx.db).unwrap();
    query::overview(
        &conn,
        &range(),
        &filters(report_cache::CacheMode::Refresh),
        NOW,
    )
    .unwrap();
    let next = Range {
        anchor: Some(NOW + 300_000),
        ..range()
    };
    let saved =
        query::overview(&conn, &next, &filters(report_cache::CacheMode::Prefer), NOW).unwrap();
    assert!(saved.cache.unwrap().stale);
    assert_eq!(saved.range.to, NOW);
    let updated = query::overview(
        &conn,
        &next,
        &filters(report_cache::CacheMode::Refresh),
        NOW,
    )
    .unwrap();
    assert!(updated.cache.is_none());
    assert_eq!(updated.range.to, NOW + 300_000);
}

#[test]
fn incremental_indexing_marks_a_snapshot_stale_then_replaces_it() {
    let fx = fixture();
    drop(saved_copy(&fx));
    fx.write("mixed.jsonl", CLAUDE_MIXED_MODELS);
    fx.index(KIND_CLAUDE, false);
    let conn = db::reader(&fx.db).unwrap();
    let old = query::overview(
        &conn,
        &range(),
        &filters(report_cache::CacheMode::Prefer),
        NOW,
    )
    .unwrap();
    assert!(old.cache.unwrap().stale);
    assert_eq!(old.totals.turns, 2);
    let current = query::overview(
        &conn,
        &range(),
        &filters(report_cache::CacheMode::Refresh),
        NOW,
    )
    .unwrap();
    assert_eq!(current.totals.turns, 5);
    assert!(current.cache.is_none());
    assert!(
        !query::overview(
            &conn,
            &range(),
            &filters(report_cache::CacheMode::Prefer),
            NOW
        )
        .unwrap()
        .cache
        .unwrap()
        .stale
    );
}

#[test]
fn real_price_edit_invalidates_the_saved_costs() {
    let fx = fixture();
    drop(saved_copy(&fx));
    let mut conn = db::writer(&fx.db).unwrap();
    let entry = query::PriceEntry {
        model: "claude-opus-5".into(),
        input_per_mtok: 100.0,
        output_per_mtok: 200.0,
        cache_read_per_mtok: 30.0,
        cache_write_5m_per_mtok: 50.0,
        cache_write_1h_per_mtok: 70.0,
        source: "user".into(),
        updated_at: NOW,
    };
    assert_eq!(query::set_price(&mut conn, &entry).unwrap(), 2);
    let saved = query::overview(
        &conn,
        &range(),
        &filters(report_cache::CacheMode::Prefer),
        NOW,
    )
    .unwrap();
    assert!(saved.cache.unwrap().stale);
    let current = query::overview(
        &conn,
        &range(),
        &filters(report_cache::CacheMode::Refresh),
        NOW,
    )
    .unwrap();
    assert!(current.totals.cost_usd > saved.totals.cost_usd);
}

#[test]
fn updated_model_classification_and_compiled_classifier_revision_are_stale() {
    let fx = fixture();
    let cache = saved_copy(&fx);
    // Represents a snapshot produced by a different compiled price/classifier
    // source; the current build hashes price.rs, query.rs and usage.rs.
    cache
        .execute(
            "UPDATE report_snapshot SET revision='older-classifier-build'",
            [],
        )
        .unwrap();
    let conn = db::reader(&fx.db).unwrap();
    assert!(
        query::overview(
            &conn,
            &range(),
            &filters(report_cache::CacheMode::Prefer),
            NOW
        )
        .unwrap()
        .cache
        .unwrap()
        .stale
    );
    query::overview(
        &conn,
        &range(),
        &filters(report_cache::CacheMode::Refresh),
        NOW,
    )
    .unwrap();
    db::writer(&fx.db)
        .unwrap()
        .execute("UPDATE turn SET model_family='updated-family'", [])
        .unwrap();
    assert!(
        query::overview(
            &conn,
            &range(),
            &filters(report_cache::CacheMode::Prefer),
            NOW
        )
        .unwrap()
        .cache
        .unwrap()
        .stale
    );
}

#[test]
fn parser_cursors_do_not_replace_source_revisions_or_report_flags() {
    let fx = fixture();
    drop(saved_copy(&fx));
    let mut writer = db::writer(&fx.db).unwrap();
    let tx = writer.transaction().unwrap();
    {
        let mut insert = tx
            .prepare("INSERT INTO index_state(key,value) VALUES (?1,?2)")
            .unwrap();
        for i in 0..20_000 {
            insert
                .execute(rusqlite::params![
                    format!("codex_ps:fixture-{i}"),
                    "parser offset only"
                ])
                .unwrap();
        }
    }
    tx.commit().unwrap();
    let reader = db::reader(&fx.db).unwrap();
    let prefer = filters(report_cache::CacheMode::Prefer);
    assert!(
        !query::overview(&reader, &range(), &prefer, NOW)
            .unwrap()
            .cache
            .unwrap()
            .stale
    );
    // Non-cursor report policy changes still invalidate. The two seek ranges
    // must retain both sides of the skipped prefix, not whitelist known keys.
    writer
        .execute(
            "INSERT INTO index_state(key,value) VALUES ('aaa_report_policy','2')",
            [],
        )
        .unwrap();
    assert!(
        query::overview(&reader, &range(), &prefer, NOW)
            .unwrap()
            .cache
            .unwrap()
            .stale
    );
    query::overview(
        &reader,
        &range(),
        &filters(report_cache::CacheMode::Refresh),
        NOW,
    )
    .unwrap();
    writer
        .execute(
            "INSERT INTO index_state(key,value) VALUES ('zzz_report_policy','2')",
            [],
        )
        .unwrap();
    assert!(
        query::overview(&reader, &range(), &prefer, NOW)
            .unwrap()
            .cache
            .unwrap()
            .stale
    );
}

#[test]
fn rolled_back_source_changes_do_not_invalidate_a_committed_snapshot() {
    let fx = fixture();
    drop(saved_copy(&fx));
    let mut writer = db::writer(&fx.db).unwrap();
    let tx = writer.transaction().unwrap();
    tx.execute("UPDATE turn SET output_tokens=999", []).unwrap();
    tx.rollback().unwrap();
    let reader = db::reader(&fx.db).unwrap();
    assert!(
        !query::overview(
            &reader,
            &range(),
            &filters(report_cache::CacheMode::Prefer),
            NOW
        )
        .unwrap()
        .cache
        .unwrap()
        .stale
    );
}

#[test]
fn incompatible_versions_and_corrupt_json_are_rebuilt() {
    let fx = fixture();
    let cache = saved_copy(&fx);
    let conn = db::reader(&fx.db).unwrap();
    for sql in [
        "UPDATE report_snapshot SET version=999",
        "UPDATE report_snapshot SET payload='{broken'",
    ] {
        cache.execute(sql, []).unwrap();
        let report = query::overview(
            &conn,
            &range(),
            &filters(report_cache::CacheMode::Prefer),
            NOW,
        )
        .unwrap();
        assert!(report.cache.is_none());
        assert_eq!(report.totals.turns, 2);
        assert!(query::overview(
            &conn,
            &range(),
            &filters(report_cache::CacheMode::Prefer),
            NOW
        )
        .unwrap()
        .cache
        .is_some());
    }
}

#[test]
fn corrupt_cache_database_falls_back_to_a_fresh_report() {
    let fx = fixture();
    let conn = db::reader(&fx.db).unwrap();
    std::fs::write(report_cache::path(&conn).unwrap(), b"not sqlite").unwrap();
    let report = query::overview(
        &conn,
        &range(),
        &filters(report_cache::CacheMode::Prefer),
        NOW,
    )
    .unwrap();
    assert!(report.cache.is_none());
    assert_eq!(report.totals.turns, 2);
}

#[test]
fn period_filters_and_axes_do_not_share_incompatible_results() {
    let fx = fixture();
    let conn = db::reader(&fx.db).unwrap();
    let prefer = filters(report_cache::CacheMode::Prefer);
    let day = query::SeriesOptions {
        bucket: "day".into(),
        group_by: "model_raw".into(),
    };
    query::series(&conn, &range(), &prefer, &day, NOW).unwrap();
    let week = query::SeriesOptions {
        bucket: "week".into(),
        group_by: "provider".into(),
    };
    assert!(query::series(&conn, &range(), &prefer, &week, NOW)
        .unwrap()
        .cache
        .is_none());
    let selected = Filters {
        projects: vec!["alpha".into()],
        ..prefer.clone()
    };
    assert!(query::series(&conn, &range(), &selected, &day, NOW)
        .unwrap()
        .cache
        .is_none());
    let period = Range {
        from: Some(0),
        to: Some(1),
        ..Default::default()
    };
    assert!(query::series(&conn, &period, &prefer, &day, NOW)
        .unwrap()
        .cache
        .is_none());
    let pivot = query::PivotOptions::default();
    query::pivot(&conn, &range(), &prefer, &pivot, NOW).unwrap();
    let swapped = query::PivotOptions {
        row_by: pivot.col_by.clone(),
        col_by: pivot.row_by.clone(),
    };
    assert!(query::pivot(&conn, &range(), &prefer, &swapped, NOW)
        .unwrap()
        .cache
        .is_none());
}

#[test]
fn late_old_anchor_does_not_overwrite_a_newer_saved_window() {
    let fx = fixture();
    let conn = db::reader(&fx.db).unwrap();
    let fresh = filters(report_cache::CacheMode::Refresh);
    let next = Range {
        anchor: Some(NOW + 300_000),
        ..range()
    };
    query::overview(&conn, &next, &fresh, NOW).unwrap();
    query::overview(&conn, &range(), &fresh, NOW).unwrap();
    let saved =
        query::overview(&conn, &next, &filters(report_cache::CacheMode::Prefer), NOW).unwrap();
    assert_eq!(saved.range.to, NOW + 300_000);
    assert!(!saved.cache.unwrap().stale);
}

#[test]
fn default_and_memory_queries_do_not_require_a_persistent_cache() {
    let fx = fixture();
    let conn = db::reader(&fx.db).unwrap();
    assert!(query::overview(&conn, &range(), &Filters::default(), NOW)
        .unwrap()
        .cache
        .is_none());
    assert!(!report_cache::path(&conn).unwrap().exists());
    let conn = Connection::open_in_memory().unwrap();
    crate::ailog::schema::init(&conn).unwrap();
    assert!(report_cache::path(&conn).is_none());
    assert!(query::overview(
        &conn,
        &range(),
        &filters(report_cache::CacheMode::Prefer),
        NOW
    )
    .unwrap()
    .cache
    .is_none());
}

#[test]
fn snapshot_count_is_bounded() {
    let fx = fixture();
    let conn = db::reader(&fx.db).unwrap();
    for i in 0..132 {
        let window = Range {
            from: Some(i),
            to: Some(i + 1),
            ..Default::default()
        };
        query::overview(
            &conn,
            &window,
            &filters(report_cache::CacheMode::Refresh),
            NOW,
        )
        .unwrap();
    }
    let cache = Connection::open(report_cache::path(&conn).unwrap()).unwrap();
    assert_eq!(
        cache
            .query_row("SELECT COUNT(*) FROM report_snapshot", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        128
    );
}

// serde_json's default float parser may differ by one ULP after a persisted
// round trip. Counts, keys, classifications and strings must still match exactly.
fn assert_snapshot_metrics(left: &serde_json::Value, right: &serde_json::Value, path: &str) {
    use serde_json::Value;
    match (left, right) {
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(a.len(), b.len(), "snapshot field count at {path}");
            for (key, value) in a {
                let other = b.get(key).expect("snapshot field missing");
                assert_snapshot_metrics(value, other, &format!("{path}.{key}"));
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "snapshot row count at {path}");
            for (i, (x, y)) in a.iter().zip(b).enumerate() {
                assert_snapshot_metrics(x, y, &format!("{path}[{i}]"));
            }
        }
        (Value::Number(a), Value::Number(b)) if a.is_f64() || b.is_f64() => {
            let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            let tolerance = 4.0 * f64::EPSILON * a.abs().max(b.abs()).max(1.0);
            assert!(
                (a - b).abs() <= tolerance,
                "snapshot float mismatch at {path}: {a} vs {b}"
            );
        }
        _ => assert!(left == right, "snapshot field mismatch at {path}"),
    }
}

// Explicitly run on a READ-ONLY, transactionally backed-up copy of the real
// index. The live Windows index is never opened by this test. Each iteration
// reopens the source, exercising the persistent rather than renderer cache.
#[test]
#[ignore = "requires MYCMUX_S6_BENCH_DB pointing to the scratch real-data copy"]
fn real_data_snapshot_benchmark() {
    use std::time::Instant;
    let path = std::path::PathBuf::from(std::env::var("MYCMUX_S6_BENCH_DB").expect("scratch DB"));
    let output =
        std::path::PathBuf::from(std::env::var("MYCMUX_S6_BENCH_OUT").expect("output JSON"));
    // Cargo executes lib tests with src-tauri as the current directory.
    // Resolve against this worktree's manifest, and reject symlink/.. escapes.
    let allowed = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("dist/s6-cache-evidence")
        .canonicalize()
        .unwrap();
    let path = path.canonicalize().unwrap();
    assert!(path.starts_with(&allowed));
    assert_eq!(path.file_name().unwrap(), "ailog-s6-copy.db");
    // Schema/revision setup writes only to this explicitly named scratch copy.
    db::ensure_initialized(&path).unwrap();
    let iterations: usize = std::env::var("MYCMUX_S6_BENCH_RUNS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(20);
    assert!(iterations >= 3);
    let seed = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    seed.execute_batch("PRAGMA query_only=ON").unwrap();
    let turns: i64 = seed
        .query_row("SELECT COUNT(*) FROM turn", [], |r| r.get(0))
        .unwrap();
    let sessions: i64 = seed
        .query_row("SELECT COUNT(*) FROM session", [], |r| r.get(0))
        .unwrap();
    let anchor = chrono::Utc::now().timestamp_millis();
    let series = query::SeriesOptions {
        bucket: "day".into(),
        group_by: "model_raw".into(),
    };
    let mut results = Vec::new();
    for preset in ["30d", "90d", "all"] {
        let window = Range {
            preset: Some(preset.into()),
            anchor: Some(anchor),
            ..Default::default()
        };
        let fresh = filters(report_cache::CacheMode::Refresh);
        let prefer = filters(report_cache::CacheMode::Prefer);
        // Prime both persistent reports on the scratch copy, then measure
        // baseline -> saved -> background refresh in every iteration.
        query::overview(&seed, &window, &fresh, anchor).unwrap();
        query::series(&seed, &window, &fresh, &series, anchor).unwrap();
        let mut before = Vec::new();
        let mut first = Vec::new();
        let mut latest = Vec::new();
        for i in 0..iterations {
            let conn =
                Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            conn.execute_batch("PRAGMA query_only=ON").unwrap();
            let start = Instant::now();
            let old_overview =
                query::overview(&conn, &window, &Filters::default(), anchor).unwrap();
            let old_series =
                query::series(&conn, &window, &Filters::default(), &series, anchor).unwrap();
            before.push(start.elapsed().as_secs_f64() * 1000.0);
            drop(conn);
            let conn =
                Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            conn.execute_batch("PRAGMA query_only=ON").unwrap();
            let start = Instant::now();
            let saved_overview = query::overview(&conn, &window, &prefer, anchor).unwrap();
            let saved_series = query::series(&conn, &window, &prefer, &series, anchor).unwrap();
            first.push(start.elapsed().as_secs_f64() * 1000.0);
            assert!(saved_overview.cache.is_some() && saved_series.cache.is_some());
            let current_overview = query::overview(&conn, &window, &fresh, anchor).unwrap();
            let current_series = query::series(&conn, &window, &fresh, &series, anchor).unwrap();
            latest.push(start.elapsed().as_secs_f64() * 1000.0);
            // Correctness checks run after the timer, outside the UI-readiness
            // interval. Compare all report fields, not only row counts.
            let mut saved_metrics = value(&saved_overview);
            let mut old_metrics = value(&old_overview);
            saved_metrics.as_object_mut().unwrap().remove("timings");
            old_metrics.as_object_mut().unwrap().remove("timings");
            assert_snapshot_metrics(&saved_metrics, &old_metrics, "overview");
            let mut saved_metrics = value(&saved_series);
            let mut old_metrics = value(&old_series);
            saved_metrics.as_object_mut().unwrap().remove("timings");
            old_metrics.as_object_mut().unwrap().remove("timings");
            assert_snapshot_metrics(&saved_metrics, &old_metrics, "series");
            assert_eq!(current_overview.totals.turns, old_overview.totals.turns);
            assert_eq!(current_series.buckets.len(), old_series.buckets.len());
            if i == 0 {
                std::fs::write(output.with_file_name(format!("real-reports-{preset}.json")),
                    serde_json::to_vec(&serde_json::json!({"overview": current_overview, "series": current_series})).unwrap()).unwrap();
            }
        }
        results.push(serde_json::json!({"preset": preset, "beforeMs": before, "firstMs": first, "latestMs": latest}));
    }
    std::fs::write(&output, serde_json::to_vec_pretty(&serde_json::json!({
        "anchor": anchor, "turns": turns, "sessions": sessions,
        "iterations": iterations, "measurement": "native overview + visible series readiness; IPC/render excluded",
        "results": results,
    })).unwrap()).unwrap();
    println!("S6_BENCH_OUTPUT {}", output.display());
}
