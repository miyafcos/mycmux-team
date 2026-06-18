use chrono::{DateTime, Utc};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

use crate::usage::config::UsageConfig;
use crate::usage::{cache, codex};

const FIXTURE: &str = include_str!("fixtures/codex_sample.jsonl");

#[test]
fn counts_only_entries_inside_5h_window() {
    cache::clear();
    let dir = tempfile::tempdir().unwrap();
    write_fixture(dir.path(), FIXTURE);
    let cfg = UsageConfig::for_tests(String::new(), glob_for(dir.path()));

    let (five_hours, _) = codex::aggregate(fixed_now(), &cfg).unwrap();

    assert_eq!(five_hours.messages, 3);
    assert_eq!(five_hours.tokens, 300);
    assert_eq!(five_hours.reset_at, parse_time("2026-05-13T13:30:00Z"));
}

#[test]
fn excludes_entries_outside_7d_window() {
    cache::clear();
    let dir = tempfile::tempdir().unwrap();
    let path = write_fixture(dir.path(), FIXTURE);
    append_line(
        &path,
        r#"{"timestamp":"2026-05-05T12:00:00Z","type":"message","usage":{"total_tokens":999}}"#,
    );
    let cfg = UsageConfig::for_tests(String::new(), glob_for(dir.path()));

    let (_, seven_days) = codex::aggregate(fixed_now(), &cfg).unwrap();

    assert_eq!(seven_days.messages, 5);
    assert_eq!(seven_days.tokens, 500);
    assert_eq!(seven_days.reset_at, parse_time("2026-05-17T12:00:00Z"));
}

#[test]
fn reuses_cache_and_reads_appended_delta() {
    cache::clear();
    let dir = tempfile::tempdir().unwrap();
    let path = write_fixture(dir.path(), FIXTURE);
    let cfg = UsageConfig::for_tests(String::new(), glob_for(dir.path()));
    let now = fixed_now();

    let (before, _) = codex::aggregate(now, &cfg).unwrap();
    append_line(
        &path,
        r#"{"timestamp":"2026-05-13T11:55:00Z","type":"message","usage":{"total_tokens":50}}"#,
    );
    let (after, _) = codex::aggregate(now, &cfg).unwrap();

    assert_eq!(before.messages, 3);
    assert_eq!(after.messages, 4);
    assert_eq!(after.tokens, 350);
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
    let nested = dir.join("2026").join("05").join("13");
    std::fs::create_dir_all(&nested).unwrap();
    let path = nested.join("rollout-2026-05-13T08-30-00-test.jsonl");
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
