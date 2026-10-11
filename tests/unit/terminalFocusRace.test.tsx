// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { Pane, Workspace } from "../../src/types";
import { focusController } from "../../src/lib/focusController";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { registerTerminalFocusSync } from "../../src/components/terminal/terminalFocusHelpers";
import { disposeSelectionCopyListener, registerSelectionCopyListener } from "../../src/components/terminal/terminalSelectionCopy";

vi.mock("../../src/lib/ipc", async original => ({ ...await original<object>(),
  listOnlineSavepoints: vi.fn().mockResolvedValue([]), listTrashedOnlineSavepoints: vi.fn().mockResolvedValue([]),
  onSavepointPublishProgress: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null), isTauri: () => false, Channel: class {} }));
vi.mock("../../src/hooks/usePaneDragSource", () => ({ usePaneDragSource: () => ({ beginPointerDrag: vi.fn(), shouldSuppressClick: () => false }) }));
vi.mock("../../src/components/workspace/BrowserPane", () => ({ default: () => null }));
vi.mock("../../src/components/composer/PaneComposer", () => ({ PaneComposer: () => null }));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({ default: () => <div className="xterm"><textarea className="xterm-helper-textarea" /></div>, hasTerminalBuffer: () => false }));
import TerminalPane from "../../src/components/workspace/TerminalPane";

let root: Root;
let host: HTMLDivElement;
let term: Terminal;
let terminalInput: HTMLTextAreaElement;
let search: HTMLInputElement;
let selectionChanged: () => void;
let unregisterFocus: () => void;
let canFocus: boolean;
let writeText: ReturnType<typeof vi.fn>;
const focus = vi.fn();
function Harness() {
  const workspace = useWorkspaceListStore(state => state.workspaces[0]);
  return <>{workspace.panes.map(pane => <TerminalPane key={pane.id} pane={pane} workspaceId={workspace.id} />)}</>;
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  focus.mockReset(); canFocus = true; focusController.request("tab-rename", { suppressMs: 0 });
  useSettingsStore.setState({ paneComposerEnabled: false, showTerminalHistoryButton: false });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useUiStore.setState({ activePaneId: "terminal-session", lastActivePaneId: "terminal-session", focusRevision: 0, zoomedPaneId: null });
  const panes: Pane[] = ["terminal", "online"].map(id => ({ id, agentId: "shell-starter", sessionId: `${id}-session`, activeTabId: `${id}-tab`,
    tabs: [{ id: `${id}-tab`, sessionId: `${id}-session`, agentId: "shell-starter", type: id as "terminal" | "online" }] }));
  const workspace: Workspace = { id: "workspace", name: "Synthetic", gridTemplateId: "1x1", status: "running", createdAt: 1, panes };
  useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Harness />));
  terminalInput = host.querySelector(".xterm-helper-textarea")!;
  search = host.querySelector("input[type='search']")!;
  expect(search).not.toBeNull();
  term = { element: terminalInput.parentElement!, focus: () => { focus(); if (canFocus) terminalInput.focus(); },
    getSelection: () => "selected terminal text", onSelectionChange: (callback: () => void) => {
      selectionChanged = callback; return { dispose: vi.fn() };
    } } as unknown as Terminal;
  unregisterFocus = registerTerminalFocusSync(term, "terminal-session");
  terminalInput.focus(); registerSelectionCopyListener(term, "terminal-session");
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});
afterEach(async () => {
  disposeSelectionCopyListener(term); unregisterFocus();
  await act(async () => root.unmount()); host.remove();
  focusController.clearSession("terminal-session");
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  delete (document as unknown as { execCommand?: unknown }).execCommand;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
async function selectOnline(): Promise<void> {
  await act(async () => {
    host.querySelector<HTMLElement>("[data-dnd-pane-id='online'] .pane-active-heading")!.click(); search.focus();
  });
  expect(useUiStore.getState().activePaneId).toBe("online-session"); expect(document.activeElement).toBe(search);
}
async function copySelection(): Promise<void> {
  selectionChanged();
  term.element!.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(writeText).toHaveBeenCalledExactlyOnceWith("selected terminal text");
}

describe("terminal focus restoration after newer non-terminal selection", () => {
  it.each(["absent", "missing-write"])("skips stale DOM clipboard fallback when the API is %s", async kind => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: kind === "absent" ? undefined : {} });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const select = vi.spyOn(HTMLTextAreaElement.prototype, "select");
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    selectionChanged(); term.element!.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
    await selectOnline(); await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(select).not.toHaveBeenCalled(); expect(execCommand).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(search); expect(useUiStore.getState().activePaneId).toBe("online-session");
  });

  it.each(["resolve", "reject"])("preserves the real Online search focus when pending clipboard write %ss", async outcome => {
    let complete!: () => void;
    writeText.mockImplementation(() => new Promise<void>((resolve, reject) => {
      complete = outcome === "resolve" ? resolve : () => reject(new Error("clipboard unavailable"));
    }));
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    await copySelection(); await selectOnline();
    await act(async () => { complete(); await vi.advanceTimersByTimeAsync(600); });
    expect(document.activeElement).toBe(search); expect(useUiStore.getState().activePaneId).toBe("online-session");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("cancels a genuinely scheduled allowInactive retry after Online selection", async () => {
    const neutral = document.createElement("button"); host.append(neutral); neutral.focus();
    const schedule = vi.spyOn(window, "setTimeout");
    canFocus = false;
    focusController.request("pointer", { sessionId: "terminal-session", action: "pending", focus: true });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(focus).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(neutral);
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 16);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await selectOnline(); const inputFocus = vi.spyOn(terminalInput, "focus"); canFocus = true;
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(inputFocus).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(search);
  });

  it("invalidates stale terminal input permission independently of focus retries", async () => {
    focusController.request("pointer", { sessionId: "terminal-session", action: "pending", focus: false });
    await selectOnline();
    expect(focusController.shouldAcceptTerminalInput("terminal-session")).toBe(false);
    expect(useUiStore.getState().activePaneId).toBe("online-session");
  });

  it.each(["session", "pane", "zoom"])("does not focus a non-terminal root through %s restoration", async method => {
    await selectOnline();
    if (method === "session") focusController.focusSessionSoon("online-session");
    else if (method === "pane") focusController.focusPaneSoon("online");
    else await act(async () => host.querySelector<HTMLButtonElement>("[data-dnd-pane-id='online'] .pane-tabbar-zoom")!.click());
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(document.activeElement).toBe(search); expect(useUiStore.getState().activePaneId).toBe("online-session");
    if (method === "zoom") expect(useUiStore.getState().zoomedPaneId).toBe("online");
  });

  it("keeps the composer protection during terminal retries", async () => {
    const composer = document.createElement("div"); composer.dataset.composerSession = "terminal-session";
    const input = document.createElement("textarea"); composer.append(input); host.append(composer); input.focus();
    focusController.focusSessionSoon("terminal-session", { allowInactive: true });
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(document.activeElement).toBe(input); expect(focus).not.toHaveBeenCalled();
  });

  it("does not choose a hidden retained terminal's textarea as a non-terminal fallback", async () => {
    await selectOnline();
    const retained = document.createElement("div"); retained.setAttribute("aria-hidden", "true");
    retained.dataset.retainedTerminal = "hidden-terminal";
    const hiddenInput = document.createElement("textarea"); hiddenInput.className = "xterm-helper-textarea";
    retained.append(hiddenInput); host.querySelector("[data-dnd-pane-id='online']")!.append(retained);
    focusController.focusSessionSoon("online-session"); focusController.focusPaneSoon("online");
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(document.activeElement).toBe(search);
  });

  it("keeps copying the gesture snapshot without restoring focus if selection changes before the copy timer", async () => {
    selectionChanged(); term.element!.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
    await selectOnline(); await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(writeText).toHaveBeenCalledExactlyOnceWith("selected terminal text"); expect(document.activeElement).toBe(search);
  });
});
