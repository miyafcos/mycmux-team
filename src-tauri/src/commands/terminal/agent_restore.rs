//! Agent-session restore validation for `create_session`.
//!
//! Answers one question: is the saved session this pane wants to resume
//! actually on disk? Claude Code keeps a per-project transcript file; Codex
//! keeps a rollout log whose first line carries the session id. The launcher
//! chooses the working directory for a valid Claude session, so this module
//! only decides whether its saved id may be passed through. When an id does not
//! exist, `create_session` starts a fresh agent and surfaces a warning instead
//! of resuming another conversation.
//!
//! It also reads the effort a Claude conversation last ran at, so that a
//! restored pane resumes at that effort instead of the shared default.

use std::collections::HashMap;
use std::io::{BufRead, Read, Seek, SeekFrom};
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::resolve_launch_cwd;
use crate::commands::session_mapping::is_agent_session_kind;
use crate::pty::path_norm::{claude_project_key, normalize_cwd_key};
use crate::util::ids::is_uuid_like;

/// Path of the Claude Code transcript for `session_id` under `cwd`.
fn claude_session_path(cwd: &str, session_id: &str) -> Option<PathBuf> {
    Some(crate::test_profile::agent_projects_dir("claude")?.join(claude_project_key(cwd)).join(format!("{session_id}.jsonl")))
}

fn claude_session_path_from_home(home: &Path, cwd: &str, session_id: &str) -> PathBuf {
    home.join(".claude")
        .join("projects")
        .join(claude_project_key(cwd))
        .join(format!("{session_id}.jsonl"))
}

/// Codex names its rollout logs `rollout-<timestamp>-<uuid>.jsonl`; the id is
/// always the trailing 36 characters.
fn codex_session_id_from_path(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let id = stem.get(stem.len().saturating_sub(36)..)?;
    is_uuid_like(id).then(|| id.to_string())
}
fn codex_session_file_matches(path: &Path, session_id: &str) -> bool {
    if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return false;
    }
    let path_session_id = codex_session_id_from_path(path);
    if path_session_id.as_deref() != Some(session_id) {
        return false;
    }
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut lines = std::io::BufReader::new(file).lines();
    let Some(Ok(line)) = lines.next() else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
        return false;
    };
    let payload = value.get("payload");
    let payload_id = payload
        .and_then(|payload| payload.get("id"))
        .and_then(|id| id.as_str());
    if payload_id != Some(session_id) {
        return false;
    }
    true
}

const CODEX_SESSION_INDEX_TTL: Duration = Duration::from_secs(5);

struct CodexSessionIndex {
    sessions_dir: PathBuf,
    built_at: Instant,
    candidates: HashMap<String, Vec<PathBuf>>,
    file_count: usize,
}

static CODEX_SESSION_INDEX: OnceLock<Mutex<Option<CodexSessionIndex>>> = OnceLock::new();
/// `None` until the first report. Seeding this with `Instant::now() - 60s` would
/// panic when the first lookup happens within a minute of boot, because the
/// Windows Instant epoch is boot time.
static CODEX_SESSION_INDEX_LAST_DIAGNOSTIC: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

fn index_codex_sessions_dir(
    dir: &Path,
    candidates: &mut HashMap<String, Vec<PathBuf>>,
    file_count: &mut usize,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            index_codex_sessions_dir(&path, candidates, file_count);
            continue;
        }
        *file_count += 1;
        if let Some(session_id) = codex_session_id_from_path(&path) {
            candidates.entry(session_id).or_default().push(path);
        }
    }
}

fn build_codex_session_index(sessions_dir: &Path) -> CodexSessionIndex {
    let mut candidates = HashMap::new();
    let mut file_count = 0;
    index_codex_sessions_dir(sessions_dir, &mut candidates, &mut file_count);
    CodexSessionIndex {
        sessions_dir: sessions_dir.to_path_buf(),
        built_at: Instant::now(),
        candidates,
        file_count,
    }
}

fn should_report_codex_session_index() -> bool {
    let last_diagnostic = CODEX_SESSION_INDEX_LAST_DIAGNOSTIC.get_or_init(|| Mutex::new(None));
    let mut last_diagnostic = last_diagnostic
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if last_diagnostic.is_some_and(|at| at.elapsed() < Duration::from_secs(60)) {
        return false;
    }
    *last_diagnostic = Some(Instant::now());
    true
}

fn codex_session_candidates(
    sessions_dir: &Path,
    session_id: &str,
) -> (Vec<PathBuf>, bool, usize, u128) {
    static REBUILD: Mutex<()> = Mutex::new(());
    codex_session_candidates_with(
        CODEX_SESSION_INDEX.get_or_init(|| Mutex::new(None)), &REBUILD,
        sessions_dir, session_id, build_codex_session_index,
    )
}

fn codex_session_candidates_with(
    index: &Mutex<Option<CodexSessionIndex>>, rebuild: &Mutex<()>,
    sessions_dir: &Path, session_id: &str,
    build: impl FnOnce(&Path) -> CodexSessionIndex,
) -> (Vec<PathBuf>, bool, usize, u128) {
    let started = Instant::now();
    let cached = |index: &Option<CodexSessionIndex>| index.as_ref().filter(|cached| {
        cached.sessions_dir == sessions_dir && cached.built_at.elapsed() < CODEX_SESSION_INDEX_TTL
    }).map(|cached| (
        cached.candidates.get(session_id).cloned().unwrap_or_default(), true,
        cached.file_count, started.elapsed().as_millis(),
    ));
    if let Some(hit) = cached(&index.lock().unwrap_or_else(|p| p.into_inner())) { return hit; }
    // Only cache misses queue behind the rebuild gate. The index itself stays
    // available while walking the disk; concurrent misses reuse the new result.
    let _rebuild = rebuild.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(hit) = cached(&index.lock().unwrap_or_else(|p| p.into_inner())) { return hit; }
    let built = build(sessions_dir);
    let result = (built.candidates.get(session_id).cloned().unwrap_or_default(), false,
        built.file_count, started.elapsed().as_millis());
    *index.lock().unwrap_or_else(|p| p.into_inner()) = Some(built);
    result
}

fn codex_session_exists_in_dir(sessions_dir: &Path, session_id: &str) -> bool {
    let mut forced_rescan = false;
    loop {
        let (candidates, cache_hit, file_count, index_ms) =
            codex_session_candidates(sessions_dir, session_id);
        let found = candidates
            .iter()
            .any(|path| codex_session_file_matches(path, session_id));
        if should_report_codex_session_index() {
            let diagnostic = format!(
                "[mycmux-diag codex_index] cache_hit={} files={} candidates={} index_ms={} forced_rescan={}",
                cache_hit,
                file_count,
                candidates.len(),
                index_ms,
                forced_rescan,
            );
            eprintln!("{diagnostic}");
            crate::diag::log(&diagnostic);
        }
        if found || forced_rescan || !cache_hit || !candidates.is_empty() {
            return found;
        }
        forced_rescan = true;
        let index = CODEX_SESSION_INDEX.get_or_init(|| Mutex::new(None));
        let mut index = index.lock().unwrap_or_else(|error| error.into_inner());
        *index = None;
    }
}

fn codex_session_exists(session_id: &str) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let sessions_dir = home.join(".codex").join("sessions");
    if !sessions_dir.exists() {
        return false;
    }
    codex_session_exists_in_dir(&sessions_dir, session_id)
}

/// The transcript of `session_id` under `projects_dir`: first under the
/// project key of `cwd`, then in every other project directory, because the
/// cwd a pane saved is not always the directory its conversation started in.
fn find_claude_session_file(
    projects_dir: &Path,
    cwd: Option<&str>,
    session_id: &str,
) -> Option<PathBuf> {
    // The id becomes a file name, so only a uuid is looked up: a stale or
    // forged value must not be matched against every project directory.
    if !is_uuid_like(session_id) {
        return None;
    }
    let file_name = format!("{session_id}.jsonl");
    if let Some(cwd) = cwd {
        let primary = projects_dir.join(claude_project_key(cwd)).join(&file_name);
        if primary.is_file() {
            return Some(primary);
        }
    }
    std::fs::read_dir(projects_dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|project_dir| project_dir.is_dir())
        .map(|project_dir| project_dir.join(&file_name))
        .find(|candidate| candidate.is_file())
}

fn claude_session_exists_in_projects_dir(
    projects_dir: &Path,
    cwd: Option<&str>,
    session_id: &str,
) -> bool {
    find_claude_session_file(projects_dir, cwd, session_id).is_some()
}

/// Grok stores one directory per session under a percent-encoded cwd key:
/// `~/.grok/sessions/C%3A%5CUsers%5C.../<session-id>/chat_history.jsonl`.
/// The cwd key is not worth reproducing byte for byte (encoding of drive letters
/// and separators is Grok's business), so this scans the cwd buckets instead and
/// accepts the session as soon as one of them holds a directory with that id.
fn grok_session_exists(session_id: &str) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let sessions_dir = home.join(".grok").join("sessions");
    let Ok(entries) = std::fs::read_dir(sessions_dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let bucket = entry.path();
        bucket.is_dir() && bucket.join(session_id).is_dir()
    })
}

fn claude_session_exists(cwd: Option<&str>, session_id: &str) -> bool {
    let Some(projects) = crate::test_profile::agent_projects_dir("claude") else { return false; };
    claude_session_exists_in_projects_dir(&projects, cwd, session_id)
}

/// Levels Claude Code takes on `--effort`. A transcript can also say `auto`,
/// `ultracode` or nothing at all; those are left to Claude Code's default.
const CLAUDE_EFFORT_LEVELS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
/// A transcript is read backwards in blocks of this size...
const TRANSCRIPT_TAIL_BLOCK: u64 = 64 * 1024;
/// ...and never further back than this from its end. One line can pass a
/// megabyte (a large tool result), but a restore must not read the whole of a
/// transcript that has grown to hundreds of megabytes.
const TRANSCRIPT_TAIL_LIMIT: u64 = 32 * 1024 * 1024;

/// The effort Claude `session_id` last ran at, so a restored pane can resume
/// there. Claude Code brings the model back from the transcript on `--resume`
/// but takes the effort from the shared settings default, and `/effort max` is
/// never saved there, so a pane that ran at `max` would otherwise come back at
/// the default.
pub(super) fn last_claude_effort(cwd: Option<&str>, session_id: &str) -> Option<String> {
    if !is_uuid_like(session_id) {
        return None;
    }
    let projects_dir = crate::test_profile::agent_projects_dir("claude")?;
    read_last_claude_effort(&find_claude_session_file(&projects_dir, cwd, session_id)?)
}

/// The effort of the last real reply in a Claude transcript.
///
/// Claude Code 2.1.278 and later writes `effort` and `perTurnEffort` on every
/// assistant line and itself reads `perTurnEffort ?? effort`. Sidechain
/// (subagent) lines, API error lines and `<synthetic>` placeholders are not
/// replies of the conversation and are passed over. The last real reply then
/// decides alone: when it carries no level `--effort` takes, the answer is
/// `None`, never an older reply's level, because that is not what the
/// conversation was last running at.
///
/// The file is read backwards from its end in 64 KiB blocks, 32 MiB at most,
/// so the cost does not grow with the conversation. A line that does not parse
/// (the last one, while it is still being written) is skipped, and CRLF line
/// ends are accepted.
fn read_last_claude_effort(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let floor = len.saturating_sub(TRANSCRIPT_TAIL_LIMIT);
    let mut pos = len;
    // The end of the line whose start lies before `pos`, kept as blocks in
    // reverse file order so that a long line is copied once, when its start
    // turns up.
    let mut tail: Vec<Vec<u8>> = Vec::new();
    while pos > floor {
        let start = pos.saturating_sub(TRANSCRIPT_TAIL_BLOCK).max(floor);
        let mut block = vec![0; (pos - start) as usize];
        file.seek(SeekFrom::Start(start)).ok()?;
        file.read_exact(&mut block).ok()?;
        pos = start;
        let mut end = block.len();
        // Each newline starts the line that runs from it up to `end`, and on
        // through `tail` for the first line found in this block.
        while let Some(newline) = block[..end].iter().rposition(|&byte| byte == b'\n') {
            let verdict = if tail.is_empty() {
                reply_effort(&block[newline + 1..end])
            } else {
                let mut line = block[newline + 1..end].to_vec();
                for piece in tail.drain(..).rev() {
                    line.extend_from_slice(&piece);
                }
                reply_effort(&line)
            };
            if let ControlFlow::Break(effort) = verdict {
                return effort;
            }
            end = newline;
        }
        block.truncate(end);
        tail.push(block);
    }
    // At the start of the file what is left is its first line, which has no
    // newline before it. Stopped by the read limit, it is only the cut-off end
    // of a longer line.
    if pos > 0 {
        return None;
    }
    let mut line = Vec::new();
    for piece in tail.iter().rev() {
        line.extend_from_slice(piece);
    }
    match reply_effort(&line) {
        ControlFlow::Break(effort) => effort,
        ControlFlow::Continue(()) => None,
    }
}

/// `Break` with the effort of `line` when it is a real reply, `Continue` for
/// any other line, including one that does not parse.
fn reply_effort(line: &[u8]) -> ControlFlow<Option<String>> {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    let Ok(entry) = serde_json::from_slice::<serde_json::Value>(line) else {
        return ControlFlow::Continue(());
    };
    let text = |pointer: &str| entry.pointer(pointer).and_then(serde_json::Value::as_str);
    let flag = |key: &str| entry.get(key).and_then(serde_json::Value::as_bool) == Some(true);
    if text("/type") != Some("assistant")
        || flag("isSidechain")
        || flag("isApiErrorMessage")
        || text("/message/model") == Some("<synthetic>")
    {
        return ControlFlow::Continue(());
    }
    let effort = text("/perTurnEffort").or_else(|| text("/effort"));
    ControlFlow::Break(
        effort
            .filter(|effort| CLAUDE_EFFORT_LEVELS.contains(effort))
            .map(str::to_string),
    )
}

fn interactive_user_text(text: &str) -> bool {
    let text = text.trim_start();
    !text.is_empty() && ![
        "<command-name>", "<command-message>", "<local-command-stdout>", "<local-command-caveat>",
        "<task-notification>", "<system-reminder>", "[Request interrupted",
    ].iter().any(|prefix| text.starts_with(prefix))
}

fn interactive_cli_user(row: &serde_json::Value) -> bool {
    if row["type"] != "user" || row["entrypoint"] != "cli"
        || row["isSidechain"].as_bool() == Some(true) || row["isMeta"].as_bool() == Some(true)
        || row.get("toolUseResult").is_some() { return false; }
    let content = &row["message"]["content"];
    content.as_str().is_some_and(interactive_user_text) || content.as_array().is_some_and(|blocks|
        blocks.iter().any(|block| block["type"] == "image" || (block["type"] == "text"
            && block["text"].as_str().is_some_and(interactive_user_text))))
}

fn unattended_sdk_transcript(path: &Path) -> bool {
    let Ok(file) = std::fs::File::open(path) else { return false; };
    let mut first_entrypoint = None;
    for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(row) = serde_json::from_str::<serde_json::Value>(&line) else { continue; };
        if first_entrypoint.is_none() {
            first_entrypoint = row.get("entrypoint").and_then(|value| value.as_str()).map(str::to_string);
        }
        if first_entrypoint.as_deref().is_some_and(|entrypoint| entrypoint != "sdk-cli") { return false; }
        if interactive_cli_user(&row) { return false; }
    }
    first_entrypoint.as_deref() == Some("sdk-cli")
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RestoreChoice {
    kind: String,
    agent_session_id: String,
    candidates: Vec<String>,
    candidate_details: Vec<RestoreCandidate>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoreCandidate {
    agent_session_id: String,
    title: String,
    last_written_at: Option<u64>,
}

fn restore_candidate(path: &Path, id: &str) -> RestoreCandidate {
    let mut title = "\u{5143}\u{306e}\u{4f1a}\u{8a71}".to_string();
    if let Ok(file) = std::fs::File::open(path) {
        for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
            let Ok(row) = serde_json::from_str::<serde_json::Value>(&line) else { continue; };
            if !interactive_cli_user(&row) { continue; }
            let content = &row["message"]["content"];
            let text = content.as_str().map(str::to_string).unwrap_or_else(|| {
                content.as_array().into_iter().flatten().filter_map(|block|
                    (block["type"] == "text").then(|| block["text"].as_str()).flatten())
                    .filter(|text| interactive_user_text(text)).collect::<Vec<_>>().join(" ")
            });
            let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
            if text.is_empty() {
                title = "\u{753b}\u{50cf}\u{306e}\u{3042}\u{308b}\u{4f1a}\u{8a71}".to_string();
            } else {
                title = text.chars().take(40).collect();
                if text.chars().count() > 40 { title.push('\u{2026}'); }
            }
            break;
        }
    }
    let last_written_at = path.metadata().ok().and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64);
    RestoreCandidate { agent_session_id: id.to_string(), title, last_written_at }
}

pub(super) fn unattended_restore_choice(kind: &str, id: &str, cwd: Option<&str>, tab_id: Option<&str>, history: &[String]) -> Option<RestoreChoice> {
    if !matches!(kind, "claude" | "claude-codex") { return None; }
    let projects = crate::test_profile::agent_projects_dir(kind)?;
    let path = find_claude_session_file(&projects, cwd, id)?;
    if !unattended_sdk_transcript(&path) { return None; }
    let mut candidates = Vec::new();
    let mut candidate_details = Vec::new();
    for candidate in tab_id.into_iter().chain(history.iter().map(String::as_str)) {
        if candidate == id || !is_uuid_like(candidate) || candidates.iter().any(|id| id == candidate) { continue; }
        if let Some(path) = find_claude_session_file(&projects, cwd, candidate) {
            if unattended_sdk_transcript(&path) { continue; }
            candidates.push(candidate.to_string());
            candidate_details.push(restore_candidate(&path, candidate));
        }
    }
    Some(RestoreChoice { kind: kind.to_string(), agent_session_id: id.to_string(), candidates, candidate_details })
}

pub(crate) fn can_restore_agent_session(kind: &str, session_id: &str, cwd: Option<&str>) -> bool {
    match kind {
        "claude" => claude_session_exists(cwd, session_id),
        "codex" => codex_session_exists(session_id),
        // claude-codex is an optional external wrapper; do not block it here.
        "claude-codex" => true,
        "grok" => grok_session_exists(session_id),
        _ => false,
    }
}

fn agent_restore_error(kind: &str, session_id: &str, cwd: Option<&str>) -> Option<String> {
    if !is_agent_session_kind(kind) || session_id.trim().is_empty() {
        return None;
    }
    if can_restore_agent_session(kind, session_id, cwd) {
        return None;
    }
    let cwd = resolve_launch_cwd(cwd).unwrap_or_else(|| "<unknown>".to_string());
    let detail = match kind {
        "claude" => claude_session_path(&cwd, session_id)
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|| "<unknown>".to_string()),
        "codex" => format!("CWD {}", normalize_cwd_key(&cwd)),
        "grok" => format!("~/.grok/sessions/*/{session_id}"),
        _ => cwd.clone(),
    };
    Some(format!(
        "Cannot restore {kind} session {session_id} from {cwd}. Saved session was not found ({detail})."
    ))
}

pub(super) fn validate_agent_restore_request(
    cwd: Option<&str>,
    env: &HashMap<String, String>,
) -> Result<(), String> {
    let Some(session_id) = env
        .get("MYCMUX_SESSION_ID")
        .map(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(());
    };
    let Some(kind) = env
        .get("MYCMUX_RESUME")
        .or_else(|| env.get("MYCMUX_AGENT_KIND"))
        .map(|value| value.as_str())
        .filter(|value| is_agent_session_kind(value))
    else {
        return Ok(());
    };
    if let Some(error) = agent_restore_error(kind, session_id, cwd) {
        return Err(error);
    }
    Ok(())
}

fn normalize_claude_project_path(path: &str) -> String {
    let raw_path = Path::new(path)
        .canonicalize()
        .unwrap_or_else(|_| Path::new(path).to_path_buf());
    raw_path
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string()
}

pub(super) fn ensure_claude_project_trusted(cwd: &str) -> Result<(), String> {
    if crate::test_profile::is_active() { return Ok(()); }
    let Some(home) = dirs::home_dir() else {
        return Ok(());
    };
    let path = home.join(".claude.json");
    if !path.exists() {
        return Ok(());
    }

    let project_path = normalize_claude_project_path(cwd);
    let contents =
        std::fs::read_to_string(&path).map_err(|error| format!("read .claude.json: {error}"))?;
    let mut root: serde_json::Value =
        serde_json::from_str(&contents).map_err(|error| format!("parse .claude.json: {error}"))?;
    let projects = root
        .as_object_mut()
        .ok_or_else(|| ".claude.json root is not an object".to_string())?
        .entry("projects".to_string())
        .or_insert_with(|| serde_json::json!({}));
    let projects = projects
        .as_object_mut()
        .ok_or_else(|| ".claude.json projects is not an object".to_string())?;

    let project = projects.entry(project_path).or_insert_with(|| {
        serde_json::json!({
            "allowedTools": [],
            "mcpContextUris": [],
            "mcpServers": {},
            "enabledMcpjsonServers": [],
            "disabledMcpjsonServers": [],
            "hasTrustDialogAccepted": true,
            "projectOnboardingSeenCount": 0,
            "hasClaudeMdExternalIncludesApproved": false,
            "hasClaudeMdExternalIncludesWarningShown": false,
            "exampleFiles": []
        })
    });
    let Some(project) = project.as_object_mut() else {
        return Ok(());
    };
    if project
        .get("hasTrustDialogAccepted")
        .and_then(|value| value.as_bool())
        == Some(true)
    {
        return Ok(());
    }
    project.insert(
        "hasTrustDialogAccepted".to_string(),
        serde_json::Value::Bool(true),
    );

    let json = serde_json::to_string_pretty(&root)
        .map_err(|error| format!("serialize .claude.json: {error}"))?;
    // fsync before the rename: a truncated .claude.json costs the user every
    // per-project trust decision they have ever made.
    crate::util::atomic_write::AtomicWrite::new("temporary .claude.json", "replace .claude.json")
        .write_bytes(&path, json.as_bytes())
}

#[cfg(test)]
mod tests {
    #[test]
    fn codex_index_build_keeps_the_cache_lock_available_and_cold_callers_share_it() {
        use super::*;
        use std::sync::atomic::{AtomicUsize, Ordering};
        let dir = tempfile::tempdir().unwrap();
        let id = "11111111-2222-3333-4444-555555555555";
        let log = dir.path().join(format!("rollout-{id}.jsonl"));
        std::fs::write(&log, "{}\n").unwrap();
        let index = Mutex::new(None);
        let rebuild = Mutex::new(());
        let builds = AtomicUsize::new(0);
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let index_ref = &index;
            let rebuild_ref = &rebuild;
            let builds_ref = &builds;
            let root = dir.path();
            let first = scope.spawn(move || codex_session_candidates_with(index_ref, rebuild_ref, root, id, |root| {
                builds_ref.fetch_add(1, Ordering::SeqCst);
                started_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                build_codex_session_index(root)
            }));
            started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            assert!(index.try_lock().is_ok(), "recursive walk must not hold the cache lock");
            let second = scope.spawn(|| codex_session_candidates_with(&index, &rebuild, dir.path(), id, |root| {
                builds.fetch_add(1, Ordering::SeqCst);
                build_codex_session_index(root)
            }));
            release_tx.send(()).unwrap();
            assert_eq!(first.join().unwrap().0, vec![log.clone()]);
            assert_eq!(second.join().unwrap().0, vec![log.clone()]);
        });
        assert_eq!(builds.load(Ordering::SeqCst), 1);
        // Separate roots must never share candidates, even with the same id.
        let other = tempfile::tempdir().unwrap();
        assert!(codex_session_candidates_with(&index, &rebuild, other.path(), id, build_codex_session_index).0.is_empty());
    }
    use super::*;

    #[test]
    fn codex_session_file_requires_matching_id_regardless_of_payload_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let session_id = "019bc371-82cf-7d82-ad0b-96d026aaca73";
        let path = dir
            .path()
            .join(format!("rollout-2026-01-15T15-55-54-{session_id}.jsonl"));
        std::fs::write(
            &path,
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{session_id}\",\"cwd\":\"C:\\\\Users\\\\miyaz\"}}}}\n"
            ),
        )
        .unwrap();

        assert!(codex_session_file_matches(&path, session_id));
        assert!(!codex_session_file_matches(
            &path,
            "019bc371-82cf-7d82-ad0b-96d026aaca74",
        ));
    }

    #[test]
    fn codex_session_index_limits_payload_checks_to_filename_candidates() {
        let dir = tempfile::tempdir().unwrap();
        let session_id = "019bc371-82cf-7d82-ad0b-96d026aaca73";
        let nested = dir.path().join("2026").join("01").join("15");
        std::fs::create_dir_all(&nested).unwrap();
        let matching = nested.join(format!("rollout-2026-01-15T15-55-54-{session_id}.jsonl"));
        std::fs::write(
            &matching,
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{session_id}\",\"cwd\":\"C:\\\\Users\\\\miyaz\"}}}}\n"
            ),
        )
        .unwrap();
        std::fs::write(nested.join("not-a-session.jsonl"), "{}\n").unwrap();

        let index = build_codex_session_index(dir.path());
        assert_eq!(index.file_count, 2);
        let candidates = index.candidates.get(session_id).unwrap();
        assert_eq!(candidates, &vec![matching.clone()]);
        assert!(candidates
            .iter()
            .any(|path| codex_session_file_matches(path, session_id)));
    }

    #[test]
    fn claude_session_is_restorable_from_another_project_dir() {
        let dir = tempfile::tempdir().unwrap();
        let projects_dir = dir.path().join("projects");
        let session_id = "019bc371-82cf-7d82-ad0b-96d026aaca73";
        let other_project = projects_dir.join("different-project-key");
        std::fs::create_dir_all(&other_project).unwrap();
        std::fs::write(other_project.join(format!("{session_id}.jsonl")), "{}\n").unwrap();

        assert!(claude_session_exists_in_projects_dir(
            &projects_dir,
            Some(r"C:\Users\miyaz\expected-project"),
            session_id,
        ));
    }

    #[test]
    fn claude_session_is_restorable_from_a_posix_project_dir() {
        let dir = tempfile::tempdir().unwrap();
        let projects_dir = dir.path().join("projects");
        let session_id = "019bc371-82cf-7d82-ad0b-96d026aaca73";
        let cwd = "/Users/example/work/mycmux";
        let project_dir = projects_dir.join(claude_project_key(cwd));
        std::fs::create_dir_all(&project_dir).unwrap();
        std::fs::write(project_dir.join(format!("{session_id}.jsonl")), "{}\n").unwrap();

        assert!(claude_session_exists_in_projects_dir(
            &projects_dir,
            Some(cwd),
            session_id,
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn claude_session_path_uses_the_macos_home_directory() {
        let home = dirs::home_dir().expect("macOS home directory should resolve");
        let path = claude_session_path_from_home(
            &home,
            "/Users/example/work/mycmux",
            "019bc371-82cf-7d82-ad0b-96d026aaca73",
        );
        assert!(path.starts_with(&home));
        assert_eq!(
            path.strip_prefix(&home).unwrap(),
            Path::new(".claude/projects/-Users-example-work-mycmux/019bc371-82cf-7d82-ad0b-96d026aaca73.jsonl")
        );
    }

    #[test]
    fn missing_agent_sessions_remain_unrestorable() {
        let dir = tempfile::tempdir().unwrap();
        let session_id = "019bc371-82cf-7d82-ad0b-96d026aaca73";
        let claude_projects = dir.path().join("claude-projects");
        let codex_sessions = dir.path().join("codex-sessions");
        std::fs::create_dir_all(&claude_projects).unwrap();
        std::fs::create_dir_all(&codex_sessions).unwrap();

        assert!(!claude_session_exists_in_projects_dir(
            &claude_projects,
            Some(r"C:\Users\miyaz\expected-project"),
            session_id,
        ));
        assert!(!codex_session_exists_in_dir(&codex_sessions, session_id));
    }

    #[test]
    fn non_uuid_claude_id_does_not_scan_other_projects() {
        let dir = tempfile::tempdir().unwrap();
        let projects_dir = dir.path().join("projects");
        let session_id = "not-a-uuid";
        let other_project = projects_dir.join("different-project-key");
        std::fs::create_dir_all(&other_project).unwrap();
        std::fs::write(other_project.join(format!("{session_id}.jsonl")), "{}\n").unwrap();

        assert!(!claude_session_exists_in_projects_dir(
            &projects_dir,
            Some(r"C:\Users\miyaz\expected-project"),
            session_id,
        ));
    }

    const EFFORT_SESSION_ID: &str = "019bc371-82cf-7d82-ad0b-96d026aaca73";

    /// An assistant line shaped like the ones Claude Code 2.1.283 writes.
    fn reply_line(effort: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "assistant",
            "isSidechain": false,
            "effort": effort,
            "perTurnEffort": effort,
            "message": {"model": "model-under-test", "role": "assistant", "content": []},
        })
    }

    fn user_line(content: &str) -> serde_json::Value {
        serde_json::json!({"type": "user", "message": {"role": "user", "content": content}})
    }

    fn write_transcript(path: &Path, lines: &[serde_json::Value], line_end: &str) {
        let text: String = lines
            .iter()
            .map(|line| format!("{line}{line_end}"))
            .collect();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn the_last_real_reply_gives_the_resume_effort() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        write_transcript(
            &path,
            &[
                user_line("go"),
                reply_line("high"),
                user_line("again"),
                reply_line("max"),
                serde_json::json!({"type": "system", "subtype": "turn_duration"}),
                serde_json::json!({"type": "last-prompt", "lastPrompt": "again"}),
            ],
            "\n",
        );

        assert_eq!(read_last_claude_effort(&path).as_deref(), Some("max"));
    }

    #[test]
    fn per_turn_effort_wins_and_effort_stands_in_when_it_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        for (last, expected) in [
            (
                serde_json::json!({"type": "assistant", "effort": "high", "perTurnEffort": "xhigh", "message": {"model": "model-under-test"}}),
                "xhigh",
            ),
            (
                serde_json::json!({"type": "assistant", "effort": "medium", "message": {"model": "model-under-test"}}),
                "medium",
            ),
            (
                serde_json::json!({"type": "assistant", "effort": "low", "perTurnEffort": null, "message": {"model": "model-under-test"}}),
                "low",
            ),
        ] {
            write_transcript(&path, &[reply_line("max"), last.clone()], "\n");
            assert_eq!(
                read_last_claude_effort(&path).as_deref(),
                Some(expected),
                "{last}"
            );
        }
    }

    #[test]
    fn sidechain_api_error_and_synthetic_lines_are_passed_over() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        write_transcript(
            &path,
            &[
                reply_line("xhigh"),
                serde_json::json!({"type": "assistant", "isSidechain": true, "effort": "low", "perTurnEffort": "low", "message": {"model": "model-under-test"}}),
                serde_json::json!({"type": "assistant", "isSidechain": false, "isApiErrorMessage": true, "effort": "low", "perTurnEffort": "low", "message": {"model": "model-under-test"}}),
                serde_json::json!({"type": "assistant", "isSidechain": false, "effort": "low", "perTurnEffort": "low", "message": {"model": "<synthetic>"}}),
                user_line("[Request interrupted by user]"),
            ],
            "\n",
        );

        assert_eq!(read_last_claude_effort(&path).as_deref(), Some("xhigh"));
    }

    #[test]
    fn a_last_reply_without_a_usable_level_does_not_fall_back_to_an_older_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        for last in [
            serde_json::json!({"type": "assistant", "isSidechain": false, "message": {"model": "model-under-test"}}),
            serde_json::json!({"type": "assistant", "effort": null, "perTurnEffort": null, "message": {"model": "model-under-test"}}),
            reply_line("ultracode"),
            reply_line("auto"),
        ] {
            write_transcript(&path, &[reply_line("max"), last.clone()], "\n");
            assert_eq!(read_last_claude_effort(&path), None, "{last}");
        }
    }

    #[test]
    fn a_line_longer_than_a_read_block_is_read_whole() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        let mut long_reply = reply_line("medium");
        long_reply["message"]["content"] =
            serde_json::json!([{"type": "text", "text": "x".repeat(150_000)}]);
        write_transcript(
            &path,
            &[
                reply_line("low"),
                long_reply,
                user_line(&"y".repeat(300_000)),
                serde_json::json!({"type": "system", "subtype": "turn_duration"}),
            ],
            "\n",
        );

        assert_eq!(read_last_claude_effort(&path).as_deref(), Some("medium"));
    }

    #[test]
    fn a_newline_on_a_block_edge_still_ends_its_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        let reply = reply_line("high").to_string();
        let empty_filler_len = user_line("").to_string().len();
        // The file is `reply \n filler \n`. With a 65534-byte filler the newline
        // after the reply is the first byte of the first block read (the last
        // 64 KiB of the file); with 65535 it is the last byte of the next one.
        for filler_len in 65_530..=65_540 {
            let filler = user_line(&"z".repeat(filler_len - empty_filler_len)).to_string();
            assert_eq!(filler.len(), filler_len);
            std::fs::write(&path, format!("{reply}\n{filler}\n")).unwrap();
            assert_eq!(
                read_last_claude_effort(&path).as_deref(),
                Some("high"),
                "filler of {filler_len} bytes"
            );
        }
    }

    #[test]
    fn a_last_line_still_being_written_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        std::fs::write(
            &path,
            format!(
                "{}\n{}",
                reply_line("max"),
                r#"{"type":"assistant","isSidechain":false,"effort":"low","perTurnEff"#
            ),
        )
        .unwrap();

        assert_eq!(read_last_claude_effort(&path).as_deref(), Some("max"));
    }

    #[test]
    fn crlf_line_ends_are_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        write_transcript(
            &path,
            &[
                reply_line("xhigh"),
                serde_json::json!({"type": "system", "subtype": "turn_duration"}),
            ],
            "\r\n",
        );

        assert_eq!(read_last_claude_effort(&path).as_deref(), Some("xhigh"));
    }

    #[test]
    fn a_missing_or_empty_transcript_and_a_non_uuid_id_give_no_effort() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            read_last_claude_effort(&dir.path().join("missing.jsonl")),
            None
        );
        let empty = dir.path().join("empty.jsonl");
        std::fs::write(&empty, "").unwrap();
        assert_eq!(read_last_claude_effort(&empty), None);
        assert_eq!(
            find_claude_session_file(&dir.path().join("projects"), None, EFFORT_SESSION_ID),
            None
        );
        // Refused before the home directory is looked at.
        assert_eq!(last_claude_effort(Some(r"C:\work"), "not-a-uuid"), None);
    }

    #[test]
    fn the_transcript_is_found_under_another_project_key() {
        let dir = tempfile::tempdir().unwrap();
        let projects_dir = dir.path().join("projects");
        let other_project = projects_dir.join("different-project-key");
        std::fs::create_dir_all(&other_project).unwrap();
        let transcript = other_project.join(format!("{EFFORT_SESSION_ID}.jsonl"));
        write_transcript(&transcript, &[reply_line("xhigh")], "\n");

        let found = find_claude_session_file(
            &projects_dir,
            Some(r"C:\Users\miyaz\expected-project"),
            EFFORT_SESSION_ID,
        );
        assert_eq!(found.as_deref(), Some(transcript.as_path()));
        assert_eq!(
            read_last_claude_effort(&transcript).as_deref(),
            Some("xhigh")
        );
    }

    #[test]
    fn the_backwards_read_stops_at_its_limit() {
        use std::io::Write;
        // A reply followed by one line longer than the read limit is out of
        // reach: reading on to it would mean reading more than the limit.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        writeln!(file, "{}", reply_line("max")).unwrap();
        file.write_all(br#"{"type":"user","message":{"role":"user","content":""#)
            .unwrap();
        let block = vec![b'w'; 1024 * 1024];
        for _ in 0..(TRANSCRIPT_TAIL_LIMIT / 1024 / 1024 + 1) {
            file.write_all(&block).unwrap();
        }
        file.write_all(b"\"}}\n").unwrap();
        drop(file);

        assert_eq!(read_last_claude_effort(&path), None);
    }
    #[test]
    fn si_t4_four_transcript_shapes_require_actual_interactive_user_input() {
        let sdk = r#"{"type":"user","entrypoint":"sdk-cli","message":{"role":"user","content":"automatic job"}}"#;
        let cli_reply = r#"{"type":"assistant","entrypoint":"cli","message":{"role":"assistant","content":"automatic resume output"}}"#;
        let cli_input = r#"{"type":"user","entrypoint":"cli","isSidechain":false,"message":{"role":"user","content":"human continuation"}}"#;
        let directory = tempfile::tempdir().unwrap();
        for (name, rows, should_offer) in [
            ("sdk_cli_ok_probe", vec![sdk], true),
            ("sdk_cli_job", vec![sdk, cli_reply], true),
            ("cli_interactive", vec![cli_input], false),
            ("mixed_sdk_then_cli", vec![sdk, cli_reply, cli_input], false),
        ] {
            let file = directory.path().join(format!("{name}.jsonl"));
            std::fs::write(&file, rows.join("\n") + "\n").unwrap();
            assert_eq!(unattended_sdk_transcript(&file), should_offer, "{name}");
        }
        let file = directory.path().join("sidechain.jsonl");
        std::fs::write(&file, format!("{sdk}\n{{\"type\":\"user\",\"entrypoint\":\"cli\",\"isSidechain\":true,\"message\":{{\"content\":\"child prompt\"}}}}\n")).unwrap();
        assert!(unattended_sdk_transcript(&file));
    }

    #[test]
    fn si_t4_all_four_evidence_fixtures_match_the_mothership_answer() {
        let dir = tempfile::tempdir().unwrap();
        let fixtures = [
            ("sdk_cli_ok_probe", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/session-identity/sdk_cli_ok_probe.jsonl")), true),
            ("sdk_cli_job", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/session-identity/sdk_cli_job.jsonl")), false),
            ("cli_interactive", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/session-identity/cli_interactive.jsonl")), false),
            ("mixed_sdk_then_cli", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/session-identity/mixed_sdk_then_cli.jsonl")), false),
        ];
        for (name, contents, expected) in fixtures {
            let path = dir.path().join(format!("{name}.jsonl"));
            std::fs::write(&path, contents).unwrap();
            assert_eq!(unattended_sdk_transcript(&path), expected, "{name}");
        }
    }

    #[test]
    fn si_t4_restore_candidate_reads_human_preview_and_last_write_without_control_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("candidate.jsonl");
        let control = serde_json::json!({"type":"user", "entrypoint":"cli", "isMeta":true,
            "message":{"content":"private control text"}});
        let human = serde_json::json!({"type":"user", "entrypoint":"cli",
            "message":{"content":"A readable human prompt with more than forty characters for a preview"}});
        std::fs::write(&path, format!("{control}\n{human}\n")).unwrap();
        let candidate = restore_candidate(&path, "original");
        assert_eq!(candidate.agent_session_id, "original");
        assert_eq!(candidate.title, "A readable human prompt with more than f\u{2026}");
        assert!(candidate.last_written_at.is_some());
        assert!(!candidate.title.contains("private"));
    }

}
