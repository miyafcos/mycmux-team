use rusqlite::{params, Connection};

use super::fixtures::Fixture;
use crate::ailog::{query, Filters, Range};

const NOW: i64 = 2_000;

fn seed(conn: &Connection, id: &str, ts: i64, origin: &str, findings: &str) {
    conn.execute("INSERT INTO session (kind,session_id,origin,started_at,project_label,cost_usd) VALUES ('claude',?,?,?,?,?)", params![id, origin, ts, "project", 1.0]).unwrap();
    conn.execute(
        "INSERT INTO turn (kind,session_id,seq,ts) VALUES ('claude',?,?,?)",
        params![id, 1, ts],
    )
    .unwrap();
    conn.execute("INSERT INTO summary (kind,session_id,created_at,findings,goal_summary) VALUES ('claude',?,?,?,?)", params![id, ts, findings, "goal"]).unwrap();
}

#[test]
fn findings_expand_filter_search_repeat_and_exclude_internal() {
    let fixture = Fixture::new();
    let conn = fixture.conn();
    seed(
        &conn,
        "old",
        1_000,
        "unknown",
        r#"[{"text":"Run tests first!","kind":"gotcha"}]"#,
    );
    seed(
        &conn,
        "new",
        1_500,
        "unknown",
        r#"[{"text":"run tests first","kind":"gotcha"},{"text":"decision","kind":"decision"}]"#,
    );
    seed(
        &conn,
        "internal",
        1_800,
        "ailog-internal",
        r#"[{"text":"run tests first","kind":"gotcha"}]"#,
    );
    seed(
        &conn,
        "other",
        1_600,
        "unknown",
        r#"[{"text":"Deploy only after approval","kind":"gotcha"}]"#,
    );
    let report = query::findings(
        &conn,
        &Range::default(),
        &Filters::default(),
        &query::FindingsOptions {
            kind: Some("gotcha".into()),
            query: Some("RUN".into()),
            limit: 50,
            offset: 0,
        },
        NOW,
    )
    .unwrap();
    assert_eq!(report.total, 2);
    assert_eq!(report.rows[0].session_id, "new");
    assert_eq!(
        report
            .rows
            .iter()
            .find(|row| row.session_id == "old")
            .unwrap()
            .repeat_count,
        2
    );
    let all = query::findings(
        &conn,
        &Range::default(),
        &Filters::default(),
        &query::FindingsOptions::default(),
        NOW,
    )
    .unwrap();
    assert_eq!(
        all.rows
            .iter()
            .find(|row| row.session_id == "other")
            .unwrap()
            .repeat_count,
        1
    );
}

#[test]
fn same_session_findings_do_not_form_a_repeat_group() {
    let fixture = Fixture::new();
    let conn = fixture.conn();
    seed(
        &conn,
        "one",
        1_000,
        "unknown",
        r#"[{"text":"Run tests first","kind":"gotcha"},{"text":"run tests first!","kind":"gotcha"}]"#,
    );
    let report = query::findings(
        &conn,
        &Range::default(),
        &Filters::default(),
        &query::FindingsOptions::default(),
        NOW,
    )
    .unwrap();
    assert!(report.rows.iter().all(|row| row.repeat_count == 1));
}

#[test]
fn lsh_repeat_counts_match_exact_groups_away_from_the_threshold() {
    let fixture = Fixture::new();
    let conn = fixture.conn();
    // 150 identical members per group have similarity 1.0 within a group and
    // intentionally disjoint 3-grams across groups, well away from 0.55.
    for index in 0..300 {
        let (id, text) = if index < 150 {
            (format!("alpha-{index}"), "alpha bravo charlie delta echo foxtrot")
        } else {
            (format!("omega-{index}"), "uniform victor whiskey xray yankee zulu")
        };
        seed(
            &conn,
            &id,
            1_000 + index as i64,
            "unknown",
            &format!(r#"[{{\"text\":\"{text}\",\"kind\":\"gotcha\"}}]"#),
        );
    }
    let options = query::FindingsOptions { limit: 50, ..Default::default() };
    let first = query::findings(&conn, &Range::default(), &Filters::default(), &options, NOW).unwrap();
    let second = query::findings(&conn, &Range::default(), &Filters::default(), &options, NOW).unwrap();
    assert!(!first.repeat_truncated);
    assert_eq!(first.rows.len(), second.rows.len());
    assert!(first.rows.iter().all(|row| row.repeat_count == 150));
    assert_eq!(
        first.rows.iter().map(|row| row.repeat_count).collect::<Vec<_>>(),
        second.rows.iter().map(|row| row.repeat_count).collect::<Vec<_>>(),
    );
}

#[test]
fn rankings_aggregate_rates_and_allow_empty_file_touch() {
    let fixture = Fixture::new();
    let conn = fixture.conn();
    seed(&conn, "one", 1_000, "unknown", "[]");
    seed(&conn, "two", 1_100, "unknown", "[]");
    conn.execute("INSERT INTO tool_event (kind,session_id,seq,ts,name,is_error,target) VALUES ('claude','one',1,1000,'Bash',1,'cargo test'),('claude','one',2,1001,'Bash',0,'cargo test'),('claude','two',1,1100,'Bash',1,'cargo test')", []).unwrap();
    let report =
        query::rework_rankings(&conn, &Range::default(), &Filters::default(), NOW).unwrap();
    assert_eq!(report.failed_commands[0].executions, 3);
    assert_eq!(report.failed_commands[0].failures, 2);
    assert!((report.failed_commands[0].failure_rate - 2.0 / 3.0).abs() < 1e-9);
    assert!(report.rewritten_files.is_empty());
}

#[test]
fn rankings_sum_rewritten_files_across_sessions() {
    let fixture = Fixture::new();
    let conn = fixture.conn();
    seed(&conn, "one", 1_000, "unknown", "[]");
    seed(&conn, "two", 1_100, "unknown", "[]");
    conn.execute("INSERT INTO file_touch (kind,session_id,path,edit_count) VALUES ('claude','one','src/a.rs',3),('claude','two','src/a.rs',4)", []).unwrap();
    let report =
        query::rework_rankings(&conn, &Range::default(), &Filters::default(), NOW).unwrap();
    assert_eq!(report.rewritten_files[0].path, "src/a.rs");
    assert_eq!(report.rewritten_files[0].edit_count, 7);
    assert_eq!(report.rewritten_files[0].session_count, 2);
}

#[test]
fn model_filter_applies_to_each_tool_event_turn() {
    let fixture = Fixture::new();
    let conn = fixture.conn();
    conn.execute(
        "INSERT INTO session (kind,session_id,origin,started_at) VALUES ('claude','mixed','unknown',1000)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO turn (kind,session_id,seq,request_id,ts,model,model_family) VALUES \
         ('claude','mixed',1,'turn-a',1200,'model-a','family-a'), \
         ('claude','mixed',2,'turn-b',1300,'model-b','family-b')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO tool_event (kind,session_id,seq,ts,name,is_error,target,turn_key) VALUES \
         ('claude','mixed',1,1201,'Bash',1,'selected-command','turn-a'), \
         ('claude','mixed',2,1301,'Bash',1,'excluded-command','turn-b')",
        [],
    )
    .unwrap();

    let filters = Filters {
        models: vec!["model-a".to_string()],
        ..Filters::default()
    };
    let report = query::rework_rankings(&conn, &Range::default(), &filters, NOW).unwrap();
    assert_eq!(
        report.failed_commands.len(),
        1,
        "R2 a model filter must exclude other-model events in the same session"
    );
    assert_eq!(
        report.failed_commands[0].target.as_deref(),
        Some("selected-command")
    );
}

#[test]
fn file_ranking_documents_cumulative_count_when_period_count_is_unavailable() {
    let fixture = Fixture::new();
    let conn = fixture.conn();
    seed(&conn, "one", 1_500, "unknown", "[]");
    conn.execute(
        "INSERT INTO file_touch (kind,session_id,path,edit_count,first_ts,last_ts) \
         VALUES ('claude','one','src/outside.rs',4,500,900)",
        [],
    )
    .unwrap();
    let range = Range {
        from: Some(1_000),
        to: Some(2_000),
        preset: None,
        anchor: None,
    };
    let report = query::rework_rankings(&conn, &range, &Filters::default(), NOW).unwrap();
    assert_eq!(
        report.rewritten_files.len(),
        1,
        "R3 documents the current session-cumulative fallback"
    );
    assert_eq!(report.rewritten_files[0].path, "src/outside.rs");
    assert_eq!(report.rewritten_files[0].edit_count, 4);
}

/// Reads the operator's database without mutation so release verification can
/// prove both Phase 2 reports against live indexed data rather than fixtures.
#[test]
#[ignore]
fn smoke_real_database_learning_reports() {
    let path = crate::ailog::db_path().expect("ailog db path");
    assert!(path.is_file(), "ailog db not found: {path:?}");
    let conn = crate::ailog::open_db(&path).expect("open live ailog db");
    let now = chrono::Utc::now().timestamp_millis();
    let findings = query::findings(
        &conn,
        &Range {
            from: None,
            to: None,
            preset: Some("all".to_string()),
            anchor: None,
        },
        &Filters::default(),
        &query::FindingsOptions::default(),
        now,
    )
    .expect("live findings");
    let rankings = query::rework_rankings(
        &conn,
        &Range {
            from: None,
            to: None,
            preset: Some("all".to_string()),
            anchor: None,
        },
        &Filters::default(),
        now,
    )
    .expect("live rankings");
    println!("live findings total={}", findings.total);
    println!(
        "live failed_commands={} rewritten_files={}",
        rankings.failed_commands.len(),
        rankings.rewritten_files.len()
    );
}
