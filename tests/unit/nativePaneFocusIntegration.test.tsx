// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane, Workspace } from "../../src/types";

const native = vi.hoisted(() => ({ invoke: vi.fn(), nextChannel: 0, nextAttachment: 0 }));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class<T> { id = ++native.nextChannel; onmessage?: (message: T) => void; },
  invoke: native.invoke, isTauri: () => true, convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}), emitTo: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({
  label: "mycmux-w-native-focus", listen: vi.fn(async () => () => {}),
}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({
  label: "mycmux-w-native-focus", setTitle: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}), onResized: vi.fn(async () => () => {}),
  onMoved: vi.fn(async () => () => {}), isMaximized: vi.fn(async () => false),
  startDragging: vi.fn(async () => {}), toggleMaximize: vi.fn(async () => {}),
  minimize: vi.fn(async () => {}),
}) }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn(async () => {}) }));

// Only the terminal engine is replaced; XTermWrapper and its focus/recovery UI
// are rendered by the real NativePaneShell -> WorkspaceView -> TerminalPane.
vi.mock("@xterm/xterm", () => {
  const disposable = () => ({ dispose() {} });
  return { Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    element?: HTMLElement;
    textarea?: HTMLTextAreaElement;
    unicode = { activeVersion: "" };
    parser = { registerOscHandler: disposable };
    buffer = { active: { type: "normal", length: 24, baseY: 0, cursorY: 0, viewportY: 0, getLine: () => undefined } };
    constructor(options: Record<string, unknown>) { this.options = { ...options }; }
    open(container: HTMLElement) {
      this.element = container.ownerDocument.createElement("div");
      this.element.className = "xterm";
      this.textarea = container.ownerDocument.createElement("textarea");
      this.textarea.className = "xterm-helper-textarea";
      this.element.append(this.textarea); container.append(this.element);
    }
    loadAddon(addon: { activate?: (term: unknown) => void }) { addon.activate?.(this); }
    attachCustomKeyEventHandler() {}
    focus() { this.textarea?.focus(); }
    write(_data: unknown, done?: () => void) { done?.(); }
    writeln() {}
    refresh() {}
    reset() {}
    dispose() {}
    scrollToBottom() {}
    scrollToLine() {}
    getSelection() { return ""; }
    hasSelection() { return false; }
    clearSelection() {}
    onBinary = disposable;
    onData = disposable;
    onRender = disposable;
    onScroll = disposable;
    onSelectionChange = disposable;
    onTitleChange = disposable;
    onWriteParsed = disposable;
    registerLinkProvider = disposable;
    registerMarker = disposable;
  } };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { activate() {} dispose() {} fit() {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {
  activate() {} dispose() {} clearDecorations() {} findNext() { return false; } findPrevious() { return false; }
} }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class { activate() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class { activate() {} } }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { activate() {} dispose() {} } }));

import NativePaneShell from "../../src/components/layout/NativePaneShell";
import { TERMINAL_SEARCH_EVENT } from "../../src/components/terminal/XTermWrapper";
import { terminalPaneStrings } from "../../src/components/workspace/terminalPaneStrings";
import { resumeRecoveryStrings } from "../../src/components/terminal/AgentResumeRecoveryPanel";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { windowLabel } from "../../src/lib/windowContext";
import { evictTerminalCache } from "../../src/components/terminal/terminalCache";
import { nativePaneTearoutEnabled } from "../../src/lib/tearout/feature";

const WORKSPACE = "native-workspace", PANE = "native-pane", SESSION = "native-session";
const PEER_PANE = "native-peer-pane", PEER_SESSION = "native-peer-session";
const searchSelector = `input[placeholder='${terminalPaneStrings.searchPlaceholder}']`;
let host: HTMLDivElement, root: Root;

function pane(id: string, sessionId: string): Pane {
  return { id, sessionId, agentId: "shell-starter", activeTabId: `${id}-tab`,
    tabs: [{ id: `${id}-tab`, sessionId, agentId: "shell-starter", type: "terminal" }] };
}
function workspace(): Workspace {
  return { id: WORKSPACE, name: "Native focus fixture", status: "running", createdAt: 1,
    gridTemplateId: "1x2", splitColumns: [[PANE], [PEER_PANE]],
    panes: [pane(PANE, SESSION), pane(PEER_PANE, PEER_SESSION)] };
}
function owner(): HTMLElement { return host.querySelector<HTMLElement>(`[data-dnd-pane-id='${PANE}']`)!; }
function terminalInput(): HTMLTextAreaElement { return owner().querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!; }
function outsideButton(): HTMLButtonElement {
  // The shell's real band control is outside every workspace pane.
  return host.querySelector<HTMLButtonElement>("[data-native-pane-band] button")!;
}
function button(text: string, within: Element = owner()): HTMLButtonElement {
  const result = [...within.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === text);
  expect(result).toBeDefined(); return result!;
}

beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 800, width: 1200, height: 800, toJSON: () => ({}),
  });
  native.invoke.mockReset().mockImplementation((command: string, args: any = {}) => {
    if (command === "get_session_attachment_contexts") return Promise.resolve(args.sessionIds.map((session_id: string) => ({
      backend_epoch: "fixture-backend", session_id, window_label: "mycmux-w-native-focus", window_incarnation: "fixture-window",
      attachment_epoch: ++native.nextAttachment, nonce: String(native.nextAttachment), transfer_id: null, transfer_token: null,
      existing_only: Boolean(args.existingOnly),
    })));
    if (command === "create_session" || command === "tearout_attach") return Promise.resolve(args.attachmentContext);
    if (command === "get_terminal_config") return Promise.resolve({ font_size: 14, font_family: "monospace",
      background: "#000000", foreground: "#ffffff", ansi: [], windows_build_number: null });
    if (command === "is_session_alive" || command === "has_persisted_scrollback") return Promise.resolve(false);
    if (command === "get_session_input_revision") return Promise.resolve(0);
    if (command === "get_transcript_user_prompts" || command === "get_window_fragments") return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
  useSettingsStore.setState({ terminalRenderer: "dom", notificationsEnabled: false,
    paneComposerEnabled: false, showTerminalHistoryButton: false, terminalProgressDiagnosticsEnabled: false,
    nativePaneTearoutEnabled: true, macNativePaneTearoutEnabled: true });
  useWorkspaceListStore.setState({ workspaces: [workspace()], activeWorkspaceId: WORKSPACE });
  useUiStore.setState({ activePaneId: SESSION, focusRevision: 0, zoomedPaneId: null });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  const sessions = new Set([SESSION, PEER_SESSION, ...useWorkspaceListStore.getState().workspaces.flatMap(ws => ws.panes.flatMap(p => p.tabs.map(t => t.sessionId)))]);
  await act(async () => root.unmount()); host.remove(); sessions.forEach(id => evictTerminalCache(id));
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function mountNative(): Promise<HTMLTextAreaElement> {
  await act(async () => root.render(<NativePaneShell />));
  await vi.waitFor(() => expect(host.querySelectorAll(".xterm-helper-textarea")).toHaveLength(2));
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 300)); });
  expect(windowLabel()).toBe("mycmux-w-native-focus");
  expect(nativePaneTearoutEnabled(useSettingsStore.getState().nativePaneTearoutEnabled)).toBe(true);
  const shell = host.querySelector<HTMLElement>("[data-native-pane-shell]")!;
  expect(shell.hasAttribute("data-dnd-pane-id")).toBe(false);
  expect(shell.querySelector(".cmux-terminal-grid-fit")).not.toBeNull();
  expect(shell.contains(owner())).toBe(true); expect(owner().dataset.dndWorkspaceId).toBe(WORKSPACE);
  expect(terminalInput().ownerDocument).toBe(shell.ownerDocument);
  terminalInput().focus(); return terminalInput();
}
async function openSearch(): Promise<HTMLInputElement> {
  await act(async () => window.dispatchEvent(new CustomEvent(TERMINAL_SEARCH_EVENT, { detail: { sessionId: SESSION } })));
  const search = owner().querySelector<HTMLInputElement>(searchSelector)!;
  expect(document.activeElement).toBe(search); return search;
}
async function finishSearch(search: HTMLInputElement, exit: "Escape" | "close") {
  await act(async () => {
    if (exit === "Escape") search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    else { const close = search.parentElement!.querySelector<HTMLButtonElement>("button:last-child")!; close.focus(); close.click(); }
  });
  expect(search.isConnected).toBe(false);
}

function deferRestart(model: "restore" | "conflict", phase: "attach" | "stop" = "attach") {
  const previous = native.invoke.getMockImplementation()!;
  let creates = 0, release: (() => void) | undefined, releaseStop: (() => void) | undefined, ownerPresent = true;
  native.invoke.mockImplementation((command: string, args?: { sessionId?: string; attachmentContext?: unknown }) => {
    if (command === "create_session" && args?.sessionId === SESSION) {
      if (++creates === 1) return Promise.reject(model === "restore"
        ? 'AGENT_RESTORE_CHOICE_REQUIRED:{"kind":"claude","agentSessionId":"synthetic-saved","candidates":[]}'
        : `AGENT_SESSION_ALREADY_RUNNING:{"kind":"claude","agentSessionId":"synthetic-saved","ownerSessionId":"${PEER_SESSION}"}`);
      return new Promise<unknown>(resolve => { release = () => resolve(args?.attachmentContext); });
    }
    if (command === "get_agent_conversation_owner") return Promise.resolve(ownerPresent ? PEER_SESSION : null);
    if (command === "kill_session" && args?.sessionId === PEER_SESSION) {
      ownerPresent = false;
      if (phase === "stop") return new Promise<void>(resolve => { releaseStop = resolve; });
    }
    return previous(command, args);
  });
  return { finish: async () => {
    expect(release).toBeTypeOf("function");
    await act(async () => release!());
  }, pending: () => expect(release).toBeTypeOf("function"),
  waitingStop: () => expect(releaseStop).toBeTypeOf("function"),
  finishStop: async () => {
    expect(releaseStop).toBeTypeOf("function"); await act(async () => releaseStop!());
    expect(release).toBeTypeOf("function");
  } };
}
async function startRestart(model: "restore" | "conflict", phase: "attach" | "stop" = "attach") {
  const pending = deferRestart(model, phase), input = await mountNative();
  expect(owner().querySelector("[data-agent-resume-recovery]")).not.toBeNull();
  const choice = button(model === "restore" ? resumeRecoveryStrings.saved : resumeRecoveryStrings.takeover);
  choice.focus(); await act(async () => choice.click());
  if (model === "conflict") {
    const confirmation = owner().querySelector<HTMLElement>("[role='alertdialog']")!;
    expect(confirmation).not.toBeNull();
    const confirm = button(resumeRecoveryStrings.confirmStop, confirmation);
    confirm.focus(); await act(async () => confirm.click());
    expect(owner().querySelector("[role='alertdialog']")).toBeNull();
    expect(native.invoke).toHaveBeenCalledWith("kill_session", { sessionId: PEER_SESSION });
  }
  if (phase === "stop") pending.waitingStop(); else pending.pending();
  return { ...pending, input };
}

describe("M2 real native pane host and local focus ownership", () => {
  it.each(["Escape", "close"] as const)("returns search %s to the same live input after re-entry", async exit => {
    const input = await mountNative(), search = await openSearch();
    const revision = useUiStore.getState().focusRevision;
    outsideButton().focus(); search.focus();
    await finishSearch(search, exit);
    expect(input.isConnected).toBe(true); expect(document.activeElement).toBe(input);
    expect(useUiStore.getState().activePaneId).toBe(SESSION);
    expect(useUiStore.getState().focusRevision).toBe(revision);
  });
  it.each(["Escape", "close"] as const)("returns ordinary search %s without changing selection", async exit => {
    const input = await mountNative(), search = await openSearch(), revision = useUiStore.getState().focusRevision;
    await finishSearch(search, exit); expect(document.activeElement).toBe(input);
    expect(useUiStore.getState().activePaneId).toBe(SESSION); expect(useUiStore.getState().focusRevision).toBe(revision);
  });
  it("does not restore an old search completion after outside focus ends on body", async () => {
    await mountNative(); const search = await openSearch(), outside = outsideButton(); outside.focus(); outside.blur();
    expect(document.activeElement).toBe(document.body);
    // Deliver the existing Escape handler later, without re-entering search.
    await act(async () => {
      await new Promise<void>(resolve => window.setTimeout(() => {
        search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); resolve();
      }, 0));
    });
    expect(search.isConnected).toBe(false); expect(document.activeElement).toBe(document.body);
    expect(useUiStore.getState().activePaneId).toBe(SESSION);
  });
  it.each(["selection", "focus", "hidden"] as const)("preserves a newer %s when mounted native search closes", async decision => {
    await mountNative(); const search = await openSearch(), outside = outsideButton();
    await act(async () => {
      if (decision === "selection") useUiStore.getState().setActivePaneId(PEER_SESSION);
      if (decision === "focus") outside.focus();
      if (decision === "hidden") useUiStore.getState().setZoomedPaneId(PEER_PANE);
    });
    await finishSearch(search, "Escape");
    expect(document.activeElement).toBe(decision === "focus" ? outside : document.body);
    expect(useUiStore.getState().activePaneId).toBe(decision === "selection" ? PEER_SESSION : SESSION);
  });
  it.each(["restore", "conflict"] as const)("returns a delayed %s completion to the same surviving native input", async model => {
    const pending = await startRestart(model), revision = useUiStore.getState().focusRevision;
    expect(owner().querySelector("[data-agent-resume-recovery]")).not.toBeNull();
    await pending.finish();
    expect(owner().querySelector("[data-agent-resume-recovery]")).toBeNull();
    expect(pending.input.isConnected).toBe(true); expect(document.activeElement).toBe(pending.input);
    expect(pending.input.ownerDocument).toBe(host.ownerDocument);
    expect(useUiStore.getState().activePaneId).toBe(SESSION); expect(useUiStore.getState().focusRevision).toBe(revision);
  });
  it.each(["selection", "focus", "outside-body", "removed", "hidden", "background"] as const)(
    "rejects a delayed confirmed restart after newer %s intent or owner lifetime", async decision => {
      const pending = await startRestart("conflict"), outside = outsideButton();
      await act(async () => {
        if (decision === "selection") useUiStore.getState().setActivePaneId(PEER_SESSION);
        if (decision === "focus") outside.focus();
        if (decision === "outside-body") { outside.focus(); outside.blur(); }
        if (decision === "removed") useWorkspaceListStore.setState(state => ({ workspaces: state.workspaces.map(ws => ({
          ...ws, panes: ws.panes.filter(p => p.id !== PANE), splitColumns: [[PEER_PANE]],
        })) }));
        if (decision === "hidden") useUiStore.getState().setZoomedPaneId(PEER_PANE);
        if (decision === "background") {
          const background: Workspace = { ...workspace(), id: "other-native-workspace", panes: [pane("other-pane", "other-session")], splitColumns: [["other-pane"]] };
          useWorkspaceListStore.setState(state => ({ workspaces: [...state.workspaces, background], activeWorkspaceId: background.id }));
        }
      });
      const before = document.activeElement, revision = useUiStore.getState().focusRevision;
      const wasTemporary = owner()?.querySelector("[data-agent-resume-recovery]")?.contains(before) ?? false;
      if (decision === "removed") expect(pending.input.isConnected).toBe(false);
      if (decision === "hidden" || decision === "background") expect(pending.input.isConnected).toBe(true);
      await pending.finish();
      expect(document.activeElement).toBe(wasTemporary ? document.body : before);
      expect(document.activeElement).not.toBe(pending.input);
      expect(useUiStore.getState().activePaneId).toBe(decision === "selection" ? PEER_SESSION : SESSION);
      expect(useUiStore.getState().focusRevision).toBe(revision);
    },
  );
  it.each(["normal", "selection", "focus", "outside-body"] as const)(
    "keeps the confirmation intent guarded during a delayed owner stop: %s", async decision => {
      const pending = await startRestart("conflict", "stop"), outside = outsideButton();
      // The async return is already owned by this confirmation, even though
      // restartAgent/create_session has not begun yet.
      await act(async () => {
        if (decision === "selection") useUiStore.getState().setActivePaneId(PEER_SESSION);
        if (decision === "focus" || decision === "outside-body") outside.focus();
        if (decision === "outside-body") outside.blur();
      });
      const revision = useUiStore.getState().focusRevision;
      await pending.finishStop(); await pending.finish();
      expect(owner().querySelector("[data-agent-resume-recovery]")).toBeNull();
      expect(document.activeElement).toBe(decision === "normal" ? pending.input : decision === "focus" ? outside : document.body);
      expect(useUiStore.getState().activePaneId).toBe(decision === "selection" ? PEER_SESSION : SESSION);
      expect(useUiStore.getState().focusRevision).toBe(revision);
    },
  );
  it("renews a mounted native confirmation's own synchronous return after re-entry", async () => {
    deferRestart("conflict"); await mountNative();
    const choice = button(resumeRecoveryStrings.takeover); choice.focus(); await act(async () => choice.click());
    const confirmation = owner().querySelector<HTMLElement>("[role='alertdialog']")!;
    const cancel = button(resumeRecoveryStrings.cancel, confirmation); cancel.focus();
    const revision = useUiStore.getState().focusRevision; outsideButton().focus(); cancel.focus();
    await act(async () => cancel.click());
    expect(confirmation.getAttribute("role")).not.toBe("alertdialog");
    expect(document.activeElement).toBe(owner().querySelector(".pane-active-heading"));
    expect(useUiStore.getState().activePaneId).toBe(SESSION); expect(useUiStore.getState().focusRevision).toBe(revision);
  });
});
