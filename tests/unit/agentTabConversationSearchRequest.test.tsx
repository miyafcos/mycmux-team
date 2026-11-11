// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), nextContext: 0,
  terminalInstances: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
  observers: [] as Array<{ disconnect: ReturnType<typeof vi.fn>; target?: Element }>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class<T> {
    onmessage?: (message: T) => void;
  },
  invoke: async (command: string, ...parameters: any[]) => {
    const args = parameters[0] ?? {};
    if (command === "get_session_attachment_contexts") return args.sessionIds.map((session_id: string) => ({
      backend_epoch: "fixture-backend", transfer_id: args.transferToken ?? null, transfer_token: args.transferToken ?? null,
      session_id, window_label: "main", window_incarnation: "fixture-window",
      attachment_epoch: ++mocks.nextContext, nonce: String(mocks.nextContext), existing_only: args.existingOnly,
    }));
    const result = await mocks.invoke(command, ...parameters);
    return command === "create_session" || command === "tearout_attach" ? result ?? args.attachmentContext : result;
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn(() => Promise.resolve()) }));

vi.mock("allotment", async () => {
  const React = await import("react");
  const Pane = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const Allotment = Object.assign(
    React.forwardRef(function MockAllotment(
      { children }: { children?: React.ReactNode },
      _ref: React.ForwardedRef<unknown>,
    ) {
      return <div data-allotment>{children}</div>;
    }),
    { Pane },
  );
  return { Allotment };
});

vi.mock("@xterm/xterm", () => {
  const disposable = () => ({ dispose: vi.fn() });
  class FakeTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    element: HTMLElement | undefined;
    textarea: HTMLTextAreaElement | undefined;
    onDataCallback: ((data: string) => void) | undefined;
    unicode = { activeVersion: "" };
    parser = {
      registerOscHandler: vi.fn(() => disposable()),
      registerCsiHandler: vi.fn(() => disposable()),
      registerEscHandler: vi.fn(() => disposable()),
    };
    buffer = {
      active: {
        length: 0,
        baseY: 0,
        cursorY: 0,
        viewportY: 0,
        getLine: () => undefined,
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
      this.element.appendChild(this.textarea);
      container.appendChild(this.element);
    }

    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
      this.textarea?.addEventListener("keydown", handler);
    }
    focus(): void { this.textarea?.focus(); }
    refresh(): void {}
    reset(): void {}
    scrollToBottom(): void {}
    write(_data: string | Uint8Array, callback?: () => void): void { callback?.(); }
    writeln(): void {}
    getSelection(): string { return ""; }
    onBinary(): { dispose: () => void } { return disposable(); }
    onData(callback: (data: string) => void): { dispose: () => void } { this.onDataCallback = callback; return disposable(); }
    onRender(): { dispose: () => void } { return disposable(); }
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


import XTermWrapper from "../../src/components/terminal/XTermWrapper";
import { TERMINAL_SEARCH_EVENT } from "../../src/components/terminal/terminalSearchEvents";
import { evictTerminalCache } from "../../src/components/terminal/terminalCache";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useAgentTabViewStore } from "../../src/stores/agentTabViewStore";
import { useComposerStore } from "../../src/stores/composerStore";
import { useKeybindingStore } from "../../src/stores/keybindingStore";
import { handleSocketCommand } from "../../src/components/layout/socketCommands";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { useUiStore } from "../../src/stores/uiStore";
import type { TranscriptPage } from "../../src/lib/livebrief";

vi.mock("../../src/stores/liveBriefStore", async original => ({
  ...await original<typeof import("../../src/stores/liveBriefStore")>(),
  holdDetailSession: vi.fn(() => () => {}), connectLiveBriefStore: vi.fn(() => () => {}),
}));
vi.mock("../../src/components/layout/socketCommands", () => ({ handleSocketCommand: vi.fn() }));

let host: HTMLDivElement, root: Root, sequence = 0, sessionId: string, tabId: string;
let agentKind: "claude" | "grok";
const archivePage = (): TranscriptPage => ({
  readerId: "search-request-fixture", sourceGeneration: "generation", snapshotEnd: "10",
  items: [{ occurrenceId: "archive:0:0", sourceStart: "0", sourceEnd: "10", slot: 0, kind: "assistant",
    timestamp: Date.now(), text: "Fixture response", bodyRef: null, callId: null, tool: null, target: null, aliases: [] }],
  olderCursor: null, newerCursor: "tail", latestCursor: "latest", scanContinuation: null,
  reachedStart: true, reachedFence: true, diagnostics: [],
});
const panel = () => host.querySelector<HTMLElement>(".terminal-transcript-panel--tab")!;
const reply = () => host.querySelector<HTMLTextAreaElement>(".cmux-dashboard-composer-input")!;
const transcriptSearch = () => host.querySelector<HTMLInputElement>("[data-transcript-search-input]");
const terminalSearch = () => host.querySelector<HTMLInputElement>("[data-terminal-search] input");

async function render(kind: "claude" | "grok" = "claude", empty = false) {
  agentKind = kind;
  useLiveBriefStore.setState({
    briefsBySession: { [sessionId]: { ptySessionId: sessionId, agentKind, agentSessionId: "agent",
      serviceEpoch: "epoch", ptyInstanceId: "instance", ptyGeneration: 1, sourceRevision: 1,
      ptyInputRevision: 1, briefRevision: 1, telemetryHealth: "live", operationalState: "running" } as never },
    eventsBySession: { [sessionId]: empty ? [] : [{ eventId: "u", sourceRevision: 1, occurredAt: Date.now(),
      sourceByteStart: 0, sourceByteEnd: 10, kind: { type: "userMessage", kind: "taskStart", text: "Fixture request", digest: "u" } }] },
  });
  await act(async () => root.render(<div data-agent-tab-surface="true" style={{ position: "relative", height: 800, width: 720 }}>
    <XTermWrapper workspaceId="w" sessionId={sessionId} command="powershell.exe" args={[]}
      agentId="shell-starter" agentKind={agentKind} />
  </div>));
  await vi.waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "create_session")).toHaveLength(1), { timeout: 10000 });
  if (empty) {
    await vi.waitFor(() => expect(host.querySelector("[data-agent-tab-fallback=empty]")).not.toBeNull(), { timeout: 10000 });
  } else {
    await act(async () => { await import("../../src/components/terminal/AgentTabConversationControls"); });
    await vi.waitFor(() => {
      expect(panel()).not.toBeNull(); expect(reply()).not.toBeNull();
      expect(host.querySelector(".xterm-helper-textarea")?.parentElement?.parentElement?.hasAttribute("inert")).toBe(true);
    }, { timeout: 10000 });
  }
}
async function requestSearch(id = sessionId) {
  await act(async () => window.dispatchEvent(new CustomEvent(TERMINAL_SEARCH_EVENT, { detail: { sessionId: id } })));
}
async function key(target: Element, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: "F", code: "KeyF", ctrlKey: true, shiftKey: true,
    bubbles: true, cancelable: true, ...options });
  await act(async () => { target.dispatchEvent(event); });
  return event;
}
function expectVisibleConversationSearch() {
  expect(transcriptSearch()).not.toBeNull();
  expect(document.activeElement).toBe(transcriptSearch());
  expect(host.querySelector("[data-terminal-search]")).toBeNull();
}
function expectNoPtyWrites() {
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "write_to_session")).toHaveLength(0);
  expect(handleSocketCommand).not.toHaveBeenCalled();
}
async function typeInFocusedSearch(text: string) {
  const input = transcriptSearch()!;
  expect(document.activeElement).toBe(input);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(input.value).toBe(text);
  expect(useComposerStore.getState().draftBySession[sessionId] ?? "").toBe("");
  expectNoPtyWrites();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as never); }
    disconnect() {}
  });
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0,
    right: 720, bottom: 800, width: 720, height: 800, toJSON: () => ({}) });
  sessionId = `conversation-search-${++sequence}`; tabId = `conversation-search-tab-${sequence}`;
  mocks.terminalInstances.length = 0; mocks.invoke.mockReset(); vi.mocked(handleSocketCommand).mockReset();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "get_terminal_config") return { font_size: 14, shell: "powershell.exe", background: "#000000",
      foreground: "#ffffff", ansi: [], windows_build_number: null };
    if (command === "read_agent_session_mappings") return agentKind === "claude"
      ? { [sessionId]: { agent_kind: "claude", session_id: "agent" } } : {};
    if (command === "open_transcript_history") return archivePage();
    if (command === "refresh_transcript_history_tail") return { ...archivePage(), items: [] };
    if (command === "heartbeat_transcript_history") return { hasNewBytes: false };
    return undefined;
  });
  useSettingsStore.setState({ agentTabContent: "conversation", conversationHistoryMode: "manual",
    terminalRenderer: "dom", notificationsEnabled: false });
  useKeybindingStore.getState().resetAll(); useAgentTabViewStore.setState({ views: {} });
  useComposerStore.setState({ draftBySession: {}, mentionTokensBySession: {}, commandKindBySession: {},
    dashboardOptimisticMessagesBySession: {}, dashboardRetryBySession: {} });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {}, lastLog: {}, lastLogAt: {} });
  useSessionAttentionStore.getState().resetForTests();
  useDashboardViewStore.setState({ open: false }); useLiveBriefStore.getState().reset();
  useUiStore.setState({ activePaneId: sessionId, focusRevision: 0 });
  useWorkspaceListStore.setState({ activeWorkspaceId: "w", workspaces: [{ id: "w", name: "Fixture",
    gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes: [{ id: "p", sessionId, agentId: "shell-starter", activeTabId: tabId,
      tabs: [{ id: tabId, sessionId, agentId: "shell-starter", type: "terminal", agentKind: "claude" }] }] }] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); evictTerminalCache(sessionId); host.remove();
  useKeybindingStore.getState().resetAll(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("conversation search requests through the running terminal", () => {
  it("1: routes the menu event into visible conversation search and keeps typed text out of the PTY", async () => {
    await render();
    await act(async () => reply().focus());
    await requestSearch();
    expectVisibleConversationSearch();
    await typeInFocusedSearch("Fixture");
  }, 15000);

  it.each(["reply", "panel"])("2: handles the search shortcut from the %s without terminal search or PTY writes", async target => {
    await render();
    const focused = target === "reply" ? reply() : panel();
    await act(async () => focused.focus());
    const event = await key(focused);
    expectVisibleConversationSearch();
    expect(event.defaultPrevented).toBe(true);
    await typeInFocusedSearch("response");
  }, 15000);

  it("3: refocuses the already open conversation search without replacing or clearing it", async () => {
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>(".agent-tab-search-toggle")!.click());
    expectVisibleConversationSearch();
    await typeInFocusedSearch("Fixture");
    const input = transcriptSearch();
    await act(async () => reply().focus());
    await requestSearch();
    expectVisibleConversationSearch();
    expect(transcriptSearch()).toBe(input); expect(input!.value).toBe("Fixture");
    await act(async () => reply().focus());
    await requestSearch();
    expectVisibleConversationSearch(); expect(transcriptSearch()).toBe(input);
    expectNoPtyWrites();
  }, 15000);

  it("4: keeps the menu event opening terminal search after switching the same tab to terminal view", async () => {
    await render();
    await act(async () => useAgentTabViewStore.getState().setView(tabId, "terminal"));
    expect(panel()).toBeNull();
    // The switch focuses the xterm a little later (a 0 ms timer, then an animation frame); a request inside that
    // window loses focus to it, which made this case depend on timing. Let that focus land first.
    await vi.waitFor(() => expect(document.activeElement).toBe(host.querySelector(".xterm-helper-textarea")), { timeout: 10000 });
    await requestSearch();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });
    expect(terminalSearch()).not.toBeNull(); expect(document.activeElement).toBe(terminalSearch());
    expect(transcriptSearch()).toBeNull(); expectNoPtyWrites();
  }, 15000);

  it("5: leaves search unavailable and focus unchanged for a Grok recent-event conversation", async () => {
    await render("grok");
    expect(host.querySelector(".agent-tab-search-toggle")).toBeNull();
    for (const focused of [reply(), panel()]) {
      await act(async () => focused.focus());
      await requestSearch();
      expect(transcriptSearch()).toBeNull(); expect(terminalSearch()).toBeNull();
      expect(document.activeElement).toBe(focused);
      await key(focused);
      expect(transcriptSearch()).toBeNull(); expect(terminalSearch()).toBeNull();
      expect(document.activeElement).toBe(focused); expectNoPtyWrites();
    }
  }, 15000);

  it("handles a rebound search shortcut from the search field and preserves other assigned keys", async () => {
    await render();
    useKeybindingStore.getState().setOverride("terminal.search", "ctrl+alt+f");
    const bubble = vi.fn(); window.addEventListener("keydown", bubble);
    try {
      const unassigned = await key(reply());
      expect(unassigned.defaultPrevented).toBe(false); expect(transcriptSearch()).toBeNull();
      const rebound = { key: "f", ctrlKey: true, altKey: true, shiftKey: false };
      await key(reply(), rebound); expectVisibleConversationSearch();
      const input = transcriptSearch()!;
      bubble.mockClear();
      expect((await key(input, rebound)).defaultPrevented).toBe(true);
      expect(bubble).not.toHaveBeenCalled(); expectVisibleConversationSearch();
      const other = await key(input, { key: "Enter", code: "Enter" });
      expect(useKeybindingStore.getState().getActionsForEvent(other)).toContain("pane.zoom.toggle");
      expect(other.defaultPrevented).toBe(false); expect(bubble).toHaveBeenCalledTimes(1);
      expectVisibleConversationSearch(); expectNoPtyWrites();
    } finally { window.removeEventListener("keydown", bubble); }
  }, 15000);

  it("keeps terminal search available under a fallback strip and ignores events for other sessions", async () => {
    await render("grok", true);
    await requestSearch("another-session");
    expect(terminalSearch()).toBeNull(); expect(transcriptSearch()).toBeNull();
    await requestSearch();
    expect(terminalSearch()).not.toBeNull(); expect(document.activeElement).toBe(terminalSearch());
    expect(transcriptSearch()).toBeNull(); expectNoPtyWrites();
  }, 15000);
});

describe("legacy conversation search keeps the terminal covered", () => {
  function holdArchiveOpen(error?: string) {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, ...rest: any[]) => {
      if (command === "open_transcript_history") {
        await gate;
        if (error) throw new Error(error);
      }
      return base(command, ...rest);
    });
    return async () => { await act(async () => { release(); await gate; }); };
  }

  function expectCoveredSearch(input: HTMLInputElement) {
    expect(host.querySelector("[data-agent-tab-fallback]")).toBeNull();
    expect(panel()).not.toBeNull();
    const terminal = host.querySelector(".xterm-helper-textarea");
    expect(terminal).not.toBeNull();
    expect(terminal?.parentElement?.parentElement?.hasAttribute("inert")).toBe(true);
    expect(transcriptSearch()).toBe(input);
    expect(input.value).toBe("F");
    expect(document.activeElement).toBe(input);
    expect(document.activeElement).not.toBe(terminal);
    expectNoPtyWrites();
  }

  it("1: keeps the search, cover and focus before and after a delayed archive opens", async () => {
    useSettingsStore.setState({ conversationHistoryMode: "legacy" });
    const release = holdArchiveOpen();
    await render();
    await requestSearch();
    const input = transcriptSearch()!;
    await typeInFocusedSearch("F");
    expectCoveredSearch(input);
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([command]) => command === "open_transcript_history")).toBe(true), { timeout: 10000 });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    expectCoveredSearch(input);
    await release();
    await vi.waitFor(() => expect(host.querySelector("[data-archive-row]")).not.toBeNull(), { timeout: 10000 });
    expectCoveredSearch(input);
  }, 20000);

  it.each(["recordMissing", "readError"])("2: keeps the search and cover when the delayed archive fails with %s", async error => {
    useSettingsStore.setState({ conversationHistoryMode: "legacy" });
    const release = holdArchiveOpen(error);
    await render();
    await requestSearch();
    const input = transcriptSearch()!;
    await typeInFocusedSearch("F");
    expectCoveredSearch(input);
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([command]) => command === "open_transcript_history")).toBe(true), { timeout: 10000 });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    expectCoveredSearch(input);
    await release();
    await vi.waitFor(() => {
      const mark = host.querySelector('.cmux-archive-notice [data-dashboard-status="error"]');
      expect(mark).not.toBeNull();
      expect(mark?.getAttribute("aria-label")).toBe(error === "recordMissing" ? "この会話の記録はまだ見つかりません" : "会話を読み取れませんでした。再試行できます");
      expect(mark?.closest("[hidden]")).toBeNull();
      expect(host.querySelector(".terminal-transcript-panel__head .agent-tab-archive-status")).toBeNull();
    }, { timeout: 10000 });
    expectCoveredSearch(input);
  }, 20000);

  it("3: keeps the search and cover without an archive descriptor", async () => {
    useSettingsStore.setState({ conversationHistoryMode: "legacy" });
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, ...rest: any[]) =>
      command === "read_agent_session_mappings" ? {} : base(command, ...rest));
    await render();
    await requestSearch();
    const input = transcriptSearch()!;
    await typeInFocusedSearch("F");
    expectCoveredSearch(input);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    expectCoveredSearch(input);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "open_transcript_history")).toHaveLength(0);
  }, 20000);

  it.each(["escape", "button", "clear"])("4: returns to recent events without uncovering the terminal after %s", async close => {
    useSettingsStore.setState({ conversationHistoryMode: "legacy" });
    const release = holdArchiveOpen();
    await render();
    await requestSearch();
    await typeInFocusedSearch("F");
    await release();
    await vi.waitFor(() => expect(host.querySelector("[data-archive-row]")).not.toBeNull(), { timeout: 10000 });
    expectCoveredSearch(transcriptSearch()!);
    if (close === "escape") {
      await key(transcriptSearch()!, { key: "Escape", code: "Escape", ctrlKey: false, shiftKey: false });
    } else if (close === "button") {
      await act(async () => host.querySelector<HTMLButtonElement>(".agent-tab-search-toggle")!.click());
    } else {
      await typeInFocusedSearch("");
    }
    expect(host.querySelector("[data-agent-tab-fallback]")).toBeNull();
    expect(panel()).not.toBeNull();
    expect(host.querySelector("[data-archive-view]")).toBeNull();
    expect(panel().textContent).toContain("Fixture request");
    expect(host.querySelector(".xterm-helper-textarea")?.parentElement?.parentElement?.hasAttribute("inert")).toBe(true);
    if (close === "clear") {
      expect(transcriptSearch()?.value).toBe("");
      expect(document.activeElement).toBe(transcriptSearch());
    } else {
      expect(transcriptSearch()).toBeNull();
      expect(document.activeElement).toBe(reply());
    }
    expectNoPtyWrites();
  }, 20000);
});

describe("terminal search when the conversation covers the tab", () => {
  it("5: closes terminal search on cover and leaves it closed when returning to the terminal", async () => {
    useSettingsStore.setState({ conversationHistoryMode: "agent-wheel" });
    await render();
    await act(async () => useAgentTabViewStore.getState().setView(tabId, "terminal"));
    await vi.waitFor(() => expect(document.activeElement).toBe(host.querySelector(".xterm-helper-textarea")), { timeout: 10000 });
    await requestSearch();
    const input = terminalSearch()!;
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "F");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.value).toBe("F");
    await act(async () => useAgentTabViewStore.getState().setView(tabId, "conversation"));
    await vi.waitFor(() => {
      expect(panel()).not.toBeNull();
      expect(host.querySelector(".xterm-helper-textarea")?.parentElement?.parentElement?.hasAttribute("inert")).toBe(true);
    }, { timeout: 10000 });
    expect(host.querySelector("[data-terminal-search]")).toBeNull();
    expect(document.activeElement).toBe(reply());
    await act(async () => useAgentTabViewStore.getState().setView(tabId, "terminal"));
    await vi.waitFor(() => expect(document.activeElement).toBe(host.querySelector(".xterm-helper-textarea")), { timeout: 10000 });
    expect(host.querySelector("[data-terminal-search]")).toBeNull();
    expectNoPtyWrites();
  }, 20000);
});
