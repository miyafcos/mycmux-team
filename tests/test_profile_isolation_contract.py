from __future__ import annotations

import re
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_repo_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def contains_ignoring_layout(haystack: str, needle: str) -> bool:
    """Match a Rust snippet without pinning rustfmt's line breaks.

    These assertions care that a construct exists, not where the formatter chose
    to wrap it. Comparing with every whitespace run removed keeps the intent and
    stops a reformat from turning a passing contract into a red one.
    """
    return _squeeze(needle) in _squeeze(haystack)


def _squeeze(text: str) -> str:
    return re.sub(r"\s+", "", text)


def test_rust_profile_isolation_uses_the_runtime_directory() -> None:
    targets = [
        "src-tauri/src/commands/session_mapping.rs",
        "src-tauri/src/remote/auth.rs",
        "src-tauri/src/remote/mod.rs",
        "src-tauri/src/commands/artifact/mod.rs",
        "src-tauri/src/commands/online.rs",
        "src-tauri/src/commands/online_publish.rs",
        "src-tauri/src/commands/online/transfer.rs",
    ]

    for target in targets:
        text = read_repo_text(target)
        production_text = text.split("#[cfg(test)]", 1)[0]
        assert 'home.join(".mycmux")' not in production_text, target
        assert '"/.mycmux/"' not in production_text, target
        assert "crate::test_profile::runtime_dir" in text, target

    for target in ["src/lib/agents.ts", "src/components/workspace/TerminalPane.tsx"]:
        assert '"/.mycmux/"' not in read_repo_text(target), target


def test_frontend_profile_isolation_resolves_runtime_paths_from_ipc() -> None:
    agents = read_repo_text("src/lib/agents.ts")
    terminal_pane = read_repo_text("src/components/workspace/TerminalPane.tsx")

    assert 'invoke<string | null>("get_test_profile")' in agents
    assert '`.mycmux-${profile}`' in agents
    assert 'invoke<string | null>("get_test_profile")' in terminal_pane
    assert '`.mycmux-${testProfile}`' in terminal_pane
    assert "testProfile === undefined" in terminal_pane
    assert "catch(() => setTestProfile(undefined))" in terminal_pane
    assert "let _runtimeLeaf: string | undefined;" in agents
    assert "Unknown profile state must not launch through production paths" in agents


def test_profile_account_consumers_and_mutations_do_not_reach_production_app_data() -> None:
    cli_commands = read_repo_text("src-tauri/src/commands/cli_accounts.rs")
    usage = read_repo_text("src-tauri/src/commands/usage.rs")
    orphan = read_repo_text("src-tauri/src/cli_accounts/mod.rs")

    for text in [cli_commands, usage, orphan]:
        assert "test_profile::app_data_dir_from" in text
    assert "CLI account switching is disabled while a test profile is active" in cli_commands


def test_profile_blocks_shared_pet_mutations() -> None:
    gallery = read_repo_text("src-tauri/src/commands/pet_gallery.rs")

    assert "ensure_pet_mutation_allowed(crate::test_profile::is_active())?" in gallery
    assert gallery.count("ensure_pet_mutation_allowed(crate::test_profile::is_active())?") == 3


def test_profile_launcher_and_transcript_fallbacks_are_fail_closed() -> None:
    launcher_sh = read_repo_text("src-tauri/src/launcher.sh")
    launcher_ps1 = read_repo_text("src-tauri/src/launcher.ps1")
    terminal = read_repo_text("src-tauri/src/commands/terminal.rs")
    transcripts = read_repo_text("src-tauri/src/pty/monitor/transcripts.rs")

    assert '__LAUNCH_RUNTIME_DIR="${MYCMUX_RUNTIME_DIR:-$HOME/.mycmux}"' in launcher_sh
    assert '"$__LAUNCH_RUNTIME_DIR/bin/launcher.local.sh"' in launcher_sh
    assert '[ "${MYCMUX_TEST_PROFILE:-}" = "1" ] && return 0' in launcher_sh
    assert "$localRuntimeDir = if ($env:MYCMUX_RUNTIME_DIR)" in launcher_ps1
    assert '"MYCMUX_TEST_PROFILE".to_string(), "1".to_string()' in terminal
    assert transcripts.count("if crate::test_profile::is_active() {") >= 3


def test_profile_remote_binds_ephemeral_port_and_persists_the_bound_value() -> None:
    remote = read_repo_text("src-tauri/src/remote/mod.rs")
    script = read_repo_text("scripts/test-profile.ps1")

    assert contains_ignoring_layout(remote, "unwrap_or(if profile_active { 0 } else { 7682 })")
    assert contains_ignoring_layout(remote, "listener.local_addr()")
    assert contains_ignoring_layout(remote, "control.set_port(port);")
    assert contains_ignoring_layout(remote, 'path.push("remote.port")')
    assert "MYCMUX_REMOTE_PORT" in script


def test_profile_intervention_audit_uses_runtime_directory() -> None:
    intervene = read_repo_text("src-tauri/src/livebrief/intervene.rs")
    assert "let dir = crate::test_profile::runtime_dir()?;" in intervene


def test_profile_clone_strips_every_agent_resume_field_from_panes_and_tabs() -> None:
    script = read_repo_text("scripts/test-profile.ps1")
    expected_keys = [
        "agent_session_id",
        "claude_session_id",
        "agent_kind",
        "suppressed_agent_sessions",
        "launch_env",
        "terminal_snapshot",
    ]

    assert "@($live.workspaces)" in script
    assert "@($workspace.panes)" in script
    assert "@($pane.tabs)" in script
    assert "@($pane) + @($pane.tabs)" in script
    for key in expected_keys:
        assert f"'{key}'" in script
    assert "$record.PSObject.Properties.Remove($key)" in script
    assert "Write-Host \"Seeded the layout" in script
    assert "System.Text.UTF8Encoding($false)" in script
    assert "[IO.File]::WriteAllText" in script


def test_profile_fresh_start_rotates_all_mutable_runtime_state() -> None:
    script = read_repo_text("scripts/test-profile.ps1")

    assert "$runtimeMutableState = @(" in script
    assert "foreach ($stale in $runtimeMutableState)" in script
    for path in [
        "savepoint.json",
        "savepoints",
        "ailog.db",
        "ailog.db-wal",
        "ailog.db-shm",
    ]:
        assert f"'{path}'" in script


def test_profile_clone_ailog_copies_sqlite_sidecars_and_scrubs_remote_port() -> None:
    script = read_repo_text("scripts/test-profile.ps1")

    assert "foreach ($suffix in @('', '-wal', '-shm'))" in script
    assert "MYCMUX_REMOTE_PORT" in script
