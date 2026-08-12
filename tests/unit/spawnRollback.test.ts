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
const secondPaneId = "pane-second";
const originalSessionId = "session-original";
const originalTabId = "tab-original";

function terminalPane(id: string, tabId: string, sessionId: string): Pane {
  const tab: PaneTab = {
    id: tabId,
    sessionId,
    agentId: "shell-starter",
    type: "terminal",
  };
  return {
    id,
    agentId: tab.agentId,
    sessionId: tab.sessionId,
    tabs: [tab],
    activeTabId: tab.id,
  };
}

function workspace(): Workspace {
  return {
    id: workspaceId,
    name: "Workspace",
    gridTemplateId: "2x1",
    status: "running",
    createdAt: 1,
    // A second pane exists so removePaneFromWorkspace is allowed to drop the
    // rolled-back pane (it refuses to remove the last pane in a workspace).
    panes: [
      terminalPane(paneId, originalTabId, originalSessionId),
      terminalPane(secondPaneId, "tab-second", "session-second"),
    ],
    splitColumns: [[paneId], [secondPaneId]],
  };
}

function currentWorkspace(): Workspace {
  return useWorkspaceListStore.getState().workspaces[0];
}

function currentPane(): Pane {
  return currentWorkspace().panes[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceListStore.setState({
    workspaces: [workspace()],
    activeWorkspaceId: workspaceId,
    lastActivePaneByWorkspace: {},
  });
  useUiStore.setState({ activePaneId: originalSessionId, focusRevision: 0 });
});

describe("pane.spawn_tab rollback", () => {
  it("removes the appended tab when the PTY fails to start", async () => {
    ipcMocks.createSession.mockRejectedValueOnce(new Error("pty boom"));

    await expect(handleSocketCommand("pane.spawn_tab", {
      anchorSessionId: originalSessionId,
      commandArgv: ["cmd.exe"],
    })).rejects.toThrow("pty boom");

    // An orphan tab with no PTY would silently start the stale spec the next
    // time somebody clicked it.
    expect(currentPane().tabs).toHaveLength(1);
    expect(currentPane().tabs[0].id).toBe(originalTabId);
    expect(currentPane().activeTabId).toBe(originalTabId);
  });

  it("removes the appended tabs when the new tab cannot be identified", async () => {
    const original = useWorkspaceLayoutStore.getState().addTabToPaneWithOptions;
    // Append two tabs so the post-add diff cannot pick a single new tab.
    useWorkspaceLayoutStore.setState({
      addTabToPaneWithOptions: (wsId, pId, options) => {
        original(wsId, pId, options);
        original(wsId, pId, options);
      },
    });

    try {
      await expect(handleSocketCommand("pane.spawn_tab", {
        anchorSessionId: originalSessionId,
        commandArgv: ["cmd.exe"],
      })).rejects.toThrow("could not identify the new tab");
    } finally {
      useWorkspaceLayoutStore.setState({ addTabToPaneWithOptions: original });
    }

    expect(currentPane().tabs).toHaveLength(1);
    expect(currentPane().tabs[0].id).toBe(originalTabId);
    expect(ipcMocks.createSession).not.toHaveBeenCalled();
  });

  it("keeps the tab when the spawn succeeds", async () => {
    const result = await handleSocketCommand("pane.spawn_tab", {
      anchorSessionId: originalSessionId,
      commandArgv: ["cmd.exe"],
    }) as { tabId: string };

    expect(currentPane().tabs).toHaveLength(2);
    expect(currentPane().tabs[1].id).toBe(result.tabId);
  });
});

describe("pane.spawn rollback", () => {
  it("removes the added panes when the new pane cannot be identified", async () => {
    const original = useWorkspaceLayoutStore.getState().addPaneToWorkspaceWithOptions;
    // Add two panes so the post-add diff cannot pick a single new pane.
    useWorkspaceLayoutStore.setState({
      addPaneToWorkspaceWithOptions: (wsId, afterPaneId, direction, options) => {
        original(wsId, afterPaneId, direction, options);
        original(wsId, afterPaneId, direction, options);
      },
    });

    try {
      await expect(handleSocketCommand("pane.spawn", {
        target: "shell",
        activate: false,
      })).rejects.toThrow("could not identify the new pane");
    } finally {
      useWorkspaceLayoutStore.setState({ addPaneToWorkspaceWithOptions: original });
    }

    expect(currentWorkspace().panes).toHaveLength(2);
    expect(currentWorkspace().panes.map((pane) => pane.id)).toEqual([paneId, secondPaneId]);
  });

  it("keeps the pane when the spawn succeeds", async () => {
    const result = await handleSocketCommand("pane.spawn", {
      target: "shell",
      activate: false,
    }) as { paneId: string };

    expect(currentWorkspace().panes).toHaveLength(3);
    expect(currentWorkspace().panes.some((pane) => pane.id === result.paneId)).toBe(true);
  });
});
