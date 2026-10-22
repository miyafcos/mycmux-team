//! Stage 1 accounting acceptance: all amounts use input $2/M, output $10/M.
use std::io::Write;
use std::sync::atomic::AtomicBool;

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use super::fixtures::Fixture;
use crate::ailog::{accounting, parse_ts, query, repair, Filters, Range, KIND_CLAUDE, KIND_CODEX};

fn fixture() -> Fixture {
    let f = Fixture::new();
    for model in ["stage1-a", "stage1-b"] {
        f.conn()
            .execute(
                "INSERT INTO price(model,input_per_mtok,output_per_mtok,cache_read_per_mtok,
            cache_write_5m_per_mtok,cache_write_1h_per_mtok,source) VALUES (?1,2,10,0,0,0,'user')",
                [model],
            )
            .unwrap();
    }
    f
}
fn scalar(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}
fn total(conn: &Connection) -> f64 {
    conn.query_row("SELECT COALESCE(SUM(cost_usd),0) FROM turn", [], |r| {
        r.get(0)
    })
    .unwrap()
}
fn close(actual: f64, expected: f64) {
    assert!((actual - expected).abs() < 1e-9, "{actual} != {expected}")
}
fn claude(
    sid: &str,
    msg: &str,
    req: &str,
    input: i64,
    output: i64,
    child: bool,
    ts: &str,
) -> String {
    json!({"type":"assistant","sessionId":sid,"requestId":req,"uuid":format!("{msg}-{ts}"),
        "isSidechain":child,"timestamp":ts,"cwd":"D:/fixture/project","message":{"id":msg,
            "model":"stage1-a","content":[],"usage":{"input_tokens":input,"output_tokens":output,
                "cache_read_input_tokens":0,"cache_creation_input_tokens":0}}})
    .to_string()
}
const TS: &str = "2026-09-15T00:00:00Z";
fn meta(sid: &str, parent: Option<&str>, fork: bool) -> String {
    let mut payload = json!({"id":sid,"source":"cli","cwd":"D:/fixture/project"});
    if let Some(parent) = parent {
        if fork {
            payload["forked_from_id"] = json!(parent)
        } else {
            payload["thread_source"] = json!("subagent");
            payload["source"] = json!({"subagent":{"thread_spawn":{"parent_thread_id":parent}}})
        }
    }
    json!({"type":"session_meta","payload":payload}).to_string()
}
fn context(turn: Option<&str>, model: Option<&str>) -> String {
    let mut p = json!({"effort":"high"});
    if let Some(t) = turn {
        p["turn_id"] = json!(t)
    }
    if let Some(m) = model {
        p["model"] = json!(m)
    }
    json!({"type":"turn_context","payload":p}).to_string()
}
fn notification(ti: i64, to: i64, li: i64, lo: i64, ordinal: i64) -> String {
    json!({"timestamp":format!("2026-09-15T00:00:{:02}Z",ordinal.rem_euclid(60)),"ordinal":ordinal,
        "type":"event_msg","payload":{"type":"token_count","info":{
            "total_token_usage":{"input_tokens":ti,"output_tokens":to,"total_tokens":ti+to,
                "cached_input_tokens":0,"reasoning_output_tokens":0},
            "last_token_usage":{"input_tokens":li,"output_tokens":lo,"total_tokens":li+lo,
                "cached_input_tokens":0,"reasoning_output_tokens":0}}}})
    .to_string()
}
fn index(f: &Fixture, kind: &'static str) {
    assert!(f.index(kind, false).errors.is_empty())
}

#[test]
fn stage1_claude_parent_and_child_same_native_session_are_separate() {
    let f = fixture();
    f.write("p.jsonl", &[&claude("p", "mp", "rp", 1000, 100, false, TS)]);
    f.write(
        "p/subagents/agent-c.jsonl",
        &[&claude("p", "mc", "rc", 2000, 200, true, TS)],
    );
    index(&f, KIND_CLAUDE);
    let c = f.conn();
    close(total(&c), 0.009);
    assert_eq!(f.count("session"), 2);
    let range = Range {
        from: Some(0),
        to: Some(1_800_000_000_000),
        ..Default::default()
    };
    let a = query::accounting_totals(&c, &range, &Filters::default(), 1_800_000_000_000).unwrap();
    let b = query::accounting_totals(
        &c,
        &range,
        &Filters {
            include_sidechain: true,
            ..Default::default()
        },
        1_800_000_000_000,
    )
    .unwrap();
    close(a.cost_usd, 0.009);
    close(a.cost_usd, b.cost_usd);
    assert_eq!(
        scalar(&c, "SELECT is_sidechain FROM session WHERE session_id='p'"),
        0
    );
    assert_eq!(
        scalar(
            &c,
            "SELECT COUNT(*) FROM session WHERE is_sidechain=1 AND parent_session_id='p'"
        ),
        1
    );
    assert_eq!(
        scalar(&c, "SELECT COUNT(*) FROM session WHERE is_sidechain=0"),
        1
    );
}

#[test]
fn stage1_nested_children_and_identical_gzip_are_counted_once() {
    let f = fixture();
    let p = claude("p", "mp", "rp", 1000, 100, false, TS);
    let child = claude("p", "mc", "rc", 2000, 200, true, TS);
    let grand = claude("p", "mg", "rg", 500, 50, true, TS);
    f.write("p.jsonl", &[&p]);
    f.write("p/subagents/agent-c.jsonl", &[&child]);
    f.write("p/subagents/agent-c/subagents/agent-g.jsonl", &[&grand]);
    f.write_gzip(KIND_CLAUDE, "p/subagents/agent-c.jsonl.gz", &[&child]);
    assert!(f.index_with_archive(KIND_CLAUDE, false).errors.is_empty());
    close(total(&f.conn()), 0.0105);
    assert_eq!(f.count("turn"), 3);
    assert_eq!(f.count("session"), 3);
    let inclusive = accounting::inclusive_sessions(&f.conn(), KIND_CLAUDE, "p").unwrap();
    assert_eq!(inclusive.len(), 3);
}

#[test]
fn stage1_legacy_agent_files_have_source_scoped_child_identity() {
    let f = fixture();
    f.write("p.jsonl", &[&claude("p", "mp", "rp", 1000, 100, false, TS)]);
    f.write(
        "project-a/agent-same.jsonl",
        &[&claude("p", "ma", "ra", 1000, 100, true, TS)],
    );
    f.write(
        "project-b/agent-same.jsonl",
        &[&claude("p", "mb", "rb", 1000, 100, true, TS)],
    );
    index(&f, KIND_CLAUDE);
    assert_eq!(f.count("session"), 3);
    close(total(&f.conn()), 0.009);
}

#[test]
fn stage1_claude_cross_session_snapshot_uses_largest_output_once() {
    let f = fixture();
    let p = claude("p", "same", "same", 1000, 50, false, TS);
    let c = claude("p", "same", "same", 1000, 50, true, TS);
    f.write("p.jsonl", &[&p]);
    f.write("p/subagents/agent-c.jsonl", &[&c]);
    index(&f, KIND_CLAUDE);
    close(total(&f.conn()), 0.0025);
    f.append(
        "p/subagents/agent-c.jsonl",
        &[&claude(
            "p",
            "same",
            "same",
            1000,
            100,
            true,
            "2026-09-15T00:00:01Z",
        )],
    );
    index(&f, KIND_CLAUDE);
    close(total(&f.conn()), 0.003);
    assert_eq!(f.count("turn"), 1);
    assert_eq!(scalar(&f.conn(), "SELECT output_tokens FROM turn"), 100);
    assert_eq!(f.count("usage_occurrence"), 3);
    f.index(KIND_CLAUDE, true);
    close(total(&f.conn()), 0.003);
    assert_eq!(f.count("turn"), 1);
}

#[test]
fn stage1_claude_root_copy_snapshot_does_not_move_the_cost_owner_on_retry() {
    let f = fixture();
    f.write(
        "p.jsonl",
        &[&claude(
            "p",
            "same",
            "same",
            1000,
            100,
            false,
            "2026-09-15T00:00:01Z",
        )],
    );
    f.write(
        "q.jsonl",
        &[&claude("q", "same", "same", 1000, 50, false, TS)],
    );
    index(&f, KIND_CLAUDE);
    close(total(&f.conn()), 0.003);
    assert_eq!(
        f.conn()
            .query_row("SELECT cost_owner_session_id FROM turn", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "p"
    );
    f.append(
        "q.jsonl",
        &[&claude(
            "q",
            "same",
            "same",
            1000,
            100,
            false,
            "2026-09-15T00:00:02Z",
        )],
    );
    index(&f, KIND_CLAUDE);
    close(total(&f.conn()), 0.003);
    assert_eq!(
        f.conn()
            .query_row("SELECT cost_owner_session_id FROM turn", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "p"
    );
    f.index(KIND_CLAUDE, true);
    close(total(&f.conn()), 0.003);
    assert_eq!(
        f.conn()
            .query_row("SELECT cost_owner_session_id FROM turn", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "p"
    );
}

#[test]
fn stage1_same_child_name_does_not_merge_unrelated_usage() {
    let f = fixture();
    f.write(
        "p/subagents/agent-same.jsonl",
        &[&claude("p", "ma", "ra", 1000, 100, true, TS)],
    );
    f.write(
        "q/subagents/agent-same.jsonl",
        &[&claude("q", "mb", "rb", 1000, 100, true, TS)],
    );
    index(&f, KIND_CLAUDE);
    close(total(&f.conn()), 0.006);
    assert_eq!(f.count("session"), 2);
}

#[test]
fn stage1_codex_parent_child_grandchild_cycle_preserves_own_costs() {
    let f = fixture();
    for (sid, parent, input, output) in [
        ("p", None, 1000, 100),
        ("c", Some("p"), 2000, 200),
        ("g", Some("c"), 500, 50),
    ] {
        f.write(
            &format!("{sid}.jsonl"),
            &[
                &meta(sid, parent, false),
                &context(Some(sid), Some("stage1-a")),
                &notification(input, output, input, output, 1),
            ],
        );
    }
    index(&f, KIND_CODEX);
    let c = f.conn();
    close(total(&c), 0.0105);
    assert_eq!(f.count("turn"), 3);
    close(
        c.query_row(
            "SELECT cost_usd FROM session WHERE session_id='p'",
            [],
            |r| r.get(0),
        )
        .unwrap(),
        0.003,
    );
    assert_eq!(scalar(&c, "SELECT SUM(output_tokens) FROM turn"), 350);
    c.execute("UPDATE session SET parent_kind='codex',parent_session_id='g',relationship_type='subagent' WHERE session_id='p'",[]).unwrap();
    assert_eq!(
        accounting::inclusive_sessions(&c, KIND_CODEX, "p")
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn stage1_codex_retimestamped_fork_prefix_is_an_occurrence() {
    let f = fixture();
    f.write(
        "p.jsonl",
        &[
            &meta("p", None, false),
            &context(Some("tp"), Some("stage1-a")),
            &notification(1000, 100, 1000, 100, 1),
        ],
    );
    f.write(
        "c.jsonl",
        &[
            &meta("c", Some("p"), true),
            &context(Some("tp"), Some("stage1-a")),
            &notification(1000, 100, 1000, 100, 8),
            &context(Some("tc"), Some("stage1-a")),
            &notification(3000, 300, 2000, 200, 9),
        ],
    );
    index(&f, KIND_CODEX);
    close(total(&f.conn()), 0.009);
    assert_eq!(f.count("turn"), 2);
    assert_eq!(
        scalar(
            &f.conn(),
            "SELECT COUNT(*) FROM usage_occurrence WHERE decision='replay'"
        ),
        1
    );
    assert_eq!(
        accounting::inclusive_sessions(&f.conn(), KIND_CODEX, "p")
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn stage1_codex_parent_like_usage_after_own_usage_and_rollback_is_billable() {
    let f = fixture();
    f.write(
        "p.jsonl",
        &[
            &meta("p", None, false),
            &context(Some("tp"), Some("stage1-a")),
            &notification(1000, 100, 1000, 100, 1),
        ],
    );
    f.write(
        "c.jsonl",
        &[
            &meta("c", Some("p"), true),
            &context(Some("tp"), Some("stage1-a")),
            &notification(1000, 100, 1000, 100, 2),
            &context(Some("tc"), Some("stage1-a")),
            &notification(3000, 300, 2000, 200, 3),
            &context(Some("tp"), Some("stage1-a")),
            &notification(1000, 100, 1000, 100, 4),
        ],
    );
    index(&f, KIND_CODEX);
    close(total(&f.conn()), 0.012);
    assert_eq!(f.count("turn"), 3);
    let conn = f.conn();
    let suffix: String = conn
        .query_row(
            "SELECT execution_key FROM usage_occurrence WHERE source_session_id='c'
        AND json_extract(evidence_json,'$.epoch')=1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let parent: String = conn
        .query_row(
            "SELECT execution_key FROM turn WHERE session_id='p'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    conn.execute(
        "DELETE FROM turn WHERE session_id='c' AND execution_key=?1",
        [&suffix],
    )
    .unwrap();
    conn.execute(
        "UPDATE usage_occurrence SET decision='replay',execution_key=?2 WHERE execution_key=?1",
        params![suffix, parent],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO usage_repair_group(kind,session_id,signature,version,complete)
        SELECT kind,session_id,'old-complete',?1,1 FROM session",
        [repair::VERSION],
    )
    .unwrap();
    close(total(&conn), 0.009);
    assert_eq!(
        accounting::codex_suffix_repair_sources(&conn)
            .unwrap()
            .len(),
        1
    );
    let fixed = run_repair(&f, false);
    assert!(fixed.errors.is_empty());
    assert_eq!(fixed.groups_repaired, 1);
    close(total(&f.conn()), 0.012);
    let before = snapshot(&f.conn());
    assert_eq!(run_repair(&f, false).groups_repaired, 0);
    assert_eq!(before, snapshot(&f.conn()));
}

#[test]
fn stage1_missing_codex_parent_does_not_discard_first_child_usage() {
    let f = fixture();
    f.write(
        "c.jsonl",
        &[
            &meta("c", Some("missing"), false),
            &context(Some("tc"), Some("stage1-a")),
            &notification(2000, 200, 2000, 200, 1),
        ],
    );
    index(&f, KIND_CODEX);
    close(total(&f.conn()), 0.006);
    assert_eq!(f.count("turn"), 1);
}

#[test]
fn stage1_duplicate_notification_survives_append_and_restart_without_rebilling() {
    let f = fixture();
    f.write(
        "p.jsonl",
        &[
            &meta("p", None, false),
            &context(Some("tp"), Some("stage1-a")),
            &notification(1000, 100, 1000, 100, 1),
        ],
    );
    index(&f, KIND_CODEX);
    f.append("p.jsonl", &[&notification(1000, 100, 1000, 100, 9)]);
    index(&f, KIND_CODEX);
    close(total(&f.conn()), 0.003);
    assert_eq!(f.count("turn"), 1);
    assert_eq!(f.count("usage_occurrence"), 2);
    let saved: String = f
        .conn()
        .query_row("SELECT state_json FROM usage_checkpoint", [], |r| r.get(0))
        .unwrap();
    let usage: accounting::CodexUsageState = serde_json::from_str(&saved).unwrap();
    assert_eq!(usage.event_index, 2);
    index(&f, KIND_CODEX);
    f.index(KIND_CODEX, true);
    close(total(&f.conn()), 0.003);
    assert_eq!(f.count("usage_occurrence"), 2);
}

#[test]
fn stage1_same_last_with_advancing_cumulative_is_new_usage() {
    let f = fixture();
    f.write(
        "p.jsonl",
        &[
            &meta("p", None, false),
            &context(Some("tp"), Some("stage1-a")),
            &notification(1000, 100, 1000, 100, 1),
        ],
    );
    index(&f, KIND_CODEX);
    f.append("p.jsonl", &[&notification(2000, 200, 1000, 100, 2)]);
    index(&f, KIND_CODEX);
    close(total(&f.conn()), 0.006);
    assert_eq!(f.count("turn"), 2);
}

#[test]
fn stage1_occurrence_line_offsets_include_empty_invalid_json_and_utf8_records() {
    let f = fixture();
    let p = claude("p", "mp", "rp", 1000, 100, false, TS);
    let path = f.write("p.jsonl", &["", "not-json", &p]);
    f.index(KIND_CLAUDE, false);
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    file.write_all(&[0xff, b'\n', b'\n']).unwrap();
    writeln!(
        file,
        "{}",
        claude("p", "mc", "rc", 2000, 200, false, "2026-09-15T00:00:01Z")
    )
    .unwrap();
    file.flush().unwrap();
    f.index(KIND_CLAUDE, false);
    let conn = f.conn();
    close(total(&conn), 0.009);
    assert_eq!(f.count("usage_occurrence"), 2);
    assert_eq!(
        scalar(&conn, "SELECT MIN(source_line) FROM usage_occurrence"),
        3
    );
    assert_eq!(
        scalar(&conn, "SELECT MAX(source_line) FROM usage_occurrence"),
        6
    );
    assert_eq!(scalar(&conn, "SELECT parsed_lines FROM source_file"), 6);
}

#[test]
fn stage1_cumulative_rollback_starts_new_epoch() {
    let f = fixture();
    f.write(
        "p.jsonl",
        &[
            &meta("p", None, false),
            &context(Some("tp"), Some("stage1-a")),
            &notification(1000, 100, 1000, 100, 1),
            &notification(2000, 200, 1000, 100, 2),
        ],
    );
    index(&f, KIND_CODEX);
    f.append("p.jsonl", &[&notification(1000, 100, 1000, 100, 3)]);
    index(&f, KIND_CODEX);
    close(total(&f.conn()), 0.009);
    assert_eq!(f.count("turn"), 3);
    assert_eq!(
        scalar(
            &f.conn(),
            "SELECT json_extract(state_json,'$.epoch') FROM usage_checkpoint"
        ),
        1
    );
}

#[test]
fn stage1_missing_cumulative_with_native_response_evidence_keeps_two_usages() {
    let f = fixture();
    let mut a: Value = serde_json::from_str(&notification(1000, 100, 1000, 100, 1)).unwrap();
    a["payload"]["info"]
        .as_object_mut()
        .unwrap()
        .remove("total_token_usage");
    let mut b = a.clone();
    a["payload"]["response_id"] = json!("a");
    b["payload"]["response_id"] = json!("b");
    f.write(
        "p.jsonl",
        &[
            &meta("p", None, false),
            &context(None, Some("stage1-a")),
            &a.to_string(),
            &b.to_string(),
        ],
    );
    index(&f, KIND_CODEX);
    close(total(&f.conn()), 0.006);
    assert_eq!(
        scalar(
            &f.conn(),
            "SELECT COUNT(*) FROM turn WHERE usage_state='canonical'"
        ),
        2
    );
}

#[test]
fn stage1_missing_cumulative_without_proof_keeps_unresolved_money_separate() {
    let f = fixture();
    let mut a: Value = serde_json::from_str(&notification(1000, 100, 1000, 100, 1)).unwrap();
    a["payload"]["info"]["total_token_usage"] = json!({"total_tokens":0});
    let mut b = a.clone();
    b["ordinal"] = json!(2);
    f.write(
        "p.jsonl",
        &[
            &meta("p", None, false),
            &context(Some("logical-turn-without-response-id"), Some("stage1-a")),
            &a.to_string(),
            &b.to_string(),
        ],
    );
    index(&f, KIND_CODEX);
    close(total(&f.conn()), 0.006);
    assert_eq!(
        scalar(
            &f.conn(),
            "SELECT COUNT(*) FROM turn WHERE usage_state='canonical'"
        ),
        0
    );
    assert_eq!(
        scalar(
            &f.conn(),
            "SELECT COUNT(*) FROM turn WHERE usage_state='unresolved'"
        ),
        2
    );
}

#[test]
fn stage1_equal_counter_sum_with_different_fields_is_not_a_replay() {
    let f = fixture();
    f.write(
        "p.jsonl",
        &[
            &meta("p", None, false),
            &context(Some("ta"), Some("stage1-a")),
            &notification(1000, 100, 1000, 100, 1),
            &context(Some("tb"), Some("stage1-a")),
            &notification(900, 200, 1000, 100, 2),
        ],
    );
    index(&f, KIND_CODEX);
    close(total(&f.conn()), 0.006);
    assert_eq!(f.count("turn"), 2);
}

#[test]
fn stage1_zero_cost_compaction_notification_only_adds_occurrence() {
    let f = fixture();
    f.write(
        "p.jsonl",
        &[
            &meta("p", None, false),
            &context(Some("tp"), Some("stage1-a")),
            &notification(1000, 100, 1000, 100, 1),
        ],
    );
    index(&f, KIND_CODEX);
    f.append("p.jsonl", &[&notification(1000, 100, 0, 0, 2)]);
    index(&f, KIND_CODEX);
    close(total(&f.conn()), 0.003);
    assert_eq!(f.count("turn"), 1);
    assert_eq!(f.count("usage_occurrence"), 2);
    assert_eq!(
        scalar(
            &f.conn(),
            "SELECT COUNT(*) FROM usage_occurrence WHERE decision='zero'"
        ),
        1
    );
}

#[test]
fn stage1_explicit_zero_total_reset_preserves_the_next_paid_epoch() {
    let f = fixture();
    f.write(
        "p.jsonl",
        &[
            &meta("p", None, false),
            &context(Some("tp"), Some("stage1-a")),
            &notification(1000, 100, 1000, 100, 1),
            &notification(0, 0, 0, 0, 2),
            &notification(1000, 100, 1000, 100, 3),
        ],
    );
    index(&f, KIND_CODEX);
    close(total(&f.conn()), 0.006);
    assert_eq!(f.count("turn"), 2);
    assert_eq!(
        scalar(
            &f.conn(),
            "SELECT json_extract(state_json,'$.epoch') FROM usage_checkpoint"
        ),
        1
    );
}

#[test]
fn stage1_copied_usage_in_a_lineage_cycle_retains_one_canonical_owner() {
    let f = fixture();
    for (sid, parent) in [("a", "c"), ("b", "a"), ("c", "b")] {
        f.write(
            &format!("{sid}.jsonl"),
            &[
                &meta(sid, Some(parent), true),
                &context(Some("shared"), Some("stage1-a")),
                &notification(1000, 100, 1000, 100, 1),
            ],
        );
    }
    index(&f, KIND_CODEX);
    close(total(&f.conn()), 0.003);
    assert_eq!(f.count("turn"), 1);
    index(&f, KIND_CODEX);
    close(total(&f.conn()), 0.003);
    assert_eq!(f.count("turn"), 1);
}

#[test]
fn stage1_null_model_changes_and_utf8_crlf_append_keep_original_attribution() {
    let f = fixture();
    f.write(
        "p.jsonl",
        &[
            &meta("p", None, false),
            &notification(1000, 100, 1000, 100, 1),
        ],
    );
    index(&f, KIND_CODEX);
    let suffix = format!(
        "{}\r\n{}\r\n",
        context(Some("tb"), Some("stage1-b")),
        notification(2000, 200, 1000, 100, 2)
    );
    let path = f.logs.join("p.jsonl");
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    let synthetic = format!("{{\"type\":\"padding\",\"value\":\"{}\"}}\r\n", "\u{3042}");
    let split = synthetic.find('\u{3042}').unwrap() + 1;
    file.write_all(&synthetic.as_bytes()[..split]).unwrap();
    file.flush().unwrap();
    index(&f, KIND_CODEX);
    assert_eq!(f.count("turn"), 1);
    file.write_all(&synthetic.as_bytes()[split..]).unwrap();
    file.write_all(suffix.as_bytes()).unwrap();
    file.flush().unwrap();
    index(&f, KIND_CODEX);
    assert_eq!(f.count("turn"), 2);
    assert_eq!(
        scalar(&f.conn(), "SELECT COUNT(*) FROM turn WHERE model IS NULL"),
        1
    );
    assert_eq!(
        scalar(
            &f.conn(),
            "SELECT COUNT(*) FROM turn WHERE model='stage1-b' AND effort='high'"
        ),
        1
    );
    f.index(KIND_CODEX, true);
    assert_eq!(f.count("turn"), 2);
    assert_eq!(
        scalar(&f.conn(), "SELECT COUNT(*) FROM turn WHERE model IS NULL"),
        1
    );
}

fn seed_legacy(f: &Fixture) -> (String, String) {
    let p = claude("p", "mp", "rp", 1000, 100, false, TS);
    let c = claude("p", "mc", "rc", 2000, 200, true, TS);
    let conn = f.conn();
    conn.execute("INSERT INTO session(kind,session_id,is_sidechain,origin) VALUES ('claude','p',1,'unknown')",[]).unwrap();
    let ts = parse_ts(Some(TS)).unwrap();
    for (seq, request, input, output, cost) in
        [(0, "rp", 1000, 100, 0.003), (1, "rc", 2000, 200, 0.006)]
    {
        conn.execute("INSERT INTO turn(kind,session_id,seq,request_id,ts,model,input_tokens,output_tokens,cost_usd)
            VALUES ('claude','p',?1,?2,?3,'stage1-a',?4,?5,?6)",params![seq,request,ts,input,output,cost]).unwrap();
    }
    for (name, text) in [("p.jsonl", &p), ("p/subagents/agent-c.jsonl", &c)] {
        conn.execute("INSERT INTO source_file(path,kind,size_bytes,mtime_ns,parsed_bytes,parsed_lines,session_id,last_indexed)
            VALUES (?1,'claude',?2,0,?2,1,'p',0)",params![f.logs.join(name).to_string_lossy(),text.len() as i64+1]).unwrap();
    }
    conn.execute(
        "INSERT INTO summary(kind,session_id,created_at) VALUES ('claude','p',1)",
        [],
    )
    .unwrap();
    (p, c)
}
fn repair_options(f: &Fixture, fallback: bool) -> repair::RepairOptions {
    repair::RepairOptions {
        claude_root: Some(f.logs.clone()),
        codex_root: Some(f.logs.clone()),
        claude_codex_root: None,
        fallback_root: fallback.then(|| f.archive.join(KIND_CLAUDE)),
        archive_root: None,
    }
}
fn run_repair(f: &Fixture, fallback: bool) -> repair::RepairReport {
    repair::run(
        &mut f.conn(),
        &repair_options(f, fallback),
        &AtomicBool::new(false),
    )
    .unwrap()
}
#[test]
fn stage1_codex_missing_original_repairs_from_explicit_archive_root() {
    let f = fixture();
    let lines = [meta("p", None, false), context(Some("t"), Some("stage1-a")),
        notification(1000, 100, 1000, 100, 1)];
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    let archived = f.write_gzip(KIND_CODEX, "p.jsonl.gz", &refs);
    let archive_bytes = std::fs::read(&archived).unwrap();
    let bytes = lines.join("\n").len() + 1;
    let original = f.logs.join("p.jsonl");
    let mut conn = f.conn();
    conn.execute("INSERT INTO session(kind,session_id,cost_usd,turn_count)
        VALUES ('codex','p',0.003,1)", []).unwrap();
    // Seed the exact pre-v3 native key written by the old indexer, so the
    // archived usage is evidence for replacing this historical row.
    let ts=parse_ts(Some("2026-09-15T00:00:01Z")).unwrap();
    let request=format!("tc:1:{ts}:1100");
    conn.execute("INSERT INTO turn(kind,session_id,seq,request_id,ts,model,input_tokens,output_tokens,cost_usd)
        VALUES ('codex','p',0,?1,?2,'stage1-a',1000,100,0.003)", params![request,ts]).unwrap();
    conn.execute("INSERT INTO source_file(path,kind,size_bytes,mtime_ns,parsed_bytes,parsed_lines,session_id,last_indexed)
        VALUES (?1,'codex',?2,0,?2,3,'p',0)",
        params![original.to_string_lossy().as_ref(),bytes as i64]).unwrap();
    let mut options = repair_options(&f, false);
    options.archive_root = Some(f.archive.clone());
    let report = repair::run(&mut conn, &options, &AtomicBool::new(false)).unwrap();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.files_read, 1);
    close(total(&conn), 0.003);
    assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM turn WHERE usage_state='canonical'"), 1);
    assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM turn WHERE usage_state='legacy'"), 0);
    let first = snapshot(&conn);
    repair::run(&mut conn, &options, &AtomicBool::new(false)).unwrap();
    assert_eq!(first, snapshot(&conn));
    assert_eq!(archive_bytes, std::fs::read(archived).unwrap());
    assert!(!original.exists());
}
fn snapshot(conn: &Connection) -> Value {
    let mut stmt=conn.prepare("SELECT kind,session_id,seq,execution_key,usage_state,cost_usd FROM turn ORDER BY kind,session_id,seq").unwrap();
    let turns = stmt
        .query_map([], |r| {
            Ok(json!([
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, f64>(5)?
            ]))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect::<Vec<_>>();
    let mut stmt=conn.prepare("SELECT session_id,parent_session_id,relationship_type,is_sidechain FROM session ORDER BY session_id").unwrap();
    let sessions = stmt
        .query_map([], |r| {
            Ok(json!([
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, bool>(3)?
            ]))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect::<Vec<_>>();
    json!({"turns":turns,"sessions":sessions,"occurrences":scalar(conn,"SELECT COUNT(*) FROM usage_occurrence"),"aliases":scalar(conn,"SELECT COUNT(*) FROM session_identity_alias")})
}

#[test]
fn stage1_fallback_root_repairs_legacy_without_changing_total_and_is_idempotent() {
    let f = fixture();
    let (p, c) = seed_legacy(&f);
    let no_root = run_repair(&f, false);
    assert_eq!(no_root.sessions_still_legacy, 1);
    close(total(&f.conn()), 0.009);
    f.write_gzip(KIND_CLAUDE, "p.jsonl.gz", &[&p]);
    f.write_gzip(KIND_CLAUDE, "p/subagents/agent-c.jsonl.gz", &[&c]);
    let result = run_repair(&f, true);
    assert!(result.errors.is_empty(), "{:?}", result.errors);
    assert_eq!(result.sessions_resplit, 1);
    close(total(&f.conn()), 0.009);
    assert_eq!(f.count("session"), 2);
    assert_eq!(f.count("summary"), 1);
    let before = snapshot(&f.conn());
    let second = run_repair(&f, true);
    assert_eq!(second.groups_repaired, 0);
    assert_eq!(before, snapshot(&f.conn()));
}

#[test]
fn stage1_fallback_gzip_keeps_raw_cursor_when_the_original_returns_and_grows() {
    let f = fixture();
    let (p, c) = seed_legacy(&f);
    f.write_gzip(KIND_CLAUDE, "p.jsonl.gz", &[&p]);
    f.write_gzip(KIND_CLAUDE, "p/subagents/agent-c.jsonl.gz", &[&c]);
    assert!(run_repair(&f, true).errors.is_empty());
    let parsed: i64 = f
        .conn()
        .query_row(
            "SELECT parsed_bytes FROM source_file WHERE path=?1",
            [f.logs.join("p.jsonl").to_string_lossy()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(parsed, p.len() as i64 + 1);
    f.write("p.jsonl", &[&p]);
    f.write("p/subagents/agent-c.jsonl", &[&c]);
    index(&f, KIND_CLAUDE);
    close(total(&f.conn()), 0.009);
    assert_eq!(f.count("turn"), 2);
    f.append(
        "p.jsonl",
        &[&claude(
            "p",
            "mp2",
            "rp2",
            1000,
            100,
            false,
            "2026-09-15T00:00:01Z",
        )],
    );
    index(&f, KIND_CLAUDE);
    close(total(&f.conn()), 0.012);
    assert_eq!(f.count("turn"), 3);
}

#[test]
fn stage1_late_child_file_preserves_unmatched_legacy_until_it_arrives() {
    let f = fixture();
    let (p, c) = seed_legacy(&f);
    f.write_gzip(KIND_CLAUDE, "p.jsonl.gz", &[&p]);
    assert!(run_repair(&f, true).errors.is_empty());
    close(total(&f.conn()), 0.009);
    assert_eq!(
        scalar(
            &f.conn(),
            "SELECT COUNT(*) FROM turn WHERE usage_state='legacy'"
        ),
        1
    );
    let partial = snapshot(&f.conn());
    assert_eq!(run_repair(&f, true).groups_repaired, 0);
    assert_eq!(partial, snapshot(&f.conn()));
    f.write_gzip(KIND_CLAUDE, "p/subagents/agent-c.jsonl.gz", &[&c]);
    assert!(run_repair(&f, true).errors.is_empty());
    close(total(&f.conn()), 0.009);
    assert_eq!(
        scalar(
            &f.conn(),
            "SELECT COUNT(*) FROM turn WHERE usage_state='legacy'"
        ),
        0
    );
}

#[test]
fn stage1_cancelled_or_invalid_repair_preserves_rows_and_can_resume() {
    let f = fixture();
    let (p, c) = seed_legacy(&f);
    f.write("p.jsonl", &[&p]);
    f.write("p/subagents/agent-c.jsonl", &["{"]);
    let before = snapshot(&f.conn());
    let result = run_repair(&f, false);
    assert!(!result.errors.is_empty());
    assert_eq!(before, snapshot(&f.conn()));
    let cancelled = repair::run(
        &mut f.conn(),
        &repair_options(&f, false),
        &AtomicBool::new(true),
    )
    .unwrap();
    assert!(cancelled.cancelled);
    assert_eq!(before, snapshot(&f.conn()));
    f.write("p/subagents/agent-c.jsonl", &[&c]);
    assert!(run_repair(&f, false).errors.is_empty());
    close(total(&f.conn()), 0.009);
}

#[test]
fn stage1_metadata_only_source_cannot_erase_historical_paid_usage() {
    let f = fixture();
    let path = f.write(
        "p.jsonl",
        &[
            &meta("p", None, false),
            &context(Some("tp"), Some("stage1-a")),
        ],
    );
    let conn = f.conn();
    conn.execute(
        "INSERT INTO session(kind,session_id) VALUES ('codex','p')",
        [],
    )
    .unwrap();
    conn.execute("INSERT INTO turn(kind,session_id,seq,request_id,ts,model,input_tokens,output_tokens,cost_usd)
        VALUES ('codex','p',0,'historical',1,'stage1-a',1000,100,0.003)",[]).unwrap();
    conn.execute("INSERT INTO source_file(path,kind,size_bytes,mtime_ns,parsed_bytes,parsed_lines,session_id,last_indexed)
        VALUES (?1,'codex',?2,0,?2,2,'p',0)",params![path.to_string_lossy(),std::fs::metadata(&path).unwrap().len() as i64]).unwrap();
    let before = snapshot(&conn);
    let result = run_repair(&f, false);
    assert_eq!(result.groups_repaired, 0);
    assert!(!result.errors.is_empty());
    close(total(&f.conn()), 0.003);
    assert_eq!(before, snapshot(&f.conn()));
}

#[test]
fn stage1_partial_claude_message_id_fallback_replaces_the_proven_legacy_row() {
    let f = fixture();
    let (p, _) = seed_legacy(&f);
    let mut p: Value = serde_json::from_str(&p).unwrap();
    p.as_object_mut().unwrap().remove("requestId");
    f.conn()
        .execute("UPDATE turn SET request_id='mp' WHERE request_id='rp'", [])
        .unwrap();
    let p = p.to_string();
    f.conn()
        .execute(
            "UPDATE source_file SET parsed_bytes=?2,size_bytes=?2 WHERE path=?1",
            params![f.logs.join("p.jsonl").to_string_lossy(), p.len() as i64 + 1],
        )
        .unwrap();
    f.write_gzip(KIND_CLAUDE, "p.jsonl.gz", &[&p]);
    assert!(run_repair(&f, true).errors.is_empty());
    close(total(&f.conn()), 0.009);
    assert_eq!(f.count("turn"), 2);
    assert_eq!(
        scalar(
            &f.conn(),
            "SELECT COUNT(*) FROM turn WHERE usage_state='legacy'"
        ),
        1
    );
}

#[test]
fn stage1_jst_boundaries_model_filter_and_raw_daily_totals_match() {
    let f = fixture();
    f.write(
        "p.jsonl",
        &[&claude(
            "p",
            "mp",
            "rp",
            1000,
            100,
            false,
            "2026-09-14T14:59:59Z",
        )],
    );
    f.write(
        "p/subagents/agent-c.jsonl",
        &[&claude(
            "p",
            "mc",
            "rc",
            2000,
            200,
            true,
            "2026-09-14T15:00:00Z",
        )],
    );
    index(&f, KIND_CLAUDE);
    let conn = f.conn();
    let daily: f64 = conn
        .query_row(
            "SELECT SUM(cost_usd) FROM rollup_turn_session_day_v2",
            [],
            |r| r.get(0),
        )
        .unwrap();
    close(daily, total(&conn));
    assert_eq!(
        scalar(
            &conn,
            "SELECT COUNT(DISTINCT day) FROM rollup_turn_session_day_v2"
        ),
        2
    );
    let range = Range {
        from: parse_ts(Some("2026-09-14T00:00:00Z")),
        to: parse_ts(Some("2026-09-16T00:00:00Z")),
        ..Default::default()
    };
    let filters = Filters {
        include_sidechain: true,
        models: vec!["stage1-a".into()],
        ..Default::default()
    };
    let rolled = query::overview(&conn, &range, &filters, 1_800_000_000_000).unwrap();
    conn.execute("DELETE FROM index_state WHERE key='rollup_version'", [])
        .unwrap();
    let raw = query::overview(&conn, &range, &filters, 1_800_000_000_000).unwrap();
    close(rolled.totals.cost_usd, raw.totals.cost_usd);
    close(raw.totals.cost_usd, 0.009);
}

fn realdata_fingerprint(conn: &Connection) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    for (table_index,sql) in [
        "SELECT kind,session_id,seq,request_id,execution_key,cost_owner_session_id,usage_state,ts,model,effort,input_tokens,output_tokens,cache_read_tokens,cache_write_5m_tokens,cache_write_1h_tokens,reasoning_tokens,cost_usd FROM turn ORDER BY kind,session_id,seq",
        "SELECT kind,session_id,parent_kind,parent_session_id,relationship_type,lineage_state,is_sidechain,cost_usd FROM session ORDER BY kind,session_id",
        "SELECT * FROM session_identity_alias ORDER BY kind,legacy_session_id,execution_session_id,source_path",
        "SELECT * FROM usage_occurrence ORDER BY kind,source_path,source_generation,source_line",
    ].into_iter().enumerate() {
        let mut stmt=conn.prepare(sql).unwrap();let columns=stmt.column_count();
        let mut rows=stmt.query([]).unwrap();
        let mut count=0usize;
        while let Some(row)=rows.next().unwrap() {
            count+=1;
            for column in 0..columns {
                let value=row.get_ref(column).unwrap();
                match value {
                    rusqlite::types::ValueRef::Null=>hash.update([0]),
                    rusqlite::types::ValueRef::Integer(v)=>{hash.update([1]);hash.update(v.to_le_bytes())},
                    rusqlite::types::ValueRef::Real(v)=>{hash.update([2]);hash.update(v.to_le_bytes())},
                    rusqlite::types::ValueRef::Text(v)=>{hash.update([3]);hash.update((v.len() as u64).to_le_bytes());hash.update(v)},
                    rusqlite::types::ValueRef::Blob(v)=>{hash.update([4]);hash.update((v.len() as u64).to_le_bytes());hash.update(v)},
                }
            }
            if count%250_000==0 {eprintln!("usage fingerprint: table {table_index}, {count} rows");}
        }
        eprintln!("usage fingerprint: table {table_index} complete, {count} rows");
    }
    format!("{:x}", hash.finalize())
}

#[test]
#[ignore = "explicit offline DB-copy acceptance; never opens a live profile"]
fn stage1_realdata_repair() {
    assert_eq!(std::env::var("AILOG_R1_REALDATA").as_deref(), Ok("1"));
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let scratch = root.join(".mycmux/ailog-r1");
    let path = scratch.join("db/ailog_stage1.db");
    assert!(path.is_file(), "prepare the independent DB copy first");
    let mut conn = crate::ailog::open_db(&path).unwrap();
    let invocation_before = total(&conn);
    let baseline: Value = serde_json::from_slice(
        &std::fs::read(scratch.join("evidence/realdata_baseline.json")).unwrap(),
    )
    .unwrap();
    let before: f64 = baseline["turn_counts_costs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row[2].as_f64().unwrap())
        .sum();
    let options = repair::RepairOptions {
        // Unit tests deliberately redirect dirs::home_dir(). This explicit,
        // ignored DB-copy check must resolve the source paths in the spec.
        claude_root: Some(std::path::PathBuf::from(
            "C:/Users/miyaz/.claude/projects",
        )),
        codex_root: Some(std::path::PathBuf::from(
            "C:/Users/miyaz/.codex/sessions",
        )),
        claude_codex_root: Some(std::path::PathBuf::from(
            "C:/Users/miyaz/.claude-codex/config/projects",
        )),
        fallback_root: Some(std::path::PathBuf::from(
            "D:/ailog-rawlog-restore/claude-projects",
        )),
        archive_root: Some(std::path::PathBuf::from(
            "C:/Users/miyaz/.mycmux/ailog-archive",
        )),
    };
    let first = repair::run(&mut conn, &options, &AtomicBool::new(false)).unwrap();
    let after = total(&conn);
    let fingerprint = realdata_fingerprint(&conn);
    let second = repair::run(&mut conn, &options, &AtomicBool::new(false)).unwrap();
    let second_fingerprint = realdata_fingerprint(&conn);
    let from = parse_ts(Some("2026-09-13T15:00:00Z")).unwrap();
    let to = parse_ts(Some("2026-10-13T15:00:00Z")).unwrap();
    let sum = |condition: &str| {
        conn.query_row(&format!("SELECT COALESCE(SUM(t.cost_usd),0) FROM turn t
        JOIN session s ON s.kind=t.kind AND s.session_id=t.session_id
        WHERE t.ts>=?1 AND t.ts<?2 AND COALESCE(s.origin,'unknown')!='ailog-internal' AND ({condition})"),
        params![from,to],|r|r.get::<_,f64>(0)).unwrap()
    };
    let w4 = sum("t.usage_state IN ('canonical','legacy')");
    let accounting = query::accounting_totals(
        &conn,
        &Range {
            from: Some(from),
            to: Some(to - 1),
            ..Default::default()
        },
        &Filters::default(),
        to,
    )
    .unwrap();
    close(w4, accounting.cost_usd);
    let result = json!({
        "w4_default_total_usd":w4,"w4_legacy_usd":sum("t.usage_state='legacy'"),
        "w4_claude_child_usd":sum("t.kind='claude' AND t.usage_state='canonical' AND s.is_sidechain=1"),
        "w4_claude_parent_usd":sum("t.kind='claude' AND t.usage_state='canonical' AND s.is_sidechain=0"),
        "w4_codex_child_usd":sum("t.kind='codex' AND t.usage_state='canonical' AND s.is_sidechain=1"),
        "w4_unresolved_usd":sum("t.usage_state='unresolved'"),
        "all_time_total_before_usd":before,"all_time_total_after_usd":after,
        "second_run_identical":fingerprint==second_fingerprint,
        "original_claude_root":options.claude_root,"original_codex_root":options.codex_root,
        "original_claude_codex_root":options.claude_codex_root,"archive_root":options.archive_root,
        "fallback_root":options.fallback_root,"restore_done_present":std::path::Path::new("D:/ailog-rawlog-restore/RESTORE_DONE.json").is_file(),
        "sessions_resplit":scalar(&conn,"SELECT COUNT(*) FROM (SELECT kind,legacy_session_id FROM session_identity_alias
            WHERE kind IN ('claude','claude-codex') GROUP BY kind,legacy_session_id HAVING COUNT(DISTINCT execution_session_id)>1)"),
        "sessions_still_legacy":first.sessions_still_legacy,"repair_invocation_before_usd":invocation_before,
        "first_run":first,"second_run":second,
        "first_fingerprint":fingerprint,"second_fingerprint":second_fingerprint,
        "db_path":path,"turn_count":scalar(&conn,"SELECT COUNT(*) FROM turn"),
        "session_count":scalar(&conn,"SELECT COUNT(*) FROM session"),
        "occurrence_count":scalar(&conn,"SELECT COUNT(*) FROM usage_occurrence"),
        "financial_cause_analysis_pending":true,
    });
    let output = scratch.join("evidence/realdata_check.json");
    if output.is_file() {
        std::fs::copy(
            &output,
            scratch.join("evidence").join(format!(
                "realdata_check_{}.json",
                chrono::Utc::now().format("%Y%m%dT%H%M%S%.6f")
            )),
        )
        .unwrap();
    }
    std::fs::write(
        &output,
        serde_json::to_string_pretty(&result).unwrap() + "\n",
    )
    .unwrap();
    eprintln!("realdata result: {}", output.display());
    assert!(result["second_run_identical"].as_bool().unwrap());
    assert!(
        before - after <= baseline["maximum_expected_removed_cost_usd"].as_f64().expect("record the accepted cost-removal ceiling"),
        "unexpected total loss: {}",
        before - after
    );
}

#[test]
fn stage1_claude_copy_enriches_missing_model_in_both_owner_orders() {
    for case in 0..3 {
        let f = fixture();
        let (first_sid, second_sid, first_output, second_output) = match case {
            1 => ("q", "p", 100, 150),
            2 => ("p", "q", 100, 50),
            _ => ("p", "q", 50, 100),
        };
        let mut first: Value = serde_json::from_str(&claude(
            first_sid, "copied-model", "copied-request", 1000, first_output, false, TS,
        )).unwrap();
        if case != 1 {
            first["message"].as_object_mut().unwrap().remove("model");
        }
        f.write(&format!("{first_sid}.jsonl"), &[&first.to_string()]);
        index(&f, KIND_CLAUDE);
        close(total(&f.conn()), if case == 1 { 0.003 } else { 0.0 });
        let mut second: Value = serde_json::from_str(&claude(
            second_sid, "copied-model", "copied-request", 1000, second_output, false,
            "2026-09-15T00:00:01Z",
        )).unwrap();
        if case == 1 {
            second["message"].as_object_mut().unwrap().remove("model");
        }
        f.write(&format!("{second_sid}.jsonl"), &[&second.to_string()]);
        index(&f, KIND_CLAUDE);
        let expected = 0.002 + first_output.max(second_output) as f64 * 0.00001;
        close(total(&f.conn()), expected);
        assert_eq!(f.count("turn"), 1);
        let (owner, model): (String, String) = f.conn().query_row(
            "SELECT cost_owner_session_id,model FROM turn", [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        assert_eq!(owner, "p");
        assert_eq!(model, "stage1-a");
        f.index(KIND_CLAUDE, true);
        close(total(&f.conn()), expected);
        assert_eq!(f.count("turn"), 1);
    }
}

#[test]
fn stage1_claude_message_without_request_replays_and_repairs_once() {
    let f = fixture();
    let missing = |sid: &str, output: i64, ts: &str| {
        let mut value: Value = serde_json::from_str(&claude(sid,"missing-request","unused",1000,output,false,ts)).unwrap();
        value.as_object_mut().unwrap().remove("requestId");
        value.to_string()
    };
    f.write("p.jsonl", &[&missing("p",50,TS)]);
    index(&f,KIND_CLAUDE);
    close(total(&f.conn()),0.0025);
    let final_snapshot=missing("p",100,"2026-09-15T00:00:01Z");
    f.append("p.jsonl", &[&final_snapshot]);
    f.write("q.jsonl", &[&missing("q",100,"2026-09-15T00:00:01Z")]);
    index(&f,KIND_CLAUDE);
    close(total(&f.conn()),0.003);
    assert_eq!(f.count("turn"),1);
    assert_eq!(f.count("usage_occurrence"),3);
    run_repair(&f,false);
    // A previously installed source-scoped key must bypass the completed-family
    // fast path and be replaced without leaving the earlier paid row behind.
    let conn=f.conn();
    conn.execute("UPDATE turn SET execution_key='claude-uuid:prototype',request_id='claude-uuid:prototype'",[]).unwrap();
    conn.execute("UPDATE usage_occurrence SET execution_key='claude-uuid:prototype'",[]).unwrap();
    assert_eq!(accounting::claude_message_key_repair_sources(&conn).unwrap().len(),2);
    drop(conn);
    run_repair(&f,false);
    close(total(&f.conn()),0.003);
    assert_eq!(f.count("turn"),1);
    assert!(accounting::claude_message_key_repair_sources(&f.conn()).unwrap().is_empty());
    let first=snapshot(&f.conn());
    run_repair(&f,false);
    assert_eq!(first,snapshot(&f.conn()));
}

#[test]
fn stage1_codex_overlapping_old_and_physical_ids_repair_as_one_family() {
    let f=fixture();
    let a="01a00000-0000-7000-8000-000000000001";
    let b="01a00000-0000-7000-8000-000000000002";
    let mut conn=f.conn();
    for (physical,old,input,output,cost,turn) in [(a,b,1000,100,0.003,"ta"),(b,a,2000,200,0.006,"tb")] {
        let name=format!("rollout-2026-09-15T00-00-00-{physical}.jsonl");
        let lines=[meta(old,None,false),context(Some(turn),Some("stage1-a")),notification(input,output,input,output,1)];
        let refs:Vec<&str>=lines.iter().map(String::as_str).collect();
        f.write(&name,&refs);
        let bytes=lines.join("\n").len()+1;
        conn.execute("INSERT INTO session(kind,session_id,is_sidechain) VALUES ('codex',?1,0)",[old]).unwrap();
        let ts=parse_ts(Some("2026-09-15T00:00:01Z")).unwrap();
        let request=format!("tc:1:{ts}:{}",input+output);
        conn.execute("INSERT INTO turn(kind,session_id,seq,request_id,ts,model,input_tokens,output_tokens,cost_usd)
            VALUES ('codex',?1,0,?2,?3,'stage1-a',?4,?5,?6)",params![old,request,ts,input,output,cost]).unwrap();
        conn.execute("INSERT INTO source_file(path,kind,size_bytes,mtime_ns,parsed_bytes,parsed_lines,session_id,last_indexed)
            VALUES (?1,'codex',?2,0,?2,3,?3,0)",params![f.logs.join(name).to_string_lossy(),bytes as i64,old]).unwrap();
    }
    let first=repair::run(&mut conn,&repair_options(&f,false),&AtomicBool::new(false)).unwrap();
    assert!(first.errors.is_empty(),"{:?}",first.errors);
    assert_eq!(first.groups_repaired,1);
    close(total(&conn),0.009);
    assert_eq!(scalar(&conn,"SELECT COUNT(*) FROM turn"),2);
    assert!(accounting::codex_orphan_repair_sources(&conn).unwrap().is_empty());
    // Reproduce the old late-family deletion, then recover just this component
    // even though its compound repair marker says it was already complete.
    conn.execute("DROP INDEX ix_turn_execution_v3",[]).unwrap();
    conn.execute("DELETE FROM turn WHERE kind='codex' AND session_id=?1",[b]).unwrap();
    assert_eq!(accounting::codex_orphan_repair_sources(&conn).unwrap().len(),1);
    repair::run(&mut conn,&repair_options(&f,false),&AtomicBool::new(false)).unwrap();
    close(total(&conn),0.009);
    assert!(accounting::codex_orphan_repair_sources(&conn).unwrap().is_empty());
    let recovered=snapshot(&conn);
    let repeat=repair::run(&mut conn,&repair_options(&f,false),&AtomicBool::new(false)).unwrap();
    assert_eq!(repeat.groups_repaired,0);
    assert_eq!(recovered,snapshot(&conn));
}

#[test]
fn stage1_claude_uuid_root_owns_copied_native_session_rows() {
    let f=fixture();
    let physical="01a00000-0000-7000-8000-000000000011";
    let copied="01a00000-0000-7000-8000-000000000012";
    f.write(&format!("{physical}.jsonl"),&[&claude(copied,"p","rp",1000,100,false,TS)]);
    f.write(&format!("{physical}/subagents/agent-c.jsonl"),&[&claude(copied,"c","rc",2000,200,true,TS)]);
    index(&f,KIND_CLAUDE);
    close(total(&f.conn()),0.009);
    assert_eq!(f.count("session"),2);
    let conn=f.conn();
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM session WHERE kind='claude' AND session_id=?1 AND is_sidechain=0",
        [physical],|r|r.get::<_,i64>(0)).unwrap(),1);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM session WHERE kind='claude' AND parent_session_id=?1 AND is_sidechain=1",
        [physical],|r|r.get::<_,i64>(0)).unwrap(),1);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM session WHERE session_id=?1",[copied],|r|r.get::<_,i64>(0)).unwrap(),0);
}

#[test]
fn stage1_native_session_proof_replaces_only_matching_foreign_legacy() {
    for kind in [KIND_CLAUDE,KIND_CODEX] {
        let f=fixture();
        // The proven native alias sorts before the original source alias.
        // Re-grouping on the second run must retain the unavailable request.
        let a="01a00000-0000-7000-8000-000000000022";
        let b="01a00000-0000-7000-8000-000000000021";
        let (name,lines,request)=if kind==KIND_CLAUDE {
            (format!("{a}.jsonl"),vec![claude(b,"known","known-request",1000,100,false,TS)],"known-request".to_string())
        } else {
            let ts=parse_ts(Some("2026-09-15T00:00:01Z")).unwrap();
            (format!("rollout-2026-09-15T00-00-00-{b}.jsonl"),
                vec![meta(a,None,false),context(Some("t"),Some("stage1-a")),notification(1000,100,1000,100,1)],format!("tc:1:{ts}:1100"))
        };
        let refs:Vec<&str>=lines.iter().map(String::as_str).collect();
        f.write(&name,&refs);
        let mut conn=f.conn();
        for sid in [a,b] {conn.execute("INSERT INTO session(kind,session_id) VALUES (?1,?2)",params![kind,sid]).unwrap();}
        for (seq,req,input,output,cost) in [(0,request.as_str(),1000,100,0.003),(1,"unavailable-other-request",2000,200,0.006)] {
            conn.execute("INSERT INTO turn(kind,session_id,seq,request_id,ts,model,input_tokens,output_tokens,cost_usd)
                VALUES (?1,?2,?3,?4,?5,'stage1-a',?6,?7,?8)",params![kind,b,seq,req,parse_ts(Some(TS)).unwrap(),input,output,cost]).unwrap();
        }
        let bytes=lines.join("\n").len()+1;
        conn.execute("INSERT INTO source_file(path,kind,size_bytes,mtime_ns,parsed_bytes,parsed_lines,session_id,last_indexed)
            VALUES (?1,?2,?3,0,?3,?4,?5,0)",params![f.logs.join(name).to_string_lossy(),kind,bytes as i64,lines.len() as i64,a]).unwrap();
        let report=repair::run(&mut conn,&repair_options(&f,false),&AtomicBool::new(false)).unwrap();
        assert!(report.errors.is_empty(),"{:?}",report.errors);
        close(total(&conn),0.009);
        assert_eq!(scalar(&conn,"SELECT COUNT(*) FROM turn WHERE usage_state='canonical'"),1);
        assert_eq!(scalar(&conn,"SELECT COUNT(*) FROM turn WHERE usage_state='legacy'"),1);
        assert_eq!(conn.query_row("SELECT request_id FROM turn WHERE usage_state='legacy'",[],|r|r.get::<_,String>(0)).unwrap(),"unavailable-other-request");
        let once=snapshot(&conn);
        repair::run(&mut conn,&repair_options(&f,false),&AtomicBool::new(false)).unwrap();
        assert_eq!(once,snapshot(&conn));
    }
}

#[test]
fn stage1_invalid_family_reconciles_only_exact_already_canonical_legacy_copy() {
    let f=fixture();
    let first=claude("p","mp","rp",1000,100,false,TS);
    let later=claude("p","mp","rp",1000,100,false,"2026-09-15T00:00:01Z");
    f.write("p.jsonl",&[&first,&later]);index(&f,KIND_CLAUDE);
    let bad=f.write("p/subagents/agent-bad.jsonl",&["{"]);
    let conn=f.conn();let ts=parse_ts(Some(TS)).unwrap();
    // Reproduce the earlier v3 hash key: the compatible native key now
    // prevents an old writer from creating this mixed shape in the first place.
    conn.execute("UPDATE turn SET request_id=execution_key WHERE usage_state='canonical'",[]).unwrap();
    conn.execute("INSERT INTO source_file(path,kind,size_bytes,mtime_ns,parsed_bytes,parsed_lines,session_id,last_indexed)
        VALUES (?1,'claude',2,0,2,1,'p',0)",[bad.to_string_lossy().as_ref()]).unwrap();
    for (seq,request,input,output,cost) in [(50,"rp",1000,100,0.003),(51,"mp",2000,200,0.006)] {
        conn.execute("INSERT INTO turn(kind,session_id,seq,request_id,ts,model,input_tokens,output_tokens,cost_usd,usage_state)
            VALUES ('claude','p',?1,?2,?3,'stage1-a',?4,?5,?6,'legacy')",params![seq,request,ts,input,output,cost]).unwrap();
    }
    close(total(&conn),0.012);drop(conn);
    assert!(!run_repair(&f,false).errors.is_empty());
    close(total(&f.conn()),0.009);
    assert_eq!(scalar(&f.conn(),"SELECT COUNT(*) FROM turn WHERE usage_state='canonical'"),1);
    assert_eq!(scalar(&f.conn(),"SELECT COUNT(*) FROM turn WHERE usage_state='legacy' AND request_id='rp'"),0);
    assert_eq!(scalar(&f.conn(),"SELECT COUNT(*) FROM turn WHERE usage_state='legacy' AND request_id='mp'"),1);
    let after=snapshot(&f.conn());
    assert!(!run_repair(&f,false).errors.is_empty());
    assert_eq!(after,snapshot(&f.conn()));
    assert_eq!(std::fs::read_to_string(bad).unwrap(),"{\n");
}

#[path = "stage1_r2_tests.rs"]
mod r2;
