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
    KIND_CLAUDE, KIND_CODEX, KIND_GROK,
};

/// Minimum gap between progress events, per spec §5.
pub const PROGRESS_THROTTLE_MS: u128 = 250;
const DERIVATION_VERSION: &str = "project-work-v2";
const MODEL_CARRY_VERSION: &str = "1";

#[derive(Debug, Clone)]
pub struct IndexOptions {
    /// Re-read every file from byte zero and discard the existing rows.
    pub full: bool,
    /// `(kind, root)` pairs. Empty means the two default roots.
    pub roots: Vec<(&'static str, PathBuf)>,
    pub db_path: PathBuf,
}

impl IndexOptions {
    pub fn new(db_path: PathBuf) -> Self {
        Self {
            full: false,
            roots: Vec::new(),
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

#[derive(Debug)]
struct FileJob {
    path: PathBuf,
    kind: &'static str,
    size: u64,
    mtime_ns: i64,
    /// Byte offset to resume from; 0 for a full read.
    start: u64,
    reset: bool,
}

enum WriteMsg {
    Chunk {
        job_path: String,
        kind: &'static str,
        size: u64,
        mtime_ns: i64,
        start: u64,
        reset: bool,
        data: ChunkData,
    },
    Failed {
        job_path: String,
        kind: &'static str,
        size: u64,
        mtime_ns: i64,
        message: String,
    },
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
    let roots = if options.roots.is_empty() {
        default_roots()
    } else {
        options.roots.clone()
    };

    // --- discovery -------------------------------------------------------
    let mut known: HashMap<String, (u64, i64, u64)> = HashMap::new();
    {
        let mut conn = crate::ailog::open_db(&options.db_path)?;
        if options.full {
            clear_all(&mut conn)?;
        } else {
            let mut stmt = conn
                .prepare("SELECT path, size_bytes, mtime_ns, parsed_bytes FROM source_file")
                .map_err(|err| format!("prepare source_file: {err}"))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)? as u64,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)? as u64,
                    ))
                })
                .map_err(|err| format!("query source_file: {err}"))?;
            for row in rows {
                let (path, size, mtime, parsed) = row.map_err(|err| format!("row: {err}"))?;
                known.insert(path, (size, mtime, parsed));
            }
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
            let previous = known.get(&key).copied();

            let (start, reset) = match previous {
                None => (0, true),
                Some((_, _, parsed)) if size < parsed => (0, true),
                Some((prev_size, prev_mtime, parsed)) => {
                    if size == parsed && size == prev_size && mtime_ns == prev_mtime {
                        skipped += 1;
                        continue;
                    }
                    if size == parsed {
                        // Nothing new to read even though the mtime moved.
                        skipped += 1;
                        continue;
                    }
                    if *kind == KIND_GROK {
                        // ACP user/tool chunks are stateful across lines. A
                        // periodic index pass may cut a turn between files, so
                        // reparse and replace the Grok session rather than
                        // losing the prefix or double-counting its metrics.
                        (0, true)
                    } else {
                        (parsed, false)
                    }
                }
            };
            bytes_total += size.saturating_sub(start);
            jobs.push(FileJob {
                path,
                kind,
                size,
                mtime_ns,
                start,
                reset,
            });
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
                 last_indexed=excluded.last_indexed, parse_error=NULL",
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

            while let Ok(message) = rx.recv() {
                let write_started = Instant::now();
                match message {
                    WriteMsg::Chunk {
                        job_path,
                        kind,
                        size,
                        mtime_ns,
                        start,
                        reset,
                        data,
                    } => {
                        if reset {
                            for session_id in data.sessions.keys() {
                                rollup::mark_session_dirty(&tx, kind, session_id)?;
                                delete_session(&tx, kind, session_id)?;
                            }
                        }
                        for chunk in data.sessions.values() {
                            apply_chunk(&tx, chunk)?;
                            touched.insert((kind.to_string(), chunk.session_id.clone()));
                        }
                        let session_id = data.sessions.keys().next().cloned();
                        source_file_upsert
                            .execute(params![
                                job_path,
                                kind,
                                size as i64,
                                mtime_ns,
                                (start + data.consumed_bytes) as i64,
                                data.lines as i64,
                                session_id,
                                chrono::Utc::now().timestamp_millis(),
                                reset,
                            ])
                            .map_err(|err| format!("write source_file: {err}"))?;
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
            drop(source_file_error);
            drop(source_file_upsert);
            for (kind, session_id) in &touched {
                recompute_session(&tx, kind, session_id, &prices)?;
                rollup::mark_session_dirty(&tx, kind, session_id)?;
            }
            let rederived = rederive_projects_and_tags_if_needed(&tx, &prices)?;
            let _carried = carry_forward_missing_models_if_needed(&tx, &prices)?;
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
            let message = match read_and_parse(&job) {
                Ok(data) => WriteMsg::Chunk {
                    job_path,
                    kind: job.kind,
                    size: job.size,
                    mtime_ns: job.mtime_ns,
                    start: job.start,
                    reset: job.reset,
                    data,
                },
                Err(message) => WriteMsg::Failed {
                    job_path,
                    kind: job.kind,
                    size: job.size,
                    mtime_ns: job.mtime_ns,
                    message,
                },
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

/// Fill `turn.model IS NULL` from the nearest non-null model in the same
/// session. Transcript files are never reread.
pub(crate) fn carry_forward_missing_models_if_needed(
    tx: &Transaction<'_>,
    prices: &PriceTable,
) -> Result<bool, String> {
    let current: Option<String> = tx
        .query_row(
            "SELECT value FROM index_state WHERE key = 'model_carry_version'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("read model_carry_version: {err}"))?;
    if current.as_deref() == Some(MODEL_CARRY_VERSION) {
        return Ok(false);
    }

    let rows = {
        let mut stmt = tx
            .prepare(
                "WITH nulls AS (
                     SELECT kind, session_id, seq
                     FROM turn
                     WHERE model IS NULL
                 ),
                 knowns AS (
                     SELECT kind, session_id, seq, model
                     FROM turn
                     WHERE model IS NOT NULL
                 )
                 SELECT n.kind, n.session_id, n.seq,
                        COALESCE(
                            (SELECT k.model FROM knowns k
                             WHERE k.kind = n.kind
                               AND k.session_id = n.session_id
                               AND k.seq < n.seq
                             ORDER BY k.seq DESC LIMIT 1),
                            (SELECT k.model FROM knowns k
                             WHERE k.kind = n.kind
                               AND k.session_id = n.session_id
                               AND k.seq > n.seq
                             ORDER BY k.seq ASC LIMIT 1)
                        ) AS carried
                 FROM nulls n",
            )
            .map_err(|err| format!("prepare model carry: {err}"))?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|err| format!("scan model carry: {err}"))?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("read model carry: {err}"))?
    };

    let mut touched: HashSet<(String, String)> = HashSet::new();
    for (kind, session_id, seq, carried) in rows {
        let Some(carried) = carried.filter(|value| !value.is_empty()) else {
            continue;
        };
        let id = price::normalize(&carried);
        tx.execute(
            "UPDATE turn SET model = ?3, model_family = ?4, model_variant = ?5 \
             WHERE kind = ?1 AND session_id = ?2 AND seq = ?6",
            params![kind, session_id, id.raw, id.family, id.variant, seq],
        )
        .map_err(|err| format!("update carried model: {err}"))?;
        touched.insert((kind, session_id));
    }

    for (kind, session_id) in &touched {
        recompute_session(tx, kind, session_id, prices)?;
        rollup::mark_session_dirty(tx, kind, session_id)?;
    }

    tx.execute(
        "INSERT INTO index_state (key, value) VALUES ('model_carry_version', ?1) \
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![MODEL_CARRY_VERSION],
    )
    .map_err(|err| format!("write model_carry_version: {err}"))?;
    Ok(true)
}

/// Read the requested byte range and hand it to the format's parser.
///
/// Only whole newline-terminated lines are consumed, so a transcript that is
/// mid-write when the indexer reaches it resumes cleanly next time instead of
/// swallowing a half-written record.
fn read_and_parse(job: &FileJob) -> Result<ChunkData, String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(&job.path).map_err(|err| format!("open: {err}"))?;
    if job.start > 0 {
        file.seek(SeekFrom::Start(job.start))
            .map_err(|err| format!("seek: {err}"))?;
    }
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer)
        .map_err(|err| format!("read: {err}"))?;

    let complete = match buffer.iter().rposition(|byte| *byte == b'\n') {
        Some(pos) => pos + 1,
        None => 0,
    };
    let text = String::from_utf8_lossy(&buffer[..complete]).into_owned();

    let stem = job
        .path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("unknown");
    let fallback = if job.kind == KIND_CODEX {
        // rollout-<iso>-<uuid> -> <uuid>
        stem.rsplit_once('-')
            .map(|_| stem.splitn(3, '-').nth(2).unwrap_or(stem))
            .unwrap_or(stem)
    } else if job.kind == KIND_GROK {
        job.path
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            .unwrap_or(stem)
    } else {
        stem
    };

    let mut data = match job.kind {
        KIND_CLAUDE => parse_claude::parse_chunk(&text, fallback),
        KIND_CODEX => parse_codex::parse_chunk(&text, fallback),
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
    Ok(data)
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
