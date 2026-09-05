//! Agent-session restore validation for `create_session`.
//!
//! Answers one question: is the saved session this pane wants to resume
//! actually on disk? Claude Code keeps a per-project transcript file; Codex
//! keeps a rollout log whose first line carries the session id. The launcher
//! chooses the working directory for a valid Claude session, so this module
//! only decides whether its saved id may be passed through. When an id does not
//! exist, `create_session` starts a fresh agent and surfaces a warning instead
//! of resuming another conversation.

use std::collections::HashMap;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::resolve_launch_cwd;
use crate::commands::session_mapping::is_agent_session_kind;
use crate::pty::path_norm::{claude_project_key, normalize_cwd_key};
use crate::util::ids::is_uuid_like;

/// Path of the Claude Code transcript for `session_id` under `cwd`.
fn claude_session_path(cwd: &str, session_id: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(claude_session_path_from_home(&home, cwd, session_id))
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
    let index = CODEX_SESSION_INDEX.get_or_init(|| Mutex::new(None));
    let mut index = index.lock().unwrap_or_else(|error| error.into_inner());
    let refresh_started = Instant::now();
    let cache_hit = index
        .as_ref()
        .is_some_and(|cached| cached.built_at.elapsed() < CODEX_SESSION_INDEX_TTL);
    if !cache_hit {
        *index = Some(build_codex_session_index(sessions_dir));
    }
    let index = index.as_ref().expect("Codex session index was populated");
    (
        index
            .candidates
            .get(session_id)
            .cloned()
            .unwrap_or_default(),
        cache_hit,
        index.file_count,
        refresh_started.elapsed().as_millis(),
    )
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

fn claude_session_exists_in_projects_dir(
    projects_dir: &Path,
    cwd: Option<&str>,
    session_id: &str,
) -> bool {
    if !is_uuid_like(session_id) {
        return false;
    }
    if let Some(cwd) = cwd {
        let primary = projects_dir
            .join(claude_project_key(cwd))
            .join(format!("{session_id}.jsonl"));
        if primary.is_file() {
            return true;
        }
    }
    let Ok(entries) = std::fs::read_dir(projects_dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let project_dir = entry.path();
        project_dir.is_dir() && project_dir.join(format!("{session_id}.jsonl")).is_file()
    })
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
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    claude_session_exists_in_projects_dir(&home.join(".claude").join("projects"), cwd, session_id)
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
}
