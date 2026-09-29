//! Database-level tests: incremental behaviour, derived columns and the
//! aggregation APIs.

use super::fixtures::*;
use crate::ailog::{query, Filters, Range, KIND_CLAUDE, KIND_CODEX, KIND_GROK};
use rusqlite::params;

const NOW: i64 = 1_800_000_000_000;

fn all_time() -> Range {
    Range::default()
}

// ---------------------------------------------------------------------------
// Incremental behaviour
// ---------------------------------------------------------------------------

#[test]
fn indexing_the_same_file_twice_does_not_duplicate_rows() {
    let fixture = Fixture::new();
    fixture.write("S1.jsonl", CLAUDE_SPLIT_REQUEST);

    let first = fixture.index(KIND_CLAUDE, false);
    assert_eq!(first.files_done, 1);
    let turns = fixture.count("turn");
    let tools = fixture.count("tool_event");
    let sessions = fixture.count("session");
    assert_eq!(turns, 1);

    // Nothing changed on disk, so the second pass must skip the file entirely.
    let second = fixture.index(KIND_CLAUDE, false);
    assert_eq!(second.files_skipped, 1);
    assert_eq!(second.files_done, 0);
    assert_eq!(fixture.count("turn"), turns);
    assert_eq!(fixture.count("tool_event"), tools);
    assert_eq!(fixture.count("session"), sessions);
}

#[test]
fn gzip_archive_has_plain_fixture_parity() {
    let plain = Fixture::new();
    plain.write("S1.jsonl", CLAUDE_SPLIT_REQUEST);
    plain.index(KIND_CLAUDE, true);

    let archived = Fixture::new();
    archived.write_gzip(KIND_CLAUDE, "S1.jsonl.gz", CLAUDE_SPLIT_REQUEST);
    let report = archived.index_with_archive(KIND_CLAUDE, true);

    assert_eq!(report.files_done, 1);
    assert_eq!(archived.count("session"), plain.count("session"));
    assert_eq!(archived.count("turn"), plain.count("turn"));
    assert_eq!(archived.count("tool_event"), plain.count("tool_event"));
}

#[test]
fn gzip_archive_is_skipped_when_live_file_exists() {
    let fixture = Fixture::new();
    let live = fixture.write("S1.jsonl", CLAUDE_SPLIT_REQUEST);
    let archive = fixture.write_gzip(KIND_CLAUDE, "S1.jsonl.gz", CLAUDE_SPLIT_REQUEST);

    let report = fixture.index_with_archive(KIND_CLAUDE, true);
    assert_eq!(report.files_done, 1);
    assert_eq!(fixture.count("source_file"), 1);
    let indexed_path: String = fixture
        .conn()
        .query_row("SELECT path FROM source_file", [], |row| row.get(0))
        .expect("read source path");
    assert_eq!(indexed_path, live.to_string_lossy());
    assert_ne!(indexed_path, archive.to_string_lossy());
}

#[test]
fn gzip_archive_is_skipped_when_live_path_is_already_indexed() {
    let fixture = Fixture::new();
    let live_path = fixture.logs.join("S1.jsonl");
    let archive = fixture.write_gzip(KIND_CLAUDE, "S1.jsonl.gz", CLAUDE_SPLIT_REQUEST);
    fixture
        .conn()
        .execute(
            "INSERT INTO source_file (path, kind, size_bytes, mtime_ns, parsed_bytes, parsed_lines, last_indexed) VALUES (?1, ?2, 0, 0, 0, 0, 0)",
            params![live_path.to_string_lossy(), KIND_CLAUDE],
        )
        .expect("seed live source_file row");

    let report = fixture.index_with_archive(KIND_CLAUDE, false);
    assert_eq!(report.files_done, 0);
    assert_eq!(report.files_skipped, 1);
    let archive_rows: i64 = fixture
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM source_file WHERE path = ?1",
            params![archive.to_string_lossy()],
            |row| row.get(0),
        )
        .expect("count archive source rows");
    assert_eq!(archive_rows, 0);
}

#[test]
fn full_rebuild_indexes_archive_only_once() {
    let fixture = Fixture::new();
    let archive = fixture.write_gzip(KIND_CLAUDE, "S1.jsonl.gz", CLAUDE_SPLIT_REQUEST);

    let first = fixture.index_with_archive(KIND_CLAUDE, true);
    assert_eq!(first.files_done, 1);
    assert_eq!(fixture.count("session"), 1);
    assert_eq!(fixture.count("turn"), 1);
    let indexed_path: String = fixture
        .conn()
        .query_row("SELECT path FROM source_file", [], |row| row.get(0))
        .expect("read archive source path");
    assert_eq!(indexed_path, archive.to_string_lossy());

    let second = fixture.index_with_archive(KIND_CLAUDE, false);
    assert_eq!(second.files_done, 0);
    assert_eq!(second.files_skipped, 1);
    assert_eq!(fixture.count("session"), 1);
    assert_eq!(fixture.count("turn"), 1);
}

#[test]
fn a_forced_full_reindex_replaces_rather_than_appends() {
    let fixture = Fixture::new();
    fixture.write("S1.jsonl", CLAUDE_SPLIT_REQUEST);
    fixture.index(KIND_CLAUDE, false);
    let turns = fixture.count("turn");
    let tools = fixture.count("tool_event");

    fixture.index(KIND_CLAUDE, true);
    assert_eq!(fixture.count("turn"), turns);
    assert_eq!(fixture.count("tool_event"), tools);

    fixture.index(KIND_CLAUDE, true);
    assert_eq!(fixture.count("turn"), turns);
    assert_eq!(fixture.count("tool_event"), tools);
}

#[test]
fn appended_lines_resume_from_the_previous_offset() {
    let fixture = Fixture::new();
    fixture.write("S1.jsonl", &CLAUDE_SPLIT_REQUEST[..1]);
    fixture.index(KIND_CLAUDE, false);
    assert_eq!(fixture.count("turn"), 1);
    assert_eq!(fixture.count("tool_event"), 0);

    // The second half of the same request arrives later. It must merge into
    // the existing turn — same requestId — and contribute its tool call.
    fixture.append("S1.jsonl", &CLAUDE_SPLIT_REQUEST[1..]);
    fixture.index(KIND_CLAUDE, false);

    assert_eq!(
        fixture.count("turn"),
        1,
        "the split request stayed one turn"
    );
    assert_eq!(fixture.count("tool_event"), 1);
    let tool_calls: i64 = fixture
        .conn()
        .query_row("SELECT tool_calls FROM turn", [], |row| row.get(0))
        .unwrap();
    assert_eq!(tool_calls, 1);
}

#[test]
fn a_truncated_file_is_reparsed_from_the_start() {
    let fixture = Fixture::new();
    fixture.write("S3.jsonl", CLAUDE_MIXED_MODELS);
    fixture.index(KIND_CLAUDE, false);
    assert_eq!(fixture.count("turn"), 3);

    // Rotation: the file shrinks. Resuming from the old offset would read
    // garbage, so the whole file is re-read and the old rows are dropped.
    fixture.write("S3.jsonl", &CLAUDE_MIXED_MODELS[..1]);
    fixture.index(KIND_CLAUDE, false);
    assert_eq!(fixture.count("turn"), 1);

    let parsed: (i64, i64) = fixture
        .conn()
        .query_row(
            "SELECT parsed_bytes, size_bytes FROM source_file",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(parsed.0, parsed.1, "parsed offset tracks the new size");
}

#[test]
fn synthetic_index_benchmark_reports_phase_timings_and_skips_unchanged_files() {
    const FILES: usize = 96;
    const TURNS_PER_FILE: usize = 32;

    let fixture = Fixture::new();
    for file_index in 0..FILES {
        let path = fixture.logs.join(format!("benchmark-{file_index}.jsonl"));
        let mut body = String::new();
        for turn_index in 0..TURNS_PER_FILE {
            body.push_str(&format!(
                r#"{{"type":"assistant","sessionId":"BENCH-{file_index}","requestId":"request-{turn_index}","timestamp":"2026-08-01T00:{:02}:{:02}.000Z","cwd":"C:\\bench","entrypoint":"cli","uuid":"bench-{file_index}-{turn_index}","message":{{"id":"message-{turn_index}","model":"claude-opus-5","role":"assistant","content":[],"usage":{{"input_tokens":100,"output_tokens":200,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#,
                turn_index / 60,
                turn_index % 60,
            ));
            body.push('\n');
        }
        std::fs::write(path, body).expect("write benchmark transcript");
    }

    let full = fixture.index(KIND_CLAUDE, true);
    assert_eq!(full.files_done, FILES);
    assert_eq!(fixture.count("turn"), (FILES * TURNS_PER_FILE) as i64);

    let unchanged = fixture.index(KIND_CLAUDE, false);
    assert_eq!(unchanged.files_done, 0, "unchanged inputs must not reparse");
    assert_eq!(unchanged.files_skipped, FILES);
    assert_eq!(unchanged.bytes_done, 0);
    assert_eq!(unchanged.sessions, 0, "unchanged inputs must not recompute");

    fixture.append(
        "benchmark-0.jsonl",
        &[r#"{"type":"assistant","sessionId":"BENCH-0","requestId":"request-appended","timestamp":"2026-08-01T01:00:00.000Z","cwd":"C:\\bench","entrypoint":"cli","uuid":"bench-appended","message":{"id":"message-appended","model":"claude-opus-5","role":"assistant","content":[],"usage":{"input_tokens":100,"output_tokens":200,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#],
    );
    let appended = fixture.index(KIND_CLAUDE, false);
    assert_eq!(appended.files_done, 1);
    assert_eq!(appended.files_skipped, FILES - 1);
    assert_eq!(appended.sessions, 1, "only the changed session recomputes");

    println!(
        "AILOG_INDEX_BENCH files={FILES} turns={} full_ms={} full_scan_ms={} full_parse_ms={} full_db_write_ms={} full_post_process_ms={} unchanged_ms={} unchanged_scan_ms={} unchanged_parse_ms={} unchanged_db_write_ms={} unchanged_post_process_ms={} append_ms={} append_scan_ms={} append_parse_ms={} append_db_write_ms={} append_post_process_ms={}",
        FILES * TURNS_PER_FILE,
        full.elapsed_ms,
        full.timings.scan_ms,
        full.timings.parse_ms,
        full.timings.db_write_ms,
        full.timings.post_process_ms,
        unchanged.elapsed_ms,
        unchanged.timings.scan_ms,
        unchanged.timings.parse_ms,
        unchanged.timings.db_write_ms,
        unchanged.timings.post_process_ms,
        appended.elapsed_ms,
        appended.timings.scan_ms,
        appended.timings.parse_ms,
        appended.timings.db_write_ms,
        appended.timings.post_process_ms,
    );
}

#[test]
fn a_partial_trailing_line_is_left_for_the_next_pass() {
    let fixture = Fixture::new();
    let path = fixture.logs.join("S1.jsonl");
    // A complete line followed by a half-written one (no trailing newline).
    let body = format!("{}\n{{\"type\":\"assis", CLAUDE_SPLIT_REQUEST[0]);
    std::fs::write(&path, body).unwrap();

    fixture.index(KIND_CLAUDE, false);
    assert_eq!(fixture.count("turn"), 1);
    let (parsed, size): (i64, i64) = fixture
        .conn()
        .query_row(
            "SELECT parsed_bytes, size_bytes FROM source_file",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert!(
        parsed < size,
        "the incomplete tail must not be marked as consumed"
    );
}

// ---------------------------------------------------------------------------
// Derived columns
// ---------------------------------------------------------------------------

#[test]
fn a_mixed_model_session_is_split_per_turn() {
    let fixture = Fixture::new();
    fixture.write("S3.jsonl", CLAUDE_MIXED_MODELS);
    fixture.index(KIND_CLAUDE, false);

    let conn = fixture.conn();
    let (model_count, primary): (i64, String) = conn
        .query_row(
            "SELECT model_count, primary_model FROM session WHERE session_id = 'S3'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(model_count, 2);
    // The haiku turn is far more expensive, so it owns the label even though
    // opus ran first and ran twice.
    assert_eq!(primary, "haiku-4.5");

    let report = query::models(
        &conn,
        &all_time(),
        &Filters::default(),
        &query::ModelsOptions::default(),
        NOW,
    )
    .unwrap();

    assert_eq!(report.total_sessions, 1);
    assert_eq!(report.mixed_sessions, 1);
    assert_eq!(report.rows.len(), 2);

    let opus = report
        .rows
        .iter()
        .find(|row| row.family == "opus-5")
        .unwrap();
    let haiku = report
        .rows
        .iter()
        .find(|row| row.family == "haiku-4.5")
        .unwrap();
    assert_eq!(opus.turns, 2);
    assert_eq!(haiku.turns, 1);

    // Per-model session counts sum above the session total, because the one
    // session used both. This is model overlap, not work-tag overlap.
    let summed: i64 = report.rows.iter().map(|row| row.sessions).sum();
    assert_eq!(summed, 2);
    assert!(summed > report.total_sessions);
    assert!(!report.overlapping);

    // Share percentages are computed against the true total, so they still
    // add up to 100 even though the session counts overlap.
    let share: f64 = report.rows.iter().map(|row| row.share_pct).sum();
    assert!((share - 100.0).abs() < 1e-6, "share was {share}");
}

#[test]
fn work_tag_session_count_unions_sessions_across_models() {
    let fixture = Fixture::new();
    fixture.write("S3.jsonl", CLAUDE_MIXED_MODELS);
    fixture.index(KIND_CLAUDE, false);

    let report = query::models(
        &fixture.conn(),
        &all_time(),
        &Filters::default(),
        &query::ModelsOptions::default(),
        NOW,
    )
    .unwrap();
    let row = report
        .by_work_tag
        .iter()
        .find(|row| row.work_tag == "explore")
        .expect("mixed-model fixture should have the explore tag");
    assert_eq!(
        row.per_model
            .iter()
            .map(|entry| entry.sessions)
            .sum::<i64>(),
        2,
        "R1 fixture must exercise the old per-model overcount"
    );
    assert_eq!(
        row.session_count, 1,
        "R1 work-tag sessions must be a union across model buckets"
    );
}

#[test]
fn work_tag_overlapping_reflects_actual_multi_tag_sessions() {
    let single_tag = Fixture::new();
    single_tag.write("S3.jsonl", CLAUDE_MIXED_MODELS);
    single_tag.index(KIND_CLAUDE, false);
    let single_report = query::models(
        &single_tag.conn(),
        &all_time(),
        &Filters::default(),
        &query::ModelsOptions::default(),
        NOW,
    )
    .unwrap();
    assert!(
        !single_report.overlapping,
        "R4 a population whose sessions each have one tag must not overlap"
    );

    let multi_tag = Fixture::new();
    multi_tag.write("S2.jsonl", CLAUDE_IO_SESSION);
    multi_tag.index(KIND_CLAUDE, false);
    let multi_report = query::models(
        &multi_tag.conn(),
        &all_time(),
        &Filters::default(),
        &query::ModelsOptions::default(),
        NOW,
    )
    .unwrap();
    assert!(
        multi_report.overlapping,
        "R4 a session with multiple tags must report overlap"
    );
}

#[test]
fn handoffs_count_each_model_switch() {
    let fixture = Fixture::new();
    fixture.write("S3.jsonl", CLAUDE_MIXED_MODELS);
    fixture.index(KIND_CLAUDE, false);

    let models = query::models(
        &fixture.conn(),
        &all_time(),
        &Filters::default(),
        &query::ModelsOptions {
            granularity: "family".to_string(),
            bucket: "day".to_string(),
        },
        NOW,
    )
    .unwrap();
    assert!(models.handoffs.is_empty());

    let report = query::model_handoffs(
        &fixture.conn(),
        &all_time(),
        &Filters::default(),
        &query::ModelsOptions {
            granularity: "family".to_string(),
            bucket: "day".to_string(),
        },
        NOW,
    )
    .unwrap();

    // A -> B -> A yields exactly one hand-off in each direction.
    assert_eq!(report.handoffs.len(), 2);
    let forward = report
        .handoffs
        .iter()
        .find(|h| h.from == "opus-5" && h.to == "haiku-4.5")
        .expect("opus -> haiku");
    let back = report
        .handoffs
        .iter()
        .find(|h| h.from == "haiku-4.5" && h.to == "opus-5")
        .expect("haiku -> opus");
    assert_eq!(forward.count, 1);
    assert_eq!(back.count, 1);
}

#[test]
fn raw_granularity_exposes_switches_inside_one_family() {
    let fixture = Fixture::new();
    fixture.write("rollout-CX2.jsonl", CODEX_HANDOFF);
    fixture.index(KIND_CODEX, false);
    let conn = fixture.conn();

    // terra and sol share the `gpt-5.6` family, so nothing shows at family
    // granularity...
    let family = query::models(
        &conn,
        &all_time(),
        &Filters::default(),
        &query::ModelsOptions {
            granularity: "family".to_string(),
            bucket: "day".to_string(),
        },
        NOW,
    )
    .unwrap();
    assert!(family.handoffs.is_empty());
    assert_eq!(family.rows.len(), 1);
    let family_handoffs = query::model_handoffs(
        &conn,
        &all_time(),
        &Filters::default(),
        &query::ModelsOptions {
            granularity: "family".to_string(),
            bucket: "day".to_string(),
        },
        NOW,
    )
    .unwrap();
    assert!(family_handoffs.handoffs.is_empty());

    // ...but the tier change is exactly what the operator cares about.
    let raw = query::models(
        &conn,
        &all_time(),
        &Filters::default(),
        &query::ModelsOptions {
            granularity: "raw".to_string(),
            bucket: "day".to_string(),
        },
        NOW,
    )
    .unwrap();
    assert_eq!(raw.rows.len(), 2);
    assert!(raw.handoffs.is_empty());
    let raw_handoffs = query::model_handoffs(
        &conn,
        &all_time(),
        &Filters::default(),
        &query::ModelsOptions {
            granularity: "raw".to_string(),
            bucket: "day".to_string(),
        },
        NOW,
    )
    .unwrap();
    assert_eq!(raw_handoffs.handoffs.len(), 2);
    assert!(raw_handoffs
        .handoffs
        .iter()
        .any(|h| h.from == "gpt-5.6-terra" && h.to == "gpt-5.6-sol" && h.count == 1));
}

#[test]
fn an_unknown_model_is_reported_rather_than_guessed() {
    let fixture = Fixture::new();
    fixture.write("S4.jsonl", CLAUDE_UNKNOWN_MODEL);
    fixture.index(KIND_CLAUDE, false);
    let conn = fixture.conn();

    let cost: f64 = conn
        .query_row("SELECT cost_usd FROM turn", [], |row| row.get(0))
        .unwrap();
    assert_eq!(cost, 0.0, "no nearby model's rate may be substituted");

    let overview = query::overview(&conn, &all_time(), &Filters::default(), NOW).unwrap();
    assert_eq!(overview.totals.cost_usd, 0.0);
    assert_eq!(
        overview.price_coverage.unknown.models,
        vec!["totally-unknown-model-x".to_string()]
    );
    assert_eq!(overview.price_coverage.covered_token_ratio, 0.0);
    assert_eq!(overview.price_source, "default");

    let row = overview
        .top_models
        .iter()
        .find(|row| row.family == "totally-unknown-model-x")
        .expect("unknown model still appears");
    assert_eq!(row.model_class, crate::ailog::price::ModelClass::Unknown);
    assert_eq!(row.turns, 1);
}

#[test]
fn read_write_and_exec_characters_land_in_their_own_buckets() {
    let fixture = Fixture::new();
    fixture.write("S2.jsonl", CLAUDE_IO_SESSION);
    fixture.index(KIND_CLAUDE, false);

    let detail = query::session_detail(&fixture.conn(), KIND_CLAUDE, "S2").unwrap();
    let io = &detail.cost_breakdown.io_chars;

    assert_eq!(io.read, 10, "Read tool_result");
    assert_eq!(io.exec, 3, "Bash tool_result");
    assert_eq!(io.write, 5, "Edit new_string, measured on the request side");
    assert_eq!(io.fetch, 0);
    // The Edit confirmation (2) plus the unidentifiable tool's output (4).
    assert_eq!(io.other, 6);
    assert_eq!(io.prompt, "最初の指示です".chars().count() as i64);
    assert_eq!(io.estimation, "char_count_only");

    assert_eq!(detail.cost_breakdown.io_files.read_files, 1);
    assert_eq!(detail.cost_breakdown.io_files.written_files, 1);
}

#[test]
fn ingest_and_generate_costs_reconcile_with_the_total() {
    let fixture = Fixture::new();
    fixture.write("S3.jsonl", CLAUDE_MIXED_MODELS);
    fixture.index(KIND_CLAUDE, false);

    let detail = query::session_detail(&fixture.conn(), KIND_CLAUDE, "S3").unwrap();
    let ingest = detail.cost_breakdown.ingest.cost_usd;
    let generate = detail.cost_breakdown.generate.cost_usd;
    let total: f64 = detail.turns.iter().map(|turn| turn.cost_usd).sum();

    assert!(total > 0.0);
    assert!(
        (ingest + generate - total).abs() < 1e-9,
        "ingest {ingest} + generate {generate} != total {total}"
    );
    assert!((detail.cost_breakdown.ingest_ratio - ingest / total).abs() < 1e-9);
}

#[test]
fn a_failed_tool_result_marks_the_call_and_feeds_rework() {
    let fixture = Fixture::new();
    fixture.write("S2.jsonl", CLAUDE_IO_SESSION);
    fixture.index(KIND_CLAUDE, false);

    let detail = query::session_detail(&fixture.conn(), KIND_CLAUDE, "S2").unwrap();
    assert_eq!(detail.rework.tool_call_count, 4);
    assert_eq!(detail.rework.tool_error_count, 1);
    assert!((detail.rework.tool_error_rate - 0.25).abs() < 1e-9);
    assert!(detail.rework.score > 0.0);
    assert!(detail.rework.score_note.contains("relative comparison"));
}

#[test]
fn tool_failures_are_attributed_back_to_the_issuing_turn() {
    // Regression guard: a tool result arrives on a later line than the turn
    // that issued the call, so `turn.tool_errors` has to be derived after the
    // fact. It silently stayed zero until a smoke run over real transcripts
    // showed every model at a 0% error rate.
    let fixture = Fixture::new();
    fixture.write("S2.jsonl", CLAUDE_IO_SESSION);
    fixture.index(KIND_CLAUDE, false);

    let detail = query::session_detail(&fixture.conn(), KIND_CLAUDE, "S2").unwrap();
    assert_eq!(detail.turns.len(), 1);
    assert_eq!(detail.turns[0].tool_calls, 4);
    assert_eq!(detail.turns[0].tool_errors, 1);

    let report = query::models(
        &fixture.conn(),
        &all_time(),
        &Filters::default(),
        &query::ModelsOptions::default(),
        NOW,
    )
    .unwrap();
    let row = &report.rows[0];
    assert!((row.tool_error_rate - 0.25).abs() < 1e-9);
    // This transcript's last assistant message is a tool call with no closing
    // reply, so the session is abandoned. The rate comes from that stored
    // flag, not from a rework-score proxy.
    assert!(detail.rework.abandoned);
    assert_eq!(row.abandoned_rate, 1.0);
}

#[test]
fn a_session_that_ends_on_a_reply_is_not_abandoned() {
    // Counterpart to the test above: without it, an `abandoned_rate` hard-wired
    // to 1.0 would pass just as happily.
    let fixture = Fixture::new();
    fixture.write("S3.jsonl", CLAUDE_MIXED_MODELS);
    fixture.index(KIND_CLAUDE, false);

    let detail = query::session_detail(&fixture.conn(), KIND_CLAUDE, "S3").unwrap();
    assert!(!detail.rework.abandoned);

    let report = query::models(
        &fixture.conn(),
        &all_time(),
        &Filters::default(),
        &query::ModelsOptions::default(),
        NOW,
    )
    .unwrap();
    assert!(report.rows.iter().all(|row| row.abandoned_rate == 0.0));
}

#[test]
fn work_tags_and_goal_keys_reach_the_database() {
    let fixture = Fixture::new();
    fixture.write("S2.jsonl", CLAUDE_IO_SESSION);
    fixture.index(KIND_CLAUDE, false);

    let conn = fixture.conn();
    let (tags, goal): (String, String) = conn
        .query_row(
            "SELECT work_tags, goal_key FROM session WHERE session_id = 'S2'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let tags: Vec<String> = serde_json::from_str(&tags).unwrap();
    // 1 of 4 calls is an Edit -> 25% >= 20%.
    assert!(
        tags.contains(&"implement".to_string()),
        "tags were {tags:?}"
    );
    assert_eq!(goal, "i o buckets test");

    let breakdown =
        query::breakdown(&conn, &all_time(), &Filters::default(), "title", NOW).unwrap();
    assert_eq!(breakdown.rows.len(), 1);
    assert_eq!(breakdown.rows[0].key, "i o buckets test");
}

#[test]
fn tag_costs_may_exceed_the_total_without_being_pro_rated() {
    let fixture = Fixture::new();
    fixture.write("S2.jsonl", CLAUDE_IO_SESSION);
    fixture.index(KIND_CLAUDE, false);
    let conn = fixture.conn();

    let report = query::models(
        &conn,
        &all_time(),
        &Filters::default(),
        &query::ModelsOptions::default(),
        NOW,
    )
    .unwrap();
    let overview = query::overview(&conn, &all_time(), &Filters::default(), NOW).unwrap();

    let tags: Vec<&str> = report
        .by_work_tag
        .iter()
        .map(|row| row.work_tag.as_str())
        .collect();
    assert!(tags.len() >= 2, "expected several tags, got {tags:?}");

    let tagged_cost: f64 = report
        .by_work_tag
        .iter()
        .flat_map(|row| row.per_model.iter())
        .map(|entry| entry.cost_usd)
        .sum();
    assert!(
        tagged_cost > overview.totals.cost_usd,
        "tag costs {tagged_cost} should exceed the total {} because tags overlap",
        overview.totals.cost_usd
    );
    assert!(report.overlapping);
}

// ---------------------------------------------------------------------------
// Codex end to end
// ---------------------------------------------------------------------------

#[test]
fn codex_sessions_index_and_aggregate() {
    let fixture = Fixture::new();
    fixture.write("rollout-2026-08-04T00-00-00-CX1.jsonl", CODEX_TOKEN_COUNTS);
    fixture.index(KIND_CODEX, false);
    let conn = fixture.conn();

    let overview = query::overview(&conn, &all_time(), &Filters::default(), NOW).unwrap();
    assert_eq!(overview.totals.sessions, 1);
    assert_eq!(overview.totals.turns, 2);
    // Deltas only: 100 + 200, never the cumulative 300.
    assert_eq!(overview.totals.output, 300);
    assert_eq!(overview.totals.input, 1_600);
    assert_eq!(overview.totals.cache_read, 1_400);
    assert_eq!(overview.totals.reasoning, 90);

    // gpt-5.6-terra: input 2.0, output 12, cache read 0.20 per MTok.
    let expected = (1_600.0 * 2.0 + 1_400.0 * 0.20 + 300.0 * 12.0) / 1_000_000.0;
    assert!(
        (overview.totals.cost_usd - expected).abs() < 1e-12,
        "cost was {} expected {expected}",
        overview.totals.cost_usd
    );
    assert_eq!(overview.price_coverage.covered_token_ratio, 1.0);

    let detail = query::session_detail(&conn, KIND_CODEX, "CX1").unwrap();
    assert_eq!(detail.plan_type.as_deref(), Some("pro"));
    assert_eq!(detail.session.origin.as_deref(), Some("unknown"));
}

#[test]
fn grok_indexes_updates_only_and_uses_provider_cost() {
    let fixture = Fixture::new();
    fixture.write("G1/updates.jsonl", GROK_UPDATES);
    fixture.write("G1/events.jsonl", GROK_EVENTS);
    fixture.write(
        "G1/summary.json",
        &[r#"{"info":{"id":"G1","cwd":"C:\\proj\\grok"},"current_model_id":"grok-4.6"}"#],
    );

    let report = fixture.index(KIND_GROK, false);
    assert_eq!(report.files_total, 1, "events.jsonl must be excluded");
    assert_eq!(report.files_done, 1);
    let conn = fixture.conn();

    let session: (String, String, String, i64, String, i64, String, f64) = conn
        .query_row(
            "SELECT kind, session_id, cwd, user_msg_count, first_prompt, turn_count, primary_model, cost_usd FROM session",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(session.0, KIND_GROK);
    assert_eq!(session.1, "G1");
    assert_eq!(session.2, r"C:\proj\grok");
    assert_eq!(session.3, 1);
    assert_eq!(session.4, "hello world");
    assert_eq!(session.5, 1);
    assert_eq!(session.6, "grok-4.6-build");
    assert!((session.7 - 0.12345).abs() < 1e-12);

    let turn: (i64, i64, i64, i64, i64, f64) = conn
        .query_row(
            "SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, reasoning_tokens, cost_usd FROM turn",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        )
        .unwrap();
    assert_eq!(turn.0, 600);
    assert_eq!(turn.1, 100);
    assert_eq!(turn.2, 400);
    assert_eq!(turn.3, 25);
    assert_eq!(turn.4, 40);
    assert!((turn.5 - 0.12345).abs() < 1e-12);

    let tool: (String, String, String, String) = conn
        .query_row(
            "SELECT name, call_id, target, turn_key FROM tool_event",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(tool, ("read_file".to_string(), "call-1".to_string(), r"C:\proj\a.rs".to_string(), "P1".to_string()));
    assert_eq!(fixture.count("source_file"), 1);
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM source_file WHERE path LIKE '%events.jsonl'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap(),
        0
    );
}

#[test]
fn grok_decodes_cwd_from_the_encoded_session_parent() {
    let fixture = Fixture::new();
    fixture.write("C%3A%5Cproj/G1/updates.jsonl", GROK_UPDATES);

    fixture.index(KIND_GROK, false);
    let conn = fixture.conn();
    let cwd: String = conn
        .query_row(
            "SELECT cwd FROM session WHERE kind=?1 AND session_id=?2",
            [KIND_GROK, "G1"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(cwd, r"C:\proj");
}

#[test]
fn grok_reparses_an_appended_file_without_duplicate_session_metrics() {
    let fixture = Fixture::new();
    fixture.write("G1/updates.jsonl", &GROK_UPDATES[..2]);
    fixture.index(KIND_GROK, false);
    fixture.append("G1/updates.jsonl", &GROK_UPDATES[2..]);
    fixture.index(KIND_GROK, false);

    let conn = fixture.conn();
    let counts: (i64, i64, i64) = conn
        .query_row(
            "SELECT user_msg_count, turn_count, (SELECT COUNT(*) FROM tool_event) FROM session WHERE kind=?1 AND session_id=?2",
            [KIND_GROK, "G1"],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(counts, (1, 1, 1));
}

#[test]
fn origin_is_never_claimed_as_mycmux() {
    let fixture = Fixture::new();
    fixture.write("rollout-CX1.jsonl", CODEX_TOKEN_COUNTS);
    fixture.index(KIND_CODEX, false);

    let origins: Vec<String> = {
        let conn = fixture.conn();
        let mut stmt = conn.prepare("SELECT DISTINCT origin FROM session").unwrap();
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|row| row.unwrap())
            .collect();
        rows
    };
    // The launcher is not recorded in either transcript, so `mycmux` can never
    // be proven and is therefore never written.
    assert!(!origins.iter().any(|origin| origin == "mycmux"));
    assert_eq!(origins, vec!["unknown".to_string()]);
}

// ---------------------------------------------------------------------------
// Range plumbing through a real query
// ---------------------------------------------------------------------------

#[test]
fn explicit_range_bounds_filter_the_result_set() {
    let fixture = Fixture::new();
    fixture.write("S3.jsonl", CLAUDE_MIXED_MODELS);
    fixture.index(KIND_CLAUDE, false);
    let conn = fixture.conn();

    // The three turns sit at 00:00:00, 00:00:10 and 00:00:20 on 2026-08-02.
    let base = chrono::DateTime::parse_from_rfc3339("2026-08-02T00:00:00.000Z")
        .unwrap()
        .timestamp_millis();

    let all = query::overview(&conn, &all_time(), &Filters::default(), NOW).unwrap();
    assert_eq!(all.totals.turns, 3);

    let narrow = query::overview(
        &conn,
        &Range {
            from: Some(base + 5_000),
            to: Some(base + 15_000),
            // A preset alongside explicit bounds must be ignored.
            preset: Some("7d".to_string()),
            anchor: None,
        },
        &Filters::default(),
        NOW,
    )
    .unwrap();
    assert_eq!(narrow.totals.turns, 1);
    assert_eq!(narrow.range.label, "custom");
    assert_eq!(narrow.range.from, base + 5_000);
}

/// Smoke test against the operator's real transcripts.
///
/// Ignored by default: it depends on machine-local data and would fail on any
/// other checkout. Run it deliberately with
/// `--ignored --nocapture --exact ailog::tests::index_tests::smoke_real_claude_project`,
/// optionally pointing `AILOG_SMOKE_DIR` at a different transcript directory.
#[test]
#[ignore]
fn smoke_real_claude_project() {
    let dir = std::env::var("AILOG_SMOKE_DIR").unwrap_or_else(|_| {
        crate::ailog::claude_root()
            .expect("claude root")
            .join("C--Users-miyaz-cmux-for-linux-dev-master")
            .to_string_lossy()
            .to_string()
    });
    let dir = std::path::PathBuf::from(dir);
    assert!(dir.is_dir(), "smoke directory not found: {dir:?}");

    let scratch = tempfile::tempdir().expect("tempdir");
    let db = scratch.path().join("smoke.db");

    let report = index_dir(KIND_CLAUDE, &dir, &db, false);
    println!("--- index report ---");
    println!("{}", serde_json::to_string_pretty(&report).unwrap());

    let conn = crate::ailog::open_db(&db).expect("open smoke db");
    let overview = query::overview(
        &conn,
        &all_time(),
        &Filters::default(),
        chrono::Utc::now().timestamp_millis(),
    )
    .expect("overview");
    println!("--- ailog_overview ---");
    println!("{}", serde_json::to_string_pretty(&overview).unwrap());

    let models = query::models(
        &conn,
        &all_time(),
        &Filters::default(),
        &query::ModelsOptions::default(),
        chrono::Utc::now().timestamp_millis(),
    )
    .expect("models");
    println!("--- ailog_models (handoffs / work tags) ---");
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "granularity": models.granularity,
            "mixedSessions": models.mixed_sessions,
            "totalSessions": models.total_sessions,
            "handoffs": models.handoffs,
            "byWorkTag": models.by_work_tag,
            "overlapping": models.overlapping,
            "priceCoverage": models.price_coverage,
        }))
        .unwrap()
    );

    // A second pass over unchanged files must add nothing.
    let again = index_dir(KIND_CLAUDE, &dir, &db, false);
    let turns_before: i64 = conn
        .query_row("SELECT COUNT(*) FROM turn", [], |row| row.get(0))
        .unwrap();
    let conn2 = crate::ailog::open_db(&db).expect("reopen");
    let turns_after: i64 = conn2
        .query_row("SELECT COUNT(*) FROM turn", [], |row| row.get(0))
        .unwrap();
    println!(
        "--- idempotency: {} files skipped on rerun, turns {} -> {} ---",
        again.files_skipped, turns_before, turns_after
    );
    assert_eq!(turns_before, turns_after);
    assert_eq!(again.files_done, 0);
}

#[test]
fn price_edits_reprice_the_stored_costs() {
    let fixture = Fixture::new();
    fixture.write("S4.jsonl", CLAUDE_UNKNOWN_MODEL);
    fixture.index(KIND_CLAUDE, false);
    let mut conn = fixture.conn();

    assert_eq!(
        query::overview(&conn, &all_time(), &Filters::default(), NOW)
            .unwrap()
            .totals
            .cost_usd,
        0.0
    );

    query::set_price(
        &mut conn,
        &query::PriceEntry {
            model: "totally-unknown-model-x".to_string(),
            input_per_mtok: 1_000_000.0,
            output_per_mtok: 2_000_000.0,
            cache_read_per_mtok: 0.0,
            cache_write_5m_per_mtok: 0.0,
            cache_write_1h_per_mtok: 0.0,
            source: "user".to_string(),
            updated_at: 0,
        },
    )
    .unwrap();

    let overview = query::overview(&conn, &all_time(), &Filters::default(), NOW).unwrap();
    // 1000 input * $1e6/MTok + 2000 output * $2e6/MTok = 1000 + 4000.
    assert!((overview.totals.cost_usd - 5_000.0).abs() < 1e-6);
    assert_eq!(overview.price_coverage.covered_token_ratio, 1.0);
    assert_eq!(overview.price_source, "mixed");
}
