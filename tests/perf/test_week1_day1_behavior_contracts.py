from __future__ import annotations

import re
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]

EXPECTED_START_IDS = [
    "claude",
    "codex",
    "claude-codex",
    "claude-dangerous",
    "codex-dangerous",
    "claude-codex-dangerous",
    "claude-resume",
    "codex-resume",
    "claude-codex-resume",
    "codex-fugu-ultra",
    "claude-codex-fugu",
    "custom",
]

EXPECTED_LAUNCHER_OPTIONS = [
    "Claude Code",
    "Codex",
    "claude-codex",
    "Claude Code (dangerous)",
    "Codex (dangerous)",
    "claude-codex (dangerous)",
    "Claude Code (resume)",
    "Codex (resume)",
    "claude-codex (resume)",
    "Codex (Fugu Ultra)",
    "claude-codex (Fugu)",
    "Custom...",
]

EXPECTED_LAUNCHER_COMMANDS = [
    "claude --allow-dangerously-skip-permissions --permission-mode auto",
    "codex --no-alt-screen",
    "claude-codex",
    "claude --dangerously-skip-permissions --permission-mode bypassPermissions",
    "codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox",
    "claude-codex --dangerously-skip-permissions --permission-mode bypassPermissions",
    "claude --allow-dangerously-skip-permissions --permission-mode auto --resume",
    "codex resume --no-alt-screen",
    "claude-codex --resume",
    "codex --no-alt-screen --profile fugu-ultra",
    "claude-codex --backend fugu",
    "__custom__",
]


def read_repo_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def extract_ts_string_array(text: str, declaration: str) -> list[str]:
    match = re.search(rf"{re.escape(declaration)}\s*=\s*\[(.*?)\]\s*as const;", text, re.S)
    assert match, f"Missing TS array declaration: {declaration}"
    return re.findall(r'id:\s*"([^"]+)"', match.group(1))


def extract_shell_array(text: str, name: str) -> list[str]:
    match = re.search(rf"^\s*{re.escape(name)}=\((.*?)^\s*\)", text, re.S | re.M)
    assert match, f"Missing shell array: {name}"
    return re.findall(r'^\s*"([^"]+)"', match.group(1), re.M)


def assert_contains(text: str, snippet: str, source: str) -> None:
    assert snippet in text, f"Missing snippet in {source}: {snippet}"


def test_launcher_order_matches_current_contract() -> None:
    pane_starter = read_repo_text("src/components/workspace/PaneStarter.tsx")
    launcher = read_repo_text("src-tauri/src/launcher.sh")
    launcher_ps1 = read_repo_text("src-tauri/src/launcher.ps1")

    assert extract_ts_string_array(pane_starter, "const START_OPTIONS") == EXPECTED_START_IDS
    assert extract_shell_array(launcher, "options") == EXPECTED_LAUNCHER_OPTIONS
    assert extract_shell_array(launcher, "commands") == EXPECTED_LAUNCHER_COMMANDS
    assert_contains(launcher, "__ensure_fugu_env", "src-tauri/src/launcher.sh")
    assert_contains(launcher, "FUGU_API_KEY", "src-tauri/src/launcher.sh")
    assert_contains(launcher_ps1, "Import-MycmuxUserEnvIfMissing", "src-tauri/src/launcher.ps1")
    assert_contains(launcher_ps1, "FUGU_API_KEY", "src-tauri/src/launcher.ps1")


def test_ctrl_p_history_palette_route_remains_wired() -> None:
    keybindings = read_repo_text("src/lib/keybindings.ts")
    app_shell = read_repo_text("src/components/layout/AppShell.tsx")
    palette = read_repo_text("src/components/CommandPalette/CrsmPalette.tsx")

    assert_contains(keybindings, '| "crsm.palette"', "src/lib/keybindings.ts")
    assert_contains(keybindings, 'action: "crsm.palette"', "src/lib/keybindings.ts")
    assert_contains(keybindings, 'defaultShortcut: "ctrl+p"', "src/lib/keybindings.ts")
    assert_contains(app_shell, "preloadCrsmSessions();", "src/components/layout/AppShell.tsx")
    assert_contains(app_shell, 'case "crsm.palette":', "src/components/layout/AppShell.tsx")
    assert_contains(app_shell, "setIsCrsmPaletteOpen(true)", "src/components/layout/AppShell.tsx")
    assert_contains(app_shell, "<CrsmPalette open={isCrsmPaletteOpen}", "src/components/layout/AppShell.tsx")
    assert_contains(palette, "let cachedCrsmSessions", "src/components/CommandPalette/CrsmPalette.tsx")
    assert_contains(palette, "requestIdleCallback", "src/components/CommandPalette/CrsmPalette.tsx")
    assert_contains(palette, "autoRefreshCrsmSessions", "src/components/CommandPalette/CrsmPalette.tsx")
    assert_contains(palette, "crsmListSessions(undefined, limit, refresh)", "src/components/CommandPalette/CrsmPalette.tsx")
    assert_contains(palette, "const ITEM_HEIGHT", "src/components/CommandPalette/CrsmPalette.tsx")
    assert_contains(palette, "virtualSessions.map", "src/components/CommandPalette/CrsmPalette.tsx")


def test_resume_and_handoff_environment_contract_remains_wired() -> None:
    launcher = read_repo_text("src-tauri/src/launcher.sh")
    launcher_ps1 = read_repo_text("src-tauri/src/launcher.ps1")
    terminal_pane = read_repo_text("src/components/workspace/TerminalPane.tsx")
    palette = read_repo_text("src/components/CommandPalette/CrsmPalette.tsx")

    for snippet in [
        "MYCMUX_HANDOFF",
        "MYCMUX_HANDOFF_PROMPT_FILE",
        "MYCMUX_HANDOFF_FROM_SESSION",
        "MYCMUX_RESUME",
        "MYCMUX_SESSION_ID",
        "__write_session_mapping",
        "codex resume --no-alt-screen --last",
    ]:
        assert_contains(launcher, snippet, "src-tauri/src/launcher.sh")

    for snippet in [
        "MYCMUX_HANDOFF",
        "MYCMUX_HANDOFF_PROMPT_FILE",
        "MYCMUX_HANDOFF_FROM_SESSION",
        "MYCMUX_RESUME",
        "MYCMUX_SESSION_ID",
        "Write-MycmuxSessionMapping",
        '@("codex", "resume", "--no-alt-screen", "--last")',
    ]:
        assert_contains(launcher_ps1, snippet, "src-tauri/src/launcher.ps1")

    for snippet in [
        "resolveSavedAgentSession",
        "MYCMUX_PANE_SESSION_ID",
        "MYCMUX_TAB_ID",
        "MYCMUX_AGENT_KIND",
        "MYCMUX_SESSION_ID",
        "MYCMUX_RESUME",
    ]:
        assert_contains(terminal_pane, snippet, "src/components/workspace/TerminalPane.tsx")

    for snippet in [
        "crsmCreateHandoff",
        "SESSION_VALIDATE_LIMIT",
        "SESSION_VALIDATE_TIMEOUT_MS",
        "resolveDirectResumeSession",
        "crsmListSessions(selected.id, SESSION_VALIDATE_LIMIT, false)",
        "exact = exactCrsmSessionMatch(refreshed, selected);",
        "cachedCrsmSessionsError = error instanceof Error ? error.message : String(error);",
        "return selected;",
        "launchEnv.MYCMUX_RESUME = targetKind",
        "launchEnv.MYCMUX_HANDOFF = targetKind",
        "launchEnv.MYCMUX_HANDOFF_PROMPT_FILE = result.path",
        "launchEnv.MYCMUX_HANDOFF_FROM_SESSION = selected.id",
    ]:
        assert_contains(palette, snippet, "src/components/CommandPalette/CrsmPalette.tsx")


def test_startup_restore_mounts_inactive_saved_session_workspaces() -> None:
    workspace_view = read_repo_text("src/components/workspace/WorkspaceView.tsx")

    for snippet in [
        "workspaceHasRestorableAgentSession",
        "startupRestoreMountedIds",
        "RESTORE_MOUNT_DELAY_MS",
        "const visibleWorkspaceIds",
        "visibleWorkspaceIds.has(ws.id)",
    ]:
        assert_contains(workspace_view, snippet, "src/components/workspace/WorkspaceView.tsx")


def test_restore_targets_are_not_trimmed_by_lru_mount_cap() -> None:
    workspace_view = read_repo_text("src/components/workspace/WorkspaceView.tsx")

    for snippet in [
        "const restoreIds = next.filter((id) => restoreWorkspaceIdSet.has(id));",
        "const shellOnlyIds = next.filter((id) => !restoreWorkspaceIdSet.has(id));",
        "const trimmed = [...shellOnlyIds.slice(-MAX_MOUNTED_WORKSPACES), ...restoreIds];",
    ]:
        assert_contains(workspace_view, snippet, "src/components/workspace/WorkspaceView.tsx")


def test_shell_starter_mapping_can_recover_session_identity() -> None:
    socket_listener = read_repo_text("src/components/layout/SocketListener.tsx")
    app = read_repo_text("src/App.tsx")

    for snippet in [
        'return mapping.agent_kind ?? existingKind ?? "claude";',
        "tabMapping ?? (isActiveTab ? paneMapping : undefined)",
        "applyMappingToTabConfig",
        "applyMappingToPaneConfig",
        "if (!processKind && tabKind && tabKind !== kind)",
    ]:
        source = "src/App.tsx" if snippet.startswith("if (!processKind") else "src/components/layout/SocketListener.tsx"
        assert_contains(app if source == "src/App.tsx" else socket_listener, snippet, source)


def test_existing_session_id_is_not_overwritten_by_mapping() -> None:
    socket_listener = read_repo_text("src/components/layout/SocketListener.tsx")

    for snippet in [
        "if (existingSessionId && existingSessionId !== mapping.session_id) return tabConfig;",
        "if (existingSessionId && existingSessionId !== mapping.session_id) return paneConfig;",
    ]:
        assert_contains(socket_listener, snippet, "src/components/layout/SocketListener.tsx")


def test_startup_restore_autosave_hold_remains_wired() -> None:
    socket_listener = read_repo_text("src/components/layout/SocketListener.tsx")

    for snippet in [
        "STARTUP_RESTORE_AUTOSAVE_BASE_HOLD_MS",
        "workspaceConfigHasRestorableAgentSession",
        "startupAutosaveHoldUntil",
        "const startupHoldRemainingMs = startupAutosaveHoldUntil.current - Date.now();",
        "scheduleSync(startupHoldRemainingMs + 100);",
    ]:
        assert_contains(socket_listener, snippet, "src/components/layout/SocketListener.tsx")


def test_data_json_storage_contract_uses_tauri_app_data_dir() -> None:
    storage = read_repo_text("src-tauri/src/db/storage.rs")

    assert_contains(storage, ".app_data_dir()", "src-tauri/src/db/storage.rs")
    assert_contains(storage, 'dir.join("data.json")', "src-tauri/src/db/storage.rs")


def test_worksets_are_not_reintroduced_in_runtime_sources() -> None:
    offenders: list[str] = []
    for root in [REPO_ROOT / "src", REPO_ROOT / "src-tauri" / "src"]:
        for path in root.rglob("*"):
            if path.suffix.lower() not in {".ts", ".tsx", ".rs", ".sh", ".js"}:
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
            if re.search(r"\bworksets?\b", text, re.I):
                offenders.append(str(path.relative_to(REPO_ROOT)))

    assert offenders == [], "Workset runtime references found: " + ", ".join(offenders)


def main() -> int:
    failures: list[str] = []
    tests = [
        value
        for key, value in sorted(globals().items())
        if key.startswith("test_") and callable(value)
    ]
    for test in tests:
        try:
            test()
            print(f"ok {test.__name__}")
        except Exception as exc:
            failures.append(f"{test.__name__}: {exc}")
            print(f"not ok {test.__name__}: {exc}", file=sys.stderr)

    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
