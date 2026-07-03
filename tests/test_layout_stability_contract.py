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

    for snippet in [
        "function reconcileColumnWidths(",
        "function reconcileRowHeightsPerCol(",
        "function reconcileLayoutMetrics(",
        "function columnsRequireBalancedWidths(",
        "if (columnsRequireBalancedWidths(previousColumns, nextColumns)) {",
        "return nextColumns.map(() => DEFAULT_LAYOUT_SIZE);",
        "resetLayoutMetrics || panesChanged || splitLayoutChanged,",
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
        "const FIT_LAYOUT_MIN_SIZE = 1;",
        "function fitLayoutSizes(",
        "const columnWidths = fitLayoutSizes(workspace?.columnWidths, viewportSize.width, cols.length);",
        "const hasMeasuredViewport = viewportSize.width > 0 && viewportSize.height > 0;",
        "const layoutSignature = cols.map((col) => col.join(\",\")).join(\"|\");",
        "const terminalLayoutSignature = useMemo(",
        "key={`cols-${layoutSignature}`}",
        "const colSignature = col.join(\",\");",
        "const rowHeights = fitLayoutSizes(rowHeightsPerCol?.[colIdx], viewportSize.height, col.length);",
        "defaultSizes={columnWidths}",
        "defaultSizes={rowHeights}",
        "preferredSize={columnWidths?.[colIdx]}",
        "preferredSize={rowHeights?.[rowIdx]}",
        "proportionalLayout",
        "minSize={FIT_LAYOUT_MIN_SIZE}",
        'className="cmux-terminal-grid-fit"',
        'overflow: "hidden"',
        "const visibleWorkspaceSignature = useMemo(",
        'new CustomEvent("mycmux:workspace-visibility-change"',
        'new CustomEvent("mycmux:terminal-layout-change"',
        "layoutSignature: terminalLayoutSignature",
        "window.requestAnimationFrame(() => {",
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
        "columnWidths.every((size) => positiveSize(size) !== null)",
        "row.every((size) => positiveSize(size) !== null)",
        "const normalizedSplitColumns = normalizeSplitColumns(splitColumns, panes.map((pane) => pane.id));",
        "const paneIds = panes.map((pane) => pane.id);",
        "const panesChanged = paneIdsChanged(w.panes, panes);",
        "const previousSplitColumns = fallbackColumns(w);",
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
        "const displayText = stripTerminalMouseModeControlSequencesForSession(sessionId, decodedText);",
        "replayTerm.write(`${stripTerminalMouseModeControlSequences(displayReplay)}\\r\\n`, () => resolve());",
    ]:
        assert_contains(terminal_sources, snippet, "src/components/terminal/*")

    assert "navigator.clipboard.writeText(selection).catch(() => {});" not in terminal_sources
    assert "clipboard.writeText(text).catch(() => fallbackCopyTextToClipboard(text));" not in terminal_sources
    assert "copyTextToClipboard(selectedText, () => focusTerminalSoon(currentTerm));" not in terminal_sources
    assert "registerTerminalMouseSelectionGuard" not in terminal_sources
    assert "removeMouseSelectionGuard" not in terminal_sources


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
        "if (event.button === 2) {\n      pendingPaneClickActivationRef.current = null;\n      return;\n    }",
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

    xterm_wrapper = read_repo_text("src/components/terminal/XTermWrapper.tsx")
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
        "if (!isContainerDisplayed()) {",
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
        "function attachTerminalWheelScroll(container: HTMLElement, currentTerm: Terminal, sessionId: string, forceMouseReport: boolean): () => void",
        "const wheelScrollContainer: HTMLElement = container;",
        "event.preventDefault();\n    event.stopPropagation();\n    event.stopImmediatePropagation();",
        "const forceWheelMouseReport = startsAsAgentTui(command, args, agentId, agentKind, launchEnv);",
        "if (forceMouseReport || (terminalMouseReportModeBySession.has(sessionId) && terminalSgrMouseReportBySession.has(sessionId)))",
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
        "const syncBackendScrollbackToTerminal = async (): Promise<void> => {",
        "scrollbackData = await getSessionScrollback(sessionId);",
        "const tailStart = findLastSubarray(scrollback, knownTail);",
        "replaceTerminalRawTail(sessionId, scrollback);",
        "rememberTerminalRawTail(sessionId, chunk);",
        "const pendingBatches: PendingFrontendBatch[] = takeDeferredTerminalBatches(sessionId);",
        "stashDeferredTerminalBatches(sessionId, carry, (pending) => {",
        "terminalDeferredBatches.delete(sessionId);",
        "terminalRawTailBySession.delete(sessionId);",
        "terminalScrollbackResyncNeeded.delete(sessionId);",
        "const isContainerDisplayed = (): boolean => {",
        "const isContainerPainted = (): boolean => {",
        "const hasWritableTerminalSize = (): boolean => {",
        "const canWritePendingBatches = (): boolean => {",
        "return Boolean(term && !termDisposed && isContainerPainted() && hasWritableTerminalSize());",
        "setFrontendVisibleIfChanged(Boolean(term && !termDisposed && isContainerDisplayed()));",
        "const visible = Boolean(term && !termDisposed && isContainerPainted());",
        "const paintChanged = refreshTerminalPaintedVisible();",
        "|| (terminalPaintedVisible && paintChanged);",
        "const ackPendingBatch = async (pending: PendingFrontendBatch): Promise<void> => {",
        "void ackPendingBatch(pending);",
        "pendingBatches.unshift(pending);",
        "schedulePendingWriteDrain();",
        "scheduleFrontendResync();",
        "if (pendingBatches.length > 0 && canWritePendingBatches())",
        "refreshFrontendVisible();",
        "void resizeSession(sessionId, cols, rows).catch((error) => {",
        "const handleTerminalLayoutSignal = (): void => {",
        'window.addEventListener("mycmux:workspace-visibility-change", handleFrontendVisibilitySignal);',
        'window.addEventListener("mycmux:terminal-layout-change", handleTerminalLayoutSignal);',
        'window.removeEventListener("mycmux:workspace-visibility-change", handleFrontendVisibilitySignal);',
        'window.removeEventListener("mycmux:terminal-layout-change", handleTerminalLayoutSignal);',
        "clearRefreshTimers();",
        "scheduleFullRefresh(replayTerm, [0, 48, 160]);",
    ]:
        assert_contains(terminal_sources, snippet, "src/components/terminal/*")

    snapshot_fn = xterm_wrapper.split("const readContainerVisibilitySnapshot = ", 1)[1].split(
        "const isContainerDisplayed = (): boolean => {",
        1,
    )[0]
    # display:none anywhere up the chain kills both displayed and painted
    assert 'style.display === "none"' in snapshot_fn
    # visibility hidden/collapse only demotes painted, never displayed
    visibility_branch = snapshot_fn.split(
        'style.visibility === "hidden" || style.visibility === "collapse"', 1
    )[1].split("}", 1)[0]
    assert "painted = false" in visibility_branch
    assert "displayed" not in visibility_branch

    displayed_fn = xterm_wrapper.split("const isContainerDisplayed = (): boolean => {", 1)[1].split(
        "const isContainerPainted = (): boolean => {",
        1,
    )[0]
    assert "readContainerVisibilitySnapshot().displayed" in displayed_fn
    assert "style.visibility" not in displayed_fn

    can_write_fn = xterm_wrapper.split("const canWritePendingBatches = (): boolean => {", 1)[1].split(
        "const schedulePendingWriteDrain =",
        1,
    )[0]
    assert "isContainerPainted()" in can_write_fn
    assert "isContainerDisplayed() && hasWritableTerminalSize()" not in can_write_fn

    painted_fn = xterm_wrapper.split("const isContainerPainted = (): boolean => {", 1)[1].split(
        "const hasWritableTerminalSize = (): boolean => {",
        1,
    )[0]
    assert "readContainerVisibilitySnapshot().painted" in painted_fn
    assert "if (!term || termDisposed || !isContainerVisible())" not in xterm_wrapper
    assert "TERMINAL_BATCH_RETAINED_MAX_BYTES" in xterm_wrapper

    assert_contains(ipc, "export async function getSessionScrollback(sessionId: string): Promise<number[]>", "src/lib/ipc.ts")
    assert_contains(terminal_commands, "pub fn get_session_scrollback(", "src-tauri/src/commands/terminal.rs")
    assert_contains(manager, "pub fn get_scrollback(&self, session_id: &str) -> Result<Vec<u8>, String>", "src-tauri/src/pty/manager.rs")
    assert_contains(lib_rs, "commands::terminal::get_session_scrollback", "src-tauri/src/lib.rs")
