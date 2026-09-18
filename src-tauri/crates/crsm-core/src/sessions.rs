use crate::cache::{
    cache_path, file_stamp, load_cache, save_cache, stamp_key, CacheFile, CacheLookup,
    CACHE_SCHEMA_VERSION,
};
use crate::models::{AgentKind, SessionEntry};
use crate::path_norm::{claude_session_path, home_dir};
use crate::preview::{
    extract_claude_visible_text, extract_codex_visible_text, extract_text_from_value, trim_preview,
};
use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Utc};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct ListOptions {
    pub refresh: bool,
    pub use_cache: bool,
}

impl Default for ListOptions {
    fn default() -> Self {
        Self {
            refresh: false,
            use_cache: true,
        }
    }
}

const MIN_USER_CHARS: usize = 10;

fn is_auto_injection(text: &str) -> bool {
    let trimmed = text.trim_start();
    // Scheduled-job prompts injected by local hooks/cron carry this marker in
    // their first line; the user never typed them.
    if trimmed
        .lines()
        .next()
        .is_some_and(|line| line.contains("(自動実行ジョブ)"))
    {
        return true;
    }
    trimmed.starts_with("<INSTRUCTIONS>")
        || trimmed.starts_with("<environment_context>")
        || trimmed.starts_with("<system-reminder>")
        || trimmed.starts_with("<command-message>")
        || trimmed.starts_with("<command-name>")
        || trimmed.starts_with("<command-args>")
        || trimmed.starts_with("<local-command-stdout>")
        || trimmed.starts_with("<local-command-stderr>")
        || trimmed.starts_with("<bash-input>")
        || trimmed.starts_with("<bash-stdout>")
        || trimmed.starts_with("<bash-stderr>")
        || trimmed.starts_with("<recommended_plugins>")
        // Codex Desktop / IDE auto-attached context, not typed by the user.
        || trimmed.starts_with("# Files mentioned by the user:")
        // Delegation spec prompts sent from Claude Code to Codex (codex-helper
        // templates) always open with a <task> block; humans don't type this.
        || trimmed.starts_with("<task>")
        || trimmed.starts_with("# AGENTS.md")
        // Claude Code assistant output markers; real user input rarely starts with these.
        || trimmed.starts_with("●")
        || trimmed.starts_with("✻")
        || trimmed.starts_with("⏿")
        // mycmux Buddy persona prompt sent to Codex (auto-generated, not a user query).
        || trimmed.starts_with("You はユーザーの PC に住んでいる相棒")
        // mycmux internal ailog summarizer marker (same constant as ailog/digest.rs).
        || trimmed.starts_with("[mycmux-ailog-summarizer]")
        // mycmux handoff / spec-injection bootstrap; the user did not type this.
        || trimmed.starts_with("Handoff from previous session.")
}

/// Count "pure" user-authored chars in a Claude JSONL record.
///
/// Real user inputs use the structured form `content: [{type:"text", text:"..."}]`.
/// Claude Code's auto-injected restore context appears as `content: "..."` (plain
/// string), which we treat as zero pure-user chars. Tool results, thinking blocks,
/// and tagged auto-injections inside the array are also skipped.
fn count_pure_user_chars_claude(value: &Value) -> usize {
    let Some(msg) = value.get("message") else { return 0; };
    if msg.get("role").and_then(Value::as_str) != Some("user") {
        return 0;
    }
    let Some(content) = msg.get("content") else { return 0; };
    // Plain-string content: real user inputs in older Claude Code versions look
    // like this too, so we still count them — but skip Claude Code's auto-injected
    // restore context (which always starts with bullet markers like "●").
    if let Some(text) = content.as_str() {
        if is_auto_injection(text) {
            return 0;
        }
        return text.chars().count();
    }
    let Some(parts) = content.as_array() else { return 0; };
    let mut chars = 0usize;
    for part in parts {
        let Some(obj) = part.as_object() else { continue; };
        if obj.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        let Some(text) = obj.get("text").and_then(Value::as_str) else {
            continue;
        };
        if is_auto_injection(text) {
            continue;
        }
        chars = chars.saturating_add(text.chars().count());
    }
    chars
}

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("failed to resolve home directory")]
    NoHome,
    #[error("{0}")]
    Io(String),
}

#[derive(Debug, Deserialize)]
struct ClaudeIndexEntry {
    timestamp: Option<String>,
    session_id: String,
    cwd: Option<String>,
    first_message: Option<String>,
    assistant_conclusion: Option<String>,
    summary_file: Option<String>,
    files_modified: Option<Vec<String>>,
    incomplete_tasks: Option<Vec<String>>,
}

fn parse_datetime(value: Option<&str>) -> DateTime<Utc> {
    let Some(value) = value else {
        return Utc::now();
    };
    if let Ok(parsed) = DateTime::parse_from_rfc3339(value) {
        return parsed.with_timezone(&Utc);
    }
    if let Ok(naive) = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f") {
        if let Some(local) = Local.from_local_datetime(&naive).single() {
            return local.with_timezone(&Utc);
        }
    }
    Utc::now()
}

fn modified_time(path: &Path) -> DateTime<Utc> {
    path.metadata()
        .and_then(|metadata| metadata.modified())
        .map(DateTime::<Utc>::from)
        .unwrap_or_else(|_| Utc::now())
}

fn list_claude_index(home: &Path, old_cache: Option<&CacheLookup>) -> Vec<SessionEntry> {
    let index_path = home
        .join(".claude")
        .join("session-archive")
        .join("index.jsonl");
    if !index_path.is_file() {
        return Vec::new();
    }
    if let Some(cache) = old_cache.filter(|cache| cache.unchanged(&index_path)) {
        return cache.entries_for_path(&index_path);
    }

    let Ok(file) = File::open(&index_path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(item) = serde_json::from_str::<ClaudeIndexEntry>(&line) else {
            continue;
        };
        let cwd = item
            .cwd
            .unwrap_or_else(|| home.to_string_lossy().to_string());
        let transcript_path = claude_session_path(home, &cwd, &item.session_id);
        let first = item.first_message.unwrap_or_default();
        // Default to false: index.jsonl's first_message is often the assistant's
        // initial bullet (e.g. "● ..."), not a real user prompt. We trust the
        // live transcript scan below to override when it's available; archived
        // sessions without a live transcript stay hidden under the toggle.
        let mut has_user_messages = false;
        let conclusion = item.assistant_conclusion.unwrap_or_default();
        let label = trim_preview(
            if first.is_empty() {
                item.session_id.as_str()
            } else {
                first.as_str()
            },
            100,
        );
        let preview = [first, conclusion]
            .into_iter()
            .filter(|part| !part.trim().is_empty())
            .map(|part| trim_preview(&part, 600))
            .collect::<Vec<_>>()
            .join("\n");
        let activity = parse_datetime(item.timestamp.as_deref());
        let transcript_opt = transcript_path.is_file().then_some(transcript_path.clone());
        let mut final_preview = preview;
        if let Some(ref tp) = transcript_opt {
            if let Some(live_entry) = scan_claude_live_file(home, tp) {
                if live_entry.preview.len() > final_preview.len() {
                    final_preview = live_entry.preview;
                }
                has_user_messages = live_entry.has_user_messages;
            }
        }
        out.push(SessionEntry {
            kind: AgentKind::Claude,
            id: item.session_id,
            cwd,
            label,
            preview: final_preview,
            last_activity: activity,
            started_at: item.timestamp.as_deref().map(|_| activity),
            source: "claude-index".to_string(),
            source_path: index_path.clone(),
            transcript_path: transcript_opt,
            summary_file: item.summary_file,
            files_modified: item.files_modified.unwrap_or_default(),
            incomplete_tasks: item.incomplete_tasks.unwrap_or_default(),
            has_user_messages,
        });
    }
    out
}

fn list_claude_live(home: &Path, old_cache: Option<&CacheLookup>) -> Vec<SessionEntry> {
    let projects_dir = home.join(".claude").join("projects");
    let Ok(project_dirs) = fs::read_dir(projects_dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for project_dir in project_dirs.flatten() {
        let Ok(file_type) = project_dir.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(project_dir.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(cache) = old_cache.and_then(|cache| {
                cache
                    .unchanged(&path)
                    .then(|| cache.entry_for_path(&path))
                    .flatten()
            }) {
                out.push(cache);
                continue;
            }
            if let Some(entry) = scan_claude_live_file(home, &path) {
                out.push(entry);
            }
        }
    }
    out
}

fn scan_claude_live_file(home: &Path, path: &Path) -> Option<SessionEntry> {
    let file = File::open(path).ok()?;
    let mut session_id = path.file_stem()?.to_string_lossy().to_string();
    let mut cwd = home.to_string_lossy().to_string();
    let mut preview_parts = Vec::new();
    let mut started_at: Option<DateTime<Utc>> = None;
    let mut pure_user_chars: usize = 0;
    // Headless invocations (claude -p via SDK, hooks, cron) record
    // entrypoint "sdk-cli"; interactive sessions record "cli".
    let mut headless = false;
    for line in BufReader::new(file).lines().map_while(Result::ok).take(150) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(found) = value.get("sessionId").and_then(Value::as_str) {
            session_id = found.to_string();
        }
        if let Some(found) = value.get("cwd").and_then(Value::as_str) {
            cwd = found.to_string();
        }
        if value.get("entrypoint").and_then(Value::as_str) == Some("sdk-cli") {
            headless = true;
        }
        if started_at.is_none() {
            if let Some(ts) = value.get("timestamp").and_then(Value::as_str) {
                started_at = Some(parse_datetime(Some(ts)));
            }
        }
        pure_user_chars = pure_user_chars.saturating_add(count_pure_user_chars_claude(&value));
        if let Some((role, text)) = extract_claude_visible_text(&value) {
            if preview_parts.len() < 6 {
                preview_parts.push(format!("{role}: {}", trim_preview(&text, 500)));
            }
        }
    }
    let has_user_messages = !headless && pure_user_chars >= MIN_USER_CHARS;
    let label = preview_parts
        .first()
        .map(|value| trim_preview(value, 100))
        .unwrap_or_else(|| session_id.clone());
    Some(SessionEntry {
        kind: AgentKind::Claude,
        id: session_id,
        cwd,
        label,
        preview: preview_parts.join("\n"),
        last_activity: modified_time(path),
        started_at,
        source: "claude-live".to_string(),
        source_path: path.to_path_buf(),
        transcript_path: Some(path.to_path_buf()),
        summary_file: None,
        files_modified: Vec::new(),
        incomplete_tasks: Vec::new(),
        has_user_messages,
    })
}

fn list_codex(home: &Path, old_cache: Option<&CacheLookup>) -> Vec<SessionEntry> {
    let sessions_dir = home.join(".codex").join("sessions");
    let mut files = Vec::new();
    collect_jsonl_files(&sessions_dir, &mut files);
    let mut out = Vec::new();
    for path in files {
        if let Some(cache) = old_cache.and_then(|cache| {
            cache
                .unchanged(&path)
                .then(|| cache.entry_for_path(&path))
                .flatten()
        }) {
            out.push(cache);
            continue;
        }
        if let Some(entry) = scan_codex_session(&path) {
            out.push(entry);
        }
    }
    out
}

fn list_claude_codex(home: &Path, old_cache: Option<&CacheLookup>) -> Vec<SessionEntry> {
    let projects_dir = home.join(".claude-codex").join("config").join("projects");
    let mut files = Vec::new();
    collect_jsonl_files_skipping_subagents(&projects_dir, &mut files);
    let mut out = Vec::new();
    for path in files {
        if let Some(cache) = old_cache.and_then(|cache| {
            cache
                .unchanged(&path)
                .then(|| cache.entry_for_path(&path))
                .flatten()
        }) {
            out.push(cache);
            continue;
        }
        if let Some(entry) = scan_claude_codex_file(home, &path) {
            out.push(entry);
        }
    }
    out
}

fn collect_jsonl_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_jsonl_files(&path, out);
        } else if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

fn collect_jsonl_files_skipping_subagents(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            if entry.file_name() == "subagents" {
                continue;
            }
            collect_jsonl_files_skipping_subagents(&path, out);
        } else if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

fn has_claude_codex_jsonl(home: &Path) -> bool {
    let projects_dir = home.join(".claude-codex").join("config").join("projects");
    let mut files = Vec::new();
    collect_jsonl_files_skipping_subagents(&projects_dir, &mut files);
    !files.is_empty()
}

fn cache_has_current_sources(home: &Path, cache: &CacheFile) -> bool {
    let cache_has_hybrid = cache
        .entries
        .iter()
        .any(|entry| entry.kind == AgentKind::ClaudeCodex);
    if !cache_has_hybrid && has_claude_codex_jsonl(home) {
        return false;
    }
    true
}

fn scan_claude_codex_file(home: &Path, path: &Path) -> Option<SessionEntry> {
    let file = File::open(path).ok()?;
    let mut session_id = path.file_stem()?.to_string_lossy().to_string();
    let mut cwd = home.to_string_lossy().to_string();
    let mut preview_parts = Vec::new();
    let mut started_at: Option<DateTime<Utc>> = None;
    let mut pure_user_chars: usize = 0;
    // Same headless marker as Claude live: `claude -p` / SDK records "sdk-cli".
    let mut headless = false;
    for line in BufReader::new(file).lines().map_while(Result::ok).take(180) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(found) = value.get("sessionId").and_then(Value::as_str) {
            session_id = found.to_string();
        }
        if let Some(found) = value.get("cwd").and_then(Value::as_str) {
            cwd = found.to_string();
        }
        if value.get("entrypoint").and_then(Value::as_str) == Some("sdk-cli") {
            headless = true;
        }
        if started_at.is_none() {
            if let Some(ts) = value.get("timestamp").and_then(Value::as_str) {
                started_at = Some(parse_datetime(Some(ts)));
            }
        }
        pure_user_chars = pure_user_chars.saturating_add(count_pure_user_chars_claude(&value));
        if let Some((role, text)) = extract_claude_visible_text(&value) {
            if preview_parts.len() < 6 {
                preview_parts.push(format!("{role}: {}", trim_preview(&text, 500)));
            }
        }
    }
    let has_user_messages = !headless && pure_user_chars >= MIN_USER_CHARS;
    let label = preview_parts
        .first()
        .map(|value| trim_preview(value, 100))
        .unwrap_or_else(|| session_id.clone());
    Some(SessionEntry {
        kind: AgentKind::ClaudeCodex,
        id: session_id,
        cwd,
        label,
        preview: preview_parts.join("\n"),
        last_activity: modified_time(path),
        started_at,
        source: "claude-codex-jsonl".to_string(),
        source_path: path.to_path_buf(),
        transcript_path: Some(path.to_path_buf()),
        summary_file: None,
        files_modified: Vec::new(),
        incomplete_tasks: Vec::new(),
        has_user_messages,
    })
}

/// Non-human Codex threads: parent-spawned subagents and headless `codex exec`.
///
/// `source` is either a string (`"exec"` / `"cli"`) or an object
/// (`{ "subagent": { ... } }`). `codex exec` also sets
/// `originator: "codex_exec"` while leaving `thread_source` as `"user"`.
fn spawned_by_parent(payload: &Value) -> bool {
    if payload.get("thread_source").and_then(Value::as_str) == Some("subagent") {
        return true;
    }
    if payload.get("originator").and_then(Value::as_str) == Some("codex_exec") {
        return true;
    }
    match payload.get("source") {
        Some(Value::String(source)) if source == "exec" => true,
        Some(Value::Object(source)) if source.contains_key("subagent") => true,
        _ => false,
    }
}

fn scan_codex_session(path: &Path) -> Option<SessionEntry> {
    let file = File::open(path).ok()?;
    let mut lines = BufReader::new(file).lines();
    let meta_line = lines.next()?.ok()?;
    let meta: Value = serde_json::from_str(&meta_line).ok()?;
    if meta.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    let payload = meta.get("payload")?;
    let id = payload.get("id").and_then(Value::as_str)?.to_string();
    let cwd = payload.get("cwd").and_then(Value::as_str)?.to_string();
    // Threads spawned by a parent (fusion fan-out, Claude Code sidecars,
    // Codex Desktop subagents, `codex exec` / mycmux internal AI) are
    // never something the user typed into an interactive TUI.
    let spawned = spawned_by_parent(payload);
    let started_at = meta
        .get("timestamp")
        .and_then(Value::as_str)
        .map(|ts| parse_datetime(Some(ts)));
    let mut preview_parts = Vec::new();
    let mut pure_user_chars: usize = 0;
    for line in lines.map_while(Result::ok).take(80) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(text) = extract_codex_visible_text(&value) {
            let payload = value.get("payload").unwrap_or(&value);
            if payload.get("role").and_then(Value::as_str) == Some("user")
                && !is_auto_injection(&text)
            {
                pure_user_chars = pure_user_chars.saturating_add(text.chars().count());
            }
            if preview_parts.len() < 6 && !is_auto_injection(&text) {
                preview_parts.push(trim_preview(&text, 500));
            }
        }
    }
    let has_user_messages = !spawned && pure_user_chars >= MIN_USER_CHARS;
    let label = preview_parts
        .first()
        .map(|value| trim_preview(value, 100))
        .unwrap_or_else(|| id.clone());
    Some(SessionEntry {
        kind: AgentKind::Codex,
        id,
        cwd,
        label,
        preview: preview_parts.join("\n"),
        last_activity: modified_time(path),
        started_at,
        source: "codex-jsonl".to_string(),
        source_path: path.to_path_buf(),
        transcript_path: Some(path.to_path_buf()),
        summary_file: None,
        files_modified: Vec::new(),
        incomplete_tasks: Vec::new(),
        has_user_messages,
    })
}

fn dedupe_sessions(entries: Vec<SessionEntry>) -> Vec<SessionEntry> {
    let mut by_key: HashMap<String, SessionEntry> = HashMap::new();
    for entry in entries {
        let key = format!("{}:{}", entry.kind, entry.id);
        match by_key.remove(&key) {
            Some(old) => {
                let earliest_start = match (old.started_at, entry.started_at) {
                    (Some(a), Some(b)) => Some(a.min(b)),
                    (Some(a), None) => Some(a),
                    (None, Some(b)) => Some(b),
                    (None, None) => None,
                };
                let mut winner = if old.last_activity >= entry.last_activity {
                    old
                } else {
                    entry
                };
                winner.started_at = earliest_start;
                by_key.insert(key, winner);
            }
            None => {
                by_key.insert(key, entry);
            }
        }
    }
    let mut out = by_key.into_values().collect::<Vec<_>>();
    out.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
    out
}

/// A cached list older than this triggers a background rescan. The stale
/// cache is still served immediately (stale-while-revalidate), so callers
/// that omit --refresh (mycmux launcher picker, palette fast path) always
/// get a ~0.1s response and never hit their own spawn timeouts; rescans
/// (incremental, 1.5-6s depending on disk pressure) run detached.
/// Public so hosts that vendor this crate with `spawn-refresh` off can apply
/// the same threshold to the rescan they run themselves.
pub const CACHE_FRESH_TTL_SECS: i64 = 60;

/// A refresh.lock older than this is treated as abandoned (crashed child);
/// full rescans after a schema bump take ~90s, so leave generous headroom.
#[cfg(feature = "spawn-refresh")]
const REFRESH_LOCK_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(300);

fn refresh_lock_path(home: &Path) -> PathBuf {
    cache_path(home).with_file_name("refresh.lock")
}

/// Clear the inherit flag on our std handles before spawning the detached
/// refresh child. Callers that read us through a pipe (bash `$(...)`,
/// piped subprocesses) mark the pipe's write end inheritable; without this
/// the child inherits it and the caller never sees EOF until the rescan
/// finishes — exactly the hang we are trying to avoid.
#[cfg(all(windows, feature = "spawn-refresh"))]
fn unset_std_handle_inheritance() {
    use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};
    use windows_sys::Win32::System::Console::{
        GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    unsafe {
        for kind in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            let handle = GetStdHandle(kind);
            if !handle.is_null() && handle != usize::MAX as *mut core::ffi::c_void {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

/// Re-exec ourselves as `crsm list --refresh` so the next caller finds a fresh
/// cache. Only correct when `current_exe()` is the crsm CLI, which is why it
/// sits behind a feature: a host that vendors this crate (mycmux) would
/// relaunch its own app here. See the `spawn-refresh` note in Cargo.toml.
#[cfg(feature = "spawn-refresh")]
fn spawn_background_refresh(home: &Path) {
    let lock = refresh_lock_path(home);
    let lock_is_live = lock
        .metadata()
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age < REFRESH_LOCK_MAX_AGE);
    if lock_is_live {
        return;
    }
    if let Some(parent) = lock.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if fs::write(&lock, b"").is_err() {
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        let _ = fs::remove_file(&lock);
        return;
    };
    #[cfg(windows)]
    unset_std_handle_inheritance();
    let mut command = std::process::Command::new(exe);
    command
        .args(["list", "--refresh", "--all", "--limit", "1"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    if command.spawn().is_err() {
        let _ = fs::remove_file(&lock);
    }
}

/// No-op stand-in for hosts that refresh the cache themselves.
#[cfg(not(feature = "spawn-refresh"))]
fn spawn_background_refresh(_home: &Path) {}

pub fn list_all_sessions(options: &ListOptions) -> Result<Vec<SessionEntry>, SessionError> {
    let home = home_dir().ok_or(SessionError::NoHome)?;
    let old_cache_file = options.use_cache.then(|| load_cache(&home)).flatten();
    if options.use_cache && !options.refresh {
        if let Some(cache) = old_cache_file
            .as_ref()
            .filter(|cache| cache_has_current_sources(&home, cache))
        {
            if Utc::now().signed_duration_since(cache.generated_at)
                >= chrono::Duration::seconds(CACHE_FRESH_TTL_SECS)
            {
                spawn_background_refresh(&home);
            }
            let mut entries = cache.entries.clone();
            entries.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
            return Ok(entries);
        }
    }
    let old_cache = old_cache_file.as_ref().map(CacheFile::lookup);
    let mut entries = Vec::new();
    entries.extend(list_claude_index(&home, old_cache.as_ref()));
    let index_ids = entries
        .iter()
        .filter(|entry| entry.kind == AgentKind::Claude)
        .map(|entry| entry.id.clone())
        .collect::<HashSet<_>>();
    entries.extend(
        list_claude_live(&home, old_cache.as_ref())
            .into_iter()
            .filter(|entry| !index_ids.contains(&entry.id)),
    );
    entries.extend(list_claude_codex(&home, old_cache.as_ref()));
    entries.extend(list_codex(&home, old_cache.as_ref()));
    let entries = dedupe_sessions(entries);

    if options.use_cache {
        let mut file_stamps = HashMap::new();
        for entry in &entries {
            if let Some(stamp) = file_stamp(&entry.source_path) {
                file_stamps.insert(stamp_key(&entry.source_path), stamp);
            }
        }
        let cache = CacheFile {
            schema_version: CACHE_SCHEMA_VERSION,
            generated_at: Utc::now(),
            file_stamps,
            entries: entries.clone(),
        };
        let _ = save_cache(&home, &cache);
        let _ = fs::remove_file(refresh_lock_path(&home));
    }

    Ok(entries)
}

pub fn find_session(
    id: &str,
    kind: Option<AgentKind>,
) -> Result<Option<SessionEntry>, SessionError> {
    let sessions = list_all_sessions(&ListOptions::default())?;
    Ok(sessions
        .into_iter()
        .find(|entry| entry.id == id && kind.as_ref().map(|k| &entry.kind == k).unwrap_or(true)))
}

pub fn summary_text_for_session(home: &Path, entry: &SessionEntry) -> Option<String> {
    let summary_file = entry.summary_file.as_ref()?;
    let path = home
        .join(".claude")
        .join("session-archive")
        .join(summary_file);
    let file = File::open(path).ok()?;
    let mut lines = Vec::new();
    for line in BufReader::new(file).lines().map_while(Result::ok).take(80) {
        lines.push(line);
    }
    let joined = lines.join("\n");
    (!joined.trim().is_empty()).then_some(joined)
}

pub fn first_visible_text_from_json(value: &Value) -> Option<String> {
    extract_text_from_value(value).map(|text| trim_preview(&text, 240))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write_temp_jsonl(name: &str, lines: &[Value]) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("crsm-sessions-{}-{}", std::process::id(), name));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{name}.jsonl"));
        let body = lines
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        fs::write(&path, body).unwrap();
        path
    }

    fn user_text_record(text: &str) -> Value {
        json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": text }]
            }
        })
    }

    fn codex_user_item(text: &str) -> Value {
        json!({
            "type": "response_item",
            "payload": {
                "role": "user",
                "content": [{ "type": "input_text", "text": text }]
            }
        })
    }

    #[test]
    fn auto_injection_zeros_mycmux_ailog_prefix() {
        let text = "[mycmux-ailog-summarizer] digest this tab into a label";
        assert!(is_auto_injection(text));
        assert_eq!(count_pure_user_chars_claude(&user_text_record(text)), 0);
    }

    #[test]
    fn auto_injection_zeros_handoff_bootstrap_prefix() {
        let text = "Handoff from previous session. Read spec.md and continue.";
        assert!(is_auto_injection(text));
        assert_eq!(count_pure_user_chars_claude(&user_text_record(text)), 0);
    }

    #[test]
    fn auto_injection_does_not_zero_plain_user_text() {
        let text = "Please hide the internal AI sessions from the picker.";
        assert!(!is_auto_injection(text));
        assert!(count_pure_user_chars_claude(&user_text_record(text)) >= MIN_USER_CHARS);
    }

    #[test]
    fn spawned_by_parent_treats_codex_exec_originator_as_non_human() {
        assert!(spawned_by_parent(&json!({
            "originator": "codex_exec",
            "source": "exec",
            "thread_source": "user"
        })));
    }

    #[test]
    fn spawned_by_parent_treats_source_exec_string_as_non_human() {
        assert!(spawned_by_parent(&json!({
            "originator": "codex-cli",
            "source": "exec",
            "thread_source": "user"
        })));
    }

    #[test]
    fn spawned_by_parent_keeps_object_subagent_source() {
        assert!(spawned_by_parent(&json!({
            "thread_source": "user",
            "source": { "subagent": { "thread_spawn": { "depth": 1 } } }
        })));
    }

    #[test]
    fn spawned_by_parent_allows_interactive_tui() {
        assert!(!spawned_by_parent(&json!({
            "originator": "codex-tui",
            "source": "cli",
            "thread_source": "user"
        })));
    }

    #[test]
    fn scan_codex_excludes_originator_codex_exec() {
        let path = write_temp_jsonl(
            "codex-exec",
            &[
                json!({
                    "timestamp": "2026-08-01T00:00:00Z",
                    "type": "session_meta",
                    "payload": {
                        "id": "codex-exec-id",
                        "cwd": "C:\\tmp",
                        "originator": "codex_exec",
                        "source": "exec",
                        "thread_source": "user"
                    }
                }),
                codex_user_item("Please implement the filter change now"),
            ],
        );
        let entry = scan_codex_session(&path).unwrap();
        assert!(!entry.has_user_messages);
    }

    #[test]
    fn scan_codex_excludes_source_exec_string() {
        let path = write_temp_jsonl(
            "codex-source-exec",
            &[
                json!({
                    "timestamp": "2026-08-01T00:00:00Z",
                    "type": "session_meta",
                    "payload": {
                        "id": "codex-source-exec-id",
                        "cwd": "C:\\tmp",
                        "source": "exec",
                        "thread_source": "user"
                    }
                }),
                codex_user_item("Please implement the filter change now"),
            ],
        );
        let entry = scan_codex_session(&path).unwrap();
        assert!(!entry.has_user_messages);
    }

    #[test]
    fn scan_codex_keeps_interactive_user_session() {
        let path = write_temp_jsonl(
            "codex-human",
            &[
                json!({
                    "timestamp": "2026-08-01T00:00:00Z",
                    "type": "session_meta",
                    "payload": {
                        "id": "codex-human-id",
                        "cwd": "C:\\tmp",
                        "originator": "codex-tui",
                        "source": "cli",
                        "thread_source": "user"
                    }
                }),
                codex_user_item("Please implement the filter change now"),
            ],
        );
        let entry = scan_codex_session(&path).unwrap();
        assert!(entry.has_user_messages);
    }

    #[test]
    fn scan_claude_codex_excludes_sdk_cli_entrypoint() {
        let home = std::env::temp_dir();
        let path = write_temp_jsonl(
            "claude-codex-sdk",
            &[
                json!({
                    "type": "last-prompt",
                    "sessionId": "hybrid-sdk",
                    "entrypoint": "sdk-cli"
                }),
                {
                    let mut rec = user_text_record("Hybrid smoke request that is long enough");
                    rec.as_object_mut()
                        .unwrap()
                        .insert("sessionId".to_string(), json!("hybrid-sdk"));
                    rec
                },
            ],
        );
        let entry = scan_claude_codex_file(&home, &path).unwrap();
        assert!(!entry.has_user_messages);
    }

    #[test]
    fn scan_claude_codex_keeps_interactive_user_session() {
        let home = std::env::temp_dir();
        let path = write_temp_jsonl(
            "claude-codex-cli",
            &[
                json!({
                    "type": "last-prompt",
                    "sessionId": "hybrid-cli",
                    "entrypoint": "cli"
                }),
                {
                    let mut rec = user_text_record("Hybrid smoke request that is long enough");
                    rec.as_object_mut()
                        .unwrap()
                        .insert("sessionId".to_string(), json!("hybrid-cli"));
                    rec
                },
            ],
        );
        let entry = scan_claude_codex_file(&home, &path).unwrap();
        assert!(entry.has_user_messages);
    }
}
