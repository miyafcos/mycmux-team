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
    global_css = read_repo_text("src/global.css")

    for snippet in [
        "const FIT_LAYOUT_MIN_SIZE = 0;",
        "function fitLayoutSizes(",
        "const columnWidths = fitLayoutSizes(workspace?.columnWidths, viewportSize.width, cols.length);",
        "const hasMeasuredViewport = viewportSize.width > 0 && viewportSize.height > 0;",
        "defaultSizes={columnWidths}",
        "defaultSizes={fitLayoutSizes(rowHeightsPerCol?.[colIdx], viewportSize.height, col.length)}",
        "preferredSize={columnWidths?.[colIdx]}",
        "preferredSize={rowHeights?.[rowIdx]}",
        "proportionalLayout",
        "minSize={FIT_LAYOUT_MIN_SIZE}",
        'className="cmux-terminal-grid-fit"',
        'overflow: "hidden"',
    ]:
        assert_contains(workspace_view, snippet, "src/components/workspace/WorkspaceView.tsx")

    for snippet in [
        ".cmux-terminal-grid-fit [class*=\"splitView\"]",
        "min-width: 0 !important;",
        "overflow: hidden !important;",
    ]:
        assert_contains(global_css, snippet, "src/global.css")

    assert "scrollIntoView" not in workspace_view
    assert "MIN_TERMINAL_COLUMN_WIDTH" not in workspace_view


def test_split_columns_are_reconciled_to_render_every_pane() -> None:
    layout_columns = read_repo_text("src/lib/layoutColumns.ts")
    workspace_view = read_repo_text("src/components/workspace/WorkspaceView.tsx")
    workspace_layout_store = read_repo_text("src/stores/workspaceLayoutStore.ts")
    workspace_list_store = read_repo_text("src/stores/workspaceListStore.ts")
    socket_listener = read_repo_text("src/components/layout/SocketListener.tsx")

    for snippet in [
        "export function reconcileSplitColumnsForPanes(",
        "const missingPaneIds = paneIds.filter((paneId) => !usedPaneIds.has(paneId));",
        "cleaned[cleaned.length - 1] = [...cleaned[cleaned.length - 1], ...missingPaneIds];",
    ]:
        assert_contains(layout_columns, snippet, "src/lib/layoutColumns.ts")

    for text, source in [
        (workspace_view, "src/components/workspace/WorkspaceView.tsx"),
        (workspace_layout_store, "src/stores/workspaceLayoutStore.ts"),
        (workspace_list_store, "src/stores/workspaceListStore.ts"),
        (socket_listener, "src/components/layout/SocketListener.tsx"),
    ]:
        assert_contains(text, "reconcileSplitColumnsForPanes", source)


def test_new_split_pane_receives_focus_and_shortcuts_match_tabs() -> None:
    workspace_layout_store = read_repo_text("src/stores/workspaceLayoutStore.ts")
    app_shell = read_repo_text("src/components/layout/AppShell.tsx")

    assert workspace_layout_store.count("useUiStore.getState().setActivePaneId(newPane.sessionId);") >= 2
    for snippet in [
        "function paneMatchesSession(",
        "pane.sessionId === sessionId || pane.tabs?.some((tab) => tab.sessionId === sessionId)",
        "const activePane = activeWs?.panes.find((p) => paneMatchesSession(p, apid));",
    ]:
        assert_contains(app_shell, snippet, "src/components/layout/AppShell.tsx")


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
        'import { normalizeReadableSplitColumns, reconcileSplitColumnsForPanes } from "../lib/layoutColumns";',
        "function normalizeSplitColumns(splitColumns: string[][], paneIds: string[]): string[][] {",
        "columnWidths.every((size) => positiveSize(size) !== null)",
        "row.every((size) => positiveSize(size) !== null)",
        "const normalizedSplitColumns = normalizeSplitColumns(splitColumns, panes.map((pane) => pane.id));",
        "const normalizedSplitColumns = splitColumns !== undefined",
        "normalizeSplitColumns(splitColumns, panes.map((pane) => pane.id))",
    ]:
        assert_contains(workspace_list_store, snippet, "src/stores/workspaceListStore.ts")

    for snippet in [
        'import { normalizeReadableSplitColumns, reconcileSplitColumnsForPanes } from "../lib/layoutColumns";',
        "function normalizeWorkspaceSplitColumns(columns: string[][]): string[][] {",
        "splitColumns: normalizeReadableSplitColumns(splitColumns),",
        "normalizeWorkspaceSplitColumns(newSplitColumns)",
        "normalizeWorkspaceSplitColumns(nextSplitColumns)",
    ]:
        assert_contains(workspace_layout_store, snippet, "src/stores/workspaceLayoutStore.ts")

    for snippet in [
        'import { normalizeReadableSplitColumns, reconcileSplitColumnsForPanes } from "../../lib/layoutColumns";',
        "return reconcileSplitColumnsForPanes(",
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
