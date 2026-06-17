from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_repo_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def assert_contains(text: str, snippet: str, source: str) -> None:
    assert snippet in text, f"Missing snippet in {source}: {snippet}"


def test_pane_layout_metrics_survive_split_structure_changes() -> None:
    store = read_repo_text("src/stores/workspaceListStore.ts")

    for snippet in [
        "function reconcileColumnWidths(",
        "function reconcileRowHeightsPerCol(",
        "function reconcileLayoutMetrics(",
        "const layoutMetrics = reconcileLayoutMetrics(w, splitColumns, resetLayoutMetrics);",
        "...(layoutMetrics ?? {})",
    ]:
        assert_contains(store, snippet, "src/stores/workspaceListStore.ts")

    assert "columnWidths: undefined, rowHeightsPerCol: undefined" not in store.replace(
        "return { columnWidths: undefined, rowHeightsPerCol: undefined };",
        "",
    )


def test_terminal_grid_keeps_multi_column_layout_readable() -> None:
    workspace_view = read_repo_text("src/components/workspace/WorkspaceView.tsx")

    for snippet in [
        "const MIN_TERMINAL_COLUMN_WIDTH = 420;",
        "const MIN_TERMINAL_ROW_HEIGHT = 180;",
        "const minGridWidth = cols.length > 1 ? cols.length * MIN_TERMINAL_COLUMN_WIDTH : undefined;",
        'overflowX: minGridWidth ? "auto" : "hidden"',
        "minSize={MIN_TERMINAL_COLUMN_WIDTH}",
        "minSize={MIN_TERMINAL_ROW_HEIGHT}",
    ]:
        assert_contains(workspace_view, snippet, "src/components/workspace/WorkspaceView.tsx")
