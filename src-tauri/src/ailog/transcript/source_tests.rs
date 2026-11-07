use super::source::*;
use std::io::Write;
use std::path::{Path, PathBuf};
use crate::ailog::{KIND_CLAUDE, KIND_CLAUDE_CODEX, KIND_CODEX, KIND_GROK};

fn write_log(path: &Path, kind: &str, id: &str, label: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let text = if kind == KIND_CODEX {
        format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\"}}}}\n{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\",\"message\":\"{label}\"}}}}\n")
    } else {
        format!("{{\"type\":\"user\",\"sessionId\":\"{id}\",\"message\":{{\"content\":\"{label}\"}}}}\n")
    };
    if path.extension().is_some_and(|ext| ext == "gz") {
        let mut encoder = flate2::write::GzEncoder::new(std::fs::File::create(path).unwrap(), flate2::Compression::default());
        encoder.write_all(text.as_bytes()).unwrap();
        encoder.finish().unwrap();
    } else { std::fs::write(path, text).unwrap(); }
}

fn config(root: &Path) -> SourceConfig {
    SourceConfig { roots: vec![(KIND_CLAUDE.into(), root.join("source")), (KIND_CODEX.into(), root.join("codex")), (KIND_CLAUDE_CODEX.into(), root.join("hybrid"))],
        archive: Some(root.join("archive")), full_text: Some(root.join("full")), claude_fallback: None }
}

fn recovery_path(cfg: &SourceConfig, recovery: &Path, kind: &str, original: &Path) -> PathBuf {
    let root = &cfg.roots.iter().find(|(source_kind, _)| source_kind == kind).unwrap().1;
    let target = recovery.join(kind).join(original.strip_prefix(root).unwrap());
    PathBuf::from(format!("{}.gz", target.display()))
}

#[cfg(unix)]
fn link_directory(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}

#[cfg(windows)]
fn link_directory(target: &Path, link: &Path) {
    let result = std::process::Command::new("cmd").args(["/c", "mklink", "/J"])
        .arg(link).arg(target).output().unwrap();
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
}

#[test]
fn transcript_candidates_keep_all_originals_before_the_three_recovery_tiers() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let first = dir.path().join("source/project/new.jsonl");
    let second = dir.path().join("source/project/old.jsonl");
    let expected = vec![first.clone(), second.clone(),
        PathBuf::from(format!("{}.gz", first.display())), PathBuf::from(format!("{}.gz", second.display())),
        dir.path().join("archive/claude/project/new.jsonl.gz"), dir.path().join("archive/claude/project/old.jsonl.gz"),
        dir.path().join("full/claude/project/new.jsonl.gz"), dir.path().join("full/claude/project/old.jsonl.gz")];
    for path in expected.iter().skip(4) { write_log(path, KIND_CLAUDE, "sample-session", "fixture"); }
    assert_eq!(candidates(KIND_CLAUDE, &[first, second], false, &cfg), expected);
}

#[test]
fn transcript_recovers_each_tier_and_rejects_a_wrong_header_before_using_it() {
    for tier in 0usize..4 {
        let dir = tempfile::tempdir().unwrap();
        let cfg = config(dir.path());
        let original = dir.path().join("source/project/session.jsonl");
        let paths = vec![original.clone(), PathBuf::from(format!("{}.gz", original.display())),
            recovery_path(&cfg, cfg.archive.as_ref().unwrap(), KIND_CLAUDE, &original),
            recovery_path(&cfg, cfg.full_text.as_ref().unwrap(), KIND_CLAUDE, &original)];
        for path in paths.iter().skip(1).take(tier.saturating_sub(1)) { write_log(path, KIND_CLAUDE, "wrong-session", "wrong"); }
        write_log(&paths[tier], KIND_CLAUDE, "sample-session", "recovered");
        let result = load_paths(KIND_CLAUDE, "sample-session", false, &[original], &cfg).unwrap();
        assert_eq!(result.messages[0].text, "recovered", "tier {tier}");
    }
}

#[test]
fn transcript_database_tries_older_sources_before_the_latest_gzip() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let newest = dir.path().join("source/project/new.jsonl");
    let older = dir.path().join("source/project/old.jsonl");
    write_log(&older, KIND_CLAUDE, "sample-session", "older");
    write_log(&PathBuf::from(format!("{}.gz", newest.display())), KIND_CLAUDE, "sample-session", "newest gzip");
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE source_file(kind TEXT,session_id TEXT,path TEXT,last_indexed INTEGER);
        CREATE TABLE session(kind TEXT,session_id TEXT,is_sidechain INTEGER,relationship_type TEXT);").unwrap();
    conn.execute("INSERT INTO session VALUES ('claude','sample-session',0,'root')", []).unwrap();
    for (index, path) in [older, newest].iter().enumerate() {
        conn.execute("INSERT INTO source_file VALUES ('claude','sample-session',?1,?2)",
            rusqlite::params![path.to_string_lossy(), index as i64]).unwrap();
    }
    let result = load(&conn, KIND_CLAUDE, "sample-session", &cfg).unwrap();
    assert_eq!(result.messages[0].text, "older");
}

#[test]
fn transcript_wrong_or_missing_identity_is_permanent_and_never_reads_body_for_another_session() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let original = dir.path().join("source/project/session.jsonl");
    write_log(&recovery_path(&cfg, cfg.full_text.as_ref().unwrap(), KIND_CLAUDE, &original), KIND_CLAUDE, "other-session", "other");
    let error = load_paths(KIND_CLAUDE, "sample-session", false, &[original], &cfg).unwrap_err();
    assert_eq!(error.code, "identity_mismatch");
    assert!(!error.retryable);
    assert!(!error.technical.contains("other-session"));
    let missing = load_paths(KIND_CLAUDE, "sample-session", false, &[], &cfg).unwrap_err();
    assert_eq!(missing.code, "not_found");
    assert!(!missing.retryable);
}

#[test]
fn transcript_codex_header_is_checked_in_gzip_and_grok_is_explicitly_unsupported() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let original = dir.path().join("codex/2026/11/05/rollout-sample.jsonl");
    write_log(&PathBuf::from(format!("{}.gz", original.display())), KIND_CODEX, "sample-session", "sample");
    assert_eq!(load_paths(KIND_CODEX, "sample-session", false, &[original], &cfg).unwrap().messages[0].text, "sample");
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    let error = load(&conn, KIND_GROK, "sample-session", &cfg).unwrap_err();
    assert_eq!(error.code, "unsupported_kind");
    assert!(!error.retryable);
}

#[test]
fn transcript_child_paths_require_a_child_request_and_matching_source_identity() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let path = dir.path().join("source/project/parent-session/subagents/agent-sample.jsonl.gz");
    write_log(&path, KIND_CLAUDE, "parent-session", "child");
    let (id, _, child) = crate::ailog::parse_claude::source_identity(&path, "parent-session");
    assert!(child);
    assert!(identity_matches(KIND_CLAUDE, &id, true, &path).unwrap());
    assert!(!identity_matches(KIND_CLAUDE, "parent-session", false, &path).unwrap());
    assert!(candidates(KIND_CLAUDE, &[path.clone()], false, &cfg).is_empty());
    let wrong = dir.path().join("source/project/parent-session/subagents/agent-wrong.jsonl.gz");
    write_log(&wrong, KIND_CLAUDE, "unrelated-parent", "wrong");
    let (wrong_id, _, _) = crate::ailog::parse_claude::source_identity(&wrong, "unrelated-parent");
    assert!(!identity_matches(KIND_CLAUDE, &wrong_id, true, &wrong).unwrap());
}

#[test]
fn transcript_gzip_scan_cap_uses_decoded_bytes_and_is_separate_from_display_limit() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("many.jsonl.gz");
    let mut encoder = flate2::write::GzEncoder::new(std::fs::File::create(&path).unwrap(), flate2::Compression::default());
    for _ in 0..205 { encoder.write_all(b"{\"type\":\"user\",\"sessionId\":\"sample\",\"message\":{\"content\":\"sample\"}}\n").unwrap(); }
    encoder.finish().unwrap();
    let stats = crate::ailog::jsonl::for_each_line(&path, crate::ailog::jsonl::Budget { max_bytes: 1024 * 1024, max_lines: 100 }, |_| std::ops::ControlFlow::Continue(())).unwrap();
    assert!(stats.bytes_read > stats.file_bytes);
    assert!(stats.scan_truncated);
    let report = super::extract_path(KIND_CLAUDE, &path).unwrap();
    assert!(report.truncated);
    assert_eq!(report.omitted_count, 5);
    assert!(!report.scan_truncated);
    assert_eq!(READ_TIMEOUT, std::time::Duration::from_secs(8));
}

#[test]
fn transcript_corrupt_gzip_is_a_permanent_reason() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let path = dir.path().join("source/project/sample.jsonl.gz");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, b"invalid gzip bytes").unwrap();
    let error = load_paths(KIND_CLAUDE, "sample", false, &[path], &cfg).unwrap_err();
    assert_eq!(error.code, "invalid_record");
    assert!(!error.retryable);
}


const UUID_A: &str = "12345678-1234-4234-8234-123456789abc";
const UUID_B: &str = "87654321-4321-4321-8321-cba987654321";

fn legacy_codex_source(root: &Path) -> (PathBuf, String) {
    (root.join(format!("codex/2026/08/24/rollout-2026-08-24T13-03-20-{UUID_A}.jsonl")),
        format!("08-24T13-03-20-{UUID_A}"))
}

#[test]
fn round2_001_codex_legacy_indexed_original_remains_readable() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let (path, expected) = legacy_codex_source(dir.path());
    // The indexed binding remains authoritative even after a copied header.
    write_log(&path, KIND_CODEX, UUID_B, "legacy original");
    assert_eq!(load_paths(KIND_CODEX, &expected, false, &[path], &cfg).unwrap().messages[0].text, "legacy original");
}

#[test]
fn round2_001_codex_legacy_recovers_from_only_full_text() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let (path, expected) = legacy_codex_source(dir.path());
    let target = recovery_path(&cfg, cfg.full_text.as_ref().unwrap(), KIND_CODEX, &path);
    write_log(&target, KIND_CODEX, UUID_A, "legacy mirror");
    assert_eq!(load_paths(KIND_CODEX, &expected, false, &[path], &cfg).unwrap().messages[0].text, "legacy mirror");
}

#[test]
fn round2_001_codex_legacy_rejects_different_payload_id_in_full_text() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let (path, expected) = legacy_codex_source(dir.path());
    let target = recovery_path(&cfg, cfg.full_text.as_ref().unwrap(), KIND_CODEX, &path);
    write_log(&target, KIND_CODEX, UUID_B, "wrong mirror");
    let error = load_paths(KIND_CODEX, &expected, false, &[path], &cfg).unwrap_err();
    assert_eq!(error.code, "identity_mismatch");
}

#[test]
fn round2_001_claude_copied_header_indexed_original_remains_readable() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let path = dir.path().join(format!("source/project/{UUID_A}.jsonl"));
    write_log(&path, KIND_CLAUDE, UUID_B, "copied original");
    assert_eq!(load_paths(KIND_CLAUDE, UUID_A, false, &[path], &cfg).unwrap().messages[0].text, "copied original");
}

#[test]
fn round2_001_claude_copied_header_recovers_from_only_full_text() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let path = dir.path().join(format!("source/project/{UUID_A}.jsonl"));
    let target = recovery_path(&cfg, cfg.full_text.as_ref().unwrap(), KIND_CLAUDE, &path);
    write_log(&target, KIND_CLAUDE, UUID_B, "copied mirror");
    assert_eq!(load_paths(KIND_CLAUDE, UUID_A, false, &[path], &cfg).unwrap().messages[0].text, "copied mirror");
}

#[test]
fn round2_001_claude_rejects_a_full_text_filename_for_another_session() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let path = dir.path().join(format!("source/project/{UUID_B}.jsonl"));
    let target = recovery_path(&cfg, cfg.full_text.as_ref().unwrap(), KIND_CLAUDE, &path);
    write_log(&target, KIND_CLAUDE, UUID_A, "wrong filename");
    assert_eq!(load_paths(KIND_CLAUDE, UUID_A, false, &[path], &cfg).unwrap_err().code, "identity_mismatch");
}

#[test]
fn round2_007_busy_is_not_timeout_and_retains_stalled_reader_details() {
    let reader = TranscriptReader::new();
    let guard = reader.acquire().unwrap();
    let error = reader.acquire().unwrap_err();
    assert_eq!(error.code, "busy");
    assert!(error.retryable);
    assert_eq!(error.message, "別の会話を読み込み中です。終わってから再試行してください。");
    assert!(!error.technical.contains("exceeded"));
    guard.timeout_marker().store(true, std::sync::atomic::Ordering::Release);
    let stalled = reader.acquire().unwrap_err();
    assert_eq!(stalled.code, "busy");
    assert!(stalled.technical.contains("still running"));
    drop(guard);
    assert!(reader.acquire().is_ok());
}

#[test]
fn round2_010_incomplete_gzip_is_transient_and_retryable() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let path = dir.path().join("source/project/partial.jsonl.gz");
    write_log(&path, KIND_CLAUDE, "partial", "syncing fixture");
    let bytes = std::fs::read(&path).unwrap();
    std::fs::write(&path, &bytes[..bytes.len()-6]).unwrap();
    let error = load_paths(KIND_CLAUDE, "partial", false, &[path], &cfg).unwrap_err();
    assert!(error.technical.to_ascii_lowercase().contains("unexpected end of file"));
    assert!(error.retryable);
}

#[test]
fn round2_013_unreadable_settings_do_not_block_an_indexed_original() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sample.jsonl");
    write_log(&path, KIND_CLAUDE, "sample", "local fixture");
    let cfg = SourceConfig::from_settings(Err("fixture settings unavailable".into()));
    assert!(cfg.full_text.is_none());
    assert_eq!(load_paths(KIND_CLAUDE, "sample", false, &[path], &cfg).unwrap().messages[0].text, "local fixture");
}

#[test]
fn l5_transcript_recovery_roots_reject_directory_links_outside() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let escaped = dir.path().join(format!("source/escaped/{UUID_A}.jsonl"));
    let ordinary = dir.path().join(format!("source/project/{UUID_B}.jsonl"));
    for (index, tier) in [cfg.archive.as_ref().unwrap(), cfg.full_text.as_ref().unwrap()].iter().enumerate() {
        let outside = dir.path().join(format!("outside-{index}"));
        write_log(&outside.join(format!("{UUID_A}.jsonl.gz")), KIND_CLAUDE, UUID_A, "outside fixture");
        std::fs::create_dir_all(tier.join(KIND_CLAUDE)).unwrap();
        link_directory(&outside, &tier.join(KIND_CLAUDE).join("escaped"));
        let safe = recovery_path(&cfg, tier, KIND_CLAUDE, &ordinary);
        write_log(&safe, KIND_CLAUDE, UUID_B, "inside fixture");
        let actual = candidates(KIND_CLAUDE, &[escaped.clone(), ordinary.clone()], false, &cfg);
        assert!(!actual.contains(&recovery_path(&cfg, tier, KIND_CLAUDE, &escaped)));
        assert!(actual.contains(&safe));
    }
    assert_eq!(load_paths(KIND_CLAUDE, UUID_A, false, &[escaped], &cfg).unwrap_err().code, "not_found");
    assert_eq!(load_paths(KIND_CLAUDE, UUID_B, false, &[ordinary], &cfg).unwrap().messages[0].text, "inside fixture");
}

#[test]
fn l5_transcript_claude_fallback_reads_plain_and_gzip_without_other_sources() {
    for compressed in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = config(dir.path());
        cfg.claude_fallback = Some(dir.path().join("fallback"));
        let original = dir.path().join(format!("source/project/{UUID_A}.jsonl"));
        let name = format!("project/{UUID_A}.jsonl{}", if compressed { ".gz" } else { "" });
        let target = cfg.claude_fallback.as_ref().unwrap().join(name);
        write_log(&target, KIND_CLAUDE, UUID_A, "fallback fixture");
        assert!(candidates(KIND_CLAUDE, &[original.clone()], false, &cfg).contains(&target));
        assert_eq!(load_paths(KIND_CLAUDE, UUID_A, false, &[original], &cfg).unwrap().messages[0].text, "fallback fixture");
    }
}

#[test]
fn l5_transcript_candidates_keep_fallback_between_original_gzip_and_archive() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(dir.path());
    cfg.claude_fallback = Some(dir.path().join("fallback"));
    let paths = [dir.path().join(format!("source/project/{UUID_A}.jsonl")),
        dir.path().join(format!("source/project/{UUID_B}.jsonl"))];
    let mut expected = paths.to_vec();
    expected.extend(paths.iter().map(|p| PathBuf::from(format!("{}.gz", p.display()))));
    for path in &paths {
        let relative = path.strip_prefix(dir.path().join("source")).unwrap();
        let fallback = cfg.claude_fallback.as_ref().unwrap().join(relative);
        expected.push(fallback.clone());
        expected.push(PathBuf::from(format!("{}.gz", fallback.display())));
    }
    for tier in [cfg.archive.as_ref().unwrap(), cfg.full_text.as_ref().unwrap()] {
        for path in &paths { expected.push(recovery_path(&cfg, tier, KIND_CLAUDE, path)); }
    }
    for path in &expected { write_log(path, KIND_CLAUDE, UUID_A, "order fixture"); }
    assert_eq!(candidates(KIND_CLAUDE, &paths, false, &cfg), expected);
}

#[test]
fn l5_transcript_fallback_is_not_used_for_codex_or_claude_codex() {
    for kind in [KIND_CODEX, KIND_CLAUDE_CODEX] {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = config(dir.path());
        cfg.claude_fallback = Some(dir.path().join("fallback"));
        let root = &cfg.roots.iter().find(|(source_kind, _)| source_kind == kind).unwrap().1;
        let original = root.join(format!("project/{UUID_A}.jsonl"));
        let fallback = cfg.claude_fallback.as_ref().unwrap().join(format!("project/{UUID_A}.jsonl"));
        let gzip = PathBuf::from(format!("{}.gz", fallback.display()));
        for path in [&fallback, &gzip] { write_log(path, kind, UUID_A, "wrong kind fixture"); }
        let actual = candidates(kind, &[original.clone()], false, &cfg);
        assert!(!actual.contains(&fallback));
        assert!(!actual.contains(&gzip));
        assert_eq!(load_paths(kind, UUID_A, false, &[original], &cfg).unwrap_err().code, "not_found");
    }
}

#[test]
fn l5_transcript_claude_fallback_rejects_directory_links_outside() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(dir.path());
    let fallback = dir.path().join("fallback");
    cfg.claude_fallback = Some(fallback.clone());
    std::fs::create_dir_all(&fallback).unwrap();
    let outside = dir.path().join("outside");
    for extension in [".jsonl", ".jsonl.gz"] {
        write_log(&outside.join(format!("{UUID_A}{extension}")), KIND_CLAUDE, UUID_A, "outside fixture");
    }
    link_directory(&outside, &fallback.join("escaped"));
    let original = dir.path().join(format!("source/escaped/{UUID_A}.jsonl"));
    assert_eq!(candidates(KIND_CLAUDE, &[original.clone()], false, &cfg).len(), 2);
    assert_eq!(load_paths(KIND_CLAUDE, UUID_A, false, &[original], &cfg).unwrap_err().code, "not_found");
    let safe_original = dir.path().join(format!("source/safe/{UUID_B}.jsonl"));
    write_log(&fallback.join(format!("safe/{UUID_B}.jsonl")), KIND_CLAUDE, UUID_B, "safe fallback");
    assert_eq!(load_paths(KIND_CLAUDE, UUID_B, false, &[safe_original], &cfg).unwrap().messages[0].text, "safe fallback");
}

#[test]
fn l5_transcript_settings_trim_both_roots_and_ignore_empty_or_unreadable_settings() {
    let cfg = SourceConfig::from_settings(Ok((Some(" full ".into()), Some(" fallback ".into()))));
    assert_eq!(cfg.full_text, Some(PathBuf::from("full")));
    assert_eq!(cfg.claude_fallback, Some(PathBuf::from("fallback")));
    let empty = SourceConfig::from_settings(Ok((Some("  ".into()), Some("\t".into()))));
    assert!(empty.full_text.is_none() && empty.claude_fallback.is_none());
    let failed = SourceConfig::from_settings(Err("synthetic settings failure".into()));
    assert!(failed.full_text.is_none() && failed.claude_fallback.is_none());
}

#[test]
fn l5_transcript_missing_recovery_roots_are_skipped_and_originals_still_read() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let original = dir.path().join(format!("source/project/{UUID_A}.jsonl"));
    assert_eq!(candidates(KIND_CLAUDE, &[original.clone()], false, &cfg).len(), 2);
    write_log(&original, KIND_CLAUDE, UUID_A, "local fixture");
    assert_eq!(load_paths(KIND_CLAUDE, UUID_A, false, &[original], &cfg).unwrap().messages[0].text, "local fixture");
}

#[cfg(unix)]
struct RestoreMode(PathBuf);
#[cfg(unix)]
impl Drop for RestoreMode {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
    }
}

#[cfg(unix)]
#[test]
fn l5_transcript_unreadable_recovery_folder_reports_access_denied_not_not_found() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let original = dir.path().join(format!("source/project/{UUID_A}.jsonl"));
    let full_copy = recovery_path(&cfg, cfg.full_text.as_ref().unwrap(), KIND_CLAUDE, &original);
    let folder = full_copy.parent().unwrap().to_path_buf();
    std::fs::create_dir_all(&folder).unwrap();
    let _restore = RestoreMode(folder.clone());
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o000)).unwrap();
    let error = load_paths(KIND_CLAUDE, UUID_A, false, &[original], &cfg).unwrap_err();
    assert_eq!(error.code, "access_denied");
    assert!(!error.retryable);
}
