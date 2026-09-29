use std::path::Path;

use serde_json::{json, Value};
use tempfile::TempDir;

use super::model::{CapsuleState, IngestInput, JournalEvent, SearchFilters};
use super::store;
use super::try_ingest_at;
use crate::livebrief::SemanticEventEnvelope;

struct Fixture {
    _dir: TempDir,
    db_path: std::path::PathBuf,
    source_log: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        Self {
            db_path: dir.path().join("history.db"),
            source_log: dir.path().join("transcript.jsonl"),
            _dir: dir,
        }
    }
}

fn envelope(id: &str, offset: u64, timestamp: i64, kind: Value) -> SemanticEventEnvelope {
    serde_json::from_value(json!({
        "eventId": id,
        "sourceRevision": 1,
        "occurredAt": timestamp,
        "sourceByteStart": offset,
        "sourceByteEnd": offset + 1,
        "kind": kind,
    }))
    .expect("semantic event fixture")
}

fn journal(id: &str, offset: u64, timestamp: i64, kind: Value) -> JournalEvent {
    let raw = format!("{{\"fixture\":\"{id}\",\"offset\":{offset}}}");
    JournalEvent::from_raw_line(envelope(id, offset, timestamp, kind), &raw)
}

fn input<'a>(
    source_log: &'a Path,
    events: &'a [JournalEvent],
    agent_session_id: &'a str,
    pty_session_id: &'a str,
    repo_id: Option<&'a str>,
    branch: Option<&'a str>,
) -> IngestInput<'a> {
    IngestInput {
        logical_session_id: agent_session_id,
        agent_session_id,
        agent_kind: "codex",
        pty_session_id,
        repo_id,
        cwd: Some("C:\\repo"),
        branch,
        source_log,
        events,
    }
}

fn user(text: &str) -> Value {
    json!({"type":"userMessage","kind":"taskStart","text":text,"digest":"digest"})
}

fn agent(text: &str) -> Value {
    json!({"type":"agentMessage","text":text})
}

fn tool_start(tool: &str, target: &str) -> Value {
    json!({"type":"toolStart","call_id":"call-1","tool":tool,"target":target})
}

fn tool_end(tool: &str, target: &str, ok: bool, summary: Option<&str>) -> Value {
    json!({"type":"toolEnd","call_id":"call-1","tool":tool,"target":target,"ok":ok,"summary":summary})
}

fn file_change(path: &str) -> Value {
    json!({"type":"fileChange","path":path,"change":"modified"})
}

fn test_result(pass: u64, fail: u64) -> Value {
    json!({"type":"testResult","pass":pass,"fail":fail})
}

fn error(text: &str) -> Value {
    json!({"type":"error","fingerprint":"error-1","text":text})
}

#[test]
fn indexing_the_same_tail_twice_does_not_duplicate_events() {
    let fixture = Fixture::new();
    let raw = r#"{"fixture":"one raw record"}"#;
    let events = vec![
        JournalEvent::from_raw_line(envelope("event-1:0", 0, 100, agent("same tail")), raw),
        JournalEvent::from_raw_line(envelope("event-1:1", 0, 100, error("same raw record")), raw),
    ];
    let request = input(&fixture.source_log, &events, "agent-1", "pty-1", None, None);
    store::ingest_at(&fixture.db_path, &request).expect("first ingest");
    store::ingest_at(&fixture.db_path, &request).expect("duplicate ingest");
    assert_eq!(store::event_count_at(&fixture.db_path).expect("count"), 2);
}

#[test]
fn repeated_full_transcript_issues_no_event_insert_or_capsule_work() {
    let fixture = Fixture::new();
    let events = vec![
        journal("user:0", 0, 100, user("keep this open")),
        journal("agent:0", 10, 101, agent("first response")),
    ];
    let request = input(&fixture.source_log, &events, "agent-1", "pty-1", None, None);
    let first = store::ingest_at(&fixture.db_path, &request).expect("first ingest");
    let second = store::ingest_at(&fixture.db_path, &request).expect("repeated ingest");
    assert_eq!(first.event_insert_attempts, 2);
    assert_eq!(second.new_event_count, 0);
    assert_eq!(second.event_insert_attempts, 0);
    assert_eq!(second.event_inserts, 0);
    assert_eq!(second.capsule_events_read, 0);
    assert_eq!(second.capsule_rebuild_count, 0);
    assert_eq!(store::event_count_at(&fixture.db_path).expect("count"), 2);
}

#[test]
fn appending_one_event_rebuilds_only_the_open_turn_tail() {
    let fixture = Fixture::new();
    let mut history = Vec::new();
    for index in 0..40_u64 {
        history.push(journal(
            &format!("user-{index}:0"),
            index * 20,
            100 + index as i64,
            user(&format!("task {index}")),
        ));
        history.push(journal(
            &format!("agent-{index}:0"),
            index * 20 + 10,
            200 + index as i64,
            agent("response"),
        ));
    }
    store::ingest_at(
        &fixture.db_path,
        &input(
            &fixture.source_log,
            &history,
            "agent-1",
            "pty-1",
            None,
            None,
        ),
    )
    .expect("initial history");
    let mut appended = history.clone();
    appended.push(journal(
        "command:0",
        800,
        300,
        tool_end("shell_command", "cargo test", true, Some("ok")),
    ));
    let stats = store::ingest_at(
        &fixture.db_path,
        &input(
            &fixture.source_log,
            &appended,
            "agent-1",
            "pty-1",
            None,
            None,
        ),
    )
    .expect("incremental history");
    assert_eq!(stats.new_event_count, 1);
    assert_eq!(stats.event_insert_attempts, 1);
    assert_eq!(stats.event_inserts, 1);
    assert_eq!(stats.capsule_events_read, 3);
    assert!(stats.capsule_events_read < appended.len());
    assert_eq!(stats.capsule_rebuild_count, 1);
    let capsules = store::capsules_at(&fixture.db_path).expect("capsules");
    assert_eq!(capsules.len(), 40);
    assert_eq!(
        capsules.last().expect("open capsule").state,
        CapsuleState::Open
    );
    assert_eq!(
        capsules.last().expect("open capsule").commands,
        vec!["cargo test"]
    );
}

#[test]
fn appending_to_an_open_turn_preserves_facts_evidence_and_state() {
    let fixture = Fixture::new();
    let initial = vec![
        journal("user-1:0", 0, 100, user("first task")),
        journal(
            "read:0",
            10,
            101,
            tool_end("Read", "src/first.rs", true, Some("ok")),
        ),
    ];
    store::ingest_at(
        &fixture.db_path,
        &input(
            &fixture.source_log,
            &initial,
            "agent-1",
            "pty-1",
            None,
            None,
        ),
    )
    .expect("initial open turn");
    let mut with_write = initial.clone();
    with_write.push(journal("write:0", 20, 102, file_change("src/second.rs")));
    let write_stats = store::ingest_at(
        &fixture.db_path,
        &input(
            &fixture.source_log,
            &with_write,
            "agent-1",
            "pty-1",
            None,
            None,
        ),
    )
    .expect("open turn append");
    assert_eq!(write_stats.new_event_count, 1);
    assert_eq!(write_stats.capsule_events_read, 3);
    let capsules = store::capsules_at(&fixture.db_path).expect("open capsule");
    assert_eq!(capsules.len(), 1);
    assert_eq!(capsules[0].turn_id, "agent-1:user-1:0");
    assert_eq!(capsules[0].state, CapsuleState::Open);
    assert_eq!(capsules[0].read_files, vec!["src/first.rs"]);
    assert_eq!(capsules[0].written_files, vec!["src/second.rs"]);
    assert!(capsules[0]
        .evidence_event_ids
        .contains(&"read:0".to_string()));
    assert!(capsules[0]
        .evidence_event_ids
        .contains(&"write:0".to_string()));

    let mut with_next_user = with_write.clone();
    with_next_user.push(journal("user-2:0", 30, 103, user("second task")));
    store::ingest_at(
        &fixture.db_path,
        &input(
            &fixture.source_log,
            &with_next_user,
            "agent-1",
            "pty-1",
            None,
            None,
        ),
    )
    .expect("close previous turn");
    let capsules = store::capsules_at(&fixture.db_path).expect("closed and open capsules");
    assert_eq!(capsules.len(), 2);
    assert_eq!(capsules[0].state, CapsuleState::Closed);
    assert_eq!(capsules[0].closed_by_event_id.as_deref(), Some("user-2:0"));
    assert_eq!(capsules[1].state, CapsuleState::Open);
}

#[test]
fn source_identity_not_event_id_controls_idempotency_after_reopen() {
    let fixture = Fixture::new();
    let first = vec![journal("event-1:0", 0, 100, agent("first"))];
    let first_request = input(&fixture.source_log, &first, "agent-1", "pty-1", None, None);
    store::ingest_at(&fixture.db_path, &first_request).expect("first ingest");
    let second = vec![journal("event-1:0", 0, 100, agent("first"))];
    let second_request = input(&fixture.source_log, &second, "agent-1", "pty-2", None, None);
    store::ingest_at(&fixture.db_path, &second_request).expect("reopened ingest");
    assert_eq!(store::event_count_at(&fixture.db_path).expect("count"), 1);
}

#[test]
fn agent_session_id_is_the_current_logical_session_across_pty_restarts() {
    let fixture = Fixture::new();
    let second_source = fixture._dir.path().join("resumed-transcript.jsonl");
    let first = vec![journal("event-1:0", 0, 100, agent("one"))];
    let second = vec![journal("event-2:0", 0, 200, agent("two"))];
    store::ingest_at(
        &fixture.db_path,
        &input(
            &fixture.source_log,
            &first,
            "agent-42",
            "pty-before",
            None,
            None,
        ),
    )
    .expect("first ingest");
    store::ingest_at(
        &fixture.db_path,
        &input(&second_source, &second, "agent-42", "pty-after", None, None),
    )
    .expect("resumed ingest");
    assert_eq!(
        store::logical_session_count_at(&fixture.db_path).expect("session count"),
        1
    );
    let hits = store::search_at(
        &fixture.db_path,
        "two",
        &SearchFilters {
            logical_session_id: Some("agent-42".to_string()),
            ..SearchFilters::default()
        },
        10,
    )
    .expect("search");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].logical_session_id, "agent-42");
}

#[test]
fn fts_finds_paths_errors_and_commands_in_bm25_order() {
    let fixture = Fixture::new();
    let events = vec![
        journal("path:0", 0, 100, file_change("src/history/store.rs")),
        journal("error:0", 10, 101, error("database is locked E_BUSY")),
        journal(
            "command:0",
            20,
            102,
            tool_start("shell_command", "cargo test --release"),
        ),
        journal("bm25-low:0", 30, 103, agent("needle")),
        journal("bm25-high:0", 40, 104, agent("needle needle needle needle")),
    ];
    let request = input(&fixture.source_log, &events, "agent-1", "pty-1", None, None);
    store::ingest_at(&fixture.db_path, &request).expect("ingest");
    for query in ["src/history/store.rs", "E_BUSY", "cargo test --release"] {
        assert!(
            !store::search_at(&fixture.db_path, query, &SearchFilters::default(), 10)
                .expect("fts search")
                .is_empty()
        );
    }
    let bm25 = store::search_at(&fixture.db_path, "needle", &SearchFilters::default(), 10)
        .expect("bm25 search");
    assert!(bm25
        .windows(2)
        .all(|pair| { pair[0].bm25_score.expect("score") <= pair[1].bm25_score.expect("score") }));
}

#[test]
fn search_filters_and_hit_evidence_are_preserved() {
    let fixture = Fixture::new();
    let other_source = fixture._dir.path().join("other.jsonl");
    let first = vec![journal("first:0", 0, 123, agent("shared evidence"))];
    let second = vec![journal("second:0", 0, 456, agent("shared evidence"))];
    store::ingest_at(
        &fixture.db_path,
        &input(
            &fixture.source_log,
            &first,
            "agent-a",
            "pty-a",
            Some("repo-a"),
            Some("main"),
        ),
    )
    .expect("first ingest");
    store::ingest_at(
        &fixture.db_path,
        &input(
            &other_source,
            &second,
            "agent-b",
            "pty-b",
            Some("repo-b"),
            Some("feature"),
        ),
    )
    .expect("second ingest");
    let hits = store::search_at(
        &fixture.db_path,
        "shared evidence",
        &SearchFilters {
            repo_id: Some("repo-a".to_string()),
            branch: Some("main".to_string()),
            logical_session_id: Some("agent-a".to_string()),
            near_timestamp: Some(123),
        },
        10,
    )
    .expect("filtered search");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].event_id, "first:0");
    assert_eq!(hits[0].timestamp, 123);
    assert_eq!(hits[0].logical_session_id, "agent-a");
}

#[test]
fn machine_capsules_have_only_machine_facts_and_empty_semantics() {
    let fixture = Fixture::new();
    let events = vec![
        journal("user-1:0", 0, 100, user("implement history")),
        journal(
            "read:0",
            10,
            101,
            tool_end("Read", "src/a.rs", true, Some("ok")),
        ),
        journal("write:0", 20, 102, file_change("src/b.rs")),
        journal(
            "command:0",
            30,
            103,
            tool_end("shell_command", "cargo test", true, Some("ok")),
        ),
        journal("test:0", 40, 104, test_result(3, 0)),
        journal("error:0", 50, 105, error("E42")),
        journal("user-2:0", 60, 106, user("next task")),
    ];
    store::ingest_at(
        &fixture.db_path,
        &input(&fixture.source_log, &events, "agent-1", "pty-1", None, None),
    )
    .expect("ingest");
    let capsules = store::capsules_at(&fixture.db_path).expect("capsules");
    assert_eq!(capsules.len(), 2);
    let closed = &capsules[0];
    assert_eq!(closed.state, CapsuleState::Closed);
    assert_eq!(closed.read_files, vec!["src/a.rs"]);
    assert_eq!(closed.written_files, vec!["src/b.rs"]);
    assert_eq!(closed.commands, vec!["cargo test"]);
    assert_eq!(closed.test_results.len(), 1);
    assert_eq!(closed.errors, vec!["E42"]);
    assert!(closed.evidence_event_ids.contains(&"read:0".to_string()));
    assert!(closed.semantic.decisions.is_empty());
    assert!(closed.semantic.assumptions.is_empty());
    assert!(closed.semantic.next_actions.is_empty());
    assert!(closed.semantic.derived_by.is_none());
    assert_eq!(capsules[1].state, CapsuleState::Open);
}

#[test]
fn capsules_close_only_on_the_next_user_message() {
    let fixture = Fixture::new();
    let events = vec![
        journal("user-1:0", 0, 1, user("first")),
        journal("agent:0", 10, 9_999_999, agent("still first")),
        journal("user-2:0", 20, 10_000_000, user("second")),
    ];
    store::ingest_at(
        &fixture.db_path,
        &input(&fixture.source_log, &events, "agent-1", "pty-1", None, None),
    )
    .expect("ingest");
    let capsules = store::capsules_at(&fixture.db_path).expect("capsules");
    assert_eq!(capsules.len(), 2);
    assert_eq!(capsules[0].state, CapsuleState::Closed);
    assert_eq!(capsules[0].closed_by_event_id.as_deref(), Some("user-2:0"));
    assert_eq!(capsules[1].state, CapsuleState::Open);
}

#[test]
fn logs_without_a_user_message_create_no_capsules() {
    let fixture = Fixture::new();
    let events = vec![
        journal("agent:0", 0, 1, agent("only agent")),
        journal("tool:0", 10, 2, tool_start("Read", "src/lib.rs")),
        journal("error:0", 20, 3, error("no user")),
    ];
    store::ingest_at(
        &fixture.db_path,
        &input(&fixture.source_log, &events, "agent-1", "pty-1", None, None),
    )
    .expect("ingest");
    assert!(store::capsules_at(&fixture.db_path)
        .expect("capsules")
        .is_empty());
}

#[test]
fn ingestion_failure_is_a_non_propagating_noop() {
    let fixture = Fixture::new();
    let blocked_parent = fixture._dir.path().join("not-a-directory");
    std::fs::write(&blocked_parent, "file").expect("blocked parent");
    let blocked_db = blocked_parent.join("history.db");
    let events = vec![journal("event:0", 0, 1, agent("safe no-op"))];
    let request = input(&fixture.source_log, &events, "agent-1", "pty-1", None, None);
    try_ingest_at(&blocked_db, &request);
    assert!(!blocked_db.exists());
}
