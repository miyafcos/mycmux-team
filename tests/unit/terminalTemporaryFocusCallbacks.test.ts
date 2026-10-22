// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import ts from "typescript";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { capturePaneFocusReturn, captureTemporaryFocusReturn, focusController } from "../../src/lib/focusController";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
const source = readFileSync("src/components/terminal/XTermWrapper.tsx", "utf8").replaceAll("\r\n", "\n");
function callback(name: string, dependencies: Record<string, unknown>) {
  const start = source.indexOf(`const ${name} = useCallback(`);
  const end = source.indexOf("\n\n", start);
  return new Function(...Object.keys(dependencies), ts.transpile(`${source.slice(start, end)}\nreturn ${name};`))(...Object.values(dependencies));
}
let pane: HTMLElement, container: HTMLElement, search: HTMLInputElement, terminal: HTMLTextAreaElement, outside: HTMLButtonElement;
beforeEach(() => {
  pane = document.createElement("div"); pane.dataset.dndPaneId = "pane"; pane.dataset.dndWorkspaceId = "workspace";
  container = document.createElement("div"); terminal = document.createElement("textarea"); terminal.className = "xterm-helper-textarea"; container.append(terminal);
  const controls = document.createElement("div"); search = document.createElement("input"); controls.append(search); pane.append(container, controls);
  outside = document.createElement("button"); document.body.append(pane, outside);
  useWorkspaceListStore.setState({ activeWorkspaceId: "workspace", workspaces: [{ id: "workspace", panes: [{ id: "pane", tabs: [] }] }] as never });
  useUiStore.setState({ activePaneId: "session", focusRevision: 0, zoomedPaneId: null });
});
afterEach(() => { pane.remove(); outside.remove(); vi.restoreAllMocks(); });
describe("production XTermWrapper search completion callbacks", () => {
  it.each(["closeSearch", "handleSearchKeyDown"])("%s preserves normal input restoration and cancels superseded focus", name => {
    const ref = { current: null as ReturnType<typeof capturePaneFocusReturn> | null };
    const dependencies = { useCallback: (fn: unknown) => fn, focusController, sessionId: "session", capturePaneFocusReturn, captureTemporaryFocusReturn,
      containerRef: { current: container }, searchInputRef: { current: search }, searchFocusReturnRef: ref,
      setIsSearchOpen: vi.fn(), setSearchQuery: vi.fn(), searchQuery: "query", searchAddonRef: { current: { clearDecorations: vi.fn() } } };
    callback("openSearch", dependencies)(); search.focus();
    const finish = callback(name, dependencies); finish({ key: "Escape" }); expect(document.activeElement).toBe(terminal);
    callback("openSearch", dependencies)(); search.focus();
    useUiStore.getState().bumpFocusRevision(); finish({ key: "Escape" }); expect(document.activeElement).toBe(search);
    callback("openSearch", dependencies)(); search.focus(); outside.focus(); finish({ key: "Escape" }); expect(document.activeElement).toBe(outside);
  });
});

it("returns only the old confirmation's own focus from the actual XTermWrapper handler", () => {
  const recovery = document.createElement("div"); recovery.dataset.agentResumeRecovery = "conflict";
  const cancel = document.createElement("button"); recovery.append(cancel); pane.append(recovery);
  const heading = document.createElement("div"); heading.className = "pane-active-heading"; heading.tabIndex = 0; pane.prepend(heading);
  const start = source.indexOf("onConfirm={yes => {") + "onConfirm={".length;
  const end = source.indexOf("\n      />}", start);
  const expression = source.slice(start, end).trim().replace(/}$/, "");
  const restore = { current: capturePaneFocusReturn(pane, heading, () => true) as ReturnType<typeof capturePaneFocusReturn> | null };
  const confirm = { current: vi.fn() as ((yes: boolean) => void) | null };
  const setConfirmation = vi.fn();
  const handler = new Function("containerRef", "resumeFocusReturnRef", "resumeConfirmationRef", "setResumeConfirmation", ts.transpile(`return (${expression});`))({current: container}, restore, confirm, setConfirmation);
  cancel.focus(); handler(false); expect(document.activeElement).toBe(heading); expect(setConfirmation).toHaveBeenCalledWith(null);
  restore.current = capturePaneFocusReturn(pane, heading, () => true); cancel.focus(); useUiStore.getState().bumpFocusRevision();
  handler(false); expect(document.activeElement).toBe(cancel);
});

it.each(["normal", "revision", "other-focus"])("preserves %s focus when the actual async restart completes", async decision => {
  const recovery = document.createElement("div"); recovery.dataset.agentResumeRecovery = "conflict";
  const choice = document.createElement("button"); recovery.append(choice); pane.append(recovery); choice.focus();
  let release!: () => void;
  const attach = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const dependencies = { disposed: false, termDisposed: false, sessionId: "session",
    confirmedResumeFocusReturnRef: { current: null },
    term: { cols: 80, rows: 24, focus: () => terminal.focus() }, containerRef: { current: container }, capturePaneFocusReturn,
    setResumeBusy: vi.fn(), setResumeError: vi.fn(), setResumeRecovery: vi.fn(), setResumeConfirmation: vi.fn(),
    buildAgentRecoveryLaunch: () => ({}), launchParamsRef: { current: {} }, attachFrontendChannel: attach,
    usePaneMetadataStore: { getState: () => ({ clearAgentSessionId: vi.fn(), clearClaudeSessionId: vi.fn() }) },
    useWorkspaceListStore: { getState: () => ({ setPaneAgentSessionFromMetadata: vi.fn() }) }, handleResumeBlock: vi.fn() };
  const start = source.indexOf("const restartAgent = async (");
  const end = source.indexOf("const performResumeAction =", start);
  const restart = new Function(...Object.keys(dependencies), ts.transpile(`let recoveryLaunch = null, restoreConfirmed = false, sessionStarted = false, sessionExitPending = false;\n${source.slice(start, end)}\nreturn restartAgent;`))(...Object.values(dependencies));
  const pending = restart("codex", "synthetic-session", false); expect(attach).toHaveBeenCalledOnce();
  if (decision === "revision") useUiStore.getState().bumpFocusRevision();
  if (decision === "other-focus") outside.focus();
  release(); await pending;
  expect(document.activeElement).toBe(decision === "normal" ? terminal : decision === "revision" ? choice : outside);
});
