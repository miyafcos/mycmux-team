use chrono::Local;
use kuchikiki::traits::TendrilSink;
use kuchikiki::{NodeData, NodeRef};
use quick_xml::events::Event;
use quick_xml::Reader;
use std::collections::{hash_map::DefaultHasher, HashMap};
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use sysinfo::System;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use zip::{ZipArchive, ZipWriter};

use crate::AppState;

#[derive(serde::Serialize)]
pub struct TerminalConfigPayload {
    pub font_family: String,
    pub font_size: f32,
    pub shell: String,
    pub background: String,
    pub foreground: String,
    pub ansi: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewArtifactInfo {
    pub preview_path: String,
    pub source_path: String,
    pub source_kind: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableArtifactSource {
    pub source_path: String,
    pub source_kind: String,
    pub content: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveEditableArtifactResult {
    pub source_path: String,
    pub backup_path: String,
    pub preview_path: String,
}

fn rgb_hex(c: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

#[tauri::command]
pub fn get_terminal_config() -> TerminalConfigPayload {
    let cfg = crate::terminal_config::load();
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
    TerminalConfigPayload {
        font_family: cfg.font_family,
        font_size: cfg.font_size,
        shell,
        background: rgb_hex(cfg.colors.background),
        foreground: rgb_hex(cfg.colors.foreground),
        ansi: cfg.colors.ansi.iter().map(|c| rgb_hex(*c)).collect(),
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_session(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    command: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<Vec<u8>>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
) -> Result<(), String> {
    let requested_command = command;
    let mut args = args;
    let mut env_map = env.unwrap_or_default();
    validate_agent_restore_request(cwd.as_deref(), &env_map)?;
    let launch_cwd = resolve_launch_cwd(cwd.as_deref());
    sanitize_launch_env(&mut env_map);
    // Canonical MYCMUX_HTML_OUT (HTML sidetab path) for this pane. sanitize_launch_env
    // just stripped any incoming value, so untrusted env cannot redirect the output.
    // session_id is used as a single directory segment, so reject anything that
    // could escape the sessions/ root (path separators or "."/".." components)
    // before joining — a forged restore id must not be able to redirect the dir.
    let session_id_is_safe = !session_id.is_empty()
        && !session_id.contains('/')
        && !session_id.contains('\\')
        && session_id != "."
        && session_id != "..";
    if session_id_is_safe {
        if let Some(home) = dirs::home_dir() {
            let html_dir = home.join(".mycmux").join("sessions").join(&session_id);
            match std::fs::create_dir_all(&html_dir) {
                Ok(()) => {
                    let html_path = html_dir.join("out.html");
                    let markdown_path = html_dir.join("out.md");
                    let artifacts_dir = html_dir.join("artifacts");
                    let _ = std::fs::create_dir_all(&artifacts_dir);
                    env_map.insert(
                        "MYCMUX_HTML_OUT".to_string(),
                        html_path.to_string_lossy().to_string(),
                    );
                    env_map.insert(
                        "MYCMUX_MARKDOWN_OUT".to_string(),
                        markdown_path.to_string_lossy().to_string(),
                    );
                    env_map.insert(
                        "MYCMUX_ARTIFACTS_DIR".to_string(),
                        artifacts_dir.to_string_lossy().to_string(),
                    );
                }
                Err(err) => {
                    eprintln!(
                        "[mycmux] failed to create sidetab dir {}: {err}",
                        html_dir.display()
                    );
                }
            }
        }
    } else {
        eprintln!("[mycmux] skipping sidetab for unsafe session_id: {session_id:?}");
    }
    let command = prepare_spawn_command(&requested_command, &mut args);
    inject_osc7_hook(&command, &mut args, &mut env_map);
    if should_trust_claude_workspace(&requested_command, &env_map) {
        if let Some(trusted_cwd) = launch_cwd.as_deref() {
            if let Err(error) = ensure_claude_project_trusted(&trusted_cwd) {
                eprintln!("[claude] failed to mark workspace trusted: {error}");
            }
        }
    }
    write_launch_session_mapping(&session_id, &env_map);
    state.session_manager.create(
        session_id,
        &command,
        &args,
        cols,
        rows,
        on_data,
        app_handle,
        launch_cwd,
        Some(env_map),
        state.metadata_store.clone(),
    )
}

#[cfg(target_os = "windows")]
fn prepare_spawn_command(command: &str, args: &mut Vec<String>) -> String {
    let Some(resolved) = resolve_windows_command(command) else {
        return command.to_string();
    };
    let extension = resolved
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension == "cmd" || extension == "bat" {
        let script = resolved.to_string_lossy().to_string();
        let mut wrapped_args = vec!["/d".to_string(), "/c".to_string(), script];
        wrapped_args.append(args);
        *args = wrapped_args;
        return std::env::var("COMSPEC")
            .unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".to_string());
    }
    resolved.to_string_lossy().to_string()
}

#[cfg(not(target_os = "windows"))]
fn prepare_spawn_command(command: &str, _args: &mut Vec<String>) -> String {
    command.to_string()
}

#[cfg(target_os = "windows")]
fn resolve_windows_command(command: &str) -> Option<std::path::PathBuf> {
    let command_path = Path::new(command);
    let has_separator = command.contains(['/', '\\']);
    if has_separator {
        return resolve_windows_command_candidate(command_path);
    }

    let path_env = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_env) {
        if let Some(resolved) = resolve_windows_command_candidate(&dir.join(command)) {
            return Some(resolved);
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn resolve_windows_command_candidate(path: &Path) -> Option<std::path::PathBuf> {
    if path.extension().is_some() && path.is_file() {
        return Some(path.to_path_buf());
    }

    for extension in ["cmd", "exe", "bat", "com"] {
        let candidate = path.with_extension(extension);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn command_leaf(command: &str) -> &str {
    let leaf = command.rsplit(['/', '\\']).next().unwrap_or(command);
    leaf.strip_suffix(".exe")
        .or_else(|| leaf.strip_suffix(".cmd"))
        .or_else(|| leaf.strip_suffix(".bat"))
        .or_else(|| leaf.strip_suffix(".com"))
        .unwrap_or(leaf)
}

fn should_trust_claude_workspace(command: &str, env: &HashMap<String, String>) -> bool {
    let kind = env
        .get("MYCMUX_AGENT_KIND")
        .or_else(|| env.get("MYCMUX_RESUME"))
        .map(|value| value.as_str());
    kind == Some("claude") || command_leaf(command).eq_ignore_ascii_case("claude")
}

fn resolve_launch_cwd(cwd: Option<&str>) -> Option<String> {
    if let Some(value) = cwd.filter(|value| !value.trim().is_empty()) {
        return Some(value.to_string());
    }
    dirs::home_dir().map(|path| path.to_string_lossy().to_string())
}

fn normalize_agent_cwd(cwd: &str) -> String {
    let normalized = if cwd.starts_with('/') && cwd.len() > 2 && cwd.as_bytes()[2] == b'/' {
        format!(
            "{}:{}",
            cwd[1..2].to_uppercase(),
            cwd[2..].replace('/', "\\")
        )
    } else {
        cwd.replace('/', "\\")
    };
    let trimmed = normalized.trim_end_matches(['\\', '/']);
    let normalized_path = Path::new(trimmed)
        .canonicalize()
        .unwrap_or_else(|_| Path::new(trimmed).to_path_buf())
        .to_string_lossy()
        .to_string();
    normalized_path
        .strip_prefix(r"\\?\")
        .unwrap_or(&normalized_path)
        .to_string()
}

fn claude_project_key(cwd: &str) -> String {
    normalize_agent_cwd(cwd).replace([':', '\\', '/'], "-")
}

fn claude_session_path(cwd: &str, session_id: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(
        home.join(".claude")
            .join("projects")
            .join(claude_project_key(cwd))
            .join(format!("{session_id}.jsonl")),
    )
}

fn normalize_cwd_key(cwd: &str) -> String {
    normalize_agent_cwd(cwd).to_ascii_lowercase()
}

fn looks_like_uuid(value: &str) -> bool {
    if value.len() != 36 {
        return false;
    }
    value.chars().enumerate().all(|(idx, ch)| {
        let is_dash_slot = matches!(idx, 8 | 13 | 18 | 23);
        (is_dash_slot && ch == '-') || (!is_dash_slot && ch.is_ascii_hexdigit())
    })
}

fn codex_session_id_from_path(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let id = stem.get(stem.len().saturating_sub(36)..)?;
    looks_like_uuid(id).then(|| id.to_string())
}

fn codex_session_file_matches(path: &Path, session_id: &str, cwd_key: &str) -> bool {
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
    payload
        .and_then(|payload| payload.get("cwd"))
        .and_then(|cwd| cwd.as_str())
        .map(|cwd| normalize_cwd_key(cwd) == cwd_key)
        .unwrap_or(false)
}

fn visit_codex_sessions_dir(dir: &Path, session_id: &str, cwd_key: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if visit_codex_sessions_dir(&path, session_id, cwd_key) {
                return true;
            }
            continue;
        }
        if codex_session_file_matches(&path, session_id, cwd_key) {
            return true;
        }
    }
    false
}

fn codex_session_exists(cwd: &str, session_id: &str) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let sessions_dir = home.join(".codex").join("sessions");
    if !sessions_dir.exists() {
        return false;
    }
    visit_codex_sessions_dir(&sessions_dir, session_id, &normalize_cwd_key(cwd))
}

pub(crate) fn can_restore_agent_session(kind: &str, session_id: &str, cwd: Option<&str>) -> bool {
    let Some(cwd) = resolve_launch_cwd(cwd) else {
        return false;
    };
    match kind {
        "claude" => claude_session_path(&cwd, session_id)
            .map(|path| path.is_file())
            .unwrap_or(false),
        "codex" => codex_session_exists(&cwd, session_id),
        // claude-codex is an optional external wrapper; do not block it here.
        "claude-codex" => true,
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
        _ => cwd.clone(),
    };
    Some(format!(
        "Cannot restore {kind} session {session_id} from {cwd}. Saved session was not found ({detail})."
    ))
}

/// Last-line defense against MYCMUX_* env pollution leaking into a freshly
/// spawned PTY child.
///
/// `validate_agent_restore_request` only rejects *invalid* resume payloads — it
/// will happily pass through `MYCMUX_RESUME=1` on its own (no MYCMUX_SESSION_ID),
/// or stray `MYCMUX_PANE_SESSION_ID` / `__CMUX_LAUNCHER_DONE` left over from
/// persistence or parent shells. Any of those reaching the child triggers
/// unintended agent auto-resume / kind detection.
///
/// Strategy:
///   - If the payload looks like a *legitimate* resume (`MYCMUX_SESSION_ID` +
///     a recognized kind in `MYCMUX_RESUME` / `MYCMUX_AGENT_KIND`) or a
///     legitimate handoff (`MYCMUX_HANDOFF` + `MYCMUX_HANDOFF_FROM_SESSION`),
///     keep the resume / handoff trio and only strip pane-internal bookkeeping
///     (`MYCMUX_PANE_SESSION_ID`, `MYCMUX_TAB_ID`, `__CMUX_LAUNCHER_DONE`).
///   - Otherwise strip *every* MYCMUX_* and `__CMUX_LAUNCHER_DONE`.
///
/// Keep this list in sync with `lib.rs::run()` startup `remove_var` and the
/// frontend `EPHEMERAL_LAUNCH_ENV_KEYS` set in `SocketListener.tsx`.
fn sanitize_launch_env(env: &mut HashMap<String, String>) {
    const ALWAYS_INTERNAL: &[&str] = &[
        "MYCMUX_PANE_SESSION_ID",
        "MYCMUX_TAB_ID",
        "__CMUX_LAUNCHER_DONE",
        // Always stripped so frontend/parent-shell cannot forge a path. The
        // canonical absolute value is re-injected by create_session below.
        "MYCMUX_HTML_OUT",
        "MYCMUX_MARKDOWN_OUT",
        "MYCMUX_ARTIFACTS_DIR",
    ];
    const RESUME_TRIO: &[&str] = &["MYCMUX_RESUME", "MYCMUX_SESSION_ID", "MYCMUX_AGENT_KIND"];
    const HANDOFF_QUARTET: &[&str] = &[
        "MYCMUX_HANDOFF",
        "MYCMUX_HANDOFF_FROM",
        "MYCMUX_HANDOFF_PROMPT_FILE",
        "MYCMUX_HANDOFF_FROM_SESSION",
    ];

    let has_session = env
        .get("MYCMUX_SESSION_ID")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    let has_kind = env
        .get("MYCMUX_RESUME")
        .or_else(|| env.get("MYCMUX_AGENT_KIND"))
        .map(|v| v.as_str())
        .map(is_agent_session_kind)
        .unwrap_or(false);
    let legitimate_resume = has_session && has_kind;

    let has_handoff = env
        .get("MYCMUX_HANDOFF")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    let has_handoff_from = env
        .get("MYCMUX_HANDOFF_FROM_SESSION")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    let legitimate_handoff = has_handoff && has_handoff_from;

    for key in ALWAYS_INTERNAL {
        env.remove(*key);
    }
    if !legitimate_resume {
        for key in RESUME_TRIO {
            env.remove(*key);
        }
    }
    if !legitimate_handoff {
        for key in HANDOFF_QUARTET {
            env.remove(*key);
        }
    }
}

fn validate_agent_restore_request(
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

fn ensure_claude_project_trusted(cwd: &str) -> Result<(), String> {
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

    let tmp_path = path.with_extension("json.mycmux-lite.tmp");
    let json = serde_json::to_string_pretty(&root)
        .map_err(|error| format!("serialize .claude.json: {error}"))?;
    std::fs::write(&tmp_path, json).map_err(|error| format!("write .claude.json tmp: {error}"))?;
    std::fs::rename(&tmp_path, &path).map_err(|error| format!("replace .claude.json: {error}"))
}

fn write_launch_session_mapping(session_id: &str, env: &HashMap<String, String>) {
    let Some(agent_session_id) = env
        .get("MYCMUX_SESSION_ID")
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    let Some(agent_kind) = env
        .get("MYCMUX_AGENT_KIND")
        .or_else(|| env.get("MYCMUX_RESUME"))
        .map(|value| value.as_str())
        .filter(|value| is_agent_session_kind(value))
    else {
        return;
    };
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let map_dir = home.join(".mycmux-lite").join("pane-sessions");
    if std::fs::create_dir_all(&map_dir).is_err() {
        return;
    }
    let path = map_dir.join(format!("{session_id}.txt"));
    let _ = std::fs::write(path, format!("{agent_kind}:{agent_session_id}\n"));
}

/// Inject a shell-specific OSC 7 emission hook so the PTY reader can observe
/// CWD changes immediately. Silent no-op for shells we don't know how to hook
/// (PowerShell, cmd.exe, zsh for now) — sysinfo monitor remains the fallback.
fn inject_osc7_hook(command: &str, args: &mut Vec<String>, env: &mut HashMap<String, String>) {
    // Allow the frontend to opt out at spawn time by setting MYCMUX_OSC7=0.
    if env.get("MYCMUX_OSC7").map(|v| v == "0").unwrap_or(false) {
        return;
    }
    let lower = command.to_ascii_lowercase();
    let leaf = lower.rsplit(['/', '\\']).next().unwrap_or("");
    let shell = leaf.strip_suffix(".exe").unwrap_or(leaf);

    match shell {
        "bash" | "sh" => {
            let hook = r#"printf '\e]7;file://%s%s\a' "${HOSTNAME:-localhost}" "$PWD""#;
            let existing = env.get("PROMPT_COMMAND").cloned().unwrap_or_default();
            let combined = if existing.is_empty() {
                hook.to_string()
            } else {
                // Run the hook after user's PROMPT_COMMAND so their exit
                // status logic is preserved.
                format!("{};{}", existing, hook)
            };
            env.insert("PROMPT_COMMAND".into(), combined);
        }
        "fish" => {
            let init = r#"function __mycmux_osc7 --on-event fish_prompt; printf '\e]7;file://%s%s\a' (hostname) $PWD; end"#;
            args.insert(0, "--init-command".into());
            args.insert(1, init.into());
        }
        // zsh: needs ZDOTDIR override + precmd hook; deferred.
        // pwsh / powershell / cmd: no OSC 7 equivalent; sysinfo handles them.
        _ => {}
    }
}

#[tauri::command]
pub fn write_to_session(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    state.session_manager.write(&session_id, data.as_bytes())
}

#[tauri::command]
pub fn resize_session(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.session_manager.resize(&session_id, cols, rows)
}

#[tauri::command]
pub fn kill_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state.session_manager.kill(&session_id)
}

fn is_safe_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && !session_id.contains('/')
        && !session_id.contains('\\')
        && session_id != "."
        && session_id != ".."
}

fn sidetab_session_dir(session_id: &str) -> Result<PathBuf, String> {
    if !is_safe_session_id(session_id) {
        return Err("Invalid session id".to_string());
    }
    let home = dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    Ok(home.join(".mycmux").join("sessions").join(session_id))
}

fn normalize_preview_path(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn is_allowed_artifact_path(session_dir: &Path, path: &Path) -> bool {
    let root = normalize_preview_path(session_dir);
    let target = normalize_preview_path(path);
    target == root.join("out.html")
        || target == root.join("out.md")
        || target.starts_with(root.join("artifacts"))
}

fn is_allowed_external_artifact_path(path: &Path) -> bool {
    path.is_absolute() && path.is_file()
}

fn is_previewable_artifact(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("html")
            | Some("htm")
            | Some("md")
            | Some("markdown")
            | Some("doc")
            | Some("docx")
            | Some("docm")
            | Some("dot")
            | Some("dotx")
            | Some("dotm")
            | Some("xls")
            | Some("xlsx")
            | Some("xlsm")
            | Some("xlsb")
            | Some("xlt")
            | Some("xltx")
            | Some("xltm")
            | Some("ppt")
            | Some("pptx")
            | Some("pptm")
            | Some("pot")
            | Some("potx")
            | Some("potm")
            | Some("pps")
            | Some("ppsx")
            | Some("ppsm")
    )
}

fn artifact_source_kind(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("html") | Some("htm") => Some("html"),
        Some("md") | Some("markdown") => Some("markdown"),
        Some("doc") | Some("docx") | Some("docm") | Some("dot") | Some("dotx") | Some("dotm")
        | Some("xls") | Some("xlsx") | Some("xlsm") | Some("xlsb") | Some("xlt") | Some("xltx")
        | Some("xltm") | Some("ppt") | Some("pptx") | Some("pptm") | Some("pot") | Some("potx")
        | Some("potm") | Some("pps") | Some("ppsx") | Some("ppsm") => Some("office"),
        _ => None,
    }
}

fn validate_editable_artifact_path(source_path: &str) -> Result<(PathBuf, String), String> {
    let path = PathBuf::from(source_path);
    if !path.is_absolute() {
        return Err("Editable artifact path must be absolute".to_string());
    }
    if !path.exists() {
        return Err("Editable artifact file not found".to_string());
    }
    if !path.is_file() {
        return Err("Editable artifact path must be a file".to_string());
    }
    let Some(kind) = artifact_source_kind(&path) else {
        return Err(
            "Editable artifact must be .html, .htm, .md, .markdown, or editable Word file"
                .to_string(),
        );
    };
    if !matches!(kind, "html" | "markdown") && !is_editable_word_artifact(&path) {
        return Err(
            "Editable artifact must be .html, .htm, .md, .markdown, or .docx/.docm/.dotx/.dotm"
                .to_string(),
        );
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Failed to canonicalize editable artifact: {error}"))?;
    Ok((canonical, kind.to_string()))
}

fn is_editable_word_artifact(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("docx") | Some("docm") | Some("dotx") | Some("dotm")
    )
}

fn decode_file_uri(value: &str) -> String {
    let mut decoded = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = &value[index + 1..index + 3];
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                decoded.push(byte);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn strip_ascii_spaces_around_path_separators(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut stripped = String::with_capacity(value.len());
    for index in 0..chars.len() {
        let ch = chars[index];
        if ch == ' ' || ch == '\t' {
            let mut next_is_separator = false;
            for next in &chars[index + 1..] {
                if *next == ' ' || *next == '\t' {
                    continue;
                }
                next_is_separator = *next == '/' || *next == '\\';
                break;
            }
            let prev_is_separator = stripped
                .chars()
                .rev()
                .find(|prev| *prev != ' ' && *prev != '\t')
                .map(|prev| prev == '/' || prev == '\\')
                .unwrap_or(false);
            if next_is_separator || prev_is_separator {
                continue;
            }
        }
        stripped.push(ch);
    }
    stripped
}

fn collapse_ascii_space_runs(value: &str) -> String {
    let mut collapsed = String::with_capacity(value.len());
    let mut in_ascii_space = false;
    for ch in value.chars() {
        if ch == ' ' || ch == '\t' {
            if !in_ascii_space {
                collapsed.push(' ');
            }
            in_ascii_space = true;
        } else {
            collapsed.push(ch);
            in_ascii_space = false;
        }
    }
    collapsed
}

fn strip_ascii_spaces_for_lookup(value: &str) -> String {
    value
        .chars()
        .filter(|ch| *ch != ' ' && *ch != '\t')
        .collect()
}

fn resolve_ascii_space_insensitive_existing_path(path: &Path) -> Option<PathBuf> {
    if path.is_file() {
        return Some(path.to_path_buf());
    }

    let mut resolved = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(prefix) => {
                resolved.push(prefix.as_os_str());
            }
            std::path::Component::RootDir => {
                resolved.push(component.as_os_str());
            }
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => return None,
            std::path::Component::Normal(segment) => {
                let direct = resolved.join(segment);
                if direct.exists() {
                    resolved = direct;
                    continue;
                }

                let needle = strip_ascii_spaces_for_lookup(&segment.to_string_lossy());
                if needle.is_empty() || !resolved.is_dir() {
                    return None;
                }

                let mut matches = Vec::new();
                for entry in std::fs::read_dir(&resolved).ok()? {
                    let entry = entry.ok()?;
                    let candidate = entry.file_name();
                    if strip_ascii_spaces_for_lookup(&candidate.to_string_lossy()) == needle {
                        matches.push(entry.path());
                        if matches.len() > 1 {
                            return None;
                        }
                    }
                }

                resolved = matches.pop()?;
            }
        }
    }

    resolved.is_file().then_some(resolved)
}

fn artifact_path_from_decoded_uri(value: &str) -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(value.replace('/', "\\"))
    }
    #[cfg(not(windows))]
    {
        PathBuf::from(value)
    }
}

fn artifact_path_from_uri(uri: &str) -> Result<PathBuf, String> {
    let mut value = uri
        .trim()
        .trim_end_matches(['.', ',', ';', ':', ')', ']', '}', '+', '＋']);
    if value.starts_with("file://") {
        value = &value[7..];
        if cfg!(windows) && value.starts_with('/') && value.len() > 2 && value.as_bytes()[2] == b':'
        {
            value = &value[1..];
        }
    }
    let decoded = decode_file_uri(value);
    let primary = artifact_path_from_decoded_uri(&decoded);
    if primary.is_file() {
        return Ok(primary);
    }

    let without_separator_padding = strip_ascii_spaces_around_path_separators(&decoded);
    let collapsed_spaces = collapse_ascii_space_runs(&decoded);
    let collapsed_without_separator_padding =
        strip_ascii_spaces_around_path_separators(&collapsed_spaces);
    for candidate in [
        without_separator_padding,
        collapsed_spaces,
        collapsed_without_separator_padding,
    ] {
        if candidate == decoded {
            continue;
        }
        let path = artifact_path_from_decoded_uri(&candidate);
        if path.is_file() {
            return Ok(path);
        }
        if let Some(path) = resolve_ascii_space_insensitive_existing_path(&path) {
            return Ok(path);
        }
    }

    if let Some(path) = resolve_ascii_space_insensitive_existing_path(&primary) {
        return Ok(path);
    }

    Ok(primary)
}

fn external_markdown_preview_path(session_dir: &Path, path: &Path) -> Result<PathBuf, String> {
    external_artifact_preview_path(session_dir, path, "")
}

fn external_office_preview_path(session_dir: &Path, path: &Path) -> Result<PathBuf, String> {
    external_artifact_preview_path(session_dir, path, "office")
}

fn external_artifact_preview_path(
    session_dir: &Path,
    path: &Path,
    preview_kind: &str,
) -> Result<PathBuf, String> {
    let previews_dir = session_dir.join("artifacts").join("previews");
    std::fs::create_dir_all(&previews_dir)
        .map_err(|error| format!("Failed to create preview directory: {error}"))?;
    let raw_stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("artifact");
    let mut safe_stem: String = raw_stem
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if safe_stem.is_empty() {
        safe_stem = "artifact".to_string();
    }
    let mut hasher = DefaultHasher::new();
    path.to_string_lossy()
        .to_ascii_lowercase()
        .hash(&mut hasher);
    let preview_suffix = if preview_kind.is_empty() {
        "preview.html".to_string()
    } else {
        format!("{preview_kind}.preview.html")
    };
    Ok(previews_dir.join(format!(
        "{}-{:016x}.{}",
        safe_stem,
        hasher.finish(),
        preview_suffix
    )))
}

fn preview_path_for_artifact(
    session_id: &str,
    path: &Path,
    allow_external: bool,
) -> Result<String, String> {
    let session_dir = sidetab_session_dir(session_id)?;
    let is_session_artifact = is_allowed_artifact_path(&session_dir, path);
    let is_external_artifact = allow_external && is_allowed_external_artifact_path(path);
    if (!is_session_artifact && !is_external_artifact) || !is_previewable_artifact(path) {
        return Err("Artifact path is outside this session preview area".to_string());
    }
    if !path.is_file() {
        return Err("Artifact file not found".to_string());
    }
    let source_kind =
        artifact_source_kind(path).ok_or_else(|| "Unsupported artifact source kind".to_string())?;
    match source_kind {
        "html" => Ok(path.to_string_lossy().to_string()),
        "markdown" => {
            let markdown = std::fs::read_to_string(path)
                .map_err(|error| format!("Failed to read markdown artifact: {error}"))?;
            let preview_path = if is_session_artifact {
                path.with_extension("preview.html")
            } else {
                external_markdown_preview_path(&session_dir, path)?
            };
            std::fs::write(&preview_path, markdown_to_static_html(&markdown))
                .map_err(|error| format!("Failed to write markdown preview: {error}"))?;
            Ok(preview_path.to_string_lossy().to_string())
        }
        "office" => {
            let preview_path = if is_session_artifact {
                path.with_extension("office.preview.html")
            } else {
                external_office_preview_path(&session_dir, path)?
            };
            std::fs::write(&preview_path, office_to_static_html(path))
                .map_err(|error| format!("Failed to write Office preview: {error}"))?;
            Ok(preview_path.to_string_lossy().to_string())
        }
        _ => Err("Unsupported artifact source kind".to_string()),
    }
}

fn preview_info_for_artifact(
    session_id: &str,
    path: &Path,
    allow_external: bool,
) -> Result<PreviewArtifactInfo, String> {
    let preview_path = preview_path_for_artifact(session_id, path, allow_external)?;
    let source_kind = artifact_source_kind(path)
        .ok_or_else(|| "Unsupported artifact source kind".to_string())?
        .to_string();
    let source_path = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string();
    Ok(PreviewArtifactInfo {
        preview_path,
        source_path,
        source_kind,
    })
}

fn escape_html(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

fn office_kind_label(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("doc") | Some("docx") | Some("docm") | Some("dot") | Some("dotx") | Some("dotm") => {
            "Word"
        }
        Some("xls") | Some("xlsx") | Some("xlsm") | Some("xlsb") | Some("xlt") | Some("xltx")
        | Some("xltm") => "Excel",
        Some("ppt") | Some("pptx") | Some("pptm") | Some("pot") | Some("potx") | Some("potm")
        | Some("pps") | Some("ppsx") | Some("ppsm") => "PowerPoint",
        _ => "Office",
    }
}

fn xml_local_name(name: &[u8]) -> &[u8] {
    name.iter()
        .position(|byte| *byte == b':')
        .map(|index| &name[index + 1..])
        .unwrap_or(name)
}

fn decode_xml_text(value: &quick_xml::events::BytesText<'_>) -> String {
    value
        .decode()
        .map(|text| text.into_owned())
        .unwrap_or_default()
}

fn xml_attr_value(element: &quick_xml::events::BytesStart<'_>, key: &[u8]) -> Option<String> {
    element.attributes().flatten().find_map(|attribute| {
        if xml_local_name(attribute.key.as_ref()) == key {
            Some(String::from_utf8_lossy(attribute.value.as_ref()).to_string())
        } else {
            None
        }
    })
}

fn read_zip_text_entry(path: &Path, entry_name: &str) -> Result<String, String> {
    let file = File::open(path).map_err(|error| format!("Failed to open Office file: {error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("Failed to read Office archive: {error}"))?;
    let mut entry = archive
        .by_name(entry_name)
        .map_err(|error| format!("Office entry not found ({entry_name}): {error}"))?;
    let mut contents = String::new();
    entry
        .read_to_string(&mut contents)
        .map_err(|error| format!("Failed to read Office XML ({entry_name}): {error}"))?;
    Ok(contents)
}

fn zip_entry_names(path: &Path, prefix: &str, suffix: &str) -> Result<Vec<String>, String> {
    let file = File::open(path).map_err(|error| format!("Failed to open Office file: {error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("Failed to read Office archive: {error}"))?;
    let mut names = Vec::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to inspect Office archive: {error}"))?;
        let name = entry.name();
        if name.starts_with(prefix) && name.ends_with(suffix) {
            names.push(name.to_string());
        }
    }
    names.sort();
    Ok(names)
}

fn push_html_text(target: &mut String, text: &str) {
    if !text.is_empty() {
        target.push_str(&escape_html(text));
    }
}

fn flush_docx_paragraph(body: &mut String, paragraph: &mut String) {
    let trimmed = paragraph.trim();
    if !trimmed.is_empty() {
        body.push_str("<p>");
        body.push_str(trimmed);
        body.push_str("</p>\n");
    }
    paragraph.clear();
}

fn docx_xml_to_html(xml: &str) -> String {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut body = String::new();
    let mut paragraph = String::new();
    let mut cell = String::new();
    let mut in_text = false;
    let mut in_table = false;
    let mut in_cell = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => match xml_local_name(element.name().as_ref()) {
                b"tbl" => {
                    flush_docx_paragraph(&mut body, &mut paragraph);
                    body.push_str("<table><tbody>\n");
                    in_table = true;
                }
                b"tr" if in_table => body.push_str("<tr>"),
                b"tc" if in_table => {
                    in_cell = true;
                    cell.clear();
                }
                b"t" => in_text = true,
                _ => {}
            },
            Ok(Event::Empty(element)) => match xml_local_name(element.name().as_ref()) {
                b"tab" => {
                    if in_cell {
                        cell.push(' ');
                    } else {
                        paragraph.push(' ');
                    }
                }
                b"br" => {
                    if in_cell {
                        cell.push_str("<br>");
                    } else {
                        paragraph.push_str("<br>");
                    }
                }
                _ => {}
            },
            Ok(Event::Text(text)) if in_text => {
                let decoded = decode_xml_text(&text);
                if in_cell {
                    push_html_text(&mut cell, &decoded);
                } else {
                    push_html_text(&mut paragraph, &decoded);
                }
            }
            Ok(Event::End(element)) => match xml_local_name(element.name().as_ref()) {
                b"t" => in_text = false,
                b"p" if !in_table => flush_docx_paragraph(&mut body, &mut paragraph),
                b"tc" if in_table => {
                    let trimmed = cell.trim();
                    body.push_str("<td>");
                    if trimmed.is_empty() {
                        body.push_str("&nbsp;");
                    } else {
                        body.push_str(trimmed);
                    }
                    body.push_str("</td>");
                    cell.clear();
                    in_cell = false;
                }
                b"tr" if in_table => body.push_str("</tr>\n"),
                b"tbl" => {
                    body.push_str("</tbody></table>\n");
                    in_table = false;
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    flush_docx_paragraph(&mut body, &mut paragraph);
    if body.trim().is_empty() {
        "<p class=\"office-empty\">No readable text was found in this Word document.</p>"
            .to_string()
    } else {
        body
    }
}

fn docx_to_html(path: &Path) -> Result<String, String> {
    let xml = read_zip_text_entry(path, "word/document.xml")?;
    Ok(docx_xml_to_html(&xml))
}

fn docx_default_section_properties() -> String {
    r#"<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>"#.to_string()
}

fn docx_section_properties(original_xml: &str) -> String {
    let Some(start) = original_xml.rfind("<w:sectPr") else {
        return docx_default_section_properties();
    };
    let tail = &original_xml[start..];
    if let Some(end) = tail.find("</w:sectPr>") {
        return tail[..end + "</w:sectPr>".len()].to_string();
    }
    if let Some(end) = tail.find("/>") {
        return tail[..end + 2].to_string();
    }
    docx_default_section_properties()
}

fn push_docx_run(target: &mut String, text: &str, bold: bool, italic: bool) {
    if text.is_empty() {
        return;
    }
    target.push_str("<w:r>");
    if bold || italic {
        target.push_str("<w:rPr>");
        if bold {
            target.push_str("<w:b/>");
        }
        if italic {
            target.push_str("<w:i/>");
        }
        target.push_str("</w:rPr>");
    }
    target.push_str("<w:t xml:space=\"preserve\">");
    target.push_str(&escape_html(text));
    target.push_str("</w:t></w:r>");
}

fn docx_inline_runs(node: &NodeRef, target: &mut String, bold: bool, italic: bool) {
    match node.data() {
        NodeData::Text(text) => push_docx_run(target, &text.borrow(), bold, italic),
        NodeData::Element(element) => {
            let name = element.name.local.to_string();
            match name.as_str() {
                "script" | "style" => {}
                "br" => target.push_str("<w:r><w:br/></w:r>"),
                "strong" | "b" => {
                    for child in node.children() {
                        docx_inline_runs(&child, target, true, italic);
                    }
                }
                "em" | "i" => {
                    for child in node.children() {
                        docx_inline_runs(&child, target, bold, true);
                    }
                }
                _ => {
                    for child in node.children() {
                        docx_inline_runs(&child, target, bold, italic);
                    }
                }
            }
        }
        _ => {
            for child in node.children() {
                docx_inline_runs(&child, target, bold, italic);
            }
        }
    }
}

fn docx_paragraph_xml(node: &NodeRef, style: Option<&str>, prefix: Option<&str>) -> Option<String> {
    let text = text_content(node);
    if text.trim().is_empty() && prefix.is_none() {
        return None;
    }
    let mut paragraph = String::from("<w:p>");
    if let Some(style) = style {
        paragraph.push_str("<w:pPr><w:pStyle w:val=\"");
        paragraph.push_str(style);
        paragraph.push_str("\"/></w:pPr>");
    }
    if let Some(prefix) = prefix {
        push_docx_run(&mut paragraph, prefix, false, false);
    }
    for child in node.children() {
        docx_inline_runs(&child, &mut paragraph, false, false);
    }
    paragraph.push_str("</w:p>");
    Some(paragraph)
}

fn docx_table_xml(node: &NodeRef) -> Option<String> {
    let rows = node
        .select("tr")
        .ok()?
        .filter_map(|row| {
            let row_node = row.as_node().clone();
            let cells = row_node
                .select("th,td")
                .ok()?
                .map(|cell| {
                    let cell_node = cell.as_node().clone();
                    let mut cell_xml = String::from("<w:tc><w:p>");
                    for child in cell_node.children() {
                        docx_inline_runs(&child, &mut cell_xml, false, false);
                    }
                    if text_content(&cell_node).trim().is_empty() {
                        cell_xml.push_str("<w:r><w:t></w:t></w:r>");
                    }
                    cell_xml.push_str("</w:p></w:tc>");
                    Some(cell_xml)
                })
                .collect::<Option<Vec<_>>>()?;
            if cells.is_empty() {
                None
            } else {
                Some(format!("<w:tr>{}</w:tr>", cells.join("")))
            }
        })
        .collect::<Vec<_>>();
    if rows.is_empty() {
        return None;
    }
    Some(format!(
        "<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/></w:tblPr>{}</w:tbl>",
        rows.join("")
    ))
}

fn docx_block_xml(node: &NodeRef, target: &mut Vec<String>) {
    match node.data() {
        NodeData::Text(text) => {
            let value = text.borrow();
            if !value.trim().is_empty() {
                target.push(format!(
                    "<w:p><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
                    escape_html(value.trim())
                ));
            }
        }
        NodeData::Element(element) => {
            let name = element.name.local.to_string();
            match name.as_str() {
                "script" | "style" => {}
                "h1" => {
                    if let Some(paragraph) = docx_paragraph_xml(node, Some("Heading1"), None) {
                        target.push(paragraph);
                    }
                }
                "h2" => {
                    if let Some(paragraph) = docx_paragraph_xml(node, Some("Heading2"), None) {
                        target.push(paragraph);
                    }
                }
                "h3" | "h4" | "h5" | "h6" => {
                    if let Some(paragraph) = docx_paragraph_xml(node, Some("Heading3"), None) {
                        target.push(paragraph);
                    }
                }
                "p" | "div" | "blockquote" => {
                    if let Some(paragraph) = docx_paragraph_xml(node, None, None) {
                        target.push(paragraph);
                    }
                }
                "ul" => {
                    if let Ok(items) = node.select("li") {
                        for item in items {
                            if let Some(paragraph) =
                                docx_paragraph_xml(item.as_node(), None, Some("- "))
                            {
                                target.push(paragraph);
                            }
                        }
                    }
                }
                "ol" => {
                    if let Ok(items) = node.select("li") {
                        for (index, item) in items.enumerate() {
                            if let Some(paragraph) = docx_paragraph_xml(
                                item.as_node(),
                                None,
                                Some(&format!("{}. ", index + 1)),
                            ) {
                                target.push(paragraph);
                            }
                        }
                    }
                }
                "table" => {
                    if let Some(table) = docx_table_xml(node) {
                        target.push(table);
                    }
                }
                "section" | "article" | "main" | "body" => {
                    for child in node.children() {
                        docx_block_xml(&child, target);
                    }
                }
                _ => {
                    if let Some(paragraph) = docx_paragraph_xml(node, None, None) {
                        target.push(paragraph);
                    }
                }
            }
        }
        _ => {
            for child in node.children() {
                docx_block_xml(&child, target);
            }
        }
    }
}

fn html_fragment_to_docx_document_xml(fragment: &str, original_xml: &str) -> String {
    let document = kuchikiki::parse_html()
        .one(format!(
            "<!doctype html><html><body>{fragment}</body></html>"
        ))
        .document_node;
    let body = document
        .select_first("body")
        .ok()
        .map(|node| node.as_node().clone())
        .unwrap_or(document);
    let mut blocks = Vec::new();
    for child in body.children() {
        docx_block_xml(&child, &mut blocks);
    }
    if blocks.is_empty() {
        blocks.push("<w:p/>".to_string());
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{}{}</w:body></w:document>"#,
        blocks.join(""),
        docx_section_properties(original_xml)
    )
}

fn xlsx_shared_strings_xml_to_vec(xml: &str) -> Vec<String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut values = Vec::new();
    let mut current = String::new();
    let mut in_item = false;
    let mut in_text = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => match xml_local_name(element.name().as_ref()) {
                b"si" => {
                    current.clear();
                    in_item = true;
                }
                b"t" if in_item => in_text = true,
                _ => {}
            },
            Ok(Event::Text(text)) if in_item && in_text => {
                current.push_str(&decode_xml_text(&text));
            }
            Ok(Event::End(element)) => match xml_local_name(element.name().as_ref()) {
                b"t" => in_text = false,
                b"si" => {
                    values.push(current.clone());
                    current.clear();
                    in_item = false;
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }

    values
}

fn xlsx_sheet_xml_to_html(xml: &str, shared_strings: &[String]) -> String {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut body = String::new();
    let mut cell_type = String::new();
    let mut cell_value = String::new();
    let mut in_value = false;
    let mut in_row = false;

    body.push_str("<table><tbody>\n");
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => match xml_local_name(element.name().as_ref()) {
                b"row" => {
                    in_row = true;
                    body.push_str("<tr>");
                }
                b"c" => {
                    cell_type = xml_attr_value(&element, b"t").unwrap_or_default();
                    cell_value.clear();
                }
                b"v" | b"t" => in_value = true,
                _ => {}
            },
            Ok(Event::Text(text)) if in_value => {
                cell_value.push_str(&decode_xml_text(&text));
            }
            Ok(Event::End(element)) => match xml_local_name(element.name().as_ref()) {
                b"v" | b"t" => in_value = false,
                b"c" if in_row => {
                    let value = if cell_type == "s" {
                        cell_value
                            .trim()
                            .parse::<usize>()
                            .ok()
                            .and_then(|index| shared_strings.get(index))
                            .cloned()
                            .unwrap_or_default()
                    } else {
                        cell_value.clone()
                    };
                    body.push_str("<td>");
                    let trimmed = value.trim();
                    if trimmed.is_empty() {
                        body.push_str("&nbsp;");
                    } else {
                        body.push_str(&escape_html(trimmed));
                    }
                    body.push_str("</td>");
                    cell_value.clear();
                    cell_type.clear();
                }
                b"row" => {
                    in_row = false;
                    body.push_str("</tr>\n");
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    body.push_str("</tbody></table>\n");
    body
}

fn xlsx_to_html(path: &Path) -> Result<String, String> {
    let shared_strings = read_zip_text_entry(path, "xl/sharedStrings.xml")
        .map(|xml| xlsx_shared_strings_xml_to_vec(&xml))
        .unwrap_or_default();
    let sheets = zip_entry_names(path, "xl/worksheets/sheet", ".xml")?;
    if sheets.is_empty() {
        return Ok("<p class=\"office-empty\">No readable worksheets were found.</p>".to_string());
    }

    let mut body = String::new();
    for (index, sheet_name) in sheets.iter().take(6).enumerate() {
        let xml = read_zip_text_entry(path, sheet_name)?;
        body.push_str(&format!(
            "<section class=\"sheet\"><h2>Sheet {}</h2>",
            index + 1
        ));
        body.push_str(&xlsx_sheet_xml_to_html(&xml, &shared_strings));
        body.push_str("</section>\n");
    }
    Ok(body)
}

fn pptx_slide_xml_to_paragraphs(xml: &str) -> Vec<String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut paragraphs = Vec::new();
    let mut current = String::new();
    let mut in_paragraph = false;
    let mut in_text = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => match xml_local_name(element.name().as_ref()) {
                b"p" => {
                    current.clear();
                    in_paragraph = true;
                }
                b"t" if in_paragraph => in_text = true,
                _ => {}
            },
            Ok(Event::Text(text)) if in_text => current.push_str(&decode_xml_text(&text)),
            Ok(Event::End(element)) => match xml_local_name(element.name().as_ref()) {
                b"t" => in_text = false,
                b"p" if in_paragraph => {
                    let trimmed = current.trim();
                    if !trimmed.is_empty() {
                        paragraphs.push(trimmed.to_string());
                    }
                    current.clear();
                    in_paragraph = false;
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    paragraphs
}

fn pptx_to_html(path: &Path) -> Result<String, String> {
    let slides = zip_entry_names(path, "ppt/slides/slide", ".xml")?;
    if slides.is_empty() {
        return Ok("<p class=\"office-empty\">No readable slides were found.</p>".to_string());
    }

    let mut body = String::new();
    for (index, slide_name) in slides.iter().take(24).enumerate() {
        let xml = read_zip_text_entry(path, slide_name)?;
        let paragraphs = pptx_slide_xml_to_paragraphs(&xml);
        body.push_str(&format!(
            "<section class=\"slide\"><h2>Slide {}</h2>",
            index + 1
        ));
        if paragraphs.is_empty() {
            body.push_str("<p class=\"office-empty\">No text on this slide.</p>");
        } else {
            for paragraph in paragraphs {
                body.push_str("<p>");
                body.push_str(&escape_html(&paragraph));
                body.push_str("</p>");
            }
        }
        body.push_str("</section>\n");
    }
    Ok(body)
}

fn office_document_body_html(path: &Path) -> Result<String, String> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("docx") | Some("docm") | Some("dotx") | Some("dotm") => docx_to_html(path),
        Some("xlsx") | Some("xlsm") | Some("xltx") | Some("xltm") => xlsx_to_html(path),
        Some("pptx") | Some("pptm") | Some("potx") | Some("potm") | Some("ppsx") | Some("ppsm") => {
            pptx_to_html(path)
        }
        _ => Err("This Office format cannot be previewed in-app yet.".to_string()),
    }
}

fn office_to_static_html(path: &Path) -> String {
    let file_name = path
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .unwrap_or("Office document");
    let parent = path
        .parent()
        .map(|parent| parent.to_string_lossy().to_string())
        .unwrap_or_default();
    let source_path = path.to_string_lossy();
    let preview = office_document_body_html(path).unwrap_or_else(|error| {
        format!(
            "<p class=\"office-empty\">{}</p>",
            escape_html(&format!(
                "{error} Use the Open button in the toolbar to edit/check this document in the desktop app."
            ))
        )
    });
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><style>{}</style></head><body><section class=\"office-shell\"><header class=\"office-header\"><div class=\"office-type\">{}</div><h1>{}</h1><dl><dt>Folder</dt><dd>{}</dd><dt>Path</dt><dd>{}</dd></dl><p class=\"office-note\">Use Open in the toolbar to edit this document in the default desktop app.</p></header><main class=\"office-preview\">{}</main></section></body></html>",
        r#"html{background:#edf1f5;color:#1f2937}body{margin:0;min-height:100vh;padding:28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;box-sizing:border-box}.office-shell{width:min(1040px,100%);margin:0 auto;box-sizing:border-box;border:1px solid #d6dbe3;background:#fff;box-shadow:0 18px 50px rgba(15,23,42,.10)}.office-header{padding:24px 28px 18px;border-bottom:1px solid #e5e7eb}.office-type{display:inline-flex;align-items:center;height:24px;padding:0 9px;border:1px solid #c8d0da;background:#f5f7fa;color:#475569;font-size:11px;font-weight:700;letter-spacing:0;text-transform:uppercase}h1{margin:14px 0 16px;font-size:25px;line-height:1.2;font-weight:720;letter-spacing:0;color:#111827;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:72px minmax(0,1fr);gap:6px 14px;margin:0;padding:14px 0;border-top:1px solid #eef2f7}dt{color:#64748b;font-size:12px;font-weight:700}dd{margin:0;color:#1f2937;font-size:13px;line-height:1.45;overflow-wrap:anywhere}.office-note{margin:12px 0 0;color:#475569;font-size:13px;line-height:1.55}.office-preview{padding:28px;font-size:14px;line-height:1.65}.office-preview p{margin:0 0 .85em}.office-preview h2{margin:0 0 12px;font-size:16px;line-height:1.3;color:#111827}.office-preview table{width:100%;border-collapse:collapse;margin:0 0 18px;display:block;overflow-x:auto}.office-preview th,.office-preview td{border:1px solid #d8dee8;padding:7px 9px;vertical-align:top;min-width:56px}.office-preview tr:nth-child(even) td{background:#fbfcfe}.sheet,.slide{margin:0 0 22px;padding-bottom:18px;border-bottom:1px solid #eef2f7}.office-empty{color:#64748b;font-style:italic}@media(max-width:640px){body{padding:14px}.office-header,.office-preview{padding:18px}h1{font-size:21px}dl{grid-template-columns:1fr;gap:4px}}"#,
        escape_html(office_kind_label(path)),
        escape_html(file_name),
        escape_html(&parent),
        escape_html(&source_path),
        preview
    )
}

fn is_safe_link_target(target: &str) -> bool {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:")
        || lower.starts_with('#')
}

fn render_inline_markdown(value: &str) -> String {
    let mut rendered = String::new();
    let mut rest = value;
    while let Some(open) = rest.find('[') {
        rendered.push_str(&escape_html(&rest[..open]));
        let Some(close_rel) = rest[open + 1..].find(']') else {
            rendered.push_str(&escape_html(&rest[open..]));
            return rendered;
        };
        let close = open + 1 + close_rel;
        let after_label = &rest[close + 1..];
        if !after_label.starts_with('(') {
            rendered.push_str(&escape_html(&rest[open..=close]));
            rest = after_label;
            continue;
        }
        let Some(end_rel) = after_label[1..].find(')') else {
            rendered.push_str(&escape_html(&rest[open..]));
            return rendered;
        };
        let target = &after_label[1..1 + end_rel];
        let label = &rest[open + 1..close];
        if is_safe_link_target(target) {
            rendered.push_str("<a href=\"");
            rendered.push_str(&escape_html(target.trim()));
            rendered.push_str("\" rel=\"noreferrer\" target=\"_blank\">");
            rendered.push_str(&escape_html(label));
            rendered.push_str("</a>");
        } else {
            rendered.push_str(&escape_html(&rest[open..close + 3 + end_rel]));
        }
        rest = &after_label[2 + end_rel..];
    }
    rendered.push_str(&escape_html(rest));
    rendered
}

fn flush_paragraph(html: &mut String, paragraph: &mut Vec<String>) {
    if paragraph.is_empty() {
        return;
    }
    html.push_str("<p>");
    html.push_str(&render_inline_markdown(&paragraph.join(" ")));
    html.push_str("</p>\n");
    paragraph.clear();
}

fn parse_heading(line: &str) -> Option<(usize, &str)> {
    let marker_len = line.chars().take_while(|ch| *ch == '#').count();
    if marker_len == 0 || marker_len > 6 {
        return None;
    }
    let rest = &line[marker_len..];
    rest.strip_prefix(' ')
        .map(|text| (marker_len, text.trim()))
        .filter(|(_, text)| !text.is_empty())
}

fn render_safe_table_html(value: &str) -> Option<String> {
    let document = kuchikiki::parse_html()
        .one(format!("<!doctype html><html><body>{value}</body></html>"))
        .document_node;
    if document.select_first("script").is_ok() {
        return None;
    }
    let table = document.select_first("table").ok()?;
    let html = serialize_node_html(table.as_node());
    if html.trim().is_empty() {
        None
    } else {
        Some(html)
    }
}

fn markdown_to_static_html(markdown: &str) -> String {
    let mut body = String::new();
    let mut paragraph: Vec<String> = Vec::new();
    let mut in_code = false;
    let mut code = String::new();
    let mut in_ul = false;

    for line in markdown.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            if in_code {
                body.push_str("<pre><code>");
                body.push_str(&escape_html(&code));
                body.push_str("</code></pre>\n");
                code.clear();
                in_code = false;
            } else {
                flush_paragraph(&mut body, &mut paragraph);
                if in_ul {
                    body.push_str("</ul>\n");
                    in_ul = false;
                }
                in_code = true;
            }
            continue;
        }
        if in_code {
            code.push_str(line);
            code.push('\n');
            continue;
        }
        if trimmed.is_empty() {
            flush_paragraph(&mut body, &mut paragraph);
            if in_ul {
                body.push_str("</ul>\n");
                in_ul = false;
            }
            continue;
        }
        if trimmed.starts_with("<table") && trimmed.contains("</table>") {
            flush_paragraph(&mut body, &mut paragraph);
            if in_ul {
                body.push_str("</ul>\n");
                in_ul = false;
            }
            if let Some(table_html) = render_safe_table_html(trimmed) {
                body.push_str(&table_html);
                body.push('\n');
                continue;
            }
        }
        if let Some((level, text)) = parse_heading(trimmed) {
            flush_paragraph(&mut body, &mut paragraph);
            if in_ul {
                body.push_str("</ul>\n");
                in_ul = false;
            }
            body.push_str(&format!("<h{level}>"));
            body.push_str(&render_inline_markdown(text));
            body.push_str(&format!("</h{level}>\n"));
            continue;
        }
        if let Some(item) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
        {
            flush_paragraph(&mut body, &mut paragraph);
            if !in_ul {
                body.push_str("<ul>\n");
                in_ul = true;
            }
            body.push_str("<li>");
            body.push_str(&render_inline_markdown(item));
            body.push_str("</li>\n");
            continue;
        }
        paragraph.push(trimmed.to_string());
    }

    if in_code {
        body.push_str("<pre><code>");
        body.push_str(&escape_html(&code));
        body.push_str("</code></pre>\n");
    }
    flush_paragraph(&mut body, &mut paragraph);
    if in_ul {
        body.push_str("</ul>\n");
    }

    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><style>{}</style></head><body>{}</body></html>",
        r#"html{background:#eef1f5;color:#1f2937}body{box-sizing:border-box;min-height:100vh;max-width:940px;margin:0 auto;padding:40px 46px 72px;background:#fff;color:#1f2937;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.72}h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.45em 0 .55em;color:#111827;font-weight:720;letter-spacing:0}h1{font-size:2rem;margin-top:.25em;padding-bottom:.35em;border-bottom:1px solid #e5e7eb}h2{font-size:1.45rem;padding-bottom:.25em;border-bottom:1px solid #eef2f7}h3{font-size:1.18rem}p,ul,ol,pre,blockquote,table{margin:0 0 1.05em}ul,ol{padding-left:1.6em}li+li{margin-top:.25em}blockquote{padding:10px 16px;border-left:4px solid #c7d2fe;background:#f8fafc;color:#475569}pre{background:#0f172a;color:#e2e8f0;border:1px solid #1e293b;border-radius:6px;padding:14px 16px;overflow:auto}code{font-family:'JetBrains Mono','Consolas','SFMono-Regular',monospace;font-size:.92em}p code,li code{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:4px;color:#0f172a;padding:1px 4px}a{color:#0f66d0;text-decoration-thickness:1px;text-underline-offset:2px}table{width:100%;border-collapse:collapse;display:block;overflow-x:auto}th,td{border:1px solid #d8dee8;padding:8px 10px;vertical-align:top}th{background:#f6f8fb;color:#111827;font-weight:700}tr:nth-child(even) td{background:#fbfcfe}img{max-width:100%;height:auto}@media(max-width:720px){body{padding:26px 22px 56px;font-size:14px}h1{font-size:1.65rem}h2{font-size:1.28rem}}"#,
        body
    )
}

fn element_name(node: &NodeRef) -> Option<String> {
    match node.data() {
        NodeData::Element(element) => Some(element.name.local.to_string()),
        _ => None,
    }
}

fn normalize_markdown_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_inline_markdown(value: &str) -> String {
    normalize_markdown_text(value)
}

fn text_content(node: &NodeRef) -> String {
    match node.data() {
        NodeData::Text(text) => text.borrow().to_string(),
        _ => node
            .children()
            .map(|child| text_content(&child))
            .collect::<Vec<_>>()
            .join(""),
    }
}

fn serialize_node_html(node: &NodeRef) -> String {
    let mut bytes = Vec::new();
    if node.serialize(&mut bytes).is_err() {
        return String::new();
    }
    String::from_utf8(bytes).unwrap_or_default()
}

fn is_block_element(name: &str) -> bool {
    matches!(
        name,
        "address"
            | "article"
            | "aside"
            | "blockquote"
            | "div"
            | "dl"
            | "fieldset"
            | "figcaption"
            | "figure"
            | "footer"
            | "form"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "header"
            | "hr"
            | "li"
            | "main"
            | "nav"
            | "ol"
            | "p"
            | "pre"
            | "section"
            | "table"
            | "ul"
    )
}

fn inline_children_to_markdown(node: &NodeRef) -> String {
    node.children()
        .map(|child| inline_node_to_markdown(&child))
        .collect::<Vec<_>>()
        .join("")
}

fn inline_node_to_markdown(node: &NodeRef) -> String {
    match node.data() {
        NodeData::Text(text) => text.borrow().to_string(),
        NodeData::Element(element) => {
            let name = element.name.local.to_string();
            match name.as_str() {
                "strong" | "b" => {
                    let inner = inline_children_to_markdown(node);
                    if inner.is_empty() {
                        String::new()
                    } else {
                        format!("**{}**", inner.trim())
                    }
                }
                "em" | "i" => {
                    let inner = inline_children_to_markdown(node);
                    if inner.is_empty() {
                        String::new()
                    } else {
                        format!("*{}*", inner.trim())
                    }
                }
                "code" => {
                    let inner = text_content(node);
                    if inner.contains('`') {
                        format!("``{inner}``")
                    } else {
                        format!("`{inner}`")
                    }
                }
                "a" => {
                    let inner = inline_children_to_markdown(node);
                    let attrs = element.attributes.borrow();
                    if let Some(href) = attrs.get("href") {
                        if inner.is_empty() {
                            href.to_string()
                        } else {
                            format!("[{inner}]({href})")
                        }
                    } else {
                        inner
                    }
                }
                "br" => "  \n".to_string(),
                "img" => {
                    let attrs = element.attributes.borrow();
                    let alt = attrs.get("alt").unwrap_or("");
                    let src = attrs.get("src").unwrap_or("");
                    if src.is_empty() {
                        String::new()
                    } else {
                        format!("![{alt}]({src})")
                    }
                }
                "span" | "small" | "sub" | "sup" | "mark" => inline_children_to_markdown(node),
                _ if is_block_element(&name) => serialize_node_html(node),
                _ => inline_children_to_markdown(node),
            }
        }
        _ => String::new(),
    }
}

fn list_to_markdown(node: &NodeRef, ordered: bool) -> String {
    let mut lines = Vec::new();
    let mut index = 1;
    for child in node.children() {
        if element_name(&child).as_deref() != Some("li") {
            continue;
        }
        let item = normalize_inline_markdown(&inline_children_to_markdown(&child));
        let item = if item.trim().is_empty() {
            text_content(&child)
        } else {
            item
        };
        let marker = if ordered {
            let marker = format!("{index}.");
            index += 1;
            marker
        } else {
            "-".to_string()
        };
        lines.push(format!("{marker} {}", item.trim()));
    }
    lines.join("\n")
}

fn block_node_to_markdown(node: &NodeRef) -> Option<String> {
    match node.data() {
        NodeData::Text(text) => {
            let value = normalize_markdown_text(&text.borrow());
            if value.is_empty() {
                None
            } else {
                Some(value)
            }
        }
        NodeData::Element(element) => {
            let name = element.name.local.to_string();
            match name.as_str() {
                "script" | "style" => None,
                "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                    let level = name[1..].parse::<usize>().unwrap_or(1).clamp(1, 6);
                    let text = normalize_inline_markdown(&inline_children_to_markdown(node));
                    if text.trim().is_empty() {
                        None
                    } else {
                        Some(format!("{} {}", "#".repeat(level), text.trim()))
                    }
                }
                "p" => {
                    let text = normalize_inline_markdown(&inline_children_to_markdown(node));
                    if text.trim().is_empty() {
                        None
                    } else {
                        Some(text.trim().to_string())
                    }
                }
                "ul" => Some(list_to_markdown(node, false)).filter(|text| !text.trim().is_empty()),
                "ol" => Some(list_to_markdown(node, true)).filter(|text| !text.trim().is_empty()),
                "pre" => {
                    let code = text_content(node);
                    Some(format!("```\n{}\n```", code.trim_matches('\n')))
                }
                "blockquote" => {
                    let inner = node
                        .children()
                        .filter_map(|child| block_node_to_markdown(&child))
                        .collect::<Vec<_>>()
                        .join("\n\n");
                    if inner.trim().is_empty() {
                        None
                    } else {
                        Some(
                            inner
                                .lines()
                                .map(|line| format!("> {line}"))
                                .collect::<Vec<_>>()
                                .join("\n"),
                        )
                    }
                }
                "table" => {
                    let html = serialize_node_html(node);
                    if html.trim().is_empty() {
                        None
                    } else {
                        Some(html)
                    }
                }
                "div" | "section" | "article" | "main" | "body" => {
                    let blocks = node
                        .children()
                        .filter_map(|child| block_node_to_markdown(&child))
                        .collect::<Vec<_>>();
                    if blocks.is_empty() {
                        let text = normalize_inline_markdown(&inline_children_to_markdown(node));
                        if text.trim().is_empty() {
                            None
                        } else {
                            Some(text.trim().to_string())
                        }
                    } else {
                        Some(blocks.join("\n\n"))
                    }
                }
                "br" => Some(String::new()),
                _ if is_block_element(&name) => {
                    let html = serialize_node_html(node);
                    if html.trim().is_empty() {
                        None
                    } else {
                        Some(html)
                    }
                }
                _ => {
                    let text = normalize_inline_markdown(&inline_children_to_markdown(node));
                    if text.trim().is_empty() {
                        None
                    } else {
                        Some(text.trim().to_string())
                    }
                }
            }
        }
        _ => None,
    }
}

fn html_fragment_to_markdown(fragment: &str) -> String {
    let document = kuchikiki::parse_html()
        .one(format!(
            "<!doctype html><html><body>{fragment}</body></html>"
        ))
        .document_node;
    let body = document
        .select_first("body")
        .ok()
        .map(|node| node.as_node().clone())
        .unwrap_or(document);
    let markdown = body
        .children()
        .filter_map(|child| block_node_to_markdown(&child))
        .collect::<Vec<_>>()
        .join("\n\n");
    let trimmed = markdown.trim();
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("{trimmed}\n")
    }
}

#[tauri::command]
pub fn preview_artifact_for_session(session_id: String) -> Result<String, String> {
    let session_dir = sidetab_session_dir(&session_id)?;
    let html_path = session_dir.join("out.html");
    if html_path.is_file() {
        return Ok(html_path.to_string_lossy().to_string());
    }

    let markdown_path = session_dir.join("out.md");
    if !markdown_path.is_file() {
        return Err("No preview artifact found for this session".to_string());
    }
    preview_path_for_artifact(&session_id, &markdown_path, false)
}

#[tauri::command]
pub fn preview_artifact_uri_for_session(session_id: String, uri: String) -> Result<String, String> {
    let path = artifact_path_from_uri(&uri)?;
    preview_path_for_artifact(&session_id, &path, true)
}

#[tauri::command]
pub fn preview_artifact_uri_for_session_v2(
    session_id: String,
    uri: String,
) -> Result<PreviewArtifactInfo, String> {
    let path = artifact_path_from_uri(&uri)?;
    preview_info_for_artifact(&session_id, &path, true)
}

#[tauri::command]
pub fn read_editable_artifact(source_path: String) -> Result<EditableArtifactSource, String> {
    let (path, source_kind) = validate_editable_artifact_path(&source_path)?;
    let content = match source_kind.as_str() {
        "markdown" => {
            let raw = std::fs::read_to_string(&path)
                .map_err(|error| format!("Failed to read editable artifact: {error}"))?;
            markdown_to_static_html(&raw)
        }
        "html" => std::fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read editable artifact: {error}"))?,
        "office" => docx_to_html(&path)?,
        _ => return Err("Unsupported editable artifact source kind".to_string()),
    };
    Ok(EditableArtifactSource {
        source_path: path.to_string_lossy().to_string(),
        source_kind,
        content,
    })
}

fn backup_path_for(path: &Path) -> Result<PathBuf, String> {
    let file_name = path
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .ok_or_else(|| "Editable artifact file name is invalid".to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "Editable artifact parent directory not found".to_string())?;
    let timestamp = Local::now().format("%Y%m%d-%H%M%S");
    let candidate = parent.join(format!("{file_name}.bak-{timestamp}"));
    if !candidate.exists() {
        return Ok(candidate);
    }
    for index in 2..100 {
        let candidate = parent.join(format!("{file_name}.bak-{timestamp}-{index}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Failed to allocate backup path".to_string())
}

fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Editable artifact parent directory not found".to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Failed to create temporary save file: {error}"))?;
    temp.write_all(contents)
        .map_err(|error| format!("Failed to write temporary save file: {error}"))?;
    temp.flush()
        .map_err(|error| format!("Failed to flush temporary save file: {error}"))?;
    temp.as_file()
        .sync_all()
        .map_err(|error| format!("Failed to sync temporary save file: {error}"))?;
    temp.persist(path)
        .map(|_| ())
        .map_err(|error| format!("Failed to replace editable artifact: {}", error.error))
}

fn write_docx_document_xml_atomic(path: &Path, document_xml: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Editable artifact parent directory not found".to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Failed to create temporary Word file: {error}"))?;
    let replaced = {
        let source =
            File::open(path).map_err(|error| format!("Failed to open Word document: {error}"))?;
        let mut archive = ZipArchive::new(source)
            .map_err(|error| format!("Failed to read Word document: {error}"))?;
        let mut replaced = false;
        let mut writer = ZipWriter::new(temp.as_file_mut());
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|error| format!("Failed to inspect Word archive: {error}"))?;
            let name = entry.name().to_string();
            let options = entry.options();
            if entry.is_dir() {
                writer
                    .add_directory(name, options)
                    .map_err(|error| format!("Failed to write Word directory entry: {error}"))?;
                continue;
            }
            writer
                .start_file(&name, options)
                .map_err(|error| format!("Failed to write Word file entry: {error}"))?;
            if name == "word/document.xml" {
                writer
                    .write_all(document_xml.as_bytes())
                    .map_err(|error| format!("Failed to write Word document body: {error}"))?;
                replaced = true;
            } else {
                std::io::copy(&mut entry, &mut writer)
                    .map_err(|error| format!("Failed to copy Word archive entry: {error}"))?;
            }
        }
        writer
            .finish()
            .map_err(|error| format!("Failed to finish Word archive: {error}"))?;
        replaced
    };
    if !replaced {
        return Err("Word document body entry not found".to_string());
    }
    temp.flush()
        .map_err(|error| format!("Failed to flush temporary Word file: {error}"))?;
    temp.as_file()
        .sync_all()
        .map_err(|error| format!("Failed to sync temporary Word file: {error}"))?;
    temp.persist(path)
        .map(|_| ())
        .map_err(|error| format!("Failed to replace Word document: {}", error.error))
}

fn preview_path_after_save(
    path: &Path,
    source_kind: &str,
    markdown: Option<&str>,
) -> Result<String, String> {
    if source_kind == "html" {
        return Ok(path.to_string_lossy().to_string());
    }
    if source_kind == "office" {
        let preview_path = path.with_extension("office.preview.html");
        std::fs::write(&preview_path, office_to_static_html(path))
            .map_err(|error| format!("Failed to refresh Word preview: {error}"))?;
        return Ok(preview_path.to_string_lossy().to_string());
    }
    let markdown = markdown.ok_or_else(|| "Markdown preview content missing".to_string())?;
    let preview_path = path.with_extension("preview.html");
    std::fs::write(&preview_path, markdown_to_static_html(markdown))
        .map_err(|error| format!("Failed to refresh markdown preview: {error}"))?;
    Ok(preview_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn save_editable_artifact(
    source_path: String,
    source_kind: String,
    content: String,
) -> Result<SaveEditableArtifactResult, String> {
    let (path, actual_kind) = validate_editable_artifact_path(&source_path)?;
    if source_kind != actual_kind {
        return Err("Editable artifact source kind does not match file extension".to_string());
    }

    let original = std::fs::read(&path)
        .map_err(|error| format!("Failed to read original artifact before save: {error}"))?;
    let backup_path = backup_path_for(&path)?;
    std::fs::write(&backup_path, original)
        .map_err(|error| format!("Failed to create artifact backup: {error}"))?;

    let mut markdown_preview: Option<String> = None;
    if actual_kind == "office" {
        let original_xml = read_zip_text_entry(&path, "word/document.xml")?;
        let next_xml = html_fragment_to_docx_document_xml(&content, &original_xml);
        write_docx_document_xml_atomic(&path, &next_xml)?;
    } else {
        let next_content = if actual_kind == "markdown" {
            let markdown = html_fragment_to_markdown(&content);
            markdown_preview = Some(markdown.clone());
            markdown
        } else {
            content
        };
        write_atomic(&path, next_content.as_bytes())?;
    }
    let preview_path = preview_path_after_save(&path, &actual_kind, markdown_preview.as_deref())?;

    Ok(SaveEditableArtifactResult {
        source_path: path.to_string_lossy().to_string(),
        backup_path: backup_path.to_string_lossy().to_string(),
        preview_path,
    })
}

#[tauri::command]
pub fn get_all_cwds(state: State<'_, AppState>) -> Result<HashMap<String, String>, String> {
    let mut cwds = HashMap::new();
    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    for (session_id, pid_opt) in state.session_manager.iter_pids() {
        if let Some(pid) = pid_opt {
            let sys_pid = sysinfo::Pid::from_u32(pid);
            // We want the foreground process CWD. If bash is the child, we find its children.
            // For simplicity, we just take the deepest child process's CWD or the shell's CWD.
            // Let's find any child of this PID, or use the PID itself.
            let mut target_pid = sys_pid;

            // Find a child process (like nvim, node, etc)
            for (p, proc) in sys.processes() {
                if let Some(parent) = proc.parent() {
                    if parent == sys_pid {
                        target_pid = *p;
                        break;
                    }
                }
            }

            if let Some(proc) = sys.process(target_pid) {
                if let Some(cwd) = proc.cwd() {
                    cwds.insert(session_id, cwd.to_string_lossy().to_string());
                }
            }
        }
    }

    Ok(cwds)
}

#[derive(serde::Serialize)]
pub struct DefaultShellInfo {
    pub command: String,
    pub args: Vec<String>,
}

#[tauri::command]
pub fn get_default_shell() -> DefaultShellInfo {
    #[cfg(target_os = "windows")]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            if std::path::Path::new(&shell).exists() {
                let lower = shell.to_ascii_lowercase();
                let args = if lower.ends_with("bash.exe") {
                    vec!["-i".to_string()]
                } else {
                    vec![]
                };
                return DefaultShellInfo {
                    command: shell,
                    args,
                };
            }
        }
        // Git Bash
        let git_bash = "C:\\Program Files\\Git\\bin\\bash.exe";
        if std::path::Path::new(git_bash).exists() {
            return DefaultShellInfo {
                command: git_bash.to_string(),
                args: vec!["-i".to_string()],
            };
        }
        // PowerShell
        let pwsh = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
        if std::path::Path::new(pwsh).exists() {
            return DefaultShellInfo {
                command: pwsh.to_string(),
                args: vec![],
            };
        }
        // cmd.exe fallback
        DefaultShellInfo {
            command: std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string()),
            args: vec![],
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            if std::path::Path::new(&shell).exists() {
                return DefaultShellInfo {
                    command: shell,
                    args: vec![],
                };
            }
        }

        DefaultShellInfo {
            command: "/bin/bash".to_string(),
            args: vec![],
        }
    }
}

/// Read pane-session mapping files written by launcher.sh
/// Returns a map of pane_session_id → claude_session_id
#[tauri::command]
pub fn read_pane_session_mappings() -> HashMap<String, String> {
    let mut result = HashMap::new();
    if let Some(home) = dirs::home_dir() {
        let map_dir = home.join(".mycmux-lite").join("pane-sessions");
        if let Ok(entries) = std::fs::read_dir(&map_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("txt") {
                    if let Some(pane_id) = path.file_stem().and_then(|s| s.to_str()) {
                        if let Ok(session_id) = std::fs::read_to_string(&path) {
                            let sid = parse_agent_session_mapping(&session_id)
                                .map(|mapping| mapping.session_id)
                                .unwrap_or_else(|| session_id.trim().to_string());
                            if !sid.is_empty() {
                                result.insert(pane_id.to_string(), sid);
                            }
                        }
                    }
                }
            }
        }
    }
    result
}

#[derive(Clone, serde::Serialize)]
pub struct AgentSessionMapping {
    pub agent_kind: Option<String>,
    pub session_id: String,
}

fn is_agent_session_kind(value: &str) -> bool {
    matches!(value, "claude" | "codex" | "claude-codex")
}

fn parse_agent_session_mapping(contents: &str) -> Option<AgentSessionMapping> {
    let trimmed = contents.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some((kind, session_id)) = trimmed.split_once(':') {
        let kind = kind.trim();
        let session_id = session_id.trim();
        if is_agent_session_kind(kind) && !session_id.is_empty() {
            return Some(AgentSessionMapping {
                agent_kind: Some(kind.to_string()),
                session_id: session_id.to_string(),
            });
        }
    }

    Some(AgentSessionMapping {
        agent_kind: None,
        session_id: trimmed.to_string(),
    })
}

#[tauri::command]
pub fn read_agent_session_mappings() -> HashMap<String, AgentSessionMapping> {
    let mut result = HashMap::new();
    if let Some(home) = dirs::home_dir() {
        let map_dir = home.join(".mycmux-lite").join("pane-sessions");
        if let Ok(entries) = std::fs::read_dir(&map_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("txt") {
                    if let Some(pane_id) = path.file_stem().and_then(|s| s.to_str()) {
                        if let Ok(contents) = std::fs::read_to_string(&path) {
                            if let Some(mapping) = parse_agent_session_mapping(&contents) {
                                result.insert(pane_id.to_string(), mapping);
                            }
                        }
                    }
                }
            }
        }
    }
    result
}

#[tauri::command]
pub fn get_claude_session_id(cwd: String) -> Option<String> {
    let home = dirs::home_dir()?;
    let project_dir = home
        .join(".claude")
        .join("projects")
        .join(claude_project_key(&cwd));
    if !project_dir.exists() {
        return None;
    }

    let mut best: Option<(String, std::time::SystemTime)> = None;
    if let Ok(entries) = std::fs::read_dir(&project_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                if let Ok(meta) = entry.metadata() {
                    if let Ok(mtime) = meta.modified() {
                        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                            if best.is_none() || mtime > best.as_ref().unwrap().1 {
                                best = Some((stem.to_string(), mtime));
                            }
                        }
                    }
                }
            }
        }
    }
    best.map(|(id, _)| id)
}

#[tauri::command]
pub fn is_directory(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

#[tauri::command]
pub fn get_launch_cwd() -> Option<String> {
    for arg in std::env::args().skip(1) {
        if arg.starts_with('-') {
            continue;
        }
        let path = std::path::Path::new(&arg);
        if path.is_dir() {
            if let Ok(canonical) = path.canonicalize() {
                let s = canonical.to_string_lossy().to_string();
                // Strip Windows UNC prefix (\\?\)
                return Some(s.strip_prefix(r"\\?\").unwrap_or(&s).to_string());
            }
            return Some(arg);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;
    use zip::CompressionMethod;

    fn write_test_docx(path: &Path, document_xml: &str) {
        let file = File::create(path).unwrap();
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        let mut writer = ZipWriter::new(file);
        writer.start_file("[Content_Types].xml", options).unwrap();
        writer
            .write_all(
                br#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#,
            )
            .unwrap();
        writer.start_file("word/document.xml", options).unwrap();
        writer.write_all(document_xml.as_bytes()).unwrap();
        writer.finish().unwrap();
    }

    #[test]
    fn artifact_preview_allows_only_session_files() {
        let dir = tempfile::tempdir().unwrap();
        let session_dir = dir.path().join("session-1");
        let artifacts_dir = session_dir.join("artifacts");
        std::fs::create_dir_all(&artifacts_dir).unwrap();
        let html_path = session_dir.join("out.html");
        let markdown_path = artifacts_dir.join("report.md");
        let office_path = artifacts_dir.join("report.docx");
        let outside_path = dir.path().join("outside.html");
        std::fs::write(&html_path, "<h1>ok</h1>").unwrap();
        std::fs::write(&markdown_path, "# ok").unwrap();
        std::fs::write(&office_path, "office").unwrap();
        std::fs::write(&outside_path, "<h1>bad</h1>").unwrap();

        assert!(is_allowed_artifact_path(&session_dir, &html_path));
        assert!(is_allowed_artifact_path(&session_dir, &markdown_path));
        assert!(is_allowed_artifact_path(&session_dir, &office_path));
        assert!(!is_allowed_artifact_path(&session_dir, &outside_path));
        assert!(is_previewable_artifact(&markdown_path));
        assert!(is_previewable_artifact(&office_path));
        assert!(!is_previewable_artifact(&artifacts_dir.join("secret.txt")));
    }

    #[test]
    fn external_preview_allows_absolute_html_md_and_office_only() {
        let dir = tempfile::tempdir().unwrap();
        let html_path = dir.path().join("report.html");
        let markdown_path = dir.path().join("report.md");
        let word_path = dir.path().join("report.docx");
        let excel_path = dir.path().join("budget.xlsx");
        let powerpoint_path = dir.path().join("deck.pptx");
        let text_path = dir.path().join("secret.txt");
        std::fs::write(&html_path, "<h1>ok</h1>").unwrap();
        std::fs::write(&markdown_path, "# ok").unwrap();
        std::fs::write(&word_path, "word").unwrap();
        std::fs::write(&excel_path, "excel").unwrap();
        std::fs::write(&powerpoint_path, "powerpoint").unwrap();
        std::fs::write(&text_path, "secret").unwrap();

        assert!(is_allowed_external_artifact_path(&html_path));
        assert!(is_allowed_external_artifact_path(&markdown_path));
        assert!(is_allowed_external_artifact_path(&word_path));
        assert!(is_previewable_artifact(&html_path));
        assert!(is_previewable_artifact(&markdown_path));
        assert!(is_previewable_artifact(&word_path));
        assert!(is_previewable_artifact(&excel_path));
        assert!(is_previewable_artifact(&powerpoint_path));
        assert!(!is_previewable_artifact(&text_path));
        assert!(!is_allowed_external_artifact_path(Path::new(
            "relative.html"
        )));
    }

    #[test]
    fn external_markdown_preview_writes_under_session_previews() {
        let dir = tempfile::tempdir().unwrap();
        let session_dir = dir.path().join("session-1");
        let outside_markdown = dir.path().join("outside report.md");
        std::fs::write(&outside_markdown, "# ok").unwrap();

        let preview_path = external_markdown_preview_path(&session_dir, &outside_markdown).unwrap();
        assert!(preview_path.starts_with(session_dir.join("artifacts").join("previews")));
        assert_eq!(
            preview_path
                .extension()
                .and_then(|extension| extension.to_str()),
            Some("html")
        );
    }

    #[test]
    fn external_office_preview_writes_under_session_previews() {
        let dir = tempfile::tempdir().unwrap();
        let session_dir = dir.path().join("session-1");
        let outside_doc = dir.path().join("outside report.docx");
        std::fs::write(&outside_doc, "office").unwrap();

        let preview_path = external_office_preview_path(&session_dir, &outside_doc).unwrap();
        assert!(preview_path.starts_with(session_dir.join("artifacts").join("previews")));
        assert_eq!(
            preview_path
                .extension()
                .and_then(|extension| extension.to_str()),
            Some("html")
        );
        assert!(preview_path
            .file_name()
            .and_then(|file_name| file_name.to_str())
            .unwrap()
            .contains(".office.preview.html"));
    }

    #[test]
    fn office_preview_html_escapes_path_and_labels_kind() {
        let path = Path::new(r"C:\Users\miyaz\budget & plan.xlsx");
        let html = office_to_static_html(path);

        assert!(html.contains(">Excel<"));
        assert!(html.contains("budget &amp; plan.xlsx"));
        assert!(html.contains("C:\\Users\\miyaz\\budget &amp; plan.xlsx"));
        assert!(!html.contains("<script"));
    }

    #[test]
    fn docx_xml_preview_renders_paragraphs_and_tables() {
        let html = docx_xml_to_html(
            r#"<w:document xmlns:w="w"><w:body>
                <w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t> world</w:t></w:r></w:p>
                <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
            </w:body></w:document>"#,
        );

        assert!(html.contains("<p>Hello world</p>"));
        assert!(html.contains("<table><tbody>"));
        assert!(html.contains("<td>A1</td>"));
        assert!(html.contains("<td>B1</td>"));
    }

    #[test]
    fn xlsx_xml_preview_resolves_shared_strings() {
        let shared = xlsx_shared_strings_xml_to_vec(
            r#"<sst><si><t>Name</t></si><si><t>Value</t></si></sst>"#,
        );
        let html = xlsx_sheet_xml_to_html(
            r#"<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c><c><v>42</v></c></row></sheetData></worksheet>"#,
            &shared,
        );

        assert!(html.contains("<td>Name</td>"));
        assert!(html.contains("<td>Value</td>"));
        assert!(html.contains("<td>42</td>"));
    }

    #[test]
    fn pptx_xml_preview_collects_slide_text() {
        let paragraphs = pptx_slide_xml_to_paragraphs(
            r#"<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree>
                <a:p><a:r><a:t>Title</a:t></a:r></a:p>
                <a:p><a:r><a:t>Body</a:t></a:r></a:p>
            </p:spTree></p:cSld></p:sld>"#,
        );

        assert_eq!(paragraphs, vec!["Title".to_string(), "Body".to_string()]);
    }

    #[test]
    fn markdown_preview_escapes_raw_html_and_unsafe_links() {
        let html = markdown_to_static_html(
            "# レポート\n\n<script>alert(1)</script>\n\n- [safe](https://example.com)\n- [bad](file:///C:/Users/miyaz/.ssh/id_rsa)\n\n```\n<div>code</div>\n```",
        );
        assert!(html.contains("<h1>レポート</h1>"));
        assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        assert!(html.contains("<a href=\"https://example.com\""));
        assert!(html.contains("[bad](file:///C:/Users/miyaz/.ssh/id_rsa)"));
        assert!(html.contains("&lt;div&gt;code&lt;/div&gt;"));
        assert!(!html.contains("<script>"));
        assert!(!html.contains("href=\"file://"));
    }

    #[test]
    fn preview_info_for_html_artifact_returns_source_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let html_path = dir.path().join("report.html");
        std::fs::write(&html_path, "<h1>ok</h1>").unwrap();

        let info = preview_info_for_artifact("session-1", &html_path, true).unwrap();

        assert_eq!(info.source_kind, "html");
        assert_eq!(
            normalize_preview_path(Path::new(&info.source_path)),
            normalize_preview_path(&html_path)
        );
        assert_eq!(
            normalize_preview_path(Path::new(&info.preview_path)),
            normalize_preview_path(&html_path)
        );
    }

    #[test]
    fn save_editable_artifact_creates_backup_before_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let html_path = dir.path().join("report.html");
        std::fs::write(&html_path, "<h1>old</h1>").unwrap();

        let result = save_editable_artifact(
            html_path.to_string_lossy().to_string(),
            "html".to_string(),
            "<!doctype html><html><body><h1>new</h1></body></html>".to_string(),
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(&html_path).unwrap(),
            "<!doctype html><html><body><h1>new</h1></body></html>"
        );
        assert!(Path::new(&result.backup_path).is_file());
        assert_eq!(
            std::fs::read_to_string(&result.backup_path).unwrap(),
            "<h1>old</h1>"
        );
        assert!(result.backup_path.contains("report.html.bak-"));
    }

    #[test]
    fn save_editable_artifact_rejects_invalid_targets() {
        let dir = tempfile::tempdir().unwrap();
        let text_path = dir.path().join("secret.txt");
        let markdown_path = dir.path().join("report.md");
        let office_path = dir.path().join("report.xlsx");
        std::fs::write(&text_path, "secret").unwrap();
        std::fs::write(&markdown_path, "# ok").unwrap();
        std::fs::write(&office_path, "office").unwrap();

        assert!(save_editable_artifact(
            "relative.html".to_string(),
            "html".to_string(),
            "x".to_string()
        )
        .is_err());
        assert!(save_editable_artifact(
            dir.path()
                .join("missing.html")
                .to_string_lossy()
                .to_string(),
            "html".to_string(),
            "x".to_string()
        )
        .is_err());
        assert!(save_editable_artifact(
            text_path.to_string_lossy().to_string(),
            "html".to_string(),
            "x".to_string()
        )
        .is_err());
        assert!(save_editable_artifact(
            dir.path().to_string_lossy().to_string(),
            "html".to_string(),
            "x".to_string()
        )
        .is_err());
        assert!(save_editable_artifact(
            markdown_path.to_string_lossy().to_string(),
            "html".to_string(),
            "x".to_string()
        )
        .is_err());
        assert!(save_editable_artifact(
            office_path.to_string_lossy().to_string(),
            "office".to_string(),
            "x".to_string()
        )
        .is_err());
    }

    #[test]
    fn save_docx_serializes_body_and_creates_backup() {
        let dir = tempfile::tempdir().unwrap();
        let docx_path = dir.path().join("report.docx");
        write_test_docx(
            &docx_path,
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Old</w:t></w:r></w:p><w:sectPr/></w:body></w:document>"#,
        );

        let result = save_editable_artifact(
            docx_path.to_string_lossy().to_string(),
            "office".to_string(),
            r#"<h1>Title</h1><p>Hello <strong>bold</strong> <em>italic</em></p><table><tbody><tr><td>A</td><td>B</td></tr></tbody></table>"#.to_string(),
        )
        .unwrap();

        assert!(Path::new(&result.backup_path).is_file());
        assert!(Path::new(&result.preview_path).is_file());
        let saved_xml = read_zip_text_entry(&docx_path, "word/document.xml").unwrap();
        assert!(saved_xml.contains("Heading1"));
        assert!(saved_xml.contains("Hello "));
        assert!(saved_xml.contains("<w:b/>"));
        assert!(saved_xml.contains("<w:i/>"));
        assert!(saved_xml.contains("<w:tbl>"));
        assert!(saved_xml.contains(">A<"));
        let preview_html = docx_to_html(&docx_path).unwrap();
        assert!(preview_html.contains("<td>A</td>"));
        assert!(preview_html.contains("<td>B</td>"));
    }

    #[test]
    fn markdown_dom_serializer_preserves_common_blocks_and_table_html() {
        let markdown = html_fragment_to_markdown(
            r#"
            <h2>Summary</h2>
            <p>Hello <strong>bold</strong> <em>italic</em> <a href="https://example.com">link</a></p>
            <ul><li>First</li><li>Second</li></ul>
            <ol><li>One</li><li>Two</li></ol>
            <pre><code>let x = 1;</code></pre>
            <table><tbody><tr><td>A</td><td>B</td></tr></tbody></table>
            "#,
        );

        assert!(markdown.contains("## Summary"));
        assert!(markdown.contains("Hello **bold** *italic* [link](https://example.com)"));
        assert!(markdown.contains("- First\n- Second"));
        assert!(markdown.contains("1. One\n2. Two"));
        assert!(markdown.contains("```\nlet x = 1;\n```"));
        assert!(markdown.contains("<table>"));
        assert!(markdown.contains("<td>A</td>"));
    }

    #[test]
    fn save_markdown_serializes_dom_and_keeps_table_as_html() {
        let dir = tempfile::tempdir().unwrap();
        let markdown_path = dir.path().join("report.md");
        std::fs::write(&markdown_path, "# old").unwrap();

        let result = save_editable_artifact(
            markdown_path.to_string_lossy().to_string(),
            "markdown".to_string(),
            "<h1>New</h1><p>See <a href=\"https://example.com\">link</a></p><table><tbody><tr><td>A</td></tr></tbody></table>".to_string(),
        )
        .unwrap();
        let saved = std::fs::read_to_string(&markdown_path).unwrap();

        assert!(saved.contains("# New"));
        assert!(saved.contains("[link](https://example.com)"));
        assert!(saved.contains("<table>"));
        assert!(Path::new(&result.backup_path).is_file());
        assert!(Path::new(&result.preview_path).is_file());
    }

    #[test]
    fn safe_session_id_rejects_path_segments() {
        assert!(is_safe_session_id("pane-123"));
        assert!(!is_safe_session_id("../secret"));
        assert!(!is_safe_session_id("pane/secret"));
        assert!(!is_safe_session_id("pane\\secret"));
        assert!(!is_safe_session_id("."));
        assert!(!is_safe_session_id(""));
    }

    #[test]
    fn file_uri_decode_preserves_utf8_names() {
        assert_eq!(
            decode_file_uri("C:/Users/miyaz/%E3%83%AC%E3%83%9D%E3%83%BC%E3%83%88.md"),
            "C:/Users/miyaz/レポート.md"
        );
        assert_eq!(
            decode_file_uri("C:/Users/miyaz/レポート.md"),
            "C:/Users/miyaz/レポート.md"
        );
    }

    #[test]
    fn artifact_path_from_raw_windows_path_trims_cli_decoration() {
        let path = artifact_path_from_uri(r"C:\Users\miyaz\report.html＋＋＋").unwrap();
        assert_eq!(
            path.file_name().and_then(|file_name| file_name.to_str()),
            Some("report.html")
        );
    }

    #[test]
    fn artifact_path_from_uri_repairs_soft_wrap_padding_before_separator() {
        let dir = tempfile::tempdir().unwrap();
        let nested_dir = dir.path().join("folder");
        std::fs::create_dir_all(&nested_dir).unwrap();
        let html_path = nested_dir.join("report.html");
        std::fs::write(&html_path, "<h1>ok</h1>").unwrap();

        let uri = html_path
            .to_string_lossy()
            .replace('\\', "/")
            .replace("/report.html", "   /report.html");
        let path = artifact_path_from_uri(&uri).unwrap();

        assert_eq!(
            normalize_preview_path(&path),
            normalize_preview_path(&html_path)
        );
    }

    #[test]
    fn artifact_path_from_uri_collapses_soft_wrap_padding_between_words() {
        let dir = tempfile::tempdir().unwrap();
        let spaced_dir = dir.path().join("company Dropbox");
        std::fs::create_dir_all(&spaced_dir).unwrap();
        let html_path = spaced_dir.join("report.html");
        std::fs::write(&html_path, "<h1>ok</h1>").unwrap();

        let uri = html_path
            .to_string_lossy()
            .replace('\\', "/")
            .replace("company Dropbox", "company   Dropbox");
        let path = artifact_path_from_uri(&uri).unwrap();

        assert_eq!(
            normalize_preview_path(&path),
            normalize_preview_path(&html_path)
        );
    }

    #[test]
    fn artifact_path_from_uri_repairs_missing_space_at_wrap_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let spaced_dir = dir.path().join("company Dropbox");
        std::fs::create_dir_all(&spaced_dir).unwrap();
        let html_path = spaced_dir.join("report.html");
        std::fs::write(&html_path, "<h1>ok</h1>").unwrap();

        let uri = html_path
            .to_string_lossy()
            .replace('\\', "/")
            .replace("company Dropbox", "companyDropbox");
        let path = artifact_path_from_uri(&uri).unwrap();

        assert_eq!(
            normalize_preview_path(&path),
            normalize_preview_path(&html_path)
        );
    }

    #[test]
    fn parse_agent_session_mapping_with_kind() {
        let mapping = parse_agent_session_mapping("claude:abc-123\n").unwrap();
        assert_eq!(mapping.agent_kind.as_deref(), Some("claude"));
        assert_eq!(mapping.session_id, "abc-123");
    }

    #[test]
    fn parse_agent_session_mapping_without_kind() {
        let mapping = parse_agent_session_mapping("abc-123\n").unwrap();
        assert_eq!(mapping.agent_kind, None);
        assert_eq!(mapping.session_id, "abc-123");
    }

    #[test]
    fn codex_session_file_requires_matching_id_and_cwd() {
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

        assert!(codex_session_file_matches(
            &path,
            session_id,
            &normalize_cwd_key(r"C:\Users\miyaz")
        ));
        assert!(!codex_session_file_matches(
            &path,
            "019bc371-82cf-7d82-ad0b-96d026aaca74",
            &normalize_cwd_key(r"C:\Users\miyaz")
        ));
        assert!(!codex_session_file_matches(
            &path,
            session_id,
            &normalize_cwd_key(r"C:\Users\other")
        ));
    }

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn sanitize_drops_pane_internal_keys_when_no_resume_context() {
        let mut e = env(&[
            ("MYCMUX_PANE_SESSION_ID", "pane-1"),
            ("MYCMUX_TAB_ID", "tab-1"),
            ("MYCMUX_MARKDOWN_OUT", "C:/tmp/out.md"),
            ("MYCMUX_ARTIFACTS_DIR", "C:/tmp/artifacts"),
            ("__CMUX_LAUNCHER_DONE", "1"),
            ("FOO", "bar"),
        ]);
        sanitize_launch_env(&mut e);
        assert!(!e.contains_key("MYCMUX_PANE_SESSION_ID"));
        assert!(!e.contains_key("MYCMUX_TAB_ID"));
        assert!(!e.contains_key("MYCMUX_MARKDOWN_OUT"));
        assert!(!e.contains_key("MYCMUX_ARTIFACTS_DIR"));
        assert!(!e.contains_key("__CMUX_LAUNCHER_DONE"));
        assert_eq!(e.get("FOO"), Some(&"bar".to_string()));
    }

    #[test]
    fn sanitize_strips_stray_resume_marker_without_session_id() {
        // Bug class: MYCMUX_RESUME=1 leaks from a parent shell with no SESSION_ID.
        // Must not reach the child or the agent will auto-resume.
        let mut e = env(&[("MYCMUX_RESUME", "claude"), ("FOO", "bar")]);
        sanitize_launch_env(&mut e);
        assert!(!e.contains_key("MYCMUX_RESUME"));
        assert_eq!(e.get("FOO"), Some(&"bar".to_string()));
    }

    #[test]
    fn sanitize_strips_stray_session_id_without_kind() {
        let mut e = env(&[("MYCMUX_SESSION_ID", "abc-123")]);
        sanitize_launch_env(&mut e);
        assert!(!e.contains_key("MYCMUX_SESSION_ID"));
    }

    #[test]
    fn sanitize_keeps_legitimate_resume_payload() {
        let mut e = env(&[
            ("MYCMUX_RESUME", "claude"),
            ("MYCMUX_SESSION_ID", "abc-123"),
            ("MYCMUX_AGENT_KIND", "claude"),
            ("MYCMUX_PANE_SESSION_ID", "should-be-stripped"),
            ("__CMUX_LAUNCHER_DONE", "1"),
            ("HOME", "/home/u"),
        ]);
        sanitize_launch_env(&mut e);
        assert_eq!(e.get("MYCMUX_RESUME").map(String::as_str), Some("claude"));
        assert_eq!(
            e.get("MYCMUX_SESSION_ID").map(String::as_str),
            Some("abc-123")
        );
        assert_eq!(
            e.get("MYCMUX_AGENT_KIND").map(String::as_str),
            Some("claude")
        );
        assert!(!e.contains_key("MYCMUX_PANE_SESSION_ID"));
        assert!(!e.contains_key("__CMUX_LAUNCHER_DONE"));
        assert_eq!(e.get("HOME").map(String::as_str), Some("/home/u"));
    }

    #[test]
    fn sanitize_keeps_legitimate_handoff_payload() {
        let mut e = env(&[
            ("MYCMUX_HANDOFF", "codex"),
            ("MYCMUX_HANDOFF_FROM", "claude"),
            ("MYCMUX_HANDOFF_PROMPT_FILE", "/tmp/p.md"),
            ("MYCMUX_HANDOFF_FROM_SESSION", "src-sess"),
            ("MYCMUX_TAB_ID", "should-be-stripped"),
        ]);
        sanitize_launch_env(&mut e);
        assert_eq!(e.get("MYCMUX_HANDOFF").map(String::as_str), Some("codex"));
        assert_eq!(
            e.get("MYCMUX_HANDOFF_FROM_SESSION").map(String::as_str),
            Some("src-sess")
        );
        assert!(!e.contains_key("MYCMUX_TAB_ID"));
    }

    #[test]
    fn sanitize_drops_partial_handoff_without_from_session() {
        // Incomplete handoff payload — likely env leak — must be stripped wholesale.
        let mut e = env(&[
            ("MYCMUX_HANDOFF", "codex"),
            ("MYCMUX_HANDOFF_PROMPT_FILE", "/tmp/p.md"),
        ]);
        sanitize_launch_env(&mut e);
        assert!(!e.contains_key("MYCMUX_HANDOFF"));
        assert!(!e.contains_key("MYCMUX_HANDOFF_PROMPT_FILE"));
    }

    #[test]
    fn sanitize_rejects_unknown_agent_kind() {
        // Spoofing attempt: MYCMUX_RESUME=evil with a SESSION_ID. is_agent_session_kind
        // should reject "evil" and the whole resume trio must be stripped.
        let mut e = env(&[("MYCMUX_RESUME", "evil"), ("MYCMUX_SESSION_ID", "abc-123")]);
        sanitize_launch_env(&mut e);
        assert!(!e.contains_key("MYCMUX_RESUME"));
        assert!(!e.contains_key("MYCMUX_SESSION_ID"));
    }
}
