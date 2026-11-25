"""Setup-token stays behind the native trusted boundary; no CLI/network is executed."""
import re
import tomllib
import pytest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
COMMANDS = ("start_claude_setup_token", "submit_claude_setup_code", "cancel_claude_setup_token", "get_claude_setup_token_state")
SETUP = ROOT / "src-tauri/src/cli_accounts/setup_token.rs"
SCREEN = SETUP.with_name("setup_token_screen.rs")
WINDOWS_TEARDOWN = SETUP.with_name("setup_token_windows.rs")
COMMAND_SOURCE = ROOT / "src-tauri/src/commands/cli_accounts.rs"

def test_setup_token_commands_are_async_trusted_registered_and_local_only():
    commands = (ROOT / "src-tauri/src/commands/cli_accounts.rs").read_text(encoding="utf-8")
    registration = (ROOT / "src-tauri/src/lib.rs").read_text(encoding="utf-8")
    permissions = tomllib.loads((ROOT / "src-tauri/permissions/app-local.toml").read_text(encoding="utf-8"))
    local = next(item for item in permissions["set"] if item["identifier"] == "app-local")["permissions"]
    web = (ROOT / "src-tauri/capabilities/web-pane.json").read_text(encoding="utf-8")
    for name in COMMANDS:
        match = re.search(r"#\[tauri::command\(async\)\]\s*pub async fn " + name + r"\((.*?)\)\s*->", commands, re.S)
        assert match and "TrustedAppCaller" in match[1], name
        assert "commands::cli_accounts::" + name in registration
        permission = "allow-" + name.replace("_", "-")
        assert permission in local
        assert permission not in web

def test_setup_token_event_and_frontend_state_contain_only_non_secret_fields():
    source = (ROOT / "src-tauri/src/cli_accounts/setup_token.rs").read_text(encoding="utf-8")
    fields = re.search(r"pub struct SetupTokenEvent\s*\{(.*?)\n\}", source, re.S)
    assert fields
    assert set(re.findall(r"pub (\w+):", fields[1])) == {"login_id", "profile_id", "state", "url", "reason", "status"}
    frontend = (ROOT / "src/stores/claudeSetupTokenStore.ts").read_text(encoding="utf-8")
    assert not re.search(r"(?i)\b(?:token|transcript|output|buffer)\??\s*:", frontend)
    assert "persist(" not in frontend and "localStorage" not in frontend

FORBIDDEN_LOGGING = re.compile(
    r"(?:\b(?:log::|tracing::)|\b(?:e?print(?:ln)?|dbg)!\s*\(|"
    r"std::io::std(?:out|err)|use\s+crate::diag|"
    r"\bdiag_\w+!\s*\(|\bdiag::\w+\s*\(|\b(?:trace|debug|info|warn|error)!\s*\()"
)

def setup_command_bodies(source):
    return [re.search(r"pub async fn " + name + r"\([\s\S]*?\n\}", source)[0] for name in COMMANDS]

# Allow exactly one typed diagnostic with the fixed terminal schema.
TERMINAL_REPORT = r'''    fn warn(
        &self, failure: TerminalFailure, screen: ScreenCounts, unsupported: Option<ControlFamily>,
        code_accepted: bool, elapsed_s: u64,
    ) {
        let outcome = failure.outcome().code();
        let (reason, original, previous_reason) = match failure {
            TerminalFailure::Reason(original) => {
                let reason = match (original, unsupported) {
                    (FailureReason::Status(CaptureFailure::Timeout), Some(control)) =>
                        ScreenRejection::UncertainScreen(control).code(),
                    (FailureReason::Status(CaptureFailure::Timeout), None) =>
                        self.timeout_rejection.map_or(original.code(), ScreenRejection::code),
                    _ => original.code(),
                };
                (reason, Some(original), "none")
            }
            TerminalFailure::StopUnconfirmed(previous) =>
                ("stop_unconfirmed", previous, previous.map_or("none", FailureReason::code)),
        };
        let control = match original {
            Some(FailureReason::Screen(ScreenRejection::UncertainScreen(control))) => Some(control),
            _ => unsupported,
        }.map_or("none", ControlFamily::code);
        let exit_code = self.child_exit_code
            .map_or_else(|| "none".to_owned(), |code| code.to_string());
        let Self { received_bytes, enter_sent, .. } = self;
        let ScreenCounts { visible_rows, value_rows, heading_rows } = screen;
        let os = std::env::consts::OS;
        crate::diag::warn("claude_setup_token", &format!(
            "outcome={outcome} reason={reason} control={control} exit_code={exit_code} \
             previous_reason={previous_reason} received_bytes={received_bytes} \
             visible_rows={visible_rows} value_rows={value_rows} heading_rows={heading_rows} \
             enter_sent={enter_sent} code_accepted={code_accepted} elapsed_s={elapsed_s} os={os}",
        ));
    }'''
CAPTURE_REASON_CODES = {
    "Cancelled": "cancelled",
    "Timeout": "timeout",
    "CliError": "cli_error",
    "CaptureFailed": "capture_failed",
    "LaunchFailed": "launch_failed",
    "SaveFailed": "save_failed",
    "OwnerMismatch": "owner_mismatch",
    "ReplacementUnverified": "replacement_unverified",
    "OutputLimit": "output_limit",
}
SCREEN_REASON_CODES = {
    "NoHeading": "no_heading",
    "ValueLineNotToken": "value_line_not_token",
    "ValueLineCol512": "value_line_col512",
    "HeadingCol512": "heading_col512",
    "BelowNotBlankOrHint": "below_not_blank_or_hint",
    "ValueOnLastRow": "value_on_last_row",
    "ConflictingValueLines": "conflicting_value_lines",
    "UncertainScreen(_)": "uncertain_screen",
    "UncertainRow": "uncertain_row",
}
CONTROL_CODES = {
    "C0": "c0",
    "C1": "c1",
    "Escape": "escape",
    "Csi": "csi",
    "CsiR": "csi_r",
    "AltScreen": "alt_screen",
    "Osc": "osc",
    "Osc133": "osc_133",
    "IncompleteSequence": "incomplete_sequence",
}
FAILURE_REASON_ARMS = {
    "Self::Status(outcome) => outcome.code(),",
    "Self::Screen(rejection) => rejection.code(),",
    'Self::ChildExit(_) => "child_exit",',
    "#[cfg(unix)]",
    'Self::ChildSignal => "child_signal",',
    'Self::ChildWaitFailed => "child_wait_failed",',
    'Self::CodeWriteFailed => "code_write_failed",',
    'Self::ConfirmationFailed => "confirmation_failed",',
    'Self::OutputIncomplete => "output_incomplete",',
}

def code_arms(source, enum):
    impl = re.search(r"(?ms)^impl " + enum + r"\s*\{\n(.*?)^\}", source)
    assert impl, enum
    conversion = re.search(
        r"fn code\(self\) -> &'static str\s*\{\s*match self\s*\{([^{}]*)\}", impl[1]
    )
    assert conversion, enum
    return [line.strip() for line in conversion[1].strip().splitlines()]

def assert_no_setup_logging(source, screen, teardown, commands):
    assert source.count(TERMINAL_REPORT) == 1, "the terminal diagnostic must use the exact typed schema"
    for pattern in [
        r"struct ScreenCounts\s*\{\s*visible_rows: usize,\s*value_rows: usize,\s*heading_rows: usize,\s*\}",
        r"struct AttemptDiagnostics\s*\{\s*received_bytes: usize,\s*enter_sent: bool,\s*"
        r"timeout_rejection: Option<ScreenRejection>,\s*child_exit_code: Option<u32>,\s*\}",
        r"enum ScreenRejection\s*\{[^{}]*\bUncertainScreen\(ControlFamily\),[^{}]*\}",
        r"enum FailureReason\s*\{[^{}]*\bChildExit\(u32\),[^{}]*\}",
        r"enum TerminalFailure\s*\{\s*Reason\(FailureReason\),\s*StopUnconfirmed\(Option<FailureReason>\),\s*\}",
    ]:
        assert re.search(pattern, source), pattern

    variants = re.search(r"enum CaptureFailure\s*\{([^{}]*)\}", source)
    assert variants
    declared = [variant.strip() for variant in variants[1].split(",") if variant.strip()]
    assert len(declared) == len(CAPTURE_REASON_CODES) and set(declared) == set(CAPTURE_REASON_CODES)
    for text, enum, codes in [
        (source, "CaptureFailure", CAPTURE_REASON_CODES),
        (source, "ScreenRejection", SCREEN_REASON_CODES),
        (screen, "ControlFamily", CONTROL_CODES),
    ]:
        arms = code_arms(text, enum)
        assert len(arms) == len(codes)
        assert set(arms) == {f'Self::{variant} => "{code}",' for variant, code in codes.items()}
    detail_arms = code_arms(source, "FailureReason")
    assert len(detail_arms) == len(FAILURE_REASON_ARMS) and set(detail_arms) == FAILURE_REASON_ARMS

    for boundary in [source.replace(TERMINAL_REPORT, "", 1), screen, teardown, *setup_command_bodies(commands)]:
        assert not FORBIDDEN_LOGGING.search(boundary)

def test_setup_token_module_allows_only_the_unconfirmed_stop_diagnostic():
    source = SETUP.read_text(encoding="utf-8")
    assert_no_setup_logging(source, SCREEN.read_text(encoding="utf-8"),
                            WINDOWS_TEARDOWN.read_text(encoding="utf-8"), COMMAND_SOURCE.read_text(encoding="utf-8"))
    assert "1024 * 1024" in source
    assert "save_with_outcome" in source
    assert "cleanup_staging" in source

@pytest.mark.parametrize(("old", "new"), [
    ('Self::Timeout => "timeout",', 'Self::Timeout => "unknown",'),
    ('Self::OutputLimit => "output_limit",', 'Self::OutputLimit => "output_limit extra",'),
    ('    OutputLimit,\n}', '    OutputLimit,\n    Other,\n}'),
    pytest.param(
        'map_or("none", FailureReason::code)', 'map_or("none extra", FailureReason::code)',
        id='map_or("none", CaptureFailure::code)-map_or("none extra", CaptureFailure::code)',
    ),
    ('previous_reason={previous_reason}', 'previous_reason={previous_reason} extra'),
])
def test_setup_token_diagnostic_rejects_extra_reasons_and_text(old, new):
    source = SETUP.read_text(encoding="utf-8")
    assert old in source
    with pytest.raises(AssertionError):
        assert_no_setup_logging(source.replace(old, new, 1), SCREEN.read_text(encoding="utf-8"),
                                WINDOWS_TEARDOWN.read_text(encoding="utf-8"), COMMAND_SOURCE.read_text(encoding="utf-8"))

@pytest.mark.parametrize("snippet", [
    'crate::diag::warn("fixture");', 'diag_warn!("fixture");', 'warn!("fixture");',
    'log::info!("fixture");', 'tracing::info!("fixture");', 'println!("fixture");',
    'eprintln!("fixture");', 'dbg!("fixture");',
    'print!("fixture");', 'eprint!("fixture");',
    'std::io::stdout();', 'std::io::stderr();',
    'use crate::diag::warn; warn("fixture");',
    'crate::diag::warn("claude_setup_token", &format!("stop_unconfirmed previous_reason={raw:?}"));',
])
@pytest.mark.parametrize("boundary", ["module", "windows_teardown", *COMMANDS])
def test_setup_token_logging_guard_rejects_logging_in_module_and_each_command(snippet, boundary):
    source = SETUP.read_text(encoding="utf-8")
    screen = SCREEN.read_text(encoding="utf-8")
    teardown = WINDOWS_TEARDOWN.read_text(encoding="utf-8")
    commands = COMMAND_SOURCE.read_text(encoding="utf-8")
    assert_no_setup_logging(source, screen, teardown, commands)
    if boundary == "module":
        with pytest.raises(AssertionError):
            assert_no_setup_logging(source, screen + "\n" + snippet, teardown, commands)
        source += "\n" + snippet
    elif boundary == "windows_teardown":
        teardown += "\n" + snippet
    else:
        original = setup_command_bodies(commands)[COMMANDS.index(boundary)]
        commands = commands.replace(original, original[:-1] + "    " + snippet + "\n}", 1)
    with pytest.raises(AssertionError):
        assert_no_setup_logging(source, screen, teardown, commands)


def assert_macos_login_path_reaches_setup_command(commands):
    body = setup_command_bodies(commands)[0]
    binding = re.search(
        r'#\[cfg\(target_os\s*=\s*"macos"\)\]\s*let\s+(\w+)\s*=\s*'
        r'crate::commands::shell::login_shell_path\(&app\)\s*;', body
    )
    assert binding, "macOS must obtain the same login-shell PATH as normal tab launch"
    assert re.search(r'\bnative_command\(\s*' + re.escape(binding[1]) + r'\s*\)', body), (
        "the login-shell PATH must reach native_command in start_claude_setup_token"
    )

def test_setup_token_macos_login_path_is_wired_into_the_native_command():
    commands = (ROOT / "src-tauri/src/commands/cli_accounts.rs").read_text(encoding="utf-8")
    assert_macos_login_path_reaches_setup_command(commands)

def test_setup_token_macos_login_path_contract_rejects_none_in_memory():
    commands = (ROOT / "src-tauri/src/commands/cli_accounts.rs").read_text(encoding="utf-8")
    body = setup_command_bodies(commands)[0]
    mutated = body.replace("native_command(login_path)", "native_command(None)", 1)
    assert mutated != body
    with pytest.raises(AssertionError):
        assert_macos_login_path_reaches_setup_command(commands.replace(body, mutated, 1))


def test_setup_token_shutdown_runs_inside_cleanup_before_kill_and_waits_after_hooks():
    source = (ROOT / "src-tauri/src/commands/window.rs").read_text(encoding="utf-8")
    start = source.index("match crate::shutdown::Cleanup::start(")
    end = source.index("\n        }) {", start)
    worker = source[start:end]
    assert "worker_app.state::<Arc<crate::cli_accounts::setup_token::SetupTokenRegistry>>()" in worker
    begin = worker.index("setup_tokens.close_for_exit()")
    assert begin < worker.index("flush_at_exit") < worker.index("session_manager.kill_all()")
    wait = worker.index(".wait_idle(deadline)")
    hooks = worker.index("hook_service.revoke_all()")
    assert hooks < wait
    assert "if std::time::Instant::now() < deadline" in worker[hooks:wait]
    assert "SetupShutdown::TimedOut" in worker[wait:]
    assert 'crate::diag_warn!("shutdown", "setup-token shutdown timed out")' in worker[wait:]
