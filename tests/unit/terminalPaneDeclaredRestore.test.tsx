// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Pane, PaneTab, Workspace } from "../../src/types";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  xtermMount: vi.fn(),
  evictTerminalCache: vi.fn(),
  tabBarProps: null as { onRemoveTab?: (tabId: string) => void } | null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class<T> {
    onmessage?: (message: T) => void;
  },
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("../../src/components/workspace/PaneTabBar", () => ({
  default: (props: { onRemoveTab?: (tabId: string) => void }) => {
    mocks.tabBarProps = props;
    return null;
  },
}));
vi.mock("../../src/components/workspace/BrowserPane", () => ({ default: () => null }));
vi.mock("../../src/components/workspace/WebPaneStatusBar", () => ({ default: () => null }));
vi.mock("../../src/components/online/OnlinePanel", () => ({ default: () => null }));
vi.mock("../../src/components/composer/PaneComposer", () => ({ PaneComposer: () => null }));
vi.mock("../../src/components/terminal/XTermWrapper", async () => {
  const React = await import("react");
  type MockProps = {
    sessionId: string;
    command: string;
    args: string[];
    cwd?: string;
    launchEnv?: Record<string, string>;
    restoreFallbackSessionIds?: string[];
    initialReplay?: string[];
    agentKind?: string;
  };
  const MockXTermWrapper = (props: MockProps) => {
    React.useEffect(() => {
      mocks.xtermMount(props);
    }, [props.agentKind, props.args, props.command, props.cwd, props.initialReplay, props.launchEnv, props.restoreFallbackSessionIds, props.sessionId]);
    return <div data-xterm-session={props.sessionId} />;
  };
  return {
    default: MockXTermWrapper,
    evictTerminalCache: mocks.evictTerminalCache,
    hasTerminalBuffer: () => false,
  };
});

import TerminalPane, { buildLaunchArgs } from "../../src/components/workspace/TerminalPane";

let container: HTMLDivElement;
let root: Root;

function paneWith(tab: PaneTab, paneId = "pane"): Pane {
  return {
    id: paneId,
    agentId: tab.agentId,
    sessionId: tab.sessionId,
    tabs: [tab],
    activeTabId: tab.id,
  };
}

function workspaceWith(panes: Pane[], id = "workspace"): Workspace {
  return {
    id,
    name: "Workspace",
    gridTemplateId: "1x1",
    status: "running",
    createdAt: 1,
    panes,
    splitColumns: [panes.map((pane) => pane.id)],
  };
}

async function renderPanes(workspace: Workspace): Promise<void> {
  useWorkspaceListStore.setState({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
    lastActivePaneByWorkspace: {},
  });
  await act(async () => {
    root.render(<>
      {workspace.panes.map((pane) => (
        <TerminalPane key={pane.id} pane={pane} workspaceId={workspace.id} />
      ))}
    </>);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  mocks.tabBarProps = null;
  mocks.invoke.mockResolvedValue(undefined);
  useSettingsStore.setState({ paneComposerEnabled: false, declaredLaunchEnabled: true });
  usePaneMetadataStore.setState({ metadata: {}, lastLog: {} });
  useUiStore.setState({ activePaneId: null, focusRevision: 0 });
  useWorkspaceListStore.setState({
    workspaces: [],
    activeWorkspaceId: null,
    lastActivePaneByWorkspace: {},
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("TerminalPane declared restore boundary", () => {
  it("mounts no XTermWrapper for a declared active tab and one for a normal active tab", async () => {
    const declared: PaneTab = {
      id: "declared",
      sessionId: "declared-session",
      agentId: "shell-starter",
      type: "terminal",
      lifecycle: "declared",
    };
    await renderPanes(workspaceWith([paneWith(declared)]));
    expect(container.querySelector("[data-declared-tab-placeholder]")).not.toBeNull();
    expect(mocks.xtermMount).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "create_session")).toHaveLength(0);

    const normal: PaneTab = {
      id: "normal",
      sessionId: "normal-session",
      agentId: "shell-starter",
      type: "terminal",
    };
    await renderPanes(workspaceWith([paneWith(normal)]));
    expect(mocks.xtermMount).toHaveBeenCalledTimes(1);
    expect(mocks.xtermMount).toHaveBeenCalledWith(expect.objectContaining({ sessionId: normal.sessionId }));
  });

  it("closes a web tab without killing or evicting its terminal sibling", async () => {
    const terminal: PaneTab = {
      id: "terminal",
      sessionId: "terminal-session",
      agentId: "claude-code",
      type: "terminal",
      cwd: "C:\\terminal-work",
      agentKind: "claude",
      agentSessionId: "terminal-agent-session",
      terminalSnapshot: ["keep terminal output"],
    };
    const originalPane: Pane = {
      ...paneWith(terminal),
      cwd: terminal.cwd,
      agentKind: terminal.agentKind,
      agentSessionId: terminal.agentSessionId,
    };
    const workspace = workspaceWith([originalPane]);
    usePaneMetadataStore.setState({
      metadata: { [terminal.sessionId]: { cwd: terminal.cwd } },
      lastLog: {},
    });
    await renderPanes(workspace);

    await act(async () => {
      useWorkspaceLayoutStore.getState().addWebTabToPane(
        workspace.id,
        originalPane.id,
        { presetId: "chatgpt", label: "ChatGPT" },
      );
      await Promise.resolve();
    });
    const openedWorkspace = useWorkspaceListStore.getState().getWorkspace(workspace.id)!;
    const openedPane = openedWorkspace.panes[0];
    const webTab = openedPane.tabs.find((tab) => tab.type === "web")!;
    await renderPanes(openedWorkspace);

    await act(async () => {
      mocks.tabBarProps?.onRemoveTab?.(webTab.id);
      await Promise.resolve();
    });
    const closedWorkspace = useWorkspaceListStore.getState().getWorkspace(workspace.id)!;
    const closedPane = closedWorkspace.panes[0];
    await renderPanes(closedWorkspace);

    expect(mocks.invoke.mock.calls.filter(([command]) => command === "kill_session")).toHaveLength(0);
    expect(mocks.evictTerminalCache).not.toHaveBeenCalled();
    expect(closedPane.tabs).toEqual([terminal]);
    expect(closedPane.activeTabId).toBe(terminal.id);
    expect(closedPane.sessionId).toBe(terminal.sessionId);
    expect(closedPane.cwd).toBe(terminal.cwd);
    expect(closedPane.agentKind).toBe(terminal.agentKind);
    expect(closedPane.agentSessionId).toBe(terminal.agentSessionId);
    expect(usePaneMetadataStore.getState().metadata[terminal.sessionId]?.cwd).toBe(terminal.cwd);
    expect(container.querySelector(`[data-xterm-session="${terminal.sessionId}"]`)).not.toBeNull();
  });

  it("launches a restored declaration next to a saved Claude tab without resume args or env", async () => {
    const restored = useWorkspaceLayoutStore.getState().restorePanes(
      "resume-safe",
      [{
        pane_id: "pane-safe",
        agent_id: "claude-code",
        active_tab_id: "declared-safe",
        claude_session_id: "sibling-session",
        agent_kind: "claude",
        agent_session_id: "sibling-session",
        tabs: [{
          tab_id: "normal-sibling",
          agent_id: "claude-code",
          type: "terminal",
          claude_session_id: "sibling-session",
          agent_kind: "claude",
          agent_session_id: "sibling-session",
        }, {
          tab_id: "declared-safe",
          agent_id: "claude-code",
          type: "terminal",
          lifecycle: "declared",
          declared_target: "claude",
          declared_prompt: "start fresh",
        }],
      }],
      [[0]],
      "1x1",
    );
    const workspace = workspaceWith(restored.panes, "resume-safe");
    workspace.splitColumns = restored.splitColumns;
    useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
    const launched = useWorkspaceLayoutStore.getState().launchDeclaredTab(
      workspace.id,
      restored.panes[0].id,
      "declared-safe",
    );
    expect(launched).not.toBeNull();
    expect(launched?.claudeSessionId).toBeUndefined();
    expect(launched?.agentSessionId).toBeUndefined();
    const updated = useWorkspaceListStore.getState().getWorkspace(workspace.id)!;

    await renderPanes(updated);

    const props = mocks.xtermMount.mock.calls[0][0] as {
      args: string[];
      launchEnv?: Record<string, string>;
    };
    expect(props.args).toContain("--session-id");
    expect(props.args).not.toContain("--resume");
    expect(props.args).not.toContain("resume");
    expect(props.launchEnv).not.toHaveProperty("MYCMUX_RESUME");
    expect(props.launchEnv).not.toHaveProperty("MYCMUX_SESSION_ID");
  });

  it("never appends an initial prompt to shell launcher argv", () => {
    expect(buildLaunchArgs(
      "powershell.exe",
      ["-NoLogo"],
      "shell-starter",
      null,
      undefined,
      undefined,
      "must-not-enter-shell-argv",
    )).toEqual(["-NoLogo"]);
  });

  it("passes a saved agent snapshot to XTermWrapper for its restore policy", async () => {
    const agentTab: PaneTab = {
      id: "saved-agent",
      sessionId: "saved-agent-session",
      agentId: "claude-code",
      type: "terminal",
      agentKind: "claude",
      agentSessionId: "saved-agent-session",
      terminalSnapshot: ["saved plain snapshot"],
    };

    await renderPanes(workspaceWith([paneWith(agentTab)]));

    expect(mocks.xtermMount).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "saved-agent-session",
      agentKind: "claude",
      initialReplay: ["saved plain snapshot"],
    }));
  });

  it("never offers suppressed agent sessions as restore fallback candidates", async () => {
    const agentTab: PaneTab = {
      id: "saved-agent",
      sessionId: "saved-agent-session",
      agentId: "claude-code",
      type: "terminal",
      agentKind: "claude",
      agentSessionId: "saved-agent-session",
      suppressedAgentSessions: [{
        agentKind: "claude",
        agentSessionId: "another-tabs-session",
        claudeSessionId: "another-tabs-session",
      }],
    };

    await renderPanes(workspaceWith([paneWith(agentTab)]));

    const props = mocks.xtermMount.mock.calls.at(-1)?.[0];
    expect(props).not.toHaveProperty("restoreFallbackSessionIds");
  });
});

describe("background spawn followed by a TerminalPane mount", () => {
  it("passes the same session IDs to renderer attachment without new PTY processes", async () => {
    const { handleSocketCommand } = await import("../../src/components/layout/socketCommands");
    const { createSession } = await import("../../src/lib/ipc");
    const { liveTerms } = await import("../../src/components/terminal/terminalCache");
    const { useSavepointDragStore } = await import("../../src/stores/savepointDragStore");
    liveTerms.clear();
    useSavepointDragStore.setState({ item: null });
    const parent = paneWith({
      id: "background-tab", sessionId: "background-session", agentId: "shell-starter", type: "terminal",
    });
    const background = workspaceWith([parent], "background");
    const foreground = workspaceWith([paneWith({
      id: "foreground-tab", sessionId: "foreground-session", agentId: "shell-starter", type: "terminal",
    }, "foreground-pane")], "foreground");
    useWorkspaceListStore.setState({ workspaces: [foreground, background], activeWorkspaceId: foreground.id });

    // Backend fixture follows manager.rs::create_or_reattach; a create_session
    // IPC call on mount changes the channel, not the existing PTY process.
    const sessions = new Set([parent.sessionId]);
    const spawnPty = vi.fn();
    mocks.invoke.mockImplementation(async (command: string, args: { sessionId?: string }) => {
      if (command === "create_session" && args.sessionId && !sessions.has(args.sessionId)) {
        sessions.add(args.sessionId);
        spawnPty(args.sessionId);
      }
    });
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      const result = await handleSocketCommand("pane.spawn", {
        workspaceId: background.id, target: "codex", prompt_file: "C:\\child\\spec.md",
      }) as { sessionId: string };
      ids.push(result.sessionId);
    }
    expect(spawnPty.mock.calls.map(([id]) => id)).toEqual(ids);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "create_session")).toHaveLength(5);
    expect(mocks.xtermMount).not.toHaveBeenCalled();

    // Exercise the real TerminalPane props; substitute only xterm's renderer
    // and use the real IPC adapter for the channel-attach operation it issues.
    const attachments: Promise<void>[] = [];
    mocks.xtermMount.mockImplementation((props: {
      sessionId: string; command: string; args: string[]; cwd?: string; launchEnv?: Record<string, string>;
    }) => {
      attachments.push(createSession(
        props.sessionId, props.command, props.args, 80, 24, () => {}, props.cwd, props.launchEnv,
      ));
    });
    await renderPanes(useWorkspaceListStore.getState().getWorkspace(background.id)!);
    await Promise.all(attachments);
    expect(mocks.xtermMount).toHaveBeenCalledTimes(6);
    expect(mocks.xtermMount.mock.calls.map(([props]) => props.sessionId)).toEqual([parent.sessionId, ...ids]);
    expect(spawnPty).toHaveBeenCalledTimes(5);
    for (const id of ids) {
      expect(mocks.invoke.mock.calls.filter(([command, args]) =>
        command === "create_session" && args.sessionId === id,
      )).toHaveLength(2); // initial headless startup + later channel attachment
    }
    mocks.xtermMount.mockReset();
  });
});
