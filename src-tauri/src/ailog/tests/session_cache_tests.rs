use super::fixtures::Fixture;
use crate::ailog::{query, Filters, Range, KIND_CLAUDE};

#[test]
fn session_cache_reuses_preparation_for_sort_and_page_but_invalidates_after_indexing() {
    let fixture = Fixture::new();
    fixture.write("a.jsonl", &[
        r#"{"type":"user","sessionId":"sample-a","timestamp":"2026-10-01T00:00:00Z","message":{"content":"sample"}}"#,
        r#"{"type":"assistant","sessionId":"sample-a","timestamp":"2026-10-01T00:00:01Z","message":{"id":"a1","model":"claude-sonnet-5-5","content":[{"type":"text","text":"sample"}],"usage":{"input_tokens":1,"output_tokens":1}}}"#,
        r#"{"type":"assistant","sessionId":"sample-a","timestamp":"2026-10-01T00:00:02Z","message":{"id":"a2","model":"claude-sonnet-5-5","content":[{"type":"text","text":"sample"}],"usage":{"input_tokens":1,"output_tokens":1}}}"#,
    ]);
    fixture.write("b.jsonl", &[
        r#"{"type":"user","sessionId":"sample-b","timestamp":"2026-10-01T00:01:00Z","message":{"content":"sample"}}"#,
        r#"{"type":"assistant","sessionId":"sample-b","timestamp":"2026-10-01T00:01:01Z","message":{"id":"b1","model":"claude-sonnet-5-5","content":[{"type":"text","text":"sample"}],"usage":{"input_tokens":1,"output_tokens":1}}}"#,
    ]);
    fixture.index(KIND_CLAUDE, true);
    let conn = fixture.conn();
    let range = Range { from: Some(0), to: Some(2_000_000_000_000), ..Range::default() };
    let filters = Filters::default();
    let cold = query::sessions(&conn, &range, &filters, &query::SessionsOptions { sort: "recent".into(), limit: 1, offset: 0 }, 2_000_000_000_000).unwrap();
    assert_eq!(cold.rows[0].session_id, "sample-b");
    let preparation = cold.timings.session_prepare.expect("cold preparation must expose measured stages");
    assert!(preparation.aggregate_us + preparation.node_sql_us + preparation.path_us > 0);
    assert!(serde_json::to_value(cold.timings).unwrap()["sessionPrepare"]["nodeSqlUs"].is_number());
    let sorted = query::sessions(&conn, &range, &filters, &query::SessionsOptions { sort: "turns".into(), limit: 1, offset: 0 }, 2_000_000_000_000).unwrap();
    assert_eq!(sorted.rows[0].session_id, "sample-a");
    assert_eq!(sorted.timings.rows_scanned, 0, "sorting must reuse the prepared period");
    assert!(sorted.timings.session_prepare.is_none(), "a reused index must not report an old build as new work");
    let page = query::sessions(&conn, &range, &filters, &query::SessionsOptions { sort: "turns".into(), limit: 1, offset: 1 }, 2_000_000_000_000).unwrap();
    assert_eq!(page.rows[0].session_id, "sample-b");
    assert_eq!(page.total, 2);
    assert_eq!(page.timings.rows_scanned, 0, "paging must reuse the prepared period");
    fixture.append("b.jsonl", &[
        r#"{"type":"assistant","sessionId":"sample-b","timestamp":"2026-10-01T00:01:02Z","message":{"id":"b2","model":"claude-sonnet-5-5","content":[{"type":"text","text":"sample"}],"usage":{"input_tokens":1,"output_tokens":1}}}"#,
        r#"{"type":"assistant","sessionId":"sample-b","timestamp":"2026-10-01T00:01:03Z","message":{"id":"b3","model":"claude-sonnet-5-5","content":[{"type":"text","text":"sample"}],"usage":{"input_tokens":1,"output_tokens":1}}}"#,
    ]);
    fixture.index(KIND_CLAUDE, false);
    let refreshed = query::sessions(&conn, &range, &filters, &query::SessionsOptions { sort: "turns".into(), limit: 1, offset: 0 }, 2_000_000_000_000).unwrap();
    assert_eq!(refreshed.rows[0].session_id, "sample-b", "index changes must invalidate preparation");
    assert_eq!(refreshed.rows[0].presentation.as_ref().unwrap().group_turns, 3);
}
