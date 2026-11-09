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
import { evictTerminalCache } from "../../src/components/terminal/terminalCache";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useAgentTabViewStore, AGENT_TAB_VIEW_KEY } from "../../src/stores/agentTabViewStore";
import { useComposerStore } from "../../src/stores/composerStore";
import { handleSocketCommand } from "../../src/components/layout/socketCommands";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";
import { useDashboardViewStore } from "../../src/stores/dashboardViewStore";
import { useUiStore } from "../../src/stores/uiStore";
import { focusController } from "../../src/lib/focusController";
import { agentTabStrings } from "../../src/components/terminal/agentTabStrings";
vi.mock("../../src/stores/liveBriefStore", async original => ({
  ...await original<typeof import("../../src/stores/liveBriefStore")>(), holdDetailSession: vi.fn(() => () => {}), connectLiveBriefStore: vi.fn(() => () => {}),
}));
vi.mock("../../src/components/layout/socketCommands", () => ({ handleSocketCommand: vi.fn() }));
let host: HTMLDivElement, root: Root, sequence = 0, sessionId: string, tabId: string;
async function render(visible = true) {
  await act(async () => root.render(<div data-agent-tab-surface="true" style={{ position: "relative", height: 800, width: 720 }}>
    <XTermWrapper workspaceId="w" sessionId={sessionId} command="powershell.exe" args={[]} agentId="shell-starter" agentKind="grok" historyVisible={visible} />
  </div>));
}
function publishConversation() {
  useLiveBriefStore.setState({
    briefsBySession: { [sessionId]: { ptySessionId: sessionId, agentKind: "grok", agentSessionId: "agent", serviceEpoch: "epoch", ptyInstanceId: "instance", ptyGeneration: 1, sourceRevision: 1, ptyInputRevision: 1, briefRevision: 1, telemetryHealth: "live", operationalState: "running" } as never },
    eventsBySession: { [sessionId]: [{ eventId: "u", sourceRevision: 1, occurredAt: Date.now(), sourceByteStart: 0, sourceByteEnd: 10, kind: { type: "userMessage", kind: "taskStart", text: "Fixture conversation", digest: "u" } }] },
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { constructor(private callback: ResizeObserverCallback) {} observe(target: Element) { this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as never); } disconnect() {} });
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 720, bottom: 800, width: 720, height: 800, toJSON: () => ({}) });
  sessionId = `conversation-pty-${++sequence}`; tabId = `conversation-tab-${sequence}`;
  mocks.terminalInstances.length = 0; mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "get_terminal_config") return { font_size: 14, shell: "powershell.exe", background: "#000000", foreground: "#ffffff", ansi: [], windows_build_number: null };
    return undefined;
  });
  useSettingsStore.setState({ agentTabContent: "terminal", conversationHistoryMode: "legacy", terminalRenderer: "dom", notificationsEnabled: false });
  useAgentTabViewStore.setState({ views: {} });
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {}, lastLog: {}, lastLogAt: {} });
  useDashboardViewStore.setState({ open: false }); useLiveBriefStore.getState().reset();
  useUiStore.setState({ activePaneId: sessionId, focusRevision: 0 });
  useWorkspaceListStore.setState({ activeWorkspaceId: "w", workspaces: [{ id: "w", name: "Fixture", gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes: [{ id: "p", sessionId, agentId: "shell-starter", activeTabId: tabId, tabs: [{ id: tabId, sessionId, agentId: "shell-starter", type: "terminal", agentKind: "grok" }] }] }] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); evictTerminalCache(sessionId); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
describe("conversation overlay keeps the running terminal", () => {
  it("switches without recreating/unmounting xterm or resizing the PTY, and routes registered focus to the reply", async () => {
    await render();
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "create_session")).toHaveLength(1), { timeout: 5000 });
    await act(async () => new Promise(resolve => setTimeout(resolve, 150)));
    const input = host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;
    const instance = mocks.terminalInstances[0];
    const counts = () => ({
      create: mocks.invoke.mock.calls.filter(([command]) => command === "create_session").length,
      resize: mocks.invoke.mock.calls.filter(([command]) => command === "resize_session").length,
    });
    const before = counts(), box = input.parentElement!.parentElement!.getAttribute("style");
    await act(async () => { publishConversation(); useSettingsStore.getState().setAgentTabContent("conversation"); });
    expect(host.querySelector(".terminal-transcript-panel--tab")).not.toBeNull();
    expect(input.isConnected).toBe(true);
    expect(input.parentElement!.parentElement!.getAttribute("style")).toBe(box);
    expect(input.parentElement!.parentElement!.hasAttribute("inert")).toBe(true);
    await act(async () => focusController.request("tab-click", { sessionId, focus: true }));
    await act(async () => new Promise(resolve => setTimeout(resolve, 100)));
    expect(document.activeElement).toBe(host.querySelector(".cmux-dashboard-composer-input"));
    await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${agentTabStrings.toTerminal}"]`)!.click());
    await act(async () => new Promise(resolve => setTimeout(resolve, 100)));
    expect(host.querySelector(".terminal-transcript-panel--tab")).toBeNull();
    expect(useAgentTabViewStore.getState().views[tabId]).toBe("terminal");
    expect(host.querySelector(".xterm-helper-textarea")).toBe(input);
    expect(input.parentElement!.parentElement!.hasAttribute("inert")).toBe(false);
    expect(instance.dispose).not.toHaveBeenCalled();
    expect(mocks.terminalInstances).toHaveLength(1); expect(counts()).toEqual(before);
  });
  it("persists the terminal choice and focuses the running xterm after an unconfirmed slash command", async () => {
    publishConversation(); useSettingsStore.setState({ agentTabContent: "conversation" });
    useComposerStore.setState({ draftBySession: {}, dashboardOptimisticMessagesBySession: {}, dashboardRetryBySession: {} });
    await render();
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "create_session")).toHaveLength(1), { timeout: 5000 });
    await vi.waitFor(() => expect(host.querySelector(".cmux-dashboard-composer-input")).not.toBeNull(), { timeout: 5000 });
    const terminalInput = host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;
    const instance = mocks.terminalInstances[0];
    const send = vi.mocked(handleSocketCommand);
    send.mockClear();
    let complete!: (value: unknown) => void;
    send.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await act(async () => useComposerStore.getState().setDraft(sessionId, "/cost"));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="送信"]')!.click());
    expect(send).toHaveBeenCalledExactlyOnceWith("pane.send_text", { sessionId, text: "\x1b[200~/cost\x1b[201~", enter: true });
    expect(host.querySelector(".terminal-transcript-panel--tab")).not.toBeNull();
    expect(host.querySelector("[data-dashboard-optimistic-message]")).toBeNull();
    expect(useAgentTabViewStore.getState().views[tabId]).toBeUndefined();
    await act(async () => complete({ confirmed: false, reason: "submit_unconfirmed" }));
    await vi.waitFor(() => expect(host.querySelector(".terminal-transcript-panel--tab")).toBeNull(), { timeout: 5000 });
    await vi.waitFor(() => expect(document.activeElement).toBe(terminalInput), { timeout: 5000 });
    expect(useAgentTabViewStore.getState().views[tabId]).toBe("terminal");
    expect(JSON.parse(localStorage.getItem(AGENT_TAB_VIEW_KEY)!)).toContainEqual([tabId, "terminal"]);
    expect(useComposerStore.getState().dashboardOptimisticMessagesBySession[sessionId] ?? []).toHaveLength(0);
    expect(useComposerStore.getState().draftBySession[sessionId] ?? "").toBe("");
    expect(host.querySelector(".xterm-helper-textarea")).toBe(terminalInput);
    expect(terminalInput.parentElement!.parentElement!.hasAttribute("inert")).toBe(false);
    expect(instance.dispose).not.toHaveBeenCalled();
    expect(mocks.terminalInstances).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "create_session")).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("writes a real ESC byte through the terminal queue, blocks hidden-terminal data, and never sends Ctrl+C", async () => {
    publishConversation(); useSettingsStore.setState({ agentTabContent: "conversation" });
    await render();
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([command]) => command === "create_session")).toBe(true), { timeout: 5000 });
    const panel = host.querySelector<HTMLElement>(".terminal-transcript-panel--tab")!;
    panel.focus();
    await act(async () => {
      (mocks.terminalInstances[0] as unknown as { onDataCallback: (data: string) => void }).onDataCallback("accidental input");
      panel.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "write_to_session")).toHaveLength(0);
    await act(async () => { panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "write_to_session")).toEqual([["write_to_session", { sessionId, data: "\x1b" }]]);
  });
  it("detects an agent started inside a shell and releases the full view when the shell returns", async () => {
    useSettingsStore.setState({ agentTabContent: "conversation" });
    usePaneMetadataStore.setState({ volatileMetadata: { [sessionId]: { ptyAlive: true, liveAgentKind: null } } });
    await render(); expect(host.querySelector("[data-terminal-transcript-panel]")).toBeNull();
    await act(async () => {
      publishConversation();
      usePaneMetadataStore.setState({ volatileMetadata: { [sessionId]: { ptyAlive: true, liveAgentKind: "grok" } } });
    });
    expect(host.querySelector(".terminal-transcript-panel--tab")).not.toBeNull();
    await act(async () => usePaneMetadataStore.setState({ volatileMetadata: { [sessionId]: { ptyAlive: true, liveAgentKind: null } } }));
    expect(host.querySelector("[data-terminal-transcript-panel]")).toBeNull();
    expect(mocks.terminalInstances).toHaveLength(1);
  });
});

describe("terminal setting does not mount live strips", () => {
  it("does not create a 250ms strip timer in terminal mode", async () => {
    const intervals = vi.spyOn(window, "setInterval");
    publishConversation();
    await render();
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "create_session")).toHaveLength(1), { timeout: 5000 });
    expect(host.querySelector(".agent-tab-live-strip")).toBeNull();
    expect(host.querySelector(".terminal-transcript-panel--tab")).toBeNull();
    expect(intervals.mock.calls.filter(([, milliseconds]) => milliseconds === 250)).toHaveLength(0);
  });
});
