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
    monitor = read_repo_text("src-tauri/src/pty/monitor.rs")

    for snippet in [
        "agent_kind: liveKind",
        "agent_session_id: liveAgentId",
        "const isActivePersistedTab = tab.id === activeTab.id;",
        "const tabKind = tab.agentKind ?? tabMeta?.agentKind ?? (isActivePersistedTab ? liveKind : null);",
        "const tabAgentId = tab.agentSessionId",
        "agent_kind: tabKind",
        "agent_session_id: tabAgentId",
        "suppressed_agent_sessions: toSuppressedAgentSessionConfigs",
        "agent_kind: paneConfig.agent_kind ?? mappingKind",
        "agent_kind: tabConfig.agent_kind ?? mappingKind",
        "function tabConfigWithPaneAgentSessionFallback(",
        "tabConfigWithPaneAgentSessionFallback(tab, pane)",
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
        "const activeTabConfigId = pc.active_tab_id ?? pc.tabs?.[0]?.tab_id ?? null;",
        "const isActiveRestoredTab = tabConfig.tab_id === activeTabConfigId;",
        "const tabAgentKind =",
        "const tabAgentSessionId =",
        "agentKind: tabAgentKind",
        "agentSessionId: tabAgentSessionId",
        "suppressedAgentSessions: restoreSuppressedAgentSessions",
        "agentKind: activeTab.agentKind ?? pc.agent_kind ?? undefined",
        "agentSessionId: activeTab.agentSessionId ?? pc.agent_session_id ?? undefined",
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
        assert_contains(monitor, snippet, "src-tauri/src/pty/monitor.rs")

    for snippet in [
        "fn write_session_mapping_file_to_dir(",
        'home.join(".mycmux").join("pane-sessions")',
        "write_text_file_atomic(",
        "fn read_session_mapping_files_for_ids",
        "fn is_safe_mapping_id(",
        "pub fn read_agent_session_mappings(",
        "pub(crate) fn remove_session_mapping_file(",
    ]:
        assert_contains(session_mapping, snippet, "src-tauri/src/commands/session_mapping.rs")
    assert "std::fs::read_dir(map_dir)" not in session_mapping
    assert "agent_mappings_snapshot()" not in monitor


def test_duplicate_session_create_is_idempotent() -> None:
    manager = read_repo_text("src-tauri/src/pty/manager.rs")

    assert_contains(manager, "create_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>", "src-tauri/src/pty/manager.rs")
    assert_contains(manager, "fn create_lock_for(&self, session_id: &str)", "src-tauri/src/pty/manager.rs")
    assert_contains(manager, "let _create_guard = create_lock", "src-tauri/src/pty/manager.rs")
    assert_contains(manager, "session.replace_data_channel(data_channel)?", "src-tauri/src/pty/manager.rs")
    assert_contains(manager, "return Ok(());", "src-tauri/src/pty/manager.rs")
