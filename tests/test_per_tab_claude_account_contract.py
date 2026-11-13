"""R-10: the actual create path must fail before allocating a PTY."""
from pathlib import Path
import re
import pytest

ROOT = Path(__file__).resolve().parents[1]

def test_v2_evidence_is_captured_only_for_a_new_successful_pty():
    source = (ROOT / "src-tauri/src/commands/terminal.rs").read_text(encoding="utf-8")
    create = source[source.index("fn create_session_blocking("):source.index("pub(crate) fn prepare_spawn_command(")]
    assert create.index("TabAccountEvidence::claude(&loaded.status)") < create.index("state.session_manager.create(")
    assert create.index("created?;") < create.index("tab_evidence::remember(")
    assert create.index("tab_evidence::remember(") < create.index('app_handle.emit("tab-account-evidence-updated"')
    assert re.search(r"if !reattach \{\s*if let Some\(\(base, evidence\)\) = pending_account_evidence", create)
    assert "if !reattach && login_launch.is_none()" in create


def test_v2_evidence_commands_are_trusted_async_and_not_sync_allowlisted():
    source = (ROOT / "src-tauri/src/commands/cli_accounts.rs").read_text(encoding="utf-8")
    for name in ("get_tab_account_evidence", "recheck_tab_account", "recheck_cli_launch_token"):
        assert re.search(r"#\[tauri::command\(async\)\]\s*pub async fn " + name + r"\(\s*_trusted: crate::ipc_caller::TrustedAppCaller", source)


def test_v2_home_recheck_keeps_the_identity_reader_shallow():
    source = (ROOT / "src-tauri/src/cli_accounts/account_homes.rs").read_text(encoding="utf-8")
    start = source.index("pub(crate) fn recheck_owner(")
    body = source[start:source.index("/// Unregister", start)]
    assert "home_path(base, provider, id, false, false)" in body
    assert "check_owner(&home, provider, &profile.identity_key)" in body
    assert "read_dir" not in body


def test_claude_launch_account_is_consumed_after_sanitizing_before_pty_creation():
    source = (ROOT / "src-tauri/src/commands/terminal.rs").read_text(encoding="utf-8")
    create = source[source.index("fn create_session_blocking("):source.index("pub(crate) fn prepare_spawn_command(")]
    assert create.count("inject_claude_launch_account(") == 1
    assert "inject_claude_launch_account(&mut env_map, &requested_command, reattach," in create
    scrub = create.index("sanitize_launch_env(&mut env_map);")
    inject = create.index("inject_claude_launch_account(&mut env_map, &requested_command,")
    spawn = create.index("state.session_manager.create(")
    assert scrub < inject < spawn
    assert re.search(r"inject_claude_launch_account\(.*?chrono::Utc::now\(\)\)\?;", create, re.S)
    assert "launch_tokens::load_for_launch(&base, profile_id)" in create[inject:spawn]
    assert "test_profile::app_data_dir_from(default_dir)" in create[inject:spawn]

def test_e2e_capture_receives_only_the_redacted_environment():
    source = (ROOT / "src-tauri/src/commands/terminal.rs").read_text(encoding="utf-8")
    start = source.index("let capture_env = env_map.iter()")
    end = source.index("codex_restore_harness::capture_launch(", start)
    assert 'filter(|(key, _)| !key.eq_ignore_ascii_case("CLAUDE_CODE_OAUTH_TOKEN"))' in source[start:end]
    assert "&capture_env)" in source[end:source.index(";", end)]
    assert not re.search(r"capture_launch\([^;]*&env_map", source)


def test_rv02_launch_owner_client_has_a_dedicated_transport_boundary():
    source = (ROOT / "src-tauri/src/cli_accounts/token_owner.rs").read_text(encoding="utf-8")
    start = source.index("fn launch_owner_client_builder(")
    builder = source[start:source.index("/// Both lookups", start)]
    assert ".redirect(reqwest::redirect::Policy::none())" in builder
    assert ".https_only(true)" in builder
    lookup = source[source.index("pub async fn fetch_claude_launch_owner("):source.index("async fn fetch_claude_launch_owner_at(")]
    assert "launch_owner_client_builder().build()" in lookup
    assert "OwnerCheck::Unavailable" in lookup
    assert "OrganizationCheck::Unavailable" in lookup
    commands = (ROOT / "src-tauri/src/commands/cli_accounts.rs").read_text(encoding="utf-8")
    for name in ("set_cli_launch_token", "recheck_cli_launch_token", "recheck_tab_account"):
        start = commands.index("pub async fn " + name + "(")
        body = commands[start:commands.index("\n}", start) + 2]
        assert "fetch_claude_launch_owner(token)" in body
        assert "UsageState" not in body


def test_rv03_profile_and_org_share_a_bounded_streaming_body_reader():
    source = (ROOT / "src-tauri/src/cli_accounts/token_owner.rs").read_text(encoding="utf-8")
    assert "const OWNER_RESPONSE_LIMIT: usize = 256 * 1024;" in source
    start = source.index("async fn read_owner_response(")
    reader = source[start:source.index("pub async fn fetch_claude_token_organization_at(", start)]
    assert "response.content_length()" in reader
    assert reader.index("response.content_length()") < reader.index("response.chunk().await")
    assert "OWNER_RESPONSE_LIMIT - body.len()" in reader
    for name in ("fetch_claude_token_owner_at", "fetch_claude_token_organization_at"):
        start = source.index("pub async fn " + name + "(")
        body = source[start:source.index("\npub ", start + 1)]
        assert "read_owner_response(response).await" in body
        assert "response.text()" not in body


@pytest.mark.parametrize(("name", "profile"), [
    ("set_cli_launch_token", "result.profile_id"), ("remove_cli_launch_token", "removed_profile_id"),
])
def test_rv04_token_mutations_emit_only_profile_id_after_success(name, profile):
    source = (ROOT / "src-tauri/src/commands/cli_accounts.rs").read_text(encoding="utf-8")
    start = source.index("pub async fn " + name + "(")
    body = source[start:source.index("\n}", start) + 2]
    event = 'app.emit("tab-account-evidence-updated", serde_json::json!({ "profile_id": ' + profile + ' }))'
    assert event in body
    success = body.index('.await.map_err(')
    emitted = body.index(event)
    assert success < body.index('??;', success) < emitted
    assert body.count('app.emit(') == 1
    assert 'Ok(' in body[emitted:]


def test_rc01_saved_mismatch_emits_profile_id_before_error():
    source = (ROOT / "src-tauri/src/commands/cli_accounts.rs").read_text(encoding="utf-8")
    start = source.index("pub async fn set_cli_launch_token(")
    body = source[start:source.index("\n}", start) + 2]
    assert "launch_tokens::save_with_outcome(" in body
    assert "SaveOutcome::Saved(" in body
    assert "SaveOutcome::MismatchRecorded(" in body
    assert body.count("app.emit(") == 1
    emitted = body.index('app.emit("tab-account-evidence-updated"')
    saved = body.index("??;", body.index(".await.map_err("))
    mismatch_error = body.index("Err(cli_accounts::ERR_LAUNCH_TOKEN_OWNER_MISMATCH.into())")
    success = body.index("Ok(")
    assert saved < emitted < mismatch_error < success
    payloads = re.findall(r"serde_json::json!\(\s*\{([^}]*)\}\s*\)", body)
    assert len(payloads) == 1
    assert re.fullmatch(r'\s*"profile_id":\s*result\.profile_id\s*', payloads[0])


def test_rc02_tab_recheck_notifies_saved_token_profile_once():
    source = (ROOT / "src-tauri/src/commands/cli_accounts.rs").read_text(encoding="utf-8")
    start = source.index("pub async fn recheck_tab_account(")
    body = source[start:source.index("\n}", start) + 2]
    assert "tab_evidence::recheck_with_outcome(" in body
    assert body.count("app.emit(") == 1
    joined = body.index(".await.map_err(")
    emitted = body.index('app.emit("tab-account-evidence-updated"')
    assert "ERR_ACCOUNTS_UNAVAILABLE.to_string())?;" in body[joined:emitted]
    assert "??;" not in body[joined:emitted]
    selection = re.search(
        r"let profile_id = outcome\.token_record_saved_for\.as_ref\(\)\.or_else\(\|\| "
        r"match outcome\.result\.as_ref\(\) \{\s*"
        r"Ok\(Some\(evidence\)\) => Some\(&evidence\.profile_id\),\s*"
        r"_ => None,\s*\}\);", body,
    )
    assert selection is not None
    guarded = body.index("if let Some(profile_id) = profile_id {")
    returned = body.rindex("outcome.result")
    assert joined < selection.start() < guarded < emitted < returned
    assert re.search(r"\boutcome\.result\s*\}$", body)
    payloads = re.findall(r"serde_json::json!\(\s*\{([^}]*)\}\s*\)", body)
    assert len(payloads) == 1
    assert re.fullmatch(r'\s*"profile_id":\s*profile_id\s*', payloads[0])
