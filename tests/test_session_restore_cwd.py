from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_repo_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def assert_contains(text: str, snippet: str, source: str) -> None:
    assert snippet in text, f"Missing snippet in {source}: {snippet}"


def test_cwd_round_trip_contract_remains_wired() -> None:
    socket_listener = read_repo_text("src/components/layout/SocketListener.tsx")
    layout_store = read_repo_text("src/stores/workspaceLayoutStore.ts")
    terminal_pane = read_repo_text("src/components/workspace/TerminalPane.tsx")

    for snippet in [
        "?? (activeTabIsTerminal ? activeTab.cwd : undefined)",
        "cwd: paneCwd",
        "cwd: terminal ? tabMeta?.cwd ?? tab.cwd ?? paneCwd : null",
    ]:
        assert_contains(socket_listener, snippet, "src/components/layout/SocketListener.tsx")

    for snippet in [
        "cwd: isWebRestoredTab ? undefined : tabConfig.cwd ?? pc.cwd ?? undefined",
        "cwd: activeTab.cwd ?? pc.cwd ?? undefined",
    ]:
        assert_contains(layout_store, snippet, "src/stores/workspaceLayoutStore.ts")

    assert_contains(terminal_pane, "cwd={activeTab.cwd ?? paneCwd}", "src/components/workspace/TerminalPane.tsx")


def test_create_session_uses_same_launch_cwd_for_validation_and_spawn() -> None:
    terminal = read_repo_text("src-tauri/src/commands/terminal.rs")

    assert_contains(terminal, "let launch_cwd = resolve_launch_cwd(cwd.as_deref());", "src-tauri/src/commands/terminal.rs")
    assert_contains(terminal, "if let Some(trusted_cwd) = launch_cwd.as_deref() {", "src-tauri/src/commands/terminal.rs")
    assert_contains(terminal, "launch_cwd,\n        Some(env_map),", "src-tauri/src/commands/terminal.rs")
