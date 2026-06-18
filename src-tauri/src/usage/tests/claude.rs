use chrono::{DateTime, Utc};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

use crate::usage::config::UsageConfig;
use crate::usage::{cache, claude};

const FIXTURE: &str = include_str!("fixtures/claude_sample.jsonl");

#[test]
fn counts_only_entries_inside_5h_window() {
    cache::clear();
    let dir = tempfile::tempdir().unwrap();
    let path = write_fixture(dir.path(), FIXTURE);
    let cfg = UsageConfig::for_tests(glob_for(dir.path()), String::new());
    let now = fixed_now();

    let (five_hours, _) = claude::aggregate(now, &cfg).unwrap();

    assert_eq!(five_hours.tokens, 4_200);
    assert_eq!(five_hours.messages, 0);
    assert_eq!(five_hours.reset_at, parse_time("2026-05-13T13:30:00Z"));
    assert!(path.is_file());
}

#[test]
fn excludes_entries_outside_7d_window() {
    cache::clear();
    let dir = tempfile::tempdir().unwrap();
    let path = write_fixture(dir.path(), FIXTURE);
    append_line(
        &path,
        r#"{"timestamp":"2026-05-05T12:00:00Z","message":{"usage":{"input_tokens":9000,"output_tokens":9000,"cache_creation_input_tokens":9000}},"type":"assistant"}"#,
    );
    let cfg = UsageConfig::for_tests(glob_for(dir.path()), String::new());

    let (_, seven_days) = claude::aggregate(fixed_now(), &cfg).unwrap();

    assert_eq!(seven_days.tokens, 6_200);
    assert_eq!(seven_days.messages, 0);
    assert_eq!(seven_days.reset_at, parse_time("2026-05-14T12:01:00Z"));
}

#[test]
fn reuses_cache_and_reads_appended_delta() {
    cache::clear();
    let dir = tempfile::tempdir().unwrap();
    let path = write_fixture(dir.path(), FIXTURE);
    let cfg = UsageConfig::for_tests(glob_for(dir.path()), String::new());
    let now = fixed_now();

    let (before, _) = claude::aggregate(now, &cfg).unwrap();
    append_line(
        &path,
        r#"{"timestamp":"2026-05-13T11:55:00Z","message":{"usage":{"input_tokens":300,"output_tokens":100,"cache_creation_input_tokens":50}},"type":"assistant"}"#,
    );
    let (after, _) = claude::aggregate(now, &cfg).unwrap();

    assert_eq!(before.tokens, 4_200);
    assert_eq!(after.tokens, 4_650);
}

fn fixed_now() -> DateTime<Utc> {
    parse_time("2026-05-13T12:00:00Z")
}

fn parse_time(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .unwrap()
        .with_timezone(&Utc)
}

fn write_fixture(dir: &Path, content: &str) -> std::path::PathBuf {
    let nested = dir.join("project-a");
    std::fs::create_dir_all(&nested).unwrap();
    let path = nested.join("session.jsonl");
    std::fs::write(&path, content).unwrap();
    path
}

fn append_line(path: &Path, line: &str) {
    let mut file = OpenOptions::new().append(true).open(path).unwrap();
    writeln!(file, "{line}").unwrap();
}

fn glob_for(dir: &Path) -> String {
    dir.join("**")
        .join("*.jsonl")
        .to_string_lossy()
        .replace('\\', "/")
}
