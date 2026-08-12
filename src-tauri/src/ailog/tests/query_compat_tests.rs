//! Dashboard aggregation compatibility tests.

use std::time::Instant;

use super::fixtures::*;
use crate::ailog::{query, Filters, Range, KIND_CLAUDE, KIND_CODEX};

const NOW: i64 = 1_800_000_000_000;

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

    assert_eq!(
        serde_json::to_value(overview).unwrap(),
        serde_json::to_value(dashboard.overview).unwrap()
    );
    assert_eq!(
        serde_json::to_value(series).unwrap(),
        serde_json::to_value(dashboard.series).unwrap()
    );
    assert_eq!(
        serde_json::to_value(models).unwrap(),
        serde_json::to_value(dashboard.models).unwrap()
    );
    assert_eq!(
        serde_json::to_value(projects).unwrap(),
        serde_json::to_value(dashboard.projects).unwrap()
    );
    assert_eq!(
        serde_json::to_value(sessions).unwrap(),
        serde_json::to_value(dashboard.sessions).unwrap()
    );
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
