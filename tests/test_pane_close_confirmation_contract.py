"""Contract: every destructive pane-close route invokes the shared guard.

Closing a pane kills the PTY of every tab under it, background agents included,
so no route may reach `killSession` without going through `confirmPaneClose`
first. Matching is on the scope argument rather than the whole call text, so
adding an options argument does not break the contract.
"""

import re
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]

PANE_CLOSE = re.compile(r'confirmPaneClose\([^)]*?,\s*"pane"')
WORKSPACE_CLOSE = re.compile(r'confirmPaneClose\([^)]*?,\s*"workspace"')


def test_close_routes_use_shared_impact_confirmation() -> None:
    workspace_view = (REPO_ROOT / "src/components/workspace/WorkspaceView.tsx").read_text(encoding="utf-8")
    app_shell = (REPO_ROOT / "src/components/layout/AppShell.tsx").read_text(encoding="utf-8")

    # Route 1: the pane's own close button.
    assert PANE_CLOSE.search(workspace_view)
    # Route 2: the `pane.close` keybinding. Route 3: closing a workspace.
    assert PANE_CLOSE.search(app_shell)
    assert WORKSPACE_CLOSE.search(app_shell)

    assert "killSession(tab.sessionId)" in workspace_view
    assert app_shell.count("killSession(tab.sessionId)") >= 2


def test_confirmation_is_imported_where_the_kills_happen() -> None:
    for relative in (
        "src/components/workspace/WorkspaceView.tsx",
        "src/components/layout/AppShell.tsx",
    ):
        source = (REPO_ROOT / relative).read_text(encoding="utf-8")
        assert "paneCloseConfirmation" in source, relative


def test_workspace_close_still_confirms_with_nothing_running() -> None:
    """A workspace close asked every time before this guard existed, and the
    pane rule (skip the prompt when no tab looks busy) must not erase that."""
    source = (REPO_ROOT / "src/lib/paneCloseConfirmation.ts").read_text(encoding="utf-8")
    assert 'victims.length === 0 && scope === "pane"' in source
