// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evictTerminalCache } from "../../src/components/terminal/terminalCache";
import { __turnListPromptCacheForTests } from "../../src/components/terminal/XTermWrapper";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  nextChannel: 0,
  nextAttachment: 0,
  turnMarks: [] as Array<{ line: number; label: string; at: number }>,
  bufferType: "alternate" as "normal" | "alternate",
  bufferLines: [] as string[],
  transcriptResponses: [] as Array<Array<{ text: string; occurredAt: number }>>,
  stallWrites: false,
  writeCallbacks: [] as Array<() => void>,
  terminalInstances: [] as Array<{
    dispose: ReturnType<typeof vi.fn>;
    scrollToLine: ReturnType<typeof vi.fn>;
    keyHandler?: (event: KeyboardEvent) => boolean;
    emitData(data: string): void;
    dataListeners: Set<(data: string) => void>;
    focusReporting: boolean;
    adversarialFocusData: string[];
    refuseFocus: boolean;
    focusBeforeReturn?: () => void;
    write: ReturnType<typeof vi.fn>;
    renderListeners: Set<(event: { start: number; end: number }) => void>;
  }>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class<T> {
    id = ++mocks.nextChannel;
    onmessage?: (message: T) => void;
  },
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "detached-focus-test", setTitle: vi.fn().mockResolvedValue(undefined) }) }));
vi.mock("../../src/components/layout/SocketListener", () => ({ closeWindowWorkspacesAndDestroy: vi.fn() }));

vi.mock("@xterm/xterm", () => {
  const disposable = () => ({ dispose: vi.fn() });
  class FakeTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    element: HTMLElement | undefined;
    textarea: HTMLTextAreaElement | undefined;
    unicode = { activeVersion: "" };
    parser = { registerOscHandler: vi.fn(() => disposable()) };
    buffer = {
      active: {
        get type(): "normal" | "alternate" { return mocks.bufferType; },
        get length(): number { return Math.max(24, mocks.bufferLines.length); },
        baseY: 0,
        cursorY: 0,
        viewportY: 0,
        getLine: (index: number) => {
          const text = mocks.bufferLines[index];
          return text === undefined
            ? undefined
            : { isWrapped: false, translateToString: () => text };
        },
      },
    };
    dispose = vi.fn();

    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      mocks.terminalInstances.push(this);
    }

    loadAddon(addon: { activate?: (terminal: FakeTerminal) => void }): void {
      addon.activate?.(this);
    }

    open(container: HTMLElement): void {
      this.element = document.createElement("div");
      this.textarea = document.createElement("textarea");
      this.textarea.className = "xterm-helper-textarea";
      // xterm 6 reports from focus/blur listeners, before bubbling focusin/out.
      this.textarea.addEventListener("focus", () => { if (this.focusReporting) this.emitData("\x1b[I"); });
      this.textarea.addEventListener("blur", () => { if (this.focusReporting) this.emitData("\x1b[O"); });
      this.element.appendChild(this.textarea);
      container.appendChild(this.element);
    }

    keyHandler?: (event: KeyboardEvent) => boolean;
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void { this.keyHandler = handler; }
    dataListeners = new Set<(data: string) => void>();
    emitData(data: string): void { for (const listener of this.dataListeners) listener(data); }
    focusReporting = false;
    adversarialFocusData: string[] = [];
    refuseFocus = false;
    focusBeforeReturn?: () => void;
    focus(): void {
      const wasFocused = document.activeElement === this.textarea;
      if (!this.refuseFocus) this.textarea?.focus();
      // Explicit adversarial injection is separate from native focus transitions.
      if (!wasFocused) for (const data of this.adversarialFocusData) this.emitData(data);
      this.focusBeforeReturn?.();
    }
    refresh(): void {}
    reset(): void {}
    scrollToBottom = vi.fn();
    scrollToLine = vi.fn();
    write = vi.fn((_data: string | Uint8Array, callback?: () => void): void => {
      if (callback && mocks.stallWrites) mocks.writeCallbacks.push(callback);
      else callback?.();
    });
    writeln(): void {}
    getSelection(): string { return ""; }
    hasSelection(): boolean { return false; }
    clearSelection(): void {}
    onBinary(): { dispose: () => void } { return disposable(); }
    onData(listener: (data: string) => void): { dispose: () => void } {
      this.dataListeners.add(listener);
      return { dispose: () => { this.dataListeners.delete(listener); } };
    }
    renderListeners = new Set<(event: { start: number; end: number }) => void>();
    onRender(listener: (event: { start: number; end: number }) => void): { dispose: () => void } {
      this.renderListeners.add(listener);
      return { dispose: () => { this.renderListeners.delete(listener); } };
    }
    onScroll(): { dispose: () => void } { return disposable(); }
    onSelectionChange(): { dispose: () => void } { return disposable(); }
    onTitleChange(): { dispose: () => void } { return disposable(); }
    onWriteParsed(): { dispose: () => void } { return disposable(); }
    registerLinkProvider(): { dispose: () => void } { return disposable(); }
    registerMarker(): { dispose: () => void } { return disposable(); }
  }
  return { Terminal: FakeTerminal };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    activate(): void {}
    dispose(): void {}
    fit(): void {}
  },
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    activate(): void {}
    dispose(): void {}
    clearDecorations(): void {}
    findNext(): boolean { return false; }
    findPrevious(): boolean { return false; }
  },
}));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class { activate(): void {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class { activate(): void {} } }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { activate(): void {} dispose(): void {} } }));

vi.mock("../../src/components/terminal/terminalTurnMarkers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/components/terminal/terminalTurnMarkers")>();
  return {
    ...actual,
    getTurnMarkData: vi.fn(() => mocks.turnMarks),
    restoreTurnMarksAtLines: vi.fn((
      _sessionId: string,
      _term: unknown,
      entries: ReadonlyArray<{ line: number; label: string; at: number }>,
    ) => {
      mocks.turnMarks = entries.map((entry) => ({ ...entry }));
      return entries.length;
    }),
  };
});

import XTermWrapper, { TERMINAL_SEARCH_EVENT } from "../../src/components/terminal/XTermWrapper";
import PaneTabBar from "../../src/components/workspace/PaneTabBar";
import { terminalPaneStrings } from "../../src/components/workspace/terminalPaneStrings";
import type { Pane, Workspace } from "../../src/types";
import {
  restoreTurnMarksAtLines,
  TURN_MARKS_EVENT,
} from "../../src/components/terminal/terminalTurnMarkers";
import { terminalTurnStrings } from "../../src/components/terminal/terminalTurnStrings";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { applyExternalStoreUpdate } from "../../src/stores/syncedPersist";
import { usePaneHoverFocus } from "../../src/hooks/usePaneHoverFocus";
import { focusController } from "../../src/lib/focusController";
import { prepareStartupSessionGate } from "../../src/lib/startupSessionGate";
import { rememberTearoutDormantSessions } from "../../src/lib/tearout/sessionAttachment";
import { TERMINAL_HISTORY_EVENT } from "../../src/components/terminal/TerminalHistoryEntry";
import DetachedPaneShell from "../../src/components/layout/DetachedPaneShell";
import type { DetachedWorkspace } from "../../src/lib/detachedPane";
import { resumeRecoveryStrings } from "../../src/components/terminal/AgentResumeRecoveryPanel";
import TerminalPane from "../../src/components/workspace/TerminalPane";

// Built from the placeholder the component renders, so translating it does
// not silently turn these reachability checks into no-ops.
const SEARCH_INPUT = `input[placeholder='${terminalPaneStrings.searchPlaceholder}']`;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => (
    window.setTimeout(() => callback(performance.now()), 0)
  ));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      this.callback(
        [{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    disconnect(): void {}
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1200,
    bottom: 800,
    width: 1200,
    height: 800,
    toJSON: () => ({}),
  });

  mocks.turnMarks = [];
  mocks.bufferType = "alternate";
  mocks.bufferLines = [];
  mocks.transcriptResponses = [];
  mocks.stallWrites = false;
  mocks.writeCallbacks = [];
  mocks.terminalInstances.length = 0;
  mocks.invoke.mockReset();
  vi.mocked(restoreTurnMarksAtLines).mockClear();
  mocks.invoke.mockImplementation((command: string, args: any = {}) => {
    if (command === "get_session_attachment_contexts") return Promise.resolve(args.sessionIds.map((session_id: string) => ({
      backend_epoch: "fixture-backend", session_id, window_label: "detached-focus-test", window_incarnation: "fixture-window",
      attachment_epoch: ++mocks.nextAttachment, nonce: String(mocks.nextAttachment), transfer_id: null, transfer_token: null,
      existing_only: Boolean(args.existingOnly),
    })));
    if (command === "create_session" || command === "tearout_attach") return Promise.resolve(args.attachmentContext);
    if (command === "get_terminal_config") {
      return Promise.resolve({
        font_size: 14,
        font_family: "monospace",
        background: "#000000",
        foreground: "#ffffff",
        ansi: [],
        windows_build_number: null,
      });
    }
    if (command === "is_session_alive") return Promise.resolve(false);
    if (command === "has_persisted_scrollback") return Promise.resolve(false);
    if (command === "get_session_input_revision") return Promise.resolve(0);
    if (command === "get_transcript_user_prompts") {
      return Promise.resolve(mocks.transcriptResponses.shift() ?? []);
    }
    return Promise.resolve(undefined);
  });
  useSettingsStore.setState({
    terminalRenderer: "dom",
    notificationsEnabled: false,
    showTerminalHistoryButton: true,
    terminalProgressDiagnosticsEnabled: false,
  });
  useUiStore.setState({ activePaneId: null, focusRevision: 0 });
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });

  host = document.createElement("div"); host.dataset.cmuxThemedRoot = "true";
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("L1 actual legacy detached host with the mounted XTermWrapper", () => {
  async function mountDetached(sessionId: string): Promise<void> {
    const workspace: DetachedWorkspace = { id: "detached", name: "Detached fixture", detached: true,
      status: "running", gridTemplateId: "1x1", createdAt: 1,
      panes: [{ id: "detached-pane", sessionId, agentId: "shell-starter", activeTabId: "detached-tab",
        tabs: [{ id: "detached-tab", sessionId, type: "terminal", agentId: "shell-starter" }] }] };
    useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
    useUiStore.setState({ activePaneId: sessionId, focusRevision: 0, zoomedPaneId: null });
    await act(async () => root.render(<DetachedPaneShell workspace={workspace} />));
    await vi.waitFor(() => expect(host.querySelector(".xterm-helper-textarea")).not.toBeNull());
    // Finish the host's established mount-focus/resize bursts before a user opens search.
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 300)); });
    expect(host.querySelector("[data-dnd-pane-id]")).toBeNull();
  }
  it.each(["Escape", "close"])("returns search %s to this window's real terminal input", async exit => {
    const sessionId = `detached-search-${exit}`; await mountDetached(sessionId);
    const terminal = host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!; terminal.focus();
    await act(async () => window.dispatchEvent(new CustomEvent(TERMINAL_SEARCH_EVENT, { detail: { sessionId } })));
    const search = host.querySelector<HTMLInputElement>(SEARCH_INPUT)!; expect(document.activeElement).toBe(search);
    await act(async () => {
      if (exit === "Escape") search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      else { const close = search.parentElement!.querySelector<HTMLButtonElement>("button:last-child")!; close.focus(); close.click(); }
    });
    expect(search.isConnected).toBe(false); expect(document.activeElement).toBe(terminal);
  });
  it.each(["revision", "focus", "removed"])("preserves a newer %s decision when detached search closes", async decision => {
    const sessionId = `detached-search-guard-${decision}`; await mountDetached(sessionId);
    await act(async () => window.dispatchEvent(new CustomEvent(TERMINAL_SEARCH_EVENT, { detail: { sessionId } })));
    const search = host.querySelector<HTMLInputElement>(SEARCH_INPUT)!;
    const outside = document.createElement("button"); host.append(outside);
    if (decision === "revision") useUiStore.getState().bumpFocusRevision();
    if (decision === "focus") outside.focus();
    if (decision === "removed") useWorkspaceListStore.setState({ workspaces: [] });
    await act(async () => search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.activeElement).toBe(decision === "focus" ? outside : document.body);
  });
  it.each(["normal", "revision", "focus"])("guards %s focus after the actual detached asynchronous restart", async decision => {
    const previous = mocks.invoke.getMockImplementation()!; let creates = 0; let release!: () => void;
    mocks.invoke.mockImplementation((command: string, ...args: unknown[]) => {
      if (command === "create_session" && ++creates === 1) return Promise.reject('AGENT_RESTORE_CHOICE_REQUIRED:{"kind":"claude","agentSessionId":"synthetic-saved","candidates":[]}');
      if (command === "create_session") return new Promise<unknown>(resolve => { release = () => resolve((args[0] as { attachmentContext: unknown }).attachmentContext); });
      return previous(command, ...args);
    });
    await mountDetached(`detached-restart-${decision}`);
    await vi.waitFor(() => expect(host.querySelector("[data-agent-resume-recovery]")).not.toBeNull());
    const saved = [...host.querySelectorAll<HTMLButtonElement>("[data-agent-resume-recovery] button")].find(b => b.textContent === resumeRecoveryStrings.saved)!;
    saved.focus(); await act(async () => saved.click()); expect(release).toBeTypeOf("function");
    const outside = document.createElement("button"); host.append(outside);
    if (decision === "revision") useUiStore.getState().bumpFocusRevision();
    if (decision === "focus") outside.focus();
    await act(async () => release());
    expect(host.querySelector("[data-agent-resume-recovery]")).toBeNull();
    expect(document.activeElement).toBe(decision === "normal" ? host.querySelector(".xterm-helper-textarea") : decision === "focus" ? outside : document.body);
  });
});

describe("M1 mounted terminal search return intent", () => {
  async function mountSearchHost(kind: "pane" | "legacy"): Promise<HTMLTextAreaElement> {
    const sessionId = `m1-search-${kind}`;
    const pane: Pane = { id: "m1-pane", sessionId, agentId: "shell-starter", activeTabId: "m1-tab",
      tabs: [{ id: "m1-tab", sessionId, type: "terminal", agentId: "shell-starter" }] };
    const workspace: DetachedWorkspace = { id: "m1-workspace", name: "Search", detached: true,
      panes: [pane], gridTemplateId: "1x1", status: "running", createdAt: 1 };
    useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
    useUiStore.setState({ activePaneId: sessionId, focusRevision: 0, zoomedPaneId: null });
    useSettingsStore.setState({ paneComposerEnabled: false, showTerminalHistoryButton: false });
    await act(async () => root.render(kind === "legacy" ? <DetachedPaneShell workspace={workspace} />
      : <TerminalPane pane={pane} workspaceId={workspace.id} onClose={() => {}} />));
    await vi.waitFor(() => expect(host.querySelector(".xterm-helper-textarea")).not.toBeNull());
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 300)); });
    const terminal = host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!; terminal.focus();
    await act(async () => window.dispatchEvent(new CustomEvent(TERMINAL_SEARCH_EVENT, { detail: { sessionId } })));
    return terminal;
  }
  it.each(["pane", "legacy"] as const)("returns %s search Escape and close after leaving and re-entering without selecting", async kind => {
    const terminal = await mountSearchHost(kind); const sessionId = useUiStore.getState().activePaneId;
    const outside = document.createElement("button"); host.append(outside);
    for (const exit of ["Escape", "close"]) {
      if (exit === "close") await act(async () => window.dispatchEvent(new CustomEvent(TERMINAL_SEARCH_EVENT, { detail: { sessionId } })));
      const search = host.querySelector<HTMLInputElement>(SEARCH_INPUT)!; expect(document.activeElement).toBe(search);
      const revision = useUiStore.getState().focusRevision;
      await act(async () => outside.focus()); expect(document.activeElement).toBe(outside);
      await act(async () => search.focus()); expect(document.activeElement).toBe(search);
      await act(async () => {
        if (exit === "Escape") search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        else { const close = search.parentElement!.querySelector<HTMLButtonElement>("button:last-child")!; close.focus(); close.click(); }
      });
      expect.soft(search.isConnected).toBe(false); expect.soft(document.activeElement).toBe(terminal);
      expect(useUiStore.getState().activePaneId).toBe(sessionId); expect(useUiStore.getState().focusRevision).toBe(revision);
    }
  });
  it.each(["pane", "legacy"] as const)("rejects %s delayed search close after leaving without re-entry", async kind => {
    await mountSearchHost(kind); const search = host.querySelector<HTMLInputElement>(SEARCH_INPUT)!;
    const close = search.parentElement!.querySelector<HTMLButtonElement>("button:last-child")!;
    const outside = document.createElement("button"); host.append(outside);
    const before = useUiStore.getState(); await act(async () => { outside.focus(); outside.blur(); });
    expect(document.activeElement).toBe(document.body);
    await act(async () => { await new Promise(resolve => window.setTimeout(() => { close.click(); resolve(undefined); }, 0)); });
    expect(search.isConnected).toBe(false); expect(document.activeElement).toBe(document.body);
    expect(useUiStore.getState().activePaneId).toBe(before.activePaneId); expect(useUiStore.getState().focusRevision).toBe(before.focusRevision);
  });
  it.each(["pane", "legacy"] as const)("rejects a newer selection after %s search re-entry", async kind => {
    await mountSearchHost(kind); const search = host.querySelector<HTMLInputElement>(SEARCH_INPUT)!;
    const outside = document.createElement("button"); host.append(outside);
    await act(async () => { outside.focus(); search.focus(); }); useUiStore.getState().bumpFocusRevision();
    await act(async () => search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(search.isConnected).toBe(false); expect(document.activeElement).toBe(document.body);
  });
  it("returns a re-entered actual resume confirmation to its durable pane on synchronous cancellation", async () => {
    const previous = mocks.invoke.getMockImplementation()!; let creates = 0;
    mocks.invoke.mockImplementation((command: string, ...args: unknown[]) => {
      if (command === "create_session" && ++creates === 1) return Promise.reject('AGENT_SESSION_ALREADY_RUNNING:{"kind":"claude","agentSessionId":"synthetic-saved","ownerSessionId":"synthetic-peer"}');
      if (command === "get_agent_conversation_owner") return Promise.resolve("synthetic-peer");
      if (command === "get_window_fragments") return Promise.resolve([]);
      return previous(command, ...args);
    });
    await mountSearchHost("pane");
    const search = host.querySelector<HTMLInputElement>(SEARCH_INPUT)!;
    await act(async () => search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    const takeover = [...host.querySelectorAll<HTMLButtonElement>("[data-agent-resume-recovery] button")].find(b => b.textContent === resumeRecoveryStrings.takeover)!;
    takeover.focus(); await act(async () => takeover.click());
    const confirmation = host.querySelector<HTMLElement>("[role='alertdialog']")!; expect(confirmation).not.toBeNull();
    const cancel = [...confirmation.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === resumeRecoveryStrings.cancel)!; cancel.focus();
    const before = useUiStore.getState(); const outside = document.createElement("button"); host.append(outside);
    await act(async () => outside.focus()); await act(async () => cancel.focus()); await act(async () => cancel.click());
    expect(host.querySelector("[role='alertdialog']")).toBeNull();
    expect(document.activeElement).toBe(host.querySelector(".pane-active-heading"));
    expect(useUiStore.getState().activePaneId).toBe(before.activePaneId); expect(useUiStore.getState().focusRevision).toBe(before.focusRevision);
  });
});

describe("XTermWrapper turn-list row integration", () => {
  it.each(["Escape", "row", "label", "mouse"])("L4 returns %s completion to a durable owner past the real hold and exit timers", async exit => {
    const sessionId = `turn-expired-focus-${exit}`;
    const pane: Pane = { id: `pane-${sessionId}`, sessionId, agentId: "claude-code", activeTabId: "turn-tab",
      tabs: [{ id: "turn-tab", sessionId, agentId: "claude-code", agentKind: "claude", type: "terminal", commandArgv: ["claude"] }] };
    useWorkspaceListStore.setState({ workspaces: [{ id: "workspace", name: "Turns", panes: [pane], gridTemplateId: "1x1", status: "running", createdAt: 1 }], activeWorkspaceId: "workspace" });
    useUiStore.setState({ activePaneId: sessionId, zoomedPaneId: null, focusRevision: 0 });
    useSettingsStore.setState({ paneComposerEnabled: false, showTerminalHistoryButton: false });
    mocks.turnMarks = [{ line: 0, label: "Synthetic turn", at: 1 }];
    // The real controller captures Date.now at construction, so install the clock before mount.
    vi.useFakeTimers();
    try {
      await act(async () => root.render(<TerminalPane pane={pane} workspaceId="workspace" onClose={() => {}} />));
      await vi.waitFor(() => expect(host.querySelector(".xterm-helper-textarea")).not.toBeNull());
      await act(async () => vi.advanceTimersByTimeAsync(300));
      const terminal = host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!; await act(async () => terminal.focus());
      await act(async () => host.querySelector("[data-turn-marks]")!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 })));
      await act(async () => vi.advanceTimersByTimeAsync(60));
      const label = host.querySelector<HTMLButtonElement>(".terminal-turn-chip__label")!; expect(label).not.toBeNull();
      await act(async () => label.click());
      const row = host.querySelector<HTMLButtonElement>("[role='option']")!; expect(row).not.toBeNull();
      await act(async () => { if (exit === "label") label.focus(); else if (exit !== "mouse") row.focus(); });
      await act(async () => vi.advanceTimersByTimeAsync(3000));
      expect(row.isConnected).toBe(true); expect(document.activeElement).toBe(exit === "mouse" ? terminal : exit === "label" ? label : row);
      await act(async () => {
        if (exit === "Escape") row.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        else if (exit === "label") label.click(); else row.click();
      });
      const heading = host.querySelector(".pane-active-heading");
      const target = exit === "mouse" ? terminal : heading;
      expect.soft(document.activeElement).toBe(target);
      await act(async () => vi.advanceTimersByTimeAsync(60));
      expect(host.querySelector(".terminal-turn-chip")?.getAttribute("aria-hidden")).toBe("true");
      // The exit timer is armed by React's commit after that refresh frame.
      await act(async () => vi.advanceTimersByTimeAsync(300));
      expect(host.querySelector(".terminal-turn-chip")).toBeNull();
      expect(document.activeElement).toBe(target);
      expect(useUiStore.getState().activePaneId).toBe(sessionId);
    } finally { vi.useRealTimers(); }
  });
  async function mountProgressPane(sessionId: string): Promise<void> {
    const pane = { id: `pane-${sessionId}`, sessionId, activeTabId: `tab-${sessionId}`, agentId: "shell",
      tabs: [{ id: `tab-${sessionId}`, sessionId, agentId: "shell", type: "terminal" }] } as Pane;
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: unknown) => {
      if (command === "read_agent_session_mappings") return Promise.resolve({ [sessionId]: { agent_kind: "claude", session_id: "exact-a" } });
      if (command === "get_session_scrollback") {
        const snapshot = new ArrayBuffer(24); new Uint8Array(snapshot).set([0x4d, 0x43, 0x53, 0x31]);
        return Promise.resolve(snapshot);
      }
      if (command === "get_live_briefs" || command === "get_live_events") return Promise.resolve([]);
      return original(command, args);
    });
    useWorkspaceListStore.setState({ workspaces: [{ id: "workspace", name: "Fixture", panes: [pane] }] as Workspace[], activeWorkspaceId: "workspace" });
    await act(async () => { root.render(<>
      <PaneTabBar pane={pane} workspaceId="workspace" hasTerminalBuffer={() => true} />
      <XTermWrapper workspaceId="workspace" sessionId={sessionId} command="powershell.exe" />
    </>); });
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([command]) => command === "create_session")).toBe(true), { timeout: 10_000 });
  }

  function sendProgressOutput(sessionId: string, text: string): number {
    const bytes = new TextEncoder().encode(text);
    const frame = new ArrayBuffer(40 + bytes.length);
    new Uint8Array(frame).set([0x4d, 0x43, 0x58, 0x31]);
    const view = new DataView(frame);
    view.setBigUint64(8, 1n, true); view.setBigUint64(16, 1n, true);
    view.setBigUint64(32, BigInt(bytes.length), true); new Uint8Array(frame).set(bytes, 40);
    const call = mocks.invoke.mock.calls.find(([command, args]) => command === "create_session" && args.sessionId === sessionId)!;
    call[1].onData.onmessage(frame);
    return bytes.length;
  }

  it.each([true, false])("P1 keeps the real wrapper attached and ACKing live output with history flag %s", async (enabled) => {
    const sessionId = `history-live-${enabled}`;
    useSettingsStore.setState({ showTerminalHistoryButton: enabled });
    await mountProgressPane(sessionId);
    const terminal = mocks.terminalInstances[0];
    // Let the initial attach's existing resize bursts settle before measuring reading.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 280)); });
    const mutations = () => mocks.invoke.mock.calls.filter(([command]) => ["create_session", "resize_session", "write_to_session", "kill_session"].includes(command)).length;
    const before = mutations();
    if (enabled) {
      await act(async () => { host.querySelector<HTMLButtonElement>(`button[aria-label='${terminalPaneStrings.paneActions}']`)!.click(); });
      await vi.waitFor(() => expect(host.querySelector("[data-terminal-magnifier-destination=history]")).not.toBeNull(), { timeout: 10_000 });
      await act(async () => { host.querySelector<HTMLButtonElement>("[data-terminal-magnifier-destination=history]")!.click(); });
      expect(host.querySelector("[data-terminal-transcript-panel]")).not.toBeNull();
      expect(document.activeElement).toBe(host.querySelector("[data-transcript-search-input]"));
    } else {
      expect(host.querySelector("[data-terminal-magnifier-destination=history]")).toBeNull();
      await act(async () => { window.dispatchEvent(new CustomEvent(TERMINAL_HISTORY_EVENT, { detail: { sessionId } })); });
      expect(host.querySelector("[data-terminal-transcript-panel]")).toBeNull();
      expect(mocks.invoke.mock.calls.filter(([command]) => command === "read_agent_session_mappings")).toHaveLength(0);
    }
    await act(async () => { sendProgressOutput(sessionId, "synthetic live output\r\n"); });
    await vi.waitFor(() => expect(terminal.write).toHaveBeenCalledWith("synthetic live output\r\n", expect.any(Function)), { timeout: 10_000 });
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([command]) => command === "ack_frontend_data")).toBe(true), { timeout: 10_000 });
    if (enabled) await act(async () => {
      expect(document.activeElement).toBe(host.querySelector("[data-transcript-search-input]"));
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(host.querySelector("[data-terminal-transcript-panel]")).toBeNull();
    expect(mutations()).toBe(before);
    expect(mocks.terminalInstances).toHaveLength(1); expect(terminal.dispose).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "record_terminal_progress")).toHaveLength(0);
  });

  it("P2 does not call a watchdog ACK parsed and observes the later parser/render callbacks", async () => {
    const sessionId = "progress-stalled-parser";
    useSettingsStore.setState({ terminalProgressDiagnosticsEnabled: true, showTerminalHistoryButton: false });
    await mountProgressPane(sessionId);
    mocks.stallWrites = true;
    let end = 0;
    await act(async () => { end = sendProgressOutput(sessionId, "private synthetic body\r\n"); });
    await vi.waitFor(() => expect(mocks.writeCallbacks).toHaveLength(1), { timeout: 10_000 });
    const latest = () => mocks.invoke.mock.calls.filter(([command]) => command === "record_terminal_progress").at(-1)?.[1].records[0].sample;
    await vi.waitFor(() => expect(latest()).toMatchObject({ receivedEnd: end, parsedEnd: null }), { timeout: 3_000 });
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([command]) => command === "ack_frontend_data")).toBe(true), { timeout: 3_000 });
    expect(latest().parsedEnd).toBeNull();
    await act(async () => { mocks.writeCallbacks.shift()!(); });
    await vi.waitFor(() => expect(latest()).toMatchObject({ parsedEnd: end }), { timeout: 3_000 });
    const tick = latest().renderTick;
    for (const listener of mocks.terminalInstances[0].renderListeners) listener({ start: 0, end: 23 });
    await vi.waitFor(() => expect(latest().renderTick).toBeGreaterThan(tick), { timeout: 3_000 });
    expect(JSON.stringify(latest())).not.toContain("private synthetic body");
    expect(JSON.stringify(latest())).not.toContain(sessionId);
  });

  it("reachability #5 opens only the requested terminal from header/menu, shares keyboard search and removes listeners", async () => {
    const panes = ["search-a", "search-b"].map((sessionId) => ({
      id: `pane-${sessionId}`, sessionId, activeTabId: `tab-${sessionId}`, agentId: "shell",
      tabs: [{ id: `tab-${sessionId}`, sessionId, agentId: "shell", type: "terminal" }],
    })) as Pane[];
    useWorkspaceListStore.setState({
      workspaces: [{ id: "workspace", name: "Search", panes }] as Workspace[], activeWorkspaceId: "workspace",
    });
    const addListener = vi.spyOn(window, "addEventListener");
    const removeListener = vi.spyOn(window, "removeEventListener");
    try {
      await act(async () => {
        root.render(<>
          <PaneTabBar pane={panes[0]} workspaceId="workspace" hasTerminalBuffer={() => true} />
          {panes.map((pane) => <section key={pane.id} data-session={pane.sessionId}>
            <XTermWrapper workspaceId="workspace" sessionId={pane.sessionId} command="powershell.exe" />
          </section>)}
        </>);
        await Promise.resolve();
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(mocks.terminalInstances).toHaveLength(2), { timeout: 10_000 });
      const first = host.querySelector<HTMLElement>("[data-session='search-a']")!;
      const second = host.querySelector<HTMLElement>("[data-session='search-b']")!;
      const searchInput = () => first.querySelector<HTMLInputElement>(SEARCH_INPUT);
      expect(searchInput()).toBeNull();
      await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label='${terminalPaneStrings.paneActions}']`)!.click());
      await act(async () => host.querySelector<HTMLButtonElement>('[data-pane-action="search"]')!.click());
      expect(searchInput()).not.toBeNull();
      expect(document.activeElement).toBe(searchInput());
      expect(second.querySelector(SEARCH_INPUT)).toBeNull();
      expect(useUiStore.getState().activePaneId).toBe("search-a");
      const closeSearch = async () => {
        await act(async () => { searchInput()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
        expect(searchInput()).toBeNull();
      };
      await closeSearch();
      await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label='${terminalPaneStrings.paneActions}']`)!.click());
      const item = [...host.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
        .find((node) => node.textContent === terminalPaneStrings.searchTerminal)!;
      await act(async () => item.click());
      expect(document.activeElement).toBe(searchInput());
      expect(searchInput()).not.toBeNull();
      expect(second.querySelector(SEARCH_INPUT)).toBeNull();
      expect(host.querySelector("[role='menu']")).toBeNull();
      await closeSearch();
      await act(async () => {
        const event = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, shiftKey: true, cancelable: true });
        expect(mocks.terminalInstances[0].keyHandler!(event)).toBe(false);
        expect(event.defaultPrevented).toBe(true);
      });
      expect(document.activeElement).toBe(searchInput());
      expect(searchInput()).not.toBeNull();
      await act(async () => {
        window.dispatchEvent(new CustomEvent(TERMINAL_SEARCH_EVENT, { detail: { sessionId: "unknown" } }));
      });
      expect(second.querySelector(SEARCH_INPUT)).toBeNull();
      const listeners = addListener.mock.calls.filter(([name]) => name === TERMINAL_SEARCH_EVENT);
      expect(listeners).toHaveLength(2);
      await act(async () => root.render(null));
      for (const [name, handler] of listeners) expect(removeListener).toHaveBeenCalledWith(name, handler);
    } finally {
      addListener.mockRestore();
      removeListener.mockRestore();
    }
  });

  it("scans a lone user turn on ▲, scrolls there, and keeps the panel closed", async () => {
    const sessionId = "turn-jump-buffer-scan";
    mocks.bufferType = "normal";
    mocks.bufferLines = ["❯ 唯一の指示", "⏺ 応答"];
    useWorkspaceListStore.setState({
      workspaces: [{
        id: "workspace",
        panes: [{ tabs: [{ id: "tab-turn-jump", sessionId }] }],
      }] as never,
      activeWorkspaceId: "workspace",
    });

    await act(async () => {
      root.render(
        <XTermWrapper
          workspaceId="workspace"
          sessionId={sessionId}
          command="claude"
          agentKind="claude"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mocks.terminalInstances).toHaveLength(1), { timeout: 10_000 });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const wrapper = host.firstElementChild;
    expect(wrapper).not.toBeNull();
    act(() => {
      wrapper!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
    });
    const prev = await vi.waitFor(() => {
      const button = host.querySelector<HTMLButtonElement>(
        `button[aria-label="${terminalTurnStrings.prevTurn}"]`,
      );
      expect(button).not.toBeNull();
      return button!;
    }, { timeout: 10_000 });

    act(() => prev.click());

    const terminal = mocks.terminalInstances[0]!;
    expect(restoreTurnMarksAtLines).toHaveBeenCalledOnce();
    expect(terminal.scrollToLine).toHaveBeenCalledWith(0);
    expect(host.querySelector("[data-terminal-transcript-panel]")).toBeNull();
  });

  it("renders a DOM row when a turn mark arrives while the list is open", async () => {
    const sessionId = "turn-list-live-row";
    await act(async () => {
      root.render(
        <XTermWrapper
          workspaceId="workspace"
          sessionId={sessionId}
          command="claude"
          agentKind="claude"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mocks.terminalInstances).toHaveLength(1), { timeout: 10_000 });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const wrapper = host.firstElementChild;
    expect(wrapper).not.toBeNull();
    act(() => {
      wrapper!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const label = host.querySelector<HTMLButtonElement>(".terminal-turn-chip__label");
    expect(label).not.toBeNull();

    act(() => {
      label!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.querySelector(".terminal-turn-list__empty")?.textContent)
      .toBe(terminalTurnStrings.listEmpty);

    mocks.turnMarks = [{ line: 4, label: "日本語の命令", at: 1_000 }];
    act(() => {
      window.dispatchEvent(new CustomEvent(TURN_MARKS_EVENT, { detail: { sessionId } }));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const rows = host.querySelectorAll(".terminal-turn-list__row[role='option']");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toBe("日本語の命令");
    expect(host.querySelector(".terminal-turn-list__empty")).toBeNull();
    expect(host.querySelector(".terminal-turn-list")?.textContent)
      .not.toContain(terminalTurnStrings.listEmpty);
  });

  it("never repopulates the closed session cache from a late transcript reply", async () => {
    const sessionId = "turn-list-closed-late";
    let release!: (prompts: Array<{ text: string; occurredAt: number }>) => void;
    const previous = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, ...args: unknown[]) => {
      if (command === "get_transcript_user_prompts") return new Promise((resolve) => { release = resolve; });
      return previous(command, ...args);
    });
    await act(async () => { root.render(<XTermWrapper workspaceId="workspace" sessionId={sessionId} command="claude" agentKind="claude" />); });
    await vi.waitFor(() => expect(mocks.terminalInstances).toHaveLength(1), { timeout: 10_000 });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    act(() => host.firstElementChild!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 })));
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    act(() => host.querySelector<HTMLButtonElement>(".terminal-turn-chip__label")!.click());
    expect(release).toBeDefined();
    act(() => evictTerminalCache(sessionId));
    await act(async () => { release([{ text: "Late reply", occurredAt: 2000 }]); await Promise.resolve(); });
    expect(__turnListPromptCacheForTests.has(sessionId)).toBe(false);
    expect(host.querySelector(".terminal-turn-list")?.textContent).not.toContain("Late reply");
  });

  it("recovers from an initially empty transcript and renders its row in the open list", async () => {
    const sessionId = "turn-list-transcript-retry";
    mocks.transcriptResponses = [
      [],
      [{ text: "再取得できた日本語の命令", occurredAt: 2_000 }],
    ];
    await act(async () => {
      root.render(
        <XTermWrapper
          workspaceId="workspace"
          sessionId={sessionId}
          command="claude"
          agentKind="claude"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mocks.terminalInstances).toHaveLength(1), { timeout: 10_000 });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const wrapper = host.firstElementChild;
    expect(wrapper).not.toBeNull();
    act(() => {
      wrapper!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const label = host.querySelector<HTMLButtonElement>(".terminal-turn-chip__label");
    expect(label).not.toBeNull();

    act(() => label!.click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.querySelector(".terminal-turn-list__empty")?.textContent)
      .toBe(terminalTurnStrings.listEmpty);

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 550));
    });

    const transcriptCalls = mocks.invoke.mock.calls.filter(
      ([command]) => command === "get_transcript_user_prompts",
    );
    expect(transcriptCalls).toHaveLength(2);
    expect(transcriptCalls[0]?.[1]).toEqual({ ptySessionId: sessionId, limit: 200 });
    const rows = host.querySelectorAll(".terminal-turn-list__row[role='option']");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toBe("再取得できた日本語の命令");
    expect(host.querySelector(".terminal-turn-list__empty")).toBeNull();
    expect(host.querySelector(".terminal-turn-list")?.textContent)
      .not.toContain(terminalTurnStrings.listEmpty);
  });
});


function SearchHoverSurface({ pane }: { pane: Pane }) {
  const ref = useRef<HTMLDivElement>(null);
  const enabled = usePaneHoverFocus(ref, { enabled: true, workspaceId: "workspace", paneId: pane.id,
    tabId: pane.activeTabId, sessionId: pane.sessionId, kind: "terminal",
    onActivate: (focusGuard, commitHoverSelection, onHoverFocusAborted) => focusController.commit("hover", pane.sessionId, { focusGuard, commitHoverSelection, onHoverFocusAborted }) });
  return <section data-dnd-pane-id={pane.id}><div ref={ref} data-session-id={pane.sessionId}
    data-pane-hover-focus-surface={enabled ? "terminal" : undefined}>
    <XTermWrapper workspaceId="workspace" sessionId={pane.sessionId} command="powershell.exe" />
  </div></section>;
}

async function withRealSearchHover(check: (first: HTMLElement, second: HTMLElement, move: (target: Element, x?: number, elapsed?: number) => Promise<void>) => Promise<void>, openSearch = true, secondReady = true) {
  vi.useFakeTimers();
  const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const rects = vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{ width: 400, height: 300 }] as any);
  const oldHitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
  let hit: Element | null = null;
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => hit });
  vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  const panes = ["hover-search-a", "hover-search-b"].map((sessionId) => ({
    id: `pane-${sessionId}`, sessionId, activeTabId: `tab-${sessionId}`, agentId: "shell",
    tabs: [{ id: `tab-${sessionId}`, sessionId, agentId: "shell", type: "terminal" }],
  })) as Pane[];
  prepareStartupSessionGate([]);
  rememberTearoutDormantSessions(panes.map((p) => p.sessionId), panes.map((p) => p.sessionId));
  useSettingsStore.setState({ paneFocusMode: "hover" });
  useUiStore.setState({ activePaneId: panes[0].sessionId, focusRevision: 0, zoomedPaneId: null });
  useWorkspaceListStore.setState({ workspaces: [{ id: "workspace", name: "Search hover", panes }] as Workspace[], activeWorkspaceId: "workspace" });
  try {
    await act(async () => { root.render(<>{panes.map((pane) => <SearchHoverSurface key={pane.id} pane={pane} />)}</>); });
    await vi.waitFor(() => expect(mocks.terminalInstances).toHaveLength(secondReady ? 2 : 1));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    const first = host.querySelector<HTMLElement>("[data-session-id='hover-search-a']")!;
    const second = host.querySelector<HTMLElement>("[data-session-id='hover-search-b']")!;
    expect(first.querySelector(".xterm-helper-textarea")).not.toBeNull();
    expect(Boolean(second.querySelector(".xterm-helper-textarea"))).toBe(secondReady);
    if (openSearch) {
      await act(async () => {
        window.dispatchEvent(new CustomEvent(TERMINAL_SEARCH_EVENT, { detail: { sessionId: panes[1].sessionId } }));
      });
      expect(document.activeElement).toBe(second.querySelector(SEARCH_INPUT));
    } else {
      await act(async () => { first.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!.focus(); });
    }
    const move = async (target: Element, x = 20, elapsed = 200) => {
      hit = target;
      await act(async () => {
        const event = new MouseEvent("pointermove", { bubbles: true, clientX: x, clientY: 20, buttons: 0 });
        for (const [key, value] of Object.entries({ pointerType: "mouse", pointerId: 1, movementX: 1, movementY: 0 })) {
          Object.defineProperty(event, key, { value });
        }
        target.dispatchEvent(event); await vi.advanceTimersByTimeAsync(elapsed);
      });
    };
    await check(first, second, move);
  } finally {
    await act(async () => { root.render(null); });
    for (const pane of panes) { evictTerminalCache(pane.sessionId); focusController.clearSession(pane.sessionId); }
    useSettingsStore.setState({ paneFocusMode: "click" });
    vi.clearAllTimers(); vi.useRealTimers(); hasFocus.mockRestore(); visibility.mockRestore(); rects.mockRestore();
    if (oldHitTest) Object.defineProperty(document, "elementFromPoint", oldHitTest);
    else delete (document as any).elementFromPoint;
  }
}

describe("R4 real wrapper delayed initialization", () => {
  it.each(["is_session_alive", "has_persisted_scrollback"])("R4 held %s IPC rejects the first dwell and allows one fresh same-B acquisition", async (heldCommand) => {
    const original = mocks.invoke.getMockImplementation()!;
    let finishInitialization: ((ready: boolean) => void) | undefined;
    mocks.invoke.mockImplementation((command: string, args: any) => {
      if (command === heldCommand && args.sessionId === "hover-search-b") {
        return new Promise<boolean>((resolve) => { finishInitialization = resolve; });
      }
      return original(command, args);
    });
    await withRealSearchHover(async (first, second, move) => {
      expect(finishInitialization).toBeDefined();
      const aTextarea = first.querySelector(".xterm-helper-textarea");
      const ui = useUiStore.getState(), layout = useWorkspaceListStore.getState();
      const requests = vi.spyOn(focusController, "commit");
      await move(second);
      expect(requests.mock.calls.filter(([source]) => source === "hover")).toHaveLength(1);
      expect(useUiStore.getState()).toBe(ui); expect(useWorkspaceListStore.getState()).toBe(layout);
      expect(document.activeElement).toBe(aTextarea);
      await act(async () => { finishInitialization!(false); await vi.advanceTimersByTimeAsync(500); });
      const bTextarea = second.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;
      expect(bTextarea).not.toBeNull(); expect(mocks.terminalInstances).toHaveLength(2);
      expect(useUiStore.getState()).toBe(ui); expect(useWorkspaceListStore.getState()).toBe(layout);
      expect(document.activeElement).toBe(aTextarea); // Readiness alone does not activate a stationary pointer.
      const focus = vi.spyOn(bTextarea, "focus"), frames: FrameRequestCallback[] = [];
      const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.push(callback); return frames.length; });
      try {
        await move(second, 21, 0); // Same element, never a leave/enter or store invalidation.
        await act(async () => { await vi.advanceTimersByTimeAsync(99); });
        expect(useUiStore.getState()).toBe(ui); expect(document.activeElement).toBe(aTextarea); expect(focus).not.toHaveBeenCalled();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1);
          // Run the nested zero-delay scheduling tick, then the actual focus frame.
          await vi.advanceTimersByTimeAsync(1);
          for (const callback of frames.splice(0)) callback(0);
        });
        expect(useUiStore.getState().activePaneId).toBe("hover-search-b"); expect(document.activeElement).toBe(bTextarea);
        expect(useUiStore.getState().focusRevision).toBe(ui.focusRevision + 1); expect(useWorkspaceListStore.getState()).toBe(layout);
        expect(focus).toHaveBeenCalledOnce(); expect(requests.mock.calls.filter(([source]) => source === "hover")).toHaveLength(2);
      } finally { raf.mockRestore(); requests.mockRestore(); }
    }, false, false);
  });
});

describe("F5 real terminal search boundary", () => {
  it.each([20, 30])("F5 real search wrapper padding/gap at %i stays excluded after focus returns to A", async (x) => {
    await withRealSearchHover(async (first, second, move) => {
      const input = second.querySelector<HTMLInputElement>(SEARCH_INPUT)!;
      const searchWrapper = input.parentElement!; // The actual product flex wrapper, never a fabricated marker.
      await act(async () => {
        focusController.commit("keyboard", "hover-search-a", { focus: false });
        first.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!.focus();
      });
      expect(second.contains(input)).toBe(true); expect(input.parentElement).toBe(searchWrapper);
      await move(searchWrapper, x);
      expect(useUiStore.getState().activePaneId).toBe("hover-search-a");
      expect(document.activeElement).toBe(first.querySelector(".xterm-helper-textarea"));
      expect(searchWrapper.hasAttribute("data-terminal-search")).toBe(true);
      expect(second.querySelector(SEARCH_INPUT)).toBe(input);
      await move(second.querySelector(".xterm-helper-textarea")!, x + 1);
      expect(useUiStore.getState().activePaneId).toBe("hover-search-b");
      expect(document.activeElement).toBe(second.querySelector(".xterm-helper-textarea"));
    });
  });
  it("F5 actual focused search input protects its keyboard owner from another terminal", async () => {
    await withRealSearchHover(async (first, second, move) => {
      const input = second.querySelector<HTMLInputElement>(SEARCH_INPUT)!;
      await move(first.querySelector(".xterm-helper-textarea")!);
      expect(useUiStore.getState().activePaneId).toBe("hover-search-b"); expect(document.activeElement).toBe(input);
    });
  });
});


describe("R1 real asynchronous resume completion", () => {
  it("R1 background owner-ended resume after hover then click reconciles to B", async () => {
    const original = mocks.invoke.getMockImplementation()!;
    let aCreates = 0;
    let finishResume: (() => void) | undefined;
    mocks.invoke.mockImplementation((command: string, args: any) => {
      if (command === "create_session" && args.sessionId === "hover-search-a") {
        if (++aCreates === 1) return Promise.reject('AGENT_SESSION_ALREADY_RUNNING:' + JSON.stringify({
          kind: "claude", agentSessionId: "resume-conversation", ownerSessionId: "ended-owner",
        }));
        return new Promise<unknown>((resolve) => { finishResume = () => resolve(args.attachmentContext); });
      }
      if (command === "get_window_fragments") return Promise.resolve([]);
      if (command === "get_agent_conversation_owner") return Promise.resolve(null);
      return original(command, args);
    });
    await withRealSearchHover(async (first, second, move) => {
      expect(first.querySelector("[data-agent-resume-recovery]")).not.toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(finishResume).toBeDefined(); // The production ownerEnded -> restartAgent is waiting on create_session.
      await move(second.querySelector(".xterm-helper-textarea")!);
      expect(useUiStore.getState().activePaneId).toBe("hover-search-b");
      await act(async () => {
        applyExternalStoreUpdate(useSettingsStore, { paneFocusMode: "click" });
        finishResume!(); await vi.advanceTimersByTimeAsync(200);
      });
      expect(first.querySelector("[data-agent-resume-recovery]")).toBeNull();
      expect(useUiStore.getState().activePaneId).toBe("hover-search-b");
      expect(document.activeElement).toBe(second.querySelector(".xterm-helper-textarea"));
      mocks.terminalInstances[1].emitData("b"); await act(async () => { await vi.advanceTimersByTimeAsync(20); });
      expect(mocks.invoke.mock.calls.filter(([c, a]) => c === "write_to_session" && a.sessionId === "hover-search-b").map(([, a]) => a.data).join("")).toBe("b");
    }, false);
  });
});

const bProtocolWrites = () => mocks.invoke.mock.calls
  .filter(([command, args]) => command === "write_to_session" && args.sessionId === "hover-search-b")
  .map(([, args]) => args.data).join("");
const aProtocolWrites = () => mocks.invoke.mock.calls
  .filter(([command, args]) => command === "write_to_session" && args.sessionId === "hover-search-a")
  .map(([, args]) => args.data).join("");

describe("R3 real wrapper synchronous focus protocol", () => {
  it("R3 exact B focus-in is delivered once and arbitrary inactive data is rejected", async () => {
    await withRealSearchHover(async (_first, second, move) => {
      const [a, b] = mocks.terminalInstances; a.focusReporting = b.focusReporting = true;
      const order: string[] = [];
      a.dataListeners.add((data) => { if (data === "\x1b[O") order.push(`A blur/${useUiStore.getState().activePaneId}`); });
      b.dataListeners.add((data) => { if (data === "\x1b[I") order.push(`B focus/${useUiStore.getState().activePaneId}`); });
      second.addEventListener("focusin", () => order.push(`B focusin/${useUiStore.getState().activePaneId}`));
      b.emitData("before-acquisition");
      await move(second.querySelector(".xterm-helper-textarea")!);
      expect(order).toEqual(["A blur/hover-search-a", "B focus/hover-search-a", "B focusin/hover-search-a"]);
      expect(useUiStore.getState().activePaneId).toBe("hover-search-b");
      expect(aProtocolWrites()).toBe("\x1b[O"); expect(bProtocolWrites()).toBe("\x1b[I");
      mocks.terminalInstances[0].emitData("unrelated-inactive");
      await act(async () => { await vi.advanceTimersByTimeAsync(20); });
      expect(aProtocolWrites()).toBe("\x1b[O"); expect(bProtocolWrites()).toBe("\x1b[I");
    }, false);
  });
  it("R3 refused acquisition emits no native report and successful retry delivers one", async () => {
    await withRealSearchHover(async (_first, second, move) => {
      const b = mocks.terminalInstances[1]; b.focusReporting = true; b.refuseFocus = true;
      const emitted = vi.spyOn(b, "emitData");
      await move(second.querySelector(".xterm-helper-textarea")!);
      expect(useUiStore.getState().activePaneId).toBe("hover-search-a"); expect(bProtocolWrites()).toBe(""); expect(emitted).not.toHaveBeenCalled();
      b.refuseFocus = false; await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(useUiStore.getState().activePaneId).toBe("hover-search-b"); expect(bProtocolWrites()).toBe("\x1b[I"); expect(emitted).toHaveBeenCalledExactlyOnceWith("\x1b[I");
    }, false);
  });
  it("R3 eight refused acquisitions never commit or deliver a report", async () => {
    await withRealSearchHover(async (first, second, move) => {
      const b = mocks.terminalInstances[1]; b.focusReporting = true; b.refuseFocus = true;
      const emitted = vi.spyOn(b, "emitData");
      await move(second.querySelector(".xterm-helper-textarea")!);
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(useUiStore.getState().activePaneId).toBe("hover-search-a"); expect(bProtocolWrites()).toBe("");
      expect(document.activeElement).toBe(first.querySelector(".xterm-helper-textarea")); expect(emitted).not.toHaveBeenCalled();
    }, false);
  });
  it("R3 explicit spurious reports are discarded on refusal and duplicates/mixed bytes cannot pass on success", async () => {
    await withRealSearchHover(async (first, second, move) => {
      const b = mocks.terminalInstances[1]; b.focusReporting = true; b.refuseFocus = true;
      b.adversarialFocusData = ["\x1b[I", "\x1b[I", "inactive-text", "\x1b[Iextra", "\x1b[O"];
      const emitted = vi.spyOn(b, "emitData");
      await move(second.querySelector(".xterm-helper-textarea")!);
      expect(emitted).toHaveBeenCalledWith("\x1b[I"); // Injection occurred despite the absence of any focus transition.
      expect(document.activeElement).toBe(first.querySelector(".xterm-helper-textarea"));
      expect(useUiStore.getState().activePaneId).toBe("hover-search-a"); expect(bProtocolWrites()).toBe("");
      b.refuseFocus = false; await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(useUiStore.getState().activePaneId).toBe("hover-search-b"); expect(bProtocolWrites()).toBe("\x1b[I");
    }, false);
  });
  it("R3 a newer explicit selection during synchronous reporting is never rolled back", async () => {
    await withRealSearchHover(async (_first, second, move) => {
      const b = mocks.terminalInstances[1]; b.focusReporting = true;
      b.focusBeforeReturn = () => focusController.commit("keyboard", "new-explicit", { focus: false });
      await move(second.querySelector(".xterm-helper-textarea")!);
      expect(useUiStore.getState().activePaneId).toBe("new-explicit"); expect(bProtocolWrites()).toBe("");
    }, false);
  });
  it.each(["editor", "composition"])("R3 %s started before focus returns cancels the buffered report", async (kind) => {
    await withRealSearchHover(async (_first, second, move) => {
      const b = mocks.terminalInstances[1]; b.focusReporting = true;
      let protectedElement: Element;
      b.focusBeforeReturn = () => {
        if (kind === "editor") { const input = document.createElement("input"); document.body.append(input); input.focus(); protectedElement = input; }
        else { protectedElement = document.activeElement!; protectedElement.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); }
      };
      await move(second.querySelector(".xterm-helper-textarea")!);
      expect(useUiStore.getState().activePaneId).toBe("hover-search-a"); expect(bProtocolWrites()).toBe("");
      expect(document.activeElement).toBe(protectedElement!);
    }, false);
  });
});
