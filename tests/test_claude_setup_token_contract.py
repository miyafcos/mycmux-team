"""Setup-token stays behind the native trusted boundary; no CLI/network is executed."""
import re
import tomllib
import pytest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
COMMANDS = ("start_claude_setup_token", "submit_claude_setup_code", "cancel_claude_setup_token", "get_claude_setup_token_state")

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

def assert_no_setup_logging(source, commands):
    for boundary in [source, *setup_command_bodies(commands)]:
        assert not FORBIDDEN_LOGGING.search(boundary)

def test_setup_token_module_has_no_output_logging_or_diagnostics():
    source = (ROOT / "src-tauri/src/cli_accounts/setup_token.rs").read_text(encoding="utf-8")
    commands = (ROOT / "src-tauri/src/commands/cli_accounts.rs").read_text(encoding="utf-8")
    assert_no_setup_logging(source, commands)
    assert "1024 * 1024" in source
    assert "save_with_outcome" in source
    assert "cleanup_staging" in source

@pytest.mark.parametrize("snippet", [
    'crate::diag::warn("fixture");', 'diag_warn!("fixture");', 'warn!("fixture");',
    'log::info!("fixture");', 'tracing::info!("fixture");', 'println!("fixture");',
    'eprintln!("fixture");', 'dbg!("fixture");',
    'print!("fixture");', 'eprint!("fixture");',
    'std::io::stdout();', 'std::io::stderr();',
    'use crate::diag::warn; warn("fixture");',
])
@pytest.mark.parametrize("boundary", ["module", *COMMANDS])
def test_setup_token_logging_guard_rejects_logging_in_module_and_each_command(snippet, boundary):
    source = (ROOT / "src-tauri/src/cli_accounts/setup_token.rs").read_text(encoding="utf-8")
    commands = (ROOT / "src-tauri/src/commands/cli_accounts.rs").read_text(encoding="utf-8")
    if boundary == "module":
        source += "\n" + snippet
    else:
        original = setup_command_bodies(commands)[COMMANDS.index(boundary)]
        commands = commands.replace(original, original[:-1] + "    " + snippet + "\n}", 1)
    with pytest.raises(AssertionError):
        assert_no_setup_logging(source, commands)


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
