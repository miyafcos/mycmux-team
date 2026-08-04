from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
TERMINAL_SOURCE_PATHS = [
    "src/components/terminal/XTermWrapper.tsx",
    "src/components/terminal/terminalCache.ts",
    "src/components/terminal/terminalFocusHelpers.ts",
    "src/components/terminal/terminalSelectionCopy.ts",
    "src/components/terminal/terminalMouseInputFilter.ts",
    "src/components/terminal/terminalLinkProvider.ts",
    "src/lib/focusController.ts",
    "src/lib/focusController.ts",
]


def read_repo_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def read_terminal_sources() -> str:
    return "\n".join(read_repo_text(path) for path in TERMINAL_SOURCE_PATHS)


def assert_contains(text: str, snippet: str, source: str) -> None:
    assert snippet in text, f"Missing snippet in {source}: {snippet}"


def test_pane_layout_metrics_survive_split_structure_changes() -> None:
    store = read_repo_text("src/stores/workspaceListStore.ts")
    layout_metrics = read_repo_text("src/lib/layoutMetrics.ts")
    workspace_view = read_repo_text("src/components/workspace/WorkspaceView.tsx")

    # Pure metric reconciliation lives in src/lib/layoutMetrics.ts so it stays
    # unit-testable; the store only adapts Workspace state onto it.
    for snippet in [
        "export function reconcileColumnWidths(",
        "export function reconcileRowHeightsPerCol(",
        "export function reconcileLayoutMetrics(",
        "export function columnsRequireBalancedWidths(",
        "function previousColumnIndicesForSurvivors(",
        "return nextColumns.map(() => DEFAULT_LAYOUT_SIZE);",
        # Pane removal keeps the survivors' stored sizes (proportional spread)
        # instead of resetting every column to the balanced default.
        "const survivorWidths = previousIndices.map((previousIndex) =>",
        "const survivorHeights = nextColumn.map((paneId) =>",
        "columnWidths.every((size) => positiveSize(size) !== null)",
        "row.every((size) => positiveSize(size) !== null)",
    ]:
        assert_contains(layout_metrics, snippet, "src/lib/layoutMetrics.ts")

    for snippet in [
        '} from "../lib/layoutMetrics";',
        "const layoutMetrics = reconcileLayoutMetrics(",
        "resetLayoutMetrics || panesChanged || splitLayoutChanged,",
        "...(layoutMetrics ?? {})",
    ]:
        assert_contains(store, snippet, "src/stores/workspaceListStore.ts")

    assert "columnWidths: undefined, rowHeightsPerCol: undefined" not in layout_metrics.replace(
        "return { columnWidths: undefined, rowHeightsPerCol: undefined };",
        "",
    )

    # allotment ignores preferredSize updates on surviving panes and lets the
    # edge pane absorb a removed sibling's space, so the grid must push the
    # reconciled metrics through the imperative resize() handles whenever the
    # split structure changes.
    for snippet in [
        "const outerAllotmentRef = useRef<AllotmentHandle | null>(null);",
        "const innerAllotmentRefs = useRef(new Map<string, AllotmentHandle>());",
        "outerAllotmentRef.current?.resize(columnWidths);",
        "innerAllotmentRefs.current.get(columnId)?.resize(rowHeights);",
    ]:
        assert_contains(workspace_view, snippet, "src/components/workspace/WorkspaceView.tsx")


def test_terminal_grid_fits_every_split_inside_the_viewport_without_outer_scrollbars() -> None:
    workspace_view = read_repo_text("src/components/workspace/WorkspaceView.tsx")
    global_css = read_repo_text("src/global.css")

    for snippet in [
        "function fitLayoutSizes(",
        "const layoutWidth = viewportSize.width;",
        "const layoutHeight = viewportSize.height;",
        "const columnWidths = fitLayoutSizes(workspace?.columnWidths, layoutWidth, cols.length);",
        "const hasMeasuredViewport = viewportSize.width > 0 && viewportSize.height > 0;",
        "const terminalLayoutSignature = useMemo(",
        "const columnIdentities = reconcileStableLayoutColumnIdentities(",
        "const columnId = columnIdentities[colIdx]?.id ?? `column-${colIdx}`;",
        "const rowHeights = fitLayoutSizes(rowHeightsPerCol?.[colIdx], layoutHeight, col.length);",
        "defaultSizes={columnWidths}",
        "defaultSizes={rowHeights}",
        "preferredSize={columnWidths?.[colIdx]}",
        "preferredSize={rowHeights?.[rowIdx]}",
        "proportionalLayout",
        "minSize={0}",
        'className="cmux-terminal-grid-fit"',
        "ref={gridContainerRef}",
        'overflow: "hidden"',
        'width: "100%"',
        "minWidth: 0",
        "const visibleWorkspaceSignature = useMemo(",
        'new CustomEvent("mycmux:workspace-visibility-change"',
        'new CustomEvent("mycmux:terminal-layout-change"',
        "layoutSignature: terminalLayoutSignature",
        "const rafId = window.requestAnimationFrame(notifyTerminals);",
    ]:
        assert_contains(workspace_view, snippet, "src/components/workspace/WorkspaceView.tsx")

    assert "key={`cols-${layoutSignature}`}" not in workspace_view
    assert "key={`rows-${colSignature}`}" not in workspace_view
    assert "key={`col-${colSignature}`}" not in workspace_view
    assert "const columnId = col[0]" not in workspace_view
    assert "secondRafId" not in workspace_view

    for snippet in [
        "const dragSourceWorkspaceId = useSavepointDragStore((s) => s.item?.sourceWorkspaceId ?? null);",
        "if (dragSourceWorkspaceId) {",
        "ids.add(dragSourceWorkspaceId);",
        "next.slice(-MAX_MOUNTED_WORKSPACES)",
    ]:
        assert_contains(workspace_view, snippet, "src/components/workspace/WorkspaceView.tsx")

    for snippet in [
        ".cmux-terminal-grid-fit [class*=\"splitView\"]",
        "min-width: 0 !important;",
        "overflow: hidden !important;",
    ]:
        assert_contains(global_css, snippet, "src/global.css")

    for forbidden in [
        "MIN_TERMINAL_COLUMN_WIDTH",
        "MIN_TERMINAL_ROW_HEIGHT",
        'overflowX: "auto"',
        'overflowY: "auto"',
        "scrollIntoView(",
    ]:
        assert forbidden not in workspace_view

    assert workspace_view.count("minSize={0}") >= 4

    grid_css = global_css.split(".cmux-terminal-grid-fit {", 1)[1].split("}", 1)[0]
    assert "overflow: hidden !important;" in grid_css
    assert "overflow-x: auto" not in grid_css
    assert "overflow-y: auto" not in grid_css
    assert "colKeyStateRef" not in workspace_view


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


def test_browser_preview_panes_are_not_persisted_as_empty_terminal_panes() -> None:
    socket_listener = read_repo_text("src/components/layout/SocketListener.tsx")

    for snippet in [
        "function dropEmptyTabPanesFromConfig(cfg: WorkspaceConfig): WorkspaceConfig",
        "const keepPane = !pane.tabs || pane.tabs.length > 0;",
        ".map(dropEmptyTabPanesFromConfig)",
        ".filter((cfg) => cfg.panes.length > 0)",
        'const persistedTabs = pane.tabs.filter((tab) => tab.type !== "browser");',
        "if (persistedTabs.length === 0) return null;",
        "const droppedEphemeralPane = paneEntries.length !== ws.panes.length;",
        "column_widths: droppedEphemeralPane ? null : normalizeColumnWidths(ws, splitColumns),",
        "row_heights_per_col: droppedEphemeralPane ? null : normalizeRowHeightsPerCol(ws, splitColumns),",
    ]:
        assert_contains(socket_listener, snippet, "src/components/layout/SocketListener.tsx")


def test_new_split_pane_receives_focus_and_shortcuts_match_tabs() -> None:
    workspace_layout_store = read_repo_text("src/stores/workspaceLayoutStore.ts")
    app_shell = read_repo_text("src/components/layout/AppShell.tsx")

    assert workspace_layout_store.count("applyStructuralActivation(newPane.sessionId);") >= 2
    assert "applyStructuralActivation(tab.sessionId);" in workspace_layout_store
    for snippet in [
        "function paneMatchesSession(",
        "pane.sessionId === sessionId || pane.tabs?.some((tab) => tab.sessionId === sessionId)",
        "const activePane = activeWs?.panes.find((p) => paneMatchesSession(p, apid));",
        'case "pane.tab.next":',
        'case "pane.tab.prev":',
        "setActivePaneTab(activeWs.id, activePane.id, nextTab.id);",
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
        "function paneIdsChanged(previousPanes: Workspace[\"panes\"], nextPanes: Workspace[\"panes\"]): boolean {",
        "function splitColumnsChanged(previousColumns: string[][], nextColumns: string[][]): boolean {",
        "const normalizedSplitColumns = normalizeSplitColumns(splitColumns, panes.map((pane) => pane.id));",
        "const paneIds = panes.map((pane) => pane.id);",
        "const panesChanged = paneIdsChanged(w.panes, panes);",
        "const previousSplitColumns = fallbackColumns(w.splitColumns, w.panes.map((pane) => pane.id));",
        "splitColumns ?? previousSplitColumns",
        "const splitLayoutChanged = splitColumnsChanged(previousSplitColumns, normalizedSplitColumns);",
        "splitColumns: normalizedSplitColumns",
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


def test_terminal_renderer_auto_default_keeps_transparency_safety() -> None:
    # Transparent multi-pane WebGL has repeatedly rendered darker or corrupted
    # text on Windows/WebView2 and macOS/WKWebView, while the forced-DOM v3
    # default made streaming output CPU-heavy. "auto" picks WebGL only for
    # opaque terminal backgrounds and falls back to DOM whenever a media
    # background or reduced opacity is active.
    xterm_wrapper = read_repo_text("src/components/terminal/XTermWrapper.tsx")
    settings_store = read_repo_text("src/stores/settingsStore.ts")
    settings_migration = read_repo_text("src/stores/settingsMigration.ts")
    appearance_tab = read_repo_text("src/components/settings/tabs/AppearanceTab.tsx")
    global_css = read_repo_text("src/global.css")

    for snippet in [
        "const DEFAULT_TERMINAL_LINE_HEIGHT = 1.35;",
        'import { WebglAddon } from "@xterm/addon-webgl";',
        "const webglRendererStates = new WeakMap<Terminal, WebglRendererState>();",
        "const webglRendererFailures = new WeakSet<Terminal>();",
        "contextLossDisposable = addon.onContextLoss(() => {",
        "disposeWebglRenderer(sessionId, term, true, true);",
        "webglRendererFailures.add(term);",
        'stats.webgl = fallback ? "fallback" : "never";',
    ]:
        assert_contains(xterm_wrapper, snippet, "src/components/terminal/XTermWrapper.tsx")

    # The renderer must be (re)applied on every terminal attach path:
    # definition + settings-change effect + cached reattach + fresh open.
    assert xterm_wrapper.count("applyTerminalRenderer(") >= 4

    # Every attach path resolves the *effective* renderer (auto -> webgl/dom
    # from the background state) instead of using the raw setting, and the
    # settings-change effect re-runs when the background state flips.
    for snippet in [
        'import { resolveEffectiveTerminalRenderer } from "../../stores/settingsMigration";',
        "function resolveTerminalBackgroundState(background: ThemeBackgroundSettings): {",
        "function resolveEffectiveTerminalRendererFromStores(): \"webgl\" | \"dom\" {",
        "}, [sessionId, terminalRenderer, mediaBackgroundActive, terminalOpacity]);",
    ]:
        assert_contains(xterm_wrapper, snippet, "src/components/terminal/XTermWrapper.tsx")
    assert xterm_wrapper.count("resolveEffectiveTerminalRendererFromStores()") >= 2
    assert "applyTerminalRenderer(sessionId, cached.term, useSettingsStore.getState().terminalRenderer)" not in xterm_wrapper
    assert "applyTerminalRenderer(sessionId, term, useSettingsStore.getState().terminalRenderer)" not in xterm_wrapper

    # loadAddon must stay inside the guarded enable path - a bare unguarded
    # load would crash terminals on GPU-less WebView2 setups.
    assert "term.loadAddon(addon);" in xterm_wrapper
    assert "term.loadAddon(new WebglAddon())" not in xterm_wrapper
    assert "clearTextureAtlas()" not in xterm_wrapper

    for snippet in [
        "terminalRenderer: TerminalRenderer;",
        "terminalRenderer: resolveDefaultTerminalRenderer(),",
        "version: SETTINGS_STORE_VERSION,",
        "migratePersistedSettings(persistedState, persistedVersion)",
    ]:
        assert_contains(settings_store, snippet, "src/stores/settingsStore.ts")

    # "auto" is the default; the v2/v3 forced-DOM safety is preserved through
    # the effective-renderer resolution (transparent configs stay on DOM) and
    # the v4 migration lifts only the forced "dom" values to "auto", keeping
    # explicit legacy WebGL opt-ins untouched.
    for snippet in [
        "export const SETTINGS_STORE_VERSION = 4;",
        'export type TerminalRenderer = "auto" | "webgl" | "dom";',
        "export function resolveDefaultTerminalRenderer(",
        'return "auto";',
        "export function resolveEffectiveTerminalRenderer(",
        'return !mediaBackgroundActive && terminalOpacity >= 1 ? "webgl" : "dom";',
        'delete migrated.useWebglRenderer;',
        'legacyWebglPreference === false ? "dom" : "webgl"',
        'migrated.terminalRenderer = "dom";',
        "&& !isWindowsUserAgent(userAgent)",
        'if (persistedVersion < 4 && migrated.terminalRenderer === "dom") {',
        'migrated.terminalRenderer = "auto";',
    ]:
        assert_contains(settings_migration, snippet, "src/stores/settingsMigration.ts")

    for snippet in [
        "自動（推奨）",
        "標準描画（安定性優先）",
        "GPU描画（高速・環境依存）",
        "自動では、背景メディアがなく不透明度100%のときGPU描画を使い",
    ]:
        assert_contains(appearance_tab, snippet, "src/components/settings/tabs/AppearanceTab.tsx")

    assert "image-rendering: pixelated;" not in global_css
    assert "image-rendering: -webkit-optimize-contrast;" not in global_css


def test_selection_copy_listener_survives_cached_terminal_remounts() -> None:
    xterm_wrapper = read_repo_text("src/components/terminal/XTermWrapper.tsx")
    terminal_sources = read_terminal_sources()

    for snippet in [
        "const terminalSelectionCopyListeners = new WeakMap<Terminal, { dispose: () => void }>();",
        "const TERMINAL_FOCUS_RETRY_LIMIT = 8;",
        "function focusTerminalSoon(currentTerm: Terminal, sessionId?: string): void",
        "focusController.focusSessionSoon(sessionId);",
        "if (target.containsActiveElement() || attempts >= TERMINAL_FOCUS_RETRY_LIMIT) return;",
        "function registerSelectionCopyListener(currentTerm: Terminal, sessionId: string): void",
        "disposeSelectionCopyListener(currentTerm);",
        "const copySelectedText = (): void => {",
        "const selectedText = currentTerm.getSelection();",
        "const restoreSelectionFocus = (): void => {",
        "if (isActiveTerminalInputTarget(sessionId)) {",
        "refocusActiveTerminalIfNeeded();",
        "if (!selectedText) {\n      restoreSelectionFocus();\n      return;\n    }",
        "copyTextToClipboard(selectedText, restoreSelectionFocus);",
        ".then(() => restoreFocus?.())",
        ".catch(() => fallbackCopyTextToClipboard(text, restoreFocus))",
        "const flushContextMenuSelectionCopy = () => {",
        'termElement?.addEventListener("contextmenu", flushContextMenuSelectionCopy);',
        'termElement?.removeEventListener("contextmenu", flushContextMenuSelectionCopy);',
        "registerSelectionCopyListener(cached.term, sessionId);",
        "registerSelectionCopyListener(term, sessionId);",
        "disposeSelectionCopyListener(term);",
        "rightClickSelectsWord: true,",
        'const TERMINAL_MOUSE_MODE_PARAMS = new Set(["9", "1000", "1002", "1003", "1005", "1006", "1007", "1015", "1016"]);',
        "function stripTerminalMouseModeControlSequences(data: string, sessionId?: string): string",
        "const TERMINAL_MOUSE_MODE_CONTROL_PARTIAL_RE = /\\x1b(?:\\[\\??[0-9;]*)?$/;",
        "function stripTerminalMouseModeControlSequencesForSession(sessionId: string, data: string): string",
        "const pendingTail = terminalMouseModeOutputTailBySession.get(sessionId) ?? \"\";",
        "terminalMouseModeOutputTailBySession.delete(sessionId);",
        "const displayText = stripTerminalMouseModeControlSequencesForSession(sessionId, decodedText);",
        "updateCodexOutputDetection(displayText);",
        "const output = displayText;",
        "stripTerminalMouseModeControlSequences(replayText)",
        "stripTerminalMouseModeControlSequences(displayReplay)",
    ]:
        assert_contains(terminal_sources, snippet, "src/components/terminal/*")

    assert "navigator.clipboard.writeText(selection).catch(() => {});" not in terminal_sources
    assert "clipboard.writeText(text).catch(() => fallbackCopyTextToClipboard(text));" not in terminal_sources
    assert "copyTextToClipboard(selectedText, () => focusTerminalSoon(currentTerm));" not in terminal_sources
    assert "registerTerminalMouseSelectionGuard" not in terminal_sources
    assert "removeMouseSelectionGuard" not in terminal_sources
    assert "formatMarkdownTablesForTerminal" not in terminal_sources


def test_focus_stability_cdp_accepts_xterm_selection_layer() -> None:
    focus_script = read_repo_text("scripts/verify-focus-stability-cdp.mjs")

    for snippet in [
        'const helper = targetPane?.querySelector(".xterm-helper-textarea");',
        'helperValue: helper?.value ?? "",',
        'xtermSelectionRects: targetPane?.querySelectorAll(".xterm-selection div").length ?? 0',
        "|| result.helperValue.trim().length > 0",
        "|| result.xtermSelectionRects > 0",
    ]:
        assert_contains(focus_script, snippet, "scripts/verify-focus-stability-cdp.mjs")


def test_terminal_toolbar_actions_restore_xterm_focus() -> None:
    terminal_pane = read_repo_text("src/components/workspace/TerminalPane.tsx")
    terminal_sources = read_terminal_sources()
    app_shell = read_repo_text("src/components/layout/AppShell.tsx")
    notification_panel = read_repo_text("src/components/layout/NotificationPanel.tsx")
    pane_drag_source = read_repo_text("src/hooks/usePaneDragSource.ts")

    focus_controller = read_repo_text("src/lib/focusController.ts")
    for snippet in [
        # xterm focus restore machinery now lives in the focusController
        'el?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")',
        "const TERMINAL_FOCUS_RETRY_LIMIT = 8;",
        "function focusSessionSoon(",
        "function focusPaneSoon(paneId: string | null | undefined): void",
    ]:
        assert_contains(focus_controller, snippet, "src/lib/focusController.ts")

    for snippet in [
        "type PaneActivationOptions = {",
        "const activatePane = useCallback((options: PaneActivationOptions = {}) => {",
        "const handlePanePointerDownCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {",
        "const isSelectionButton = event.button === 0 || event.button === 2;",
        'focusController.request("pointer", {',
        'action: "pending",',
        "if (event.button === 2) {\n      pendingPaneClickActivationRef.current = null;\n      activatePane();\n      return;\n    }",
        "const handlePanePointerUpCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {",
        "function getDocumentSelectionText(): string",
        'target.closest(".xterm-helper-textarea")',
        "pendingPaneClickActivationRef.current = {\n      sessionId: tab.sessionId,\n      pointerId: event.pointerId,\n      x: event.clientX,\n      y: event.clientY,\n      selectionText: getDocumentSelectionText(),\n    };",
        "const nextSelectionText = getDocumentSelectionText();",
        "if (nextSelectionText && nextSelectionText !== pending.selectionText) {\n      abortPendingActivation();\n      return;\n    }",
        'focusController.request("pointer", { sessionId: pending.sessionId, action: "abort" });',
        "activatePane();",
        "onPointerDownCapture={handlePanePointerDownCapture}",
        "focusController.focusPaneSoon(pane.id);",
        'focusController.request("tab-click", { sessionId: tab.sessionId, focus: true });',
    ]:
        assert_contains(terminal_pane, snippet, "src/components/workspace/TerminalPane.tsx")
    assert "onFocus={handleFocus}" not in terminal_pane
    assert "onWheelCapture=" not in terminal_pane
    assert "handlePaneWheelCapture" not in terminal_pane
    assert "ReactWheelEvent" not in terminal_pane
    assert "activatePane({ focusTerminal: false });" not in terminal_pane
    assert "if (hasDocumentTextSelection()) return;" not in terminal_pane

    for snippet in [
        "export function allowInactiveTerminalPointerFocus(sessionId: string): void",
        'focusController.request("pointer", { sessionId, action: "pending", focus: false });',
        "focusController.observeTerminalFocusIn(sessionId);",
        "focusController.clearSession(sessionId);",
    ]:
        assert_contains(terminal_sources, snippet, "src/components/terminal/*")

    for text, source in [
        (terminal_pane, "src/components/workspace/TerminalPane.tsx"),
        (app_shell, "src/components/layout/AppShell.tsx"),
        (notification_panel, "src/components/layout/NotificationPanel.tsx"),
        (pane_drag_source, "src/hooks/usePaneDragSource.ts"),
    ]:
        assert 'querySelector<HTMLTextAreaElement>("textarea")' not in text, source
        assert ".xterm-helper-textarea, textarea" not in text, source

    # AppShell and usePaneDragSource must delegate to the focusController —
    # no file-local xterm focus machinery is allowed to reappear.
    for snippet in [
        'import { focusController } from "../../lib/focusController";',
        "focusController.focusSessionSoon(useUiStore.getState().activePaneId);",
        'focusController.request("keyboard", { sessionId: targetSessionId, focus: true });',
    ]:
        assert_contains(app_shell, snippet, "src/components/layout/AppShell.tsx")

    for snippet in [
        'import { focusController } from "../lib/focusController";',
        'focusController.request("drag", { sessionId: focusSessionId, focus: true });',
    ]:
        assert_contains(pane_drag_source, snippet, "src/hooks/usePaneDragSource.ts")

    for text, source in [
        (app_shell, "src/components/layout/AppShell.tsx"),
        (pane_drag_source, "src/hooks/usePaneDragSource.ts"),
    ]:
        assert "function focusXtermInElement" not in text, source
        assert "function focusSessionSoon" not in text, source
        assert "function focusActiveSessionSoon" not in text, source
        assert ".xterm-helper-textarea" not in text, source


def test_cached_terminal_remount_disposes_input_subscriptions() -> None:
    xterm_wrapper = read_repo_text("src/components/terminal/XTermWrapper.tsx")

    for snippet in [
        "let dataDisposable: { dispose: () => void } | null = null;",
        "let binaryDisposable: { dispose: () => void } | null = null;",
        "let titleDisposable: { dispose: () => void } | null = null;",
        "dataDisposable?.dispose();",
        "binaryDisposable?.dispose();",
        "titleDisposable?.dispose();",
        "const registerInputListeners = (currentTerm: Terminal): void => {",
        "dataDisposable = currentTerm.onData((data) => {",
        "binaryDisposable = currentTerm.onBinary((data) => {",
        "titleDisposable = currentTerm.onTitleChange((title) => {",
        "registerInputListeners(cached.term);",
        "registerInputListeners(term);",
        "if (!isContainerWritable()) {",
        "if (!shouldAcceptTerminalInput(sessionId)) return;",
    ]:
        assert_contains(xterm_wrapper, snippet, "src/components/terminal/XTermWrapper.tsx")

    assert "currentTerm.onData((data) => {" not in xterm_wrapper.replace(
        "dataDisposable = currentTerm.onData((data) => {",
        "",
    )


def test_active_pane_id_follows_surviving_tab_after_close() -> None:
    workspace_layout_store = read_repo_text("src/stores/workspaceLayoutStore.ts")

    for snippet in [
        "function activeSessionIdForPane(pane: Pane | undefined): string | null",
        "let nextActivePaneId: string | null | undefined;",
        "const currentActivePaneId = useUiStore.getState().activePaneId;",
        "const removedActiveTarget = Boolean(",
        "nextActivePaneId = activeTab.sessionId;",
        "const fallbackPane = newPanes[Math.min(Math.max(sourcePaneIndex, 0), newPanes.length - 1)] ?? newPanes[0];",
        "nextActivePaneId = activeSessionIdForPane(fallbackPane);",
        "applyStructuralActivation(nextActivePaneId);",
    ]:
        assert_contains(workspace_layout_store, snippet, "src/stores/workspaceLayoutStore.ts")


def test_pane_tab_rename_double_click_does_not_steal_focus() -> None:
    pane_tab_bar = read_repo_text("src/components/workspace/PaneTabBar.tsx")

    for snippet in [
        "const suppressNextTabClick = useCallback(() => {",
        'focusController.request("tab-rename", { action: "suppress-tab-click", suppressMs: 250 });',
        "focusController.shouldSuppressTabClick()",
        "if (event.detail >= 2) {",
        "event.preventDefault();",
        "event.stopPropagation();",
        "suppressNextTabClick();",
        "startEditingTab(tab.id, label);",
        "onClick={(event) => {\n                if (event.detail >= 2) {",
        "if (isEditingTab || focusController.shouldSuppressTabClick() || shouldSuppressClick()) {",
        "onPointerDown={(e) => e.stopPropagation()}",
        "onMouseDown={(e) => e.stopPropagation()}",
        "onDoubleClick={(e) => e.stopPropagation()}",
        'WebkitUserSelect: "text",',
    ]:
        assert_contains(pane_tab_bar, snippet, "src/components/workspace/PaneTabBar.tsx")

    assert "if (shouldSuppressClick()) {" not in pane_tab_bar


def test_terminal_wheel_input_does_not_steal_keyboard_focus() -> None:
    xterm_wrapper = read_repo_text("src/components/terminal/XTermWrapper.tsx")
    terminal_sources = read_terminal_sources()
    terminal_pane = read_repo_text("src/components/workspace/TerminalPane.tsx")

    for snippet in [
        "function filterWheelFocusInputSequences(",
        "function isActiveTerminalInputTarget(sessionId: string): boolean",
        "function clearActiveTerminalNotification(sessionId: string): void",
        "function refocusActiveTerminalIfNeeded(): void",
        "function shouldAcceptTerminalInput(sessionId: string): boolean",
        'return data.replace(/\\x1b\\[[IO]/g, "");',
        "function hasTerminalUserInput(data: string): boolean",
        "return stripTerminalFocusInputSequences(stripTerminalWheelInputSequences(data)).length > 0;",
        "const terminalMouseReportModeBySession = new Set<string>();",
        "const terminalSgrMouseReportBySession = new Set<string>();",
        "function updateTerminalMouseReportMode(sessionId: string | undefined, parts: string[], final: string): void",
        "function stripTerminalMouseInputSequences(data: string): string",
        "const inputData = stripTerminalMouseInputSequences(data);",
        "function wheelEventToSgrMouseReport(currentTerm: Terminal, event: WheelEvent, lines: number): string | null",
        "export function shouldForwardWheelToApplication(",
        "function attachTerminalWheelScroll(container: HTMLElement, currentTerm: Terminal, sessionId: string, forceMouseReport: boolean): () => void",
        "const wheelScrollContainer: HTMLElement = container;",
        "event.preventDefault();\n    event.stopPropagation();\n    event.stopImmediatePropagation();",
        "const forceWheelMouseReport = startsAsAgentTui(command, args, agentId, agentKind, launchEnv);",
        "const mouseReportingEnabled = terminalMouseReportModeBySession.has(sessionId)",
        "currentTerm.buffer.active.type,",
        "event.shiftKey,",
        "chunkedWrite(sessionId, report);",
        "currentTerm.scrollLines(lines);",
        "removeWheelScrollGuard = attachTerminalWheelScroll(wheelScrollContainer, cached.term, sessionId, forceWheelMouseReport);",
        "removeWheelScrollGuard = attachTerminalWheelScroll(wheelScrollContainer, term, sessionId, forceWheelMouseReport);",
        "removeWheelScrollGuard?.();",
        "hasNonWheelInput: hasTerminalUserInput(inputData),",
        "return focusController.shouldSuppressWheelFocusInput(sessionId);",
        "const { data: inputData, hasNonWheelInput } = filterWheelFocusInputSequences(",
        "filterTerminalMouseInputSequences(data),",
        "if (!shouldAcceptTerminalInput(sessionId)) return;",
        "if (hasNonWheelInput) {\n          clearActiveTerminalNotification(sessionId);\n          focusTerminalIfNeeded(currentTerm, sessionId);\n        }",
        "chunkedWrite(sessionId, inputData);",
        "enqueueSessionWrite(sessionId, inputData);",
        "function registerTerminalWheelFocusGuard(currentTerm: Terminal, sessionId: string): () => void",
        "const activePaneId = useUiStore.getState().activePaneId;",
        'focusController.request("wheel", { sessionId, previousSessionId: activePaneId, action: "observe" });',
        "focusController.observeTerminalFocusIn(sessionId);",
        "element.addEventListener(\"wheel\", guardWheelFocus, { capture: true, passive: true });",
        "removeWheelFocusGuard = registerTerminalWheelFocusGuard(term, sessionId);",
    ]:
        assert_contains(terminal_sources, snippet, "src/components/terminal/*")

    assert 'activeBufferType === "alternate"' in terminal_sources
    assert "if (shiftKey) return false;" in terminal_sources

    assert "stripNonWheelTerminalMouseInputSequences" not in terminal_sources
    assert "function activateTerminalPane" not in terminal_sources
    assert "activateTerminalPane(sessionId)" not in terminal_sources
    assert "function registerTerminalWheelFocusSync" not in terminal_sources
    assert "removeWheelFocusSync" not in terminal_sources
    assert "focusTerminalNowIfNeeded" not in terminal_sources
    assert "ownerDocument.addEventListener(\"wheel\"" not in terminal_sources
    assert "onWheelCapture=" not in terminal_pane


def test_terminal_plain_input_bypasses_keybinding_overrides() -> None:
    terminal_sources = read_terminal_sources()
    app_shell = read_repo_text("src/components/layout/AppShell.tsx")

    for snippet in [
        "const TERMINAL_PLAIN_INPUT_KEYS = new Set([",
        '"Backspace"',
        '"Delete"',
        "function isPlainTerminalInputEvent(e: KeyboardEvent): boolean",
        "if (isPlainTerminalInputEvent(e)) {",
        "e.stopPropagation();",
        "return true;",
    ]:
        assert_contains(terminal_sources, snippet, "src/components/terminal/*")

    for snippet in [
        "function isPlainXtermInputEvent(event: KeyboardEvent): boolean",
        "if (event.ctrlKey || event.altKey || event.metaKey) return false;",
        "if (!target?.closest(\".xterm\")) return false;",
        "if (isPlainXtermInputEvent(e)) return;",
    ]:
        assert_contains(app_shell, snippet, "src/components/layout/AppShell.tsx")


def test_pty_reader_does_not_block_when_frontend_queue_is_full() -> None:
    pty_session = read_repo_text("src-tauri/src/pty/session.rs")

    for snippet in [
        "Err(mpsc::error::TrySendError::Full(rejected)) => {",
        ".frontend_queue_full_retry",
        ".dropped_chunks",
        ".fetch_add(1, Ordering::Relaxed);",
        ".dropped_bytes",
        "Keep draining the PTY even when the renderer is behind.",
    ]:
        assert_contains(pty_session, snippet, "src-tauri/src/pty/session.rs")

    assert "frontend_tx.blocking_send" not in pty_session


def test_terminal_batches_keep_backend_flowing_while_layout_is_unwritable() -> None:
    xterm_wrapper = read_repo_text("src/components/terminal/XTermWrapper.tsx")
    terminal_sources = read_terminal_sources()
    ipc = read_repo_text("src/lib/ipc.ts")
    terminal_commands = read_repo_text("src-tauri/src/commands/terminal.rs")
    manager = read_repo_text("src-tauri/src/pty/manager.rs")
    lib_rs = read_repo_text("src-tauri/src/lib.rs")

    for snippet in [
        "interface PendingFrontendBatch {",
        "TERMINAL_BATCH_RETAINED_MAX_BYTES",
        "trimOldestBatchesToByteCap",
        "const terminalDeferredBatches = new Map<string, PendingFrontendBatch[]>();",
        "const terminalRawTailBySession = new Map<string, Uint8Array>();",
        "const terminalScrollbackResyncNeeded = new Set<string>();",
        "let refreshTimers: ReturnType<typeof setTimeout>[] = [];",
        "const clearRefreshTimers = (): void => {",
        "function takeDeferredTerminalBatches(sessionId: string): PendingFrontendBatch[]",
        "function stashDeferredTerminalBatches(",
        "ackDropped?: (pending: PendingFrontendBatch) => void",
        "const enforcePendingBatchCap = (): void => {",
        "trimmed.needsScrollbackResync",
        "terminalScrollbackResyncNeeded.add(sessionId);",
        "const syncDroppedBatchScrollbackIfNeeded = async (): Promise<void> => {",
        "await syncDroppedBatchScrollbackIfNeeded();",
        "function rememberTerminalRawTail(sessionId: string, chunk: Uint8Array): void",
        "function replaceTerminalRawTail(sessionId: string, scrollback: Uint8Array): void",
        "function findLastSubarray(haystack: Uint8Array, needle: Uint8Array): number",
        "const performBackendScrollbackSync = async (): Promise<boolean> => {",
        "const syncBackendScrollbackToTerminal = (): Promise<boolean> => {",
        "let scrollbackSyncInFlight: Promise<boolean> | null = null;",
        "let frontendChannelReady = false;",
        "scrollbackSnapshot = await getSessionScrollback(sessionId);",
        "if (disposed || termDisposed || !term || !canWritePendingBatches()) return false;",
        "const tailStart = findLastSubarray(scrollback, knownTail);",
        "sliceBatchAfterScrollbackOffset(",
        "lastSynchronizedScrollbackEnd = scrollbackSnapshot.endOffset;",
        "batch.scrollbackEnd,",
        "batch.scrollbackStart > lastSynchronizedScrollbackEnd",
        "getTerminalOutputDecoder(sessionId)",
        "resetTerminalOutputDecoder(sessionId)",
        "replaceTerminalRawTail(sessionId, scrollback);",
        "rememberTerminalRawTail(sessionId, chunk);",
        "const pendingBatches: PendingFrontendBatch[] = takeDeferredTerminalBatches(sessionId);",
        "stashDeferredTerminalBatches(sessionId, carry, (pending) => {",
        "terminalDeferredBatches.delete(sessionId);",
        "terminalRawTailBySession.delete(sessionId);",
        "terminalScrollbackResyncNeeded.delete(sessionId);",
        "const isContainerPainted = (): boolean => {",
        "const hasWritableTerminalSize = (): boolean => {",
        "const isContainerWritable = (): boolean => {",
        "const canWritePendingBatches = (): boolean => {",
        "currentTerm.options.cursorBlink = isActivePane;",
        "cached.term.options.cursorBlink = useUiStore.getState().activePaneId === sessionId;",
        "cursorBlink: useUiStore.getState().activePaneId === sessionId,",
        "frontendChannelReady",
        "setFrontendVisibleIfChanged(Boolean(term && !termDisposed && isContainerWritable()));",
        "const visible = Boolean(term && !termDisposed && isContainerWritable());",
        "const paintChanged = refreshTerminalPaintedVisible();",
        "|| (terminalPaintedVisible && paintChanged);",
        "const ackCoalescer = new TerminalAckCoalescer(",
        "const ackPendingBatch = (pending: PendingFrontendBatch): void => {",
        "ackPendingBatch(pending);",
        "pendingBatches.unshift(pending);",
        "schedulePendingWriteDrain();",
        "scheduleFrontendResync();",
        "pendingBatches.length > 0 || terminalScrollbackResyncNeeded.has(sessionId)",
        "const synchronized = await syncBackendScrollbackToTerminal();",
        "planTerminalScrollbackRecovery(",
        "scrollbackSnapshot.startOffset,",
            'recoveryPlan.action === "skip-truncated"',
            "const redrawn = await scheduleTuiRecoveryRedraw();",
            "await replayTruncatedTailIntoEmptyTerminal(scrollback);",
            'recoveryPlan.action === "initial-replay"',
            "const replacesVisibleBuffer = recoveryPlan.action",
        "if (!synchronized) {",
        "refreshFrontendVisible();",
        "void resizeSession(sessionId, cols, rows).catch((error) => {",
        "const handleTerminalLayoutSignal = (event: Event): void => {",
        'window.addEventListener("mycmux:workspace-visibility-change", handleFrontendVisibilitySignal);',
        'window.addEventListener("mycmux:terminal-layout-change", handleTerminalLayoutSignal);',
        'window.removeEventListener("mycmux:workspace-visibility-change", handleFrontendVisibilitySignal);',
        'window.removeEventListener("mycmux:terminal-layout-change", handleTerminalLayoutSignal);',
        "clearRefreshTimers();",
        "scheduleFullRefresh(replayTerm, [0, 48, 160]);",
    ]:
        assert_contains(terminal_sources, snippet, "src/components/terminal/*")

    # xterm.write already renders parsed output. A second pair of full visible
    # row refreshes per PTY batch starves wheel input during streaming.
    assert "scheduleFullRefresh(term, [0, 48]);" not in xterm_wrapper
    schedule_refresh_fn = xterm_wrapper.split("const scheduleFullRefresh = ", 1)[1].split(
        "const fitAndSyncResize = ",
        1,
    )[0]
    assert "clearRefreshTimers();" in schedule_refresh_fn

    assert "await ackPendingBatch(pending)" not in xterm_wrapper
    truncated_recovery = xterm_wrapper.split(
        'if (recoveryPlan.action === "skip-truncated") {', 1
    )[1].split("replaceTerminalRawTail(sessionId, scrollback);", 1)[0]
    assert "terminalScrollbackResyncNeeded.add(sessionId);" not in truncated_recovery
    assert "return false;" not in truncated_recovery
    recovery_redraw = xterm_wrapper.split(
        "const scheduleTuiRecoveryRedraw = (): Promise<boolean> => {", 1
    )[1].split("const performBackendScrollbackSync", 1)[0]
    assert "!forceWheelMouseReport" in recovery_redraw
    assert "const hasMeaningfulTerminalScreen = (): boolean => {" in xterm_wrapper
    assert "if (!term || termDisposed || hasMeaningfulTerminalScreen()) return;" in xterm_wrapper

    snapshot_fn = xterm_wrapper.split("const readContainerVisibilitySnapshot = ", 1)[1].split(
        "const isContainerPainted = (): boolean => {",
        1,
    )[0]
    # display:none anywhere up the chain kills both displayed and painted
    assert 'style.display === "none"' in snapshot_fn
    assert 'document.visibilityState !== "hidden"' in snapshot_fn
    # visibility hidden/collapse demotes painted. Hidden terminals stay mounted
    # but must not parse/render PTY output until they are visible again.
    visibility_branch = snapshot_fn.split(
        'style.visibility === "hidden" || style.visibility === "collapse"', 1
    )[1].split("}", 1)[0]
    assert "painted = false" in visibility_branch
    assert "displayed" not in visibility_branch

    can_write_fn = xterm_wrapper.split("const canWritePendingBatches = (): boolean => {", 1)[1].split(
        "const schedulePendingWriteDrain =",
        1,
    )[0]
    assert "frontendChannelReady" in can_write_fn
    assert "isContainerWritable()" in can_write_fn
    assert "isContainerDisplayed()" not in can_write_fn

    writable_fn = xterm_wrapper.split("const isContainerWritable = (): boolean => {", 1)[1].split(
        "const canWritePendingBatches =", 1,
    )[0]
    assert "isContainerPainted() && hasWritableTerminalSize()" in writable_fn

    painted_fn = xterm_wrapper.split("const isContainerPainted = (): boolean => {", 1)[1].split(
        "const hasWritableTerminalSize = (): boolean => {",
        1,
    )[0]
    assert "readContainerVisibilitySnapshot().painted" in painted_fn
    assert "if (!term || termDisposed || !isContainerVisible())" not in xterm_wrapper
    assert "TERMINAL_BATCH_RETAINED_MAX_BYTES" in xterm_wrapper
    assert "terminalScrollbackResyncNeeded.add(sessionId);" in xterm_wrapper
    assert "pendingBatches.length > 0 || terminalScrollbackResyncNeeded.has(sessionId)" in xterm_wrapper
    assert "frontendVisible = null;" in xterm_wrapper
    assert "queueTerminalVisibilityUpdate(sessionId, visible);" in xterm_wrapper

    replay_write = xterm_wrapper.index("await writeTerminalOutput(")
    replay_tail = xterm_wrapper.index("replaceTerminalRawTail(sessionId, scrollback);", replay_write)
    replay_disposed = xterm_wrapper.index("if (disposed || termDisposed || !term) return false;", replay_write)
    assert replay_write < replay_tail < replay_disposed

    assert_contains(ipc, "export async function getSessionScrollback(sessionId: string): Promise<ScrollbackSnapshot>", "src/lib/ipc.ts")
    assert_contains(ipc, "startOffset: number;", "src/lib/ipc.ts")
    assert_contains(ipc, "endOffset: number;", "src/lib/ipc.ts")
    assert_contains(terminal_commands, "pub fn get_session_scrollback(", "src-tauri/src/commands/terminal.rs")
    assert_contains(manager, "pub fn get_scrollback(&self, session_id: &str) -> Result<Vec<u8>, String>", "src-tauri/src/pty/manager.rs")
    assert_contains(lib_rs, "commands::terminal::get_session_scrollback", "src-tauri/src/lib.rs")


def test_streaming_last_log_updates_do_not_rearm_workspace_autosave() -> None:
    socket_listener = read_repo_text("src/components/layout/SocketListener.tsx")
    metadata_store = read_repo_text("src/stores/paneMetadataStore.ts")

    assert "const unsubMeta = usePaneMetadataStore.subscribe((state, previousState) => {" in socket_listener
    assert "if (state.metadata !== previousState.metadata) markDirty();" in socket_listener
    assert "const { lastLogLine, ...metadataFields } = filtered;" in metadata_store
    assert "return changed ? { metadata: nextMetadata, lastLog: nextLastLog } : state;" in metadata_store


def test_terminal_layout_resync_is_scoped_to_its_workspace() -> None:
    xterm_wrapper = read_repo_text("src/components/terminal/XTermWrapper.tsx")
    terminal_pane = read_repo_text("src/components/workspace/TerminalPane.tsx")

    assert "workspaceId: string;" in xterm_wrapper
    assert "workspaceId={workspaceId}" in terminal_pane
    assert "const detail = (event as CustomEvent<{ workspaceId?: string }>).detail;" in xterm_wrapper
    assert "if (detail?.workspaceId && detail.workspaceId !== workspaceId) return;" in xterm_wrapper
