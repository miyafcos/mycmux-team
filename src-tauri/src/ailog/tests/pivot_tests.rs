//! Cross-tabulation totals must match the 1-D breakdowns they fold.

use super::fixtures::*;
use crate::ailog::{query, Filters, Range, KIND_CLAUDE};

const NOW: i64 = 1_800_000_000_000;

fn pivot_project_by_model() -> query::PivotOptions {
    query::PivotOptions {
        row_by: "project".to_string(),
        col_by: "model".to_string(),
    }
}

fn mixed_fixture() -> Fixture {
    let fixture = Fixture::new();
    fixture.write("S1.jsonl", CLAUDE_SPLIT_REQUEST);
    fixture.write("S2.jsonl", CLAUDE_IO_SESSION);
    fixture.write("S3.jsonl", CLAUDE_MIXED_MODELS);
    fixture.index(KIND_CLAUDE, false);
    fixture
}

fn by_key(rows: &[query::BreakdownRow]) -> std::collections::BTreeMap<&str, &query::BreakdownRow> {
    rows.iter().map(|row| (row.key.as_str(), row)).collect()
}

#[test]
fn pivot_row_totals_match_breakdown_on_the_row_axis() {
    let fixture = mixed_fixture();
    let conn = fixture.conn();
    let range = Range::default();
    let filters = Filters::default();
    let pivot = query::pivot(&conn, &range, &filters, &pivot_project_by_model(), NOW).unwrap();
    let breakdown = query::breakdown(&conn, &range, &filters, "project", NOW).unwrap();

    assert_eq!(pivot.row_by, "project");
    assert_eq!(pivot.rows.len(), breakdown.rows.len());
    let expected = by_key(&breakdown.rows);
    for row in &pivot.rows {
        let other = expected
            .get(row.key.as_str())
            .unwrap_or_else(|| panic!("missing breakdown row {}", row.key));
        assert_eq!(row.total.turns, other.turns, "turns {}", row.key);
        assert_eq!(row.total.sessions, other.sessions, "sessions {}", row.key);
        assert_eq!(row.total.input, other.input, "input {}", row.key);
        assert_eq!(row.total.output, other.output, "output {}", row.key);
        assert_eq!(row.total.cache_read, other.cache_read, "cache_read {}", row.key);
        assert_eq!(row.total.cache_write, other.cache_write, "cache_write {}", row.key);
        assert_eq!(row.total.cost_usd, other.cost_usd, "cost {}", row.key);
    }
}

#[test]
fn pivot_col_totals_match_breakdown_on_the_col_axis() {
    let fixture = mixed_fixture();
    let conn = fixture.conn();
    let range = Range::default();
    let filters = Filters::default();
    let pivot = query::pivot(&conn, &range, &filters, &pivot_project_by_model(), NOW).unwrap();
    let breakdown = query::breakdown(&conn, &range, &filters, "model", NOW).unwrap();

    assert_eq!(pivot.col_by, "model");
    assert_eq!(pivot.cols.len(), breakdown.rows.len());
    let expected = by_key(&breakdown.rows);
    for (index, col) in pivot.cols.iter().enumerate() {
        let total = &pivot.col_totals[index];
        let other = expected
            .get(col.as_str())
            .unwrap_or_else(|| panic!("missing breakdown col {col}"));
        assert_eq!(total.turns, other.turns, "turns {col}");
        assert_eq!(total.sessions, other.sessions, "sessions {col}");
        assert_eq!(total.input, other.input, "input {col}");
        assert_eq!(total.output, other.output, "output {col}");
        assert_eq!(total.cost_usd, other.cost_usd, "cost {col}");
    }
}

#[test]
fn pivot_does_not_double_count_a_session_that_spans_models() {
    let fixture = mixed_fixture();
    let conn = fixture.conn();
    let pivot = query::pivot(
        &conn,
        &Range::default(),
        &Filters::default(),
        &pivot_project_by_model(),
        NOW,
    )
    .unwrap();

    let mixed = pivot
        .rows
        .iter()
        .find(|row| row.cells.iter().filter(|cell| cell.sessions > 0).count() >= 2)
        .expect("one project uses two model families");
    let cell_session_sum: i64 = mixed.cells.iter().map(|cell| cell.sessions).sum();
    assert!(
        cell_session_sum > mixed.total.sessions,
        "cell sessions {cell_session_sum} should exceed de-duplicated row total {}",
        mixed.total.sessions
    );
    assert!(
        mixed
            .cells
            .iter()
            .all(|cell| cell.sessions <= mixed.total.sessions),
        "no cell may count more sessions than the de-duplicated row"
    );

    let breakdown = query::breakdown(
        &conn,
        &Range::default(),
        &Filters::default(),
        "project",
        NOW,
    )
    .unwrap();
    let expected = breakdown
        .rows
        .iter()
        .find(|row| row.key == mixed.key)
        .expect("matching breakdown row");
    assert_eq!(mixed.total.sessions, expected.sessions);

    let summed_cell_sessions: i64 = pivot
        .rows
        .iter()
        .flat_map(|row| row.cells.iter().map(|cell| cell.sessions))
        .sum();
    assert!(
        summed_cell_sessions > pivot.grand_total.sessions,
        "sum of cell sessions {summed_cell_sessions} must exceed distinct grand total {}",
        pivot.grand_total.sessions
    );
}

#[test]
fn pivot_zero_fills_every_row_to_the_declared_columns() {
    let fixture = mixed_fixture();
    let conn = fixture.conn();
    let pivot = query::pivot(
        &conn,
        &Range::default(),
        &Filters::default(),
        &pivot_project_by_model(),
        NOW,
    )
    .unwrap();
    assert!(!pivot.cols.is_empty());
    for row in &pivot.rows {
        assert_eq!(row.cells.len(), pivot.cols.len());
        for (index, cell) in row.cells.iter().enumerate() {
            assert_eq!(cell.group, pivot.cols[index]);
        }
    }
    assert_eq!(pivot.col_totals.len(), pivot.cols.len());
}
