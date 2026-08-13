//! Spec-backed F3 session summarisation.
//!
//! Raw transcripts are reopened only while preparing one bounded prompt.  The
//! index stays compact, while summaries retain the evidence needed to explain
//! an outcome and any rework.

use std::collections::{HashMap, HashSet};
use std::env;
#[cfg(test)]
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ailog::ResolvedRange;

pub const DEFAULT_BATCH_SIZE: u32 = 50;
pub const MIN_BATCH_SIZE: u32 = 1;
pub const MAX_BATCH_SIZE: u32 = 100;
pub const SESSION_TIMEOUT: Duration = Duration::from_secs(120);
pub const PROMPT_VERSION: i64 = 2;
pub const DEFAULT_SCOPE_DAYS: u32 = 7;
const RETRY_DELAY_MS: i64 = 15 * 60 * 1000;
const MAX_ATTEMPTS: i64 = 3;
const INPUT_LIMIT: usize = 12_000;
const MAX_CONCURRENCY: usize = 2;
const PROMPT: &str = include_str!("prompts/summarize_v2_ja.txt");
const MARKER: &str = "[mycmux-ailog-summarizer]";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummarizeProgress {
    pub phase: String,
    pub sessions_done: usize,
    pub sessions_total: usize,
    pub sessions_remaining: usize,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummarizeReport {
    pub sessions_total: usize,
    pub sessions_done: usize,
    pub sessions_remaining: usize,
    pub cancelled: bool,
    pub errors: Vec<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
}

pub type ProgressSink = Arc<dyn Fn(SummarizeProgress) + Send + Sync>;
pub type ChildRegistry = Arc<Mutex<HashMap<u32, Child>>>;

#[derive(Debug, Clone)]
struct PendingSession {
    kind: String,
    session_id: String,
    source_path: Option<String>,
    ai_title: Option<String>,
    first_prompt: Option<String>,
    turn_count: i64,
    compact_count: i64,
    wall_ms: Option<i64>,
    cost_usd: f64,
}

#[derive(Debug, Clone, Serialize)]
struct InputSession {
    id: String,
    material: String,
    truncated: bool,
}

#[derive(Debug, Deserialize)]
struct OutputResult {
    id: String,
    goal: String,
    goal_cluster: String,
    outcome: String,
    #[serde(default)]
    findings: Vec<OutputFinding>,
    #[serde(default)]
    rework: OutputRework,
    #[serde(default)]
    cost_note: String,
    confidence: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct OutputFinding {
    text: String,
    kind: String,
}

#[derive(Debug, Default, Deserialize)]
struct OutputRework {
    #[serde(default)]
    happened: bool,
    #[serde(default)]
    cause: String,
    #[serde(default)]
    category: String,
}

#[derive(Debug, Clone)]
struct ValidResult {
    id_mismatch: bool,
    goal: String,
    cluster: String,
    outcome: String,
    findings: Vec<OutputFinding>,
    rework_happened: bool,
    rework_cause: String,
    rework_category: String,
    cost_note: String,
    confidence: String,
}

#[derive(Default)]
struct TranscriptMaterial {
    user: Vec<String>,
    errors: Vec<String>,
    assistant_last: Option<String>,
    bash: Vec<String>,
}

pub fn clamp_batch_size(value: Option<u32>) -> u32 {
    value
        .unwrap_or(DEFAULT_BATCH_SIZE)
        .clamp(MIN_BATCH_SIZE, MAX_BATCH_SIZE)
}

pub fn estimate_pending(
    conn: &Connection,
    batch_size: u32,
    force: bool,
    range: ResolvedRange,
) -> Result<(usize, usize), String> {
    let total = pending_count(conn, force, range)?;
    // Never reopen every transcript just to produce an estimate.  The caller
    // needs a prompt count before it starts, not a multi-gigabyte preview.
    let _ = batch_size;
    Ok((total, 0))
}

pub async fn run_summarize(
    db_path: PathBuf,
    batch_size: u32,
    force: bool,
    range: ResolvedRange,
    ai: crate::ai::AiConfig,
    cancel: Arc<AtomicBool>,
    children: ChildRegistry,
    progress: Option<ProgressSink>,
) -> Result<SummarizeReport, String> {
    tokio::task::spawn_blocking(move || {
        run_summarize_blocking(
            db_path, batch_size, force, range, ai, cancel, children, progress,
        )
    })
    .await
    .map_err(|err| format!("summarizer task: {err}"))?
}

/// Summarise exactly one session without acquiring the dashboard batch gate.
pub async fn run_summarize_one(db_path: PathBuf, kind: String, session_id: String, ai: crate::ai::AiConfig) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = crate::ailog::open_db(&db_path)?;
        let session = conn.query_row(
            "SELECT s.kind, s.session_id, sf.path, s.ai_title, s.first_prompt, s.turn_count, s.compact_count, s.wall_ms, s.cost_usd FROM session s LEFT JOIN source_file sf ON sf.kind=s.kind AND sf.session_id=s.session_id WHERE s.kind=?1 AND s.session_id=?2 ORDER BY sf.last_indexed DESC LIMIT 1",
            params![kind, session_id], pending_row,
        ).map_err(|err| format!("session for summary not found: {err}"))?;
        let input = build_input(&conn, &session)?;
        let cancel = AtomicBool::new(false);
        let children: ChildRegistry = Arc::new(Mutex::new(HashMap::new()));
        let result = execute_session(&input, &ai, &cancel, &children)
            .and_then(|raw| validate_output(&raw, &input.id));
        match result {
            Ok(result) => upsert_result(&mut conn, &session, &result, &ai),
            Err(error) => {
                crate::diag_warn!("ailog", "single summary {}/{} failed: {error}", session.kind, session.session_id);
                save_parse_error(&mut conn, &session, &error)?;
                Err(error)
            }
        }
    }).await.map_err(|err| format!("single summary worker: {err}"))?
}

fn run_summarize_blocking(
    db_path: PathBuf,
    batch_size: u32,
    force: bool,
    range: ResolvedRange,
    ai: crate::ai::AiConfig,
    cancel: Arc<AtomicBool>,
    children: ChildRegistry,
    progress: Option<ProgressSink>,
) -> Result<SummarizeReport, String> {
    let started = Instant::now();
    let mut conn = crate::ailog::open_db(&db_path)?;
    let total = pending_count(&conn, force, range)?;
    let mut report = SummarizeReport {
        sessions_total: total,
        sessions_remaining: total,
        ..Default::default()
    };
    let mut failed = HashSet::new();
    emit(&progress, "running", &report, started);

    while !cancel.load(Ordering::SeqCst) {
        let batch = fetch_pending(&conn, batch_size as usize, force, range, &failed)?;
        if batch.is_empty() {
            break;
        }
        let inputs = batch
            .into_iter()
            .map(|session| build_input(&conn, &session).map(|input| (session, input)))
            .collect::<Result<Vec<_>, _>>()?;
        for group in inputs.chunks(MAX_CONCURRENCY) {
            if cancel.load(Ordering::SeqCst) {
                break;
            }
            let results = std::thread::scope(|scope| {
                let workers = group
                    .iter()
                    .map(|(session, input)| {
                        let worker_cancel = cancel.clone();
                        let worker_children = children.clone();
                        let worker_ai = ai.clone();
                        scope.spawn(move || {
                            let result = execute_session(input, &worker_ai, &worker_cancel, &worker_children)
                                .and_then(|raw| {
                                    validate_output(&raw, &input.id).map_err(|err| {
                                        format!(
                                            "{err}; raw: {}",
                                            crate::ailog::truncate_chars(&raw, 500)
                                        )
                                    })
                                });
                            (session, result)
                        })
                    })
                    .collect::<Vec<_>>();
                workers
                    .into_iter()
                    .map(|worker| {
                        worker
                            .join()
                            .map_err(|_| "summarizer worker panicked".to_string())
                    })
                    .collect::<Result<Vec<_>, _>>()
            })?;
            for (session, result) in results {
                match result {
                    Ok(result) => {
                        upsert_result(&mut conn, session, &result, &ai)?;
                        report.sessions_done += 1;
                    }
                    Err(error) => {
                        save_parse_error(&mut conn, session, &error)?;
                        failed.insert(key(session));
                        report
                            .errors
                            .push(format!("{}/{}: {error}", session.kind, session.session_id));
                    }
                }
                report.sessions_remaining = pending_count(&conn, force, range)?;
                emit(&progress, "running", &report, started);
            }
        }
    }
    report.cancelled = cancel.load(Ordering::SeqCst);
    report.sessions_remaining = pending_count(&conn, force, range)?;
    let (input_tokens, output_tokens) = conn.query_row(
        "SELECT COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0) FROM summary WHERE prompt_version = ?1",
        [PROMPT_VERSION], |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap_or((0, 0));
    report.input_tokens = input_tokens;
    report.output_tokens = output_tokens;
    emit(&progress, "done", &report, started);
    Ok(report)
}

fn key(entry: &PendingSession) -> String {
    format!("{}\0{}", entry.kind, entry.session_id)
}

fn emit(progress: &Option<ProgressSink>, phase: &str, report: &SummarizeReport, started: Instant) {
    if let Some(sink) = progress {
        sink(SummarizeProgress {
            phase: phase.to_string(),
            sessions_done: report.sessions_done,
            sessions_total: report.sessions_total,
            sessions_remaining: report.sessions_remaining,
            elapsed_ms: started.elapsed().as_millis() as u64,
        });
    }
}

fn pending_where(force: bool) -> &'static str {
    if force {
        "COALESCE(s.origin, 'unknown') <> 'ailog-internal'"
    } else {
        "COALESCE(s.origin, 'unknown') <> 'ailog-internal' AND s.is_sidechain=0 AND s.turn_count>=3 AND EXISTS (SELECT 1 FROM source_file sf WHERE sf.kind=s.kind AND sf.session_id=s.session_id) AND (x.prompt_version IS NULL OR x.prompt_version < ?3 OR (x.parse_error IS NOT NULL AND COALESCE(x.attempt_count, 0) < ?4 AND COALESCE(x.last_error_at, x.created_at, 0) <= ?5))"
    }
}

pub fn pending_count(
    conn: &Connection,
    force: bool,
    range: ResolvedRange,
) -> Result<usize, String> {
    let sql = format!("SELECT COUNT(*) FROM session s LEFT JOIN summary x ON x.kind=s.kind AND x.session_id=s.session_id WHERE s.started_at >= ?1 AND s.started_at <= ?2 AND {}", pending_where(force));
    let count = if force {
        conn.query_row(&sql, params![range.from, range.to], |row| {
            row.get::<_, i64>(0)
        })
    } else {
        conn.query_row(
            &sql,
            params![
                range.from,
                range.to,
                PROMPT_VERSION,
                MAX_ATTEMPTS,
                chrono::Utc::now().timestamp_millis() - RETRY_DELAY_MS
            ],
            |row| row.get::<_, i64>(0),
        )
    };
    count
        .map(|value| value.max(0) as usize)
        .map_err(|err| format!("count pending summaries: {err}"))
}

fn fetch_pending(
    conn: &Connection,
    limit: usize,
    force: bool,
    range: ResolvedRange,
    failed: &HashSet<String>,
) -> Result<Vec<PendingSession>, String> {
    let sql = format!(
        "SELECT s.kind, s.session_id, sf.path, s.ai_title, s.first_prompt, s.turn_count, s.compact_count, s.wall_ms, s.cost_usd \
         FROM session s LEFT JOIN summary x ON x.kind=s.kind AND x.session_id=s.session_id \
         LEFT JOIN source_file sf ON sf.kind=s.kind AND sf.session_id=s.session_id \
         WHERE s.started_at >= ?1 AND s.started_at <= ?2 AND {} ORDER BY s.started_at DESC, s.session_id DESC LIMIT ?{}", pending_where(force), if force { "3" } else { "6" });
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|err| format!("prepare pending summaries: {err}"))?;
    let rows = if force {
        stmt.query_map(params![range.from, range.to, limit as i64], pending_row)
    } else {
        stmt.query_map(
            params![
                range.from,
                range.to,
                PROMPT_VERSION,
                MAX_ATTEMPTS,
                chrono::Utc::now().timestamp_millis() - RETRY_DELAY_MS,
                limit as i64
            ],
            pending_row,
        )
    }
    .map_err(|err| format!("query pending summaries: {err}"))?;
    let mut out = Vec::new();
    for row in rows {
        let entry = row.map_err(|err| format!("read pending summary: {err}"))?;
        if !failed.contains(&key(&entry)) {
            out.push(entry);
        }
    }
    Ok(out)
}

fn pending_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PendingSession> {
    Ok(PendingSession {
        kind: row.get(0)?,
        session_id: row.get(1)?,
        source_path: row.get(2)?,
        ai_title: row.get(3)?,
        first_prompt: row.get(4)?,
        turn_count: row.get(5)?,
        compact_count: row.get(6)?,
        wall_ms: row.get(7)?,
        cost_usd: row.get(8)?,
    })
}

fn build_input(conn: &Connection, session: &PendingSession) -> Result<InputSession, String> {
    let raw = session
        .source_path
        .as_deref()
        .map(read_transcript_material)
        .transpose()?
        .unwrap_or_default();
    let mut parts = Vec::new();
    for value in raw.user {
        parts.push(("ユーザー発話", crate::ailog::truncate_chars(&value, 500)));
    }
    for value in raw.errors.into_iter().take(10) {
        parts.push((
            "エラー tool_result",
            crate::ailog::truncate_chars(&value, 300),
        ));
    }
    let churn = churn_files(conn, session)?;
    if !churn.is_empty() {
        parts.push(("3回以上編集したファイル", churn));
    }
    if !raw.bash.is_empty() {
        parts.push(("失敗後に再実行された Bash", raw.bash.join(", ")));
    }
    if let Some(last) = raw.assistant_last {
        parts.push((
            "最終アシスタントメッセージ",
            crate::ailog::truncate_chars(&last, 1500),
        ));
    }
    let tools = tool_stats(conn, session)?;
    if !tools.is_empty() {
        parts.push(("ツール統計", tools));
    }
    let quantitative = quantitative(conn, session)?;
    parts.push(("定量値", quantitative));
    if let Some(title) = session
        .ai_title
        .as_deref()
        .or(session.first_prompt.as_deref())
    {
        parts.push(("補足タイトル", crate::ailog::truncate_chars(title, 300)));
    }
    let mut material = String::new();
    let mut truncated = false;
    for (heading, body) in parts {
        let section = format!("\n## {heading}\n{body}\n");
        let remaining = INPUT_LIMIT.saturating_sub(material.chars().count());
        if remaining == 0 {
            truncated = true;
            break;
        }
        if section.chars().count() > remaining {
            material.push_str(&crate::ailog::truncate_chars(&section, remaining));
            truncated = true;
            break;
        }
        material.push_str(&section);
    }
    Ok(InputSession {
        id: session.session_id.clone(),
        material,
        truncated,
    })
}

fn churn_files(conn: &Connection, s: &PendingSession) -> Result<String, String> {
    let mut stmt = conn.prepare("SELECT path, edit_count FROM file_touch WHERE kind=?1 AND session_id=?2 AND edit_count>=3 ORDER BY edit_count DESC, path").map_err(|err| format!("prepare churn files: {err}"))?;
    let rows = stmt
        .query_map(params![s.kind, s.session_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })
        .map_err(|err| format!("read churn files: {err}"))?;
    rows.map(|r| r.map(|(path, count)| format!("{path} ({count}回)")))
        .collect::<Result<Vec<_>, _>>()
        .map(|v| v.join("\n"))
        .map_err(|err| format!("churn row: {err}"))
}

fn tool_stats(conn: &Connection, s: &PendingSession) -> Result<String, String> {
    let mut stmt = conn.prepare("SELECT name, COUNT(*), COALESCE(SUM(is_error),0) FROM tool_event WHERE kind=?1 AND session_id=?2 GROUP BY name ORDER BY COUNT(*) DESC").map_err(|err| format!("prepare tool stats: {err}"))?;
    let rows = stmt
        .query_map(params![s.kind, s.session_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(|err| format!("read tool stats: {err}"))?;
    rows.map(|r| r.map(|(name, calls, errors)| format!("{name}: {calls}回 / エラー {errors}回")))
        .collect::<Result<Vec<_>, _>>()
        .map(|v| v.join("\n"))
        .map_err(|err| format!("tool stat row: {err}"))
}

fn quantitative(conn: &Connection, s: &PendingSession) -> Result<String, String> {
    let (input, output, duration): (i64, i64, i64) = conn.query_row("SELECT COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), COALESCE(SUM(duration_ms),0) FROM turn WHERE kind=?1 AND session_id=?2", params![s.kind, s.session_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(|err| format!("read quantitative values: {err}"))?;
    Ok(format!("入力 {input} tokens / 出力 {output} tokens / コスト ${:.4} / ターン {} / compact {} / 所要 {}ms", s.cost_usd, s.turn_count, s.compact_count, s.wall_ms.unwrap_or(duration)))
}

fn read_transcript_material(path: &str) -> Result<TranscriptMaterial, String> {
    // Material is evidence for a prompt, not an unbounded transcript cache.
    // Read JSONL lossily under the same hard budget on every platform so a
    // malformed or very large source cannot make a summarisation worker spike.
    const MATERIAL_BYTES: u64 = 8 * 1024 * 1024;
    const MATERIAL_LINES: u64 = 200_000;
    let mut text = String::new();
    crate::ailog::jsonl::for_each_line(
        std::path::Path::new(path),
        crate::ailog::jsonl::Budget { max_bytes: MATERIAL_BYTES, max_lines: MATERIAL_LINES },
        |line| {
            text.push_str(line);
            std::ops::ControlFlow::Continue(())
        },
    )?;
    if text
        .lines()
        .find_map(|line| serde_json::from_str::<Value>(line).ok())
        .and_then(|value| {
            value
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .as_deref()
        == Some("session_meta")
    {
        let material = crate::ailog::parse_codex::extract_material(&text);
        return Ok(TranscriptMaterial {
            user: material.user,
            errors: material.errors,
            assistant_last: material.assistant_last,
            bash: Vec::new(),
        });
    }
    let mut out = TranscriptMaterial::default();
    let mut errors = HashSet::new();
    let mut bash_calls: HashMap<String, String> = HashMap::new();
    let mut failed_bash = HashSet::new();
    let mut retry_seen = HashSet::new();
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let ty = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let message = value.get("message").unwrap_or(&Value::Null);
        if ty == "user" {
            for block in text_blocks(message.get("content")) {
                if !block.starts_with(MARKER) {
                    out.user.push(block);
                }
            }
            if let Some(blocks) = message.get("content").and_then(Value::as_array) {
                for block in blocks {
                    if block.get("type").and_then(Value::as_str) == Some("tool_result")
                        && block
                            .get("is_error")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                    {
                        for excerpt in text_blocks(block.get("content")) {
                            if errors.insert(excerpt.clone()) {
                                out.errors.push(excerpt);
                            }
                        }
                        if let Some(call_id) = block.get("tool_use_id").and_then(Value::as_str) {
                            if let Some(word) = bash_calls.get(call_id) {
                                failed_bash.insert(word.clone());
                            }
                        }
                    }
                }
            }
        } else if ty == "assistant" {
            let text = text_blocks(message.get("content")).join("\n");
            if !text.trim().is_empty() {
                out.assistant_last = Some(text);
            }
            if let Some(blocks) = message.get("content").and_then(Value::as_array) {
                for block in blocks {
                    if block.get("type").and_then(Value::as_str) == Some("tool_use")
                        && block
                            .get("name")
                            .and_then(Value::as_str)
                            .map(|name| name.eq_ignore_ascii_case("bash"))
                            .unwrap_or(false)
                    {
                        if let Some(command) = block
                            .get("input")
                            .and_then(|v| v.get("command"))
                            .and_then(Value::as_str)
                        {
                            let word = command
                                .split_whitespace()
                                .next()
                                .unwrap_or_default()
                                .to_string();
                            if let Some(call_id) = block.get("id").and_then(Value::as_str) {
                                bash_calls.insert(call_id.to_string(), word.clone());
                            }
                            if !word.is_empty()
                                && failed_bash.contains(&word)
                                && retry_seen.insert(word.clone())
                            {
                                out.bash.push(word);
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(out)
}

fn text_blocks(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(text)) => vec![text.trim().to_string()]
            .into_iter()
            .filter(|text| !text.is_empty())
            .collect(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| {
                block
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .map(str::to_string)
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn execute_session(
    input: &InputSession,
    ai: &crate::ai::AiConfig,
    cancel: &AtomicBool,
    children: &ChildRegistry,
) -> Result<String, String> {
    let payload =
        serde_json::to_string(input).map_err(|err| format!("encode summary input: {err}"))?;
    let prompt = format!("{MARKER}\n{PROMPT}\n{payload}");
    let cwd = env::current_dir().map_err(|err| format!("summary working directory: {err}"))?;
    let mut command = crate::ai::build_command(ai, env::vars());
    command.current_dir(cwd);
    let mut child = command
        .spawn()
        .map_err(|err| format!("start AI summarizer: {err}"))?;
    // Take (not borrow) stdin so it drops after the write; the AI command reads
    // "-" until EOF and never starts while the pipe stays open.
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .map_err(|err| format!("write summarizer stdin: {err}"))?;
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let pid = child.id();
    let mut child = Some(child);
    let cancelled_before_register = {
        let mut guard = children.lock().unwrap_or_else(|err| err.into_inner());
        if cancel.load(Ordering::SeqCst) {
            true
        } else {
            guard.insert(pid, child.take().expect("child not yet registered"));
            false
        }
    };
    if cancelled_before_register {
        stop_child_tree(child.expect("cancelled child"));
        return Err("summarizer cancelled".to_string());
    }
    let started = Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) || started.elapsed() >= SESSION_TIMEOUT {
            if let Some(running) = children
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .remove(&pid)
            {
                stop_child_tree(running);
            }
            return Err(if cancel.load(Ordering::SeqCst) {
                "summarizer cancelled".to_string()
            } else {
                "summarizer timed out after 120 seconds".to_string()
            });
        }
        let finished = {
            let mut guard = children.lock().unwrap_or_else(|err| err.into_inner());
            guard
                .get_mut(&pid)
                .map(|running| running.try_wait())
                .transpose()
                .map_err(|err| format!("wait summarizer: {err}"))?
        };
        if let Some(status) = finished.flatten() {
            let _ = children
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .remove(&pid);
            let mut stdout_bytes = Vec::new();
            let mut stderr_bytes = Vec::new();
            if let Some(mut handle) = stdout {
                use std::io::Read;
                let _ = handle.read_to_end(&mut stdout_bytes);
            }
            if let Some(mut handle) = stderr {
                use std::io::Read;
                let _ = handle.read_to_end(&mut stderr_bytes);
            }
            let stdout_text = String::from_utf8_lossy(&stdout_bytes).into_owned();
            let stderr_text = String::from_utf8_lossy(&stderr_bytes).into_owned();
            if !status.success() {
                return Err(format!(
                    "summarizer exited {status}: {}",
                    stderr_text.trim()
                ));
            }
            return Ok(stdout_text);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

pub fn stop_child_tree(mut child: Child) {
    let mut taskkill = Command::new("taskkill");
    taskkill.args(["/PID", &child.id().to_string(), "/T", "/F"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        taskkill.creation_flags(crate::util::process::CREATE_NO_WINDOW);
    }
    let _ = taskkill.status();
    let _ = child.kill();
    let _ = child.wait();
}

fn validate_output(raw: &str, expected_id: &str) -> Result<ValidResult, String> {
    let value = extract_json(raw)
        .ok_or_else(|| "summarizer output contained no JSON object".to_string())?;
    let parsed: OutputResult =
        serde_json::from_str(value).map_err(|err| format!("parse summarizer JSON: {err}"))?;
    let id_mismatch = parsed.id != expected_id;
    if id_mismatch {
        crate::diag_warn!("ailog", "summary output id mismatch: expected {expected_id}, received {}", parsed.id);
    }
    let findings = parsed
        .findings
        .into_iter()
        .filter_map(|finding| {
            let text = crate::ailog::truncate_chars(finding.text.trim(), 80);
            (!text.is_empty()).then(|| OutputFinding {
                text,
                kind: normalize_kind(&finding.kind),
            })
        })
        .take(5)
        .collect();
    let happened = parsed.rework.happened;
    Ok(ValidResult {
        id_mismatch,
        goal: crate::ailog::truncate_chars(parsed.goal.trim(), 60),
        cluster: normalize_cluster(&parsed.goal_cluster),
        outcome: normalize_outcome(&parsed.outcome),
        findings,
        rework_happened: happened,
        rework_cause: if happened {
            crate::ailog::truncate_chars(parsed.rework.cause.trim(), 80)
        } else {
            String::new()
        },
        rework_category: if happened {
            normalize_category(&parsed.rework.category)
        } else {
            "none".to_string()
        },
        cost_note: crate::ailog::truncate_chars(parsed.cost_note.trim(), 80),
        confidence: normalize_confidence(&parsed.confidence),
    })
}

fn extract_json(raw: &str) -> Option<&str> {
    let trimmed = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim();
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    (end >= start).then(|| &trimmed[start..=end])
}

pub fn normalize_cluster(value: &str) -> String {
    enum_value(
        value,
        &[
            "feature",
            "bugfix",
            "refactor",
            "investigation",
            "review",
            "test",
            "build-release",
            "ops-config",
            "docs",
            "data-analysis",
            "content-production",
            "planning",
            "other",
        ],
        "other",
    )
}
fn normalize_outcome(value: &str) -> String {
    enum_value(
        value,
        &["done", "partial", "abandoned", "unclear"],
        "unclear",
    )
}
fn normalize_kind(value: &str) -> String {
    enum_value(
        value,
        &["cause", "constraint", "gotcha", "decision", "verified"],
        "constraint",
    )
}
fn normalize_category(value: &str) -> String {
    enum_value(
        value,
        &[
            "spec-ambiguity",
            "wrong-assumption",
            "env-issue",
            "tool-failure",
            "scope-creep",
            "none",
        ],
        "none",
    )
}
fn normalize_confidence(value: &str) -> String {
    enum_value(value, &["high", "medium", "low"], "low")
}
fn enum_value(value: &str, allowed: &[&str], fallback: &str) -> String {
    let normalized = value.trim().to_ascii_lowercase();
    if allowed.contains(&normalized.as_str()) {
        normalized
    } else {
        fallback.to_string()
    }
}

fn upsert_result(
    conn: &mut Connection,
    session: &PendingSession,
    result: &ValidResult,
    ai: &crate::ai::AiConfig,
) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|err| format!("begin summary transaction: {err}"))?;
    let now = chrono::Utc::now().timestamp_millis();
    tx.execute(
        "UPDATE session SET goal_summary=?3, goal_cluster=?4 WHERE kind=?1 AND session_id=?2",
        params![
            session.kind,
            session.session_id,
            result.goal,
            result.cluster
        ],
    )
    .map_err(|err| format!("update session summary: {err}"))?;
    let findings =
        serde_json::to_string(&result.findings).map_err(|err| format!("encode findings: {err}"))?;
    let rework = serde_json::json!({"happened": result.rework_happened, "cause": result.rework_cause, "category": result.rework_category}).to_string();
    tx.execute(
        "INSERT INTO summary (kind,session_id,created_at,model_used,findings,rework_note,cost_note,goal_summary,goal_cluster,summary,cluster,model,outcome,confidence,rework_category,prompt_version,parse_error,error_kind,input_tokens,output_tokens,attempt_count,last_error_at,last_ok_at) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?8,?9,?4,?10,?11,?12,?13,NULL,CASE WHEN ?14 THEN 'id-mismatch' ELSE NULL END,0,0,0,NULL,?3) \
         ON CONFLICT(kind,session_id) DO UPDATE SET created_at=excluded.created_at, model_used=excluded.model_used, findings=excluded.findings, rework_note=excluded.rework_note, cost_note=excluded.cost_note, goal_summary=excluded.goal_summary, goal_cluster=excluded.goal_cluster, summary=excluded.summary, cluster=excluded.cluster, model=excluded.model, outcome=excluded.outcome, confidence=excluded.confidence, rework_category=excluded.rework_category, prompt_version=excluded.prompt_version, parse_error=NULL, error_kind=excluded.error_kind, last_ok_at=excluded.created_at, last_error_at=NULL",
         params![session.kind, session.session_id, now, ai.sanitized_model(), findings, rework, result.cost_note, result.goal, result.cluster, result.outcome, result.confidence, result.rework_category, PROMPT_VERSION, result.id_mismatch],
    ).map_err(|err| format!("upsert summary row: {err}"))?;
    tx.commit()
        .map_err(|err| format!("commit summary transaction: {err}"))
}

fn save_parse_error(
    conn: &mut Connection,
    session: &PendingSession,
    error: &str,
) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    let kind = if error.contains("timed out") { "timeout" } else if error.contains("cancelled") { "cancelled" } else if error.contains("start AI") { "spawn" } else if error.contains("exited") { "exit" } else { "parse" };
    conn.execute("INSERT INTO summary (kind,session_id,created_at,parse_error,error_kind,prompt_version,attempt_count,last_error_at) VALUES (?1,?2,?3,?4,?5,?6,1,?3) ON CONFLICT(kind,session_id) DO UPDATE SET created_at=excluded.created_at,parse_error=excluded.parse_error,error_kind=excluded.error_kind,prompt_version=excluded.prompt_version,attempt_count=COALESCE(summary.attempt_count,0)+1,last_error_at=excluded.last_error_at", params![session.kind, session.session_id, now, crate::ailog::truncate_chars(error, 500), kind, PROMPT_VERSION]).map_err(|err| format!("save parse error: {err}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const ALL_RANGE: ResolvedRange = ResolvedRange {
        from: i64::MIN / 4,
        to: i64::MAX / 4,
    };

    fn insert_eligible_session(conn: &Connection, id: &str, started_at: i64) {
        conn.execute(
            "INSERT INTO session(kind, session_id, origin, started_at, is_sidechain, turn_count) VALUES ('codex', ?1, 'unknown', ?2, 0, 3)",
            params![id, started_at],
        )
        .expect("eligible session");
        conn.execute(
            "INSERT INTO source_file(path, kind, size_bytes, mtime_ns, parsed_bytes, parsed_lines, session_id, last_indexed) VALUES (?1, 'codex', 0, 0, 0, 0, ?2, 0)",
            params![format!("C:/test/{id}.jsonl"), id],
        )
        .expect("eligible source file");
    }
    #[test]
    fn enums_round_to_fixed_values() {
        assert_eq!(normalize_cluster("教材"), "other");
        assert_eq!(normalize_outcome("x"), "unclear");
        assert_eq!(normalize_kind("x"), "constraint");
        assert_eq!(normalize_category("x"), "none");
        assert_eq!(normalize_confidence("x"), "low");
    }
    #[test]
    fn json_extraction_accepts_prose_and_fences() {
        assert_eq!(
            extract_json("text ```json\n{\"a\":1}\n```"),
            Some("{\"a\":1}")
        );
    }

    #[test]
    fn output_with_one_character_id_mismatch_is_accepted() {
        let raw = r#"{"id":"session-abd","goal":"goal","goal_cluster":"other","outcome":"done","findings":[],"rework":{"happened":false},"cost_note":"","confidence":"high"}"#;
        let result = validate_output(raw, "session-abc").expect("accepted output");
        assert!(result.id_mismatch);
        assert_eq!(result.goal, "goal");
    }
    #[test]
    fn input_limit_keeps_higher_priority_material() {
        let mut text = String::new();
        for _ in 0..30 {
            text.push_str("x".repeat(500).as_str());
        }
        let mut material = String::new();
        for part in [text, "lower".to_string()] {
            let left = INPUT_LIMIT.saturating_sub(material.chars().count());
            material.push_str(&crate::ailog::truncate_chars(&part, left));
        }
        assert_eq!(material.chars().count(), INPUT_LIMIT);
        assert!(!material.contains("lower"));
    }

    #[test]
    fn prompt_version_selects_old_rows_unless_forced() {
        let conn = Connection::open_in_memory().expect("memory database");
        crate::ailog::schema::init(&conn).expect("schema");
        insert_eligible_session(&conn, "s", 1);
        conn.execute("INSERT INTO summary(kind, session_id, created_at, prompt_version) VALUES ('codex', 's', 1, 1)", []).expect("old summary");
        assert_eq!(
            pending_count(&conn, false, ALL_RANGE).expect("old pending"),
            1
        );
        conn.execute("UPDATE summary SET prompt_version=?1", [PROMPT_VERSION])
            .expect("current summary");
        assert_eq!(
            pending_count(&conn, false, ALL_RANGE).expect("current skipped"),
            0
        );
        assert_eq!(
            pending_count(&conn, true, ALL_RANGE).expect("force includes current"),
            1
        );
    }

    #[test]
    fn current_parse_errors_become_pending_after_the_retry_window() {
        let conn = Connection::open_in_memory().expect("memory database");
        crate::ailog::schema::init(&conn).expect("schema");
        insert_eligible_session(&conn, "retry", 1);
        conn.execute("INSERT INTO summary(kind, session_id, created_at, prompt_version, parse_error, attempt_count, last_error_at) VALUES ('codex', 'retry', 1, ?1, 'failed', 1, 1)", [PROMPT_VERSION]).expect("failed summary");
        assert_eq!(
            pending_count(&conn, false, ALL_RANGE).expect("retry pending"),
            1
        );
    }

    #[test]
    fn pending_scope_applies_to_count_and_fetch() {
        let conn = Connection::open_in_memory().expect("memory database");
        crate::ailog::schema::init(&conn).expect("schema");
        let now = 2_000_000_000_000_i64;
        for (id, age_days) in [("six", 6), ("eight", 8), ("thirty_one", 31)] {
            insert_eligible_session(&conn, id, now - age_days * 86_400_000);
        }
        let seven_days = ResolvedRange {
            from: now - 7 * 86_400_000,
            to: now,
        };
        let thirty_days = ResolvedRange {
            from: now - 30 * 86_400_000,
            to: now,
        };
        assert_eq!(
            pending_count(&conn, false, seven_days).expect("7 day count"),
            1
        );
        assert_eq!(
            pending_count(&conn, false, thirty_days).expect("30 day count"),
            2
        );
        assert_eq!(
            pending_count(&conn, false, ALL_RANGE).expect("all count"),
            3
        );
        let seven =
            fetch_pending(&conn, 10, false, seven_days, &HashSet::new()).expect("7 day fetch");
        assert_eq!(
            seven
                .iter()
                .map(|entry| entry.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["six"]
        );
    }

    #[test]
    fn default_scope_excludes_sidechains_but_force_includes_them() {
        let conn = Connection::open_in_memory().expect("memory database");
        crate::ailog::schema::init(&conn).expect("schema");
        insert_eligible_session(&conn, "main", 1);
        conn.execute(
            "INSERT INTO session(kind, session_id, origin, started_at, is_sidechain, turn_count) VALUES ('codex', 'sidechain', 'unknown', 1, 1, 3)",
            [],
        )
        .expect("sidechain session");
        conn.execute(
            "INSERT INTO source_file(path, kind, size_bytes, mtime_ns, parsed_bytes, parsed_lines, session_id, last_indexed) VALUES ('C:/test/sidechain.jsonl', 'codex', 0, 0, 0, 0, 'sidechain', 0)",
            [],
        )
        .expect("sidechain source file");

        assert_eq!(pending_count(&conn, false, ALL_RANGE).expect("default scope"), 1);
        assert_eq!(pending_count(&conn, true, ALL_RANGE).expect("force scope"), 2);
    }

    #[test]
    fn retry_pending_excludes_recent_exhausted_and_successful_rows() {
        let conn = Connection::open_in_memory().expect("memory database");
        crate::ailog::schema::init(&conn).expect("schema");
        let now = chrono::Utc::now().timestamp_millis();
        for id in ["old_error", "recent_error", "exhausted_error", "successful"] {
            insert_eligible_session(&conn, id, now);
        }
        for (id, error, attempts, error_at) in [
            ("old_error", Some("failed"), 1, now - RETRY_DELAY_MS - 1),
            ("recent_error", Some("failed"), 1, now),
            (
                "exhausted_error",
                Some("failed"),
                MAX_ATTEMPTS,
                now - RETRY_DELAY_MS - 1,
            ),
            ("successful", None, 1, now - RETRY_DELAY_MS - 1),
        ] {
            conn.execute("INSERT INTO summary(kind, session_id, created_at, prompt_version, parse_error, attempt_count, last_error_at) VALUES ('codex', ?1, ?2, ?3, ?4, ?5, ?6)", params![id, now, PROMPT_VERSION, error, attempts, error_at]).expect("summary");
        }
        let range = ResolvedRange {
            from: now - 1,
            to: now + 1,
        };
        assert_eq!(
            pending_count(&conn, false, range).expect("only old error retries"),
            1
        );
    }

    #[test]
    fn old_prompt_parse_error_obeys_retry_window_and_attempt_limit_after_save() {
        let mut conn = Connection::open_in_memory().expect("memory database");
        crate::ailog::schema::init(&conn).expect("schema");
        let now = chrono::Utc::now().timestamp_millis();
        insert_eligible_session(&conn, "old-retry", now);
        conn.execute(
            "INSERT INTO summary(kind, session_id, created_at, prompt_version, parse_error, attempt_count, last_error_at) VALUES ('codex', 'old-retry', ?1, ?2, 'old failure', 1, ?1)",
            params![now, PROMPT_VERSION - 1],
        )
        .expect("old failed summary");
        let range = ResolvedRange {
            from: now - 1,
            to: now + 1,
        };
        assert_eq!(
            pending_count(&conn, false, range).expect("old prompt is pending"),
            1
        );

        let session = PendingSession {
            kind: "codex".to_string(),
            session_id: "old-retry".to_string(),
            source_path: None,
            ai_title: None,
            first_prompt: None,
            turn_count: 0,
            compact_count: 0,
            wall_ms: None,
            cost_usd: 0.0,
        };
        save_parse_error(&mut conn, &session, "new failure").expect("save failure");
        let (version, attempts, last_error_at): (i64, i64, i64) = conn
            .query_row(
                "SELECT prompt_version, attempt_count, last_error_at FROM summary WHERE kind='codex' AND session_id='old-retry'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("saved retry state");
        assert_eq!(version, PROMPT_VERSION);
        assert_eq!(attempts, 2);
        assert!(last_error_at >= now);
        assert_eq!(
            pending_count(&conn, false, range).expect("recent failure waits"),
            0
        );

        conn.execute(
            "UPDATE summary SET last_error_at=?1 WHERE kind='codex' AND session_id='old-retry'",
            [chrono::Utc::now().timestamp_millis() - RETRY_DELAY_MS - 1],
        )
        .expect("expire retry window");
        assert_eq!(
            pending_count(&conn, false, range).expect("expired failure retries"),
            1
        );
        conn.execute(
            "UPDATE summary SET attempt_count=?1 WHERE kind='codex' AND session_id='old-retry'",
            [MAX_ATTEMPTS],
        )
        .expect("exhaust attempts");
        assert_eq!(
            pending_count(&conn, false, range).expect("exhausted failure stops"),
            0
        );
    }

    #[test]
    fn upsert_result_records_configured_model() {
        let mut conn = Connection::open_in_memory().expect("memory database");
        crate::ailog::schema::init(&conn).expect("schema");
        let session = PendingSession { kind: "codex".into(), session_id: "model-test".into(), source_path: None, ai_title: None, first_prompt: None, turn_count: 0, compact_count: 0, wall_ms: None, cost_usd: 0.0 };
        let result = ValidResult { id_mismatch: false, goal: "goal".into(), cluster: "other".into(), outcome: "done".into(), findings: vec![], rework_happened: false, rework_cause: String::new(), rework_category: "none".into(), cost_note: String::new(), confidence: "high".into() };
        let ai = crate::ai::AiConfig { provider: crate::ai::AiProvider::Codex, model: "configured-test-model".into(), enabled: true };
        upsert_result(&mut conn, &session, &result, &ai).expect("upsert");
        let model: String = conn.query_row("SELECT model_used FROM summary WHERE kind=?1 AND session_id=?2", params![session.kind, session.session_id], |row| row.get(0)).expect("model");
        assert_eq!(model, "configured-test-model");
    }

    #[test]
    fn codex_rollout_material_keeps_user_answer_and_error() {
        let path =
            std::env::temp_dir().join(format!("ailog-material-{}.jsonl", std::process::id()));
        fs::write(&path, concat!(
            r#"{"type":"session_meta","payload":{"id":"s"}}"#, "\n",
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"fix the parser"}}"#, "\n",
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"text":"implemented the fix"}]}}"#, "\n",
            r#"{"type":"response_item","payload":{"type":"function_call_output","is_error":true,"output":"Error: denied"}}"#,
        )).expect("fixture");
        let material = read_transcript_material(&path.to_string_lossy()).expect("material");
        let _ = fs::remove_file(path);
        assert_eq!(material.user, vec!["fix the parser"]);
        assert_eq!(
            material.assistant_last.as_deref(),
            Some("implemented the fix")
        );
        assert_eq!(material.errors, vec!["Error: denied"]);
    }
}
