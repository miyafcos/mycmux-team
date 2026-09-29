from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_repo_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def assert_contains(text: str, snippet: str, source: str) -> None:
    assert snippet in text, f"Missing snippet in {source}: {snippet}"


def test_autosave_hold_is_workspace_and_pane_aware() -> None:
    socket_listener = read_repo_text("src/components/layout/SocketListener.tsx")

    for snippet in [
        "const STARTUP_RESTORE_AUTOSAVE_BASE_HOLD_MS = 1400;",
        "const STARTUP_RESTORE_AUTOSAVE_PER_WORKSPACE_MS = 700;",
        "const STARTUP_RESTORE_AUTOSAVE_PER_PANE_MS = 500;",
        "const STARTUP_RESTORE_AUTOSAVE_MAX_HOLD_MS = 30000;",
        "function paneConfigRestorableAgentSessionCount",
        "function workspaceConfigRestorableAgentSessionCount",
        "+ startupRestoreTargetPaneCount * STARTUP_RESTORE_AUTOSAVE_PER_PANE_MS",
    ]:
        assert_contains(socket_listener, snippet, "src/components/layout/SocketListener.tsx")


def test_mapping_refresh_is_event_driven_with_single_fallback() -> None:
    app = read_repo_text("src/App.tsx")
    gate = read_repo_text("src/lib/startupSessionGate.ts")

    assert_contains(gate, 'export const STARTUP_RESTORE_COMPLETE_EVENT = "startup-restore-complete";', "src/lib/startupSessionGate.ts")
    assert_contains(gate, "window.dispatchEvent(new CustomEvent(STARTUP_RESTORE_COMPLETE_EVENT));", "src/lib/startupSessionGate.ts")
    assert_contains(app, "collectStartupSessionIds(", "src/App.tsx")
    assert_contains(app, "prepareStartupSessionGate(startupSessionIds);", "src/App.tsx")
    assert_contains(app, "window.addEventListener(STARTUP_RESTORE_COMPLETE_EVENT, refreshAgentSessionMappings);", "src/App.tsx")
    assert_contains(app, "const mappingFallbackTimer = window.setTimeout(refreshAgentSessionMappings, 15000);", "src/App.tsx")
    assert "setInterval" not in app


def test_startup_gate_targets_only_the_active_workspace() -> None:
    # Lazy resume (2026-07-28): startup must NOT create PTY sessions for
    # non-active workspaces. Their tabs resume on first activation instead.
    # Memory-pressure root cause: eager all-workspace restore spawned 15
    # concurrent claude processes (~610MB commit each) on every app start.
    workspace_view = read_repo_text("src/components/workspace/WorkspaceView.tsx")
    gate = read_repo_text("src/lib/startupSessionGate.ts")

    assert_contains(gate, "export function collectStartupSessionIds(", "src/lib/startupSessionGate.ts")
    assert_contains(gate, "?? workspaces[0]", "src/lib/startupSessionGate.ts")
    assert "FIRST_LAUNCH_STORAGE_KEY" not in gate
    assert "startupRestoreMountedIds" not in workspace_view
    assert "RESTORE_MOUNT_DELAY_MS" not in workspace_view
    assert "workspaceHasRestorableAgentSession" not in workspace_view


def test_app_does_not_start_forced_auto_update_loop() -> None:
    app = read_repo_text("src/App.tsx")

    assert "startForcedAutoUpdateLoop" not in app
    assert "forcedAutoUpdater" not in app
