//! Dashboard aggregation compatibility tests.

use std::time::Instant;

use super::fixtures::*;
use crate::ailog::{query, Filters, Range, KIND_CLAUDE, KIND_CODEX};

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
    ];
    assert!(migrated_timings
        .iter()
        .all(|timing| timing.path == "rollup"));
    let raw_timings = [
        query::models(
            &conn,
            &range,
            &filters,
            &query::ModelsOptions::default(),
            NOW,
        )
        .unwrap()
        .timings,
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
            sort: "cost".to_string(),
            limit: 5000,
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
    let models = query::models(
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
