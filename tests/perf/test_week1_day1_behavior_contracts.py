from __future__ import annotations

import re
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]

EXPECTED_LAUNCHER_OPTIONS = [
    "Claude Code",
    "Codex",
    "claude-codex (Codex Models)",
    "Grok Build",
    "claude-codex (Open Models)",
    "Antigravity (agy)",
    "Hermes",
    "ChatGPT (Web)",
    "Gemini (Web)",
    "Grok (Web)",
    "Claude.ai (Web)",
    "NotebookLM (Web)",
    "Browser (Web)",
    "Claude Code (resume)",
    "Codex (resume)",
    "claude-codex (resume)",
    "Grok Build (resume)",
    "Custom...",
    "Change directory (開発)...",
    "Change directory (案件)...",
    "Change directory (最近・フォルダを辿る)...",
]

EXPECTED_LAUNCHER_COMMANDS = [
    "claude --allow-dangerously-skip-permissions --permission-mode auto",
    "codex --no-alt-screen",
    "claude-codex --backend gpt",
    "grok --no-alt-screen --permission-mode auto",
    "claude-codex --backend fcc",
    "agy",
    "$HOME/AppData/Local/hermes/bin/hermes.exe",
    "__web_chatgpt__",
    "__web_gemini__",
    "__web_grok__",
    "__web_claude__",
    "__web_notebooklm__",
    "__web_browser__",
    "claude --allow-dangerously-skip-permissions --permission-mode auto --resume",
    "codex resume --no-alt-screen",
    "claude-codex --resume",
    "grok --no-alt-screen --resume",
    "__custom__",
    "__dir_dev__",
    "__dir_anken__",
    "__dir__",
]


def read_repo_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def extract_shell_array(text: str, name: str) -> list[str]:
    match = re.search(rf"^\s*{re.escape(name)}=\((.*?)^\s*\)", text, re.S | re.M)
    assert match, f"Missing shell array: {name}"
    return re.findall(r'^\s*"([^"]+)"', match.group(1), re.M)


def assert_contains(text: str, snippet: str, source: str) -> None:
    assert snippet in text, f"Missing snippet in {source}: {snippet}"


def assert_not_contains(text: str, snippet: str, source: str) -> None:
    assert snippet not in text, f"Forbidden snippet in {source}: {snippet}"


def test_launcher_order_matches_current_contract() -> None:
    launcher = read_repo_text("src-tauri/src/launcher.sh")
    launcher_ps1 = read_repo_text("src-tauri/src/launcher.ps1")

    assert extract_shell_array(launcher, "options") == EXPECTED_LAUNCHER_OPTIONS
    assert extract_shell_array(launcher, "commands") == EXPECTED_LAUNCHER_COMMANDS
    assert "restore.json" not in launcher
    assert_contains(launcher, "__ensure_fugu_env", "src-tauri/src/launcher.sh")
    assert_contains(launcher, "FUGU_API_KEY", "src-tauri/src/launcher.sh")
    assert_contains(launcher_ps1, "Import-MycmuxUserEnvIfMissing", "src-tauri/src/launcher.ps1")
    assert_contains(launcher_ps1, "FUGU_API_KEY", "src-tauri/src/launcher.ps1")
    for command in (
        "claude-codex --backend gpt",
        "claude-codex --backend fcc",
    ):
        assert command in EXPECTED_LAUNCHER_COMMANDS
    # Two entries were removed on 2026-08-29 and one added, so the menu went
    # from 16 to 15 and every index after Grok Build shifted by one.
    assert_contains(launcher, "slash) selected=17", "src-tauri/src/launcher.sh")
    assert_contains(launcher, "5) selected=14", "src-tauri/src/launcher.sh")
    assert_contains(launcher, "6) selected=15", "src-tauri/src/launcher.sh")
    assert_contains(launcher, "7) selected=16", "src-tauri/src/launcher.sh")
    # The (dangerous) entries were retired on 2026-08-15; they must not come back
    # into the menu, and no launch target may point at them.
    for retired in ("Claude Code (dangerous)", "Codex (dangerous)", "claude-codex (dangerous)"):
        assert_not_contains(launcher, retired, "src-tauri/src/launcher.sh")
        assert_not_contains(launcher_ps1, retired, "src-tauri/src/launcher.ps1")
    for retired_target in ("claude-dangerous", "codex-dangerous", "grok-dangerous"):
        assert_not_contains(launcher, retired_target, "src-tauri/src/launcher.sh")
        assert_not_contains(launcher_ps1, retired_target, "src-tauri/src/launcher.ps1")


def test_integrated_model_profiles_match_powershell_launcher() -> None:
    launcher_ps1 = read_repo_text("src-tauri/src/launcher.ps1")
    expected = {
        "claude-codex (Codex Models)": "gpt",
        "claude-codex (Open Models)": "fcc",
    }
    for label, backend in expected.items():
        assert_contains(
            launcher_ps1,
            f'New-MycmuxOption "{label}" @("claude-codex", "--backend", "{backend}") "claude-codex"',
            "src-tauri/src/launcher.ps1",
        )
    for alias in ('"claude-codex-open"', '"fcc"', '"fcc-claude"'):
        assert_contains(launcher_ps1, alias, "src-tauri/src/launcher.ps1")


def test_directory_menu_is_reachable_with_arrows_only() -> None:
    """Change directory は上下キー + Enter だけで最近使った/開発/案件/実フォルダへ入れること。

    数字キーだけの選択に戻すと候補 10 件目以降へ到達できなくなる (launch-roots は
    開発 23 件 / 案件 20 件あり、旧実装は 1〜9 しか受け付けなかった)。
    """
    launcher = read_repo_text("src-tauri/src/launcher.sh")

    for snippet in [
        "__pick_list",           # 共通ピッカー (ページ送り + 絞り込み)
        "__read_pick_event",     # 印字可能文字を拾う入力リーダー
        "__launch_dir_menu",     # トップ画面 (最近使った/開発/案件/辿る/Home)
        "__browse_launch_dirs",  # 候補ファイル外へも行ける実フォルダ探索
        "__record_dir_mru",      # 最近使った行き先の記録
        "__norm_path",           # /c/... と C:/... の同一視 (今ここ判定)
    ]:
        assert_contains(launcher, snippet, "src-tauri/src/launcher.sh")

    # 上下キー・Enter・→ 決定・← 戻るが全部イベントとして配線されていること
    for snippet in ["__PICK_EVENT=up", "__PICK_EVENT=down", "__PICK_EVENT=enter", "__PICK_EVENT=esc"]:
        assert_contains(launcher, snippet, "src-tauri/src/launcher.sh")

    # d / a のショートカットは従来どおり開発 / 案件へ直行すること
    assert_contains(launcher, "dirkey) __launch_dir_menu dev", "src-tauri/src/launcher.sh")
    assert_contains(launcher, "ankenkey) __launch_dir_menu anken", "src-tauri/src/launcher.sh")

    # 開発 / 案件はメインメニューから Enter 1回で候補一覧に入れること (トップ画面を挟まない)
    assert_contains(launcher, "__dir_dev__)   __launch_dir_menu dev", "src-tauri/src/launcher.sh")
    assert_contains(launcher, "__dir_anken__) __launch_dir_menu anken", "src-tauri/src/launcher.sh")


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
        "MYCMUX_RESUME",
        "MYCMUX_SESSION_ID",
        "__write_session_mapping",
        "codex resume --no-alt-screen --last",
        # A handoff pane must mint its own session id, not inherit the source
        # pane's — see the handoff branch in launcher.sh.
        'claude --session-id "$__handoff_sid"',
        '__write_session_mapping "$MYCMUX_PANE_SESSION_ID" "claude" "$__handoff_sid"',
    ]:
        assert_contains(launcher, snippet, "src-tauri/src/launcher.sh")

    for snippet in [
        "MYCMUX_HANDOFF",
        "MYCMUX_HANDOFF_PROMPT_FILE",
        "MYCMUX_RESUME",
        "MYCMUX_SESSION_ID",
        "Write-MycmuxSessionMapping",
        '@("codex", "resume", "--no-alt-screen", "--last")',
        'Write-MycmuxSessionMapping $env:MYCMUX_PANE_SESSION_ID "claude" $sid',
    ]:
        assert_contains(launcher_ps1, snippet, "src-tauri/src/launcher.ps1")

    # The "<kind>-handoff:<source pane id>" mappings are junk: no reader accepts
    # them, and persisting one downgraded restore to `claude --continue`, which
    # hijacked another tab's conversation in the same cwd.
    for snippet in ["claude-handoff", "codex-handoff", "claude-codex-handoff"]:
        assert_not_contains(launcher, snippet, "src-tauri/src/launcher.sh")
        assert_not_contains(launcher_ps1, snippet, "src-tauri/src/launcher.ps1")

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
        # The palette passes the clicked row's session explicitly (reachability fix #3),
        # so the handoff source is read from `sessionToOpen`, not the highlighted `selected`.
        "launchEnv.MYCMUX_HANDOFF_FROM_SESSION = sessionToOpen.id",
    ]:
        assert_contains(palette, snippet, "src/components/CommandPalette/CrsmPalette.tsx")


def test_startup_does_not_mount_inactive_workspaces() -> None:
    # Lazy resume (2026-07-28): the old eager startup restore mounted every
    # workspace with a saved agent session, spawning all agents at once
    # (memory-pressure root cause). Startup must mount the active workspace
    # only; other workspaces mount — and their agents resume — on activation.
    workspace_view = read_repo_text("src/components/workspace/WorkspaceView.tsx")

    for snippet in [
        "const visibleWorkspaceIds",
        "visibleWorkspaceIds.has(ws.id)",
    ]:
        assert_contains(workspace_view, snippet, "src/components/workspace/WorkspaceView.tsx")
    for removed in [
        "workspaceHasRestorableAgentSession",
        "startupRestoreMountedIds",
        "RESTORE_MOUNT_DELAY_MS",
        "startupRestoreComplete",
    ]:
        assert removed not in workspace_view, (
            f"eager startup restore machinery is back in WorkspaceView.tsx: {removed}"
        )


def test_workspace_mount_lru_trim_is_unconditional() -> None:
    workspace_view = read_repo_text("src/components/workspace/WorkspaceView.tsx")

    assert_contains(workspace_view, "const trimmed = next.slice(-MAX_MOUNTED_WORKSPACES);", "src/components/workspace/WorkspaceView.tsx")
    assert "releaseStartupRestorePins" not in workspace_view


def test_shell_starter_mapping_recovers_only_the_matching_tab_identity() -> None:
    socket_listener = read_repo_text("src/components/layout/SocketListener.tsx")
    app = read_repo_text("src/App.tsx")

    for snippet in [
        'return mapping.agent_kind ?? existingKind ?? "claude";',
        "agentMappings[tabId]",
        "applyMappingToTabConfig",
        "if (!processKind && tabKind && tabKind !== kind)",
    ]:
        source = "src/App.tsx" if snippet.startswith("if (!processKind") else "src/components/layout/SocketListener.tsx"
        assert_contains(app if source == "src/App.tsx" else socket_listener, snippet, source)
    assert "tabMapping ?? (isActiveTab ? paneMapping : undefined)" not in socket_listener
    assert "applyMappingToPaneConfig" not in socket_listener


def test_existing_session_id_is_not_overwritten_by_mapping() -> None:
    socket_listener = read_repo_text("src/components/layout/SocketListener.tsx")

    assert_contains(
        socket_listener,
        "if (existingSessionId && existingSessionId !== mapping.session_id) return tabConfig;",
        "src/components/layout/SocketListener.tsx",
    )
    assert "return paneConfig;" not in socket_listener[socket_listener.index("function applyMappingToTabConfig"):socket_listener.index("export function applyMappingsToConfig")]


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
