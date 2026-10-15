use super::*;
use std::time::Duration;

fn request() -> TitleRequest {
    TitleRequest { tab_id:"a".into(), agent_kind:"codex".into(), agent_session_id:None, cwd:"C:/shared/work".into() }
}
fn lookup() -> CodexLookup {
    CodexLookup { session_id:None, started_at:1791964820000, excluded_ids:vec![], contended:false }
}
fn candidate(root: &Path) {
    let header = serde_json::json!({"type":"session_meta", "timestamp":"2026-10-14T08:00:00Z",
        "payload":{"id":"owner-b", "cwd":"C:/shared/work", "source":"cli"}});
    std::fs::write(root.join("rollout-owner-b.jsonl"), serde_json::to_vec(&header).unwrap()).unwrap();
}

#[test]
fn fix2_f01_rejects_an_ended_unmanaged_peer_twenty_seconds_before_launch() {
    let root = tempfile::tempdir().unwrap();
    candidate(root.path());
    let result = locate_in(root.path(), &request(), &lookup(), Instant::now() + Duration::from_secs(5));
    assert!(result.is_err(), "A has no owned UUID; a unique CWD/time match B must not name A: {result:?}");
}
#[test]
fn fix2_f06_rejects_a_unique_readable_peer_when_another_header_is_incomplete() {
    let root = tempfile::tempdir().unwrap();
    candidate(root.path());
    std::fs::write(root.path().join("rollout-owner-a.jsonl"), b"{\"type\":\"session_meta\",\"payload\":").unwrap();
    let result = locate_in(root.path(), &request(), &lookup(), Instant::now() + Duration::from_secs(5));
    assert!(result.is_err(), "Unreadable A cannot prove B unique: {result:?}");
}
#[test]
fn fix2_f06_distinguishes_a_missing_date_from_a_directory_read_error() {
    let root = tempfile::tempdir().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    assert!(locate_in(&root.path().join("missing-date"), &request(), &lookup(), deadline).unwrap().is_none());
    let file = root.path().join("not-a-directory");
    std::fs::write(&file, b"file").unwrap();
    assert!(locate_in(&file, &request(), &lookup(), deadline).is_err(), "A directory IO error is not an empty date");
}
