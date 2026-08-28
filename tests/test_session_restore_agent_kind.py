from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_repo_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def assert_contains(text: str, snippet: str, source: str) -> None:
    assert snippet in text, f"Missing snippet in {source}: {snippet}"


def test_agent_kind_round_trip_contract_remains_wired() -> None:
    socket_listener = read_repo_text("src/components/layout/SocketListener.tsx")
    storage = read_repo_text("src-tauri/src/db/storage.rs")
    layout_store = read_repo_text("src/stores/workspaceLayoutStore.ts")
    launcher_ps1 = read_repo_text("src-tauri/src/launcher.ps1")
    launcher_sh = read_repo_text("src-tauri/src/launcher.sh")
    session_mapping = read_repo_text("src-tauri/src/commands/session_mapping.rs")
    monitor_paths = [
        "src-tauri/src/pty/monitor.rs",
        "src-tauri/src/pty/monitor/detection.rs",
        "src-tauri/src/pty/monitor/git_branch.rs",
        "src-tauri/src/pty/monitor/runner.rs",
        "src-tauri/src/pty/monitor/transcripts.rs",
    ]
    monitor = "\n".join(read_repo_text(path) for path in monitor_paths)
    monitor_source = ", ".join(monitor_paths)

    for snippet in [
        "agent_kind: liveKind",
        "agent_session_id: liveAgentId",
        "const isActivePersistedTab = tab.id === activeTab.id;",
        "const declared = isDeclaredTab(tab);",
        "const tabKind = declared",
        "const tabAgentId = declared",
        "const tabClaudeId = declared",
        "agent_kind: tabKind",
        "agent_session_id: tabAgentId",
        "suppressed_agent_sessions: declared",
        "terminal_snapshot: declared",
        "agent_kind: tabConfig.agent_kind ?? mappingKind",
        "agentMappings[tabId]",
        "clearDuplicateTabAgentSession(cleanedTab)",
        "function getPaneAgentSessionKey(pane: PaneConfig): string | null",
        "function clearDuplicatePaneAgentSession(pane: PaneConfig): PaneConfig",
        "function normalizeAgentSessionPane(pane: PaneConfig): PaneConfig",
        "candidateId: `${workspaceIndex}:${paneIndex}:pane`",
        "clearDuplicatePaneAgentSession(pane)",
        "clearStaleAgentErrorSnapshot(tab)",
        "terminal_snapshot: null",
    ]:
        assert_contains(snippet=snippet, text=socket_listener, source="src/components/layout/SocketListener.tsx")

    assert_contains(storage, "pub agent_kind: Option<String>", "src-tauri/src/db/storage.rs")
    assert_contains(storage, "#[serde(default)]\n    pub agent_kind", "src-tauri/src/db/storage.rs")
    assert_contains(storage, "pub suppressed_agent_sessions: Option<Vec<SuppressedAgentSessionConfig>>", "src-tauri/src/db/storage.rs")

    for snippet in [
        "const tabAgentKind =",
        "tabConfig.agent_kind",
        "const tabAgentSessionId =",
        "agentKind: tabAgentKind",
        "agentSessionId: tabAgentSessionId",
        ": restoreSuppressedAgentSessions(tabConfig.suppressed_agent_sessions)",
        "const activeTabDeclared = isDeclaredTab(activeTab);",
        "agentKind: activeTabDeclared",
        "agentSessionId: activeTabDeclared",
        "suppressedAgentSessions: activeTabDeclared",
        ]:
        assert_contains(layout_store, snippet, "src/stores/workspaceLayoutStore.ts")

    for snippet in [
        "function Write-MycmuxSessionMapping",
        "[System.IO.File]::WriteAllText",
        "function Get-MycmuxClaudeProjectDir",
        "function Get-MycmuxClaudeProjectKey",
        "function Get-MycmuxClaudeCodexProjectDir",
        "function Get-MycmuxStableSessionId",
        "function Find-MycmuxClaudeSessionFile",
        "function Get-MycmuxClaudeSessionCwd",
        "function Set-MycmuxClaudeResumeLocation",
        'Sort-Object -Property @{ Expression = "LastWriteTimeUtc"; Descending = $true }',
        '"[^A-Za-z0-9-]"',
        "function Start-MycmuxSessionTracking",
        "function Start-MycmuxCommandSessionTracking",
        "function Invoke-MycmuxResumeFromEnv",
        "MYCMUX_RESUME",
        'MYCMUX_RESUME_FORK -eq "1"',
        "--fork-session",
        "Normalize-MycmuxTrackingCwd",
        "Get-MycmuxTrackingCandidate",
        "Resolve-Path -LiteralPath $Path",
        "$remainingCandidates.Count -ne 1",
        'Start-MycmuxSessionTracking $env:MYCMUX_PANE_SESSION_ID "claude-codex"',
        'Start-MycmuxSessionTracking $env:MYCMUX_PANE_SESSION_ID "claude"',
        'Start-MycmuxSessionTracking $env:MYCMUX_PANE_SESSION_ID "codex"',
        '@("codex", "resume", "--no-alt-screen", $env:MYCMUX_SESSION_ID)',
    ]:
        assert_contains(launcher_ps1, snippet, "src-tauri/src/launcher.ps1")

    for snippet in [
        "__claude_project_key()",
        "__find_claude_session_file()",
        "__claude_session_cwd()",
        "__prepare_claude_resume()",
        "print(max(candidates)[2])",
        're.sub(r"[^A-Za-z0-9-]", "-", cwd)',
        'if __prepare_claude_resume "$MYCMUX_SESSION_ID"; then',
        'if [ "${MYCMUX_RESUME_FORK:-}" = "1" ]; then',
        "--fork-session",
        "__single_unclaimed_session_since()",
        "os.path.realpath(value)",
        "if len(candidates) == 1:",
    ]:
        assert_contains(launcher_sh, snippet, "src-tauri/src/launcher.sh")

    for snippet in [
        "fn write_detected_agent_session_mapping(",
        "fn collect_explicit_agent_session_ids(",
        # Tick-start reservation of cached heuristic detections: without it,
        # same-cwd panes steal each other's session ids across ticks.
        "let explicit_agent_session_ids = collect_explicit_agent_session_ids(&sys);",
        "let cached_agent_session_owners = reserve_cached_agent_session_ids(",
        "fn reserve_cached_agent_session_ids(",
        "fn agent_session_id_exclusions_for_pane(",
        "&claimed_agent_session_ids",
        'arg.eq_ignore_ascii_case("--fork-session")',
        "crate::commands::session_mapping::write_session_mapping_file(",
        "write_detected_agent_session_mapping(",
        'agent_session_id.as_deref()',
    ]:
        assert_contains(monitor, snippet, monitor_source)

    for snippet in [
        "fn write_session_mapping_file_to_dir(",
            'crate::test_profile::runtime_dir()',
        "write_text_file_atomic(",
        "fn read_session_mapping_files_for_ids",
        "fn is_safe_mapping_id(",
        "fn stable_tab_id_from_legacy_session_id(",
        "fn unique_legacy_mapping_path(",
        "candidates.len() == 1",
        "pub fn read_agent_session_mappings(",
        "pub(crate) fn remove_session_mapping_file(",
    ]:
        assert_contains(session_mapping, snippet, "src-tauri/src/commands/session_mapping.rs")
    assert "std::fs::read_dir(map_dir)" in session_mapping
    assert "agent_mappings_snapshot()" not in monitor


def test_duplicate_session_create_is_idempotent() -> None:
    manager = read_repo_text("src-tauri/src/pty/manager.rs")

    assert_contains(manager, "create_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>", "src-tauri/src/pty/manager.rs")
    assert_contains(manager, "fn create_lock_for(&self, session_id: &str)", "src-tauri/src/pty/manager.rs")
    assert_contains(manager, "let _create_guard = create_lock", "src-tauri/src/pty/manager.rs")
    assert_contains(manager, "session.replace_data_channel(data_channel)?", "src-tauri/src/pty/manager.rs")
    assert_contains(manager, "return Ok(());", "src-tauri/src/pty/manager.rs")
