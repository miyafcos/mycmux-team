//! Transient restore supervision only: no capture, save, owner or quit state.
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use tauri::{AppHandle, Emitter};
use super::command_leaf;
#[cfg(test)]
use super::requested_conversation;
use crate::commands::session_mapping::{is_safe_mapping_id, session_mapping_dir};
use crate::pty::manager::SessionManager;
use crate::util::ids::is_uuid_like;

pub(super) fn sanitize_report_env(env: &mut HashMap<String, String>) {
    for reserved in ["MYCMUX_CODEX_RESTORE_GENERATION", "MYCMUX_CODEX_RESTORE_REASON"] {
        let aliases: Vec<_> = env.keys().filter(|key| key.eq_ignore_ascii_case(reserved)).cloned().collect();
        for key in &aliases { env.remove(key); }
    }
}

// Publish invalidation to every window before a create/kill/channel replacement
// can publish the new instance. This event has no identity or persistence data.
pub(crate) fn invalidate_codex_restore_notice(app: &AppHandle, pty: &str) {
    let _ = app.emit("codex-restore-invalidated", serde_json::json!({ "session_id": pty }));
}
pub(crate) fn publish_codex_restore_epoch(app: &AppHandle, pty: &str, epoch: Option<u64>) {
    let _ = app.emit("codex-restore-published", serde_json::json!({ "session_id": pty, "session_epoch": epoch }));
}

// Extend the existing native create serialization through instance binding.
// Weak entries retain no PTY, report, conversation or persistent identity.
pub(super) fn creation_gate(pty: &str) -> Arc<Mutex<()>> {
    static GATES: OnceLock<Mutex<HashMap<String, Weak<Mutex<()>>>>> = OnceLock::new();
    let mut gates = GATES.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    gates.retain(|_, gate| gate.strong_count() > 0);
    if let Some(gate) = gates.get(pty).and_then(Weak::upgrade) { return gate; }
    let gate = Arc::new(Mutex::new(()));
    gates.insert(pty.into(), Arc::downgrade(&gate));
    gate
}

pub(super) enum CodexExecutable { Direct(Option<String>), Launcher }
impl CodexExecutable {
    pub(super) fn fresh_args(&self) -> Option<Vec<String>> {
        match self {
            Self::Direct(script) => Some(script.iter().cloned().chain(std::iter::once("--no-alt-screen".into())).collect()),
            Self::Launcher => None,
        }
    }
}
pub(super) fn classify_executable(command: &str, args: &[String]) -> Option<CodexExecutable> {
    // Normalize extension and case here; do not alter the base identity parser.
    let lower = command.to_ascii_lowercase();
    match command_leaf(&lower) {
        "codex" => Some(CodexExecutable::Direct(None)),
        "node" | "bun" if args.first().is_some_and(|script| script.replace('\\', "/")
            .rsplit('/').next().is_some_and(|name| name.eq_ignore_ascii_case("codex.js"))) =>
            Some(CodexExecutable::Direct(args.first().cloned())),
        "bash" | "sh" | "zsh" | "fish" | "powershell" | "pwsh" | "cmd" if args.iter()
            .any(|arg| arg.contains("launcher.sh") || arg.contains("launcher.ps1")) => Some(CodexExecutable::Launcher),
        _ => None,
    }
}

// Launch-only grammar. The base monitor, capture parser and owner readers keep
// their exact bytes and callers; prompt UUIDs must not create restore intent.
pub(super) fn exact_resume_id(command: &str, args: &[String]) -> Option<String> {
    let mut index = match classify_executable(command, args)? {
        CodexExecutable::Direct(script) => usize::from(script.is_some()),
        _ => return None,
    };
    let mut resume = false;
    let mut target = None;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--" {
            if !resume { return None; }
            return target.or_else(|| args.get(index + 1).filter(|id| is_uuid_like(id)).cloned());
        }
        if matches!(arg.as_str(), "--last" | "--fork-session" | "--help" | "-h" | "--version" | "-V") { return None; }
        if ["-p", "-c", "-m", "-s", "-a", "-C", "-i"].iter().any(|prefix| arg.starts_with(prefix) && arg.len() > prefix.len()) {
            index += 1;
            continue;
        }
        let option = arg.split('=').next().unwrap_or(arg);
        if ["-p", "--profile", "-c", "--config", "-m", "--model", "-s", "--sandbox", "-a", "--ask-for-approval",
            "-C", "--cd", "--add-dir", "--local-provider", "--enable", "--disable", "-i", "--image"].contains(&option) {
            if !arg.contains('=') { index += 1; args.get(index)?; }
        } else if matches!(arg.as_str(), "--no-alt-screen" | "--oss" | "--full-auto" | "--search"
            | "--dangerously-bypass-approvals-and-sandbox" | "--yolo" | "--all" | "--include-non-interactive") {
        } else if arg.starts_with('-') {
            return None;
        } else if !resume {
            if arg != "resume" { return None; }
            resume = true;
        } else if target.is_none() {
            if !is_uuid_like(arg) { return None; }
            target = Some(arg.to_string());
        }
        index += 1;
    }
    target
}

#[derive(Clone)]
pub(super) struct RestoreReportContext {
    epoch: u64,
    generation: String,
    tab_id: Option<String>,
    requested_id: Option<String>,
    downgraded: bool,
    last_report: Option<(CodexRestoreOutcome, CodexRestoreReason)>,
}

impl RestoreReportContext {
    pub(super) fn new(epoch: u64, generation: String, tab_id: Option<String>, requested_id: Option<String>) -> Self {
        Self { epoch, generation, tab_id, requested_id, downgraded: false, last_report: None }
    }

    fn observe(&mut self, live_epoch: Option<u64>, report: &CodexRestoreReport) -> Option<Self> {
        if live_epoch != Some(self.epoch) || self.generation != report.generation
            || self.tab_id.as_deref().unwrap_or("") != report.tab_id
            || self.last_report.is_some_and(|(outcome, _)| outcome != CodexRestoreOutcome::Downgrade)
            || self.last_report == Some((report.outcome, report.reason)) { return None; }
        let previous = self.clone();
        self.last_report = Some((report.outcome, report.reason));
        self.downgraded |= report.outcome.is_downgrade();
        Some(previous)
    }
}

fn handle_report(app: &AppHandle, pty: &str, context: &mut RestoreReportContext,
                 live_epoch: Option<u64>, report: &CodexRestoreReport) -> Option<CodexRestoreOutcome> {
    let previous = context.observe(live_epoch, report)?;
    if report.outcome.is_downgrade() && !previous.downgraded {
        if report.reason == CodexRestoreReason::SpawnFailed {
            codex_restore_diag(pty, previous.tab_id.as_deref(), previous.requested_id.as_deref(), "spawn-failure", report.reason.as_str());
        }
        codex_restore_diag(pty, previous.tab_id.as_deref(), previous.requested_id.as_deref(), "downgrade", report.reason.as_str());
        // A notification-only event cannot erase an ordinary identity accepted
        // after this Codex launch. The base metadata/downgrade writer is intact.
        emit_notice(app, pty, &previous, report.reason.as_str());
    }
    if report.outcome != CodexRestoreOutcome::Downgrade {
        codex_restore_diag(pty, previous.tab_id.as_deref(), previous.requested_id.as_deref(), report.outcome.as_str(), report.reason.as_str());
    }
    Some(report.outcome)
}

pub(super) fn emit_notice(app: &AppHandle, pty: &str, context: &RestoreReportContext, reason: &str) {
    let _ = app.emit("codex-restore-notice", serde_json::json!({ "session_id": pty, "reason": reason,
        "session_epoch": context.epoch, "generation": context.generation, "tab_id": context.tab_id }));
}

// One task owns one report context. Nothing is stored in SessionManager or
// read by saving, canonicalization, dormancy, ownership or quit consumers.
pub(super) fn watch_report(app: AppHandle, manager: Arc<SessionManager>, pty: String, mut context: RestoreReportContext) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            if manager.session_observation(&pty).map(|value| value.0) != Some(context.epoch) { break; }
            let reader_pty = pty.clone();
            let report = crate::util::task::run_blocking("codex_restore_report", move || {
                if session_mapping_dir().and_then(|dir| codex_restore_report_path(&dir, &reader_pty)).is_some_and(|path| path.is_dir()) {
                    return Err("Codex restore outcome path is unavailable".to_string());
                }
                Ok(read_codex_restore_report(&reader_pty))
            }).await;
            let live_epoch = manager.session_observation(&pty).map(|value| value.0);
            if live_epoch != Some(context.epoch) { break; }
            match report {
                Ok(Some(report)) => {
                    if handle_report(&app, &pty, &mut context, live_epoch, &report).is_some_and(|outcome| outcome != CodexRestoreOutcome::Downgrade) { break; }
                }
                Ok(None) => {},
                Err(_) => {
                    codex_restore_diag(&pty, context.tab_id.as_deref(), context.requested_id.as_deref(), "downgrade", "report-unavailable");
                    if !context.downgraded {
                        emit_notice(&app, &pty, &context, "report-unavailable");
                    }
                    break;
                }
            }
        }
    });
}

#[cfg(test)]
mod report_context_tests {
    use super::*;
    #[test]
    fn n3_report_epoch_generation_tab_and_once_only_are_local_to_the_launch() {
        let mut context = RestoreReportContext::new(100, "new".into(), Some("tab".into()), Some("A".into()));
        let mut report = CodexRestoreReport { generation: "old".into(), tab_id: "tab".into(),
            outcome: CodexRestoreOutcome::Downgrade, reason: CodexRestoreReason::SpawnFailed };
        assert!(context.observe(Some(100), &report).is_none());
        report.generation = "new".into();
        assert!(context.observe(None, &report).is_none());
        assert!(context.observe(Some(101), &report).is_none());
        report.tab_id = "other".into(); assert!(context.observe(Some(100), &report).is_none());
        report.tab_id = "tab".into();
        assert!(!context.observe(Some(100), &report).unwrap().downgraded);
        assert!(context.observe(Some(100), &report).is_none());
        report.outcome = CodexRestoreOutcome::FreshFailed;
        assert!(context.observe(Some(100), &report).unwrap().downgraded);
        report.outcome = CodexRestoreOutcome::Downgrade;
        assert!(context.observe(Some(100), &report).is_none());
    }
    #[test]
    fn n3_launch_only_grammar_does_not_change_capture_or_resume_prompt_uuids() {
        let id = "11111111-2222-4333-8444-555555555555";
        for args in [vec!["resume", id], vec!["--profile", id, "resume", id], vec!["resume", "--", id]] {
            assert_eq!(exact_resume_id("codex", &args.iter().map(|value| value.to_string()).collect::<Vec<_>>()).as_deref(), Some(id));
        }
        for args in [vec![id], vec!["--profile", id], vec!["resume", "--last", id], vec!["resume", "--model", id], vec!["exec", id]] {
            assert!(exact_resume_id("codex", &args.iter().map(|value| value.to_string()).collect::<Vec<_>>()).is_none());
        }
        let args = vec!["C:/bin/codex.js".into(), "resume".into(), id.into()];
        assert_eq!(exact_resume_id("node", &args).as_deref(), Some(id));
    }
    #[test]
    fn n3_report_env_is_scrubbed_without_changing_the_shared_sanitizer() {
        let mut env = HashMap::from([("MYCMUX_CODEX_RESTORE_GENERATION".into(), "old".into()),
            ("MYCMUX_CODEX_RESTORE_REASON".into(), "old".into()), ("KEEP".into(), "ok".into())]);
        sanitize_report_env(&mut env);
        assert_eq!(env, HashMap::from([("KEEP".into(), "ok".into())]));
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum CodexRestoreOutcome { Downgrade, Completed, Exited, FreshCompleted, FreshFailed }

impl CodexRestoreOutcome {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Downgrade => "downgrade", Self::Completed => "completed", Self::Exited => "exited",
            Self::FreshCompleted => "fresh-completed", Self::FreshFailed => "fresh-failed",
        }
    }
    pub(super) fn is_downgrade(self) -> bool {
        matches!(self, Self::Downgrade | Self::FreshCompleted | Self::FreshFailed)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum CodexRestoreReason { MissingId, MalformedId, ValidationFailed, SpawnFailed, CliExit }

impl CodexRestoreReason {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::MissingId => "missing-id", Self::MalformedId => "malformed-id",
            Self::ValidationFailed => "validation-failed", Self::SpawnFailed => "spawn-failed", Self::CliExit => "cli-exit",
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CodexRestoreReport {
    pub(super) generation: String,
    pub(super) tab_id: String,
    pub(super) outcome: CodexRestoreOutcome,
    pub(super) reason: CodexRestoreReason,
}

fn codex_restore_report_path(map_dir: &Path, pty: &str) -> Option<PathBuf> {
    is_safe_mapping_id(pty).then(|| map_dir.join(format!("{pty}.codex-restore.json")))
}

fn parse_codex_restore_report(contents: &str) -> Option<CodexRestoreReport> {
    if contents.len() > 2048 { return None; }
    let report: CodexRestoreReport = serde_json::from_str(contents).ok()?;
    if !crate::util::ids::is_uuid_like(&report.generation) { return None; }
    if !report.tab_id.is_empty() && !crate::util::ids::is_uuid_like(&report.tab_id) { return None; }
    if report.outcome.is_downgrade() == (report.reason == CodexRestoreReason::CliExit) { return None; }
    Some(report)
}

fn prepare_codex_restore_report_in_dir(map_dir: &Path, pty: &str) -> Result<(), String> {
    let path = codex_restore_report_path(map_dir, pty).ok_or("Codex restore outcome path is unavailable")?;
    std::fs::create_dir_all(map_dir).map_err(|_| "Codex restore outcome directory is unavailable")?;
    match std::fs::remove_file(path) {
        Ok(()) => {},
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(_) => return Err("could not clear previous Codex restore outcome".into()),
    }
    // Verify the parent is writable before attempting the CLI. The launcher
    // still checks each later report write; storage can fail after preparation.
    let mut probe = tempfile::NamedTempFile::new_in(map_dir).map_err(|_| "Codex restore outcome is not writable")?;
    probe.write_all(b"codex-restore-preflight").map_err(|_| "Codex restore outcome is not writable")?;
    Ok(())
}

pub(super) fn clear_codex_restore_report(pty: &str) -> Result<(), String> {
    let dir = session_mapping_dir().ok_or("Codex restore outcome directory is unavailable")?;
    prepare_codex_restore_report_in_dir(&dir, pty)
}

#[cfg(test)]
mod codex_report_preparation_tests {
    use super::*;
    #[test]
    fn n3_report_directory_and_parent_errors_fail_preflight() {
        let root = tempfile::tempdir().unwrap();
        let reports = root.path().join("pane-sessions");
        std::fs::create_dir_all(reports.join("pty.codex-restore.json")).unwrap();
        assert!(prepare_codex_restore_report_in_dir(&reports, "pty").is_err());
        std::fs::write(root.path().join("file-parent"), "fixture").unwrap();
        assert!(prepare_codex_restore_report_in_dir(&root.path().join("file-parent"), "pty").is_err());
        assert!(prepare_codex_restore_report_in_dir(&reports, "../escape").is_err());
        assert!(prepare_codex_restore_report_in_dir(&reports, "usable").is_ok());
        assert_eq!(std::fs::read_dir(&reports).unwrap().count(), 1, "preflight temporary file must be cleaned");
    }
}

pub(super) fn read_codex_restore_report(pty: &str) -> Option<CodexRestoreReport> {
    let path = session_mapping_dir().and_then(|dir| codex_restore_report_path(&dir, pty))?;
    if std::fs::metadata(&path).ok()?.len() > 2048 { return None; }
    parse_codex_restore_report(&std::fs::read_to_string(path).ok()?)
}

#[cfg(test)]
mod codex_restore_report_tests {
    use super::*;
    #[test]
    fn restore_reports_are_bounded_and_accept_only_known_outcomes_and_reasons() {
        assert!(parse_codex_restore_report(r#"{"generation":"cccccccc-1111-4222-8333-444444444444","tab_id":"","outcome":"exited","reason":"cli-exit"}"#).is_some());
        assert!(parse_codex_restore_report(r#"{"generation":"cccccccc-1111-4222-8333-444444444444","tab_id":"","outcome":"fresh-failed","reason":"spawn-failed"}"#).is_some());
        for value in [
            r#"{"generation":"cccccccc-1111-4222-8333-444444444444","tab_id":"","outcome":"downgrade","reason":"cli-exit"}"#,
            r#"{"generation":"cccccccc-1111-4222-8333-444444444444","tab_id":"","outcome":"exited","reason":"spawn-failed"}"#,
            r#"{"generation":"cccccccc-1111-4222-8333-444444444444","tab_id":"prompt","outcome":"exited","reason":"cli-exit"}"#,
            r#"{"generation":"cccccccc-1111-4222-8333-444444444444","tab_id":"","outcome":"unknown","reason":"cli-exit"}"#,
            r#"{"generation":"cccccccc-1111-4222-8333-444444444444","tab_id":"","outcome":"exited","reason":"provider error contents"}"#,
            r#"{"generation":"cccccccc-1111-4222-8333-444444444444","tab_id":"","outcome":"exited","reason":"cli-exit","prompt":"secret"}"#,
        ] { assert!(parse_codex_restore_report(value).is_none(), "{value}"); }
        assert!(parse_codex_restore_report(&" ".repeat(2049)).is_none());
        assert!(codex_restore_report_path(Path::new("fixture"), "../escape").is_none());
    }
}

// Both paths execute the launcher's actual restore helpers; no second retry
// policy or interpretation of Codex exit codes is hidden in the backend.
pub(super) fn codex_restore_requested(command: &str, args: &[String], env: &HashMap<String, String>, reason: Option<&str>) -> bool {
    if env.contains_key("MYCMUX_HANDOFF") { return false; }
    if env.get("MYCMUX_RESUME").is_some_and(|kind| kind != "codex")
        || matches!(command_leaf(command).to_ascii_lowercase().as_str(), "claude" | "claude-codex" | "grok") { return false; }
    env.get("MYCMUX_RESUME").is_some_and(|kind| kind == "codex")
        || exact_resume_id(command, args).is_some() || reason == Some("saved-codex-pane")
}

fn codex_restore_helpers(source: &str) -> &str {
    source.split("# BEGIN CODEX RESTORE HELPERS").nth(1).unwrap()
        .split("# END CODEX RESTORE HELPERS").next().unwrap()
}

fn shell_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
fn powershell_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub(super) fn codex_restore_report_unavailable_shell(args: &mut Vec<String>) -> String {
    const EXPLANATION: &str = "Codex restore outcome could not be recorded; returning to the shell.";
    #[cfg(target_os = "windows")]
    {
        *args = vec!["-NoLogo".into(), "-NoProfile".into(), "-NoExit".into(), "-Command".into(), format!("Remove-Item Env:\\MYCMUX_CODEX_RESTORE_GENERATION, Env:\\MYCMUX_CODEX_RESTORE_REASON -ErrorAction SilentlyContinue; Write-Host {}", powershell_literal(EXPLANATION))];
        "powershell.exe".into()
    }
    #[cfg(not(target_os = "windows"))]
    {
        let shell = std::env::var("SHELL").ok().filter(|value| Path::new(value).is_file()).unwrap_or_else(|| "/bin/bash".into());
        *args = vec!["-c".into(), format!("unset MYCMUX_CODEX_RESTORE_GENERATION MYCMUX_CODEX_RESTORE_REASON; printf '%s\n' {}; exec {} -i", shell_literal(EXPLANATION), shell_literal(&shell))];
        "/bin/bash".into()
    }
}

pub(super) fn wrap_codex_restore(command: &str, args: &mut Vec<String>, fresh_command: &str, fresh_args: &[String]) -> String {
    #[cfg(target_os = "windows")]
    {
        let array = |command: &str, args: &[String]| std::iter::once(command).chain(args.iter().map(String::as_str))
            .map(powershell_literal).collect::<Vec<_>>().join(", ");
        let script = format!(
            "{}\nfunction Write-MycmuxSessionMapping {{}}\nfunction Invoke-MycmuxCommandArray {{ param([string[]]$Command) $exe=$Command[0]; $argv=@(); if ($Command.Count -gt 1) {{ $argv=$Command[1..($Command.Count-1)] }}; & $exe @argv }}\nInvoke-MycmuxCodexRestore -ResumeCommand @({}) -FreshCommand @({})",
            codex_restore_helpers(include_str!("../../launcher.ps1")), array(command, args), array(fresh_command, fresh_args));
        *args = vec!["-NoLogo".into(), "-NoProfile".into(), "-NoExit".into(), "-Command".into(), script];
        "powershell.exe".into()
    }
    #[cfg(not(target_os = "windows"))]
    {
        let array = |command: &str, args: &[String]| std::iter::once(command).chain(args.iter().map(String::as_str))
            .map(shell_literal).collect::<Vec<_>>().join(" ");
        let shell = std::env::var("SHELL").ok().filter(|value| Path::new(value).is_file()).unwrap_or_else(|| "/bin/bash".into());
        let script = format!(
            "{}\n__write_session_mapping() {{ :; }}\n__mycmux_is_windows_shell() {{ return 1; }}\n__MYCMUX_CODEX_RESUME_CMD=({})\n__MYCMUX_CODEX_FRESH_CMD=({})\n__mycmux_restore_codex\nexec {} -i",
            codex_restore_helpers(include_str!("../../launcher.sh")), array(command, args), array(fresh_command, fresh_args), shell_literal(&shell));
        *args = vec!["-c".into(), script];
        "/bin/bash".into()
    }
}

pub(super) fn codex_restore_diag_line(pty: &str, tab: Option<&str>, requested: Option<&str>, outcome: &str, reason: &str) -> String {
    let pty = if crate::commands::session_mapping::is_safe_mapping_id(pty) { pty } else { "<invalid>" };
    let tab = tab.filter(|id| is_uuid_like(id)).unwrap_or("<none>");
    let requested = match requested {
        Some(id) if is_uuid_like(id) => id,
        Some(id) if !id.trim().is_empty() => "<invalid>",
        _ => "<none>",
    };
    format!("[restore] codex pty={pty} tab={tab} requested={requested} outcome={outcome} reason={reason}")
}

pub(super) fn codex_restore_diag(pty: &str, tab: Option<&str>, requested: Option<&str>, outcome: &str, reason: &str) {
    crate::diag::log(&codex_restore_diag_line(pty, tab, requested, outcome, reason));
}

#[cfg(test)]
mod codex_restore_tests {
    use super::*;
    #[test]
    fn r7_4_native_detached_reason_reaches_missing_id_guidance_and_the_shared_helper() {
        let tab = "11111111-2222-4333-8444-555555555555";
        for command in ["codex", "bash", "powershell.exe"] {
            let env = HashMap::from([("MYCMUX_TAB_ID".into(), tab.into()), ("MYCMUX_PANE_SESSION_ID".into(), "pty-detached".into())]);
            let mut args = vec!["--no-alt-screen".into()];
            assert!(codex_restore_requested(command, &args, &env, Some("saved-codex-pane")));
            assert!(requested_conversation(command, &args, &env).is_none());
            let diagnostic = codex_restore_diag_line("pty-detached", Some(tab), None, "guidance", "missing-id");
            assert_eq!(diagnostic, format!("[restore] codex pty=pty-detached tab={tab} requested=<none> outcome=guidance reason=missing-id"));
            let wrapped = wrap_codex_restore("codex", &mut args, "codex", &["--no-alt-screen".into()]);
            assert!(matches!(wrapped.as_str(), "/bin/bash" | "powershell.exe"));
            assert!(args.last().unwrap().contains("Previous conversation could not be restored; starting a new session."));
        }
    }
    #[test]
    fn restore_diagnostics_join_ids_and_redact_non_id_payloads() {
        let id = "11111111-2222-4333-8444-555555555555";
        let line = codex_restore_diag_line("pty-id", Some(id), Some(id), "request", "saved-conversation");
        assert_eq!(line, format!("[restore] codex pty=pty-id tab={id} requested={id} outcome=request reason=saved-conversation"));
        let invalid = codex_restore_diag_line("../prompt\nsecret", Some("prompt"), Some("token=secret"), "validation", "malformed-id");
        assert!(!invalid.contains("secret") && !invalid.contains("prompt"));
        assert!(invalid.contains("requested=<invalid>"));
        assert_eq!(powershell_literal("C:\\a'b.ps1"), "'C:\\a''b.ps1'");
    }
    #[test]
    fn direct_restore_uses_the_same_helpers_as_the_launcher() {
        let mut args = vec!["resume".into(), "11111111-2222-4333-8444-555555555555".into()];
        let command = wrap_codex_restore("codex", &mut args, "codex", &["--no-alt-screen".into()]);
        let script = args.last().unwrap();
        assert!(script.contains("Previous conversation could not be restored; starting a new session."));
        assert!(!script.contains("--last"));
        #[cfg(windows)] { assert_eq!(command, "powershell.exe"); assert!(args.iter().any(|arg| arg == "-NoExit")); }
        #[cfg(not(windows))] { assert_eq!(command, "/bin/bash"); assert!(script.contains("__mycmux_restore_codex")); }
    }
    #[cfg(unix)]
    #[test]
    fn direct_shell_arguments_are_literals_even_with_prompt_metacharacters() {
        let value = "a'b;$(echo wrong) `echo wrong`\nsecond";
        let output = std::process::Command::new("/bin/bash").arg("-c")
            .arg(format!("printf %s {}", shell_literal(value))).env_clear().output().unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap(), value);
    }
}
