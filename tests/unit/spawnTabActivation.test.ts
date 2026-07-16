import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleSocketCommand } from "../../src/components/layout/socketCommands";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Pane, PaneTab, Workspace } from "../../src/types";

const ipcMocks = vi.hoisted(() => ({
  ackFrontendData: vi.fn(() => Promise.resolve()),
  createSession: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/lib/ipc", () => ipcMocks);

const workspaceId = "workspace";
const paneId = "pane";
const originalSessionId = "session-original";
const originalTabId = "tab-original";

function workspace(): Workspace {
  const tab: PaneTab = {
    id: originalTabId,
    sessionId: originalSessionId,
    agentId: "shell-starter",
    type: "terminal",
  };
  const pane: Pane = {
    id: paneId,
    agentId: tab.agentId,
    sessionId: tab.sessionId,
    tabs: [tab],
    activeTabId: tab.id,
  };
  return {
    id: workspaceId,
    name: "Workspace",
    gridTemplateId: "1x1",
    status: "running",
    createdAt: 1,
    panes: [pane],
    splitColumns: [[paneId]],
  };
}

function currentPane(): Pane {
  return useWorkspaceListStore.getState().workspaces[0].panes[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceListStore.setState({
    workspaces: [workspace()],
    activeWorkspaceId: workspaceId,
    lastActivePaneByWorkspace: {},
  });
  useUiStore.setState({ activePaneId: originalSessionId });
});

describe("addTabToPaneWithOptions activation", () => {
  it("appends without changing the active tab when activate is false", () => {
    useWorkspaceLayoutStore.getState().addTabToPaneWithOptions(workspaceId, paneId, {
      commandArgv: ["cmd.exe"],
      activate: false,
    });

    const pane = currentPane();
    expect(pane.tabs).toHaveLength(2);
    expect(pane.activeTabId).toBe(originalTabId);
    expect(pane.sessionId).toBe(originalSessionId);
    expect(useUiStore.getState().activePaneId).toBe(originalSessionId);
  });

  it.each([undefined, true])("activates the appended tab when activate is %s", (activate) => {
    useWorkspaceLayoutStore.getState().addTabToPaneWithOptions(workspaceId, paneId, {
      commandArgv: ["cmd.exe"],
      activate,
    });

    const pane = currentPane();
    const appended = pane.tabs[1];
    expect(pane.activeTabId).toBe(appended.id);
    expect(pane.sessionId).toBe(appended.sessionId);
    expect(useUiStore.getState().activePaneId).toBe(appended.sessionId);
  });
});

describe("pane.spawn_tab activation", () => {
  it("keeps the active tab by default", async () => {
    const result = await handleSocketCommand("pane.spawn_tab", {
      anchorSessionId: originalSessionId,
      commandArgv: ["cmd.exe", "/c", "echo ok"],
      cwd: "C:\\repo",
    }) as { tabId: string; sessionId: string };

    const pane = currentPane();
    expect(pane.tabs).toHaveLength(2);
    expect(pane.activeTabId).toBe(originalTabId);
    expect(useUiStore.getState().activePaneId).toBe(originalSessionId);
    expect(ipcMocks.createSession).toHaveBeenCalledTimes(1);
    const createArgs = ipcMocks.createSession.mock.calls[0];
    expect(createArgs.slice(0, 5)).toEqual([
      result.sessionId,
      "cmd.exe",
      ["/c", "echo ok"],
      80,
      24,
    ]);
    expect(createArgs[6]).toBe("C:\\repo");
    expect(createArgs[7]).toMatchObject({
      MYCMUX_PANE_SESSION_ID: result.sessionId,
      MYCMUX_TAB_ID: result.tabId,
      __CMUX_LAUNCHER_DONE: "1",
    });

    const onData = createArgs[5] as (batch: {
      generation: number;
      seq: number;
      bytes: number;
    }) => void;
    onData({ generation: 2, seq: 3, bytes: 4 });
    expect(ipcMocks.ackFrontendData).toHaveBeenCalledWith(result.sessionId, 2, 3, 4);
  });

  it("switches to the appended tab when activate is true", async () => {
    const result = await handleSocketCommand("pane.spawn_tab", {
      anchorSessionId: originalSessionId,
      commandArgv: ["cmd.exe"],
      activate: true,
    }) as { tabId: string; sessionId: string };

    const pane = currentPane();
    expect(pane.activeTabId).toBe(result.tabId);
    expect(pane.sessionId).toBe(result.sessionId);
    expect(useUiStore.getState().activePaneId).toBe(result.sessionId);
    expect(ipcMocks.createSession).not.toHaveBeenCalled();
  });

  it("starts an agent target through the shell launcher without a renderer", async () => {
    const { getAgent } = await import("../../src/lib/agents");
    await handleSocketCommand("pane.spawn_tab", {
      anchorSessionId: originalSessionId,
      target: "codex",
    });

    const launcher = getAgent("shell-starter");
    const createArgs = ipcMocks.createSession.mock.calls[0];
    expect(createArgs[1]).toBe(launcher?.command);
    expect(createArgs[2]).toEqual(launcher?.args);
    expect(createArgs[7]).toMatchObject({
      MYCMUX_LAUNCH_TARGET: "codex",
      __CMUX_LAUNCHER_DONE: "1",
    });
  });
});
