"""Private homes must never enter global credential capture/refresh/cleanup."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")

def function(source: str, name: str) -> str:
    start = re.search(rf"(?m)^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+{name}(?:<[^\n]*?>)?\s*\(", source)
    assert start, name
    next_function = re.search(r"(?m)^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+", source[start.end():])
    return source[start.start():start.end()+next_function.start()] if next_function else source[start.start():]

FORBIDDEN = r"\b(?:capture_staged|capture_account_with_grok|cleanup_staging|sweep_stale_staging)\s*\(|\blive_sync\s*::|\busage\s*::"

def test_home_module_has_no_global_capture_refresh_cleanup_or_usage_dependency():
    source = read("src-tauri/src/cli_accounts/account_homes.rs")
    code = re.sub(r"(?m)^\s*//.*$", "", source)
    assert not re.search(FORBIDDEN, code)
    assert not re.search(r"std::env::(?:set_var|remove_var)\s*\(", code)
    assert not re.search(r"(?:remove_dir|remove_dir_all)\s*\(", code)
    assert 'staging::login_command(pending.key.provider)' in source
    owner = function(source, "check_owner")
    for provider in ("codex", "grok"):
        assert f"{provider}::read_live_identity" in owner
    assert 'home.join("auth.json")' in owner
    assert "resolve()" not in owner
    assert not re.search(r'write_private\([^;]*auth\.json', source, re.S)

def test_private_begin_branch_returns_before_the_global_staging_workflow():
    source = function(read("src-tauri/src/commands/cli_accounts.rs"), "begin_cli_login")
    start = source.index("if let Some(cli_accounts::account_homes::LoginPurpose::AccountHome")
    end = source.index("let login_mode", start)
    branch = source[start:end]
    assert "account_homes::begin_login" in branch
    assert "account_homes::spawn_login_watch" in branch
    assert "return Ok(CliLoginSession" in branch
    assert not re.search(FORBIDDEN, branch)
    assert "staging::create_staging_dir" not in branch
    assert "staging::create_staging_dir" in source[end:]
    assert "staging::cleanup_staging" in source[end:]

def test_private_login_and_account_launch_resolve_only_backend_owned_paths():
    source = read("src-tauri/src/commands/terminal.rs")
    for name in ("resolve_registered_launch_context", "take_cli_login_launch"):
        assert not re.search(FORBIDDEN, function(source, name))
    login = function(source, "take_cli_login_launch")
    assert 'env.remove("MYCMUX_CLI_LOGIN_ID")' in login
    assert "account_homes::claim_login" in login
    assert "LoginRegistry>().claim_launch" in login
    assert not re.search(r'PathBuf::from\([^\n]*env', login)
    create = source[source.index("fn create_session_blocking("):source.index("pub(crate) fn prepare_spawn_command(")]
    assert create.index("resolve_launch_account(") < create.index("validate_agent_restore_request_with_home(")
    assert create.index("sanitize_launch_env(&mut env_map);") < create.index("context.apply_env(&mut env_map)") < create.index("state.session_manager.create(")
    assert "account_context.is_some() { return Err(" in create
    assert "account_context.is_none()" in create[create.index("let command = if let Some(mut fresh_args)"):]
    session = read("src-tauri/src/pty/session.rs")
    assert session.index("scrub_account_home_parent_env(&mut cmd, env.as_ref());") < session.index("for (k, v) in extra_env")
    scrub = function(session, "scrub_account_home_parent_env")
    assert "iter_full_env_as_str()" in scrub and "cmd.env_remove(name)" in scrub

def test_private_login_frontend_never_supplies_a_home_or_offers_a_global_switch():
    source = read("src/stores/cliLoginStore.ts")
    start = source.index("async function openLoginTab(")
    tab = source[start:source.index("function closeLoginTab(", start)]
    assert "launchEnv: { MYCMUX_CLI_LOGIN_ID: session.login_id }" in tab
    assert "session.env" not in tab and "commandArgv:" not in tab
    start = source.index('if (payload.purpose?.kind === "account_home"')
    private = source[start:source.index("const label = payload.profile.label", start)]
    assert "return;" in private
    for forbidden in ("offerSwitch(", "useUsageStore", "captureCliAccount", "switchTo("):
        assert forbidden not in private
    assert "offerSwitch(provider, payload.profile)" in source

def test_global_synchronization_and_usage_do_not_discover_private_homes():
    paths = [ROOT / "src-tauri/src/cli_accounts/live_sync.rs", *sorted((ROOT / "src-tauri/src/usage").rglob("*.rs"))]
    for path in paths:
        source = path.read_text(encoding="utf-8")
        assert "cli_account_homes" not in source and "account_homes::" not in source, str(path.relative_to(ROOT))

def test_public_status_types_and_context_debug_do_not_serialize_home_paths():
    source = read("src-tauri/src/cli_accounts/account_homes.rs")
    for struct in ("AccountHomeStatus", "HomeLoginStatus"):
        declaration = source.split(f"pub struct {struct} {{", 1)[1].split("\n}", 1)[0]
        assert "Path" not in declaration and "token" not in declaration and "auth_text" not in declaration
    debug = source.split("impl std::fmt::Debug for AccountLaunchContext", 1)[1].split("impl AccountLaunchContext", 1)[0]
    assert '.field("home"' not in debug and "self.home" not in debug
