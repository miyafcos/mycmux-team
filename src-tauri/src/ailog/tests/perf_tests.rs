use std::env;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;

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
    repeated: Vec<RepeatedScenario>,
}

#[derive(Serialize)]
struct Distribution {
    runs: usize,
    p50_ms: f64,
    p95_ms: f64,
    min_ms: f64,
    max_ms: f64,
}

#[derive(Serialize)]
struct RepeatedScenario {
    name: &'static str,
    cold: Distribution,
    warm: Distribution,
    sample_rows: usize,
    sample_json_bytes: usize,
    sample_json_bytes_min: usize,
    sample_json_bytes_max: usize,
    note: &'static str,
}

const REPEATED_RUNS: usize = 20;

fn stable_json_bytes<T: Serialize>(value: &T) -> usize {
    fn remove_timings(value: &mut Value) {
        match value {
            Value::Object(map) => {
                map.remove("timings");
                for child in map.values_mut() {
                    remove_timings(child);
                }
            }
            Value::Array(items) => items.iter_mut().for_each(remove_timings),
            _ => {}
        }
    }

    let mut value = serde_json::to_value(value).expect("convert report for stable payload size");
    // Per-report timings are intentionally volatile instrumentation. Excluding
    // them makes the payload guard describe data stability rather than the
    // digit count of a stopwatch value.
    remove_timings(&mut value);
    serde_json::to_vec(&value)
        .expect("serialize stable report payload")
        .len()
}

fn read_only_connection(db_path: &PathBuf) -> Connection {
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("open live ailog database read-only");
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .expect("set read-only busy timeout");
    conn.execute_batch("PRAGMA query_only=ON")
        .expect("enable query_only");
    let query_only: i64 = conn
        .query_row("PRAGMA query_only", [], |row| row.get(0))
        .expect("read query_only pragma");
    assert_eq!(query_only, 1, "performance runs must stay query-only");
    conn
}

fn distribution(mut elapsed_micros: Vec<u64>) -> Distribution {
    assert_eq!(elapsed_micros.len(), REPEATED_RUNS);
    elapsed_micros.sort_unstable();
    let percentile = |numerator: usize, denominator: usize| {
        let index = (elapsed_micros.len() * numerator).div_ceil(denominator) - 1;
        elapsed_micros[index] as f64 / 1_000.0
    };
    Distribution {
        runs: elapsed_micros.len(),
        p50_ms: percentile(50, 100),
        p95_ms: percentile(95, 100),
        min_ms: elapsed_micros[0] as f64 / 1_000.0,
        max_ms: *elapsed_micros.last().expect("non-empty timings") as f64 / 1_000.0,
    }
}

fn measure_repeated<F>(
    db_path: &PathBuf,
    warm_conn: &Connection,
    name: &'static str,
    note: &'static str,
    mut task: F,
) -> RepeatedScenario
where
    F: FnMut(&Connection) -> (usize, usize),
{
    // "Cold" means a new SQLite read-only connection for each iteration.
    // The OS page cache is deliberately not flushed because doing so would
    // require invasive machine-wide operations and would not match product use.
    let mut cold = Vec::with_capacity(REPEATED_RUNS);
    let mut sample_rows = 0;
    let mut payload_sizes = Vec::with_capacity(REPEATED_RUNS * 2);
    for _ in 0..REPEATED_RUNS {
        let started = Instant::now();
        let conn = read_only_connection(db_path);
        let (rows, json_bytes) = task(&conn);
        cold.push(started.elapsed().as_micros().min(u64::MAX as u128) as u64);
        sample_rows = rows;
        payload_sizes.push(json_bytes);
    }

    let mut warm = Vec::with_capacity(REPEATED_RUNS);
    for _ in 0..REPEATED_RUNS {
        let started = Instant::now();
        let (rows, json_bytes) = task(warm_conn);
        warm.push(started.elapsed().as_micros().min(u64::MAX as u128) as u64);
        assert_eq!(rows, sample_rows, "{name} row count changed between runs");
        // The live database can advance between iterations even though this
        // connection is query-only. Keep the observed payload range instead
        // of pretending that a read-only probe freezes the writer's state.
        payload_sizes.push(json_bytes);
    }

    payload_sizes.sort_unstable();
    let sample_json_bytes = payload_sizes[payload_sizes.len() / 2];
    let sample_json_bytes_min = payload_sizes[0];
    let sample_json_bytes_max = *payload_sizes.last().expect("non-empty payload sizes");

    RepeatedScenario {
        name,
        cold: distribution(cold),
        warm: distribution(warm),
        sample_rows,
        sample_json_bytes,
        sample_json_bytes_min,
        sample_json_bytes_max,
        note,
    }
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
        anchor: None,
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
    let conn = read_only_connection(&db_path);
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

    let current_range = Range {
        from: None,
        to: None,
        preset: Some("30d".to_string()),
        anchor: None,
    };
    let legacy_cost_options = query::SessionsOptions {
        sort: "cost".to_string(),
        limit: 5_000,
        offset: 0,
    };
    let current_cost_options = query::SessionsOptions {
        sort: "cost".to_string(),
        limit: 100,
        offset: 0,
    };
    let legacy_rework_options = query::SessionsOptions {
        sort: "rework".to_string(),
        limit: 5_000,
        offset: 0,
    };
    let current_rework_options = query::SessionsOptions {
        sort: "rework".to_string(),
        limit: 100,
        offset: 0,
    };
    let mut search_filters = Filters::default();
    search_filters.query = Some("AI".to_string());
    let mut repeated = Vec::new();
    repeated.push(measure_repeated(
        &db_path,
        &conn,
        "legacy_sessions_5000_cost",
        "Before-shape proxy: the previous dashboard session payload, including query/build/JSON serialization but excluding Tauri transport.",
        |read_conn| {
            let report = query::sessions(
                read_conn,
                &current_range,
                &filters,
                &legacy_cost_options,
                now_ms,
            )
            .expect("measure legacy session payload");
            let rows = report.rows.len();
            let bytes = stable_json_bytes(&report);
            (rows, bytes)
        },
    ));
    repeated.push(measure_repeated(
        &db_path,
        &conn,
        "current_sessions_100_cost",
        "Current first-page payload using the same cost sort as the before-shape proxy; query/build/JSON serialization excludes Tauri transport.",
        |read_conn| {
            let report = query::sessions(
                read_conn,
                &current_range,
                &filters,
                &current_cost_options,
                now_ms,
            )
            .expect("measure current cost-sorted session payload");
            let rows = report.rows.len();
            let bytes = stable_json_bytes(&report);
            (rows, bytes)
        },
    ));
    repeated.push(measure_repeated(
        &db_path,
        &conn,
        "legacy_sessions_5000_rework",
        "Before-shape proxy using the current default rework sort; query/build/JSON serialization excludes Tauri transport.",
        |read_conn| {
            let report = query::sessions(
                read_conn,
                &current_range,
                &filters,
                &legacy_rework_options,
                now_ms,
            )
            .expect("measure legacy rework-sorted session payload");
            let rows = report.rows.len();
            let bytes = stable_json_bytes(&report);
            (rows, bytes)
        },
    ));
    repeated.push(measure_repeated(
        &db_path,
        &conn,
        "current_sessions_100_rework",
        "Current first-page session payload; query/build/JSON serialization proxy excludes Tauri transport.",
        |read_conn| {
            let report = query::sessions(
                read_conn,
                &current_range,
                &filters,
                &current_rework_options,
                now_ms,
            )
            .expect("measure current session payload");
            let rows = report.rows.len();
            let bytes = stable_json_bytes(&report);
            (rows, bytes)
        },
    ));
    repeated.push(measure_repeated(
        &db_path,
        &conn,
        "current_overview",
        "Current above-the-fold backend report; query/build/JSON serialization excludes Tauri transport and renderer work.",
        |read_conn| {
            let report = query::overview(read_conn, &current_range, &filters, now_ms)
                .expect("measure current overview");
            let rows = report.totals.sessions.max(0) as usize;
            let bytes = stable_json_bytes(&report);
            (rows, bytes)
        },
    ));
    repeated.push(measure_repeated(
        &db_path,
        &conn,
        "current_dashboard",
        "Compatibility batch retained for callers outside the current UI critical path; query/build/JSON serialization excludes Tauri transport and renderer work.",
        |read_conn| {
            let report = query::dashboard(
                read_conn,
                &current_range,
                &filters,
                "provider",
                now_ms,
            )
            .expect("measure current dashboard");
            let rows = report.sessions.rows.len();
            let bytes = stable_json_bytes(&report);
            (rows, bytes)
        },
    ));
    repeated.push(measure_repeated(
        &db_path,
        &conn,
        "current_session_search_ai",
        "Dedicated server-paged search for query AI; query/build/JSON serialization excludes the 250ms UI debounce and Tauri transport.",
        |read_conn| {
            let report = query::sessions(
                read_conn,
                &current_range,
                &search_filters,
                &current_rework_options,
                now_ms,
            )
            .expect("measure current session search");
            let rows = report.rows.len();
            let bytes = stable_json_bytes(&report);
            (rows, bytes)
        },
    ));

    println!(
        "AILOG_PERF_JSON={}",
        serde_json::to_string(&PerfResult {
            db_path: db_path.display().to_string(),
            query_only,
            scenarios,
            repeated,
        })
        .expect("serialize performance result")
    );
}

#[derive(Serialize)]
struct TimingDist {
    runs: usize,
    p50_ms: f64,
    p95_ms: f64,
    min_ms: f64,
    max_ms: f64,
}

#[derive(Serialize)]
struct ReportSplit {
    name: &'static str,
    path: String,
    paths_seen: Vec<String>,
    rows_scanned_sample: u64,
    cold_sql: TimingDist,
    warm_sql: TimingDist,
    cold_build: TimingDist,
    warm_build: TimingDist,
}

fn timing_dist_from_ms(mut values: Vec<f64>) -> TimingDist {
    assert_eq!(values.len(), REPEATED_RUNS);
    values.sort_by(|left, right| left.partial_cmp(right).unwrap());
    let percentile = |numerator: usize, denominator: usize| {
        let index = (values.len() * numerator).div_ceil(denominator) - 1;
        values[index]
    };
    TimingDist {
        runs: values.len(),
        p50_ms: percentile(50, 100),
        p95_ms: percentile(95, 100),
        min_ms: values[0],
        max_ms: *values.last().expect("non-empty timings"),
    }
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

fn search_page_sql(
    conn: &Connection,
    resolved: &crate::ailog::ResolvedRange,
    filters: &Filters,
    limit: i64,
    offset: i64,
) -> Result<(u64, Vec<(String, String)>), String> {
    let mut aggregate_filters = filters.clone();
    let search_query = aggregate_filters
        .query
        .take()
        .filter(|value| !value.is_empty());
    let (filter_sql, filter_params) = query::shared_where(resolved, &aggregate_filters);
    let (search_cte, turn_source, mut params) = if let Some(query_text) = search_query {
        let pattern = SqlValue::Text(format!("%{query_text}%"));
        let mut params = vec![pattern.clone(), pattern.clone(), pattern];
        params.extend(filter_params);
        (
            "matched_session AS MATERIALIZED (\
             SELECT kind, session_id FROM session \
             WHERE COALESCE(ai_title,'') LIKE ? OR COALESCE(first_prompt,'') LIKE ? \
                OR COALESCE(project_label,'') LIKE ?), ",
            "FROM matched_session matched \
             CROSS JOIN turn t ON t.kind = matched.kind AND t.session_id = matched.session_id \
             JOIN session s ON s.kind = t.kind AND s.session_id = t.session_id",
            params,
        )
    } else {
        (
            "",
            "FROM turn t JOIN session s \
             ON s.kind = t.kind AND s.session_id = t.session_id",
            filter_params,
        )
    };
    let eligible = format!(
        "SELECT t.kind, t.session_id, SUM(t.cost_usd) AS sort_cost, \
         COUNT(*) AS sort_turns, MAX(t.ts) AS sort_recent \
         {turn_source} \
         WHERE {filter_sql} GROUP BY t.kind, t.session_id"
    );
    let sql = format!(
        "WITH {search_cte}eligible AS ({eligible}) \
         SELECT eligible.kind, eligible.session_id, COALESCE(r.score, 0), COUNT(*) OVER() \
         FROM eligible \
         JOIN session s ON s.kind = eligible.kind AND s.session_id = eligible.session_id \
         LEFT JOIN rework r ON r.kind = eligible.kind AND r.session_id = eligible.session_id \
         ORDER BY COALESCE(r.score, 0) DESC, eligible.kind ASC, eligible.session_id ASC \
         LIMIT ? OFFSET ?"
    );
    params.push(SqlValue::Integer(limit.max(0)));
    params.push(SqlValue::Integer(offset.max(0)));
    let started = Instant::now();
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|err| format!("prepare search page sql: {err}"))?;
    let rows = stmt
        .query_map(params_from_iter(params.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| format!("run search page sql: {err}"))?;
    let keys = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("read search page sql: {err}"))?;
    let elapsed = started.elapsed().as_micros().min(u64::MAX as u128) as u64;
    Ok((elapsed, keys))
}

fn fill_range_models_sql(
    conn: &Connection,
    keys: &[(String, String)],
    from: i64,
    to: i64,
) -> Result<(u64, usize), String> {
    if keys.is_empty() {
        return Ok((0, 0));
    }
    let requested = std::iter::repeat("(?, ?)")
        .take(keys.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "WITH requested(kind, session_id) AS (VALUES {requested}) \
         SELECT t.kind, t.session_id, COALESCE(t.model, ''), \
                SUM(t.input_tokens + t.output_tokens) \
           FROM turn t JOIN requested q ON q.kind = t.kind AND q.session_id = t.session_id \
          WHERE t.ts >= ? AND t.ts <= ? \
          GROUP BY 1, 2, 3"
    );
    let mut params = Vec::with_capacity(keys.len() * 2 + 2);
    for (kind, session_id) in keys {
        params.push(SqlValue::Text(kind.clone()));
        params.push(SqlValue::Text(session_id.clone()));
    }
    params.push(SqlValue::Integer(from));
    params.push(SqlValue::Integer(to));
    let started = Instant::now();
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|err| format!("prepare fill range models: {err}"))?;
    let rows = stmt
        .query_map(params_from_iter(params.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<i64>>(3)?.unwrap_or(0),
            ))
        })
        .map_err(|err| format!("run fill range models: {err}"))?;
    let count = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("read fill range models: {err}"))?
        .len();
    let elapsed = started.elapsed().as_micros().min(u64::MAX as u128) as u64;
    Ok((elapsed, count))
}

/// Dashboard report-by-report timings plus search-path stage split.
/// Production query behavior is not changed; this only reads ReportTimings
/// and times serialize / independent SQL copies from the test side.
#[test]
#[ignore = "run only against a live read-only ailog database"]
fn measure_dashboard_and_search_breakdown_read_only() {
    let db_path = PathBuf::from(env::var("AILOG_PERF_DB").expect("AILOG_PERF_DB is required"));
    let conn = read_only_connection(&db_path);
    let query_only: i64 = conn
        .query_row("PRAGMA query_only", [], |row| row.get(0))
        .expect("read query_only pragma");
    assert_eq!(query_only, 1, "performance runs must stay query-only");

    let now_ms = chrono::Utc::now().timestamp_millis();
    let filters = Filters::default();
    let current_range = Range {
        from: None,
        to: None,
        preset: Some("30d".to_string()),
        anchor: None,
    };
    let (resolved, _) = current_range.resolve(now_ms);
    let search_options = query::SessionsOptions {
        sort: "rework".to_string(),
        limit: 100,
        offset: 0,
    };
    let mut search_filters = Filters::default();
    search_filters.query = Some("AI".to_string());

    let efficiency_oneshot = {
        let report = query::efficiency(&conn, &current_range, &filters, now_ms)
            .expect("measure efficiency oneshot");
        MeasuredReport {
            name: "efficiency",
            timings: report.timings,
        }
    };

    let mut dash_wall = Vec::with_capacity(REPEATED_RUNS);
    let mut dash_wall_no_ser = Vec::with_capacity(REPEATED_RUNS);
    let mut dash_serialize = Vec::with_capacity(REPEATED_RUNS);
    let mut dash_sql = Vec::with_capacity(REPEATED_RUNS);
    let mut dash_build = Vec::with_capacity(REPEATED_RUNS);
    let report_names = ["overview", "series", "models", "projects", "sessions"];
    let mut report_sql: [Vec<f64>; 5] = Default::default();
    let mut report_build: [Vec<f64>; 5] = Default::default();
    let mut report_paths: [Vec<String>; 5] = Default::default();
    let mut report_rows: [u64; 5] = [0; 5];
    let mut sample_rows = 0usize;
    let mut payload_sizes = Vec::new();
    let mut cold_wall = Vec::with_capacity(REPEATED_RUNS);
    let mut cold_wall_no_ser = Vec::with_capacity(REPEATED_RUNS);
    let mut cold_serialize = Vec::with_capacity(REPEATED_RUNS);
    let mut cold_sql = Vec::with_capacity(REPEATED_RUNS);
    let mut cold_build = Vec::with_capacity(REPEATED_RUNS);
    let mut cold_report_sql: [Vec<f64>; 5] = Default::default();
    let mut cold_report_build: [Vec<f64>; 5] = Default::default();
    let mut cold_report_paths: [Vec<String>; 5] = Default::default();
    for _ in 0..REPEATED_RUNS {
        let read_conn = read_only_connection(&db_path);
        let started = Instant::now();
        let report = query::dashboard(&read_conn, &current_range, &filters, "provider", now_ms)
            .expect("measure dashboard cold");
        let wall_no_ser = started.elapsed().as_micros().min(u64::MAX as u128) as u64;
        let ser_started = Instant::now();
        let bytes = stable_json_bytes(&report);
        let ser_us = ser_started.elapsed().as_micros().min(u64::MAX as u128) as u64;
        cold_wall.push(started.elapsed().as_micros().min(u64::MAX as u128) as u64);
        cold_wall_no_ser.push(wall_no_ser as f64 / 1_000.0);
        cold_serialize.push(ser_us as f64 / 1_000.0);
        cold_sql.push(report.timings.sql_ms as f64);
        cold_build.push(report.timings.build_ms as f64);
        sample_rows = report.sessions.rows.len();
        payload_sizes.push(bytes);
        let children = [
            report.overview.timings,
            report.series.timings,
            report.models.timings,
            report.projects.timings,
            report.sessions.timings,
        ];
        for (index, timings) in children.into_iter().enumerate() {
            cold_report_sql[index].push(timings.sql_ms as f64);
            cold_report_build[index].push(timings.build_ms as f64);
            cold_report_paths[index].push(timings.path.to_string());
            report_rows[index] = timings.rows_scanned;
        }
    }
    for _ in 0..REPEATED_RUNS {
        let started = Instant::now();
        let report = query::dashboard(&conn, &current_range, &filters, "provider", now_ms)
            .expect("measure dashboard warm");
        let wall_no_ser = started.elapsed().as_micros().min(u64::MAX as u128) as u64;
        let ser_started = Instant::now();
        let bytes = stable_json_bytes(&report);
        let ser_us = ser_started.elapsed().as_micros().min(u64::MAX as u128) as u64;
        dash_wall.push(started.elapsed().as_micros().min(u64::MAX as u128) as u64);
        dash_wall_no_ser.push(wall_no_ser as f64 / 1_000.0);
        dash_serialize.push(ser_us as f64 / 1_000.0);
        dash_sql.push(report.timings.sql_ms as f64);
        dash_build.push(report.timings.build_ms as f64);
        sample_rows = report.sessions.rows.len();
        payload_sizes.push(bytes);
        let children = [
            report.overview.timings,
            report.series.timings,
            report.models.timings,
            report.projects.timings,
            report.sessions.timings,
        ];
        for (index, timings) in children.into_iter().enumerate() {
            report_sql[index].push(timings.sql_ms as f64);
            report_build[index].push(timings.build_ms as f64);
            report_paths[index].push(timings.path.to_string());
            report_rows[index] = timings.rows_scanned;
        }
    }

    payload_sizes.sort_unstable();
    let dashboard_repeated = RepeatedScenario {
        name: "current_dashboard",
        cold: distribution(cold_wall),
        warm: distribution(dash_wall.clone()),
        sample_rows,
        sample_json_bytes: payload_sizes[payload_sizes.len() / 2],
        sample_json_bytes_min: payload_sizes[0],
        sample_json_bytes_max: *payload_sizes.last().expect("payload sizes"),
        note: "Dashboard wall including JSON serialization; excludes Tauri transport and renderer.",
    };
    let mut report_splits = Vec::new();
    for index in 0..5 {
        let mut paths = cold_report_paths[index].clone();
        paths.extend(report_paths[index].iter().cloned());
        report_splits.push(ReportSplit {
            name: report_names[index],
            path: cold_report_paths[index]
                .first()
                .cloned()
                .unwrap_or_else(|| "unknown".to_string()),
            paths_seen: unique_sorted(paths),
            rows_scanned_sample: report_rows[index],
            cold_sql: timing_dist_from_ms(cold_report_sql[index].clone()),
            warm_sql: timing_dist_from_ms(report_sql[index].clone()),
            cold_build: timing_dist_from_ms(cold_report_build[index].clone()),
            warm_build: timing_dist_from_ms(report_build[index].clone()),
        });
    }
    let warm_child_sum_p50: f64 = report_splits
        .iter()
        .map(|report| report.warm_sql.p50_ms + report.warm_build.p50_ms)
        .sum();
    let warm_wall_no_ser = timing_dist_from_ms(dash_wall_no_ser.clone());

    let mut search_wall_cold = Vec::with_capacity(REPEATED_RUNS);
    let mut search_wall_warm = Vec::with_capacity(REPEATED_RUNS);
    let mut search_sql_cold = Vec::with_capacity(REPEATED_RUNS);
    let mut search_sql_warm = Vec::with_capacity(REPEATED_RUNS);
    let mut search_build_cold = Vec::with_capacity(REPEATED_RUNS);
    let mut search_build_warm = Vec::with_capacity(REPEATED_RUNS);
    let mut search_ser_cold = Vec::with_capacity(REPEATED_RUNS);
    let mut search_ser_warm = Vec::with_capacity(REPEATED_RUNS);
    let mut search_res_cold = Vec::with_capacity(REPEATED_RUNS);
    let mut search_res_warm = Vec::with_capacity(REPEATED_RUNS);
    let mut search_paths = Vec::new();
    let mut search_rows = 0usize;
    let mut search_payload = Vec::new();
    let mut page_keys: Vec<(String, String)> = Vec::new();

    for _ in 0..REPEATED_RUNS {
        let read_conn = read_only_connection(&db_path);
        let started = Instant::now();
        let report = query::sessions(
            &read_conn,
            &current_range,
            &search_filters,
            &search_options,
            now_ms,
        )
        .expect("measure search cold");
        let ser_started = Instant::now();
        let bytes = stable_json_bytes(&report);
        let ser_us = ser_started.elapsed().as_micros().min(u64::MAX as u128) as u64;
        let wall_us = started.elapsed().as_micros().min(u64::MAX as u128) as u64;
        let sql_us = report.timings.sql_ms.saturating_mul(1000);
        let build_us = report.timings.build_ms.saturating_mul(1000);
        let residual_us = wall_us
            .saturating_sub(sql_us)
            .saturating_sub(build_us)
            .saturating_sub(ser_us);
        search_wall_cold.push(wall_us);
        search_sql_cold.push(report.timings.sql_ms as f64);
        search_build_cold.push(report.timings.build_ms as f64);
        search_ser_cold.push(ser_us as f64 / 1_000.0);
        search_res_cold.push(residual_us as f64 / 1_000.0);
        search_rows = report.rows.len();
        search_payload.push(bytes);
        search_paths.push(report.timings.path.to_string());
        if page_keys.is_empty() {
            page_keys = report
                .rows
                .iter()
                .map(|row| (row.kind.clone(), row.session_id.clone()))
                .collect();
        }
    }
    for _ in 0..REPEATED_RUNS {
        let started = Instant::now();
        let report = query::sessions(&conn, &current_range, &search_filters, &search_options, now_ms)
            .expect("measure search warm");
        let ser_started = Instant::now();
        let bytes = stable_json_bytes(&report);
        let ser_us = ser_started.elapsed().as_micros().min(u64::MAX as u128) as u64;
        let wall_us = started.elapsed().as_micros().min(u64::MAX as u128) as u64;
        let sql_us = report.timings.sql_ms.saturating_mul(1000);
        let build_us = report.timings.build_ms.saturating_mul(1000);
        let residual_us = wall_us
            .saturating_sub(sql_us)
            .saturating_sub(build_us)
            .saturating_sub(ser_us);
        search_wall_warm.push(wall_us);
        search_sql_warm.push(report.timings.sql_ms as f64);
        search_build_warm.push(report.timings.build_ms as f64);
        search_ser_warm.push(ser_us as f64 / 1_000.0);
        search_res_warm.push(residual_us as f64 / 1_000.0);
        search_payload.push(bytes);
        search_paths.push(report.timings.path.to_string());
        if page_keys.is_empty() {
            page_keys = report
                .rows
                .iter()
                .map(|row| (row.kind.clone(), row.session_id.clone()))
                .collect();
        }
    }
    search_payload.sort_unstable();
    let search_repeated = RepeatedScenario {
        name: "current_session_search_ai",
        cold: distribution(search_wall_cold),
        warm: distribution(search_wall_warm),
        sample_rows: search_rows,
        sample_json_bytes: search_payload[search_payload.len() / 2],
        sample_json_bytes_min: search_payload[0],
        sample_json_bytes_max: *search_payload.last().expect("search payload"),
        note: "Search wall including JSON serialization; excludes 250ms UI debounce and Tauri transport.",
    };

    let page_sql_repeated = measure_repeated(
        &db_path,
        &conn,
        "search_ai_page_sql",
        "Independent copy of sessions_raw page SQL (search CTE + eligible + rework join + LIMIT). Not part of production timings split.",
        |read_conn| {
            let (elapsed_us, keys) = search_page_sql(
                read_conn,
                &resolved,
                &search_filters,
                search_options.limit,
                search_options.offset,
            )
            .expect("page sql");
            let _ = elapsed_us;
            (keys.len(), 0)
        },
    );
    // measure_repeated records wall of the closure, which is the SQL. Good.
    // Re-run with explicit timings stored: measure_repeated already times the task wall.
    let fill_repeated = measure_repeated(
        &db_path,
        &conn,
        "search_ai_fill_range_models",
        "Independent copy of fill_raw_range_models SQL over the first search page keys.",
        |read_conn| {
            let (elapsed_us, rows) =
                fill_range_models_sql(read_conn, &page_keys, resolved.from, resolved.to)
                    .expect("fill range models");
            let _ = elapsed_us;
            (rows, 0)
        },
    );

    let dashboard = serde_json::json!({
        "name": "current_dashboard",
        "note": "Per-report ReportTimings from DashboardReport plus wall/serialize measured in the test.",
        "wall_including_serialize": dashboard_repeated,
        "wall_excluding_serialize": {
            "cold": timing_dist_from_ms(cold_wall_no_ser),
            "warm": warm_wall_no_ser,
        },
        "serialize": {
            "cold": timing_dist_from_ms(cold_serialize),
            "warm": timing_dist_from_ms(dash_serialize),
        },
        "dashboard_sql": {
            "cold": timing_dist_from_ms(cold_sql),
            "warm": timing_dist_from_ms(dash_sql),
        },
        "dashboard_build": {
            "cold": timing_dist_from_ms(cold_build),
            "warm": timing_dist_from_ms(dash_build),
        },
        "reports": report_splits,
        "sum_child_sql_plus_build_warm_p50_ms": warm_child_sum_p50,
        "dashboard_wall_excluding_serialize_warm_p50_ms": warm_wall_no_ser.p50_ms,
        "sum_minus_wall_warm_p50_ms": warm_child_sum_p50 - warm_wall_no_ser.p50_ms,
        "efficiency_on_dashboard_path": false,
        "efficiency_on_dashboard_path_reason": "query::dashboard does not call query::efficiency. Nested reports are overview/series/models/projects/sessions only.",
    });
    let search = serde_json::json!({
        "name": "current_session_search_ai",
        "note": "sessions() with query=AI, sort=rework, limit=100. sql/build from ReportTimings. serialize timed in the test. residual = wall - sql - build - serialize. page_sql and fill_range_models are independent copies of sessions_raw internals because production lumps them into sqlMs on the raw path.",
        "wall_including_serialize": search_repeated,
        "sql": {
            "cold": timing_dist_from_ms(search_sql_cold),
            "warm": timing_dist_from_ms(search_sql_warm),
        },
        "build": {
            "cold": timing_dist_from_ms(search_build_cold),
            "warm": timing_dist_from_ms(search_build_warm),
        },
        "serialize": {
            "cold": timing_dist_from_ms(search_ser_cold),
            "warm": timing_dist_from_ms(search_ser_warm),
        },
        "residual": {
            "cold": timing_dist_from_ms(search_res_cold),
            "warm": timing_dist_from_ms(search_res_warm),
        },
        "residual_name": "sessions_call_overhead_outside_reported_sql_build_and_test_serialize",
        "path": search_paths.first().cloned().unwrap_or_else(|| "unknown".to_string()),
        "paths_seen": unique_sorted(search_paths),
        "page_sql_independent": page_sql_repeated,
        "fill_range_models_independent": fill_repeated,
    });

    let result = serde_json::json!({
        "db_path": db_path.display().to_string(),
        "open_flags": "SQLITE_OPEN_READ_ONLY",
        "query_only": query_only,
        "efficiency_oneshot": efficiency_oneshot,
        "dashboard": dashboard,
        "search": search,
    });
    println!(
        "AILOG_BREAKDOWN_JSON={}",
        serde_json::to_string(&result).expect("serialize breakdown")
    );
}

/// 20-run warm/cold timings for `query::models` after the hand-off split.
/// Keep the live database read-only: SQLITE_OPEN_READ_ONLY + PRAGMA query_only=ON.
#[test]
#[ignore = "run only against a live read-only ailog database"]
fn measure_models_report_read_only() {
    let db_path = PathBuf::from(env::var("AILOG_PERF_DB").expect("AILOG_PERF_DB is required"));
    let conn = read_only_connection(&db_path);
    let query_only: i64 = conn
        .query_row("PRAGMA query_only", [], |row| row.get(0))
        .expect("read query_only");
    assert_eq!(query_only, 1, "performance runs must stay query-only");

    let now_ms = chrono::Utc::now().timestamp_millis();
    let filters = Filters::default();
    let current_range = Range {
        from: None,
        to: None,
        preset: Some("30d".to_string()),
        anchor: None,
    };
    let options = query::ModelsOptions {
        granularity: "raw".to_string(),
        bucket: "day".to_string(),
    };

    let mut cold_sql = Vec::with_capacity(REPEATED_RUNS);
    let mut cold_build = Vec::with_capacity(REPEATED_RUNS);
    let mut cold_paths = Vec::with_capacity(REPEATED_RUNS);
    let mut warm_sql = Vec::with_capacity(REPEATED_RUNS);
    let mut warm_build = Vec::with_capacity(REPEATED_RUNS);
    let mut warm_paths = Vec::with_capacity(REPEATED_RUNS);
    let mut rows_scanned = 0u64;
    let mut sample_rows = 0usize;
    let mut sample = None;

    for _ in 0..REPEATED_RUNS {
        let read_conn = read_only_connection(&db_path);
        let report = query::models(&read_conn, &current_range, &filters, &options, now_ms)
            .expect("measure models cold");
        cold_sql.push(report.timings.sql_ms as f64);
        cold_build.push(report.timings.build_ms as f64);
        cold_paths.push(report.timings.path.to_string());
        rows_scanned = report.timings.rows_scanned;
        sample_rows = report.rows.len();
        sample = Some(report);
    }
    for _ in 0..REPEATED_RUNS {
        let report = query::models(&conn, &current_range, &filters, &options, now_ms)
            .expect("measure models warm");
        warm_sql.push(report.timings.sql_ms as f64);
        warm_build.push(report.timings.build_ms as f64);
        warm_paths.push(report.timings.path.to_string());
        rows_scanned = report.timings.rows_scanned;
        sample_rows = report.rows.len();
        sample = Some(report);
    }

    let report = sample.expect("models sample");
    let value_fingerprint = serde_json::json!({
        "row_count": report.rows.len(),
        "rows": report
            .rows
            .iter()
            .map(|row| {
                serde_json::json!({
                    "model": row.model,
                    "cost_usd": row.cost_usd,
                    "tokens": row.input + row.output + row.cache_read + row.cache_write,
                    "sessions": row.sessions,
                })
            })
            .collect::<Vec<_>>(),
        "mixed_sessions": report.mixed_sessions,
        "total_sessions": report.total_sessions,
        "work_tag_count": report.by_work_tag.len(),
        "handoffs_in_models": report.handoffs.len(),
    });
    println!(
        "AILOG_MODELS_SPLIT_JSON={}",
        serde_json::to_string(&serde_json::json!({
            "db_path": db_path.display().to_string(),
            "query_only": query_only,
            "path": report.timings.path,
            "paths_seen": unique_sorted({
                let mut paths = cold_paths.clone();
                paths.extend(warm_paths.iter().cloned());
                paths
            }),
            "rows_scanned": rows_scanned,
            "sample_model_rows": sample_rows,
            "cold_sql": timing_dist_from_ms(cold_sql),
            "warm_sql": timing_dist_from_ms(warm_sql),
            "cold_build": timing_dist_from_ms(cold_build),
            "warm_build": timing_dist_from_ms(warm_build),
            "values": value_fingerprint,
        }))
        .expect("serialize models split")
    );
}


/// G1-3 snapshot-copy measurement. Never opens the runtime database.
#[test]
#[ignore = "explicit snapshot-copy-only G1-3 measurement"]
fn measure_g1_3_reports_read_only() {
    let path = g1_3_path();
    let now: i64 = env::var("AILOG_PERF_NOW").expect("fixed anchor required").parse().unwrap();
    let conn = read_only_connection(&path);
    let filters = Filters::default();
    let selected = env::var("AILOG_PERF_PRESET").ok();
    for preset in ["7d", "30d", "90d", "all"] {
        if selected.as_deref().is_some_and(|selected| selected != preset) { continue; }
        let range = Range { preset: Some(preset.into()), anchor: Some(now), ..Range::default() };
        for name in ["overview", "series", "models", "sessions", "breakdown", "pivot", "model_handoffs", "rework_rankings", "usage_rhythm"] {
            for iteration in 0..4 {
                let begin = Instant::now();
                let result = match name {
                    "overview" => query::overview(&conn, &range, &filters, now).map(|report| report.timings),
                    "series" => query::series(&conn, &range, &filters, &query::SeriesOptions { bucket: "day".into(), group_by: "model_raw".into() }, now).map(|report| report.timings),
                    "models" => query::models(&conn, &range, &filters, &query::ModelsOptions { granularity: "raw".into(), bucket: "day".into() }, now).map(|report| report.timings),
                    "sessions" => query::sessions(&conn, &range, &filters, &query::SessionsOptions { sort:"rework".into(),limit:100,offset:0 }, now).map(|report| report.timings),
                    "breakdown" => query::breakdown(&conn, &range, &filters, "project", now).map(|report| report.timings),
                    "pivot" => query::pivot(&conn, &range, &filters, &query::PivotOptions::default(), now).map(|report| report.timings),
                    "model_handoffs" => query::model_handoffs(&conn, &range, &filters, &query::ModelsOptions { granularity: "raw".into(), bucket: "day".into() }, now).map(|report| report.timings),
                    "rework_rankings" => query::rework_rankings(&conn, &range, &filters, now).map(|report| report.timings),
                    _ => crate::ailog::usage::rhythm(&conn, &range, &filters, now).map(|report| report.timings),
                };
                let wall = begin.elapsed().as_secs_f64()*1000.0;
                let value = match result {
                    Ok(timings) => serde_json::json!({"preset":preset,"report":name,"iteration":iteration,"wall_ms":wall,"timings":timings}),
                    Err(error) => serde_json::json!({"preset":preset,"report":name,"iteration":iteration,"wall_ms":wall,
                        "error": if error.contains("too many SQL variables") { "too_many_sql_variables" } else { "report_error_see_code" }}),
                };
                println!("AILOG_G1_3_ROW={}", serde_json::to_string(&value).unwrap());
            }
        }
    }
}

#[test]
#[ignore = "explicit snapshot-copy-only session assembly comparison"]
fn measure_g1_3_session_assembly_read_only() {
    let path=g1_3_path();
    let now=env::var("AILOG_PERF_NOW").expect("fixed anchor required").parse().unwrap();
    let conn=read_only_connection(&path);
    for preset in ["7d","30d","90d","all"] {
        println!("AILOG_G1_3_SESSION_PRESET={preset}");
        query::measure_session_assembly_pair(&conn,&Range { preset:Some(preset.into()),anchor:Some(now),..Range::default() },now).unwrap();
    }
}

// Test-only G1-3 measurement support. No runtime database is an allowed input.
fn g1_3_path() -> PathBuf {
    let path=PathBuf::from(env::var("AILOG_PERF_DB").expect("explicit measurement path"));
    if cfg!(windows) {
        assert_eq!(path.canonicalize().unwrap(),PathBuf::from("D:/mycmux-g1-3-dbcopy/ailog-copy.db").canonicalize().unwrap());
    } else {
        assert_eq!(env::var("AILOG_G1_3_SYNTHETIC").as_deref(),Ok("1"));
        assert!(path.is_absolute());
        assert_eq!(path.file_name().unwrap(),"g1-3-synthetic.db");
        assert_eq!(path.parent().unwrap().file_name().unwrap(),"target");
        assert!(path.to_string_lossy().contains("/04_macrun/mirrors/mycmux-wt-grass-perf-261030-"));
        let conn=read_only_connection(&path);
        let marker:String=conn.query_row("SELECT value FROM index_state WHERE key='g1_3_synthetic_only'",[],|row|row.get(0)).unwrap();
        assert_eq!(marker,"random-fixture-from-spec-only-v2");
    }
    path
}

#[test]
#[ignore="Mac-only synthetic fallback, never reads the snapshot or live database"]
fn create_g1_3_synthetic_fixture() {
    assert!(!cfg!(windows));
    assert_eq!(env::var("AILOG_G1_3_SYNTHETIC").as_deref(),Ok("1"));
    let path=std::env::current_dir().unwrap().join("target/g1-3-synthetic.db");
    assert!(!path.exists(),"preserve an existing synthetic fixture");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut conn=Connection::open(&path).unwrap();
    crate::ailog::schema::init(&conn).unwrap();
    crate::ailog::migrate::apply(&conn).unwrap();
    let now:i64=env::var("AILOG_PERF_NOW").unwrap().parse().unwrap();
    let day=86_400_000_i64; let shift=9*3_600_000_i64;
    let first=(now+shift)/day*day-shift-229*day;
    let mut seed=0x261030_6a13_u64;
    fn random(seed:&mut u64)->u64 { *seed^=*seed<<13;*seed^=*seed>>7;*seed^=*seed<<17;*seed }
    {
        let tx=conn.transaction().unwrap();
        let mut sessions=tx.prepare("INSERT INTO session(kind,session_id,ai_title,first_prompt,project_key,project_label,primary_model,model_count,started_at,user_msg_count,work_tags,origin) VALUES ('claude',?1,?2,?2,?3,?3,?4,1,?5,7,'[\"debug\"]','unknown')").unwrap();
        let mut turns=tx.prepare("INSERT INTO turn(kind,session_id,seq,ts,model,model_family,input_tokens,output_tokens,cache_read_tokens,cache_write_5m_tokens,cost_usd,usage_state) VALUES ('claude',?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)").unwrap();
        let mut tools=tx.prepare("INSERT INTO tool_event(kind,session_id,seq,ts,name,target,is_error) VALUES ('claude',?1,?2,?3,'fake-tool',?4,?5)").unwrap();
        let mut files=tx.prepare("INSERT INTO file_touch(kind,session_id,path,edit_count) VALUES ('claude',?1,?2,?3)").unwrap();
        let mut rework=tx.prepare("INSERT INTO rework(kind,session_id,score) VALUES ('claude',?1,?2)").unwrap();
        for index in 0..50_000_i64 {
            let id=format!("synthetic-{index:06}");
            let text=format!("random-{:016x}",random(&mut seed)).repeat(40);
            let project=format!("fake-project-{}",index%200);
            let model=format!("fake-model-{}",index%8);
            let start=first+(index%230)*day;
            sessions.execute(rusqlite::params![id,text,project,model,start]).unwrap();
            rework.execute(rusqlite::params![id,(random(&mut seed)%1000) as f64/100.0]).unwrap();
            let targets:Vec<_>=(0..4).map(|_|format!("random-command-{:016x}",random(&mut seed)).repeat(20)).collect();
            for seq in 0..44_i64 {
                let ts=start+(random(&mut seed)%(day as u64)) as i64;
                let selected=if index%5==0 && seq>22 {(index+1)%8}else{index%8};
                let model=format!("fake-model-{selected}");let family=format!("fake-family-{}",selected%3);
                let input=(random(&mut seed)%5000) as i64;let output=(random(&mut seed)%1000) as i64;
                let cache=(random(&mut seed)%10000) as i64;
                let state=if seq==0 && index%5==0 {"unresolved"}else{"legacy"};
                turns.execute(rusqlite::params![id,seq,ts,model,family,input,output,cache,0,(input+output) as f64/1000000.0,state]).unwrap();
                tools.execute(rusqlite::params![id,seq,ts,targets[(seq%4) as usize],(random(&mut seed)%10==0) as i64]).unwrap();
            }
            files.execute(rusqlite::params![id,format!("src/fake-{}.rs",index%5000),3+(random(&mut seed)%10) as i64]).unwrap();
            if index%10000==0 {println!("AILOG_G1_3_SYNTHETIC_PROGRESS sessions={index}");}
        }
        drop((sessions,turns,tools,files,rework));
        tx.commit().unwrap();
    }
    crate::ailog::report_cache::init_source_revision(&conn).unwrap();
    conn.execute("INSERT INTO index_state(key,value) VALUES ('g1_3_synthetic_only','random-fixture-from-spec-only-v2')",[]).unwrap();
    crate::ailog::rollup::mark_all_dirty(&conn).unwrap();
    crate::ailog::rollup::rebuild_dirty(&conn).unwrap();
    println!("AILOG_G1_3_SYNTHETIC_READY sessions=50000 turns=2200000 days=230 seed=0x2610306a13");
}

#[test]
#[ignore="measurement database only; changes rollup_dirty rows and nothing else"]
fn set_g1_3_dirty_scene() {
    let path=g1_3_path();
    let conn=Connection::open_with_flags(path,OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap();
    let now:i64=env::var("AILOG_PERF_NOW").unwrap().parse().unwrap();
    let scene=env::var("AILOG_PERF_SCENE").unwrap();
    assert!(["clean","today_dirty","day_30_before_dirty"].contains(&scene.as_str()));
    let day=(now+9*3_600_000)/86_400_000;
    conn.execute("DELETE FROM rollup_dirty",[]).unwrap();
    if scene!="clean" { conn.execute("INSERT INTO rollup_dirty(day) VALUES (?1)",[if scene=="today_dirty" {day}else{day-30}]).unwrap(); }
    let count:i64=conn.query_row("SELECT COUNT(*) FROM rollup_dirty",[],|row|row.get(0)).unwrap();
    println!("AILOG_G1_3_SCENE={scene} dirty_rows={count}");
}

fn g1_3_query(conn:&Connection,name:&str,range:&Range,now:i64)->Result<query::ReportTimings,String> {
    let filters=Filters::default();
    match name {
        "overview"=>query::overview(conn,range,&filters,now).map(|r|r.timings),
        "series"=>query::series(conn,range,&filters,&query::SeriesOptions {bucket:"day".into(),group_by:"model_raw".into()},now).map(|r|r.timings),
        "models"=>query::models(conn,range,&filters,&query::ModelsOptions {granularity:"raw".into(),bucket:"day".into()},now).map(|r|r.timings),
        "sessions"=>query::sessions(conn,range,&filters,&query::SessionsOptions {sort:"rework".into(),limit:100,offset:0},now).map(|r|r.timings),
        "breakdown"=>query::breakdown(conn,range,&filters,"project",now).map(|r|r.timings),
        "pivot"=>query::pivot(conn,range,&filters,&query::PivotOptions::default(),now).map(|r|r.timings),
        "model_handoffs"=>query::model_handoffs(conn,range,&filters,&query::ModelsOptions {granularity:"raw".into(),bucket:"day".into()},now).map(|r|r.timings),
        _=>unreachable!(),
    }
}

fn g1_3_spawn(name:&'static str,preset:&str,now:i64)->tokio::task::JoinHandle<(String,f64,query::ReportTimings)> {
    let path=g1_3_path();let preset=preset.to_owned();
    tokio::spawn(async move {
        let range=Range {preset:Some(preset),anchor:Some(now),..Default::default()};
        let started=Instant::now();
        let timing=g1_3_gate(name,None,move ||Ok(read_only_connection(&path)),move |conn|g1_3_query(conn,name,&range,now)).await.unwrap();
        (name.into(),started.elapsed().as_secs_f64()*1000.0,timing)
    })
}

#[tokio::test(flavor="multi_thread",worker_threads=2)]
#[ignore="measurement through the production report runtime with an explicit readonly database"]
async fn measure_g1_3_opening_lanes_read_only() {
    let now:i64=env::var("AILOG_PERF_NOW").unwrap().parse().unwrap();
    for preset in ["7d","30d","90d","all"] {
        for heavy in [false,true] {
            for iteration in 0..4 {
                let mut heavy_job=None;
                let finished=Arc::new(AtomicBool::new(false));
                if heavy {
                    let path=g1_3_path();let ended=finished.clone();
                    let (ready,wait)=tokio::sync::oneshot::channel();
                    heavy_job=Some(tokio::spawn(async move {
                        let value=g1_3_gate("model_handoffs",Some(1),move ||Ok(read_only_connection(&path)),move |conn| {
                            let _=ready.send(());
                            g1_3_query(conn,"model_handoffs",&Range {preset:Some("all".into()),anchor:Some(now),..Default::default()},now)
                        }).await;
                        ended.store(true,std::sync::atomic::Ordering::Release);value
                    }));
                    wait.await.unwrap();
                }
                let started=Instant::now();
                let overview=g1_3_spawn("overview",preset,now);
                let series=g1_3_spawn("series",preset,now);
                let models=g1_3_spawn("models",preset,now);
                let sessions=g1_3_spawn("sessions",preset,now);
                let series=series.await.unwrap();
                let breakdown=g1_3_spawn("breakdown",preset,now);
                let pivot=g1_3_spawn("pivot",preset,now);
                let rows=vec![overview.await.unwrap(),series,models.await.unwrap(),sessions.await.unwrap(),breakdown.await.unwrap(),pivot.await.unwrap()];
                let wall=started.elapsed().as_secs_f64()*1000.0;
                let overlaps=heavy && !finished.load(std::sync::atomic::Ordering::Acquire);
                println!("AILOG_G1_3_OPENING={}",serde_json::json!({"preset":preset,"iteration":iteration,"heavy":heavy,"heavy_active_through_light":overlaps,"wall_ms":wall,"reports":rows}));
                if let Some(job)=heavy_job { let _=job.await.unwrap(); }
            }
        }
    }
}

async fn g1_3_gate<T:Send+'static>(name:&'static str,id:Option<u64>,open:impl FnOnce()->Result<Connection,String>+Send+'static,
    build:impl FnOnce(&Connection)->Result<T,String>+Send+'static)->Result<T,String> {
    use crate::ailog::report_runtime::{runtime,Lane,ReportRequest};
    let request=id.map(|id|ReportRequest {id,supersedes:Vec::new(),channel:"measurement".into()});
    runtime().run("g1-3-measure",name,request,if name=="model_handoffs" {Lane::Heavy}else{Lane::Light},open,build).await
}

#[tokio::test(flavor="multi_thread",worker_threads=2)]
#[ignore="explicit readonly database and real heavy report cancellation measurement"]
async fn measure_g1_3_heavy_cancellation_read_only() {
    use crate::ailog::report_runtime::{runtime,Lane,ReportRequest,CANCELLED};
    let now:i64=env::var("AILOG_PERF_NOW").unwrap().parse().unwrap();
    for name in ["model_handoffs","rework_rankings","usage_rhythm"] {
        for iteration in 0..4 {
            let path=g1_3_path(); let next_path=path.clone();
            let (ready,wait)=tokio::sync::oneshot::channel();
            let old=tokio::spawn(async move {
                runtime().run("g1-3-cancellation",name,Some(ReportRequest {id:100,supersedes:vec![],channel:"measurement".into()}),Lane::Heavy,
                    move ||Ok(read_only_connection(&path)),move |conn| {
                        let _=ready.send(());
                        let range=Range {preset:Some("all".into()),anchor:Some(now),..Default::default()};
                        let filters=Filters::default();
                        match name {
                            "rework_rankings"=>query::rework_rankings(conn,&range,&filters,now).map(|r|r.timings),
                            "usage_rhythm"=>crate::ailog::usage::rhythm(conn,&range,&filters,now).map(|r|r.timings),
                            _=>g1_3_query(conn,name,&range,now),
                        }
                    }).await
            });
            wait.await.unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            let started=Instant::now();
            runtime().run("g1-3-cancellation",name,Some(ReportRequest {id:101,supersedes:vec![100],channel:"measurement".into()}),Lane::Heavy,
                move ||Ok(read_only_connection(&next_path)),|_|Ok(())).await.unwrap();
            let release_ms=started.elapsed().as_secs_f64()*1000.0;
            let cancelled=old.await.unwrap().unwrap_err()==CANCELLED;
            println!("AILOG_G1_3_CANCELLATION={}",serde_json::json!({"report":name,"iteration":iteration,"release_ms":release_ms,"old_cancelled":cancelled}));
            assert!(cancelled);
            assert!(release_ms<=200.0);
        }
    }
}
