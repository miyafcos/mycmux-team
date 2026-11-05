//! Ordered, identity-checked transcript recovery. No author-specific locations.
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use serde::Serialize;
use rusqlite::{Connection, OptionalExtension};
use crate::ailog::{KIND_CLAUDE, KIND_CLAUDE_CODEX, KIND_CODEX};
use super::TranscriptReport;

pub const READ_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptError {
    pub code: &'static str,
    pub retryable: bool,
    pub message: &'static str,
    pub technical: String,
}

impl TranscriptError {
    pub fn temporary(technical: impl Into<String>) -> Self {
        Self { code: "temporarily_unavailable", retryable: true,
            message: "会話の記録を一時的に読めません。時間をおいて再試行してください。", technical: technical.into() }
    }
    pub fn busy(timed_out: bool) -> Self {
        Self { code: "busy", retryable: true,
            message: "別の会話を読み込み中です。終わってから再試行してください。",
            technical: if timed_out { "A previous blocking transcript read exceeded 8 seconds and is still running." } else { "Another transcript reader is active." }.into() }
    }
    pub fn timeout() -> Self {
        Self { code: "timeout", retryable: true, message: "控えの読み込みに時間がかかっています。時間をおいて再試行してください。",
            technical: "Transcript read exceeded 8 seconds; the blocking reader is still bounded to one worker.".into() }
    }
}

#[derive(Debug)]
pub struct TranscriptReader {
    active: std::sync::Mutex<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>>,
}

#[derive(Debug)]
pub struct TranscriptReadGuard<'a> {
    reader: &'a TranscriptReader,
    timed_out: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl TranscriptReader {
    pub const fn new() -> Self { Self { active: std::sync::Mutex::new(None) } }
    pub fn acquire(&self) -> Result<TranscriptReadGuard<'_>, TranscriptError> {
        let mut active = self.active.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(timed_out) = active.as_ref() {
            return Err(TranscriptError::busy(timed_out.load(std::sync::atomic::Ordering::Acquire)));
        }
        let timed_out = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        *active = Some(std::sync::Arc::clone(&timed_out));
        Ok(TranscriptReadGuard { reader: self, timed_out })
    }
}
impl TranscriptReadGuard<'_> {
    pub fn timeout_marker(&self) -> std::sync::Arc<std::sync::atomic::AtomicBool> {
        std::sync::Arc::clone(&self.timed_out)
    }
}
impl Drop for TranscriptReadGuard<'_> {
    fn drop(&mut self) {
        self.reader.active.lock().unwrap_or_else(|error| error.into_inner()).take();
    }
}

pub struct SourceConfig {
    pub roots: Vec<(String, PathBuf)>,
    pub archive: Option<PathBuf>,
    pub full_text: Option<PathBuf>,
}

impl SourceConfig {
    pub fn from_full_text_setting(setting: Result<Option<String>, String>) -> Self {
        Self::configured(setting.ok().flatten()
            .and_then(|root| (!root.trim().is_empty()).then(|| PathBuf::from(root.trim()))))
    }
    pub fn configured(full_text: Option<PathBuf>) -> Self {
        let roots = [
            (KIND_CLAUDE, crate::ailog::claude_root()),
            (KIND_CLAUDE_CODEX, crate::ailog::claude_codex_root()),
            (KIND_CODEX, crate::ailog::codex_root()),
        ].into_iter().filter_map(|(kind, root)| root.map(|root| (kind.to_string(), root))).collect();
        Self { roots, archive: crate::ailog::archive_root(), full_text }
    }
}

fn gzip_path(path: &Path) -> PathBuf {
    if path.extension().is_some_and(|ext| ext == "gz") { return path.to_path_buf(); }
    let mut name = path.as_os_str().to_os_string();
    name.push(".gz");
    PathBuf::from(name)
}

fn child_source(path: &Path) -> bool {
    let normalized = path.to_string_lossy().replace('\\', "/");
    normalized.split('/').any(|part| part == "subagents")
        || path.file_name().is_some_and(|name| name.to_string_lossy().starts_with("agent-"))
}

/// Four tiers, not four probes per file: all indexed originals precede any gzip.
pub fn candidates(kind: &str, paths: &[PathBuf], child: bool, config: &SourceConfig) -> Vec<PathBuf> {
    let sources: Vec<_> = paths.iter().filter(|path| child || !child_source(path)).collect();
    let mut out: Vec<PathBuf> = sources.iter().map(|path| (*path).clone()).collect();
    out.extend(sources.iter().map(|path| gzip_path(path)));
    for tier in [&config.archive, &config.full_text].into_iter().flatten() {
        for path in &sources {
            for (_, root) in config.roots.iter().filter(|(source_kind, _)| source_kind == kind) {
                if let Ok(relative) = path.strip_prefix(root) {
                    if relative.components().any(|part| matches!(part, std::path::Component::ParentDir)) { continue; }
                    out.push(gzip_path(&tier.join(kind).join(relative)));
                }
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|path| seen.insert(path.clone()));
    out
}

/// Read only a bounded header. The first identity is authoritative; a later
/// matching record must never excuse a mismatching header.
pub fn identity_matches(kind: &str, expected: &str, child: bool, path: &Path) -> Result<bool, String> {
    let mut matches = false;
    crate::ailog::jsonl::for_each_line(path, crate::ailog::jsonl::Budget { max_bytes: 1024 * 1024, max_lines: 32 }, |line| {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else { return std::ops::ControlFlow::Continue(()); };
        let native = if kind == KIND_CODEX {
            if value.get("type").and_then(|v| v.as_str()) == Some("session_meta") {
                value.pointer("/payload/id").and_then(|v| v.as_str())
            } else { None }
        } else {
            value.get("sessionId").or_else(|| value.get("session_id")).and_then(|v| v.as_str())
        };
        let Some(native) = native else { return std::ops::ControlFlow::Continue(()); };
        matches = if child_source(path) {
            if !child || kind == KIND_CODEX { false } else {
                let (id, _, is_child) = crate::ailog::parse_claude::source_identity(path, native);
                let normalized = path.to_string_lossy().replace('\\', "/");
                let parts: Vec<_> = normalized.split('/').collect();
                let root_parent = parts.iter().position(|part| *part == "subagents").and_then(|index| index.checked_sub(1)).map(|index| parts[index]);
                is_child && id == expected && root_parent.map_or(true, |parent| parent == native)
            }
        } else if kind == KIND_CODEX {
            let logical = if path.extension().is_some_and(|ext| ext == "gz") { path.with_extension("") } else { path.to_path_buf() };
            let stem = logical.file_stem().and_then(|stem| stem.to_str()).unwrap_or_default();
            native == expected || crate::ailog::parse_codex::standard_rollout_filename_uuid(stem)
                .is_some_and(|uuid| crate::ailog::parse_codex::is_legacy_compat_source(expected, uuid) && native == uuid)
        } else {
            crate::ailog::parse_claude::source_identity(path, native).0 == expected
        };
        std::ops::ControlFlow::Break(())
    })?;
    Ok(matches)
}

pub fn load(conn: &Connection, kind: &str, session_id: &str, config: &SourceConfig) -> Result<TranscriptReport, TranscriptError> {
    if ![KIND_CLAUDE, KIND_CLAUDE_CODEX, KIND_CODEX].contains(&kind) {
        return Err(TranscriptError { code: "unsupported_kind", retryable: false,
            message: "この種類の会話は、本文の表示に対応していません。使用量の集計は確認できます。", technical: format!("Unsupported transcript kind: {kind}") });
    }
    let mut statement = conn.prepare("SELECT path FROM source_file WHERE kind=?1 AND session_id=?2 ORDER BY last_indexed DESC, path ASC")
        .map_err(|error| TranscriptError::temporary(error.to_string()))?;
    let paths = statement.query_map(rusqlite::params![kind, session_id], |row| row.get::<_, String>(0))
        .map_err(|error| TranscriptError::temporary(error.to_string()))?
        .map(|row| row.map(PathBuf::from)).collect::<Result<Vec<_>, _>>()
        .map_err(|error| TranscriptError::temporary(error.to_string()))?;
    let child = conn.query_row("SELECT is_sidechain<>0 OR relationship_type='subagent' FROM session WHERE kind=?1 AND session_id=?2",
        rusqlite::params![kind, session_id], |row| row.get::<_, bool>(0)).optional()
        .map_err(|error| TranscriptError::temporary(error.to_string()))?.unwrap_or(false);
    load_paths(kind, session_id, child, &paths, config)
}

pub fn load_paths(kind: &str, session_id: &str, child: bool, paths: &[PathBuf], config: &SourceConfig) -> Result<TranscriptReport, TranscriptError> {
    let deadline = Instant::now() + READ_TIMEOUT;
    let candidates = candidates(kind, paths, child, config);
    let mut io_error = None;
    let mut wrong_identity = false;
    let mut denied = false;
    let mut corrupt = false;
    let mut empty_report = None;
    for path in &candidates {
        if Instant::now() >= deadline { return Err(TranscriptError::timeout()); }
        match path.try_exists() {
            Ok(false) => continue,
            Err(error) => { denied |= error.kind() == std::io::ErrorKind::PermissionDenied; io_error = Some(error.to_string()); continue; }
            Ok(true) => {}
        }
        // The indexed path itself is trusted, as before recovery was added.
        // Only alternatives need the same source identity rules as the indexer.
        if !paths.contains(path) {
            match identity_matches(kind, session_id, child, path) {
                Ok(false) => { wrong_identity = true; continue; }
                Err(error) => { denied |= permission_error(&error); corrupt |= corrupt_error(&error); io_error = Some(error); continue; }
                Ok(true) => {}
            }
        }
        if Instant::now() >= deadline { return Err(TranscriptError::timeout()); }
        match super::extract_path(kind, path) {
            Ok(report) if !report.messages.is_empty() => return Ok(report),
            Ok(report) => { empty_report = Some(report); }
            Err(error) => { denied |= permission_error(&error); corrupt |= corrupt_error(&error); io_error = Some(error); }
        }
    }
    if let Some(report) = empty_report { return Ok(report); }
    if denied || corrupt {
        return Err(TranscriptError {
            code: if denied { "access_denied" } else { "invalid_record" }, retryable: false,
            message: if denied { "会話の記録を開く権限がありません。保存場所のアクセス権を確認してください。" } else { "会話の控えを読み取れませんでした。ファイルの状態を確認してください。" },
            technical: io_error.unwrap_or_default(),
        });
    }
    if let Some(error) = io_error { return Err(TranscriptError::temporary(error)); }
    Err(TranscriptError { code: if wrong_identity { "identity_mismatch" } else { "not_found" }, retryable: false,
        message: if wrong_identity { "控えは見つかりましたが、選んだ会話の記録と確認できませんでした。" } else { "この会話の元の記録と控えが見つかりません。使用量の集計は残っています。" },
        technical: format!("Checked {} known locations; identity mismatch: {wrong_identity}", candidates.len()) })
}

fn permission_error(error: &str) -> bool {
    let text = error.to_ascii_lowercase();
    text.contains("permission denied") || text.contains("access is denied") || text.contains("os error 5") || text.contains("os error 13")
}

fn corrupt_error(error: &str) -> bool {
    let text = error.to_ascii_lowercase();
    !text.contains("unexpected end of file") && (text.contains("invalid gzip") || text.contains("corrupt") || text.contains("invalid checksum"))
}
