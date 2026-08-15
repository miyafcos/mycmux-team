// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  terminalInstances: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
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
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver);
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
  vi.clearAllMocks();
  mocks.terminalInstances.length = 0;
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
