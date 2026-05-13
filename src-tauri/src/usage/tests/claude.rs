use crate::usage::{cache, claude, config::UsageConfig};
use chrono::{DateTime, Utc};
use std::{fs::OpenOptions, io::Write, path::Path};

const SAMPLE: &str = include_str!("fixtures/claude_sample.jsonl");
const OLD_EVENT: &str = r#"{"timestamp":"2026-05-01T12:00:00Z","message":{"usage":{"input_tokens":9000,"output_tokens":9000,"cache_creation_input_tokens":9000}},"type":"assistant"}"#;
const APPENDED_EVENT: &str = r#"{"timestamp":"2026-05-13T11:59:00Z","message":{"usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":30}},"type":"assistant"}"#;

#[test]
fn claude_aggregate_inside_5h_counts_only_recent_tokens() {
    cache::reset_cache();
    let cfg = UsageConfig::for_test(fixture_glob("claude_sample.jsonl"), empty_glob());
    let (five_hour, seven_day) = claude::aggregate(now(), &cfg).expect("claude aggregate");

    assert_eq!(five_hour.tokens, 5_150);
    assert_eq!(five_hour.messages, 0);
    assert_eq!(seven_day.tokens, 6_200);
}

#[test]
fn claude_aggregate_outside_7d_excludes_old_tokens() {
    cache::reset_cache();
    let temp = tempfile::NamedTempFile::new().expect("temp file");
    std::fs::write(temp.path(), format!("{SAMPLE}{OLD_EVENT}\n")).expect("write fixture");
    let cfg = UsageConfig::for_test(path_glob(temp.path()), empty_glob());
    let (_, seven_day) = claude::aggregate(now(), &cfg).expect("claude aggregate");

    assert_eq!(seven_day.tokens, 6_200);
}

#[test]
fn claude_aggregate_cache_reuse_reads_appended_delta() {
    cache::reset_cache();
    let temp = tempfile::NamedTempFile::new().expect("temp file");
    std::fs::write(temp.path(), SAMPLE).expect("write fixture");
    let cfg = UsageConfig::for_test(path_glob(temp.path()), empty_glob());
    let (before, _) = claude::aggregate(now(), &cfg).expect("first aggregate");

    let mut file = OpenOptions::new()
        .append(true)
        .open(temp.path())
        .expect("open temp file");
    writeln!(file, "{APPENDED_EVENT}").expect("append event");

    let (after, _) = claude::aggregate(now(), &cfg).expect("second aggregate");

    assert_eq!(before.tokens, 5_150);
    assert_eq!(after.tokens, 5_210);
}

fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-05-13T12:00:00Z")
        .expect("fixed now")
        .with_timezone(&Utc)
}

fn fixture_glob(name: &str) -> String {
    path_glob(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/usage/tests/fixtures")
            .join(name),
    )
}

fn path_glob(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn empty_glob() -> String {
    path_glob(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src/usage/tests/fixtures/no_codex_*.jsonl"),
    )
}
