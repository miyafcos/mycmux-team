"""Contract: every destructive pane-close route invokes the shared guard.

Closing a pane kills the PTY of every tab under it, background agents included,
so GUI routes may not reach `killSession` without going through `confirmPaneClose`
first. Matching is on the scope argument rather than the whole call text, so
adding an options argument does not break the contract.

Since 2026-09-11, socket workspace.close is the only unconfirmed workspace
destruction route: it structurally refuses the active workspace instead.
The GUI pane and workspace routes still pass through confirmPaneClose.
"""

import re
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]

PANE_CLOSE = re.compile(r'confirmPaneClose\([^)]*?,\s*"pane"')
WORKSPACE_CLOSE = re.compile(r'confirmPaneClose\([^)]*?,\s*"workspace"')


def test_close_routes_use_shared_impact_confirmation() -> None:
    workspace_view = (REPO_ROOT / "src/components/workspace/WorkspaceView.tsx").read_text(encoding="utf-8")
    app_shell = (REPO_ROOT / "src/components/layout/AppShell.tsx").read_text(encoding="utf-8")

    # UI close entries now delegate to the same guarded transaction.
    terminal = (REPO_ROOT / "src/components/workspace/TerminalPane.tsx").read_text(encoding="utf-8")
    operation = (REPO_ROOT / "src/lib/paneCloseOperation.ts").read_text(encoding="utf-8")
    for source in (workspace_view, app_shell, terminal):
        assert "closePaneOperation(" in source
        assert '"ui"' in source
        assert "killSession(" not in source
    assert "await confirmPaneClose(" in operation
    assert "readPlan(op.target, op)" in operation
    assert operation.index("await confirmPaneClose(") < operation.index("await killSession(")
    assert "Promise.allSettled" in operation
    assert WORKSPACE_CLOSE.search(app_shell)
    workspace_close = (REPO_ROOT / "src/lib/workspaceClose.ts").read_text(encoding="utf-8")
    assert "killSession(" in workspace_close
    assert "await closeWorkspaceAfterConfirmation(id)" in app_shell
    assert 'confirmPaneClose(requestedWorkspace.panes, "workspace", { workspaceName })' in app_shell
    assert 'confirmPaneClose(ws.panes, "workspace", { workspaceName })' in app_shell


def test_confirmation_is_imported_where_the_kills_happen() -> None:
    for relative in (
        "src/components/workspace/WorkspaceView.tsx",
        "src/components/layout/AppShell.tsx",
    ):
        source = (REPO_ROOT / relative).read_text(encoding="utf-8")
        assert "paneCloseOperation" in source, relative
    operation = (REPO_ROOT / "src/lib/paneCloseOperation.ts").read_text(encoding="utf-8")
    assert "paneCloseConfirmation" in operation


def test_workspace_close_still_confirms_with_nothing_running() -> None:
    """A workspace close asked every time before this guard existed, and the
    pane rule (skip the prompt when no tab looks busy) must not erase that."""
    source = (REPO_ROOT / "src/lib/paneCloseConfirmation.ts").read_text(encoding="utf-8")
    assert 'victims.length === 0 && (scope === "pane" || scope === "tab")' in source


def test_the_socket_close_route_is_the_only_unconfirmed_one() -> None:
    source = (REPO_ROOT / "src/components/layout/socketCommands.ts").read_text(encoding="utf-8")
    start = source.index("async function closeWorkspace(")
    close = source[start:source.index("export async function handleSocketCommand(", start)]
    assert "confirmPaneClose" not in close
    assert "activeWorkspaceId === workspaceId" in close
    assert "refuses the active workspace" in close
    assert "throw new Error(" in close
    assert "setActiveWorkspace(" not in close
    assert "killSession(" not in close
    assert 'await import("../../lib/workspaceClose")' in close
    assert "await closeWorkspaceAfterConfirmation(workspaceId)" in close
    # All three spawn rollbacks kill their PTY; workspace.close adds no direct kill.
    assert re.findall(r"killSession\(([^)]*)\)", source) == [
        "newTab.sessionId", "newTab.sessionId", "newTab.sessionId",
        "anchorTab.sessionId",
    ]
