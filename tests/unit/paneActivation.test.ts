import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleSocketCommand,
  type ActivationToken,
} from "../../src/components/layout/socketCommands";
import { focusController } from "../../src/lib/focusController";
import type { Pane, PaneTab, Workspace } from "../../src/types";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";

const ipcMocks = vi.hoisted(() => ({
  getSessionStatusSnapshot: vi.fn(),
}));

vi.mock("../../src/lib/ipc", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/lib/ipc")>(),
  getSessionStatusSnapshot: ipcMocks.getSessionStatusSnapshot,
}));

const workspaceId = "workspace";
const paneId = "pane";
const previousSessionId = "session-previous";
const targetSessionId = "session-target";
const thirdSessionId = "session-third";

const sessionEpochs: Record<string, number | null> = {};
const sessionLifecycles: Record<string, "alive" | "exited" | "orphaned" | "unknown"> = {};
let serverEpoch = "server-epoch";

function terminalTab(id: string, sessionId: string): PaneTab {
  return { id, sessionId, agentId: "shell-starter", type: "terminal" };
}

function makeWorkspace(): Workspace {
  const tabs = [
    terminalTab("tab-previous", previousSessionId),
    terminalTab("tab-target", targetSessionId),
    terminalTab("tab-third", thirdSessionId),
  ];
  const pane: Pane = {
    id: paneId,
    agentId: tabs[0].agentId,
    sessionId: tabs[0].sessionId,
    tabs,
    activeTabId: tabs[0].id,
  };
  return {
    id: workspaceId,
    name: "Workspace",
    gridTemplateId: "1x1",
    panes: [pane],
    status: "running",
    createdAt: 1,
    splitColumns: [[paneId]],
  };
}

function currentPane(): Pane {
  return useWorkspaceListStore.getState().getWorkspace(workspaceId)!.panes[0];
}

function activeTuple() {
  const workspaceState = useWorkspaceListStore.getState();
  const activeWorkspace = workspaceState.getWorkspace(workspaceState.activeWorkspaceId ?? "");
  return {
    activeWorkspaceId: workspaceState.activeWorkspaceId,
    activePaneId: useUiStore.getState().activePaneId,
    panes: activeWorkspace?.panes.map((pane) => ({
      id: pane.id,
      activeTabId: pane.activeTabId,
      sessionId: pane.sessionId,
    })),
    focusRevision: useUiStore.getState().focusRevision,
  };
}

function activateAsHuman(tabId: string, sessionId: string): void {
  useWorkspaceLayoutStore.getState().setActivePaneTab(workspaceId, paneId, tabId);
  focusController.request("tab-click", { sessionId, focus: true });
}

function replacePane(pane: Pane): void {
  useWorkspaceListStore.getState()._updateWorkspacePanes(workspaceId, [pane]);
}

function statusSnapshot() {
  return {
    server_epoch: serverEpoch,
    seq: 1,
    sessions: Object.entries(sessionEpochs).map(([sessionId, sessionEpoch]) => ({
      session_id: sessionId,
      session_revision: 1,
      status: {
        session_epoch: sessionEpoch,
        lifecycle: sessionLifecycles[sessionId] ?? "unknown",
        attention: { attention_id: null, kind: "none", detail: null, state_since: 0 },
        ui_state: "idle",
      },
    })),
  };
}

async function activateTarget(args: Record<string, unknown> = { sessionId: targetSessionId }) {
  return await handleSocketCommand("pane.activate_tab", args) as ActivationToken;
}

async function expectRestoreNoOp(token: ActivationToken, reason: string): Promise<void> {
  const beforeRestore = activeTuple();
  const result = await handleSocketCommand("pane.restore_activation", token);
  expect(result).toEqual({ restored: false, reason });
  expect(activeTuple()).toEqual(beforeRestore);
}

beforeEach(() => {
  serverEpoch = "server-epoch";
  sessionEpochs[previousSessionId] = 101;
  sessionEpochs[targetSessionId] = 102;
  sessionEpochs[thirdSessionId] = 103;
  sessionLifecycles[previousSessionId] = "alive";
  sessionLifecycles[targetSessionId] = "alive";
  sessionLifecycles[thirdSessionId] = "alive";
  ipcMocks.getSessionStatusSnapshot.mockImplementation(async () => statusSnapshot());
  useWorkspaceListStore.setState({
    workspaces: [makeWorkspace()],
    activeWorkspaceId: workspaceId,
    lastActivePaneByWorkspace: {},
  });
  useUiStore.setState({
    activePaneId: previousSessionId,
    lastActivePaneId: previousSessionId,
    focusRevision: 0,
  });
});

describe("pane.activate_tab", () => {
  it.each([
    { sessionId: targetSessionId },
    { session_id: targetSessionId },
  ])("accepts camel or snake session IDs and returns a restorable token", async (args) => {
    const token = await activateTarget(args);

    expect(useUiStore.getState().activePaneId).toBe(targetSessionId);
    expect(currentPane().activeTabId).toBe("tab-target");
    expect(token).toEqual({
      previous_session_id: previousSessionId,
      target_session_id: targetSessionId,
      focus_revision: expect.any(Number),
      previous_session_identity: {
        server_epoch: serverEpoch,
        session_epoch: 101,
        pane_id: paneId,
        tab_id: "tab-previous",
      },
      target_session_identity: {
        server_epoch: serverEpoch,
        session_epoch: 102,
        pane_id: paneId,
        tab_id: "tab-target",
      },
    });
    expect(token.focus_revision).toBeGreaterThan(0);
  });

  it("is idempotent when the target is already active", async () => {
    const token = await handleSocketCommand("pane.activate_tab", {
      sessionId: previousSessionId,
    }) as ActivationToken;

    expect(token.previous_session_id).toBe(previousSessionId);
    expect(token.target_session_id).toBe(previousSessionId);
    expect(token.focus_revision).toBe(0);
    const result = await handleSocketCommand("pane.restore_activation", token) as {
      restored: boolean;
      focus_revision: number;
    };
    expect(result).toEqual({
      restored: true,
      session_id: previousSessionId,
      focus_revision: 0,
    });
  });
});

describe("pane.restore_activation", () => {
  it("restores the previous tab when every condition still matches", async () => {
    const token = await activateTarget();
    const result = await handleSocketCommand("pane.restore_activation", token) as {
      restored: boolean;
      session_id: string;
      focus_revision: number;
    };

    expect(result.restored).toBe(true);
    expect(result.session_id).toBe(previousSessionId);
    expect(result.focus_revision).toBeGreaterThan(token.focus_revision);
    expect(useUiStore.getState().activePaneId).toBe(previousSessionId);
    expect(currentPane().activeTabId).toBe("tab-previous");
  });

  it("does not restore after a human moves away and back", async () => {
    const token = await activateTarget();
    activateAsHuman("tab-third", thirdSessionId);
    activateAsHuman("tab-target", targetSessionId);
    const beforeRestore = activeTuple();

    const result = await handleSocketCommand("pane.restore_activation", token);

    expect(result).toEqual({ restored: false, reason: "focus_revision_changed" });
    expect(activeTuple()).toEqual(beforeRestore);
  });

  it("does not restore when the target is no longer active", async () => {
    const token = await activateTarget();
    activateAsHuman("tab-third", thirdSessionId);
    const revisionBeforeRestore = useUiStore.getState().focusRevision;

    const result = await handleSocketCommand("pane.restore_activation", token);

    expect(result).toEqual({ restored: false, reason: "target_not_active" });
    expect(useUiStore.getState().activePaneId).toBe(thirdSessionId);
    expect(useUiStore.getState().focusRevision).toBe(revisionBeforeRestore);
  });

  it("detects an inactive target even when activePaneId and revision stayed stale", async () => {
    const token = await activateTarget();
    const pane = currentPane();
    const third = pane.tabs.find((tab) => tab.sessionId === thirdSessionId)!;
    useWorkspaceListStore.setState((state) => ({
      workspaces: state.workspaces.map((workspace) => workspace.id === workspaceId
        ? {
            ...workspace,
            panes: workspace.panes.map((candidate) => candidate.id === paneId
              ? { ...candidate, activeTabId: third.id, sessionId: third.sessionId }
              : candidate),
          }
        : workspace),
    }));
    const beforeRestore = activeTuple();

    const result = await handleSocketCommand("pane.restore_activation", token);

    expect(result).toEqual({ restored: false, reason: "target_not_active" });
    expect(activeTuple()).toEqual(beforeRestore);
  });

  it("restores across workspaces and panes", async () => {
    const previousTab = terminalTab("tab-previous", previousSessionId);
    const targetTab = terminalTab("tab-target", targetSessionId);
    const previousPane: Pane = {
      id: "pane-previous",
      agentId: previousTab.agentId,
      sessionId: previousTab.sessionId,
      tabs: [previousTab],
      activeTabId: previousTab.id,
    };
    const targetPane: Pane = {
      id: "pane-target",
      agentId: targetTab.agentId,
      sessionId: targetTab.sessionId,
      tabs: [targetTab],
      activeTabId: targetTab.id,
    };
    const previousWorkspace: Workspace = {
      ...makeWorkspace(),
      id: "workspace-previous",
      panes: [previousPane],
      splitColumns: [[previousPane.id]],
    };
    const targetWorkspace: Workspace = {
      ...makeWorkspace(),
      id: "workspace-target",
      panes: [targetPane],
      splitColumns: [[targetPane.id]],
    };
    useWorkspaceListStore.setState({
      workspaces: [previousWorkspace, targetWorkspace],
      activeWorkspaceId: previousWorkspace.id,
      lastActivePaneByWorkspace: {},
    });
    useUiStore.setState({
      activePaneId: previousSessionId,
      lastActivePaneId: previousSessionId,
      focusRevision: 0,
    });

    const token = await activateTarget();
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe(targetWorkspace.id);

    const result = await handleSocketCommand("pane.restore_activation", token);
    expect(result).toMatchObject({ restored: true, session_id: previousSessionId });
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe(previousWorkspace.id);
    expect(useUiStore.getState().activePaneId).toBe(previousSessionId);
  });

  it("does not restore when the previous tab disappeared", async () => {
    const token = await activateTarget();
    const pane = currentPane();
    replacePane({
      ...pane,
      tabs: pane.tabs.filter((tab) => tab.sessionId !== previousSessionId),
    });
    await expectRestoreNoOp(token, "previous_session_missing");
  });

  it("does not restore when the previous session was replaced in another tab", async () => {
    const token = await activateTarget();
    const pane = currentPane();
    replacePane({
      ...pane,
      tabs: pane.tabs.map((tab) => tab.sessionId === previousSessionId
        ? { ...tab, id: "tab-previous-replacement" }
        : tab),
    });
    await expectRestoreNoOp(token, "previous_session_replaced");
  });

  it("does not restore when the target PTY epoch changed", async () => {
    const token = await activateTarget();
    sessionEpochs[targetSessionId] = 202;
    await expectRestoreNoOp(token, "target_session_replaced");
  });

  it("does not restore when the previous PTY epoch changed", async () => {
    const token = await activateTarget();
    sessionEpochs[previousSessionId] = 201;

    await expectRestoreNoOp(token, "previous_session_replaced");
  });

  it("does not restore across a mycmux server epoch change", async () => {
    const token = await activateTarget();
    serverEpoch = "replacement-server-epoch";

    await expectRestoreNoOp(token, "target_session_replaced");
  });

  it("returns an explicit reason when a session epoch is unavailable", async () => {
    sessionEpochs[previousSessionId] = null;
    const token = await activateTarget();

    await expectRestoreNoOp(token, "previous_session_identity_unavailable");
  });

  it("does not restore a target whose PTY exited with the same epoch", async () => {
    const token = await activateTarget();
    sessionLifecycles[targetSessionId] = "exited";

    await expectRestoreNoOp(token, "target_session_not_alive");
  });

  it("does not restore a previous PTY that exited with the same epoch", async () => {
    const token = await activateTarget();
    sessionLifecycles[previousSessionId] = "exited";

    await expectRestoreNoOp(token, "previous_session_not_alive");
  });

  it("restores to a browser tab using its logical tab identity", async () => {
    const pane = currentPane();
    replacePane({
      ...pane,
      activeTabId: "tab-target",
      sessionId: targetSessionId,
      tabs: pane.tabs.map((tab) => tab.id === "tab-target" ? { ...tab, type: "browser" } : tab),
    });
    sessionEpochs[targetSessionId] = null;
    useUiStore.setState({ focusRevision: 0 });

    const token = await handleSocketCommand("pane.activate_tab", {
      sessionId: thirdSessionId,
    }) as ActivationToken;
    expect(token.previous_session_id).toBe(targetSessionId);
    expect(token.previous_session_identity?.session_epoch).toBeNull();

    const result = await handleSocketCommand("pane.restore_activation", token);
    expect(result).toMatchObject({ restored: true, session_id: targetSessionId });
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe(workspaceId);
    expect(useUiStore.getState().activePaneId).toBe(targetSessionId);
    expect(currentPane().activeTabId).toBe("tab-target");
  });

  it("can activate a browser tab and restore the prior terminal", async () => {
    const pane = currentPane();
    replacePane({
      ...pane,
      tabs: pane.tabs.map((tab) => tab.id === "tab-target" ? { ...tab, type: "browser" } : tab),
    });
    sessionEpochs[targetSessionId] = null;
    useUiStore.setState({ focusRevision: 0 });

    const token = await activateTarget();
    expect(token.target_session_identity.session_epoch).toBeNull();

    const result = await handleSocketCommand("pane.restore_activation", token);
    expect(result).toMatchObject({ restored: true, session_id: previousSessionId });
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe(workspaceId);
    expect(useUiStore.getState().activePaneId).toBe(previousSessionId);
    expect(currentPane().activeTabId).toBe("tab-previous");
  });

  it("waits for a dormant target to publish its new live PTY epoch", async () => {
    sessionLifecycles[targetSessionId] = "exited";
    let snapshots = 0;
    ipcMocks.getSessionStatusSnapshot.mockImplementation(async () => {
      snapshots += 1;
      if (snapshots >= 2) {
        sessionLifecycles[targetSessionId] = "alive";
        sessionEpochs[targetSessionId] = 302;
      }
      return statusSnapshot();
    });

    const token = await activateTarget();

    expect(snapshots).toBeGreaterThanOrEqual(2);
    expect(token.target_session_identity.session_epoch).toBe(302);
  });

  it("keeps the previous identity from before a dormant target wait", async () => {
    sessionLifecycles[targetSessionId] = "exited";
    let snapshots = 0;
    ipcMocks.getSessionStatusSnapshot.mockImplementation(async () => {
      snapshots += 1;
      if (snapshots >= 2) {
        sessionLifecycles[targetSessionId] = "alive";
        sessionEpochs[targetSessionId] = 302;
        sessionEpochs[previousSessionId] = 201;
      }
      return statusSnapshot();
    });

    const token = await activateTarget();

    expect(token.previous_session_identity?.session_epoch).toBe(101);
    await expectRestoreNoOp(token, "previous_session_replaced");
  });

  it("does not move focus when the initial status snapshot fails", async () => {
    ipcMocks.getSessionStatusSnapshot.mockRejectedValueOnce(new Error("snapshot failed"));
    const beforeActivate = activeTuple();

    await expect(activateTarget()).rejects.toThrow("snapshot failed");

    expect(activeTuple()).toEqual(beforeActivate);
  });
});

describe("focus revision coverage", () => {
  it("increments for a human tab activation", () => {
    activateAsHuman("tab-target", targetSessionId);
    expect(useUiStore.getState().focusRevision).toBeGreaterThan(0);
  });

  it("increments for a non-terminal active-tab change without DOM focus", () => {
    const pane = currentPane();
    replacePane({
      ...pane,
      tabs: pane.tabs.map((tab) => tab.id === "tab-target" ? { ...tab, type: "browser" } : tab),
    });
    useUiStore.setState({ focusRevision: 0 });

    useWorkspaceLayoutStore.getState().setActivePaneTab(workspaceId, paneId, "tab-target");

    expect(useUiStore.getState().focusRevision).toBeGreaterThan(0);
  });

  it("increments when the active workspace changes", () => {
    const second = makeWorkspace();
    second.id = "workspace-second";
    second.name = "Second";
    second.panes = second.panes.map((pane) => ({
      ...pane,
      id: "pane-second",
      sessionId: "session-second",
      activeTabId: "tab-second",
      tabs: [terminalTab("tab-second", "session-second")],
    }));
    second.splitColumns = [["pane-second"]];
    useWorkspaceListStore.setState((state) => ({ workspaces: [...state.workspaces, second] }));

    useWorkspaceListStore.getState().setActiveWorkspace(second.id);

    expect(useUiStore.getState().focusRevision).toBeGreaterThan(0);
  });

  it("increments when the active session moves to another pane", async () => {
    await activateTarget();
    useUiStore.setState({ focusRevision: 0 });
    const sourcePane = currentPane();
    const targetTab = sourcePane.tabs.find((tab) => tab.sessionId === targetSessionId)!;
    const remainingTabs = sourcePane.tabs.filter((tab) => tab.sessionId !== targetSessionId);
    const fallback = remainingTabs[0];
    const destinationPane: Pane = {
      id: "pane-destination",
      agentId: targetTab.agentId,
      sessionId: targetTab.sessionId,
      tabs: [targetTab],
      activeTabId: targetTab.id,
    };

    useWorkspaceListStore.getState()._updateWorkspacePanes(workspaceId, [
      {
        ...sourcePane,
        sessionId: fallback.sessionId,
        activeTabId: fallback.id,
        tabs: remainingTabs,
      },
      destinationPane,
    ]);

    expect(useUiStore.getState().activePaneId).toBe(targetSessionId);
    expect(useUiStore.getState().focusRevision).toBeGreaterThan(0);
  });
});
