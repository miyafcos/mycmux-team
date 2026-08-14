mod agent_restore;

use std::collections::HashMap;
use std::path::Path;
use tauri::ipc::{Channel, InvokeResponseBody, Response};
use tauri::{AppHandle, Emitter, State};

use crate::commands::session_mapping::{is_agent_session_kind, write_session_mapping_file};
use crate::pty::monitor::PtyMetadata;
use crate::util::ids::is_uuid_like;
use crate::AppState;

pub(crate) use agent_restore::can_restore_agent_session;
use agent_restore::{ensure_claude_project_trusted, validate_agent_restore_request};

#[derive(serde::Serialize)]
pub struct TerminalConfigPayload {
    pub font_family: String,
    pub font_size: f32,
    pub shell: String,
    pub background: String,
    pub foreground: String,
    pub ansi: Vec<String>,
    pub windows_build_number: Option<u32>,
}

fn rgb_hex(c: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

#[cfg(windows)]
fn windows_build_number() -> Option<u32> {
    sysinfo::System::kernel_version().and_then(|v| v.parse::<u32>().ok())
}

#[cfg(not(windows))]
fn windows_build_number() -> Option<u32> {
    None
}

#[tauri::command(async)]
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
        windows_build_number: windows_build_number(),
    }
}

#[tauri::command]
pub fn get_pty_metadata_snapshot(state: State<'_, AppState>) -> HashMap<String, PtyMetadata> {
    state
        .metadata_store
        .iter()
        .map(|entry| (entry.key().clone(), entry.value().clone()))
        .collect()
}

#[tauri::command(async)]
pub fn get_session_output_snapshot(state: State<'_, AppState>) -> HashMap<String, Option<u64>> {
    state.session_manager.last_output_snapshot()
}

// `(async)` runs this on a worker thread instead of the Tauri main (UI) thread.
// The body does heavy synchronous filesystem work (recursive ~/.codex scan,
// .claude.json rewrite, dir creation) that would otherwise freeze the UI every
// time a session is added.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn create_session(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    command: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    restore_fallback_session_ids: Option<Vec<String>>,
) -> Result<(), String> {
    let requested_command = command;
    let mut args = args;
    let mut env_map = env.unwrap_or_default();
    // A PTY that is still tracked for this session_id means create() below
    // will take the reattach branch (channel swap only, no spawn / resume).
    // Restore validation only matters for an actual spawn, so skip it here —
    // otherwise reattaches (e.g. every pane on an Allotment remount) would
    // re-run stale-id validation and re-emit "agent-restore-downgraded" for
    // sessions that were never being restored in the first place.
    let fallback_resume = if state.session_manager.is_alive(&session_id) {
        None
    } else {
        match validate_agent_restore_request(cwd.as_deref(), &env_map) {
            Ok(()) => None,
            Err(err) => {
                let resume = env_map.get("MYCMUX_RESUME").cloned();
                let kind = resume
                    .as_deref()
                    .filter(|value| is_agent_session_kind(value))
                    .map(str::to_string);
                if let Some(kind) = kind.as_deref() {
                    let requested_session_id = env_map
                        .get("MYCMUX_SESSION_ID")
                        .cloned()
                        .unwrap_or_default();
                    let fallback_ids = restore_fallback_session_ids.as_deref().unwrap_or_default();
                    match apply_agent_restore_recovery_args(
                        &requested_command,
                        &mut args,
                        kind,
                        &requested_session_id,
                        fallback_ids,
                        cwd.as_deref(),
                    ) {
                        AgentRestoreRecovery::RequestedValid => None,
                        AgentRestoreRecovery::Fallback(fallback_id) => {
                            eprintln!(
                                "[mycmux] agent restore validation failed, resuming fallback session {fallback_id}: {err}"
                            );
                            env_map.insert("MYCMUX_SESSION_ID".to_string(), fallback_id.clone());
                            let _ = app_handle.emit(
                                "agent-restore-downgraded",
                                serde_json::json!({
                                    "session_id": &session_id,
                                    "kind": kind,
                                    "reason": &err,
                                    "fallback_session_id": fallback_id,
                                }),
                            );
                            None
                        }
                        AgentRestoreRecovery::Downgrade => {
                            eprintln!(
                                "[mycmux] agent restore validation failed, falling back to --continue: {err}"
                            );
                            // Release builds have no stderr, so surface the silent
                            // downgrade to the frontend (warning toast).
                            let _ = app_handle.emit(
                                "agent-restore-downgraded",
                                serde_json::json!({
                                    "session_id": &session_id,
                                    "kind": kind,
                                    "reason": &err,
                                }),
                            );
                            env_map.remove("MYCMUX_SESSION_ID");
                            resume
                        }
                    }
                } else {
                    env_map.remove("MYCMUX_SESSION_ID");
                    resume
                }
            }
        }
    };
    let launch_cwd = resolve_launch_cwd(cwd.as_deref());
    // Stash frontend-provided pane bookkeeping before sanitize_launch_env strips
    // it; canonical values are re-injected below so launcher.sh session tracking
    // (__write_session_mapping / __stable_new_session_id) keeps working while
    // forged values from persistence or parent shells still cannot pass through.
    let incoming_tab_id = env_map.get("MYCMUX_TAB_ID").cloned();
    let incoming_launcher_done = env_map
        .get("__CMUX_LAUNCHER_DONE")
        .map(|value| value == "1")
        .unwrap_or(false);
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
        if let Ok(runtime_dir) = crate::test_profile::runtime_dir() {
            let html_dir = runtime_dir.join("sessions").join(&session_id);
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
    // Canonical pane/tab identity for launcher.sh session tracking. The pane
    // session id is the create_session argument itself (the mapping filename
    // launcher.sh writes under ~/.mycmux/pane-sessions/), so re-injecting it
    // here cannot be forged — same pattern as MYCMUX_HTML_OUT above.
    if session_id_is_safe {
        env_map.insert("MYCMUX_PANE_SESSION_ID".to_string(), session_id.clone());
    }
    if let Ok(runtime_dir) = crate::test_profile::runtime_dir() {
        env_map.insert(
            "MYCMUX_RUNTIME_DIR".to_string(),
            runtime_dir.to_string_lossy().to_string(),
        );
    }
    if crate::test_profile::is_active() {
        env_map.insert("MYCMUX_TEST_PROFILE".to_string(), "1".to_string());
    }
    if let Some(tab_id) = incoming_tab_id {
        if is_uuid_like(&tab_id) {
            env_map.insert("MYCMUX_TAB_ID".to_string(), tab_id);
        }
    }
    if incoming_launcher_done {
        env_map.insert("__CMUX_LAUNCHER_DONE".to_string(), "1".to_string());
    }
    if let Some(resume) = fallback_resume.filter(|value| is_agent_session_kind(value)) {
        env_map.insert("MYCMUX_RESUME".to_string(), resume);
    }
    let command = prepare_spawn_command(&requested_command, &mut args);
    inject_osc7_hook(&command, &mut args, &mut env_map);
    inject_no_color_for_agy(&command, &mut env_map);
    if should_trust_claude_workspace(&requested_command, &env_map) {
        if let Some(trusted_cwd) = launch_cwd.as_deref() {
            if let Err(error) = ensure_claude_project_trusted(trusted_cwd) {
                eprintln!("[claude] failed to mark workspace trusted: {error}");
            }
        }
    }
    write_launch_session_mapping(&session_id, &env_map);
    state.session_manager.create(
        session_id.clone(),
        &command,
        &args,
        cols,
        rows,
        on_data,
        app_handle,
        launch_cwd,
        Some(env_map),
        state.metadata_store.clone(),
    )?;
    if let Some((session_epoch, _)) = state.session_manager.session_observation(&session_id) {
        state.session_state_store.ingest(
            session_id,
            crate::session_state::Evidence::socket_lifecycle(
                crate::session_state::unix_epoch_millis(),
                session_epoch,
                crate::session_state::Lifecycle::Alive,
            ),
        );
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub(crate) fn prepare_spawn_command(command: &str, args: &mut Vec<String>) -> String {
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
    let resolved_command = resolved.to_string_lossy().to_string();
    force_utf8_codepage_for_interactive_shell(&resolved_command, args);
    resolved_command
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn prepare_spawn_command(command: &str, _args: &mut Vec<String>) -> String {
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

#[cfg(target_os = "windows")]
fn force_utf8_codepage_for_interactive_shell(command: &str, args: &mut Vec<String>) {
    let leaf = Path::new(command)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(command)
        .to_ascii_lowercase();
    match leaf.as_str() {
        "bash" | "sh" if args.is_empty() || args.as_slice() == ["-i"] => {
            let executable = leaf;
            *args = vec![
                "-c".to_string(),
                format!("chcp.com 65001 >/dev/null 2>&1; exec {executable} -i"),
            ];
        }
        "bash" | "sh" => {
            if let Some(command_index) = args.iter().position(|arg| arg == "-c") {
                if let Some(script) = args.get_mut(command_index + 1) {
                    if !script.contains("chcp.com 65001") {
                        *script = format!("chcp.com 65001 >/dev/null 2>&1; {script}");
                    }
                }
            }
        }
        "powershell" | "pwsh" if args.is_empty() => {
            *args = vec![
                "-NoExit".to_string(),
                "-Command".to_string(),
                "chcp.com 65001 > $null; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; [Console]::InputEncoding = New-Object System.Text.UTF8Encoding".to_string(),
            ];
        }
        "cmd" if args.is_empty() => {
            *args = vec![
                "/d".to_string(),
                "/k".to_string(),
                "chcp.com 65001 >nul".to_string(),
            ];
        }
        _ => {}
    }
}

fn command_leaf(command: &str) -> &str {
    let leaf = command.rsplit(['/', '\\']).next().unwrap_or(command);
    leaf.strip_suffix(".exe")
        .or_else(|| leaf.strip_suffix(".cmd"))
        .or_else(|| leaf.strip_suffix(".bat"))
        .or_else(|| leaf.strip_suffix(".com"))
        .unwrap_or(leaf)
}

fn apply_agent_restore_fallback_args(command: &str, args: &mut Vec<String>, kind: &str) {
    let leaf = command_leaf(command).to_ascii_lowercase();
    match (leaf.as_str(), kind) {
        ("claude", "claude") => {
            *args = vec![
                "--dangerously-skip-permissions".to_string(),
                "--permission-mode".to_string(),
                "bypassPermissions".to_string(),
                "--continue".to_string(),
            ];
        }
        ("codex", "codex") => {
            *args = vec![
                "resume".to_string(),
                "--no-alt-screen".to_string(),
                "--last".to_string(),
            ];
        }
        ("claude-codex", "claude-codex") => {
            *args = vec!["--continue".to_string()];
        }
        _ => {}
    }
}

#[derive(Debug, PartialEq, Eq)]
enum AgentRestoreRecovery {
    RequestedValid,
    Fallback(String),
    Downgrade,
}

fn apply_agent_restore_resume_args(
    command: &str,
    args: &mut [String],
    kind: &str,
    requested_session_id: &str,
    fallback_session_id: &str,
) {
    let leaf = command_leaf(command).to_ascii_lowercase();
    match (leaf.as_str(), kind) {
        ("claude", "claude") | ("claude-codex", "claude-codex") => {
            if let Some(resume_index) = args.iter().position(|arg| arg == "--resume") {
                if args.get(resume_index + 1).map(String::as_str) == Some(requested_session_id) {
                    args[resume_index + 1] = fallback_session_id.to_string();
                }
            }
        }
        ("codex", "codex") => {
            if let Some(session_id) = args
                .iter_mut()
                .rev()
                .find(|arg| arg.as_str() == requested_session_id)
            {
                *session_id = fallback_session_id.to_string();
            }
        }
        _ => {}
    }
}

fn apply_agent_restore_recovery_args(
    command: &str,
    args: &mut Vec<String>,
    kind: &str,
    requested_session_id: &str,
    fallback_session_ids: &[String],
    cwd: Option<&str>,
) -> AgentRestoreRecovery {
    apply_agent_restore_recovery_args_with(
        command,
        args,
        kind,
        requested_session_id,
        fallback_session_ids,
        cwd,
        can_restore_agent_session,
    )
}

fn apply_agent_restore_recovery_args_with<F>(
    command: &str,
    args: &mut Vec<String>,
    kind: &str,
    requested_session_id: &str,
    fallback_session_ids: &[String],
    cwd: Option<&str>,
    mut can_restore: F,
) -> AgentRestoreRecovery
where
    F: FnMut(&str, &str, Option<&str>) -> bool,
{
    if can_restore(kind, requested_session_id, cwd) {
        return AgentRestoreRecovery::RequestedValid;
    }
    if matches!(kind, "claude" | "codex") {
        if let Some(fallback_session_id) = fallback_session_ids
            .iter()
            .find(|session_id| !session_id.trim().is_empty() && can_restore(kind, session_id, cwd))
        {
            apply_agent_restore_resume_args(
                command,
                args,
                kind,
                requested_session_id,
                fallback_session_id,
            );
            return AgentRestoreRecovery::Fallback(fallback_session_id.clone());
        }
    }
    apply_agent_restore_fallback_args(command, args, kind);
    AgentRestoreRecovery::Downgrade
}

fn should_trust_claude_workspace(command: &str, env: &HashMap<String, String>) -> bool {
    // A pane launched with CLAUDE_CONFIG_DIR reads its config from the staging
    // directory. Writing trust into the live ~/.claude.json has no effect there
    // and only rewrites the file, which makes live_sync re-capture for nothing.
    if env.contains_key("CLAUDE_CONFIG_DIR") {
        return false;
    }
    let kind = env
        .get("MYCMUX_AGENT_KIND")
        .or_else(|| env.get("MYCMUX_RESUME"))
        .map(|value| value.as_str());
    kind == Some("claude") || command_leaf(command).eq_ignore_ascii_case("claude")
}

pub(crate) fn resolve_launch_cwd(cwd: Option<&str>) -> Option<String> {
    if let Some(value) = cwd.filter(|value| !value.trim().is_empty()) {
        return Some(value.to_string());
    }
    dirs::home_dir().map(|path| path.to_string_lossy().to_string())
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
///     keep the resume / handoff payload and only strip pane-internal bookkeeping
///     (`MYCMUX_PANE_SESSION_ID`, `MYCMUX_TAB_ID`, `__CMUX_LAUNCHER_DONE`).
///   - Otherwise strip *every* MYCMUX_* and `__CMUX_LAUNCHER_DONE`.
///
/// Pane bookkeeping is stripped here but `create_session` re-injects canonical
/// values afterwards (`MYCMUX_PANE_SESSION_ID` = the session_id argument,
/// `MYCMUX_TAB_ID` = the frontend value when UUID-shaped, `__CMUX_LAUNCHER_DONE`
/// when the frontend explicitly sent "1") — launcher.sh session tracking
/// depends on them.
///
/// Keep this list in sync with `lib.rs::run()` startup `remove_var` and the
/// frontend `EPHEMERAL_LAUNCH_ENV_KEYS` set in `SocketListener.tsx`.
pub(crate) fn sanitize_launch_env(env: &mut HashMap<String, String>) {
    const ALWAYS_INTERNAL: &[&str] = &[
        "MYCMUX_PANE_SESSION_ID",
        "MYCMUX_TAB_ID",
        "__CMUX_LAUNCHER_DONE",
        // Always stripped so frontend/parent-shell cannot forge a path. The
        // canonical absolute value is re-injected by create_session below.
        "MYCMUX_HTML_OUT",
        "MYCMUX_MARKDOWN_OUT",
        "MYCMUX_ARTIFACTS_DIR",
        "MYCMUX_RUNTIME_DIR",
        "MYCMUX_TEST_PROFILE",
    ];
    const RESUME_QUARTET: &[&str] = &[
        "MYCMUX_RESUME",
        "MYCMUX_SESSION_ID",
        "MYCMUX_AGENT_KIND",
        "MYCMUX_RESUME_FORK",
    ];
    const HANDOFF_QUARTET: &[&str] = &[
        "MYCMUX_HANDOFF",
        "MYCMUX_HANDOFF_FROM",
        "MYCMUX_HANDOFF_PROMPT_FILE",
        "MYCMUX_HANDOFF_FROM_SESSION",
    ];

    // Windows environment names are case-insensitive. Keep canonical keys for
    // the existing legitimacy checks below, but strip every case alias before
    // handing the map to portable-pty where aliases would otherwise merge.
    env.retain(|key, _| {
        !ALWAYS_INTERNAL
            .iter()
            .chain(RESUME_QUARTET.iter())
            .chain(HANDOFF_QUARTET.iter())
            .any(|protected| key != *protected && key.eq_ignore_ascii_case(protected))
    });

    let has_session = env
        .get("MYCMUX_SESSION_ID")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    let resume_kind = env
        .get("MYCMUX_RESUME")
        .or_else(|| env.get("MYCMUX_AGENT_KIND"))
        .map(|v| v.as_str());
    let has_kind = resume_kind.map(is_agent_session_kind).unwrap_or(false);
    let supports_resume_fork = matches!(resume_kind, Some("claude" | "claude-codex"));
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
        for key in RESUME_QUARTET {
            env.remove(*key);
        }
    } else if !supports_resume_fork {
        env.remove("MYCMUX_RESUME_FORK");
    }
    if !legitimate_handoff {
        for key in HANDOFF_QUARTET {
            env.remove(*key);
        }
    }
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
    if matches!(agent_kind, "claude" | "claude-codex")
        && env
            .get("MYCMUX_RESUME_FORK")
            .map(|value| value == "1")
            .unwrap_or(false)
    {
        return;
    }
    let _ = write_session_mapping_file(session_id, agent_kind, agent_session_id);
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

/// agy (Antigravity CLI) hardcodes light-background ANSI/256-color escapes and
/// never queries the terminal background (OSC 11); mycmux's 16-color ANSI theme
/// cannot patch the truecolor/256-color output it emits directly, and agy has no
/// --theme/--no-color flag (confirmed on agy 1.1.11). NO_COLOR=1 is the only known
/// mitigation. This only covers panes whose own top-level command IS the agent
/// binary (e.g. a BUILT_IN_AGENTS direct launch such as `command: "gemini"` in
/// src/lib/agents.ts) — panes that reach agy via launcher.sh/launcher.ps1's own
/// menu are handled inside those scripts instead, since Rust never sees the
/// inner `eval`'d command.
fn inject_no_color_for_agy(command: &str, env: &mut HashMap<String, String>) {
    let leaf = command_leaf(command).to_ascii_lowercase();
    if matches!(leaf.as_str(), "agy" | "antigravity" | "gemini") {
        env.entry("NO_COLOR".to_string())
            .or_insert_with(|| "1".to_string());
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

#[tauri::command(async)]
pub fn is_session_alive(state: State<'_, AppState>, session_id: String) -> bool {
    state.session_manager.is_alive(&session_id)
}

#[tauri::command(async)]
pub fn resize_session(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.session_manager.resize(&session_id, cols, rows)
}

#[tauri::command]
pub fn ack_frontend_data(
    state: State<'_, AppState>,
    session_id: String,
    generation: u64,
    seq: u64,
    bytes: usize,
) -> Result<(), String> {
    state
        .session_manager
        .ack_frontend_data(&session_id, generation, seq, bytes);
    Ok(())
}

#[tauri::command]
pub fn set_frontend_visible(
    state: State<'_, AppState>,
    session_id: String,
    visible: bool,
) -> Result<(), String> {
    state
        .session_manager
        .set_frontend_visible(&session_id, visible);
    Ok(())
}

#[tauri::command(async)]
pub fn get_session_scrollback(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Response, String> {
    state
        .session_manager
        .get_scrollback_snapshot(&session_id)
        .map(|snapshot| Response::new(snapshot.into_wire()))
}

#[tauri::command(async)]
pub fn kill_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let session_epoch = state
        .session_manager
        .session_observation(&session_id)
        .map(|(session_epoch, _)| session_epoch);
    state.session_manager.kill(&session_id)?;
    if let Some(session_epoch) = session_epoch {
        state.session_state_store.ingest(
            session_id,
            crate::session_state::Evidence::socket_lifecycle(
                crate::session_state::unix_epoch_millis(),
                session_epoch,
                crate::session_state::Lifecycle::Exited,
            ),
        );
    }
    Ok(())
}

#[tauri::command(async)]
pub fn is_directory(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

#[tauri::command(async)]
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
            ("__CMUX_LAUNCHER_DONE", "1"),
            ("FOO", "bar"),
        ]);
        sanitize_launch_env(&mut e);
        assert!(!e.contains_key("MYCMUX_PANE_SESSION_ID"));
        assert!(!e.contains_key("MYCMUX_TAB_ID"));
        assert!(!e.contains_key("MYCMUX_MARKDOWN_OUT"));
        assert!(!e.contains_key("__CMUX_LAUNCHER_DONE"));
        assert_eq!(e.get("FOO"), Some(&"bar".to_string()));
    }

    #[test]
    fn sanitize_strips_stray_resume_marker_without_session_id() {
        // Bug class: MYCMUX_RESUME=1 leaks from a parent shell with no SESSION_ID.
        // Must not reach the child or the agent will auto-resume.
        let mut e = env(&[
            ("MYCMUX_RESUME", "claude"),
            ("MYCMUX_RESUME_FORK", "1"),
            ("FOO", "bar"),
        ]);
        sanitize_launch_env(&mut e);
        assert!(!e.contains_key("MYCMUX_RESUME"));
        assert!(!e.contains_key("MYCMUX_RESUME_FORK"));
        assert_eq!(e.get("FOO"), Some(&"bar".to_string()));
    }

    #[test]
    fn sanitize_strips_stray_session_id_without_kind() {
        let mut e = env(&[("MYCMUX_SESSION_ID", "abc-123")]);
        sanitize_launch_env(&mut e);
        assert!(!e.contains_key("MYCMUX_SESSION_ID"));
    }

    #[test]
    fn sanitize_strips_noncanonical_case_aliases_of_ephemeral_keys() {
        let mut e = env(&[
            ("mycmux_pane_session_id", "pane-1"),
            ("MyCmUx_ReSuMe", "claude"),
            ("mYcMuX_hAnDoFf", "codex"),
            ("__cmux_launcher_done", "1"),
            ("SAFE", "value"),
        ]);
        sanitize_launch_env(&mut e);
        assert!(e.keys().all(|key| {
            !key.eq_ignore_ascii_case("MYCMUX_PANE_SESSION_ID")
                && !key.eq_ignore_ascii_case("MYCMUX_RESUME")
                && !key.eq_ignore_ascii_case("MYCMUX_HANDOFF")
                && !key.eq_ignore_ascii_case("__CMUX_LAUNCHER_DONE")
        }));
        assert_eq!(e.get("SAFE"), Some(&"value".to_string()));
    }

    #[test]
    fn isolated_login_panes_are_never_trusted_into_the_live_config() {
        // The pane reads ~/.claude.json from the staging directory, so writing
        // trust into the live file would only churn it for live_sync.
        let e = env(&[
            ("MYCMUX_AGENT_KIND", "claude"),
            ("CLAUDE_CONFIG_DIR", "C:/data/cli_login_staging/abc"),
        ]);
        assert!(!should_trust_claude_workspace("claude", &e));
        assert!(!should_trust_claude_workspace(
            "C:/tools/claude.cmd",
            &env(&[("CLAUDE_CONFIG_DIR", "C:/data/cli_login_staging/abc")]),
        ));
    }

    #[test]
    fn ordinary_claude_panes_still_trust_their_workspace() {
        assert!(should_trust_claude_workspace(
            "claude",
            &env(&[("HOME", "/home/u")])
        ));
        assert!(should_trust_claude_workspace(
            "bash",
            &env(&[("MYCMUX_AGENT_KIND", "claude")])
        ));
        assert!(!should_trust_claude_workspace("bash", &env(&[])));
    }

    #[test]
    fn sanitize_keeps_legitimate_resume_payload() {
        let mut e = env(&[
            ("MYCMUX_RESUME", "claude"),
            ("MYCMUX_SESSION_ID", "abc-123"),
            ("MYCMUX_AGENT_KIND", "claude"),
            ("MYCMUX_RESUME_FORK", "1"),
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
        assert_eq!(e.get("MYCMUX_RESUME_FORK").map(String::as_str), Some("1"));
        assert!(!e.contains_key("MYCMUX_PANE_SESSION_ID"));
        assert!(!e.contains_key("__CMUX_LAUNCHER_DONE"));
        assert_eq!(e.get("HOME").map(String::as_str), Some("/home/u"));
    }

    #[test]
    fn sanitize_strips_fork_marker_from_codex_resume_payload() {
        let mut e = env(&[
            ("MYCMUX_RESUME", "codex"),
            ("MYCMUX_SESSION_ID", "abc-123"),
            ("MYCMUX_AGENT_KIND", "codex"),
            ("MYCMUX_RESUME_FORK", "1"),
        ]);
        sanitize_launch_env(&mut e);
        assert_eq!(e.get("MYCMUX_RESUME").map(String::as_str), Some("codex"));
        assert_eq!(
            e.get("MYCMUX_SESSION_ID").map(String::as_str),
            Some("abc-123")
        );
        assert!(!e.contains_key("MYCMUX_RESUME_FORK"));
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

    #[test]
    fn restore_fallback_args_remove_stale_codex_session_id() {
        let mut args = vec![
            "resume".to_string(),
            "--no-alt-screen".to_string(),
            "-C".to_string(),
            "C:\\work".to_string(),
            "missing-session".to_string(),
        ];
        apply_agent_restore_fallback_args("codex", &mut args, "codex");
        assert_eq!(
            args,
            vec![
                "resume".to_string(),
                "--no-alt-screen".to_string(),
                "--last".to_string(),
            ]
        );
        assert!(!args.iter().any(|arg| arg == "missing-session"));
    }

    #[test]
    fn restore_missing_requested_id_uses_first_fallback_with_existing_transcript() {
        let mut args = vec![
            "--dangerously-skip-permissions".to_string(),
            "--permission-mode".to_string(),
            "bypassPermissions".to_string(),
            "--resume".to_string(),
            "missing-session".to_string(),
        ];
        let fallback_ids = vec![
            "also-missing".to_string(),
            "existing-transcript".to_string(),
            "later-existing-transcript".to_string(),
        ];

        let recovery = apply_agent_restore_recovery_args_with(
            "claude",
            &mut args,
            "claude",
            "missing-session",
            &fallback_ids,
            Some("C:\\work"),
            |_, session_id, _| {
                matches!(
                    session_id,
                    "existing-transcript" | "later-existing-transcript"
                )
            },
        );

        assert_eq!(
            recovery,
            AgentRestoreRecovery::Fallback("existing-transcript".to_string())
        );
        assert_eq!(args.last().map(String::as_str), Some("existing-transcript"));
        assert!(!args.iter().any(|arg| arg == "missing-session"));
    }

    #[test]
    fn restore_missing_requested_id_without_valid_fallback_still_continues() {
        let mut args = vec!["--resume".to_string(), "missing-session".to_string()];
        let fallback_ids = vec!["also-missing".to_string()];

        let recovery = apply_agent_restore_recovery_args_with(
            "claude",
            &mut args,
            "claude",
            "missing-session",
            &fallback_ids,
            Some("C:\\work"),
            |_, _, _| false,
        );

        assert_eq!(recovery, AgentRestoreRecovery::Downgrade);
        assert_eq!(
            args,
            vec![
                "--dangerously-skip-permissions".to_string(),
                "--permission-mode".to_string(),
                "bypassPermissions".to_string(),
                "--continue".to_string(),
            ]
        );
    }

    #[test]
    fn restore_valid_requested_id_ignores_fallbacks() {
        let mut args = vec!["--resume".to_string(), "requested-session".to_string()];
        let original = args.clone();
        let fallback_ids = vec!["existing-transcript".to_string()];

        let recovery = apply_agent_restore_recovery_args_with(
            "claude",
            &mut args,
            "claude",
            "requested-session",
            &fallback_ids,
            Some("C:\\work"),
            |_, session_id, _| {
                assert_eq!(session_id, "requested-session");
                true
            },
        );

        assert_eq!(recovery, AgentRestoreRecovery::RequestedValid);
        assert_eq!(args, original);
    }

    #[test]
    fn restore_fallback_args_leave_launcher_shell_args_alone() {
        let mut args = vec![
            "-i".to_string(),
            "-c".to_string(),
            "source \"$HOME/.mycmux/bin/launcher.sh\"".to_string(),
        ];
        let original = args.clone();
        apply_agent_restore_fallback_args("bash", &mut args, "codex");
        assert_eq!(args, original);
    }

    #[test]
    fn injects_no_color_for_direct_agy_launch() {
        let mut e = env(&[]);
        inject_no_color_for_agy("agy", &mut e);
        assert_eq!(e.get("NO_COLOR"), Some(&"1".to_string()));
    }

    #[test]
    fn injects_no_color_for_antigravity_and_gemini_leaves_too() {
        let mut e = env(&[]);
        inject_no_color_for_agy(
            "C:\\Users\\miyaz\\AppData\\Local\\agy\\bin\\antigravity.exe",
            &mut e,
        );
        assert_eq!(e.get("NO_COLOR"), Some(&"1".to_string()));

        let mut e2 = env(&[]);
        inject_no_color_for_agy("gemini", &mut e2);
        assert_eq!(e2.get("NO_COLOR"), Some(&"1".to_string()));
    }

    #[test]
    fn injects_no_color_leaves_existing_value_alone() {
        let mut e = env(&[("NO_COLOR", "0")]);
        inject_no_color_for_agy("agy", &mut e);
        assert_eq!(e.get("NO_COLOR"), Some(&"0".to_string()));
    }

    #[test]
    fn does_not_inject_no_color_for_unrelated_commands() {
        let mut e = env(&[]);
        inject_no_color_for_agy("bash", &mut e);
        assert!(!e.contains_key("NO_COLOR"));
    }
}
