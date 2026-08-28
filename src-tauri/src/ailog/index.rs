//! Incremental indexer.
//!
//! Transcripts are append-only, so a file whose size has not moved since the
//! last run is skipped outright and a file that grew is read from
//! `parsed_bytes` onward. A file that *shrank* is treated as rotated and
//! re-read from zero.
//!
//! Parsing fans out across `spawn_blocking` workers; every database write goes
//! through a single writer task that owns the only `Connection`. No connection
//! is ever shared between threads.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Instant, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;

use crate::ailog::metrics::{self, ToolClass};
use crate::ailog::price::{self, PriceTable};
use crate::ailog::rollup;
use crate::ailog::{
    parse_claude, parse_codex, parse_grok, project_rules, ChunkData, SessionChunk, ToolRow,
    KIND_CLAUDE, KIND_CLAUDE_CODEX, KIND_CODEX, KIND_GROK,
};
use parse_codex::SessionBehavior;

/// Minimum gap between progress events, per spec §5.
pub const PROGRESS_THROTTLE_MS: u128 = 250;
const DERIVATION_VERSION: &str = "project-work-v2";
const CODEX_PARSE_STATE_PREFIX: &str = "codex_ps:";
const PREFIX_FINGERPRINT_LEN: usize = 4096;
const FINGERPRINT_READ_CHUNK: usize = 64 * 1024;
const REVERSE_WINDOW: u64 = 1024 * 1024;
const HISTORICAL_REPAIR_PENDING: &str =
    "historical repair pending: shared Codex source requires a destructive reset";

#[cfg(test)]
pub(crate) fn default_roots_for_test() -> Vec<(&'static str, PathBuf)> {
    default_roots()
}

#[derive(Debug, Clone)]
pub struct IndexOptions {
    /// Re-read every file from byte zero and discard the existing rows.
    pub full: bool,
    /// `(kind, root)` pairs. Empty means the two default roots.
    pub roots: Vec<(&'static str, PathBuf)>,
    /// Optional immutable gzip archive root. Defaults to `~/.mycmux/ailog-archive`
    /// only when indexing the normal default roots.
    pub archive_root: Option<PathBuf>,
    pub db_path: PathBuf,
}

impl IndexOptions {
    pub fn new(db_path: PathBuf) -> Self {
        Self {
            full: false,
            roots: Vec::new(),
            archive_root: None,
            db_path,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgress {
    pub phase: String,
    pub files_done: usize,
    pub files_total: usize,
    pub sessions: usize,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexPhaseTimings {
    /// Source-file discovery plus the incremental-state lookup.
    pub scan_ms: u64,
    /// Wall-clock time spent waiting for parse workers. This overlaps database
    /// writes because the single writer consumes completed chunks concurrently.
    pub parse_ms: u64,
    /// Time spent applying parsed chunks to SQLite, excluding final derivation.
    pub db_write_ms: u64,
    /// Time spent recomputing touched sessions and final index metadata.
    pub post_process_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexReport {
    pub files_total: usize,
    pub files_done: usize,
    pub files_skipped: usize,
    pub sessions: usize,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub elapsed_ms: u64,
    pub timings: IndexPhaseTimings,
    pub cancelled: bool,
    pub errors: Vec<String>,
}

pub type ProgressSink = Arc<dyn Fn(IndexProgress) + Send + Sync>;

#[derive(Debug, Clone)]
struct FileJob {
    path: PathBuf,
    kind: &'static str,
    size: u64,
    mtime_ns: i64,
    /// Archives are immutable gzip streams and always parse from byte zero.
    archive: bool,
    /// Byte offset to resume from; 0 for a full read.
    start: u64,
    reset: bool,
    /// True when a `source_file` row already exists for this path.
    had_previous: bool,
    /// Stored session id, used for legacy-compat identity and unshared reset.
    stored_session_id: Option<String>,
    /// Persisted Codex model/effort at `start`, when the fingerprint matches.
    codex_seed: Option<parse_codex::CodexParseState>,
    /// Rolling fingerprint of the already-consumed Codex prefix.
    codex_content_fp: Option<String>,
    /// True when the parser state came from a fingerprint-verified checkpoint.
    /// A missing model/effort in trusted state is an observed absence, not a
    /// reason to rescan the complete prefix on every append.
    codex_seed_trusted: bool,
    /// Refresh only source metadata after a same-size content match.
    metadata_only: bool,
    /// Skip parse/write of session rows and record this source error instead.
    block_reason: Option<String>,
}

enum WriteMsg {
    Metadata {
        job_path: String,
        size: u64,
        mtime_ns: i64,
    },
    Chunk {
        job_path: String,
        kind: &'static str,
        size: u64,
        mtime_ns: i64,
        archive: bool,
        start: u64,
        reset: bool,
        had_previous: bool,
        stored_session_id: Option<String>,
        data: ChunkData,
        codex_end_state: Option<parse_codex::CodexParseState>,
        content_fp: Option<String>,
    },
    Failed {
        job_path: String,
        kind: &'static str,
        size: u64,
        mtime_ns: i64,
        message: String,
    },
}

#[derive(Debug, Clone)]
struct PersistedCodex {
    at: u64,
    state: parse_codex::CodexParseState,
    prefix_fp: Option<String>,
    boundary_fp: Option<String>,
    content_fp: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FingerprintStatus {
    Match,
    Mismatch,
    Unknown,
}

/// Walk a directory tree collecting `*.jsonl` files.
///
/// Grok keeps several telemetry JSONL files beside `updates.jsonl`; callers
/// pass `Some("updates.jsonl")` for that root so telemetry never becomes a
/// second transcript source.
fn collect_jsonl(root: &Path, out: &mut Vec<PathBuf>, file_name: Option<&str>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(file_type) if file_type.is_dir() => collect_jsonl(&path, out, file_name),
            Ok(file_type) if file_type.is_file() => {
                if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl")
                    && file_name.map_or(true, |name| {
                        path.file_name().and_then(|v| v.to_str()) == Some(name)
                    })
                {
                    out.push(path);
                }
            }
            _ => {}
        }
    }
}

/// Walk an immutable archive kind directory collecting `*.jsonl.gz` files.
pub(crate) fn collect_archive_jsonl(root: &Path, out: &mut Vec<PathBuf>, file_name: Option<&str>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(file_type) if file_type.is_dir() => collect_archive_jsonl(&path, out, file_name),
            Ok(file_type) if file_type.is_file() => {
                let is_jsonl_gz = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with(".jsonl.gz"));
                if is_jsonl_gz
                    && file_name.map_or(true, |name| {
                        path.file_name()
                            .and_then(|value| value.to_str())
                            .is_some_and(|value| value == format!("{name}.gz"))
                    })
                {
                    out.push(path);
                }
            }
            _ => {}
        }
    }
}

fn live_root_for_kind(kind: &str) -> Option<PathBuf> {
    match kind {
        KIND_CLAUDE => crate::ailog::claude_root(),
        KIND_CLAUDE_CODEX => crate::ailog::claude_codex_root(),
        KIND_CODEX => crate::ailog::codex_root(),
        KIND_GROK => crate::ailog::grok_root(),
        _ => None,
    }
}

fn archive_original_path(archive_kind_root: &Path, archive_path: &Path, live_root: &Path) -> Option<PathBuf> {
    let relative = archive_path.strip_prefix(archive_kind_root).ok()?;
    let name = relative.file_name()?.to_str()?.strip_suffix(".gz")?;
    let mut original_relative = relative.to_path_buf();
    original_relative.set_file_name(name);
    Some(live_root.join(original_relative))
}

fn mtime_nanos(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|delta| delta.as_nanos().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn default_roots() -> Vec<(&'static str, PathBuf)> {
    let mut roots = Vec::new();
    if let Some(path) = crate::ailog::claude_root() {
        roots.push((KIND_CLAUDE, path));
    }
    if let Some(path) = crate::ailog::codex_root() {
        roots.push((KIND_CODEX, path));
    }
    if let Some(path) = crate::ailog::grok_root() {
        roots.push((KIND_GROK, path));
    }
    roots
}

/// Run one indexing pass. Returns once every file has been written or the
/// cancel flag has been observed.
pub async fn run_index(
    options: IndexOptions,
    cancel: Arc<AtomicBool>,
    progress: Option<ProgressSink>,
) -> Result<IndexReport, String> {
    let started = Instant::now();
    let scan_started = Instant::now();
    let using_default_roots = options.roots.is_empty();
    let roots = if using_default_roots {
        default_roots()
    } else {
        options.roots.clone()
    };

    // --- discovery -------------------------------------------------------
    let mut known: HashMap<String, (u64, i64, u64, Option<String>)> = HashMap::new();
    let mut persisted_codex: HashMap<String, PersistedCodex> = HashMap::new();
    let mut session_sources: HashMap<(String, String), usize> = HashMap::new();
    {
        let mut conn = crate::ailog::open_db(&options.db_path)?;
        if options.full {
            clear_all(&mut conn)?;
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT path, kind, size_bytes, mtime_ns, parsed_bytes, session_id FROM source_file",
                )
                .map_err(|err| format!("prepare source_file: {err}"))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)? as u64,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)? as u64,
                        row.get::<_, Option<String>>(5)?,
                    ))
                })
                .map_err(|err| format!("query source_file: {err}"))?;
            for row in rows {
                let (path, kind, size, mtime, parsed, session_id) =
                    row.map_err(|err| format!("row: {err}"))?;
                if let Some(session_id) = &session_id {
                    *session_sources
                        .entry((kind, session_id.clone()))
                        .or_default() += 1;
                }
                known.insert(path, (size, mtime, parsed, session_id));
            }
            persisted_codex = load_persisted_codex_states(&conn)?;
        }
    }

    let mut jobs: Vec<FileJob> = Vec::new();
    let mut skipped = 0usize;
    let mut bytes_total = 0u64;
    for (kind, root) in &roots {
        let mut files = Vec::new();
        collect_jsonl(
            root,
            &mut files,
            (*kind == KIND_GROK).then_some("updates.jsonl"),
        );
        for path in files {
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            let size = meta.len();
            let mtime_ns = mtime_nanos(&meta);
            let key = path.to_string_lossy().to_string();
            let previous = known.get(&key).cloned();
            let job = plan_file_job(
                *kind,
                path,
                size,
                mtime_ns,
                previous,
                persisted_codex.get(&key),
                &session_sources,
            );
            match job {
                PlannedJob::Skip => {
                    skipped += 1;
                }
                PlannedJob::Run(file_job) => {
                    bytes_total += file_job.size.saturating_sub(file_job.start);
                    jobs.push(file_job);
                }
            }
        }
    }
    let configured_archive_root = options.archive_root.clone().or_else(|| {
        using_default_roots.then(crate::ailog::archive_root).flatten()
    });
    if let Some(archive_root) = configured_archive_root.filter(|path| path.is_dir()) {
        let configured_live_roots: HashMap<&str, &PathBuf> = roots
            .iter()
            .map(|(kind, root)| (*kind, root))
            .collect();
        for kind in [KIND_CLAUDE, KIND_CLAUDE_CODEX, KIND_CODEX, KIND_GROK] {
            let Some(live_root) = configured_live_roots
                .get(kind)
                .map(|path| (*path).clone())
                .or_else(|| live_root_for_kind(kind)) else {
                continue;
            };
            let archive_kind_root = archive_root.join(kind);
            let mut files = Vec::new();
            collect_archive_jsonl(
                &archive_kind_root,
                &mut files,
                (kind == KIND_GROK).then_some("updates.jsonl"),
            );
            for path in files {
                let Some(original_path) = archive_original_path(&archive_kind_root, &path, &live_root) else {
                    continue;
                };
                if original_path.exists()
                    || known.contains_key(&original_path.to_string_lossy().to_string())
                {
                    skipped += 1;
                    continue;
                }
                let Ok(meta) = std::fs::metadata(&path) else {
                    continue;
                };
                let size = meta.len();
                let mtime_ns = mtime_nanos(&meta);
                let key = path.to_string_lossy().to_string();
                match plan_archive_job(kind, path, size, mtime_ns, known.get(&key).cloned()) {
                    PlannedJob::Skip => skipped += 1,
                    PlannedJob::Run(file_job) => {
                        bytes_total += file_job.size;
                        jobs.push(file_job);
                    }
                }
            }
        }
    }

    let files_total = jobs.len();
    let scan_ms = scan_started.elapsed().as_millis() as u64;
    let (tx, rx) = mpsc::channel::<WriteMsg>();

    // --- writer ----------------------------------------------------------
    let db_path = options.db_path.clone();
    let writer_progress = progress.clone();
    let writer =
        tokio::task::spawn_blocking(move || -> Result<(usize, Vec<String>, u64, u64), String> {
            let mut conn = crate::ailog::open_db(&db_path)?;
            let prices = PriceTable::load(&conn)?;
            let mut touched: HashSet<(String, String)> = HashSet::new();
            let mut errors = Vec::new();
            let mut db_write_ms = 0u64;

            // Keep the index pass atomic. The prior file-at-a-time transaction
            // made a full initial import pay a journal sync for every JSONL file.
            // The writer remains single-threaded, so readers can still parse in
            // parallel without retaining completed chunks in memory.
            let tx = conn
                .transaction()
                .map_err(|err| format!("begin index transaction: {err}"))?;
            let mut source_file_upsert = tx
                .prepare_cached(
                    "INSERT INTO source_file (path, kind, size_bytes, mtime_ns, parsed_bytes, \
                 parsed_lines, session_id, last_indexed, parse_error) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL) \
                 ON CONFLICT(path) DO UPDATE SET kind=excluded.kind, \
                 size_bytes=excluded.size_bytes, mtime_ns=excluded.mtime_ns, \
                 parsed_bytes=excluded.parsed_bytes, \
                 parsed_lines=CASE WHEN ?9 THEN excluded.parsed_lines \
                   ELSE source_file.parsed_lines + excluded.parsed_lines END, \
                 session_id=COALESCE(excluded.session_id, source_file.session_id), \
                 last_indexed=excluded.last_indexed, \
                 parse_error=CASE WHEN ?9 THEN NULL ELSE source_file.parse_error END",
                )
                .map_err(|err| format!("prepare source_file upsert: {err}"))?;
            let mut source_file_error = tx
                .prepare_cached(
                    "INSERT INTO source_file (path, kind, size_bytes, mtime_ns, parsed_bytes, \
                 parsed_lines, session_id, last_indexed, parse_error) \
                 VALUES (?1, ?2, ?3, ?4, 0, 0, NULL, ?5, ?6) \
                 ON CONFLICT(path) DO UPDATE SET parse_error=excluded.parse_error, \
                 last_indexed=excluded.last_indexed",
                )
                .map_err(|err| format!("prepare source_file error: {err}"))?;
            let mut source_file_metadata = tx
                .prepare_cached(
                    "UPDATE source_file SET size_bytes = ?2, mtime_ns = ?3, last_indexed = ?4 \
                     WHERE path = ?1",
                )
                .map_err(|err| format!("prepare source_file metadata: {err}"))?;

            while let Ok(message) = rx.recv() {
                let write_started = Instant::now();
                match message {
                    WriteMsg::Metadata {
                        job_path,
                        size,
                        mtime_ns,
                    } => {
                        source_file_metadata
                            .execute(params![
                                job_path,
                                size as i64,
                                mtime_ns,
                                chrono::Utc::now().timestamp_millis(),
                            ])
                            .map_err(|err| format!("write source_file metadata: {err}"))?;
                    }
                    WriteMsg::Chunk {
                        job_path,
                        kind,
                        size,
                        mtime_ns,
                        archive,
                        start,
                        reset,
                        had_previous,
                        stored_session_id,
                        data,
                        codex_end_state,
                        content_fp,
                    } => {
                        let destructive_blocked = reset
                            && had_previous
                            && (data.parse_errors > 0
                                || shared_session_blocked(
                                    &tx,
                                    kind,
                                    stored_session_id.as_deref(),
                                    &job_path,
                                )?);
                        if destructive_blocked {
                            let message = if data.parse_errors > 0 {
                                format!(
                                    "complete invalid JSON/UTF-8; refusing destructive reset ({} parse errors)",
                                    data.parse_errors
                                )
                            } else {
                                HISTORICAL_REPAIR_PENDING.to_string()
                            };
                            errors.push(format!("{job_path}: {message}"));
                            source_file_error
                                .execute(params![
                                    job_path,
                                    kind,
                                    size as i64,
                                    mtime_ns,
                                    chrono::Utc::now().timestamp_millis(),
                                    message,
                                ])
                                .map_err(|err| format!("write source_file error: {err}"))?;
                        } else {
                            apply_plain_chunk(
                                &tx,
                                &mut source_file_upsert,
                                &mut touched,
                                job_path,
                                kind,
                                size,
                                mtime_ns,
                                archive,
                                start,
                                reset,
                                stored_session_id,
                                data,
                                codex_end_state,
                                content_fp,
                            )?;
                        }
                    }
                    WriteMsg::Failed {
                        job_path,
                        kind,
                        size,
                        mtime_ns,
                        message,
                    } => {
                        errors.push(format!("{job_path}: {message}"));
                        source_file_error
                            .execute(params![
                                job_path,
                                kind,
                                size as i64,
                                mtime_ns,
                                chrono::Utc::now().timestamp_millis(),
                                message,
                            ])
                            .map_err(|err| format!("write source_file error: {err}"))?;
                    }
                }
                db_write_ms += write_started.elapsed().as_millis() as u64;
            }

            let post_process_started = Instant::now();
            let count = touched.len();
            drop(source_file_metadata);
            drop(source_file_error);
            drop(source_file_upsert);
            for (kind, session_id) in &touched {
                recompute_session(&tx, kind, session_id, &prices)?;
                rollup::mark_session_dirty(&tx, kind, session_id)?;
            }
            let rederived = rederive_projects_and_tags_if_needed(&tx, &prices)?;
            if rederived || !rollup::version_matches(&tx)? {
                rollup::mark_all_dirty(&tx)?;
            }
            if let Some(sink) = &writer_progress {
                sink(IndexProgress {
                    phase: "rollup".to_string(),
                    files_done: files_total,
                    files_total,
                    sessions: count,
                    bytes_done: bytes_total,
                    bytes_total,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                });
            }
            let _rollup_rows = rollup::rebuild_dirty(&tx)?;
            tx.execute(
                "INSERT INTO index_state (key, value) VALUES ('last_finished_at', ?1) \
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![chrono::Utc::now().timestamp_millis().to_string()],
            )
            .map_err(|err| format!("write index_state: {err}"))?;
            tx.commit()
                .map_err(|err| format!("commit finalize: {err}"))?;
            Ok((
                count,
                errors,
                db_write_ms,
                post_process_started.elapsed().as_millis() as u64,
            ))
        });

    // --- readers ---------------------------------------------------------
    let workers = std::thread::available_parallelism()
        .map(|value| value.get().saturating_sub(2).max(1))
        .unwrap_or(1)
        .min(8);
    let semaphore = Arc::new(tokio::sync::Semaphore::new(workers));

    let parse_started = Instant::now();
    let mut handles = Vec::with_capacity(jobs.len());
    let mut cancelled = false;
    for job in jobs {
        if cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        let permit = semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|err| format!("acquire worker permit: {err}"))?;
        let tx = tx.clone();
        handles.push(tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let job_path = job.path.to_string_lossy().to_string();
            let message = if job.metadata_only {
                WriteMsg::Metadata {
                    job_path,
                    size: job.size,
                    mtime_ns: job.mtime_ns,
                }
            } else if let Some(message) = job.block_reason.clone() {
                WriteMsg::Failed {
                    job_path,
                    kind: job.kind,
                    size: job.size,
                    mtime_ns: job.mtime_ns,
                    message,
                }
            } else {
                match read_and_parse(&job) {
                    Ok((data, end_state, actual_start, actual_reset, content_fp)) => WriteMsg::Chunk {
                        job_path,
                        kind: job.kind,
                        size: job.size,
                        mtime_ns: job.mtime_ns,
                        archive: job.archive,
                        start: actual_start,
                        reset: actual_reset,
                        had_previous: job.had_previous,
                        stored_session_id: job.stored_session_id.clone(),
                        data,
                        codex_end_state: end_state,
                        content_fp,
                    },
                    Err(message) => WriteMsg::Failed {
                        job_path,
                        kind: job.kind,
                        size: job.size,
                        mtime_ns: job.mtime_ns,
                        message,
                    },
                }
            };
            let bytes = job.size.saturating_sub(job.start);
            let _ = tx.send(message);
            bytes
        }));
    }
    drop(tx);

    let mut files_done = 0usize;
    let mut bytes_done = 0u64;
    let mut last_emit = Instant::now()
        .checked_sub(std::time::Duration::from_millis(
            PROGRESS_THROTTLE_MS as u64 + 1,
        ))
        .unwrap_or_else(Instant::now);
    for handle in handles {
        let bytes = handle.await.unwrap_or(0);
        files_done += 1;
        bytes_done += bytes;
        if let Some(sink) = &progress {
            if last_emit.elapsed().as_millis() >= PROGRESS_THROTTLE_MS {
                last_emit = Instant::now();
                sink(IndexProgress {
                    phase: "parsing".to_string(),
                    files_done,
                    files_total,
                    sessions: 0,
                    bytes_done,
                    bytes_total,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                });
            }
        }
    }

    let parse_ms = parse_started.elapsed().as_millis() as u64;
    let (sessions, errors, db_write_ms, post_process_ms) = writer
        .await
        .map_err(|err| format!("writer task: {err}"))??;

    let report = IndexReport {
        files_total,
        files_done,
        files_skipped: skipped,
        sessions,
        bytes_done,
        bytes_total,
        elapsed_ms: started.elapsed().as_millis() as u64,
        timings: IndexPhaseTimings {
            scan_ms,
            parse_ms,
            db_write_ms,
            post_process_ms,
        },
        cancelled: cancelled || cancel.load(Ordering::Relaxed),
        errors,
    };
    if let Some(sink) = &progress {
        sink(IndexProgress {
            phase: "done".to_string(),
            files_done: report.files_done,
            files_total: report.files_total,
            sessions: report.sessions,
            bytes_done: report.bytes_done,
            bytes_total: report.bytes_total,
            elapsed_ms: report.elapsed_ms,
        });
    }
    Ok(report)
}

/// Upgrade derived project and work-tag values in-place. This reads only the
/// indexed SQLite tables; transcript source files are never reparsed.
fn rederive_projects_and_tags_if_needed(
    tx: &Transaction<'_>,
    prices: &PriceTable,
) -> Result<bool, String> {
    let current: Option<String> = tx
        .query_row(
            "SELECT value FROM index_state WHERE key = 'derivation_version'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("read derivation_version: {err}"))?;
    if current.as_deref() == Some(DERIVATION_VERSION) {
        return Ok(false);
    }

    let sessions = {
        let mut stmt = tx
            .prepare("SELECT kind, session_id, cwd FROM session")
            .map_err(|err| format!("prepare derivation sessions: {err}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|err| format!("scan derivation sessions: {err}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("read derivation session: {err}"))?
    };

    for (kind, session_id, cwd) in sessions {
        if let Some(cwd) = cwd {
            let touches = {
                let mut stmt = tx
                    .prepare("SELECT path FROM file_touch WHERE kind = ?1 AND session_id = ?2")
                    .map_err(|err| format!("prepare derivation touches: {err}"))?;
                let rows = stmt
                    .query_map(params![kind, session_id], |row| row.get::<_, String>(0))
                    .map_err(|err| format!("scan derivation touches: {err}"))?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|err| format!("read derivation touch: {err}"))?
            };
            let touch_refs: Vec<&str> = touches.iter().map(String::as_str).collect();
            let attribution = project_rules::derive_project(&cwd, &touch_refs);
            tx.execute(
                "UPDATE session SET project_key = ?3, project_label = ?4 WHERE kind = ?1 AND session_id = ?2",
                params![kind, session_id, attribution.key, attribution.label],
            )
            .map_err(|err| format!("update project derivation: {err}"))?;
        }
        recompute_session(tx, &kind, &session_id, prices)?;
    }
    tx.execute(
        "INSERT INTO index_state (key, value) VALUES ('derivation_version', ?1) \
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![DERIVATION_VERSION],
    )
    .map_err(|err| format!("write derivation_version: {err}"))?;
    Ok(true)
}

enum PlannedJob {
    Skip,
    Run(FileJob),
}

fn plan_file_job(
    kind: &'static str,
    path: PathBuf,
    size: u64,
    mtime_ns: i64,
    previous: Option<(u64, i64, u64, Option<String>)>,
    persisted: Option<&PersistedCodex>,
    session_sources: &HashMap<(String, String), usize>,
) -> PlannedJob {
    let stored_session_id = previous.as_ref().and_then(|prev| prev.3.clone());
    let had_previous = previous.is_some();
    let shared = stored_session_id
        .as_ref()
        .is_some_and(|sid| {
            session_sources
                .get(&(kind.to_string(), sid.clone()))
                .copied()
                .unwrap_or(0)
                > 1
        });

    let (start, reset, block_reason, trust_persist, metadata_only) = match previous {
        None => (0, true, None, false, false),
        Some((_, _, parsed, _)) if size < parsed => {
            if kind == KIND_CODEX && shared {
                (
                    0,
                    true,
                    Some(HISTORICAL_REPAIR_PENDING.to_string()),
                    false,
                    false,
                )
            } else {
                (0, true, None, false, false)
            }
        }
        Some((prev_size, prev_mtime, parsed, _)) => {
            let same_size = size == parsed && size == prev_size;
            let mtime_ok = mtime_ns == prev_mtime;
            if kind == KIND_GROK {
                if same_size && mtime_ok {
                    return PlannedJob::Skip;
                }
                (0, true, None, false, false)
            } else if kind != KIND_CODEX {
                // Claude: size==parsed means there is no new record to consume.
                if same_size {
                    return PlannedJob::Skip;
                }
                (parsed, false, None, false, false)
            } else {
                if same_size {
                    // A truly unchanged source is the hot path. Do not read
                    // transcript bytes merely to prove that nothing changed.
                    if mtime_ok {
                        return PlannedJob::Skip;
                    }
                    let fp = fingerprint_status(&path, parsed, persisted, true);
                    match fp {
                        FingerprintStatus::Match => (parsed, false, None, true, true),
                        FingerprintStatus::Mismatch | FingerprintStatus::Unknown if shared => (
                            0,
                            true,
                            Some(HISTORICAL_REPAIR_PENDING.to_string()),
                            false,
                            false,
                        ),
                        FingerprintStatus::Mismatch | FingerprintStatus::Unknown => {
                            (0, true, None, false, false)
                        }
                    }
                } else {
                    let fp = fingerprint_status(&path, parsed, persisted, false);
                    match fp {
                        FingerprintStatus::Match => (parsed, false, None, true, false),
                        FingerprintStatus::Mismatch if shared => (
                            0,
                            true,
                            Some(HISTORICAL_REPAIR_PENDING.to_string()),
                            false,
                            false,
                        ),
                        FingerprintStatus::Mismatch => (0, true, None, false, false),
                        FingerprintStatus::Unknown => (parsed, false, None, false, false),
                    }
                }
            }
        }
    };

    let codex_seed = if kind == KIND_CODEX {
        Some(codex_seed_for_job(
            &path,
            start,
            reset,
            stored_session_id.as_deref(),
            persisted
                .filter(|_| trust_persist)
                .filter(|item| item.at == start)
                .map(|item| &item.state),
        ))
    } else {
        None
    };
    let codex_content_fp = if kind == KIND_CODEX && trust_persist {
        persisted
            .filter(|item| item.at == start)
            .and_then(|item| item.content_fp.clone())
    } else {
        None
    };

    PlannedJob::Run(FileJob {
        path,
        kind,
        size,
        mtime_ns,
        archive: false,
        start,
        reset,
        had_previous,
        stored_session_id,
        codex_seed,
        codex_content_fp,
        codex_seed_trusted: trust_persist,
        metadata_only,
        block_reason,
    })
}

fn plan_archive_job(
    kind: &'static str,
    path: PathBuf,
    size: u64,
    mtime_ns: i64,
    previous: Option<(u64, i64, u64, Option<String>)>,
) -> PlannedJob {
    if previous.as_ref().is_some_and(|(previous_size, previous_mtime, _, _)| {
        *previous_size == size && *previous_mtime == mtime_ns
    }) {
        return PlannedJob::Skip;
    }
    PlannedJob::Run(FileJob {
        path,
        kind,
        size,
        mtime_ns,
        archive: true,
        start: 0,
        reset: true,
        had_previous: previous.is_some(),
        stored_session_id: previous.and_then(|item| item.3),
        codex_seed: None,
        codex_content_fp: None,
        codex_seed_trusted: false,
        metadata_only: false,
        block_reason: None,
    })
}

fn codex_seed_for_job(
    path: &Path,
    start: u64,
    reset: bool,
    stored: Option<&str>,
    persisted: Option<&parse_codex::CodexParseState>,
) -> parse_codex::CodexParseState {
    let stem = transcript_stem(path);
    let standard = parse_codex::standard_rollout_filename_uuid(stem);
    let legacy = stored.is_some_and(|sid| {
        standard.is_some_and(|uuid| parse_codex::is_legacy_compat_source(sid, uuid))
    });

    let mut state = if reset {
        parse_codex::CodexParseState::default()
    } else if let Some(persisted) = persisted {
        persisted.clone()
    } else {
        parse_codex::CodexParseState::default()
    };

    if legacy {
        state.session_id = stored.map(str::to_string);
        state.session_locked = true;
        state.session_behavior = SessionBehavior::LegacyCompat;
    } else if let Some(filename_id) = standard {
        state.session_id = Some(filename_id.to_string());
        state.session_locked = true;
        state.session_behavior = SessionBehavior::CanonicalFilename;
    } else {
        state.session_behavior = SessionBehavior::InFileIdentity;
        if reset || start == 0 {
            state.session_id = None;
            state.session_locked = false;
        } else if !state.session_locked {
            // A source mapping is not proof that a nonstandard filename has
            // established an in-file identity. Keep the checkpoint unlocked
            // until a valid session_meta.id has actually been observed.
            state.session_id = None;
        }
    }
    state
}

fn transcript_stem(path: &Path) -> &str {
    let name = path.file_name().and_then(|value| value.to_str()).unwrap_or("unknown");
    name.strip_suffix(".jsonl.gz")
        .or_else(|| name.strip_suffix(".jsonl"))
        .unwrap_or(name)
}

fn fingerprint_status(
    path: &Path,
    parsed_bytes: u64,
    persisted: Option<&PersistedCodex>,
    verify_full_content: bool,
) -> FingerprintStatus {
    let Some(item) = persisted else {
        return FingerprintStatus::Unknown;
    };
    if item.at != parsed_bytes {
        return FingerprintStatus::Unknown;
    }
    let Some(stored_prefix) = item.prefix_fp.as_deref() else {
        return FingerprintStatus::Unknown;
    };
    let Ok(prefix) = prefix_fingerprint(path, parsed_bytes) else {
        return FingerprintStatus::Mismatch;
    };
    if prefix != stored_prefix {
        return FingerprintStatus::Mismatch;
    }
    let boundary_matches = match item.boundary_fp.as_deref() {
        Some(stored_boundary) => match boundary_fingerprint(path, parsed_bytes) {
            Ok(boundary) if boundary == stored_boundary => true,
            _ => return FingerprintStatus::Mismatch,
        },
        None if parsed_bytes <= PREFIX_FINGERPRINT_LEN as u64 => true,
        None => return FingerprintStatus::Unknown,
    };
    if !boundary_matches {
        return FingerprintStatus::Mismatch;
    }
    if verify_full_content {
        let Some(stored_content) = item.content_fp.as_deref() else {
            return FingerprintStatus::Unknown;
        };
        return match content_fingerprint(path, parsed_bytes) {
            Ok(content) if content == stored_content => FingerprintStatus::Match,
            _ => FingerprintStatus::Mismatch,
        };
    }
    FingerprintStatus::Match
}

fn prefix_fingerprint(path: &Path, parsed_bytes: u64) -> Result<String, String> {
    let take = parsed_bytes.min(PREFIX_FINGERPRINT_LEN as u64);
    range_fingerprint(path, 0, take)
}

fn boundary_fingerprint(path: &Path, parsed_bytes: u64) -> Result<String, String> {
    let take = parsed_bytes.min(PREFIX_FINGERPRINT_LEN as u64);
    range_fingerprint(path, parsed_bytes.saturating_sub(take), take)
}

fn content_fingerprint(path: &Path, parsed_bytes: u64) -> Result<String, String> {
    range_fingerprint(path, 0, parsed_bytes)
}

fn range_fingerprint(path: &Path, start: u64, len: u64) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};
    if len == 0 {
        return Ok(fingerprint(&[]));
    }
    let mut file = std::fs::File::open(path).map_err(|err| format!("open fingerprint: {err}"))?;
    file.seek(SeekFrom::Start(start))
        .map_err(|err| format!("seek fingerprint: {err}"))?;
    let mut hash: u64 = 0xcbf_29ce4_8422_2325;
    let mut read_total = 0u64;
    let mut buffer = [0u8; FINGERPRINT_READ_CHUNK];
    while read_total < len {
        let wanted = (len - read_total).min(buffer.len() as u64) as usize;
        match file.read(&mut buffer[..wanted]) {
            Ok(0) => break,
            Ok(n) => {
                for byte in &buffer[..n] {
                    hash ^= u64::from(*byte);
                    hash = hash.wrapping_mul(0x1000_0000_01b3);
                }
                read_total += n as u64;
            }
            Err(err) => return Err(format!("read fingerprint: {err}")),
        }
    }
    Ok(format!("{hash:016x}:{read_total}"))
}

fn fingerprint(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}:{}", bytes.len())
}

fn extend_fingerprint(existing: &str, bytes: &[u8]) -> Option<String> {
    let (raw_hash, raw_len) = existing.split_once(':')?;
    let mut hash = u64::from_str_radix(raw_hash, 16).ok()?;
    let old_len = raw_len.parse::<u64>().ok()?;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    Some(format!("{hash:016x}:{}", old_len + bytes.len() as u64))
}

fn load_persisted_codex_states(
    conn: &Connection,
) -> Result<HashMap<String, PersistedCodex>, String> {
    let mut stmt = conn
        .prepare("SELECT key, value FROM index_state WHERE key LIKE ?1")
        .map_err(|err| format!("prepare persisted codex state: {err}"))?;
    let rows = stmt
        .query_map(params![format!("{CODEX_PARSE_STATE_PREFIX}%")], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| format!("scan persisted codex state: {err}"))?;
    let mut out = HashMap::new();
    for row in rows {
        let (key, value) = row.map_err(|err| format!("read persisted codex state: {err}"))?;
        let Some(path) = key.strip_prefix(CODEX_PARSE_STATE_PREFIX) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&value) else {
            continue;
        };
        let Some(at) = parsed.get("parsed_bytes").and_then(|v| v.as_u64()) else {
            continue;
        };
        let behavior = parsed
            .get("session_behavior")
            .and_then(|v| v.as_str())
            .and_then(SessionBehavior::parse)
            .unwrap_or(SessionBehavior::InFileIdentity);
        let state = parse_codex::CodexParseState {
            session_id: parsed
                .get("session_id")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            model: parsed
                .get("model")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            effort: parsed
                .get("effort")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            session_locked: parsed
                .get("session_locked")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            session_behavior: behavior,
        };
        out.insert(
            path.to_string(),
            PersistedCodex {
                at,
                state,
                prefix_fp: parsed
                    .get("prefix_fp")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                boundary_fp: parsed
                    .get("boundary_fp")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                content_fp: parsed
                    .get("content_fp")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
            },
        );
    }
    Ok(out)
}

fn persist_codex_state(
    tx: &Transaction<'_>,
    path: &str,
    parsed_bytes: u64,
    state: &parse_codex::CodexParseState,
    content_fp: Option<&str>,
) -> Result<(), String> {
    let file_path = Path::new(path);
    let prefix_fp = prefix_fingerprint(file_path, parsed_bytes).ok();
    let boundary_fp = boundary_fingerprint(file_path, parsed_bytes).ok();
    let value = serde_json::json!({
        "parsed_bytes": parsed_bytes,
        "model": state.model,
        "effort": state.effort,
        "session_id": state.session_id,
        "session_locked": state.session_locked,
        "session_behavior": state.session_behavior.as_str(),
        "prefix_fp": prefix_fp,
        "boundary_fp": boundary_fp,
        "content_fp": content_fp,
    });
    tx.execute(
        "INSERT INTO index_state (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![
            format!("{CODEX_PARSE_STATE_PREFIX}{path}"),
            value.to_string()
        ],
    )
    .map_err(|err| format!("write persisted codex state: {err}"))?;
    Ok(())
}

fn source_count_for_session(
    tx: &Transaction<'_>,
    kind: &str,
    session_id: &str,
    except_path: Option<&str>,
) -> Result<i64, String> {
    let count: i64 = if let Some(path) = except_path {
        tx.query_row(
            "SELECT COUNT(*) FROM source_file WHERE kind = ?1 AND session_id = ?2 AND path != ?3",
            params![kind, session_id, path],
            |row| row.get(0),
        )
    } else {
        tx.query_row(
            "SELECT COUNT(*) FROM source_file WHERE kind = ?1 AND session_id = ?2",
            params![kind, session_id],
            |row| row.get(0),
        )
    }
    .map_err(|err| format!("count source_file session: {err}"))?;
    Ok(count)
}

fn shared_session_blocked(
    tx: &Transaction<'_>,
    kind: &str,
    stored: Option<&str>,
    path: &str,
) -> Result<bool, String> {
    let Some(session_id) = stored else {
        return Ok(false);
    };
    Ok(source_count_for_session(tx, kind, session_id, Some(path))? > 0)
}

fn apply_plain_chunk(
    tx: &Transaction<'_>,
    source_file_upsert: &mut rusqlite::CachedStatement<'_>,
    touched: &mut HashSet<(String, String)>,
    job_path: String,
    kind: &'static str,
    size: u64,
    mtime_ns: i64,
    archive: bool,
    start: u64,
    reset: bool,
    stored_session_id: Option<String>,
    data: ChunkData,
    codex_end_state: Option<parse_codex::CodexParseState>,
    content_fp: Option<String>,
) -> Result<(), String> {
    if reset {
        let mut ids: HashSet<String> = data.sessions.keys().cloned().collect();
        if let Some(stored) = stored_session_id.clone() {
            ids.insert(stored);
        }
        for session_id in ids {
            if source_count_for_session(tx, kind, &session_id, Some(&job_path))? > 0 {
                continue;
            }
            rollup::mark_session_dirty(tx, kind, &session_id)?;
            delete_session(tx, kind, &session_id)?;
        }
    }
    for chunk in data.sessions.values() {
        apply_chunk(tx, chunk)?;
        touched.insert((kind.to_string(), chunk.session_id.clone()));
    }
    let session_id = data
        .sessions
        .keys()
        .next()
        .cloned()
        .or(stored_session_id);
    let parsed_bytes = if archive { size } else { start + data.consumed_bytes };
    source_file_upsert
        .execute(params![
            job_path,
            kind,
            size as i64,
            mtime_ns,
            parsed_bytes as i64,
            data.lines as i64,
            session_id,
            chrono::Utc::now().timestamp_millis(),
            reset,
        ])
        .map_err(|err| format!("write source_file: {err}"))?;
    if data.parse_errors > 0 {
        let message = format!(
            "complete invalid JSON/UTF-8 records skipped ({})",
            data.parse_errors
        );
        tx.execute(
            "UPDATE source_file SET parse_error = ?1 WHERE path = ?2",
            params![message, job_path],
        )
        .map_err(|err| format!("write source_file parse_error: {err}"))?;
    }
    if let Some(state) = codex_end_state {
        persist_codex_state(tx, &job_path, parsed_bytes, &state, content_fp.as_deref())?;
    }
    Ok(())
}

/// Read the requested byte range and hand it to the format's parser.
///
/// Only whole newline-terminated lines are consumed, so a transcript that is
/// mid-write when the indexer reaches it resumes cleanly next time instead of
/// swallowing a half-written record. A mid-line offset rewinds to the previous
/// record start so a valid record is never discarded while progress advances.
fn read_and_parse(
    job: &FileJob,
) -> Result<
    (
        ChunkData,
        Option<parse_codex::CodexParseState>,
        u64,
        bool,
        Option<String>,
    ),
    String,
> {
    use std::io::{Read, Seek, SeekFrom};

    let (start, buffer) = if job.archive {
        let file = std::fs::File::open(&job.path).map_err(|err| format!("open archive: {err}"))?;
        let mut decoder = flate2::read::GzDecoder::new(file);
        let mut buffer = Vec::new();
        decoder
            .read_to_end(&mut buffer)
            .map_err(|err| format!("read archive: {err}"))?;
        (0, buffer)
    } else {
        let mut start = job.start;
        let mut file = std::fs::File::open(&job.path).map_err(|err| format!("open: {err}"))?;
        if start > 0 && !byte_before_is_newline(&mut file, start)? {
            start = previous_newline_end(&mut file, start)?;
        }
        if start > 0 {
            file.seek(SeekFrom::Start(start))
                .map_err(|err| format!("seek: {err}"))?;
        } else {
            file.seek(SeekFrom::Start(0))
                .map_err(|err| format!("seek: {err}"))?;
        }
        let mut buffer = Vec::new();
        file.read_to_end(&mut buffer)
            .map_err(|err| format!("read: {err}"))?;
        (start, buffer)
    };

    let complete = match buffer.iter().rposition(|byte| *byte == b'\n') {
        Some(pos) => pos + 1,
        None => 0,
    };
    if complete == 0 {
        let end_state = if job.kind == KIND_CODEX && (job.codex_seed_trusted || start == 0) {
            job.codex_seed.clone()
        } else {
            None
        };
        return Ok((
            ChunkData::default(),
            end_state,
            start,
            job.reset,
            job.codex_content_fp.clone(),
        ));
    }
    let (text, utf8_errors) = decode_complete_records(&buffer[..complete]);
    let observed_codex_state = (job.kind == KIND_CODEX)
        .then(|| parse_codex::parse_state_from_text(&text));

    // A nonstandard source may be indexed before its first valid
    // session_meta. Once the identity appears in a later chunk, re-read this
    // one unshared source from zero so earlier fallback rows cannot be split
    // from the now-established in-file identity.
    if job.kind == KIND_CODEX
        && start > 0
        && job
            .codex_seed
            .as_ref()
            .is_some_and(|state| {
                state.session_behavior == SessionBehavior::InFileIdentity
                    && !state.session_locked
            })
        && observed_codex_state
            .as_ref()
            .and_then(|state| state.session_id.as_deref())
            .is_some()
    {
        let mut replay = job.clone();
        replay.start = 0;
        replay.reset = true;
        replay.codex_seed = Some(parse_codex::CodexParseState::default());
        replay.codex_content_fp = None;
        replay.codex_seed_trusted = false;
        return read_and_parse(&replay);
    }

    let stem = job
        .path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("unknown");
    let filename_fallback = if job.kind == KIND_CODEX {
        parse_codex::session_id_from_filename(transcript_stem(&job.path))
    } else if job.kind == KIND_GROK {
        job.path
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            .unwrap_or(stem)
    } else {
        stem
    };

    let mut seed = if job.kind == KIND_CODEX {
        job.codex_seed
            .clone()
            .unwrap_or_else(parse_codex::CodexParseState::default)
    } else {
        parse_codex::CodexParseState::default()
    };
    if job.kind == KIND_CODEX && start > 0 {
        let rewound = start != job.start;
        if rewound
            || (!job.codex_seed_trusted && (seed.model.is_none() || seed.effort.is_none()))
        {
            let recovered = recover_codex_state(&job.path, start)?;
            if rewound {
                seed.model = recovered.model;
                seed.effort = recovered.effort;
            } else {
                if seed.model.is_none() {
                    seed.model = recovered.model;
                }
                if seed.effort.is_none() {
                    seed.effort = recovered.effort;
                }
            }
        }
    }

    let fallback = if job.kind == KIND_CODEX && seed.session_locked {
        seed.session_id
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or(filename_fallback)
    } else {
        filename_fallback
    };

    let mut data = match job.kind {
        KIND_CLAUDE | KIND_CLAUDE_CODEX => parse_claude::parse_chunk(&text, fallback),
        KIND_CODEX => parse_codex::parse_chunk_with_state(&text, fallback, seed.clone()),
        KIND_GROK => parse_grok::parse_chunk(&text, fallback),
        other => return Err(format!("unsupported ailog kind: {other}")),
    };
    if job.kind == KIND_GROK {
        let (cwd, model) = grok_supplemental_metadata(&job.path);
        for session in data.sessions.values_mut() {
            if session.cwd.is_none() {
                session.cwd = cwd.clone();
            }
            for turn in &mut session.turns {
                if turn.model.is_none() {
                    turn.model = model.clone();
                }
            }
        }
    };
    data.consumed_bytes = complete as u64;
    data.parse_errors += utf8_errors;
    let end_state = if job.kind == KIND_CODEX {
        let delta = observed_codex_state.unwrap_or_default();
        if delta.model.is_some() {
            seed.model = delta.model;
        }
        if delta.effort.is_some() {
            seed.effort = delta.effort;
        }
        if seed.session_behavior == SessionBehavior::InFileIdentity && !seed.session_locked {
            if let Some(session_id) = delta.session_id {
                seed.session_id = Some(session_id);
                seed.session_locked = true;
            }
        }
        Some(seed)
    } else {
        None
    };
    let content_fp = if job.kind == KIND_CODEX {
        let parsed_bytes = start + data.consumed_bytes;
        if start == 0 {
            Some(fingerprint(&buffer[..complete]))
        } else if start == job.start {
            job.codex_content_fp
                .as_deref()
                .and_then(|existing| extend_fingerprint(existing, &buffer[..complete]))
                .filter(|value| value.ends_with(&format!(":{parsed_bytes}")))
        } else {
            content_fingerprint(&job.path, parsed_bytes).ok()
        }
    } else {
        None
    };
    Ok((data, end_state, start, job.reset, content_fp))
}

fn byte_before_is_newline(file: &mut std::fs::File, pos: u64) -> Result<bool, String> {
    use std::io::{Read, Seek, SeekFrom};
    if pos == 0 {
        return Ok(true);
    }
    file.seek(SeekFrom::Start(pos - 1))
        .map_err(|err| format!("seek boundary: {err}"))?;
    let mut prev = [0u8; 1];
    file.read_exact(&mut prev)
        .map_err(|err| format!("read boundary: {err}"))?;
    Ok(prev[0] == b'\n')
}

fn previous_newline_end(file: &mut std::fs::File, pos: u64) -> Result<u64, String> {
    use std::io::{Seek, SeekFrom};
    const CHUNK: u64 = 64 * 1024;
    let mut cursor = pos;
    while cursor > 0 {
        let begin = cursor.saturating_sub(CHUNK);
        file.seek(SeekFrom::Start(begin))
            .map_err(|err| format!("seek prev nl: {err}"))?;
        let mut buffer = vec![0u8; (cursor - begin) as usize];
        read_exact_or_short(file, &mut buffer).map_err(|err| format!("read prev nl: {err}"))?;
        if let Some(rel) = buffer.iter().rposition(|byte| *byte == b'\n') {
            return Ok(begin + rel as u64 + 1);
        }
        cursor = begin;
    }
    Ok(0)
}

fn read_exact_or_short(file: &mut std::fs::File, buffer: &mut [u8]) -> Result<(), std::io::Error> {
    use std::io::Read;
    let mut filled = 0usize;
    while filled < buffer.len() {
        match file.read(&mut buffer[filled..]) {
            Ok(0) => {
                buffer[filled..].fill(0);
                break;
            }
            Ok(n) => filled += n,
            Err(err) => return Err(err),
        }
    }
    Ok(())
}

/// Fragment-aware reverse record reader. Windows carry incomplete prefixes
/// so a `turn_context` that spans a 1 MiB boundary or exceeds 1 MiB is still
/// decoded as one record.
fn recover_codex_state(path: &Path, start: u64) -> Result<parse_codex::CodexParseState, String> {
    use std::io::{Seek, SeekFrom};

    if start == 0 {
        return Ok(parse_codex::CodexParseState::default());
    }
    let mut file = std::fs::File::open(path).map_err(|err| format!("open prefix: {err}"))?;
    let mut end = start;
    if !byte_before_is_newline(&mut file, end)? {
        end = previous_newline_end(&mut file, end)?;
    }
    let mut pos = end;
    let mut carry: Vec<u8> = Vec::new();
    let mut recovered = parse_codex::CodexParseState::default();
    while pos > 0 {
        let begin = pos.saturating_sub(REVERSE_WINDOW);
        file.seek(SeekFrom::Start(begin))
            .map_err(|err| format!("seek prefix: {err}"))?;
        let mut data = vec![0u8; (pos - begin) as usize];
        read_exact_or_short(&mut file, &mut data).map_err(|err| format!("read prefix: {err}"))?;
        data.extend_from_slice(&carry);

        let starts_mid_record = begin > 0 && !byte_before_is_newline(&mut file, begin)?;
        let (complete_start, next_carry) = if starts_mid_record {
            match data.iter().position(|byte| *byte == b'\n') {
                Some(first_newline) => (first_newline + 1, data[..=first_newline].to_vec()),
                None => (data.len(), data.clone()),
            }
        } else {
            (0, Vec::new())
        };
        for record in data[complete_start..]
            .split(|byte| *byte == b'\n')
            .rev()
        {
            let record = strip_cr(record);
            if record.is_empty() {
                continue;
            }
            let Ok(text) = std::str::from_utf8(record) else {
                continue;
            };
            let state = parse_codex::parse_model_state_from_text(text);
            if recovered.model.is_none() {
                recovered.model = state.model;
            }
            if recovered.effort.is_none() {
                recovered.effort = state.effort;
            }
            if recovered.model.is_some() && recovered.effort.is_some() {
                return Ok(recovered);
            }
        }
        if begin == 0 {
            break;
        }
        carry = next_carry;
        pos = begin;
    }
    Ok(recovered)
}

fn strip_cr(bytes: &[u8]) -> &[u8] {
    match bytes.last() {
        Some(b'\r') => &bytes[..bytes.len() - 1],
        _ => bytes,
    }
}

/// Decode newline-terminated records one at a time so a single invalid UTF-8
/// line cannot hide later valid records or force a whole-file failure.
fn decode_complete_records(bytes: &[u8]) -> (String, u64) {
    let mut text = String::new();
    let mut errors = 0u64;
    let mut start = 0usize;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        let line = strip_cr(&bytes[start..index]);
        match std::str::from_utf8(line) {
            Ok(line) => {
                text.push_str(line);
                text.push('\n');
            }
            Err(_) => errors += 1,
        }
        start = index + 1;
    }
    (text, errors)
}

/// Read Grok metadata that lives beside `updates.jsonl` without indexing the
/// sibling telemetry files themselves.
fn grok_supplemental_metadata(path: &Path) -> (Option<String>, Option<String>) {
    let Some(parent) = path.parent() else {
        return (None, None);
    };
    let mut cwd = None;
    let mut model = None;

    if let Ok(text) = std::fs::read_to_string(parent.join("summary.json")) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            cwd = value
                .get("info")
                .and_then(|info| info.get("cwd"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            model = value
                .get("current_model_id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
        }
    }

    if model.is_none() {
        if let Ok(file) = std::fs::File::open(parent.join("events.jsonl")) {
            use std::io::BufRead;
            for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                if value.get("type").and_then(serde_json::Value::as_str)
                    == Some("turn_started")
                {
                    model = value
                        .get("model_id")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string);
                    if model.is_some() {
                        break;
                    }
                }
            }
        }
    }

    if cwd.is_none() {
        cwd = path
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            .and_then(percent_decode_path_segment);
    }

    (cwd, model)
}

fn percent_decode_path_segment(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let high = hex_digit(bytes[index + 1])?;
            let low = hex_digit(bytes[index + 2])?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn clear_all(conn: &mut Connection) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|err| format!("begin clear transaction: {err}"))?;
    for table in [
        "source_file",
        "session",
        "turn",
        "tool_event",
        "file_touch",
        "rework",
        "rollup_turn_session_day",
        "rollup_dirty",
    ] {
        tx.execute(&format!("DELETE FROM {table}"), [])
            .map_err(|err| format!("clear {table}: {err}"))?;
    }
    tx.commit()
        .map_err(|err| format!("commit clear transaction: {err}"))?;
    Ok(())
}

fn delete_session(tx: &Transaction<'_>, kind: &str, session_id: &str) -> Result<(), String> {
    for table in ["session", "turn", "tool_event", "file_touch", "rework"] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE kind = ?1 AND session_id = ?2"),
            params![kind, session_id],
        )
        .map_err(|err| format!("delete {table}: {err}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Writing one chunk
// ---------------------------------------------------------------------------

fn apply_chunk(tx: &Transaction<'_>, chunk: &SessionChunk) -> Result<(), String> {
    let (project_key_value, project_label_value) = match &chunk.cwd {
        Some(cwd) => {
            let touches: Vec<&str> = chunk.files.keys().map(String::as_str).collect();
            let attribution = project_rules::derive_project(cwd, &touches);
            (Some(attribution.key), Some(attribution.label))
        }
        None => (None, None),
    };
    let agent_names = if chunk.agent_names.is_empty() {
        None
    } else {
        serde_json::to_string(&chunk.agent_names).ok()
    };

    tx.execute(
        "INSERT INTO session (kind, session_id, cwd, project_key, project_label, git_branch, \
         ai_title, first_prompt, slug, entrypoint, origin, is_sidechain, agent_names, \
         cli_version, plan_type, started_at, ended_at, active_ms, user_msg_count, \
         compact_count, prompt_chars, write_chars, ends_on_tool) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, \
         ?18, ?19, ?20, ?21, ?22, ?23) \
         ON CONFLICT(kind, session_id) DO UPDATE SET \
           cwd = COALESCE(excluded.cwd, session.cwd), \
           project_key = COALESCE(excluded.project_key, session.project_key), \
           project_label = COALESCE(excluded.project_label, session.project_label), \
           git_branch = COALESCE(excluded.git_branch, session.git_branch), \
           ai_title = COALESCE(excluded.ai_title, session.ai_title), \
           first_prompt = COALESCE(session.first_prompt, excluded.first_prompt), \
           slug = COALESCE(excluded.slug, session.slug), \
           entrypoint = COALESCE(excluded.entrypoint, session.entrypoint), \
           origin = CASE WHEN session.origin = 'ailog-internal' OR excluded.origin = 'ailog-internal' \
                         THEN 'ailog-internal' ELSE COALESCE(excluded.origin, session.origin) END, \
           is_sidechain = MAX(session.is_sidechain, excluded.is_sidechain), \
           agent_names = COALESCE(excluded.agent_names, session.agent_names), \
           cli_version = COALESCE(excluded.cli_version, session.cli_version), \
           plan_type = COALESCE(excluded.plan_type, session.plan_type), \
           started_at = MIN(COALESCE(session.started_at, excluded.started_at), \
                            COALESCE(excluded.started_at, session.started_at)), \
           ended_at = MAX(COALESCE(session.ended_at, excluded.ended_at), \
                          COALESCE(excluded.ended_at, session.ended_at)), \
           active_ms = COALESCE(session.active_ms, 0) + excluded.active_ms, \
           user_msg_count = session.user_msg_count + excluded.user_msg_count, \
           compact_count = session.compact_count + excluded.compact_count, \
           prompt_chars = session.prompt_chars + excluded.prompt_chars, \
           write_chars = session.write_chars + excluded.write_chars, \
           ends_on_tool = excluded.ends_on_tool",
        params![
            chunk.kind,
            chunk.session_id,
            chunk.cwd,
            project_key_value,
            project_label_value,
            chunk.git_branch,
            chunk.ai_title,
            chunk.first_prompt,
            chunk.slug,
            chunk.entrypoint,
            chunk.origin,
            chunk.is_sidechain as i64,
            agent_names,
            chunk.cli_version,
            chunk.plan_type,
            chunk.started_at,
            chunk.ended_at,
            chunk.active_ms,
            chunk.user_msg_count,
            chunk.compact_count,
            chunk.prompt_chars,
            chunk.write_chars,
            chunk.ends_on_tool as i64,
        ],
    )
    .map_err(|err| format!("upsert session: {err}"))?;

    // --- turns -----------------------------------------------------------
    let mut next_turn_seq: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(seq), -1) + 1 FROM turn WHERE kind = ?1 AND session_id = ?2",
            params![chunk.kind, chunk.session_id],
            |row| row.get(0),
        )
        .map_err(|err| format!("next turn seq: {err}"))?;

    for turn in &chunk.turns {
        let normalized = turn.model.as_deref().map(price::normalize);
        // Grok reports one aggregate cost for a completed turn. The existing
        // schema exposes input/output cost columns, so keep the exact total
        // while allocating the aggregate by token volume for those views. The
        // split is storage-compatible presentation, not a claim about the
        // provider's component rates.
        let reported_ingest = turn.reported_cost_usd.map(|cost| {
            let input = (turn.input_tokens
                + turn.cache_read_tokens
                + turn.cache_write_5m_tokens
                + turn.cache_write_1h_tokens) as f64;
            let output = turn.output_tokens as f64;
            let total = input + output;
            if total > 0.0 {
                cost * input / total
            } else {
                0.0
            }
        });
        let reported_generate = turn
            .reported_cost_usd
            .map(|cost| cost - reported_ingest.unwrap_or(0.0));
        tx.execute(
            "INSERT INTO turn (kind, session_id, seq, request_id, ts, model, model_family, \
             model_variant, effort, service_tier, input_tokens, output_tokens, \
             cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, \
             reasoning_tokens, duration_ms, tool_calls, tool_errors, cost_usd, \
             ingest_cost_usd, generate_cost_usd) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, \
             ?17, ?18, 0, COALESCE(?19, 0), COALESCE(?20, 0), COALESCE(?21, 0)) \
             ON CONFLICT(kind, session_id, request_id) DO UPDATE SET \
               tool_calls = turn.tool_calls + excluded.tool_calls, \
               duration_ms = COALESCE(excluded.duration_ms, turn.duration_ms), \
               model = COALESCE(turn.model, excluded.model), \
               cost_usd = CASE WHEN ?19 IS NULL THEN turn.cost_usd ELSE excluded.cost_usd END, \
               ingest_cost_usd = CASE WHEN ?20 IS NULL THEN turn.ingest_cost_usd ELSE excluded.ingest_cost_usd END, \
               generate_cost_usd = CASE WHEN ?21 IS NULL THEN turn.generate_cost_usd ELSE excluded.generate_cost_usd END",
            params![
                chunk.kind,
                chunk.session_id,
                next_turn_seq,
                turn.dedup_key,
                turn.ts,
                turn.model,
                normalized.as_ref().map(|id| id.family.clone()),
                normalized.as_ref().and_then(|id| id.variant.clone()),
                turn.effort,
                turn.service_tier,
                turn.input_tokens,
                turn.output_tokens,
                turn.cache_read_tokens,
                turn.cache_write_5m_tokens,
                turn.cache_write_1h_tokens,
                turn.reasoning_tokens,
                turn.duration_ms,
                turn.tool_calls,
                turn.reported_cost_usd,
                reported_ingest,
                reported_generate,
            ],
        )
        .map_err(|err| format!("upsert turn: {err}"))?;
        next_turn_seq += 1;
    }

    // --- tool events -----------------------------------------------------
    let mut next_tool_seq: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(seq), -1) + 1 FROM tool_event WHERE kind = ?1 AND session_id = ?2",
            params![chunk.kind, chunk.session_id],
            |row| row.get(0),
        )
        .map_err(|err| format!("next tool seq: {err}"))?;

    for tool in &chunk.tools {
        tx.execute(
            "INSERT OR REPLACE INTO tool_event (kind, session_id, seq, ts, name, is_error, \
             target, call_id, turn_key) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8)",
            params![
                chunk.kind,
                chunk.session_id,
                next_tool_seq,
                tool.ts,
                tool.name,
                tool.target,
                tool.call_id,
                // Links the call back to the turn that issued it so failures,
                // which only surface in a later result record, can be counted
                // against the right turn.
                tool.turn_key,
            ],
        )
        .map_err(|err| format!("insert tool_event: {err}"))?;
        next_tool_seq += 1;
    }

    // --- tool results ----------------------------------------------------
    let mut io = IoChars::default();
    for result in &chunk.results {
        // A result whose call landed in an earlier chunk is resolved from the
        // database rather than being dropped into `other`.
        let name = match &result.name {
            Some(name) => Some(name.clone()),
            None => tx
                .query_row(
                    "SELECT name FROM tool_event WHERE kind = ?1 AND session_id = ?2 \
                     AND call_id = ?3 LIMIT 1",
                    params![chunk.kind, chunk.session_id, result.call_id],
                    |row| row.get::<_, String>(0),
                )
                .ok(),
        };
        io.add(name.as_deref(), result.chars);

        if result.is_error {
            tx.execute(
                "UPDATE tool_event SET is_error = 1 WHERE kind = ?1 AND session_id = ?2 \
                 AND call_id = ?3",
                params![chunk.kind, chunk.session_id, result.call_id],
            )
            .map_err(|err| format!("mark tool error: {err}"))?;
        }
    }

    tx.execute(
        "UPDATE session SET read_chars = read_chars + ?3, exec_chars = exec_chars + ?4, \
         fetch_chars = fetch_chars + ?5, other_chars = other_chars + ?6 \
         WHERE kind = ?1 AND session_id = ?2",
        params![
            chunk.kind,
            chunk.session_id,
            io.read,
            io.exec,
            io.fetch,
            io.other
        ],
    )
    .map_err(|err| format!("update io chars: {err}"))?;

    // --- files -----------------------------------------------------------
    for (path, touch) in &chunk.files {
        tx.execute(
            "INSERT INTO file_touch (kind, session_id, path, edit_count, read_count, first_ts, \
             last_ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
             ON CONFLICT(kind, session_id, path) DO UPDATE SET \
               edit_count = file_touch.edit_count + excluded.edit_count, \
               read_count = file_touch.read_count + excluded.read_count, \
               first_ts = MIN(COALESCE(file_touch.first_ts, excluded.first_ts), \
                              COALESCE(excluded.first_ts, file_touch.first_ts)), \
               last_ts = MAX(COALESCE(file_touch.last_ts, excluded.last_ts), \
                             COALESCE(excluded.last_ts, file_touch.last_ts))",
            params![
                chunk.kind,
                chunk.session_id,
                path,
                touch.edit_count,
                touch.read_count,
                touch.first_ts,
                touch.last_ts,
            ],
        )
        .map_err(|err| format!("upsert file_touch: {err}"))?;
    }

    // --- rework accumulators --------------------------------------------
    tx.execute(
        "INSERT INTO rework (kind, session_id, correction_count) VALUES (?1, ?2, ?3) \
         ON CONFLICT(kind, session_id) DO UPDATE SET \
           correction_count = rework.correction_count + excluded.correction_count",
        params![chunk.kind, chunk.session_id, chunk.correction_hits],
    )
    .map_err(|err| format!("upsert rework: {err}"))?;

    Ok(())
}

#[derive(Debug, Default, Clone, Copy)]
struct IoChars {
    read: i64,
    exec: i64,
    fetch: i64,
    other: i64,
}

impl IoChars {
    /// Route a tool result's character count.
    ///
    /// Edit-class results hold a confirmation message, not written content, so
    /// they go to `other`; written volume is measured from the request payload
    /// instead. An unidentifiable tool also lands in `other` — never in read
    /// or write, where it would corrupt the estimate it appears in.
    fn add(&mut self, name: Option<&str>, chars: i64) {
        match name.map(metrics::classify_tool) {
            Some(ToolClass::Read) => self.read += chars,
            Some(ToolClass::Exec) => self.exec += chars,
            Some(ToolClass::Fetch) => self.fetch += chars,
            _ => self.other += chars,
        }
    }
}

// ---------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------

/// Recompute everything that depends on the whole session: turn costs, model
/// mix, rework signals, work tags and the goal key.
pub fn recompute_session(
    tx: &Transaction<'_>,
    kind: &str,
    session_id: &str,
    prices: &PriceTable,
) -> Result<(), String> {
    // --- price every turn ------------------------------------------------
    struct TurnCost {
        seq: i64,
        model: Option<String>,
        family: Option<String>,
        input: i64,
        output: i64,
        cache_read: i64,
        write_5m: i64,
        write_1h: i64,
        stored_cost: f64,
        stored_ingest: f64,
        stored_generate: f64,
    }

    let mut turns = Vec::new();
    {
        let mut stmt = tx
            .prepare(
                "SELECT seq, model, model_family, input_tokens, output_tokens, \
                 cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, \
                 cost_usd, ingest_cost_usd, generate_cost_usd \
                 FROM turn WHERE kind = ?1 AND session_id = ?2",
            )
            .map_err(|err| format!("prepare turn scan: {err}"))?;
        let rows = stmt
            .query_map(params![kind, session_id], |row| {
                Ok(TurnCost {
                    seq: row.get(0)?,
                    model: row.get(1)?,
                    family: row.get(2)?,
                    input: row.get(3)?,
                    output: row.get(4)?,
                    cache_read: row.get(5)?,
                    write_5m: row.get(6)?,
                    write_1h: row.get(7)?,
                    stored_cost: row.get(8)?,
                    stored_ingest: row.get(9)?,
                    stored_generate: row.get(10)?,
                })
            })
            .map_err(|err| format!("scan turns: {err}"))?;
        for row in rows {
            turns.push(row.map_err(|err| format!("turn row: {err}"))?);
        }
    }

    let mut total_cost = 0.0f64;
    let mut per_family: BTreeMap<String, f64> = BTreeMap::new();
    let mut families: HashSet<String> = HashSet::new();
    for turn in &turns {
        let split = if kind == KIND_GROK {
            // Grok's provider-reported aggregate is already authoritative. It
            // was stored by apply_chunk; do not replace it with the local
            // token-price table, which has no Grok row.
            let stored_total = turn.stored_ingest + turn.stored_generate;
            if stored_total.abs() > f64::EPSILON || turn.stored_cost.abs() <= f64::EPSILON {
                price::CostSplit {
                    ingest: turn.stored_ingest,
                    generate: turn.stored_generate,
                }
            } else {
                price::CostSplit {
                    ingest: 0.0,
                    generate: turn.stored_cost,
                }
            }
        } else {
            let price = turn
                .model
                .as_deref()
                .and_then(|model| prices.lookup(model))
                .map(|row| row.price);
            price::cost_for_turn(
                price.as_ref(),
                turn.input,
                turn.output,
                turn.cache_read,
                turn.write_5m,
                turn.write_1h,
            )
        };
        total_cost += split.total();
        if let Some(family) = &turn.family {
            families.insert(family.clone());
            *per_family.entry(family.clone()).or_insert(0.0) += split.total();
        }
        tx.execute(
            "UPDATE turn SET cost_usd = ?3, ingest_cost_usd = ?4, generate_cost_usd = ?5 \
             WHERE kind = ?1 AND session_id = ?2 AND seq = ?6",
            params![
                kind,
                session_id,
                split.total(),
                split.ingest,
                split.generate,
                turn.seq
            ],
        )
        .map_err(|err| format!("update turn cost: {err}"))?;
    }

    let primary_model = per_family
        .iter()
        .max_by(|a, b| {
            a.1.partial_cmp(b.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.0.cmp(a.0))
        })
        .map(|(family, _)| family.clone());

    // --- tool events -----------------------------------------------------
    let mut tools: Vec<ToolRow> = Vec::new();
    {
        let mut stmt = tx
            .prepare(
                "SELECT ts, name, is_error, target FROM tool_event \
                 WHERE kind = ?1 AND session_id = ?2 ORDER BY seq",
            )
            .map_err(|err| format!("prepare tool scan: {err}"))?;
        let rows = stmt
            .query_map(params![kind, session_id], |row| {
                Ok(ToolRow {
                    call_id: None,
                    ts: row.get(0)?,
                    name: row.get(1)?,
                    is_error: row.get::<_, i64>(2)? != 0,
                    target: row.get(3)?,
                    turn_key: None,
                })
            })
            .map_err(|err| format!("scan tools: {err}"))?;
        for row in rows {
            tools.push(row.map_err(|err| format!("tool row: {err}"))?);
        }
    }

    // Failures are discovered from the tool *result*, which arrives after the
    // turn row was written, so the per-turn error count is derived here rather
    // than at insert time.
    tx.execute(
        "UPDATE turn SET tool_errors = (SELECT COUNT(*) FROM tool_event te          WHERE te.kind = turn.kind AND te.session_id = turn.session_id          AND te.turn_key = turn.request_id AND te.is_error = 1)          WHERE kind = ?1 AND session_id = ?2",
        params![kind, session_id],
    )
    .map_err(|err| format!("update turn tool_errors: {err}"))?;

    let tool_call_count = tools.len() as i64;
    let tool_error_count = tools.iter().filter(|tool| tool.is_error).count() as i64;
    let tool_error_rate = if tool_call_count > 0 {
        tool_error_count as f64 / tool_call_count as f64
    } else {
        0.0
    };
    let retry_bash = metrics::count_retry_bash(&tools);

    let mut read_calls = 0i64;
    let mut edit_calls = 0i64;
    let mut verify_runs = 0i64;
    let mut orchestrate_calls = 0i64;
    let mut research_calls = 0i64;
    for tool in &tools {
        match metrics::classify_tool(&tool.name) {
            ToolClass::Read => read_calls += 1,
            ToolClass::Edit => edit_calls += 1,
            ToolClass::Exec => {
                if metrics::is_verify_command(tool.target.as_deref()) {
                    verify_runs += 1;
                }
            }
            ToolClass::Fetch => research_calls += 1,
            ToolClass::Orchestrate => orchestrate_calls += 1,
            ToolClass::Other => {}
        }
    }

    // --- files -----------------------------------------------------------
    let mut files = BTreeMap::new();
    {
        let mut stmt = tx
            .prepare(
                "SELECT path, edit_count, read_count FROM file_touch \
                 WHERE kind = ?1 AND session_id = ?2",
            )
            .map_err(|err| format!("prepare file scan: {err}"))?;
        let rows = stmt
            .query_map(params![kind, session_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    crate::ailog::FileTouchRow {
                        edit_count: row.get(1)?,
                        read_count: row.get(2)?,
                        first_ts: None,
                        last_ts: None,
                    },
                ))
            })
            .map_err(|err| format!("scan files: {err}"))?;
        for row in rows {
            let (path, touch) = row.map_err(|err| format!("file row: {err}"))?;
            files.insert(path, touch);
        }
    }
    let (max_file_edits, churn_files) = metrics::file_churn(&files);
    let read_files = files.values().filter(|f| f.read_count > 0).count() as i64;
    let written_files = files.values().filter(|f| f.edit_count > 0).count() as i64;

    // --- session-level state --------------------------------------------
    let (user_msg_count, compact_count, ends_on_tool, ai_title, first_prompt, started, ended, read_chars, exec_chars, write_chars) = tx
        .query_row(
            "SELECT user_msg_count, compact_count, ends_on_tool, ai_title, first_prompt, \
             started_at, ended_at, read_chars, exec_chars, write_chars FROM session WHERE kind = ?1 AND session_id = ?2",
            params![kind, session_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)? != 0,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                ))
            },
        )
        .map_err(|err| format!("read session state: {err}"))?;

    let correction_count: i64 = tx
        .query_row(
            "SELECT correction_count FROM rework WHERE kind = ?1 AND session_id = ?2",
            params![kind, session_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let turn_count = turns.len() as i64;
    let score = metrics::rework_score(tool_error_rate, correction_count, churn_files, ends_on_tool);

    let tags = metrics::work_tags(&metrics::WorkTagStats {
        tool_calls: tool_call_count,
        read_calls,
        edit_calls,
        verify_runs,
        orchestrate_calls,
        research_calls,
        tool_error_rate,
        retry_bash,
        user_msg_count,
        turn_count,
        compact_count,
        read_chars,
        exec_chars,
        write_chars,
    });
    let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".to_string());
    let goal = metrics::goal_key(ai_title.as_deref(), first_prompt.as_deref());
    let wall_ms = match (started, ended) {
        (Some(start), Some(end)) if end >= start => Some(end - start),
        _ => None,
    };

    tx.execute(
        "UPDATE session SET turn_count = ?3, cost_usd = ?4, primary_model = ?5, \
         model_count = ?6, work_tags = ?7, goal_key = ?8, read_files = ?9, \
         written_files = ?10, wall_ms = ?11 WHERE kind = ?1 AND session_id = ?2",
        params![
            kind,
            session_id,
            turn_count,
            total_cost,
            primary_model,
            families.len() as i64,
            tags_json,
            goal,
            read_files,
            written_files,
            wall_ms,
        ],
    )
    .map_err(|err| format!("update session derived: {err}"))?;

    tx.execute(
        "INSERT INTO rework (kind, session_id, tool_error_count, tool_call_count, \
         tool_error_rate, correction_count, max_file_edits, churn_files, retry_bash, \
         abandoned, score) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) \
         ON CONFLICT(kind, session_id) DO UPDATE SET \
           tool_error_count = excluded.tool_error_count, \
           tool_call_count = excluded.tool_call_count, \
           tool_error_rate = excluded.tool_error_rate, \
           max_file_edits = excluded.max_file_edits, \
           churn_files = excluded.churn_files, \
           retry_bash = excluded.retry_bash, \
           abandoned = excluded.abandoned, \
           score = excluded.score",
        params![
            kind,
            session_id,
            tool_error_count,
            tool_call_count,
            tool_error_rate,
            correction_count,
            max_file_edits,
            churn_files,
            retry_bash,
            ends_on_tool as i64,
            score,
        ],
    )
    .map_err(|err| format!("upsert rework derived: {err}"))?;

    Ok(())
}

/// Re-price every session in the database. Used after a price edit.
pub fn reprice_all(conn: &mut Connection) -> Result<usize, String> {
    let tx = conn
        .transaction()
        .map_err(|err| format!("begin reprice: {err}"))?;
    let prices = PriceTable::load(&tx)?;
    let count = reprice_all_in_transaction(&tx, &prices)?;
    tx.commit()
        .map_err(|err| format!("commit reprice: {err}"))?;
    Ok(count)
}

/// Re-price and rebuild rollups under a transaction already owned by the
/// caller. Price table updates use this so a new price cannot commit while a
/// stale ready rollup remains visible.
pub fn reprice_all_in_transaction(
    tx: &Transaction<'_>,
    prices: &PriceTable,
) -> Result<usize, String> {
    let mut sessions = Vec::new();
    {
        let mut stmt = tx
            .prepare("SELECT kind, session_id FROM session")
            .map_err(|err| format!("prepare session list: {err}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|err| format!("list sessions: {err}"))?;
        for row in rows {
            sessions.push(row.map_err(|err| format!("session row: {err}"))?);
        }
    }
    for (kind, session_id) in &sessions {
        recompute_session(tx, kind, session_id, prices)?;
    }
    rollup::mark_all_dirty(tx)?;
    rollup::rebuild_dirty(tx)?;
    Ok(sessions.len())
}
