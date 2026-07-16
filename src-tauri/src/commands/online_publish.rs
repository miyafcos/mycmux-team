// GUI-side savepoint publisher: native port of scripts/savepoint_publish.py.
// The Python CLI remains the scriptable path; keep the bundle layout,
// manifest schema, and handoff.md template in sync between the two.

use chrono::{Duration as ChronoDuration, FixedOffset, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use tauri::Emitter;

use super::online::{
    is_link_or_reparse_point, load_config, read_json, sanitize_project_dir, SavepointAgentKind,
    SavepointLifecycle, SavepointLifecycleStatus, SavepointRecordKind, DROPBOX_TOKEN,
    FINAL_RECORDS_DIR, SAVEPOINT_SCHEMA, TRASHED_FINAL_CHECKPOINT_FIELD,
};

const DEFAULT_EXPIRE_HOURS: i64 = 48;
const READ_TOOL: &str = "Read";
const WRITE_TOOLS: [&str; 4] = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
const PUBLISH_PROGRESS_EVENT: &str = "mycmux:savepoint-publish-progress";
pub(crate) static PUBLISH_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum PublishProgressStage {
    Digest,
    Handoff,
    Bundle,
    Register,
    Done,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
struct PublishProgressPayload {
    stage: PublishProgressStage,
    agent_kind: SavepointAgentKind,
    agent_session_id: String,
    claude_session_id: Option<String>,
}

fn publish_progress(
    stage: PublishProgressStage,
    kind: SavepointAgentKind,
    session_id: &str,
) -> PublishProgressPayload {
    PublishProgressPayload {
        stage,
        agent_kind: kind,
        agent_session_id: session_id.to_string(),
        claude_session_id: (kind == SavepointAgentKind::Claude).then(|| session_id.to_string()),
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SavepointCloseReason {
    Manual,
    TabClosed,
    PaneClosed,
    WorkspaceClosed,
    AppClosed,
}

impl SavepointCloseReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::TabClosed => "tab_closed",
            Self::PaneClosed => "pane_closed",
            Self::WorkspaceClosed => "workspace_closed",
            Self::AppClosed => "app_closed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PublishMode {
    Current,
    Final(SavepointCloseReason),
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct PublishSavepointResult {
    pub bundle_dir: String,
    pub session_id: String,
    pub summary_line: String,
    pub files_written: usize,
    pub files_read: usize,
    pub warnings: Vec<String>,
    pub updated: bool,
    pub record_kind: SavepointRecordKind,
    pub checkpoint_id: String,
    pub parent_checkpoint_id: Option<String>,
}

#[derive(Debug, Default)]
struct SessionDigest {
    cwd: Option<String>,
    git_branch: Option<String>,
    user_prompts: Vec<String>,
    last_assistant_text: String,
    files_read: Vec<String>,
    files_written: Vec<String>,
    turn_count: usize,
}

fn norm_slashes(path: &str) -> String {
    path.replace('\\', "/")
}

struct PathMapper {
    dropbox_root: Option<String>,
}

impl PathMapper {
    /// 絶対パスを {DROPBOX} トークン形式へ。戻り値 (パス, Dropbox内かどうか)。
    fn tokenize(&self, path: &str) -> (String, bool) {
        let normalized = norm_slashes(path);
        if let Some(root) = &self.dropbox_root {
            let root = norm_slashes(root);
            let root = root.trim_end_matches('/');
            let lower = normalized.to_lowercase();
            let root_lower = root.to_lowercase();
            if lower.starts_with(&format!("{root_lower}/")) {
                return (
                    format!("{DROPBOX_TOKEN}{}", &normalized[root.len()..]),
                    true,
                );
            }
            if lower == root_lower {
                return (DROPBOX_TOKEN.to_string(), true);
            }
        }
        (normalized, false)
    }
}

fn user_text(entry: &Value) -> Option<String> {
    if entry.get("type").and_then(Value::as_str) != Some("user") {
        return None;
    }
    if entry
        .get("isMeta")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let message = entry.get("message")?.as_object()?;
    let content = message.get("content")?;
    let text = if let Some(text) = content.as_str() {
        text.to_string()
    } else if let Some(blocks) = content.as_array() {
        let parts: Vec<&str> = blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .filter(|text| !text.is_empty())
            .collect();
        if parts.is_empty() {
            return None;
        }
        parts.join("\n")
    } else {
        return None;
    };
    let stripped = text.trim();
    if stripped.is_empty()
        || stripped.starts_with("<command-name>")
        || stripped.starts_with("<local-command")
    {
        return None;
    }
    Some(stripped.to_string())
}

fn digest_claude_transcript(jsonl_path: &Path) -> Result<SessionDigest, String> {
    let file = fs::File::open(jsonl_path)
        .map_err(|error| format!("Failed to open {}: {error}", jsonl_path.display()))?;
    let reader = std::io::BufReader::new(file);
    let mut digest = SessionDigest::default();

    for line in reader.lines() {
        let Ok(line) = line else { continue };
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if !entry.is_object() {
            continue;
        }
        if let Some(cwd) = entry.get("cwd").and_then(Value::as_str) {
            digest.cwd = Some(cwd.to_string());
        }
        if let Some(branch) = entry.get("gitBranch").and_then(Value::as_str) {
            if !branch.is_empty() {
                digest.git_branch = Some(branch.to_string());
            }
        }
        if let Some(text) = user_text(&entry) {
            digest.user_prompts.push(text);
            digest.turn_count += 1;
        }
        if entry.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let blocks = entry
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(Value::as_array);
        let Some(blocks) = blocks else { continue };
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        if !text.is_empty() {
                            digest.last_assistant_text = text.to_string();
                        }
                    }
                }
                Some("tool_use") => {
                    let Some(name) = block.get("name").and_then(Value::as_str) else {
                        continue;
                    };
                    let is_write = WRITE_TOOLS.contains(&name);
                    if !is_write && name != READ_TOOL {
                        continue;
                    }
                    let file_path = block
                        .get("input")
                        .and_then(|input| input.get("file_path"))
                        .and_then(Value::as_str);
                    let Some(file_path) = file_path else { continue };
                    if file_path.is_empty() {
                        continue;
                    }
                    let bucket = if is_write {
                        &mut digest.files_written
                    } else {
                        &mut digest.files_read
                    };
                    if !bucket.iter().any(|existing| existing == file_path) {
                        bucket.push(file_path.to_string());
                    }
                }
                _ => {}
            }
        }
    }
    Ok(digest)
}

#[derive(Debug)]
struct CodexSessionMeta {
    id: String,
    root_session_id: String,
    cwd: Option<String>,
    git_branch: Option<String>,
}

fn read_codex_session_meta(jsonl_path: &Path) -> Result<CodexSessionMeta, String> {
    let file = fs::File::open(jsonl_path)
        .map_err(|error| format!("Failed to open {}: {error}", jsonl_path.display()))?;
    let mut reader = std::io::BufReader::new(file);
    let mut first_line = String::new();
    if reader
        .read_line(&mut first_line)
        .map_err(|error| format!("Failed to read {}: {error}", jsonl_path.display()))?
        == 0
    {
        return Err("Codex transcript is empty".to_string());
    }
    let entry: Value = serde_json::from_str(first_line.trim_end())
        .map_err(|error| format!("Invalid Codex session metadata: {error}"))?;
    if entry.get("type").and_then(Value::as_str) != Some("session_meta") {
        return Err("Codex transcript does not start with session_meta".to_string());
    }
    let payload = entry
        .get("payload")
        .and_then(Value::as_object)
        .ok_or_else(|| "Codex session_meta payload is invalid".to_string())?;
    let id = payload
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Codex session id is missing".to_string())?
        .to_string();
    let root_session_id = payload
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Codex root session id is missing".to_string())?
        .to_string();
    let cwd = payload
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::to_string);
    let git_branch = payload
        .get("git")
        .and_then(|git| git.get("branch"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Ok(CodexSessionMeta {
        id,
        root_session_id,
        cwd,
        git_branch,
    })
}

fn message_content_text(payload: &Value, block_type: &str) -> Option<String> {
    let parts = payload
        .get("content")
        .and_then(Value::as_array)?
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some(block_type))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .filter(|text| !text.trim().is_empty())
        .collect::<Vec<_>>();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

fn collect_apply_patch_paths(input: &str, paths: &mut Vec<String>) {
    for line in input.lines() {
        let path = ["*** Add File: ", "*** Update File: ", "*** Delete File: "]
            .iter()
            .find_map(|prefix| line.trim().strip_prefix(prefix))
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let Some(path) = path {
            if !paths.iter().any(|existing| existing == path) {
                paths.push(path.to_string());
            }
        }
    }
}

fn digest_codex_transcript(jsonl_path: &Path) -> Result<SessionDigest, String> {
    let meta = read_codex_session_meta(jsonl_path)?;
    if meta.id != meta.root_session_id {
        return Err("Codex transcript is a child rollout, not a root session".to_string());
    }
    let file = fs::File::open(jsonl_path)
        .map_err(|error| format!("Failed to open {}: {error}", jsonl_path.display()))?;
    let reader = std::io::BufReader::new(file);
    let mut digest = SessionDigest {
        cwd: meta.cwd,
        git_branch: meta.git_branch,
        ..SessionDigest::default()
    };
    let mut fallback_users = Vec::new();
    let mut fallback_assistant = String::new();
    let mut latest_agent_message = String::new();
    let mut latest_final_message = String::new();

    for line in reader.lines() {
        let Ok(line) = line else { continue };
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let top_type = entry.get("type").and_then(Value::as_str);
        let Some(payload) = entry.get("payload") else {
            continue;
        };
        if top_type == Some("event_msg") {
            match payload.get("type").and_then(Value::as_str) {
                Some("user_message") => {
                    if let Some(message) = payload
                        .get("message")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                    {
                        if digest
                            .user_prompts
                            .last()
                            .is_none_or(|last| last != message)
                        {
                            digest.user_prompts.push(message.to_string());
                        }
                    }
                }
                Some("agent_message") => {
                    if let Some(message) = payload
                        .get("message")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                    {
                        latest_agent_message = message.to_string();
                        if payload.get("phase").and_then(Value::as_str) == Some("final") {
                            latest_final_message = message.to_string();
                        }
                    }
                }
                _ => {}
            }
        }
        if top_type != Some("response_item") {
            continue;
        }
        match payload.get("type").and_then(Value::as_str) {
            Some("message") => match payload.get("role").and_then(Value::as_str) {
                Some("user") => {
                    if let Some(text) = message_content_text(payload, "input_text") {
                        fallback_users.push(text);
                    }
                }
                Some("assistant") => {
                    if let Some(text) = message_content_text(payload, "output_text") {
                        fallback_assistant = text;
                    }
                }
                _ => {}
            },
            Some("custom_tool_call") | Some("function_call") => {
                for key in ["input", "arguments"] {
                    if let Some(input) = payload.get(key).and_then(Value::as_str) {
                        collect_apply_patch_paths(input, &mut digest.files_written);
                    }
                }
            }
            _ => {}
        }
    }
    if digest.user_prompts.is_empty() {
        digest.user_prompts = fallback_users;
    }
    digest.turn_count = digest.user_prompts.len();
    digest.last_assistant_text = if latest_final_message.is_empty() {
        if latest_agent_message.is_empty() {
            fallback_assistant
        } else {
            latest_agent_message
        }
    } else {
        latest_final_message
    };
    Ok(digest)
}

fn truncate(text: &str, limit: usize) -> String {
    let flattened = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flattened.chars().count() <= limit {
        return flattened;
    }
    let mut result: String = flattened.chars().take(limit.saturating_sub(1)).collect();
    result.push('…');
    result
}

fn build_summary_line(explicit: Option<&str>, digest: &SessionDigest) -> String {
    if let Some(explicit) = explicit {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return truncate(trimmed, 80);
        }
    }
    if let Some(last) = digest.user_prompts.last() {
        return truncate(last, 80);
    }
    "(サマリ未設定)".to_string()
}

fn build_handoff_md(
    digest: &SessionDigest,
    mapper: &PathMapper,
    summary_line: &str,
    author: &str,
    next_step: Option<&str>,
) -> (String, Vec<String>) {
    let mut warnings: Vec<String> = Vec::new();

    let cwd_line = match &digest.cwd {
        Some(cwd) => {
            let (token, inside) = mapper.tokenize(cwd);
            if !inside {
                warnings.push(format!("作業ディレクトリ {token} は Dropbox 外"));
            }
            format!("`{token}`{}", if inside { "" } else { " ⚠Dropbox外" })
        }
        None => "(不明)".to_string(),
    };

    let render_paths = |paths: &[String], warnings: &mut Vec<String>| -> Vec<String> {
        if paths.is_empty() {
            return vec!["- (なし)".to_string()];
        }
        paths
            .iter()
            .map(|raw| {
                let (token, inside) = mapper.tokenize(raw);
                if !inside {
                    warnings.push(format!("{token} は Dropbox 外 (相手側に存在しない可能性)"));
                }
                format!("- `{token}`{}", if inside { "" } else { " ⚠Dropbox外" })
            })
            .collect()
    };

    let first_prompt = digest
        .user_prompts
        .first()
        .map(|prompt| truncate(prompt, 300))
        .unwrap_or_else(|| "(記録なし)".to_string());
    let last_assistant = if digest.last_assistant_text.is_empty() {
        "(記録なし)".to_string()
    } else {
        truncate(&digest.last_assistant_text, 600)
    };

    let mut lines: Vec<String> = vec![
        format!("# 引き継ぎ: {summary_line}"),
        String::new(),
        format!("- 記録者: {author} / やり取り {} 往復", digest.turn_count),
        format!("- 作業ディレクトリ: {cwd_line}"),
    ];
    if let Some(branch) = &digest.git_branch {
        lines.push(format!("- git ブランチ: `{branch}`"));
    }
    lines.extend([
        String::new(),
        "## 依頼の始まり (最初の指示)".to_string(),
        first_prompt,
        String::new(),
        "## 現在地 (最後の応答の要旨)".to_string(),
        last_assistant,
        String::new(),
        "## 次の一手".to_string(),
        next_step
            .map(str::to_string)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| {
                "(記録者が未記入 — 会話ごと続ける場合は、会話の続きから確認してください)"
                    .to_string()
            }),
        String::new(),
        "## 変更したファイル".to_string(),
    ]);
    lines.extend(render_paths(&digest.files_written, &mut warnings));
    lines.extend([String::new(), "## 参照したファイル".to_string()]);
    lines.extend(render_paths(&digest.files_read, &mut warnings));
    lines.extend([
        String::new(),
        "## 環境の前提".to_string(),
        "- 会話の記憶は引き継がれますが、記録者のマシンにあるツール・MCP・権限は付いてきません。"
            .to_string(),
        "- パスの `{DROPBOX}` はあなたのローカル Dropbox ルートに読み替えてください (mycmux は自動展開)。"
            .to_string(),
        String::new(),
    ]);
    (lines.join("\n"), warnings)
}

/// Newest .jsonl transcript in a project dir, with its session id.
fn latest_transcript_in(project_dir: &Path) -> Option<(PathBuf, String)> {
    let entries = fs::read_dir(project_dir).ok()?;
    let mut latest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().is_none_or(|ext| ext != "jsonl") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|metadata| metadata.modified()) else {
            continue;
        };
        if latest
            .as_ref()
            .is_none_or(|(current, _)| modified > *current)
        {
            latest = Some((modified, path));
        }
    }
    let (_, path) = latest?;
    let session_id = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())?;
    Some((path, session_id))
}

fn locate_claude_transcript(
    projects_dir: &Path,
    cwd: &str,
    session: Option<&str>,
) -> Result<(PathBuf, String), String> {
    let project_dir = projects_dir.join(sanitize_project_dir(cwd));
    if let Some(session) = session {
        let candidate = project_dir.join(format!("{session}.jsonl"));
        if candidate.is_file() {
            return Ok((candidate, session.to_string()));
        }
        // cwd の sanitize 結果と実際の置き場所がずれた場合の保険: 全 project を横断検索
        if let Ok(entries) = fs::read_dir(projects_dir) {
            for entry in entries.flatten() {
                let fallback = entry.path().join(format!("{session}.jsonl"));
                if fallback.is_file() {
                    return Ok((fallback, session.to_string()));
                }
            }
        }
        // The recorded id can go stale while the pane still has a real
        // conversation: claude's in-app /resume (or the bare --resume
        // picker) switches the live session away from the id in argv and
        // tab markers (observed 2026-07-12: argv --session-id had no jsonl
        // while the pane was actively writing another session). Fall back
        // to the newest transcript for this cwd; the caller warns with the
        // id actually published.
        if let Some(found) = latest_transcript_in(&project_dir) {
            return Ok(found);
        }
        return Err(format!(
            "Session transcript {session}.jsonl not found under {}",
            projects_dir.display()
        ));
    }

    let entries = fs::read_dir(&project_dir)
        .map_err(|error| format!("Failed to scan {}: {error}", project_dir.display()))?;
    let mut latest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().is_none_or(|ext| ext != "jsonl") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|metadata| metadata.modified()) else {
            continue;
        };
        if latest
            .as_ref()
            .is_none_or(|(current, _)| modified > *current)
        {
            latest = Some((modified, path));
        }
    }
    let (_, path) = latest
        .ok_or_else(|| format!("No session transcript found in {}", project_dir.display()))?;
    let session_id = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .ok_or_else(|| format!("Invalid transcript file name: {}", path.display()))?;
    Ok((path, session_id))
}

/// tmp_dir を target_dir へ入れ替える (受け手が読取り中でも壊れないように)。
fn collect_codex_transcript_paths(root: &Path, paths: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_codex_transcript_paths(&path, paths);
        } else if file_type.is_file() && path.extension().is_some_and(|ext| ext == "jsonl") {
            paths.push(path);
        }
    }
}

fn locate_codex_transcript(
    sessions_root: &Path,
    cwd: &str,
    session: Option<&str>,
) -> Result<(PathBuf, String), String> {
    if let Some(session) = session {
        uuid::Uuid::parse_str(session).map_err(|_| "Codex session id is invalid".to_string())?;
    }
    let mut paths = Vec::new();
    collect_codex_transcript_paths(sessions_root, &mut paths);
    if let Some(session) = session {
        let filename_suffix = format!("-{session}.jsonl");
        for path in paths.iter().filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(&filename_suffix))
        }) {
            let Ok(meta) = read_codex_session_meta(path) else {
                continue;
            };
            if meta.id == session && meta.root_session_id == session {
                return Ok((path.clone(), session.to_string()));
            }
        }
        return Err(format!(
            "Codex session transcript {session} not found under {}",
            sessions_root.display()
        ));
    }

    let expected_cwd = norm_slashes(cwd).to_lowercase();
    let mut candidates = paths
        .into_iter()
        .filter_map(|path| {
            let meta = read_codex_session_meta(&path).ok()?;
            if meta.id != meta.root_session_id
                || meta
                    .cwd
                    .as_deref()
                    .map(norm_slashes)
                    .map(|value| value.to_lowercase())
                    .as_deref()
                    != Some(expected_cwd.as_str())
            {
                return None;
            }
            let modified = fs::metadata(&path)
                .and_then(|value| value.modified())
                .ok()?;
            Some((modified, path, meta.id))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    candidates
        .into_iter()
        .next()
        .map(|(_, path, session_id)| (path, session_id))
        .ok_or_else(|| {
            format!(
                "No Codex session transcript found in {}",
                sessions_root.display()
            )
        })
}

fn locate_agent_transcript(
    transcript_root: &Path,
    kind: SavepointAgentKind,
    cwd: &str,
    session: Option<&str>,
) -> Result<(PathBuf, String), String> {
    match kind {
        SavepointAgentKind::Claude => locate_claude_transcript(transcript_root, cwd, session),
        SavepointAgentKind::Codex => locate_codex_transcript(transcript_root, cwd, session),
    }
}

fn digest_agent_transcript(
    kind: SavepointAgentKind,
    transcript: &Path,
) -> Result<SessionDigest, String> {
    match kind {
        SavepointAgentKind::Claude => digest_claude_transcript(transcript),
        SavepointAgentKind::Codex => digest_codex_transcript(transcript),
    }
}

fn atomic_swap_dir(tmp_dir: &Path, target_dir: &Path) -> Result<(), String> {
    let parent = target_dir
        .parent()
        .ok_or_else(|| "Bundle parent directory not found".to_string())?;
    let old_dir = parent.join(format!(
        "{}.old-{}-{}",
        target_dir
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        std::process::id(),
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ));
    if target_dir.exists() {
        fs::rename(target_dir, &old_dir)
            .map_err(|error| format!("Failed to stage old bundle: {error}"))?;
    }
    if let Err(error) = fs::rename(tmp_dir, target_dir) {
        if old_dir.exists() {
            let _ = fs::rename(&old_dir, target_dir);
        }
        return Err(format!("Failed to swap in new bundle: {error}"));
    }
    if old_dir.exists() {
        let _ = fs::remove_dir_all(&old_dir);
    }
    Ok(())
}

fn atomic_create_dir(tmp_dir: &Path, target_dir: &Path) -> Result<bool, String> {
    if target_dir.exists() {
        return Ok(false);
    }
    match fs::rename(tmp_dir, target_dir) {
        Ok(()) => Ok(true),
        Err(_error) if target_dir.exists() => Ok(false),
        Err(error) => Err(format!("Failed to create immutable record: {error}")),
    }
}

fn safe_final_records_dir(online_dir: &Path, create: bool) -> Result<Option<PathBuf>, String> {
    let online_root = fs::canonicalize(online_dir)
        .map_err(|error| format!("Failed to resolve {}: {error}", online_dir.display()))?;
    let candidate = online_dir.join(FINAL_RECORDS_DIR);
    if candidate.exists() {
        if is_link_or_reparse_point(&candidate) || !candidate.is_dir() {
            return Err(format!(
                "Final records path must be a real directory: {}",
                candidate.display()
            ));
        }
    } else if create {
        fs::create_dir(&candidate)
            .map_err(|error| format!("Failed to create {}: {error}", candidate.display()))?;
    } else {
        return Ok(None);
    }
    let records_root = fs::canonicalize(&candidate)
        .map_err(|error| format!("Failed to resolve {}: {error}", candidate.display()))?;
    if records_root.parent() != Some(online_root.as_path()) || is_link_or_reparse_point(&candidate)
    {
        return Err(format!(
            "Final records path escapes {}",
            online_root.display()
        ));
    }
    Ok(Some(candidate))
}

fn write_bundle_temp(
    tmp_dir: &Path,
    manifest: &Value,
    handoff_md: &str,
    jsonl_path: &Path,
) -> Result<(), String> {
    fs::create_dir_all(tmp_dir.join("transcript"))
        .map_err(|error| format!("Failed to create bundle temp dir: {error}"))?;
    let manifest_json = serde_json::to_string_pretty(manifest)
        .map_err(|error| format!("Failed to serialize manifest: {error}"))?;
    fs::write(tmp_dir.join("manifest.json"), manifest_json)
        .map_err(|error| format!("Failed to write manifest: {error}"))?;
    fs::write(tmp_dir.join("handoff.md"), handoff_md)
        .map_err(|error| format!("Failed to write handoff.md: {error}"))?;
    let transcript_name = jsonl_path
        .file_name()
        .ok_or_else(|| format!("Invalid transcript path: {}", jsonl_path.display()))?;
    fs::copy(jsonl_path, tmp_dir.join("transcript").join(transcript_name))
        .map_err(|error| format!("Failed to copy transcript: {error}"))?;
    Ok(())
}

fn lifecycle_from_manifest(manifest: Option<&Value>) -> SavepointLifecycle {
    manifest
        .and_then(|value| value.get("lifecycle"))
        .and_then(|value| serde_json::from_value::<SavepointLifecycle>(value.clone()).ok())
        .unwrap_or_default()
        .normalized()
}

fn read_head_manifest_with_recovery(head_dir: &Path) -> Option<Value> {
    if let Ok(manifest) = read_json::<Value>(&head_dir.join("manifest.json")) {
        return Some(manifest);
    }
    let parent = head_dir.parent()?;
    let prefix = format!("{}.old-", head_dir.file_name()?.to_string_lossy());
    let mut candidates = fs::read_dir(parent)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with(&prefix) || !path.is_dir() || is_link_or_reparse_point(&path) {
                return None;
            }
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok()?;
            Some((modified, path))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    candidates.into_iter().find_map(|(_, path)| {
        let manifest = read_json::<Value>(&path.join("manifest.json")).ok()?;
        lifecycle_from_manifest(Some(&manifest))
            .checkpoint_id
            .is_some()
            .then_some(manifest)
    })
}

fn validate_final_record(
    manifest: &Value,
    target_dir: &Path,
    agent_kind: SavepointAgentKind,
    session_id: &str,
    checkpoint_id: &str,
) -> Result<SavepointLifecycle, String> {
    let lifecycle = lifecycle_from_manifest(Some(manifest));
    let generic_kind = manifest.get("agent_kind").and_then(Value::as_str);
    let generic_id = manifest.get("agent_session_id").and_then(Value::as_str);
    let legacy_id = manifest.get("claude_session_id").and_then(Value::as_str);
    let identity_matches = match agent_kind {
        SavepointAgentKind::Claude => {
            (generic_kind.is_none() && generic_id.is_none() && legacy_id == Some(session_id))
                || (generic_kind == Some("claude")
                    && generic_id == Some(session_id)
                    && legacy_id == Some(session_id))
        }
        SavepointAgentKind::Codex => {
            generic_kind == Some("codex") && generic_id == Some(session_id) && legacy_id.is_none()
        }
    };
    if !identity_matches
        || lifecycle.status != SavepointLifecycleStatus::Closed
        || !lifecycle.final_checkpoint
        || lifecycle.checkpoint_id.as_deref() != Some(checkpoint_id)
    {
        return Err(format!(
            "Immutable record identity mismatch: {}",
            target_dir.display()
        ));
    }
    Ok(lifecycle)
}

fn find_bundle_transcript(bundle_dir: &Path) -> Result<PathBuf, String> {
    let transcript_dir = bundle_dir.join("transcript");
    let mut transcripts = fs::read_dir(&transcript_dir)
        .map_err(|error| format!("Failed to scan {}: {error}", transcript_dir.display()))?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && path.extension().is_some_and(|ext| ext == "jsonl"))
        .collect::<Vec<_>>();
    transcripts.sort();
    transcripts
        .into_iter()
        .next()
        .ok_or_else(|| format!("No transcript JSONL found in {}", transcript_dir.display()))
}

fn write_head_from_final_record(final_dir: &Path, head_dir: &Path) -> Result<Value, String> {
    let final_manifest: Value = read_json(&final_dir.join("manifest.json"))?;
    let mut head_lifecycle = lifecycle_from_manifest(Some(&final_manifest));
    let current_head = read_json::<Value>(&head_dir.join("manifest.json")).ok();
    let current_head_id = lifecycle_from_manifest(current_head.as_ref()).checkpoint_id;
    let replaces_trashed_parent = current_head.as_ref().is_some_and(|manifest| {
        manifest
            .get(TRASHED_FINAL_CHECKPOINT_FIELD)
            .and_then(Value::as_str)
            == current_head_id.as_deref()
            && current_head_id.as_deref() == head_lifecycle.parent_checkpoint_id.as_deref()
    });
    if current_head.is_some()
        && current_head_id.is_some()
        && current_head_id != head_lifecycle.checkpoint_id
        && !replaces_trashed_parent
    {
        return Ok(final_manifest);
    }

    head_lifecycle.final_checkpoint = false;
    let mut head_manifest = final_manifest.clone();
    let object = head_manifest
        .as_object_mut()
        .ok_or_else(|| format!("Invalid manifest object: {}", final_dir.display()))?;
    object.insert(
        "lifecycle".to_string(),
        serde_json::to_value(head_lifecycle)
            .map_err(|error| format!("Failed to serialize lifecycle: {error}"))?,
    );
    let handoff_md = fs::read_to_string(final_dir.join("handoff.md"))
        .map_err(|error| format!("Failed to read final handoff: {error}"))?;
    let transcript = find_bundle_transcript(final_dir)?;
    let parent = head_dir
        .parent()
        .ok_or_else(|| "Bundle parent directory not found".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    let head_tmp = parent.join(format!(
        ".{}.tmp-{}",
        head_dir
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ));
    let outcome = (|| -> Result<(), String> {
        write_bundle_temp(&head_tmp, &head_manifest, &handoff_md, &transcript)?;
        atomic_swap_dir(&head_tmp, head_dir)
    })();
    if head_tmp.exists() {
        let _ = fs::remove_dir_all(&head_tmp);
    }
    outcome?;
    Ok(final_manifest)
}

#[allow(clippy::too_many_arguments)]
fn publish_savepoint_impl(
    config_path: &Path,
    home: &Path,
    transcript_root: &Path,
    agent_kind: SavepointAgentKind,
    cwd: &str,
    agent_session_id: Option<&str>,
    summary: Option<&str>,
    next_step: Option<&str>,
    mode: PublishMode,
    now: chrono::DateTime<Utc>,
    progress: &mut dyn FnMut(PublishProgressPayload),
) -> Result<PublishSavepointResult, String> {
    let _publish_guard = PUBLISH_LOCK
        .lock()
        .map_err(|_| "Savepoint publisher lock is unavailable".to_string())?;
    let config = load_config(config_path)?;
    let online_dir = super::online::local_savepoint_dir(&config, home)?;
    let author = config
        .author
        .clone()
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var("USERNAME").ok())
        .or_else(|| std::env::var("USER").ok())
        .unwrap_or_else(|| "user".to_string());
    let machine = config
        .machine
        .clone()
        .filter(|value| !value.is_empty())
        .or_else(sysinfo::System::host_name)
        .unwrap_or_default();

    let (jsonl_path, session_id) =
        locate_agent_transcript(transcript_root, agent_kind, cwd, agent_session_id)?;
    let digest = digest_agent_transcript(agent_kind, &jsonl_path)?;
    progress(publish_progress(
        PublishProgressStage::Digest,
        agent_kind,
        &session_id,
    ));
    let mapper = PathMapper {
        dropbox_root: config.dropbox_root.clone(),
    };
    let summary_line = build_summary_line(summary, &digest);
    let (handoff_md, mut warnings) =
        build_handoff_md(&digest, &mapper, &summary_line, &author, next_step);
    if let Some(requested) = agent_session_id {
        if requested != session_id {
            warnings.insert(
                0,
                format!(
                    "タブ記録のセッション {} に会話ログが無いため、この作業ディレクトリの最新会話 {} を保存しました",
                    &requested[..requested.len().min(8)],
                    &session_id[..session_id.len().min(8)]
                ),
            );
        }
    }
    progress(publish_progress(
        PublishProgressStage::Handoff,
        agent_kind,
        &session_id,
    ));

    fs::create_dir_all(&online_dir)
        .map_err(|error| format!("Failed to create {}: {error}", online_dir.display()))?;
    let final_records_dir =
        safe_final_records_dir(&online_dir, matches!(mode, PublishMode::Final(_)))?;
    let author_slug: String = author
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect();
    let author_slug = if author_slug.is_empty() {
        "user".to_string()
    } else {
        author_slug
    };
    let short_id: String = session_id.chars().take(8).collect();
    let head_dir = if agent_kind == SavepointAgentKind::Codex {
        online_dir.join(format!("{author_slug}_codex_{short_id}"))
    } else {
        online_dir.join(format!("{author_slug}_{short_id}"))
    };

    // Mutable head preserves its identity while active. Publishing again after
    // a finalized generation starts a new checkpoint linked to the previous one.
    let jst = FixedOffset::east_opt(9 * 3600).expect("JST offset");
    let now_jst = now.with_timezone(&jst);
    let now_text = now_jst.to_rfc3339_opts(SecondsFormat::Secs, false);
    let previous_manifest = read_head_manifest_with_recovery(&head_dir);
    let previous_lifecycle = lifecycle_from_manifest(previous_manifest.as_ref());
    let previous_final_exists = previous_lifecycle.checkpoint_id.as_ref().is_some_and(|id| {
        final_records_dir
            .as_ref()
            .is_some_and(|records_dir| records_dir.join(id).exists())
    });
    let previous_final_was_trashed = previous_manifest.as_ref().is_some_and(|manifest| {
        manifest
            .get(TRASHED_FINAL_CHECKPOINT_FIELD)
            .and_then(Value::as_str)
            == previous_lifecycle.checkpoint_id.as_deref()
    });
    let starts_new_generation = (mode == PublishMode::Current
        && (previous_lifecycle.status == SavepointLifecycleStatus::Closed
            || previous_final_exists))
        || (mode != PublishMode::Current && previous_final_was_trashed);
    let checkpoint_id = if starts_new_generation {
        uuid::Uuid::new_v4().to_string()
    } else {
        previous_lifecycle
            .checkpoint_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
    };
    let parent_checkpoint_id = if starts_new_generation {
        previous_lifecycle.checkpoint_id.clone()
    } else {
        previous_lifecycle.parent_checkpoint_id.clone()
    };
    let created_at = if starts_new_generation {
        now_text.clone()
    } else {
        previous_manifest
            .as_ref()
            .and_then(|value| value.get("created_at"))
            .and_then(Value::as_str)
            .unwrap_or(&now_text)
            .to_string()
    };
    let pinned = previous_manifest
        .as_ref()
        .and_then(|value| value.get("pinned"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let record_kind = match mode {
        PublishMode::Current => SavepointRecordKind::Current,
        PublishMode::Final(_) => SavepointRecordKind::Final,
    };
    let target_dir = match mode {
        PublishMode::Current => head_dir.clone(),
        PublishMode::Final(_) => final_records_dir
            .as_ref()
            .expect("final records directory is created for final mode")
            .join(&checkpoint_id),
    };
    let mut updated = target_dir.join("manifest.json").is_file();
    if mode != PublishMode::Current && updated {
        let existing: Value = read_json(&target_dir.join("manifest.json"))?;
        let existing_lifecycle = validate_final_record(
            &existing,
            &target_dir,
            agent_kind,
            &session_id,
            &checkpoint_id,
        )?;
        let existing = write_head_from_final_record(&target_dir, &head_dir)?;
        progress(publish_progress(
            PublishProgressStage::Done,
            agent_kind,
            &session_id,
        ));
        return Ok(PublishSavepointResult {
            bundle_dir: target_dir.to_string_lossy().into_owned(),
            session_id,
            summary_line: existing
                .get("summary_line")
                .and_then(Value::as_str)
                .unwrap_or(&summary_line)
                .to_string(),
            files_written: existing
                .get("files_written")
                .and_then(Value::as_array)
                .map_or(0, Vec::len),
            files_read: 0,
            warnings: existing
                .get("warnings")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            updated: true,
            record_kind,
            checkpoint_id,
            parent_checkpoint_id: existing_lifecycle.parent_checkpoint_id,
        });
    }
    let updated_at = now_jst.to_rfc3339_opts(SecondsFormat::Secs, false);
    let expires_at = (now_jst + ChronoDuration::hours(DEFAULT_EXPIRE_HOURS))
        .to_rfc3339_opts(SecondsFormat::Secs, false);

    let cwd_token = digest
        .cwd
        .as_deref()
        .map(|value| mapper.tokenize(value).0)
        .unwrap_or_else(|| norm_slashes(cwd));
    let tokenized = |paths: &[String]| -> Vec<String> {
        paths.iter().map(|path| mapper.tokenize(path).0).collect()
    };
    let mut files_touched = tokenized(&digest.files_written);
    files_touched.extend(tokenized(&digest.files_read));
    let closed_reason = match mode {
        PublishMode::Current => None,
        PublishMode::Final(reason) => Some(reason.as_str().to_string()),
    };
    let lifecycle = SavepointLifecycle {
        status: if record_kind == SavepointRecordKind::Final {
            SavepointLifecycleStatus::Closed
        } else {
            SavepointLifecycleStatus::Active
        },
        checkpoint_id: Some(checkpoint_id.clone()),
        parent_checkpoint_id: parent_checkpoint_id.clone(),
        final_checkpoint: record_kind == SavepointRecordKind::Final,
        closed_at: (record_kind == SavepointRecordKind::Final).then(|| updated_at.clone()),
        closed_reason: closed_reason.clone(),
    };
    let make_manifest = |lifecycle: SavepointLifecycle| {
        serde_json::json!({
            "schema": SAVEPOINT_SCHEMA,
            "author": author.clone(),
            "machine": machine.clone(),
            "created_at": created_at.clone(),
            "updated_at": updated_at.clone(),
            "expires_at": expires_at.clone(),
            "pinned": pinned,
            "summary_line": summary_line.clone(),
            "cwd": cwd_token.clone(),
            "agent_kind": agent_kind,
            "agent_session_id": session_id.clone(),
            "claude_session_id": (agent_kind == SavepointAgentKind::Claude)
                .then(|| session_id.clone()),
            "files_touched": files_touched.clone(),
            "files_written": tokenized(&digest.files_written),
            "git_branch": digest.git_branch.clone(),
            "warnings": warnings.clone(),
            "lifecycle": lifecycle,
        })
    };
    let manifest = make_manifest(lifecycle.clone());
    let make_tmp_dir = |target: &Path| -> Result<PathBuf, String> {
        let parent = target
            .parent()
            .ok_or_else(|| "Bundle parent directory not found".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
        Ok(parent.join(format!(
            ".{}.tmp-{}",
            target
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        )))
    };
    if matches!(mode, PublishMode::Final(_))
        && (previous_lifecycle.checkpoint_id.is_none() || starts_new_generation)
    {
        // Persist the generated identity before creating the immutable record.
        // If the process stops between final creation and head closure, a retry
        // must resolve to the same checkpoint instead of creating a duplicate.
        let bootstrap_lifecycle = SavepointLifecycle {
            status: SavepointLifecycleStatus::Active,
            checkpoint_id: Some(checkpoint_id.clone()),
            parent_checkpoint_id: parent_checkpoint_id.clone(),
            final_checkpoint: false,
            closed_at: None,
            closed_reason: None,
        };
        let bootstrap_manifest = make_manifest(bootstrap_lifecycle);
        let bootstrap_tmp = make_tmp_dir(&head_dir)?;
        let bootstrap_outcome = (|| -> Result<(), String> {
            write_bundle_temp(
                &bootstrap_tmp,
                &bootstrap_manifest,
                &handoff_md,
                &jsonl_path,
            )?;
            atomic_swap_dir(&bootstrap_tmp, &head_dir)
        })();
        if bootstrap_tmp.exists() {
            let _ = fs::remove_dir_all(&bootstrap_tmp);
        }
        bootstrap_outcome?;
    }
    let tmp_dir = make_tmp_dir(&target_dir)?;
    let outcome = (|| -> Result<(), String> {
        write_bundle_temp(&tmp_dir, &manifest, &handoff_md, &jsonl_path)?;
        progress(publish_progress(
            PublishProgressStage::Bundle,
            agent_kind,
            &session_id,
        ));
        match mode {
            PublishMode::Current => {
                let finalized_during_save = safe_final_records_dir(&online_dir, false)?
                    .as_ref()
                    .is_some_and(|records_dir| records_dir.join(&checkpoint_id).exists());
                if finalized_during_save {
                    return Err(
                        "This checkpoint was finalized while saving. Please retry the current save."
                            .to_string(),
                    );
                }
                atomic_swap_dir(&tmp_dir, &target_dir)?;
            }
            PublishMode::Final(_) => {
                let created = atomic_create_dir(&tmp_dir, &target_dir)?;
                if !created {
                    updated = true;
                    let existing: Value = read_json(&target_dir.join("manifest.json"))?;
                    validate_final_record(
                        &existing,
                        &target_dir,
                        agent_kind,
                        &session_id,
                        &checkpoint_id,
                    )?;
                }
                write_head_from_final_record(&target_dir, &head_dir)?;
            }
        }
        progress(publish_progress(
            PublishProgressStage::Register,
            agent_kind,
            &session_id,
        ));
        Ok(())
    })();
    if tmp_dir.exists() {
        let _ = fs::remove_dir_all(&tmp_dir);
    }
    outcome?;
    progress(publish_progress(
        PublishProgressStage::Done,
        agent_kind,
        &session_id,
    ));

    Ok(PublishSavepointResult {
        bundle_dir: target_dir.to_string_lossy().into_owned(),
        session_id,
        summary_line,
        files_written: digest.files_written.len(),
        files_read: digest.files_read.len(),
        warnings,
        updated,
        record_kind,
        checkpoint_id,
        parent_checkpoint_id,
    })
}

#[tauri::command(async)]
pub fn publish_savepoint(
    app: tauri::AppHandle,
    cwd: String,
    agent_kind: Option<SavepointAgentKind>,
    agent_session_id: Option<String>,
    claude_session_id: Option<String>,
    summary: Option<String>,
    next_step: Option<String>,
) -> Result<PublishSavepointResult, String> {
    let home = dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    let agent_kind = agent_kind.unwrap_or(SavepointAgentKind::Claude);
    let session_id = match agent_kind {
        SavepointAgentKind::Claude => agent_session_id.as_deref().or(claude_session_id.as_deref()),
        SavepointAgentKind::Codex => agent_session_id.as_deref(),
    };
    let transcript_root = match agent_kind {
        SavepointAgentKind::Claude => home.join(".claude").join("projects"),
        SavepointAgentKind::Codex => home.join(".codex").join("sessions"),
    };
    let mut emit_progress = |payload: PublishProgressPayload| {
        let _ = app.emit(PUBLISH_PROGRESS_EVENT, payload);
    };
    publish_savepoint_impl(
        &home.join(".mycmux").join("savepoint.json"),
        &home,
        &transcript_root,
        agent_kind,
        &cwd,
        session_id,
        summary.as_deref(),
        next_step.as_deref(),
        PublishMode::Current,
        Utc::now(),
        &mut emit_progress,
    )
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn finalize_savepoint(
    app: tauri::AppHandle,
    cwd: String,
    agent_kind: Option<SavepointAgentKind>,
    agent_session_id: Option<String>,
    claude_session_id: Option<String>,
    summary: Option<String>,
    next_step: Option<String>,
    closed_reason: Option<SavepointCloseReason>,
) -> Result<PublishSavepointResult, String> {
    let home = dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    let agent_kind = agent_kind.unwrap_or(SavepointAgentKind::Claude);
    let session_id = match agent_kind {
        SavepointAgentKind::Claude => agent_session_id.as_deref().or(claude_session_id.as_deref()),
        SavepointAgentKind::Codex => agent_session_id.as_deref(),
    };
    let transcript_root = match agent_kind {
        SavepointAgentKind::Claude => home.join(".claude").join("projects"),
        SavepointAgentKind::Codex => home.join(".codex").join("sessions"),
    };
    let mut emit_progress = |payload: PublishProgressPayload| {
        let _ = app.emit(PUBLISH_PROGRESS_EVENT, payload);
    };
    publish_savepoint_impl(
        &home.join(".mycmux").join("savepoint.json"),
        &home,
        &transcript_root,
        agent_kind,
        &cwd,
        session_id,
        summary.as_deref(),
        next_step.as_deref(),
        PublishMode::Final(closed_reason.unwrap_or(SavepointCloseReason::Manual)),
        Utc::now(),
        &mut emit_progress,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use std::io::Write;
    use tempfile::tempdir;

    fn write_transcript(path: &Path, cwd: &str) {
        let lines = [
            serde_json::json!({
                "type": "user",
                "cwd": cwd,
                "gitBranch": "master",
                "message": {"content": "最初の指示です"}
            }),
            serde_json::json!({
                "type": "user",
                "isMeta": true,
                "message": {"content": "meta noise"}
            }),
            serde_json::json!({
                "type": "user",
                "message": {"content": "<command-name>/skill</command-name>"}
            }),
            serde_json::json!({
                "type": "assistant",
                "message": {"content": [
                    {"type": "text", "text": "途中の応答"},
                    {"type": "tool_use", "name": "Read", "input": {"file_path": format!("{cwd}/notes.md")}},
                    {"type": "tool_use", "name": "Write", "input": {"file_path": format!("{cwd}/out.md")}},
                    {"type": "tool_use", "name": "Write", "input": {"file_path": format!("{cwd}/out.md")}},
                    {"type": "tool_use", "name": "Edit", "input": {"file_path": "C:/outside/tool.py"}}
                ]}
            }),
            serde_json::json!({
                "type": "user",
                "message": {"content": [{"type": "text", "text": "続きをお願いします"}]}
            }),
            serde_json::json!({
                "type": "assistant",
                "message": {"content": [{"type": "text", "text": "最後の応答の要旨です"}]}
            }),
        ];
        let body = lines
            .iter()
            .map(|line| line.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(path, body).unwrap();
    }

    fn write_codex_transcript(path: &Path, session_id: &str, root_session_id: &str, cwd: &str) {
        let lines = [
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": session_id,
                    "session_id": root_session_id,
                    "cwd": cwd,
                    "git": {"branch": "main"}
                }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "Codex user prompt"}]
                }
            }),
            serde_json::json!({
                "type": "event_msg",
                "payload": {"type": "user_message", "message": "Codex user prompt"}
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call",
                    "name": "apply_patch",
                    "input": "*** Begin Patch\n*** Update File: src/main.ts\n*** End Patch"
                }
            }),
            serde_json::json!({
                "type": "event_msg",
                "payload": {
                    "type": "agent_message",
                    "phase": "commentary",
                    "message": "Working on it"
                }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "Duplicated final"}]
                }
            }),
            serde_json::json!({
                "type": "event_msg",
                "payload": {
                    "type": "agent_message",
                    "phase": "final",
                    "message": "Codex final response"
                }
            }),
        ];
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            path,
            lines
                .iter()
                .map(serde_json::Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
    }

    struct PublishFixture {
        _temp: tempfile::TempDir,
        config_path: PathBuf,
        home: PathBuf,
        projects_dir: PathBuf,
        online_dir: PathBuf,
        cwd: String,
        session_id: String,
    }

    fn setup_fixture() -> PublishFixture {
        let temp = tempdir().unwrap();
        let home = temp.path().join("home");
        let dropbox = temp.path().join("dropbox");
        let cwd_path = dropbox.join("project");
        let online_dir = dropbox.join("_mycmux_online");
        let projects_dir = temp.path().join("claude-projects");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&cwd_path).unwrap();
        fs::create_dir_all(&online_dir).unwrap();

        let cwd = cwd_path.to_string_lossy().into_owned();
        let session_id = "11112222-3333-4444-5555-666677778888".to_string();
        let project_dir = projects_dir.join(sanitize_project_dir(&cwd));
        fs::create_dir_all(&project_dir).unwrap();
        write_transcript(&project_dir.join(format!("{session_id}.jsonl")), &cwd);

        let config_path = temp.path().join("savepoint.json");
        fs::write(
            &config_path,
            serde_json::json!({
                "local_dir": online_dir,
                "dropbox_root": dropbox,
                "author": "miyazaki",
                "machine": "home-windows"
            })
            .to_string(),
        )
        .unwrap();

        PublishFixture {
            _temp: temp,
            config_path,
            home,
            projects_dir,
            online_dir,
            cwd,
            session_id,
        }
    }

    fn publish_fixture(
        fixture: &PublishFixture,
        session: Option<&str>,
        summary: Option<&str>,
        now: chrono::DateTime<Utc>,
    ) -> PublishSavepointResult {
        let mut ignore_progress = |_payload: PublishProgressPayload| {};
        publish_savepoint_impl(
            &fixture.config_path,
            &fixture.home,
            &fixture.projects_dir,
            SavepointAgentKind::Claude,
            &fixture.cwd,
            session,
            summary,
            None,
            PublishMode::Current,
            now,
            &mut ignore_progress,
        )
        .unwrap()
    }

    fn finalize_fixture(
        fixture: &PublishFixture,
        now: chrono::DateTime<Utc>,
    ) -> PublishSavepointResult {
        let mut ignore_progress = |_payload: PublishProgressPayload| {};
        publish_savepoint_impl(
            &fixture.config_path,
            &fixture.home,
            &fixture.projects_dir,
            SavepointAgentKind::Claude,
            &fixture.cwd,
            Some(&fixture.session_id),
            None,
            None,
            PublishMode::Final(SavepointCloseReason::Manual),
            now,
            &mut ignore_progress,
        )
        .unwrap()
    }

    #[test]
    fn tokenize_is_case_insensitive_and_marks_outside_paths() {
        let mapper = PathMapper {
            dropbox_root: Some("C:\\Users\\Miyaz\\Dropbox".to_string()),
        };
        assert_eq!(
            mapper.tokenize("c:/users/miyaz/dropbox/案件/a.md"),
            ("{DROPBOX}/案件/a.md".to_string(), true)
        );
        assert_eq!(
            mapper.tokenize("C:/elsewhere/b.md"),
            ("C:/elsewhere/b.md".to_string(), false)
        );
    }

    #[test]
    fn truncate_flattens_whitespace_and_appends_ellipsis() {
        assert_eq!(truncate("a  b\n\nc", 80), "a b c");
        let long = "あ".repeat(100);
        let truncated = truncate(&long, 80);
        assert_eq!(truncated.chars().count(), 80);
        assert!(truncated.ends_with('…'));
    }

    #[test]
    fn publish_writes_bundle_with_manifest_handoff_and_transcript() {
        let fixture = setup_fixture();
        let now = Utc.with_ymd_and_hms(2026, 7, 11, 3, 0, 0).single().unwrap();

        let result = publish_fixture(&fixture, Some(&fixture.session_id), None, now);

        assert!(!result.updated);
        assert_eq!(result.session_id, fixture.session_id);
        assert_eq!(result.summary_line, "続きをお願いします");
        assert_eq!(result.files_written, 2);
        assert_eq!(result.files_read, 1);
        assert_eq!(result.warnings.len(), 1);

        let bundle_dir = fixture.online_dir.join("miyazaki_11112222");
        assert_eq!(result.bundle_dir, bundle_dir.to_string_lossy());
        let manifest: Value = read_json(&bundle_dir.join("manifest.json")).unwrap();
        assert_eq!(manifest["schema"], 1);
        assert_eq!(manifest["author"], "miyazaki");
        assert_eq!(manifest["machine"], "home-windows");
        assert_eq!(manifest["agent_kind"], "claude");
        assert_eq!(manifest["agent_session_id"], fixture.session_id.as_str());
        assert_eq!(manifest["claude_session_id"], fixture.session_id.as_str());
        assert_eq!(manifest["git_branch"], "master");
        assert_eq!(manifest["cwd"], "{DROPBOX}/project");
        assert_eq!(manifest["updated_at"], "2026-07-11T12:00:00+09:00");
        assert_eq!(manifest["expires_at"], "2026-07-13T12:00:00+09:00");
        assert_eq!(manifest["files_written"].as_array().unwrap().len(), 2);
        assert_eq!(manifest["files_touched"].as_array().unwrap().len(), 3);

        let handoff = fs::read_to_string(bundle_dir.join("handoff.md")).unwrap();
        assert!(handoff.contains("# 引き継ぎ: 続きをお願いします"));
        assert!(handoff.contains("最初の指示です"));
        assert!(handoff.contains("最後の応答の要旨です"));
        assert!(handoff.contains("`{DROPBOX}/project/out.md`"));
        assert!(handoff.contains("C:/outside/tool.py` ⚠Dropbox外"));
        assert!(bundle_dir
            .join("transcript")
            .join(format!("{}.jsonl", fixture.session_id))
            .is_file());
        assert!(!fs::read_dir(&fixture.online_dir)
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains(".tmp-"),));
    }

    #[test]
    fn publish_reports_all_progress_stages_for_the_resolved_session() {
        let fixture = setup_fixture();
        let now = Utc.with_ymd_and_hms(2026, 7, 11, 3, 0, 0).single().unwrap();
        let mut progress = Vec::new();
        let mut collect_progress = |payload: PublishProgressPayload| progress.push(payload);

        publish_savepoint_impl(
            &fixture.config_path,
            &fixture.home,
            &fixture.projects_dir,
            SavepointAgentKind::Claude,
            &fixture.cwd,
            Some(&fixture.session_id),
            None,
            None,
            PublishMode::Current,
            now,
            &mut collect_progress,
        )
        .unwrap();

        assert_eq!(
            progress
                .iter()
                .map(|payload| payload.stage)
                .collect::<Vec<_>>(),
            vec![
                PublishProgressStage::Digest,
                PublishProgressStage::Handoff,
                PublishProgressStage::Bundle,
                PublishProgressStage::Register,
                PublishProgressStage::Done,
            ]
        );
        assert!(progress.iter().all(|payload| {
            payload.agent_kind == SavepointAgentKind::Claude
                && payload.agent_session_id == fixture.session_id
                && payload.claude_session_id.as_deref() == Some(fixture.session_id.as_str())
        }));
    }

    #[test]
    fn republish_upserts_preserving_created_at_and_pinned() {
        let fixture = setup_fixture();
        let first_now = Utc.with_ymd_and_hms(2026, 7, 11, 3, 0, 0).single().unwrap();
        let first = publish_fixture(&fixture, Some(&fixture.session_id), None, first_now);
        assert!(!first.updated);

        let bundle_dir = fixture.online_dir.join("miyazaki_11112222");
        let manifest_path = bundle_dir.join("manifest.json");
        let mut manifest: Value = read_json(&manifest_path).unwrap();
        manifest["pinned"] = Value::Bool(true);
        fs::write(&manifest_path, manifest.to_string()).unwrap();

        let second_now = Utc
            .with_ymd_and_hms(2026, 7, 11, 9, 30, 0)
            .single()
            .unwrap();
        let second = publish_fixture(
            &fixture,
            Some(&fixture.session_id),
            Some("上書きサマリ"),
            second_now,
        );

        assert!(second.updated);
        assert_eq!(second.summary_line, "上書きサマリ");
        let manifest: Value = read_json(&manifest_path).unwrap();
        assert_eq!(manifest["created_at"], "2026-07-11T12:00:00+09:00");
        assert_eq!(manifest["updated_at"], "2026-07-11T18:30:00+09:00");
        assert_eq!(manifest["pinned"], true);
        assert_eq!(manifest["summary_line"], "上書きサマリ");
        assert_eq!(manifest["lifecycle"]["status"], "active");
        assert_eq!(second.checkpoint_id, first.checkpoint_id);
    }

    #[test]
    fn finalize_creates_immutable_record_and_next_publish_starts_child_generation() {
        let fixture = setup_fixture();
        let first_now = Utc.with_ymd_and_hms(2026, 7, 11, 3, 0, 0).single().unwrap();
        let current = publish_fixture(&fixture, Some(&fixture.session_id), None, first_now);
        assert_eq!(current.record_kind, SavepointRecordKind::Current);

        let final_now = Utc.with_ymd_and_hms(2026, 7, 11, 4, 0, 0).single().unwrap();
        let finalized = finalize_fixture(&fixture, final_now);
        assert_eq!(finalized.record_kind, SavepointRecordKind::Final);
        assert_eq!(finalized.checkpoint_id, current.checkpoint_id);
        let record_dir = fixture
            .online_dir
            .join(FINAL_RECORDS_DIR)
            .join(&finalized.checkpoint_id);
        assert_eq!(record_dir.to_string_lossy(), finalized.bundle_dir);
        let final_manifest: Value = read_json(&record_dir.join("manifest.json")).unwrap();
        assert_eq!(final_manifest["lifecycle"]["status"], "closed");
        assert_eq!(final_manifest["lifecycle"]["final_checkpoint"], true);
        assert_eq!(final_manifest["lifecycle"]["closed_reason"], "manual");
        let original_record = fs::read(record_dir.join("manifest.json")).unwrap();

        // Simulate a stop after immutable creation but before head closure.
        let head_dir = fixture.online_dir.join("miyazaki_11112222");
        let mut stranded_head: Value = read_json(&head_dir.join("manifest.json")).unwrap();
        stranded_head["lifecycle"]["status"] = Value::String("active".to_string());
        stranded_head["lifecycle"]["final_checkpoint"] = Value::Bool(false);
        stranded_head["lifecycle"]["closed_at"] = Value::Null;
        stranded_head["lifecycle"]["closed_reason"] = Value::Null;
        fs::write(
            head_dir.join("manifest.json"),
            serde_json::to_string_pretty(&stranded_head).unwrap(),
        )
        .unwrap();

        fs::OpenOptions::new()
            .append(true)
            .open(
                fixture
                    .projects_dir
                    .join(sanitize_project_dir(&fixture.cwd))
                    .join(format!("{}.jsonl", fixture.session_id)),
            )
            .unwrap()
            .write_all(b"\n{\"type\":\"user\"}")
            .unwrap();
        let repeated = finalize_fixture(
            &fixture,
            Utc.with_ymd_and_hms(2026, 7, 11, 5, 0, 0).single().unwrap(),
        );
        assert!(repeated.updated);
        assert_eq!(
            fs::read(record_dir.join("manifest.json")).unwrap(),
            original_record
        );
        let repaired_head: Value = read_json(&head_dir.join("manifest.json")).unwrap();
        assert_eq!(repaired_head["lifecycle"]["status"], "closed");

        let resumed = publish_fixture(
            &fixture,
            Some(&fixture.session_id),
            Some("続きの現在地"),
            Utc.with_ymd_and_hms(2026, 7, 11, 6, 0, 0).single().unwrap(),
        );
        assert_ne!(resumed.checkpoint_id, finalized.checkpoint_id);
        assert_eq!(
            resumed.parent_checkpoint_id.as_deref(),
            Some(finalized.checkpoint_id.as_str())
        );
        let head_manifest: Value = read_json(&head_dir.join("manifest.json")).unwrap();
        assert_eq!(head_manifest["lifecycle"]["status"], "active");
        assert_eq!(head_manifest["lifecycle"]["final_checkpoint"], false);
    }

    #[test]
    fn finalize_after_trashing_a_final_starts_a_new_checkpoint() {
        let fixture = setup_fixture();
        let finalized = finalize_fixture(
            &fixture,
            Utc.with_ymd_and_hms(2026, 7, 11, 4, 0, 0).single().unwrap(),
        );
        let record_dir = fixture
            .online_dir
            .join(FINAL_RECORDS_DIR)
            .join(&finalized.checkpoint_id);
        let trash_dir = fixture.online_dir.join("_trash").join("trash-fixture");
        fs::create_dir_all(trash_dir.parent().unwrap()).unwrap();
        fs::rename(&record_dir, &trash_dir).unwrap();
        let head_dir = fixture.online_dir.join("miyazaki_11112222");
        let head_manifest_path = head_dir.join("manifest.json");
        let mut head_manifest: Value = read_json(&head_manifest_path).unwrap();
        head_manifest[TRASHED_FINAL_CHECKPOINT_FIELD] =
            Value::String(finalized.checkpoint_id.clone());
        fs::write(
            &head_manifest_path,
            serde_json::to_string_pretty(&head_manifest).unwrap(),
        )
        .unwrap();

        let repeated = finalize_fixture(
            &fixture,
            Utc.with_ymd_and_hms(2026, 7, 11, 5, 0, 0).single().unwrap(),
        );

        assert_ne!(repeated.checkpoint_id, finalized.checkpoint_id);
        assert_eq!(
            repeated.parent_checkpoint_id.as_deref(),
            Some(finalized.checkpoint_id.as_str())
        );
        assert!(trash_dir.is_dir());
        assert!(fixture
            .online_dir
            .join(FINAL_RECORDS_DIR)
            .join(&repeated.checkpoint_id)
            .is_dir());
        let repaired_head: Value = read_json(&head_manifest_path).unwrap();
        assert_eq!(
            repaired_head["lifecycle"]["checkpoint_id"],
            repeated.checkpoint_id
        );
        assert_eq!(
            repaired_head["lifecycle"]["parent_checkpoint_id"],
            finalized.checkpoint_id
        );
        assert!(repaired_head.get(TRASHED_FINAL_CHECKPOINT_FIELD).is_none());
    }

    #[test]
    fn trashed_final_retry_reuses_bootstrapped_checkpoint() {
        let fixture = setup_fixture();
        let finalized = finalize_fixture(
            &fixture,
            Utc.with_ymd_and_hms(2026, 7, 11, 4, 0, 0).single().unwrap(),
        );
        let records_dir = fixture.online_dir.join(FINAL_RECORDS_DIR);
        let record_dir = records_dir.join(&finalized.checkpoint_id);
        let trash_dir = fixture.online_dir.join("_trash").join("trash-fixture");
        fs::create_dir_all(trash_dir.parent().unwrap()).unwrap();
        fs::rename(&record_dir, &trash_dir).unwrap();
        let head_dir = fixture.online_dir.join("miyazaki_11112222");
        let head_manifest_path = head_dir.join("manifest.json");
        let mut head_manifest: Value = read_json(&head_manifest_path).unwrap();
        head_manifest[TRASHED_FINAL_CHECKPOINT_FIELD] =
            Value::String(finalized.checkpoint_id.clone());
        fs::write(
            &head_manifest_path,
            serde_json::to_string_pretty(&head_manifest).unwrap(),
        )
        .unwrap();

        let mut injected_target = None;
        let failure = {
            let mut inject_failure = |payload: PublishProgressPayload| {
                if payload.stage != PublishProgressStage::Bundle || injected_target.is_some() {
                    return;
                }
                let bootstrap: Value = read_json(&head_manifest_path).unwrap();
                let checkpoint_id = bootstrap["lifecycle"]["checkpoint_id"]
                    .as_str()
                    .unwrap()
                    .to_string();
                assert_ne!(checkpoint_id, finalized.checkpoint_id);
                assert_eq!(
                    bootstrap["lifecycle"]["parent_checkpoint_id"],
                    finalized.checkpoint_id
                );
                let target = records_dir.join(checkpoint_id);
                fs::create_dir_all(&target).unwrap();
                injected_target = Some(target);
            };
            publish_savepoint_impl(
                &fixture.config_path,
                &fixture.home,
                &fixture.projects_dir,
                SavepointAgentKind::Claude,
                &fixture.cwd,
                Some(&fixture.session_id),
                None,
                None,
                PublishMode::Final(SavepointCloseReason::Manual),
                Utc.with_ymd_and_hms(2026, 7, 11, 5, 0, 0).single().unwrap(),
                &mut inject_failure,
            )
            .unwrap_err()
        };
        assert!(failure.contains("manifest.json"));
        let injected_target = injected_target.unwrap();
        let bootstrapped: Value = read_json(&head_manifest_path).unwrap();
        let bootstrapped_id = bootstrapped["lifecycle"]["checkpoint_id"]
            .as_str()
            .unwrap()
            .to_string();
        fs::rename(&injected_target, records_dir.join(".injected-conflict")).unwrap();

        let repeated = finalize_fixture(
            &fixture,
            Utc.with_ymd_and_hms(2026, 7, 11, 6, 0, 0).single().unwrap(),
        );

        assert_eq!(repeated.checkpoint_id, bootstrapped_id);
        assert_eq!(
            repeated.parent_checkpoint_id.as_deref(),
            Some(finalized.checkpoint_id.as_str())
        );
        let records = fs::read_dir(&records_dir)
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry.path().is_dir() && !entry.file_name().to_string_lossy().starts_with('.')
            })
            .count();
        assert_eq!(records, 1);
    }

    #[test]
    fn invalid_checkpoint_id_cannot_escape_final_records_directory() {
        let fixture = setup_fixture();
        let now = Utc.with_ymd_and_hms(2026, 7, 11, 3, 0, 0).single().unwrap();
        publish_fixture(&fixture, Some(&fixture.session_id), None, now);
        let head_dir = fixture.online_dir.join("miyazaki_11112222");
        let manifest_path = head_dir.join("manifest.json");
        let mut manifest: Value = read_json(&manifest_path).unwrap();
        manifest["lifecycle"]["checkpoint_id"] = Value::String("../../escaped".to_string());
        fs::write(
            &manifest_path,
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();

        let finalized = finalize_fixture(
            &fixture,
            Utc.with_ymd_and_hms(2026, 7, 11, 4, 0, 0).single().unwrap(),
        );

        assert!(uuid::Uuid::parse_str(&finalized.checkpoint_id).is_ok());
        let records_dir = fixture.online_dir.join(FINAL_RECORDS_DIR);
        assert_eq!(
            Path::new(&finalized.bundle_dir).parent(),
            Some(records_dir.as_path())
        );
        assert!(!fixture
            .online_dir
            .parent()
            .unwrap()
            .join("escaped")
            .exists());
    }

    #[test]
    fn old_final_record_does_not_rewind_a_newer_head() {
        let fixture = setup_fixture();
        let now = Utc.with_ymd_and_hms(2026, 7, 11, 3, 0, 0).single().unwrap();
        publish_fixture(&fixture, Some(&fixture.session_id), None, now);
        let finalized = finalize_fixture(
            &fixture,
            Utc.with_ymd_and_hms(2026, 7, 11, 4, 0, 0).single().unwrap(),
        );
        let head_dir = fixture.online_dir.join("miyazaki_11112222");
        let old_record = fixture
            .online_dir
            .join(FINAL_RECORDS_DIR)
            .join(finalized.checkpoint_id);
        publish_fixture(
            &fixture,
            Some(&fixture.session_id),
            Some("new generation"),
            Utc.with_ymd_and_hms(2026, 7, 11, 5, 0, 0).single().unwrap(),
        );
        let newer_head = fs::read(head_dir.join("manifest.json")).unwrap();

        write_head_from_final_record(&old_record, &head_dir).unwrap();

        assert_eq!(
            fs::read(head_dir.join("manifest.json")).unwrap(),
            newer_head
        );
    }

    #[test]
    fn current_publish_rotates_when_final_exists_but_head_is_still_active() {
        let fixture = setup_fixture();
        let now = Utc.with_ymd_and_hms(2026, 7, 11, 3, 0, 0).single().unwrap();
        let current = publish_fixture(&fixture, Some(&fixture.session_id), None, now);
        let finalized = finalize_fixture(
            &fixture,
            Utc.with_ymd_and_hms(2026, 7, 11, 4, 0, 0).single().unwrap(),
        );
        let head_dir = fixture.online_dir.join("miyazaki_11112222");
        let mut stranded_head: Value = read_json(&head_dir.join("manifest.json")).unwrap();
        stranded_head["lifecycle"]["status"] = Value::String("active".to_string());
        stranded_head["lifecycle"]["final_checkpoint"] = Value::Bool(false);
        fs::write(
            head_dir.join("manifest.json"),
            serde_json::to_string_pretty(&stranded_head).unwrap(),
        )
        .unwrap();

        let resumed = publish_fixture(
            &fixture,
            Some(&fixture.session_id),
            Some("continued after stranded final"),
            Utc.with_ymd_and_hms(2026, 7, 11, 5, 0, 0).single().unwrap(),
        );

        assert_eq!(current.checkpoint_id, finalized.checkpoint_id);
        assert_ne!(resumed.checkpoint_id, finalized.checkpoint_id);
        assert_eq!(
            resumed.parent_checkpoint_id.as_deref(),
            Some(finalized.checkpoint_id.as_str())
        );
    }

    #[test]
    fn finalize_recovers_checkpoint_id_from_interrupted_head_swap() {
        let fixture = setup_fixture();
        let now = Utc.with_ymd_and_hms(2026, 7, 11, 3, 0, 0).single().unwrap();
        let current = publish_fixture(&fixture, Some(&fixture.session_id), None, now);
        let finalized = finalize_fixture(
            &fixture,
            Utc.with_ymd_and_hms(2026, 7, 11, 4, 0, 0).single().unwrap(),
        );
        let head_dir = fixture.online_dir.join("miyazaki_11112222");
        fs::rename(
            &head_dir,
            fixture.online_dir.join("miyazaki_11112222.old-crash"),
        )
        .unwrap();

        let repeated = finalize_fixture(
            &fixture,
            Utc.with_ymd_and_hms(2026, 7, 11, 5, 0, 0).single().unwrap(),
        );

        assert_eq!(repeated.checkpoint_id, current.checkpoint_id);
        assert_eq!(repeated.checkpoint_id, finalized.checkpoint_id);
        let records = fs::read_dir(fixture.online_dir.join(FINAL_RECORDS_DIR))
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry.path().is_dir() && !entry.file_name().to_string_lossy().starts_with('.')
            })
            .count();
        assert_eq!(records, 1);
        let repaired: Value = read_json(&head_dir.join("manifest.json")).unwrap();
        assert_eq!(repaired["lifecycle"]["status"], "closed");
    }

    #[test]
    fn final_records_path_must_be_a_real_directory() {
        let fixture = setup_fixture();
        fs::write(
            fixture.online_dir.join(FINAL_RECORDS_DIR),
            "not a directory",
        )
        .unwrap();

        assert!(safe_final_records_dir(&fixture.online_dir, true).is_err());
    }

    #[test]
    fn latest_session_fallback_picks_newest_jsonl() {
        let fixture = setup_fixture();
        let project_dir = fixture
            .projects_dir
            .join(sanitize_project_dir(&fixture.cwd));
        let older = project_dir.join("00000000-0000-4000-8000-000000000000.jsonl");
        write_transcript(&older, &fixture.cwd);
        let newest = project_dir.join(format!("{}.jsonl", fixture.session_id));
        let future = std::time::SystemTime::now() + std::time::Duration::from_secs(120);
        let file = fs::OpenOptions::new().append(true).open(&newest).unwrap();
        file.set_modified(future).unwrap();

        let now = Utc.with_ymd_and_hms(2026, 7, 11, 3, 0, 0).single().unwrap();
        let result = publish_fixture(&fixture, None, None, now);
        assert_eq!(result.session_id, fixture.session_id);
    }

    #[test]
    fn explicit_session_falls_back_to_cross_project_search() {
        let fixture = setup_fixture();
        let stray_dir = fixture.projects_dir.join("some-other-project");
        fs::create_dir_all(&stray_dir).unwrap();
        let stray_session = "99990000-aaaa-4bbb-8ccc-ddddeeeeffff";
        write_transcript(
            &stray_dir.join(format!("{stray_session}.jsonl")),
            &fixture.cwd,
        );

        let now = Utc.with_ymd_and_hms(2026, 7, 11, 3, 0, 0).single().unwrap();
        let result = publish_fixture(&fixture, Some(stray_session), None, now);
        assert_eq!(result.session_id, stray_session);
    }

    #[test]
    fn codex_digest_prefers_event_messages_and_collects_explicit_patch_paths() {
        let temp = tempdir().unwrap();
        let session_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        let path = temp
            .path()
            .join(format!("rollout-2026-07-14T10-00-00-{session_id}.jsonl"));
        write_codex_transcript(&path, session_id, session_id, "C:/work/codex");

        let digest = digest_codex_transcript(&path).unwrap();

        assert_eq!(digest.cwd.as_deref(), Some("C:/work/codex"));
        assert_eq!(digest.git_branch.as_deref(), Some("main"));
        assert_eq!(digest.user_prompts, vec!["Codex user prompt"]);
        assert_eq!(digest.turn_count, 1);
        assert_eq!(digest.last_assistant_text, "Codex final response");
        assert_eq!(digest.files_written, vec!["src/main.ts"]);
    }

    #[test]
    fn codex_locator_matches_payload_id_not_parent_session_id() {
        let temp = tempdir().unwrap();
        let requested = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        let child = "11111111-2222-4333-8444-555555555555";
        let wrong = temp
            .path()
            .join("2026/07/13")
            .join(format!("rollout-2026-07-13T10-00-00-{requested}.jsonl"));
        write_codex_transcript(&wrong, child, requested, "C:/work/codex");
        let correct = temp
            .path()
            .join("2026/07/14")
            .join(format!("rollout-2026-07-14T10-00-00-{requested}.jsonl"));
        write_codex_transcript(&correct, requested, requested, "C:/work/codex");

        let (located, id) =
            locate_codex_transcript(temp.path(), "C:/work/codex", Some(requested)).unwrap();
        assert_eq!(located, correct);
        assert_eq!(id, requested);
    }

    #[test]
    fn codex_locator_never_falls_back_when_explicit_id_is_missing() {
        let temp = tempdir().unwrap();
        let existing = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        let missing = "99999999-8888-4777-8666-555555555555";
        let path = temp
            .path()
            .join("2026/07/14")
            .join(format!("rollout-2026-07-14T10-00-00-{existing}.jsonl"));
        write_codex_transcript(&path, existing, existing, "C:/work/codex");

        let error =
            locate_codex_transcript(temp.path(), "C:/work/codex", Some(missing)).unwrap_err();
        assert!(error.contains(missing));
    }

    #[test]
    fn codex_publish_writes_generic_manifest_without_legacy_claude_identity() {
        let fixture = setup_fixture();
        let session_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        let sessions_root = fixture._temp.path().join("codex-sessions");
        let transcript = sessions_root
            .join("2026/07/14")
            .join(format!("rollout-2026-07-14T10-00-00-{session_id}.jsonl"));
        write_codex_transcript(&transcript, session_id, session_id, &fixture.cwd);
        let mut progress = Vec::new();

        let result = publish_savepoint_impl(
            &fixture.config_path,
            &fixture.home,
            &sessions_root,
            SavepointAgentKind::Codex,
            &fixture.cwd,
            Some(session_id),
            None,
            None,
            PublishMode::Current,
            Utc.with_ymd_and_hms(2026, 7, 14, 1, 0, 0).single().unwrap(),
            &mut |payload| progress.push(payload),
        )
        .unwrap();

        let bundle = fixture.online_dir.join("miyazaki_codex_aaaaaaaa");
        assert_eq!(result.bundle_dir, bundle.to_string_lossy());
        let manifest: Value = read_json(&bundle.join("manifest.json")).unwrap();
        assert_eq!(manifest["agent_kind"], "codex");
        assert_eq!(manifest["agent_session_id"], session_id);
        assert!(manifest["claude_session_id"].is_null());
        assert!(progress.iter().all(|payload| {
            payload.agent_kind == SavepointAgentKind::Codex
                && payload.agent_session_id == session_id
                && payload.claude_session_id.is_none()
        }));
    }
}

#[cfg(test)]
mod stale_id_fallback_tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn locate_falls_back_to_latest_when_requested_id_has_no_transcript() {
        let temp = tempdir().unwrap();
        let projects = temp.path();
        let project_dir = projects.join(sanitize_project_dir("C:/work/demo"));
        fs::create_dir_all(&project_dir).unwrap();
        fs::write(project_dir.join("real-session.jsonl"), "{}\n").unwrap();

        let (path, session_id) =
            locate_claude_transcript(projects, "C:/work/demo", Some("ghost-session")).unwrap();
        assert_eq!(session_id, "real-session");
        assert!(path.ends_with("real-session.jsonl"));
    }

    #[test]
    fn locate_still_errors_when_no_transcript_exists_at_all() {
        let temp = tempdir().unwrap();
        let projects = temp.path();
        fs::create_dir_all(projects.join(sanitize_project_dir("C:/work/empty"))).unwrap();

        let result = locate_claude_transcript(projects, "C:/work/empty", Some("ghost-session"));
        assert!(result.is_err());
    }
}
