//! Dashboard aggregation compatibility tests.

use std::time::Instant;

use super::fixtures::*;
use crate::ailog::{query, rollup, Filters, Range, KIND_CLAUDE, KIND_CODEX};

const NOW: i64 = 1_800_000_000_000;

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

fn report_value(report: impl serde::Serialize) -> serde_json::Value {
    let mut value = serde_json::to_value(report).unwrap();
    remove_timings(&mut value);
    value
}

#[test]
fn migrated_reports_expose_rollup_timings_and_other_reports_stay_raw() {
    let fixture = Fixture::new();
    fixture.write("S1.jsonl", CLAUDE_SPLIT_REQUEST);
    fixture.index(KIND_CLAUDE, false);
    let conn = fixture.conn();
    let range = Range::default();
    let filters = Filters::default();
    let options = query::SessionsOptions::default();
    let migrated_timings = [
        query::overview(&conn, &range, &filters, NOW)
            .unwrap()
            .timings,
        query::sessions(&conn, &range, &filters, &options, NOW)
            .unwrap()
            .timings,
        // `models` joined the rollup path once hand-off counting moved out to
        // `model_handoffs`; the row/series aggregates it keeps are all
        // buildable from the daily rollup.
        query::models(
            &conn,
            &range,
            &filters,
            &query::ModelsOptions::default(),
            NOW,
        )
        .unwrap()
        .timings,
    ];
    assert!(migrated_timings
        .iter()
        .all(|timing| timing.path == "rollup"));
    let raw_timings = [
        query::efficiency(&conn, &range, &filters, NOW)
            .unwrap()
            .timings,
        query::rule_check(&conn, &range, &filters, NOW)
            .unwrap()
            .timings,
        query::rework_rankings(&conn, &range, &filters, NOW)
            .unwrap()
            .timings,
        query::dashboard(&conn, &range, &filters, "family", NOW)
            .unwrap()
            .timings,
    ];
    assert!(raw_timings.iter().all(|timing| timing.path == "raw"));
    assert_eq!(
        query::series(
            &conn,
            &range,
            &filters,
            &query::SeriesOptions::default(),
            NOW
        )
        .unwrap()
        .timings
        .path,
        "rollup"
    );
    assert_eq!(
        query::breakdown(&conn, &range, &filters, "project", NOW)
            .unwrap()
            .timings
            .path,
        "rollup"
    );
}

#[test]
fn dashboard_matches_the_individual_report_contracts() {
    let fixture = Fixture::new();
    fixture.write("S1.jsonl", CLAUDE_SPLIT_REQUEST);
    fixture.write("S2.jsonl", CLAUDE_IO_SESSION);
    fixture.write("S3.jsonl", CLAUDE_MIXED_MODELS);
    fixture.write("S4.jsonl", CLAUDE_UNKNOWN_MODEL);
    fixture.write("CX1.jsonl", CODEX_TOKEN_COUNTS);
    fixture.write("CX2.jsonl", CODEX_HANDOFF);
    fixture.index(KIND_CLAUDE, false);
    fixture.index(KIND_CODEX, false);

    let conn = fixture.conn();
    let range = Range::default();
    let filters = Filters::default();
    let granularity = "family";

    let overview = query::overview(&conn, &range, &filters, NOW).unwrap();
    let series = query::series(
        &conn,
        &range,
        &filters,
        &query::SeriesOptions {
            bucket: "day".to_string(),
            group_by: "none".to_string(),
        },
        NOW,
    )
    .unwrap();
    let models = query::models(
        &conn,
        &range,
        &filters,
        &query::ModelsOptions {
            granularity: granularity.to_string(),
            bucket: "day".to_string(),
        },
        NOW,
    )
    .unwrap();
    let projects = query::breakdown(&conn, &range, &filters, "project", NOW).unwrap();
    let sessions = query::sessions(
        &conn,
        &range,
        &filters,
        &query::SessionsOptions {
            sort: "rework".to_string(),
            limit: 100,
            offset: 0,
        },
        NOW,
    )
    .unwrap();

    let dashboard = query::dashboard(&conn, &range, &filters, granularity, NOW).unwrap();

    assert_eq!(report_value(overview), report_value(dashboard.overview));
    assert_eq!(report_value(series), report_value(dashboard.series));
    assert_eq!(report_value(models), report_value(dashboard.models));
    assert_eq!(report_value(projects), report_value(dashboard.projects));
    assert_eq!(report_value(sessions), report_value(dashboard.sessions));
}

#[test]
fn reports_are_deterministic_when_turn_storage_order_changes() {
    fn seed(fixture: &Fixture, insertion_order: &[i64]) {
        let conn = fixture.conn();
        for session_id in ["handoff", "steady"] {
            conn.execute(
                "INSERT INTO session (kind, session_id, project_label, started_at, cost_usd) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![KIND_CLAUDE, session_id, "determinism", NOW - 100, 0.0_f64],
            )
            .unwrap();
        }
        for seq in insertion_order {
            let (session_id, model) = match seq {
                1 => ("handoff", "gpt-5.6-terra"),
                2 => ("handoff", "gpt-5.6-sol"),
                3 => ("handoff", "gpt-5.6-terra"),
                4 => ("steady", "gpt-5.6-terra"),
                _ => ("steady", "gpt-5.6-terra"),
            };
            let turn_seq = if *seq == 4 { 1 } else { *seq };
            conn.execute(
                "INSERT INTO turn (kind, session_id, seq, ts, model, model_family, \
                 input_tokens, output_tokens, cost_usd) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![
                    KIND_CLAUDE,
                    session_id,
                    turn_seq,
                    NOW - 10 - seq,
                    model,
                    "gpt-5.6",
                    100_i64,
                    20_i64,
                    0.0_f64,
                ],
            )
            .unwrap();
        }
    }

    fn reports(fixture: &Fixture) -> Vec<serde_json::Value> {
        let conn = fixture.conn();
        conn.pragma_update(None, "reverse_unordered_selects", "ON")
            .unwrap();
        let range = Range {
            from: Some(0),
            to: Some(NOW),
            preset: None,
        };
        let filters = Filters::default();
        let models = query::ModelsOptions {
            granularity: "raw".to_string(),
            bucket: "day".to_string(),
        };
        let sessions = query::SessionsOptions {
            sort: "cost".to_string(),
            limit: 50,
            offset: 0,
        };
        let mut values = vec![
            report_value(query::overview(&conn, &range, &filters, NOW).unwrap()),
            report_value(
                query::series(
                    &conn,
                    &range,
                    &filters,
                    &query::SeriesOptions::default(),
                    NOW,
                )
                .unwrap(),
            ),
            report_value(query::models(&conn, &range, &filters, &models, NOW).unwrap()),
            report_value(query::breakdown(&conn, &range, &filters, "project", NOW).unwrap()),
            report_value(query::breakdown(&conn, &range, &filters, "agent", NOW).unwrap()),
            report_value(query::sessions(&conn, &range, &filters, &sessions, NOW).unwrap()),
            report_value(query::dashboard(&conn, &range, &filters, "raw", NOW).unwrap()),
        ];
        for value in &mut values {
            remove_timings(value);
        }
        values
    }

    let ordered = Fixture::new();
    seed(&ordered, &[1, 2, 3, 4]);
    let shuffled = Fixture::new();
    seed(&shuffled, &[3, 1, 4, 2]);

    assert_eq!(reports(&ordered), reports(&shuffled));

    let conn = ordered.conn();
    let models = query::model_handoffs(
        &conn,
        &Range {
            from: Some(0),
            to: Some(NOW),
            preset: None,
        },
        &Filters::default(),
        &query::ModelsOptions {
            granularity: "raw".to_string(),
            bucket: "day".to_string(),
        },
        NOW,
    )
    .unwrap();
    assert!(models.handoffs.iter().any(|handoff| {
        handoff.from == "gpt-5.6-terra" && handoff.to == "gpt-5.6-sol" && handoff.count == 1
    }));
    assert!(models.handoffs.iter().any(|handoff| {
        handoff.from == "gpt-5.6-sol" && handoff.to == "gpt-5.6-terra" && handoff.count == 1
    }));
}

#[test]
fn rework_summary_keeps_missing_rows_in_the_average_denominator() {
    let fixture = Fixture::new();
    let conn = fixture.conn();
    for session_id in ["S1", "S2", "S3"] {
        conn.execute(
            "INSERT INTO session (kind, session_id, project_label, started_at, cost_usd) \
             VALUES (?1, ?2, 'rework', ?3, 0)",
            rusqlite::params![KIND_CLAUDE, session_id, NOW - 100],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO turn (kind, session_id, seq, ts, model, model_family) \
             VALUES (?1, ?2, 1, ?3, 'gpt-5.6-terra', 'gpt-5.6')",
            rusqlite::params![KIND_CLAUDE, session_id, NOW - 10],
        )
        .unwrap();
    }
    conn.execute(
        "INSERT INTO rework (kind, session_id, tool_error_count, tool_call_count, correction_count, \
         churn_files, abandoned, score) VALUES (?1, 'S1', 3, 4, 5, 6, 1, 10)",
        rusqlite::params![KIND_CLAUDE],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO rework (kind, session_id, tool_error_count, tool_call_count, correction_count, \
         churn_files, abandoned, score) VALUES (?1, 'S2', 1, 2, 7, 8, 0, 20)",
        rusqlite::params![KIND_CLAUDE],
    )
    .unwrap();

    let range = Range {
        from: Some(0),
        to: Some(NOW),
        preset: None,
    };
    let overview = query::overview(&conn, &range, &Filters::default(), NOW).unwrap();
    assert_eq!(overview.totals.sessions, 3);
    assert_eq!(overview.rework.avg_score, 10.0);
    assert_eq!(overview.rework.tool_error_rate, 4.0 / 6.0);
    assert_eq!(overview.rework.correction_hits, 12);
    assert_eq!(overview.rework.churn_files, 14);
    assert_eq!(overview.rework.abandoned_sessions, 1);
}

/// Run explicitly with the Windows test wrapper's generated binary and
/// `--ignored --nocapture` when recording an implementation performance check.
#[test]
#[ignore = "records dashboard refresh timing on a representative SQLite fixture"]
fn dashboard_refresh_is_faster_than_five_individual_reports() {
    const SESSION_COUNT: i64 = 5_000;

    let fixture = Fixture::new();
    let mut conn = fixture.conn();
    let tx = conn.transaction().unwrap();
    for index in 0..SESSION_COUNT {
        let session_id = format!("benchmark-{index}");
        tx.execute(
            "INSERT INTO session (kind, session_id, project_label, started_at, cost_usd) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![KIND_CLAUDE, session_id, "benchmark", NOW - index, 0.03_f64],
        )
        .unwrap();
        for seq in 0..2 {
            tx.execute(
                "INSERT INTO turn (kind, session_id, seq, ts, model, model_family, \
                 input_tokens, output_tokens, cost_usd) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![
                    KIND_CLAUDE,
                    format!("benchmark-{index}"),
                    seq,
                    NOW - index - seq,
                    "gpt-5.6-terra",
                    "gpt-5.6",
                    100_i64,
                    20_i64,
                    0.015_f64,
                ],
            )
            .unwrap();
        }
    }
    tx.commit().unwrap();

    let range = Range {
        from: Some(0),
        to: Some(NOW),
        preset: None,
    };
    let filters = Filters::default();
    let legacy_started = Instant::now();
    query::overview(&conn, &range, &filters, NOW).unwrap();
    query::series(
        &conn,
        &range,
        &filters,
        &query::SeriesOptions::default(),
        NOW,
    )
    .unwrap();
    query::models(
        &conn,
        &range,
        &filters,
        &query::ModelsOptions::default(),
        NOW,
    )
    .unwrap();
    query::breakdown(&conn, &range, &filters, "project", NOW).unwrap();
    query::sessions(
        &conn,
        &range,
        &filters,
        &query::SessionsOptions {
            sort: "cost".to_string(),
            limit: SESSION_COUNT,
            offset: 0,
        },
        NOW,
    )
    .unwrap();
    let legacy_elapsed = legacy_started.elapsed();

    let dashboard_started = Instant::now();
    query::dashboard(&conn, &range, &filters, "family", NOW).unwrap();
    let dashboard_elapsed = dashboard_started.elapsed();

    println!(
        "dashboard refresh timing: legacy={}ms dashboard={}ms sessions={SESSION_COUNT}",
        legacy_elapsed.as_millis(),
        dashboard_elapsed.as_millis(),
    );
    assert!(dashboard_elapsed < legacy_elapsed);
}

#[test]
fn models_and_pivot_defaults_keep_raw_tiers_apart() {
    assert_eq!(query::ModelsOptions::default().granularity, "raw");
    assert_eq!(query::PivotOptions::default().col_by, "model_raw");
}

const DAY: i64 = 86_400_000;

fn range_all() -> Range {
    Range {
        from: Some(0),
        to: Some(NOW),
        preset: None,
    }
}

fn session_options() -> query::SessionsOptions {
    query::SessionsOptions {
        sort: "cost".to_string(),
        limit: 50,
        offset: 0,
    }
}

fn insert_session(conn: &rusqlite::Connection, session_id: &str) {
    conn.execute(
        "INSERT INTO session (kind, session_id, project_label, started_at, cost_usd) \
         VALUES (?1, ?2, 'range-models', ?3, 0)",
        rusqlite::params![KIND_CLAUDE, session_id, NOW - 20 * DAY],
    )
    .unwrap();
}

fn insert_turn(
    conn: &rusqlite::Connection,
    session_id: &str,
    seq: i64,
    ts: i64,
    model: Option<&str>,
    input: i64,
    output: i64,
    cost: f64,
) {
    conn.execute(
        "INSERT INTO turn (kind, session_id, seq, ts, model, model_family, \
         input_tokens, output_tokens, cost_usd) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            KIND_CLAUDE,
            session_id,
            seq,
            ts,
            model,
            model.map(|name| name.rsplit_once('-').map(|(family, _)| family).unwrap_or(name)),
            input,
            output,
            cost,
        ],
    )
    .unwrap();
}

fn rebuild_rollup(conn: &rusqlite::Connection) {
    rollup::mark_all_dirty(conn).unwrap();
    rollup::rebuild_dirty(conn).unwrap();
}

fn sessions_on(conn: &rusqlite::Connection, filters: &Filters) -> query::SessionsReport {
    query::sessions(conn, &range_all(), filters, &session_options(), NOW).unwrap()
}

fn find_session<'a>(
    report: &'a query::SessionsReport,
    session_id: &str,
) -> &'a query::SessionRow {
    report
        .rows
        .iter()
        .find(|row| row.session_id == session_id)
        .unwrap_or_else(|| panic!("missing session {session_id}"))
}

#[test]
fn session_text_search_keeps_total_across_pages() {
    let fixture = Fixture::new();
    let conn = fixture.conn();
    for session_id in ["title-hit", "project-hit", "miss"] {
        insert_session(&conn, session_id);
        insert_turn(
            &conn,
            session_id,
            1,
            NOW - DAY,
            Some("gpt-5.6-sol"),
            100,
            10,
            1.0,
        );
    }
    conn.execute(
        "UPDATE session SET ai_title = 'Needle in title' WHERE session_id = 'title-hit'",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE session SET project_label = 'needle-project' WHERE session_id = 'project-hit'",
        [],
    )
    .unwrap();

    let mut filters = Filters::default();
    filters.query = Some("needle".to_string());
    for (offset, expected_rows) in [(0, 1), (1, 1), (5, 0)] {
        let report = query::sessions(
            &conn,
            &range_all(),
            &filters,
            &query::SessionsOptions {
                sort: "cost".to_string(),
                limit: 1,
                offset,
            },
            NOW,
        )
        .unwrap();
        assert_eq!(report.total, 2);
        assert_eq!(report.rows.len(), expected_rows);
    }
}

#[test]
fn range_models_merge_sol_and_terra_across_two_days() {
    let fixture = Fixture::new();
    let conn = fixture.conn();
    insert_session(&conn, "two-day");
    insert_turn(
        &conn,
        "two-day",
        1,
        NOW - 10 * DAY,
        Some("gpt-5.6-sol"),
        800,
        200,
        1.0,
    );
    insert_turn(
        &conn,
        "two-day",
        2,
        NOW - 5 * DAY,
        Some("gpt-5.6-terra"),
        80,
        20,
        0.1,
    );
    rebuild_rollup(&conn);

    let report = sessions_on(&conn, &Filters::default());
    assert_eq!(report.timings.path, "rollup");
    let row = find_session(&report, "two-day");
    assert_eq!(
        row.range_models,
        vec!["gpt-5.6-sol".to_string(), "gpt-5.6-terra".to_string()]
    );
    assert_eq!(row.range_model_count, 2);
}

#[test]
fn range_models_keep_the_top_three_and_the_full_count() {
    let fixture = Fixture::new();
    let conn = fixture.conn();
    insert_session(&conn, "four-models");
    insert_turn(&conn, "four-models", 1, NOW - 10 * DAY, Some("gpt-5.6-sol"), 400, 0, 0.4);
    insert_turn(&conn, "four-models", 2, NOW - 10 * DAY, Some("gpt-5.6-terra"), 300, 0, 0.3);
    insert_turn(&conn, "four-models", 3, NOW - 10 * DAY, Some("gpt-5.6-luna"), 200, 0, 0.2);
    insert_turn(&conn, "four-models", 4, NOW - 10 * DAY, Some("claude-opus-5"), 100, 0, 0.1);
    rebuild_rollup(&conn);

    let sessions = sessions_on(&conn, &Filters::default());
    let row = find_session(&sessions, "four-models");
    assert_eq!(
        row.range_models,
        vec![
            "gpt-5.6-sol".to_string(),
            "gpt-5.6-terra".to_string(),
            "gpt-5.6-luna".to_string()
        ]
    );
    assert_eq!(row.range_model_count, 4);
}

#[test]
fn range_models_rank_by_tokens_not_cost() {
    let fixture = Fixture::new();
    let conn = fixture.conn();
    insert_session(&conn, "token-rank");
    insert_turn(
        &conn,
        "token-rank",
        1,
        NOW - 10 * DAY,
        Some("high-cost-low-tokens"),
        10,
        10,
        99.0,
    );
    insert_turn(
        &conn,
        "token-rank",
        2,
        NOW - 10 * DAY,
        Some("zero-cost-high-tokens"),
        10_000,
        10_000,
        0.0,
    );
    rebuild_rollup(&conn);

    let sessions = sessions_on(&conn, &Filters::default());
    let row = find_session(&sessions, "token-rank");
    assert_eq!(row.range_models[0], "zero-cost-high-tokens");
    assert_eq!(
        row.range_models,
        vec![
            "zero-cost-high-tokens".to_string(),
            "high-cost-low-tokens".to_string()
        ]
    );
}

#[test]
fn range_models_use_unknown_when_every_turn_model_is_null() {
    let fixture = Fixture::new();
    let conn = fixture.conn();
    insert_session(&conn, "null-model");
    insert_turn(&conn, "null-model", 1, NOW - 10 * DAY, None, 100, 50, 0.0);
    rebuild_rollup(&conn);

    let sessions = sessions_on(&conn, &Filters::default());
    let row = find_session(&sessions, "null-model");
    assert_eq!(row.range_models, vec!["(unknown)".to_string()]);
    assert_eq!(row.range_model_count, 1);
}

#[test]
fn range_models_match_between_rollup_and_raw_paths() {
    let fixture = Fixture::new();
    let conn = fixture.conn();
    insert_session(&conn, "compat");
    insert_turn(&conn, "compat", 1, NOW - 10 * DAY, Some("gpt-5.6-sol"), 800, 200, 1.0);
    insert_turn(&conn, "compat", 2, NOW - 5 * DAY, Some("gpt-5.6-terra"), 80, 20, 0.1);
    insert_turn(&conn, "compat", 3, NOW - 5 * DAY, Some("gpt-5.6-luna"), 40, 10, 0.05);
    insert_turn(&conn, "compat", 4, NOW - 5 * DAY, Some("claude-opus-5"), 10, 5, 0.01);
    rebuild_rollup(&conn);

    let rollup_report = sessions_on(&conn, &Filters::default());
    assert_eq!(rollup_report.timings.path, "rollup");
    let mut raw_filters = Filters::default();
    raw_filters.min_cost = Some(0.0);
    let raw_report = sessions_on(&conn, &raw_filters);
    assert_eq!(raw_report.timings.path, "raw");

    let rollup_row = find_session(&rollup_report, "compat");
    let raw_row = find_session(&raw_report, "compat");
    assert_eq!(rollup_row.range_models, raw_row.range_models);
    assert_eq!(rollup_row.range_model_count, raw_row.range_model_count);
    assert_eq!(rollup_row.range_model_count, 4);
    assert_eq!(rollup_row.range_models.len(), 3);
}
