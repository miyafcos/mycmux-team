//! External-CLI backed, resumable goal summarisation.
//!
//! This module deliberately owns no API key. It prepares a bounded JSON batch,
//! lets the configured local command process it, then commits valid rows one
//! batch at a time so an interrupted run can resume safely.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};

pub const DEFAULT_BATCH_SIZE: u32 = 50;
pub const MIN_BATCH_SIZE: u32 = 10;
pub const MAX_BATCH_SIZE: u32 = 100;
pub const BATCH_TIMEOUT: Duration = Duration::from_secs(600);

const DEFAULT_COMMAND_TEMPLATE: &str = "codex exec --model gpt-5.6-luna -c model_reasoning_effort=max -c features.fast_mode=false --output-last-message \"{output}\" \"{prompt}\"";
const PROMPT_PREFIX: &str = "次の入力JSONファイルを読み、各セッションについて日本語40字以内・体言止めの1行要約と目的クラスタを作成してください。出力は説明やMarkdownを含めず、必ず {\\\"results\\\":[{\\\"id\\\":\\\"...\\\",\\\"summary\\\":\\\"...\\\",\\\"cluster\\\":\\\"...\\\"}]} のJSONのみです。cluster は 教材制作 / 作問 / 検収・検証 / 組版・体裁 / スライド制作 / mycmux開発 / ツール開発 / 環境整備 / 事務・案件管理 / 調査・リサーチ / 会話・相談 / その他 を優先し、必要なら新語も使えます。入力ファイル: ";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummarizerConfig {
    pub command_template: String,
}

impl Default for SummarizerConfig {
    fn default() -> Self {
        Self { command_template: DEFAULT_COMMAND_TEMPLATE.to_string() }
    }
}

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
}

pub type ProgressSink = Arc<dyn Fn(SummarizeProgress) + Send + Sync>;

#[derive(Debug, Clone, Serialize)]
struct InputBatch {
    sessions: Vec<InputSession>,
}

#[derive(Debug, Clone, Serialize)]
struct InputSession {
    id: String,
    first_prompt: String,
    ai_title: Option<String>,
    project_label: Option<String>,
    primary_model: Option<String>,
    turn_count: i64,
    top_files: Vec<String>,
}

#[derive(Debug, Clone)]
struct PendingSession {
    kind: String,
    session_id: String,
    input: InputSession,
}

#[derive(Debug, Deserialize)]
struct OutputBatch {
    results: Vec<OutputResult>,
}

#[derive(Debug, Deserialize)]
struct OutputResult {
    id: String,
    summary: String,
    cluster: String,
}

#[derive(Debug, Clone)]
struct ValidResult {
    id: String,
    summary: String,
    cluster: String,
}

pub fn config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "home directory is not available".to_string())?;
    Ok(home.join(".mycmux").join("ailog-summarizer.json"))
}

pub fn load_config() -> Result<SummarizerConfig, String> {
    let path = config_path()?;
    if !path.exists() {
        let config = SummarizerConfig::default();
        let parent = path.parent().ok_or_else(|| "summarizer config parent is unavailable".to_string())?;
        fs::create_dir_all(parent).map_err(|err| format!("create {parent:?}: {err}"))?;
        fs::write(&path, serde_json::to_string_pretty(&config).map_err(|err| format!("encode config: {err}"))?)
            .map_err(|err| format!("write {path:?}: {err}"))?;
        return Ok(config);
    }
    let text = fs::read_to_string(&path).map_err(|err| format!("read {path:?}: {err}"))?;
    serde_json::from_str(&text).map_err(|err| format!("parse {path:?}: {err}"))
}

pub fn clamp_batch_size(value: Option<u32>) -> u32 {
    value.unwrap_or(DEFAULT_BATCH_SIZE).clamp(MIN_BATCH_SIZE, MAX_BATCH_SIZE)
}

pub async fn run_summarize(
    db_path: PathBuf,
    batch_size: u32,
    cancel: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
    progress: Option<ProgressSink>,
) -> Result<SummarizeReport, String> {
    tokio::task::spawn_blocking(move || run_summarize_blocking(db_path, batch_size, cancel, child, progress))
        .await
        .map_err(|err| format!("summarizer task: {err}"))?
}

fn run_summarize_blocking(
    db_path: PathBuf,
    batch_size: u32,
    cancel: Arc<AtomicBool>,
    child_slot: Arc<Mutex<Option<Child>>>,
    progress: Option<ProgressSink>,
) -> Result<SummarizeReport, String> {
    let started = Instant::now();
    let config = load_config()?;
    let mut conn = crate::ailog::open_db(&db_path)?;
    let total = pending_count(&conn)?;
    let mut report = SummarizeReport { sessions_total: total, sessions_remaining: total, ..Default::default() };
    let mut failed = HashSet::new();
    emit(&progress, "running", &report, started);

    while !cancel.load(Ordering::SeqCst) {
        let batch = fetch_pending(&conn, batch_size as usize, &failed)?;
        if batch.is_empty() {
            break;
        }
        let mut completed = None;
        let mut last_error = None;
        for _attempt in 0..2 {
            match execute_batch(&config, &batch, &cancel, &child_slot) {
                Ok(json) => match validate_output(&json, &batch) {
                    Ok(results) => {
                        completed = Some(results);
                        break;
                    }
                    Err(err) => last_error = Some(err),
                },
                Err(err) => {
                    last_error = Some(err);
                    if cancel.load(Ordering::SeqCst) { break; }
                }
            }
        }
        if cancel.load(Ordering::SeqCst) { break; }
        match completed {
            Some(results) => {
                let written = upsert_results(&mut conn, &batch, &results)?;
                report.sessions_done += written;
                let successful: HashSet<&str> = results.iter().map(|result| result.id.as_str()).collect();
                for session in &batch {
                    if !successful.contains(session.session_id.as_str()) {
                        failed.insert(format!("{}\u{0}{}", session.kind, session.session_id));
                    }
                }
                report.sessions_remaining = pending_count(&conn)?;
            }
            None => {
                report.errors.push(last_error.unwrap_or_else(|| "batch did not produce valid JSON".to_string()));
                // Leave failed rows untouched for a later manual run, but do
                // continue with newer eligible batches in this pass.
                for session in &batch {
                    failed.insert(format!("{}\u{0}{}", session.kind, session.session_id));
                }
            }
        }
        emit(&progress, "running", &report, started);
    }
    report.cancelled = cancel.load(Ordering::SeqCst);
    report.sessions_remaining = pending_count(&conn)?;
    emit(&progress, "done", &report, started);
    Ok(report)
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

fn pending_count(conn: &Connection) -> Result<usize, String> {
    conn.query_row("SELECT COUNT(*) FROM session WHERE goal_summary IS NULL OR trim(goal_summary) = ''", [], |row| row.get::<_, i64>(0))
        .map(|value| value.max(0) as usize)
        .map_err(|err| format!("count pending summaries: {err}"))
}

fn fetch_pending(conn: &Connection, limit: usize, failed: &HashSet<String>) -> Result<Vec<PendingSession>, String> {
    let mut stmt = conn.prepare(
        "SELECT kind, session_id, first_prompt, ai_title, project_label, primary_model, turn_count \
         FROM session WHERE goal_summary IS NULL OR trim(goal_summary) = '' \
         ORDER BY started_at DESC, session_id DESC LIMIT ?1",
    ).map_err(|err| format!("prepare pending summaries: {err}"))?;
    let rows = stmt.query_map([(limit + failed.len()) as i64], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, Option<String>>(5)?, row.get::<_, i64>(6)?))
    }).map_err(|err| format!("query pending summaries: {err}"))?;
    let mut pending = Vec::new();
    for row in rows {
        let (kind, session_id, first_prompt, ai_title, project_label, primary_model, turn_count) = row.map_err(|err| format!("read pending summary: {err}"))?;
        if failed.contains(&format!("{}\u{0}{}", kind, session_id)) { continue; }
        let top_files = top_files(conn, &kind, &session_id)?;
        pending.push(PendingSession {
            kind,
            session_id: session_id.clone(),
            input: InputSession {
                id: session_id,
                first_prompt: crate::ailog::truncate_chars(first_prompt.as_deref().unwrap_or(""), 500),
                ai_title,
                project_label,
                primary_model,
                turn_count,
                top_files,
            },
        });
        if pending.len() >= limit { break; }
    }
    Ok(pending)
}

fn top_files(conn: &Connection, kind: &str, session_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn.prepare(
        "SELECT path FROM file_touch WHERE kind = ?1 AND session_id = ?2 \
         ORDER BY (edit_count + read_count) DESC, last_ts DESC, path LIMIT 5",
    ).map_err(|err| format!("prepare top files: {err}"))?;
    let rows = stmt.query_map(params![kind, session_id], |row| row.get::<_, String>(0))
        .map_err(|err| format!("query top files: {err}"))?;
    rows.map(|row| {
        let path = row.map_err(|err| format!("read top file: {err}"))?;
        Ok(Path::new(&path).file_name().and_then(|name| name.to_str()).unwrap_or(&path).to_string())
    }).collect()
}

fn execute_batch(
    config: &SummarizerConfig,
    batch: &[PendingSession],
    cancel: &AtomicBool,
    child_slot: &Arc<Mutex<Option<Child>>>,
) -> Result<String, String> {
    let dir = std::env::temp_dir().join(format!("mycmux-ailog-{}", std::process::id()));
    fs::create_dir_all(&dir).map_err(|err| format!("create batch directory: {err}"))?;
    let nonce = format!("{}-{}", chrono::Utc::now().timestamp_millis(), batch.first().map(|entry| entry.session_id.as_str()).unwrap_or("empty"));
    let input_path = dir.join(format!("input-{nonce}.json"));
    let output_path = dir.join(format!("output-{nonce}.json"));
    let payload = InputBatch { sessions: batch.iter().map(|entry| entry.input.clone()).collect() };
    fs::write(&input_path, serde_json::to_vec(&payload).map_err(|err| format!("encode batch: {err}"))?)
        .map_err(|err| format!("write input batch: {err}"))?;
    let prompt = format!("{PROMPT_PREFIX}{}", input_path.display());
    let command = render_command(&config.command_template, &input_path, &output_path, &prompt);
    let mut child = Command::new("cmd")
        .args(["/C", &command])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("start summarizer command: {err}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *child_slot.lock().unwrap_or_else(|err| err.into_inner()) = Some(child);
    let started = Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) || started.elapsed() >= BATCH_TIMEOUT {
            let mut guard = child_slot.lock().unwrap_or_else(|err| err.into_inner());
            if let Some(mut running) = guard.take() {
                let _ = Command::new("taskkill").args(["/PID", &running.id().to_string(), "/T", "/F"]).status();
                let _ = running.kill();
                let _ = running.wait();
            }
            if cancel.load(Ordering::SeqCst) { return Err("summarizer cancelled".to_string()); }
            return Err("summarizer batch timed out after 600 seconds".to_string());
        }
        let finished = {
            let mut guard = child_slot.lock().unwrap_or_else(|err| err.into_inner());
            guard.as_mut().map(|running| running.try_wait()).transpose().map_err(|err| format!("wait summarizer: {err}"))?
        };
        if let Some(status) = finished.flatten() {
            let child = child_slot.lock().unwrap_or_else(|err| err.into_inner()).take();
            let mut stdout_text = String::new();
            let mut stderr_text = String::new();
            if let Some(stdout) = stdout { use std::io::Read; let _ = stdout.take(10 * 1024 * 1024).read_to_string(&mut stdout_text); }
            if let Some(stderr) = stderr { use std::io::Read; let _ = stderr.take(10 * 1024 * 1024).read_to_string(&mut stderr_text); }
            drop(child);
            if !status.success() { return Err(format!("summarizer exited {status}: {}", stderr_text.trim())); }
            if output_path.exists() {
                return fs::read_to_string(&output_path).map_err(|err| format!("read summarizer output: {err}"));
            }
            return Ok(stdout_text);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn render_command(template: &str, input: &Path, output: &Path, prompt: &str) -> String {
    template
        .replace("{input_file}", &input.display().to_string())
        .replace("{output}", &output.display().to_string())
        .replace("{prompt}", prompt)
}

fn validate_output(raw: &str, batch: &[PendingSession]) -> Result<Vec<ValidResult>, String> {
    let parsed: OutputBatch = serde_json::from_str(raw.trim()).map_err(|err| format!("parse summarizer JSON: {err}"))?;
    let expected: HashSet<&str> = batch.iter().map(|entry| entry.session_id.as_str()).collect();
    let mut seen = HashSet::new();
    let mut valid = Vec::new();
    for result in parsed.results {
        let summary = result.summary.trim();
        if !expected.contains(result.id.as_str()) || summary.is_empty() || !seen.insert(result.id.clone()) { continue; }
        valid.push(ValidResult { id: result.id, summary: crate::ailog::truncate_chars(summary, 40), cluster: normalize_cluster(&result.cluster) });
    }
    if valid.is_empty() { return Err("summarizer output contained no valid result IDs and summaries".to_string()); }
    Ok(valid)
}

pub fn normalize_cluster(value: &str) -> String {
    value.trim().replace('\u{3000}', " ").split_whitespace().collect::<Vec<_>>().join(" ")
}

fn upsert_results(conn: &mut Connection, batch: &[PendingSession], results: &[ValidResult]) -> Result<usize, String> {
    let lookup: HashMap<&str, &PendingSession> = batch.iter().map(|entry| (entry.session_id.as_str(), entry)).collect();
    let tx = conn.transaction().map_err(|err| format!("begin summary transaction: {err}"))?;
    let now = chrono::Utc::now().timestamp_millis();
    let mut written = 0;
    for result in results {
        let Some(session) = lookup.get(result.id.as_str()) else { continue; };
        write_result(&tx, session, result, now)?;
        written += 1;
    }
    tx.commit().map_err(|err| format!("commit summary transaction: {err}"))?;
    Ok(written)
}

fn write_result(tx: &Transaction<'_>, session: &PendingSession, result: &ValidResult, now: i64) -> Result<(), String> {
    tx.execute(
        "UPDATE session SET goal_summary = ?3, goal_cluster = ?4 WHERE kind = ?1 AND session_id = ?2",
        params![session.kind, session.session_id, result.summary, result.cluster],
    ).map_err(|err| format!("update session summary: {err}"))?;
    tx.execute(
        "INSERT INTO summary (kind, session_id, created_at, model_used, goal_summary, goal_cluster, summary, cluster, model) \
         VALUES (?1, ?2, ?3, 'codex gpt-5.6-luna', ?4, ?5, ?4, ?5, 'gpt-5.6-luna') \
         ON CONFLICT(kind, session_id) DO UPDATE SET created_at=excluded.created_at, \
         model_used=excluded.model_used, goal_summary=excluded.goal_summary, goal_cluster=excluded.goal_cluster, \
         summary=excluded.summary, cluster=excluded.cluster, model=excluded.model",
        params![session.kind, session.session_id, now, result.summary, result.cluster],
    ).map_err(|err| format!("upsert summary row: {err}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(id: &str) -> PendingSession {
        PendingSession {
            kind: "codex".to_string(),
            session_id: id.to_string(),
            input: InputSession { id: id.to_string(), first_prompt: "x".to_string(), ai_title: None, project_label: None, primary_model: None, turn_count: 1, top_files: Vec::new() },
        }
    }

    #[test]
    fn output_validation_keeps_partial_valid_results_and_normalizes_cluster() {
        let long = "あ".repeat(50);
        let raw = format!(r#"{{"results":[{{"id":"a","summary":"{long}","cluster":"　ツール開発　"}},{{"id":"wrong","summary":"ignored","cluster":"その他"}},{{"id":"b","summary":"","cluster":"その他"}}]}}"#);
        let results = validate_output(&raw, &[pending("a"), pending("b")]).expect("one valid result");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].summary.chars().count(), 40);
        assert_eq!(results[0].cluster, "ツール開発");
        assert_eq!(clamp_batch_size(Some(1)), MIN_BATCH_SIZE);
        assert_eq!(clamp_batch_size(Some(999)), MAX_BATCH_SIZE);
    }

    #[test]
    fn upsert_writes_session_and_summary_for_each_valid_id() {
        let mut conn = Connection::open_in_memory().expect("memory db");
        crate::ailog::schema::init(&conn).expect("schema");
        conn.execute("INSERT INTO session (kind, session_id) VALUES ('codex', 'a')", []).expect("session");
        let batch = vec![pending("a")];
        let rows = vec![ValidResult { id: "a".to_string(), summary: "要約".to_string(), cluster: "その他".to_string() }];
        assert_eq!(upsert_results(&mut conn, &batch, &rows).expect("upsert"), 1);
        let values: (String, String) = conn.query_row("SELECT goal_summary, goal_cluster FROM session WHERE kind='codex' AND session_id='a'", [], |row| Ok((row.get(0)?, row.get(1)?))).expect("session values");
        assert_eq!(values, ("要約".to_string(), "その他".to_string()));
        let summary: String = conn.query_row("SELECT goal_summary FROM summary WHERE kind='codex' AND session_id='a'", [], |row| row.get(0)).expect("summary value");
        assert_eq!(summary, "要約");
    }
}
