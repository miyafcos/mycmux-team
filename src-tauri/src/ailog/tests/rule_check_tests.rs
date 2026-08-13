use rusqlite::{params, Connection, OpenFlags};

use super::fixtures::Fixture;
use crate::ailog::{query, Filters, Range};

const NOW: i64 = 10_000;

fn seed(
    conn: &Connection,
    id: &str,
    project: &str,
    origin: &str,
    input: i64,
    cache_read: i64,
    cost: f64,
    compact_count: i64,
) {
    conn.execute(
        "INSERT INTO session (kind, session_id, project_label, origin, ai_title, started_at, compact_count) \
         VALUES ('claude', ?, ?, ?, ?, ?, ?)",
        params![id, project, origin, format!("title-{id}"), NOW - 1, compact_count],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO turn (kind, session_id, seq, ts, input_tokens, cache_read_tokens, cost_usd) \
         VALUES ('claude', ?, 1, ?, ?, ?, ?)",
        params![id, NOW - 1, input, cache_read, cost],
    )
    .unwrap();
}

#[test]
fn rule_check_observes_threshold_excludes_internal_and_returns_top_five() {
    let fixture = Fixture::new();
    let conn = fixture.conn();
    seed(&conn, "exact", "keep", "unknown", 300_000, 0, 99.0, 0);
    for index in 0..6 {
        seed(
            &conn,
            &format!("large-{index}"),
            "keep",
            "unknown",
            300_001,
            0,
            index as f64,
            if index % 2 == 0 { 1 } else { 0 },
        );
    }
    seed(
        &conn,
        "internal",
        "keep",
        "ailog-internal",
        500_000,
        0,
        999.0,
        2,
    );

    let report = query::rule_check(&conn, &Range::default(), &Filters::default(), NOW).unwrap();
    assert_eq!(report.large_context.count, 6);
    assert_eq!(report.large_context.sessions.len(), 5);
    assert_eq!(report.large_context.sessions[0].session_id, "large-5");
    assert!(report
        .large_context
        .sessions
        .iter()
        .all(|row| row.session_id != "exact"));
    assert!(report
        .large_context
        .sessions
        .iter()
        .all(|row| row.session_id != "internal"));
    assert_eq!(report.compacted.count, 3);
    assert_eq!(report.compacted.sessions[0].session_id, "large-4");
}

#[test]
fn rule_check_applies_range_and_project_filters() {
    let fixture = Fixture::new();
    let conn = fixture.conn();
    seed(&conn, "keep", "selected", "unknown", 300_001, 0, 1.0, 1);
    seed(&conn, "skip", "other", "unknown", 300_001, 0, 2.0, 1);
    let mut filters = Filters::default();
    filters.projects = vec!["selected".to_string()];

    let report = query::rule_check(&conn, &Range::default(), &filters, NOW).unwrap();
    assert_eq!(report.large_context.count, 1);
    assert_eq!(report.large_context.sessions[0].session_id, "keep");
    assert_eq!(report.compacted.count, 1);
}

#[test]
fn smoke_real_database_efficiency_and_rule_check_are_read_only() {
    let path = crate::ailog::db_path().expect("ailog db path");
    if !path.is_file() {
        println!("live ailog database unavailable");
        return;
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("open live ailog database read-only");
    let range = Range {
        from: None,
        to: None,
        preset: Some("all".to_string()),
    };
    let now = chrono::Utc::now().timestamp_millis();
    let efficiency =
        query::efficiency(&conn, &range, &Filters::default(), now).expect("live efficiency");
    let rules =
        query::rule_check(&conn, &range, &Filters::default(), now).expect("live rule check");
    println!(
        "live efficiency effort={} subagent={} compaction={} quantiles={}; rule_check large_context={} compacted={}",
        efficiency.by_effort.len(),
        efficiency.by_subagent.len(),
        efficiency.by_compaction.len(),
        efficiency.turn_quantiles.len(),
        rules.large_context.count,
        rules.compacted.count,
    );
}
