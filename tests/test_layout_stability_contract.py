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
        "const layoutMetrics = reconcileLayoutMetrics(w, normalizedSplitColumns, resetLayoutMetrics);",
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
        "const minGridHeight = maxRows > 1 ? maxRows * MIN_TERMINAL_ROW_HEIGHT : undefined;",
        'overflowX: minGridWidth ? "auto" : "hidden"',
        'overflowY: minGridHeight ? "auto" : "hidden"',
        "activePaneEl?.scrollIntoView({ block: \"nearest\", inline: \"nearest\" });",
        "minSize={MIN_TERMINAL_COLUMN_WIDTH}",
        "minSize={MIN_TERMINAL_ROW_HEIGHT}",
    ]:
        assert_contains(workspace_view, snippet, "src/components/workspace/WorkspaceView.tsx")


def test_horizontal_only_columns_are_cleaned_without_vertical_wrapping() -> None:
    layout_columns = read_repo_text("src/lib/layoutColumns.ts")
    workspace_layout_store = read_repo_text("src/stores/workspaceLayoutStore.ts")
    workspace_list_store = read_repo_text("src/stores/workspaceListStore.ts")
    socket_listener = read_repo_text("src/components/layout/SocketListener.tsx")

    for snippet in [
        "function cleanSplitColumns(",
        "export function normalizeReadableSplitColumns(columns: string[][]): string[][] {",
        "return cleanSplitColumns(columns);",
    ]:
        assert_contains(layout_columns, snippet, "src/lib/layoutColumns.ts")
    assert "wrapPaneIdsIntoColumns" not in layout_columns
    assert "MAX_READABLE_SPLIT_COLUMNS" not in layout_columns

    for snippet in [
        'import { normalizeReadableSplitColumns } from "../lib/layoutColumns";',
        "function normalizeSplitColumns(splitColumns: string[][]): string[][] {",
        "columnWidths.every((size) => positiveSize(size) !== null)",
        "row.every((size) => positiveSize(size) !== null)",
        "const normalizedSplitColumns = normalizeSplitColumns(splitColumns);",
        "const normalizedSplitColumns = splitColumns !== undefined",
        "normalizeSplitColumns(splitColumns)",
    ]:
        assert_contains(workspace_list_store, snippet, "src/stores/workspaceListStore.ts")

    for snippet in [
        'import { normalizeReadableSplitColumns } from "../lib/layoutColumns";',
        "function normalizeWorkspaceSplitColumns(columns: string[][]): string[][] {",
        "splitColumns: normalizeReadableSplitColumns(splitColumns),",
        "normalizeWorkspaceSplitColumns(newSplitColumns)",
        "normalizeWorkspaceSplitColumns(nextSplitColumns)",
    ]:
        assert_contains(workspace_layout_store, snippet, "src/stores/workspaceLayoutStore.ts")

    for snippet in [
        'import { normalizeReadableSplitColumns } from "../../lib/layoutColumns";',
        "return normalizeReadableSplitColumns(columns);",
    ]:
        assert_contains(socket_listener, snippet, "src/components/layout/SocketListener.tsx")


def test_terminal_renderer_uses_dom_renderer_for_stability() -> None:
    xterm_wrapper = read_repo_text("src/components/terminal/XTermWrapper.tsx")
    global_css = read_repo_text("src/global.css")

    for snippet in [
        "const DEFAULT_TERMINAL_LINE_HEIGHT = 1.1;",
        "diagStats.webgl = \"never\";",
        "WebGL texture atlases can corrupt",
    ]:
        assert_contains(xterm_wrapper, snippet, "src/components/terminal/XTermWrapper.tsx")

    assert "@xterm/addon-webgl" not in xterm_wrapper
    assert "term.loadAddon(currentWebgl)" not in xterm_wrapper
    assert "image-rendering: pixelated;" not in global_css
    assert "image-rendering: -webkit-optimize-contrast;" not in global_css


def test_terminal_batches_are_not_acked_while_layout_is_unwritable() -> None:
    xterm_wrapper = read_repo_text("src/components/terminal/XTermWrapper.tsx")

    for snippet in [
        "const isContainerDisplayed = (): boolean => {",
        "const hasWritableTerminalSize = (): boolean => {",
        "const canWritePendingBatches = (): boolean => {",
        "setFrontendVisibleIfChanged(Boolean(term && !termDisposed && isContainerDisplayed()));",
        "pendingBatches.unshift(batch);",
        "if (pendingBatches.length > 0 && canWritePendingBatches())",
        "refreshFrontendVisible();",
    ]:
        assert_contains(xterm_wrapper, snippet, "src/components/terminal/XTermWrapper.tsx")

    assert "if (!term || termDisposed || !isContainerVisible())" not in xterm_wrapper
