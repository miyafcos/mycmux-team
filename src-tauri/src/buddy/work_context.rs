use crate::buddy::signal::now_ms;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_SESSION_LIMIT: usize = 12;
const HISTORY_LINE_LIMIT: usize = 160;
const ARCHIVE_LINE_LIMIT: usize = 160;
const CODEX_FILE_LIMIT: usize = 48;
const CODEX_TAIL_BYTES: u64 = 128 * 1024;
const CODEX_TAIL_LINE_LIMIT: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkContextSnapshot {
    generated_at_ms: u64,
    sessions: Vec<WorkSessionSummary>,
    sources: Vec<String>,
    errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkSessionSummary {
    agent: String,
    session_id: Option<String>,
    project_path: Option<String>,
    title: String,
    last_activity_ms: u64,
    recent_text: String,
    source_path: String,
}

#[tauri::command(async)]
pub fn load_work_context(limit: Option<usize>) -> Result<WorkContextSnapshot, String> {
    collect_work_context(limit.unwrap_or(DEFAULT_SESSION_LIMIT))
}

fn collect_work_context(limit: usize) -> Result<WorkContextSnapshot, String> {
    let home = user_home_dir();
    let mut sessions = Vec::new();
    let mut sources = Vec::new();
    let mut errors = Vec::new();

    collect_claude_archive(&home, &mut sessions, &mut sources, &mut errors);
    collect_claude_history(&home, &mut sessions, &mut sources, &mut errors);
    collect_codex_history(&home, &mut sessions, &mut sources, &mut errors);
    collect_codex_rollouts(&home, &mut sessions, &mut sources, &mut errors);

    sessions.sort_by_key(|session| std::cmp::Reverse(session.last_activity_ms));
    let mut seen = HashSet::new();
    sessions.retain(|session| {
        let key = format!(
            "{}:{}",
            session.agent,
            session
                .session_id
                .as_deref()
                .unwrap_or(session.source_path.as_str())
        );
        seen.insert(key)
    });
    sessions.truncate(limit.max(1));

    Ok(WorkContextSnapshot {
        generated_at_ms: now_ms(),
        sessions,
        sources,
        errors,
    })
}

fn collect_claude_archive(
    home: &Path,
    sessions: &mut Vec<WorkSessionSummary>,
    sources: &mut Vec<String>,
    errors: &mut Vec<String>,
) {
    let archive_dir = home.join(".claude").join("session-archive");
    let index_path = archive_dir.join("index.jsonl");
    if !index_path.exists() {
        return;
    }

    sources.push(index_path.to_string_lossy().into_owned());
    match read_recent_lines(&index_path, ARCHIVE_LINE_LIMIT) {
        Ok(lines) => {
            for line in lines {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let summary_file = value.get("summary_file").and_then(Value::as_str);
                let source_path = summary_file
                    .map(|file| archive_dir.join(file))
                    .unwrap_or_else(|| index_path.clone());
                let last_activity_ms = file_modified_ms(&source_path)
                    .or_else(|| file_modified_ms(&index_path))
                    .unwrap_or_else(now_ms);
                let first_message = value.get("first_message").and_then(Value::as_str);
                let conclusion = value.get("assistant_conclusion").and_then(Value::as_str);
                let title = preview_text(
                    first_message
                        .or(conclusion)
                        .unwrap_or("Claude Code session"),
                    96,
                );
                let recent_text = preview_text(
                    conclusion
                        .or(first_message)
                        .unwrap_or("Claude Code session"),
                    220,
                );
                sessions.push(WorkSessionSummary {
                    agent: "claude".to_string(),
                    session_id: value
                        .get("session_id")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    project_path: value.get("cwd").and_then(Value::as_str).map(str::to_string),
                    title,
                    last_activity_ms,
                    recent_text,
                    source_path: source_path.to_string_lossy().into_owned(),
                });
            }
        }
        Err(error) => errors.push(format!("{}: {error}", index_path.display())),
    }
}

fn collect_claude_history(
    home: &Path,
    sessions: &mut Vec<WorkSessionSummary>,
    sources: &mut Vec<String>,
    errors: &mut Vec<String>,
) {
    let path = home.join(".claude").join("history.jsonl");
    if !path.exists() {
        return;
    }

    sources.push(path.to_string_lossy().into_owned());
    match read_recent_lines(&path, HISTORY_LINE_LIMIT) {
        Ok(lines) => {
            let mut grouped: HashMap<String, WorkSessionSummary> = HashMap::new();
            for line in lines {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let text = value
                    .get("display")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim();
                if text.is_empty() {
                    continue;
                }
                let session_id = value.get("sessionId").and_then(Value::as_str);
                let key = session_id
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("claude-history-{}", grouped.len()));
                let timestamp_ms = value
                    .get("timestamp")
                    .and_then(Value::as_u64)
                    .unwrap_or_else(now_ms);
                grouped.insert(
                    key,
                    WorkSessionSummary {
                        agent: "claude".to_string(),
                        session_id: session_id.map(str::to_string),
                        project_path: value
                            .get("project")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        title: preview_text(text, 96),
                        last_activity_ms: timestamp_ms,
                        recent_text: preview_text(text, 220),
                        source_path: path.to_string_lossy().into_owned(),
                    },
                );
            }
            sessions.extend(grouped.into_values());
        }
        Err(error) => errors.push(format!("{}: {error}", path.display())),
    }
}

fn collect_codex_history(
    home: &Path,
    sessions: &mut Vec<WorkSessionSummary>,
    sources: &mut Vec<String>,
    errors: &mut Vec<String>,
) {
    let path = home.join(".codex").join("history.jsonl");
    if !path.exists() {
        return;
    }

    sources.push(path.to_string_lossy().into_owned());
    match read_recent_lines(&path, HISTORY_LINE_LIMIT) {
        Ok(lines) => {
            let mut grouped: HashMap<String, WorkSessionSummary> = HashMap::new();
            for line in lines {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let text = value
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim();
                if text.is_empty() {
                    continue;
                }
                let session_id = value.get("session_id").and_then(Value::as_str);
                let key = session_id
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("codex-history-{}", grouped.len()));
                let timestamp_ms = value
                    .get("ts")
                    .and_then(Value::as_u64)
                    .map(|seconds| seconds.saturating_mul(1_000))
                    .unwrap_or_else(now_ms);
                grouped.insert(
                    key,
                    WorkSessionSummary {
                        agent: "codex".to_string(),
                        session_id: session_id.map(str::to_string),
                        project_path: None,
                        title: preview_text(text, 96),
                        last_activity_ms: timestamp_ms,
                        recent_text: preview_text(text, 220),
                        source_path: path.to_string_lossy().into_owned(),
                    },
                );
            }
            sessions.extend(grouped.into_values());
        }
        Err(error) => errors.push(format!("{}: {error}", path.display())),
    }
}

fn collect_codex_rollouts(
    home: &Path,
    sessions: &mut Vec<WorkSessionSummary>,
    sources: &mut Vec<String>,
    errors: &mut Vec<String>,
) {
    let root = home.join(".codex").join("sessions");
    if !root.exists() {
        return;
    }

    sources.push(root.to_string_lossy().into_owned());
    let mut files = Vec::new();
    collect_rollout_files(&root, &mut files);
    files.sort_by(|a, b| {
        file_modified_ms(b)
            .unwrap_or_default()
            .cmp(&file_modified_ms(a).unwrap_or_default())
    });
    files.truncate(CODEX_FILE_LIMIT);

    for path in files {
        match summarize_codex_rollout(&path) {
            Ok(Some(summary)) => sessions.push(summary),
            Ok(None) => {}
            Err(error) => errors.push(format!("{}: {error}", path.display())),
        }
    }
}

fn summarize_codex_rollout(path: &Path) -> Result<Option<WorkSessionSummary>, String> {
    let Some(first_line) = read_first_line(path)? else {
        return Ok(None);
    };
    let value = serde_json::from_str::<Value>(&first_line)
        .map_err(|error| format!("failed to parse first line: {error}"))?;
    if value.get("type").and_then(Value::as_str) != Some("session_meta") {
        return Ok(None);
    }

    let payload = value.get("payload").unwrap_or(&Value::Null);
    let session_id = payload
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string);
    let project_path = payload
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::to_string);
    let recent_text = codex_rollout_recent_text(path).unwrap_or_default();
    if looks_like_buddy_decision(&recent_text) {
        return Ok(None);
    }
    let title_source = if recent_text.trim().is_empty() {
        payload
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or("Codex session")
    } else {
        recent_text.as_str()
    };
    let last_activity_ms = file_modified_ms(path).unwrap_or_else(now_ms);

    Ok(Some(WorkSessionSummary {
        agent: "codex".to_string(),
        session_id,
        project_path,
        title: preview_text(title_source, 96),
        last_activity_ms,
        recent_text: preview_text(title_source, 220),
        source_path: path.to_string_lossy().into_owned(),
    }))
}

fn looks_like_buddy_decision(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.starts_with('{')
        && trimmed.contains("\"speak\"")
        && trimmed.contains("\"mood\"")
        && trimmed.contains("\"text\"")
}

fn read_first_line(path: &Path) -> Result<Option<String>, String> {
    let file =
        File::open(path).map_err(|error| format!("failed to open {}: {error}", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let bytes = reader
        .read_line(&mut line)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    if bytes == 0 {
        return Ok(None);
    }
    Ok(Some(line.trim().to_string()))
}

fn codex_rollout_recent_text(path: &Path) -> Result<String, String> {
    let lines = read_tail_lines(path, CODEX_TAIL_BYTES, CODEX_TAIL_LINE_LIMIT)?;
    for line in lines.into_iter().rev() {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(text) = extract_codex_text(&value) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }
    }
    Ok(String::new())
}

fn extract_codex_text(value: &Value) -> Option<String> {
    match value.get("type").and_then(Value::as_str) {
        Some("response_item") => {
            let payload = value.get("payload")?;
            match payload.get("type").and_then(Value::as_str) {
                Some("message") => extract_message_content(payload),
                _ => None,
            }
        }
        Some("event_msg") => value
            .get("payload")
            .and_then(|payload| payload.get("message"))
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

fn extract_message_content(payload: &Value) -> Option<String> {
    let content = payload.get("content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }

    let array = content.as_array()?;
    let parts = array
        .iter()
        .filter_map(|item| {
            item.get("text")
                .or_else(|| item.get("content"))
                .and_then(Value::as_str)
        })
        .collect::<Vec<_>>();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn collect_rollout_files(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rollout_files(&path, out);
            continue;
        }

        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name.starts_with("rollout-") && name.ends_with(".jsonl") {
            out.push(path);
        }
    }
}

fn read_recent_lines(path: &Path, limit: usize) -> Result<Vec<String>, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let mut lines = content
        .lines()
        .rev()
        .filter(|line| !line.trim().is_empty())
        .take(limit)
        .map(str::to_string)
        .collect::<Vec<_>>();
    lines.reverse();
    Ok(lines)
}

fn read_tail_lines(path: &Path, max_bytes: u64, line_limit: usize) -> Result<Vec<String>, String> {
    let mut file =
        File::open(path).map_err(|error| format!("failed to open {}: {error}", path.display()))?;
    let len = file
        .metadata()
        .map_err(|error| format!("failed to stat {}: {error}", path.display()))?
        .len();
    let start = len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start))
        .map_err(|error| format!("failed to seek {}: {error}", path.display()))?;

    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let mut text = String::from_utf8_lossy(&buffer).to_string();
    if start > 0 {
        if let Some(pos) = text.find('\n') {
            text = text[pos + 1..].to_string();
        }
    }

    let mut lines = text
        .lines()
        .rev()
        .filter(|line| !line.trim().is_empty())
        .take(line_limit)
        .map(str::to_string)
        .collect::<Vec<_>>();
    lines.reverse();
    Ok(lines)
}

fn file_modified_ms(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .map(system_time_to_ms)
}

fn system_time_to_ms(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn preview_text(text: &str, max_chars: usize) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut preview = normalized.chars().take(max_chars).collect::<String>();
    if normalized.chars().count() > max_chars {
        preview.push_str("...");
    }
    preview
}

fn user_home_dir() -> PathBuf {
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        return PathBuf::from(user_profile);
    }

    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home);
    }

    PathBuf::from(".")
}
