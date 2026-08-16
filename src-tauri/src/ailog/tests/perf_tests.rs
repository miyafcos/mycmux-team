use std::env;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use crate::ailog::{query, Filters, Range};

#[derive(Serialize)]
struct MeasuredReport {
    name: &'static str,
    timings: query::ReportTimings,
}

#[derive(Serialize)]
struct Scenario {
    name: &'static str,
    reports: Vec<MeasuredReport>,
}

#[derive(Serialize)]
struct PerfResult {
    db_path: String,
    query_only: i64,
    scenarios: Vec<Scenario>,
}

fn days_range(now_ms: i64, days: i64) -> Range {
    let day_ms = 86_400_000;
    let offset = query::DAY_BOUNDARY_OFFSET_MIN * 60_000;
    let current_day = (now_ms + offset) / day_ms;
    // Deliberately keep both ends inside a JST day.  The production rollup path
    // must combine these raw edges with complete days from the daily table.
    let to = current_day * day_ms - offset - 12 * 60 * 60 * 1_000 + 123;
    Range {
        from: Some(to - days * day_ms),
        to: Some(to),
        preset: None,
    }
}

/// Create a reproducible, disposable measurement database through the product
/// indexer.  This is deliberately ignored: callers must provide a fresh path
/// outside the production database, then pass the result to the read-only
/// measurement below.
#[test]
#[ignore = "set AILOG_ROLLUP_BUILD_DB to a fresh temporary database path"]
fn build_rollup_measurement_database() {
    let db_path = PathBuf::from(
        env::var("AILOG_ROLLUP_BUILD_DB").expect("AILOG_ROLLUP_BUILD_DB is required"),
    );
    assert!(
        !db_path.exists(),
        "measurement database path must be new: {}",
        db_path.display()
    );
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("build index runtime");
    let report = runtime
        .block_on(crate::ailog::index::run_index(
            crate::ailog::index::IndexOptions::new(db_path.clone()),
            Arc::new(AtomicBool::new(false)),
            None,
        ))
        .expect("index measurement database");
    assert!(!report.cancelled, "measurement index was cancelled");
    let conn = crate::ailog::open_db(&db_path).expect("open indexed database");
    assert!(crate::ailog::rollup::ready(&conn).expect("rollup ready"));
    let rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM rollup_turn_session_day", [], |row| {
            row.get(0)
        })
        .expect("count rollup rows");
    println!(
        "AILOG_ROLLUP_BUILD_JSON={}",
        serde_json::json!({
            "db_path": db_path.display().to_string(),
            "files_done": report.files_done,
            "sessions": report.sessions,
            "rollup_rows": rows,
        })
    );
}

/// The PowerShell harness executes this explicitly against a live database.
/// It must keep the connection read-only even if a future database helper
/// gains initialization behavior.
#[test]
#[ignore = "run only through scripts/perf/measure-mycmux.ps1"]
fn measure_live_database_reports_read_only() {
    let db_path = PathBuf::from(env::var("AILOG_PERF_DB").expect("AILOG_PERF_DB is required"));
    let conn = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("open live ailog database read-only");
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .expect("set read-only busy timeout");
    conn.execute_batch("PRAGMA query_only=ON")
        .expect("enable query_only");
    let query_only: i64 = conn
        .query_row("PRAGMA query_only", [], |row| row.get(0))
        .expect("read query_only pragma");
    assert_eq!(query_only, 1, "performance runs must stay query-only");
    assert!(
        crate::ailog::rollup::ready(&conn).expect("read rollup state"),
        "performance evidence requires a current rollup; build a disposable database first"
    );

    let now_ms = chrono::Utc::now().timestamp_millis();
    let filters = Filters::default();
    // The dashboard requests these reports as a batch. Prime only SQLite's
    // in-process read cache with the largest measured range; this stays on the
    // same query-only connection and keeps the recorded values comparable
    // across the following report calls.
    let warm_range = days_range(now_ms, 90);
    query::series(
        &conn,
        &warm_range,
        &filters,
        &query::SeriesOptions::default(),
        now_ms,
    )
    .expect("warm rollup series");
    for dimension in ["model", "project", "branch", "effort", "origin"] {
        query::breakdown(&conn, &warm_range, &filters, dimension, now_ms)
            .expect("warm rollup breakdown");
    }
    let mut scenarios = Vec::new();
    for (name, range) in [
        ("30d_rollup_series_breakdowns", days_range(now_ms, 30)),
        ("90d_rollup_series_breakdowns", days_range(now_ms, 90)),
    ] {
        let reports = vec![
            MeasuredReport {
                name: "series",
                timings: query::series(
                    &conn,
                    &range,
                    &filters,
                    &query::SeriesOptions {
                        bucket: "day".to_string(),
                        group_by: "none".to_string(),
                    },
                    now_ms,
                )
                .expect("measure series")
                .timings,
            },
            MeasuredReport {
                name: "breakdown_model",
                timings: query::breakdown(&conn, &range, &filters, "model", now_ms)
                    .expect("measure breakdown")
                    .timings,
            },
            MeasuredReport {
                name: "breakdown_project",
                timings: query::breakdown(&conn, &range, &filters, "project", now_ms)
                    .expect("measure breakdown project")
                    .timings,
            },
            MeasuredReport {
                name: "breakdown_branch",
                timings: query::breakdown(&conn, &range, &filters, "branch", now_ms)
                    .expect("measure breakdown branch")
                    .timings,
            },
            MeasuredReport {
                name: "breakdown_effort",
                timings: query::breakdown(&conn, &range, &filters, "effort", now_ms)
                    .expect("measure breakdown effort")
                    .timings,
            },
            MeasuredReport {
                name: "breakdown_origin",
                timings: query::breakdown(&conn, &range, &filters, "origin", now_ms)
                    .expect("measure breakdown origin")
                    .timings,
            },
        ];
        for report in &reports {
            assert_eq!(report.timings.path, "rollup", "{} {}", name, report.name);
            assert!(
                report.timings.sql_ms + report.timings.build_ms < 150,
                "{} {} exceeded 150ms: sql={} build={}",
                name,
                report.name,
                report.timings.sql_ms,
                report.timings.build_ms,
            );
        }
        scenarios.push(Scenario { name, reports });
    }
    let range = days_range(now_ms, 30);
    scenarios.push(Scenario {
        name: "30d_efficiency",
        reports: vec![MeasuredReport {
            name: "efficiency",
            timings: query::efficiency(&conn, &range, &filters, now_ms)
                .expect("measure efficiency")
                .timings,
        }],
    });

    println!(
        "AILOG_PERF_JSON={}",
        serde_json::to_string(&PerfResult {
            db_path: db_path.display().to_string(),
            query_only,
            scenarios,
        })
        .expect("serialize performance result")
    );
}
