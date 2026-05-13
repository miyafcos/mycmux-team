use crate::usage::{cache, codex, config::UsageConfig};
use chrono::{DateTime, Utc};
use std::{fs::OpenOptions, io::Write, path::Path};

const SAMPLE: &str = include_str!("fixtures/codex_sample.jsonl");
const OLD_EVENT: &str =
    r#"{"timestamp":"2026-05-01T12:00:00Z","type":"message","role":"assistant"}"#;
const APPENDED_EVENT: &str =
    r#"{"timestamp":"2026-05-13T11:59:00Z","type":"message","role":"assistant"}"#;

#[test]
fn codex_aggregate_inside_5h_counts_only_recent_messages() {
    cache::reset_cache();
    let cfg = UsageConfig::for_test(empty_glob(), fixture_glob("codex_sample.jsonl"));
    let (five_hour, seven_day) = codex::aggregate(now(), &cfg).expect("codex aggregate");

    assert_eq!(five_hour.messages, 2);
    assert_eq!(five_hour.tokens, 2_300);
    assert_eq!(seven_day.messages, 4);
}

#[test]
fn codex_aggregate_outside_7d_excludes_old_messages() {
    cache::reset_cache();
    let temp = tempfile::NamedTempFile::new().expect("temp file");
    std::fs::write(temp.path(), format!("{SAMPLE}{OLD_EVENT}\n")).expect("write fixture");
    let cfg = UsageConfig::for_test(empty_glob(), path_glob(temp.path()));
    let (_, seven_day) = codex::aggregate(now(), &cfg).expect("codex aggregate");

    assert_eq!(seven_day.messages, 4);
}

#[test]
fn codex_aggregate_cache_reuse_reads_appended_delta() {
    cache::reset_cache();
    let temp = tempfile::NamedTempFile::new().expect("temp file");
    std::fs::write(temp.path(), SAMPLE).expect("write fixture");
    let cfg = UsageConfig::for_test(empty_glob(), path_glob(temp.path()));
    let (before, _) = codex::aggregate(now(), &cfg).expect("first aggregate");

    let mut file = OpenOptions::new()
        .append(true)
        .open(temp.path())
        .expect("open temp file");
    writeln!(file, "{APPENDED_EVENT}").expect("append event");

    let (after, _) = codex::aggregate(now(), &cfg).expect("second aggregate");

    assert_eq!(before.messages, 2);
    assert_eq!(after.messages, 3);
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
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src/usage/tests/fixtures/no_claude_*.jsonl"),
    )
}
