// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  terminalInstances: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
  observers: [] as Array<{ disconnect: ReturnType<typeof vi.fn>; target?: Element }>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class<T> {
    onmessage?: (message: T) => void;
  },
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
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
    unicode = { activeVersion: "" };
    parser = { registerOscHandler: vi.fn(() => disposable()) };
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
    onData(): { dispose: () => void } { return disposable(); }
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

vi.mock("../../src/components/workspace/PaneTabBar", () => ({ default: () => null }));
vi.mock("../../src/components/workspace/BrowserPane", () => ({ default: () => null }));
vi.mock("../../src/components/online/OnlinePanel", () => ({ default: () => null }));
vi.mock("../../src/components/composer/PaneComposer", () => ({ PaneComposer: () => null }));

import type { PaneConfig, WorkspaceConfig } from "../../src/lib/ipc";
import { restoreWorkspaceConfigs } from "../../src/lib/workspaceRestore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import WorkspaceView from "../../src/components/workspace/WorkspaceView";
import { evictTerminalCache } from "../../src/components/terminal/terminalCache";

let container: HTMLDivElement;
let root: Root;
let testSequence = 0;

function workspaceConfig(id: string, panes: PaneConfig[]): WorkspaceConfig {
  return {
    id,
    name: "Restore integration",
    grid_template_id: "1x1",
    panes,
    created_at: 1,
    split_columns: [panes.map((_, index) => index)],
  };
}

function createSessionCalls(): Array<[string, {
  sessionId: string;
  args: string[];
  env: Record<string, string> | null;
}]> {
  return mocks.invoke.mock.calls.filter(([command]) => command === "create_session") as Array<[
    string,
    { sessionId: string; args: string[]; env: Record<string, string> | null },
  ]>;
}

async function renderWorkspaceView(): Promise<void> {
  await act(async () => {
    root.render(<WorkspaceView />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  testSequence += 1;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    target?: Element;
    constructor(private readonly callback: ResizeObserverCallback) { mocks.observers.push(this); }
    observe(target: Element): void {
      this.target = target;
      this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    disconnect = vi.fn();
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
  vi.clearAllMocks();
  mocks.terminalInstances.length = 0;
  mocks.observers.length = 0;
  mocks.invoke.mockImplementation((command: string) => {
    if (command === "get_terminal_config") {
      return Promise.resolve({
        font_size: 14,
        shell: "powershell.exe",
        background: "#000000",
        foreground: "#ffffff",
        ansi: [],
        windows_build_number: null,
      });
    }
    return Promise.resolve(undefined);
  });
  window.localStorage.clear();
  useSettingsStore.setState({
    paneComposerEnabled: false,
    declaredLaunchEnabled: true,
    terminalRenderer: "dom",
    notificationsEnabled: false,
  });
  usePaneMetadataStore.setState({ metadata: {}, lastLog: {}, lastLogAt: {} });
  useUiStore.setState({ activePaneId: null, focusRevision: 0 });
  useWorkspaceListStore.setState({
    workspaces: [],
    activeWorkspaceId: null,
    lastActivePaneByWorkspace: {},
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("declared restore PTY integration", () => {
  it("does not allocate a terminal after closing during initial IPC", async () => {
    let finish!: (alive: boolean) => void;
    const waiting = new Promise<boolean>(resolve => { finish = resolve; });
    const implementation = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string) => command === "is_session_alive" ? waiting : implementation(command));
    const workspaceId = `closed-during-init-${testSequence}`;
    restoreWorkspaceConfigs([workspaceConfig(workspaceId, [{
      pane_id: "waiting-pane", agent_id: "shell-starter", label: null, active_tab_id: "waiting-tab",
      tabs: [{ tab_id: "waiting-tab", agent_id: "shell-starter", label: null, type: "terminal" }],
    }])], { activeWorkspaceId: workspaceId });
    useWorkspaceListStore.getState().setActiveWorkspace(workspaceId);
    await renderWorkspaceView();
    expect(mocks.invoke.mock.calls.some(([command]) => command === "is_session_alive")).toBe(true);
    await act(async () => useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null }));
    await act(async () => { finish(true); await waiting; });
    expect(mocks.terminalInstances).toHaveLength(0);
    expect(createSessionCalls()).toHaveLength(0);
    const removedObservers = mocks.observers.filter(observer => observer.target && !observer.target.isConnected);
    expect(removedObservers.length).toBeGreaterThan(0);
    for (const observer of removedObservers) expect(observer.disconnect).toHaveBeenCalledTimes(1);
  });

  it("retains a visited pair across tab/workspace switches and disconnects on close", async () => {
    const ids = ["retain-a", "retain-b"].map(id => `${id}-${testSequence}`);
    const configs = ids.map(id => workspaceConfig(id, [{
      pane_id: `pane-${id}`, agent_id: "shell-starter", label: null,
      active_tab_id: `${id}-first`,
      tabs: ["first", "second"].map(suffix => ({
        tab_id: `${id}-${suffix}`, agent_id: "shell-starter", label: null, type: "terminal" as const,
      })),
    }]));
    restoreWorkspaceConfigs(configs, { activeWorkspaceId: ids[0] });
    useWorkspaceListStore.getState().setActiveWorkspace(ids[0]);
    await renderWorkspaceView();
    await vi.waitFor(() => expect(createSessionCalls()).toHaveLength(1));
    const firstPane = useWorkspaceListStore.getState().getWorkspace(ids[0])!.panes[0];
    await act(async () => useWorkspaceLayoutStore.getState().setActivePaneTab(ids[0], firstPane.id, `${ids[0]}-second`));
    await vi.waitFor(() => expect(createSessionCalls()).toHaveLength(2));
    const changedPane = useWorkspaceListStore.getState().getWorkspace(ids[0])!.panes[0];
    const activeTerminal = container.querySelector(`[data-dnd-pane-id="${firstPane.id}"] .xterm-helper-textarea`);
    expect(activeTerminal?.closest('[data-session-id]')?.getAttribute('data-session-id')).toBe(changedPane.sessionId);
    expect(activeTerminal?.closest('[data-retained-terminal]')?.getAttribute('aria-hidden')).toBe('false');
    await act(async () => useWorkspaceListStore.getState().setActiveWorkspace(ids[1]));
    await vi.waitFor(() => expect(createSessionCalls()).toHaveLength(3));
    const terminals = [...mocks.terminalInstances], observers = [...mocks.observers];
    for (let i = 0; i < 10; i++) {
      await act(async () => useWorkspaceListStore.getState().setActiveWorkspace(ids[0]));
      await act(async () => useWorkspaceLayoutStore.getState().setActivePaneTab(ids[0], firstPane.id, `${ids[0]}-${i % 2 ? "first" : "second"}`));
      await act(async () => useWorkspaceListStore.getState().setActiveWorkspace(ids[1]));
    }
    expect(createSessionCalls()).toHaveLength(3);
    expect(mocks.terminalInstances).toEqual(terminals);
    expect(mocks.observers).toEqual(observers);
    for (const terminal of terminals) expect(terminal.dispose).not.toHaveBeenCalled();
    // A real close marks even a retained mounted terminal for disposal before
    // layout removal, so it must not be resurrected in the detached cache.
    const closing = useWorkspaceListStore.getState().getWorkspace(ids[0])!.panes[0];
    for (const tab of closing.tabs) evictTerminalCache(tab.sessionId);
    await act(async () => useWorkspaceListStore.setState(state => ({ workspaces: state.workspaces.filter(ws => ws.id !== ids[0]) })));
    expect(terminals[0].dispose).toHaveBeenCalledTimes(1);
    expect(terminals[1].dispose).toHaveBeenCalledTimes(1);
    expect(observers.filter(observer => observer.disconnect.mock.calls.length > 0).length).toBeGreaterThanOrEqual(2);
  });

  it("preserves each saved agent resume identity while retaining sibling sessions", async () => {
    const workspaceId = `retained-resume-${testSequence}`;
    const identities = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    const config = workspaceConfig(workspaceId, [{
      pane_id: "saved-agent-pane", agent_id: "claude-code", label: null, active_tab_id: "saved-agent-0",
      tabs: identities.map((sessionId, index) => ({
        tab_id: `saved-agent-${index}`, agent_id: "claude-code", label: null, type: "terminal" as const,
        agent_kind: "claude" as const, agent_session_id: sessionId, claude_session_id: sessionId,
      })),
    }]);
    restoreWorkspaceConfigs([config], { activeWorkspaceId: workspaceId });
    useWorkspaceListStore.getState().setActiveWorkspace(workspaceId);
    await renderWorkspaceView();
    await vi.waitFor(() => expect(createSessionCalls()).toHaveLength(1));
    const pane = useWorkspaceListStore.getState().getWorkspace(workspaceId)!.panes[0];
    await act(async () => useWorkspaceLayoutStore.getState().setActivePaneTab(workspaceId, pane.id, "saved-agent-1"));
    await vi.waitFor(() => expect(createSessionCalls()).toHaveLength(2));
    for (let index = 0; index < 2; index++) {
      const payload = createSessionCalls()[index][1];
      expect(payload.sessionId).toBe(pane.tabs[index].sessionId);
      expect(payload.args.slice(-2)).toEqual(["--resume", identities[index]]);
      expect(payload.env).toMatchObject({ MYCMUX_AGENT_KIND: "claude", MYCMUX_RESUME: "claude", MYCMUX_SESSION_ID: identities[index] });
      expect(payload.args).not.toContain(identities[1 - index]);
    }
    for (let index = 0; index < 20; index++) {
      await act(async () => useWorkspaceLayoutStore.getState().setActivePaneTab(workspaceId, pane.id, `saved-agent-${index % 2}`));
    }
    expect(createSessionCalls()).toHaveLength(2);
    for (const tab of pane.tabs) evictTerminalCache(tab.sessionId);
  });

  it("creates exactly five production PTYs on first render after restoring 100 declared panes", async () => {
    const workspaceId = `restore-bulk-${testSequence}`;
    const declaredPanes: PaneConfig[] = Array.from({ length: 100 }, (_, index) => ({
      pane_id: `declared-pane-${index}`,
      agent_id: "shell-starter",
      label: null,
      active_tab_id: `declared-${index}`,
      tabs: [{
        tab_id: `declared-${index}`,
        agent_id: "shell-starter",
        label: null,
        type: "terminal",
        lifecycle: "declared",
      }],
    }));
    const normalPanes: PaneConfig[] = Array.from({ length: 5 }, (_, index) => ({
      pane_id: `normal-pane-${index}`,
      agent_id: "shell-starter",
      label: null,
      active_tab_id: `normal-${index}`,
      tabs: [{
        tab_id: `normal-${index}`,
        agent_id: "shell-starter",
        label: null,
        type: "terminal",
      }],
    }));
    const config = workspaceConfig(workspaceId, [...declaredPanes, ...normalPanes]);

    restoreWorkspaceConfigs([config], { activeWorkspaceId: workspaceId });
    useWorkspaceListStore.getState().setActiveWorkspace(workspaceId);
    await renderWorkspaceView();

    await vi.waitFor(() => expect(createSessionCalls()).toHaveLength(5));
    const restored = useWorkspaceListStore.getState().getWorkspace(workspaceId)!;
    expect(restored.panes).toHaveLength(105);
    expect(restored.panes.filter((pane) => pane.tabs[0].lifecycle === "declared")).toHaveLength(100);
    const sessionIds = createSessionCalls().map(([, args]) => args.sessionId);
    expect(new Set(sessionIds)).toEqual(new Set(Array.from({ length: 5 }, (_, index) => (
      `pty-${workspaceId}-normal-pane-${index}-normal-${index}`
    ))));
    expect(sessionIds.some((sessionId) => sessionId.includes("declared"))).toBe(false);
  });

  it("sends no sibling resume identity through the production create_session payload", async () => {
    const workspaceId = `resume-safe-${testSequence}`;
    const config = workspaceConfig(workspaceId, [{
      pane_id: "pane-safe",
      agent_id: "claude-code",
      label: null,
      active_tab_id: "declared-safe",
      claude_session_id: "sibling-session",
      agent_kind: "claude",
      agent_session_id: "sibling-session",
      tabs: [{
        tab_id: "normal-sibling",
        agent_id: "claude-code",
        label: null,
        type: "terminal",
        claude_session_id: "sibling-session",
        agent_kind: "claude",
        agent_session_id: "sibling-session",
      }, {
        tab_id: "declared-safe",
        agent_id: "claude-code",
        label: "Fresh Claude",
        type: "terminal",
        lifecycle: "declared",
        declared_target: "claude",
        declared_prompt: "start fresh",
      }],
    }]);

    restoreWorkspaceConfigs([config], { activeWorkspaceId: workspaceId });
    useWorkspaceListStore.getState().setActiveWorkspace(workspaceId);
    const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId)!;
    const launched = useWorkspaceLayoutStore.getState().launchDeclaredTab(
      workspaceId,
      workspace.panes[0].id,
      "declared-safe",
    );
    expect(launched).not.toBeNull();
    expect(launched?.claudeSessionId).toBeUndefined();
    expect(launched?.agentSessionId).toBeUndefined();

    await renderWorkspaceView();
    await vi.waitFor(() => expect(createSessionCalls()).toHaveLength(1));

    const payload = createSessionCalls()[0][1];
    expect(payload.args).toContain("--session-id");
    expect(payload.args).not.toContain("--resume");
    expect(payload.args).not.toContain("resume");
    expect(payload.env ?? {}).not.toHaveProperty("MYCMUX_RESUME");
    expect(payload.env ?? {}).not.toHaveProperty("MYCMUX_SESSION_ID");
  });
});
