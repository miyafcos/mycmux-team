// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), snapshot: vi.fn(), mappings: vi.fn(), nextContext: 0,
  listeners: new Map<string, Set<(event: { payload: any }) => void>>(),
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
  listen: vi.fn((name: string, callback: (event: { payload: any }) => void) => {
    const handlers = mocks.listeners.get(name) ?? new Set();
    handlers.add(callback); mocks.listeners.set(name, handlers);
    return Promise.resolve(() => { handlers.delete(callback); });
  }),
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

    attachCustomKeyEventHandler(): void {}
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
import PaneTabBar from "../../src/components/workspace/PaneTabBar";
import { evictTerminalCache } from "../../src/components/terminal/terminalCache";
import { agentTabStrings } from "../../src/components/terminal/agentTabStrings";
import { terminalPaneStrings } from "../../src/components/workspace/terminalPaneStrings";
import { applyPtyMetadata, connectLiveAgentHydration } from "../../src/lib/liveAgentMetadata";
import { onPtyMetadata, type PtyMetadata } from "../../src/lib/ipc";
import { codexRestoreNoticeEpoch } from "../../src/lib/codexRestoreLifecycle";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useAgentTabViewStore } from "../../src/stores/agentTabViewStore";
import { useComposerStore } from "../../src/stores/composerStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import type { TranscriptPage } from "../../src/lib/livebrief";

vi.mock("../../src/lib/ipc", async original => ({
  ...await original<typeof import("../../src/lib/ipc")>(),
  getPtyMetadataSnapshot: mocks.snapshot, readAgentSessionMappings: mocks.mappings,
}));
vi.mock("../../src/stores/liveBriefStore", async original => ({
  ...await original<typeof import("../../src/stores/liveBriefStore")>(),
  holdDetailSession: vi.fn(() => () => {}), connectLiveBriefStore: vi.fn(() => () => {}),
}));
vi.mock("../../src/components/layout/socketCommands", () => ({ handleSocketCommand: vi.fn() }));

let host: HTMLDivElement, root: Root, sequence = 0, sessionId: string, tabId: string;
const epoch = 42, agentSessionId = "401caf0d-c8d1-4c12-b0d4-ed291d41d356";
const stops: Array<() => void> = [];
const page: TranscriptPage = {
  readerId: "reattach-reader", sourceGeneration: "generation", snapshotEnd: "20",
  items: [{ occurrenceId: "reply:0", sourceStart: "0", sourceEnd: "20", slot: 0,
    kind: "assistant", timestamp: 1, text: "**Archive conversation stays visible**", bodyRef: null,
    callId: null, tool: null, target: null, aliases: [] }],
  olderCursor: null, newerCursor: "tail", latestCursor: "latest", scanContinuation: null,
  reachedStart: true, reachedFence: true, diagnostics: [],
};
function metadata(patch: Partial<PtyMetadata> = {}): PtyMetadata {
  return { session_id: sessionId, session_epoch: epoch, cwd: "C:/fixture", process_name: "claude.exe",
    process_status: "working", agent_active: true, live_agent_kind: "claude", agent_kind: "claude",
    agent_session_id: agentSessionId, claude_session_id: agentSessionId, ...patch };
}
function emit(name: string, payload: unknown) {
  const listeners = mocks.listeners.get(name);
  expect(listeners?.size, `registered production receiver for ${name}`).toBeGreaterThan(0);
  for (const callback of [...listeners!]) callback({ payload });
}
function reattach() {
  emit("codex-restore-invalidated", { session_id: sessionId });
  emit("codex-restore-published", { session_id: sessionId, session_epoch: epoch });
}
function Fixture() {
  const pane = useWorkspaceListStore(s => s.workspaces[0].panes[0]);
  return <div data-agent-tab-surface="true" style={{ position: "relative", height: 800, width: 1200 }}>
    <PaneTabBar pane={pane} workspaceId="w" hasTerminalBuffer={() => false} />
    <XTermWrapper workspaceId="w" sessionId={sessionId} command="powershell.exe" args={[]}
      agentId="shell-starter" agentKind={pane.tabs[0].agentKind} historyVisible />
  </div>;
}
const panel = () => host.querySelector(".terminal-transcript-panel--tab");
const terminal = () => host.querySelector(".xterm-helper-textarea")!.parentElement!.parentElement!;
const switchButton = () => host.querySelector<HTMLButtonElement>(".pane-agent-content-switch");
const menuItem = () => document.querySelector('[data-pane-action="agent-tab-content"]');
function assertConversation(previous: Element | null) {
  expect(panel(), "conversation must remain mounted before the next monitor observation").toBe(previous);
  expect(panel()).not.toBeNull();
  expect(host.querySelector("[data-agent-tab-fallback]"), "no terminal/loading fallback").toBeNull();
  expect(terminal().hasAttribute("inert"), "running terminal stays covered").toBe(true);
  expect(switchButton(), "heading switch remains available").not.toBeNull();
  expect(menuItem(), "overflow switch remains available").not.toBeNull();
  expect(menuItem()?.textContent).toBe(agentTabStrings.toTerminal);
}
async function mount(mode: "legacy" | "manual" = "manual") {
  useSettingsStore.setState({ conversationHistoryMode: mode });
  stops.push(await onPtyMetadata(applyPtyMetadata));
  stops.push(connectLiveAgentHydration(Promise.resolve()));
  await vi.waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1), { timeout: 5000 });
  await act(async () => {
    emit("pty_metadata", metadata());
    root.render(<Fixture />);
  });
  // A newly mounted xterm invalidates its old owner before native create.
  // Supply the native publication that the fake backend cannot emit itself.
  await act(async () => vi.waitFor(() => {
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "create_session")).toHaveLength(1);
  }, { timeout: 5000 }));
  await act(async () => {
    emit("codex-restore-published", { session_id: sessionId, session_epoch: epoch });
    emit("pty_metadata", metadata());
  });
  await act(async () => vi.waitFor(() => {
    expect(panel()).not.toBeNull(); expect(terminal().hasAttribute("inert")).toBe(true);
  }, { timeout: 5000 }));
  await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${terminalPaneStrings.paneActions}"]`)!.click());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as never); }
    unobserve() {} disconnect() {}
  });
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 800, width: 1200, height: 800, toJSON: () => ({}),
  });
  sessionId = `reattach-pty-${++sequence}`; tabId = `reattach-tab-${sequence}`;
  mocks.listeners.clear(); mocks.terminalInstances.length = 0; mocks.invoke.mockReset();
  mocks.snapshot.mockReset(); mocks.snapshot.mockImplementation(async () => ({ [sessionId]: metadata() }));
  mocks.mappings.mockReset(); mocks.mappings.mockImplementation(async () => ({ [sessionId]: { agent_kind: "claude", session_id: agentSessionId } }));
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "get_terminal_config") return { font_size: 14, shell: "powershell.exe", background: "#000000", foreground: "#ffffff", ansi: [], windows_build_number: null };
    if (command === "open_transcript_history") return page;
    if (command === "refresh_transcript_history_tail") return { ...page, items: [] };
    if (command === "heartbeat_transcript_history") return { hasNewBytes: false };
    return undefined;
  });
  useSettingsStore.setState({ agentTabContent: "conversation", conversationHistoryMode: "manual", terminalRenderer: "dom", notificationsEnabled: false });
  useAgentTabViewStore.setState({ views: {} });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {}, lastLog: {}, lastLogAt: {} });
  useDashboardViewStore.setState({ open: false }); useLiveBriefStore.getState().reset();
  useSessionAttentionStore.getState().resetForTests();
  useComposerStore.setState({ draftBySession: {}, dashboardOptimisticMessagesBySession: {}, dashboardRetryBySession: {} });
  useUiStore.setState({ activePaneId: sessionId, focusRevision: 0 });
  useWorkspaceListStore.setState({ activeWorkspaceId: "w", workspaces: [{ id: "w", name: "Fixture", gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes: [{ id: "p", sessionId, agentId: "shell-starter", activeTabId: tabId,
      tabs: [{ id: tabId, sessionId, agentId: "shell-starter", type: "terminal", agentKind: "claude" }] }] }] });
  useLiveBriefStore.setState({
    briefsBySession: { [sessionId]: { ptySessionId: sessionId, agentKind: "claude", agentSessionId,
      serviceEpoch: "epoch", ptyInstanceId: "instance", ptyGeneration: 1, sourceRevision: 1,
      ptyInputRevision: 1, briefRevision: 1, telemetryHealth: "live", operationalState: "running" } as never },
    eventsBySession: { [sessionId]: [{ eventId: "u", sourceRevision: 1, occurredAt: Date.now(), sourceByteStart: 0, sourceByteEnd: 10,
      kind: { type: "userMessage", kind: "taskStart", text: "Legacy conversation stays visible", digest: "u" } }] },
  });
  host = document.createElement("div"); host.dataset.cmuxThemedRoot = "true"; document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await act(async () => root.unmount()); evictTerminalCache(sessionId); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("conversation presentation during native same-epoch reattachment", () => {
  it.each(["legacy", "manual"] as const)("retains the %s reader and both switches until a confirmed shell observation", async mode => {
    await mount(mode);
    const readable = panel(); assertConversation(readable);
    const archiveOpens = mocks.invoke.mock.calls.filter(([command]) => command === "open_transcript_history").length;
    expect(host.textContent).toContain(mode === "manual" ? "Archive conversation stays visible" : "Legacy conversation stays visible");
    expect(codexRestoreNoticeEpoch(sessionId)).toBe(epoch);
    await act(async () => reattach());
    expect(codexRestoreNoticeEpoch(sessionId)).toBe(epoch);
    expect(usePaneMetadataStore.getState().volatileMetadata[sessionId]).toMatchObject({
      liveAgentKind: null, ptyAlive: true, liveAgentObservationKnown: false,
    });
    assertConversation(readable);
    expect(host.textContent).toContain(mode === "manual" ? "Archive conversation stays visible" : "Legacy conversation stays visible");
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "open_transcript_history")).toHaveLength(archiveOpens);
    await act(async () => emit("pty_metadata", metadata()));
    assertConversation(readable);
    await act(async () => emit("pty_metadata", metadata({ live_agent_kind: null, agent_active: false, process_name: "powershell.exe", process_status: "idle" })));
    expect(usePaneMetadataStore.getState().volatileMetadata[sessionId]).toMatchObject({ liveAgentKind: null, liveAgentObservationKnown: true });
    expect(panel()).toBeNull(); expect(terminal().hasAttribute("inert")).toBe(false);
    expect(switchButton()).toBeNull(); expect(menuItem()).toBeNull();
    expect(mocks.terminalInstances).toHaveLength(1);
  });

  it("uses the saved tab kind when no persisted metadata kind exists during re-observation", async () => {
    await mount();
    const readable = panel();
    await act(async () => {
      usePaneMetadataStore.setState({ metadata: {} });
      reattach();
    });
    assertConversation(readable);
  });

  it("does not retain a conversation after a confirmed PTY exit or same-epoch re-adoption of that exit", async () => {
    await mount();
    await act(async () => emit(`pty-exit-${sessionId}`, { session_epoch: epoch }));
    expect(usePaneMetadataStore.getState().volatileMetadata[sessionId]).toMatchObject({ ptyAlive: false, liveAgentObservationKnown: true });
    expect(panel()).toBeNull(); expect(switchButton()).toBeNull(); expect(menuItem()).toBeNull();
    await act(async () => reattach());
    expect(usePaneMetadataStore.getState().volatileMetadata[sessionId]).toMatchObject({ ptyAlive: false, liveAgentObservationKnown: true });
    expect(panel()).toBeNull(); expect(switchButton()).toBeNull(); expect(menuItem()).toBeNull();
  });
});
