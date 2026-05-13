use std::collections::HashMap;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use sysinfo::System;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

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
    ];
    const RESUME_TRIO: &[&str] = &[
        "MYCMUX_RESUME",
        "MYCMUX_SESSION_ID",
        "MYCMUX_AGENT_KIND",
    ];
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
            ("__CMUX_LAUNCHER_DONE", "1"),
            ("FOO", "bar"),
        ]);
        sanitize_launch_env(&mut e);
        assert!(!e.contains_key("MYCMUX_PANE_SESSION_ID"));
        assert!(!e.contains_key("MYCMUX_TAB_ID"));
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
        let mut e = env(&[
            ("MYCMUX_RESUME", "evil"),
            ("MYCMUX_SESSION_ID", "abc-123"),
        ]);
        sanitize_launch_env(&mut e);
        assert!(!e.contains_key("MYCMUX_RESUME"));
        assert!(!e.contains_key("MYCMUX_SESSION_ID"));
    }
}
