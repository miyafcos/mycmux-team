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
import { useSettingsStore } from "../../src/stores/settingsStore";

const ipcMocks = vi.hoisted(() => ({
  getSessionStatusSnapshot: vi.fn(),
}));

vi.mock("../../src/lib/ipc", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/lib/ipc")>(),
  getSessionStatusSnapshot: ipcMocks.getSessionStatusSnapshot,
}));

const visibleWorkspaceId = "workspace-visible";
const visiblePaneId = "pane-visible";
const previousSessionId = "session-previous";
const targetSessionId = "session-target";
const backgroundWorkspaceId = "workspace-background";
const backgroundPaneId = "pane-background";
const backgroundCurrentSessionId = "session-background-current";
const backgroundTargetSessionId = "session-background-target";

function terminalTab(id: string, sessionId: string): PaneTab {
  return { id, sessionId, agentId: "shell-starter", type: "terminal" };
}

function makeWorkspace(
  id: string,
  paneId: string,
  tabs: PaneTab[],
): Workspace {
  const pane: Pane = {
    id: paneId,
    agentId: "shell-starter",
    sessionId: tabs[0].sessionId,
    tabs,
    activeTabId: tabs[0].id,
  };
  return {
    id,
    name: id,
    gridTemplateId: "1x1",
    panes: [pane],
    status: "running",
    createdAt: 1,
    splitColumns: [[paneId]],
  };
}

function visiblePane(): Pane {
  return useWorkspaceListStore.getState().getWorkspace(visibleWorkspaceId)!.panes[0];
}

function backgroundPane(): Pane {
  return useWorkspaceListStore.getState().getWorkspace(backgroundWorkspaceId)!.panes[0];
}

function visibleSelection() {
  const pane = visiblePane();
  return {
    activeWorkspaceId: useWorkspaceListStore.getState().activeWorkspaceId,
    activePaneId: useUiStore.getState().activePaneId,
    activeTabId: pane.activeTabId,
    paneSessionId: pane.sessionId,
    focusRevision: useUiStore.getState().focusRevision,
  };
}

function statusSnapshot() {
  return {
    server_epoch: "server-epoch",
    seq: 1,
    sessions: [
      previousSessionId,
      targetSessionId,
      backgroundCurrentSessionId,
      backgroundTargetSessionId,
    ].map((sessionId, index) => ({
      session_id: sessionId,
      session_revision: 1,
      status: {
        session_epoch: index + 1,
        lifecycle: "alive" as const,
        attention: { attention_id: null, kind: "none", detail: null, state_since: 0 },
        ui_state: "idle",
      },
    })),
  };
}

beforeEach(() => {
  ipcMocks.getSessionStatusSnapshot.mockImplementation(async () => statusSnapshot());
  useWorkspaceListStore.setState({
    workspaces: [
      makeWorkspace(visibleWorkspaceId, visiblePaneId, [
        terminalTab("tab-previous", previousSessionId),
        terminalTab("tab-target", targetSessionId),
      ]),
      makeWorkspace(backgroundWorkspaceId, backgroundPaneId, [
        terminalTab("tab-background-current", backgroundCurrentSessionId),
        terminalTab("tab-background-target", backgroundTargetSessionId),
      ]),
    ],
    activeWorkspaceId: visibleWorkspaceId,
    lastActivePaneByWorkspace: {},
  });
  useUiStore.setState({
    activePaneId: previousSessionId,
    lastActivePaneId: previousSessionId,
    focusRevision: 0,
  });
  useSettingsStore.setState({ declaredLaunchEnabled: false });
});

describe("socket activation", () => {
  it.each([
    { sessionId: targetSessionId },
    { session_id: targetSessionId },
  ])("preserves a visible pane for camel and snake session IDs", async (args) => {
    const before = visibleSelection();

    const token = await handleSocketCommand("pane.activate_tab", args) as ActivationToken;

    expect(visibleSelection()).toEqual(before);
    expect(token).toMatchObject({
      previous_session_id: previousSessionId,
      target_session_id: targetSessionId,
      foreground_changed: false,
      activation_applied: false,
    });
  });

  it("activates a background workspace internally without moving the foreground", async () => {
    const before = visibleSelection();

    const token = await handleSocketCommand("pane.activate_tab", {
      sessionId: backgroundTargetSessionId,
    }) as ActivationToken;

    expect(visibleSelection()).toEqual(before);
    expect(backgroundPane().activeTabId).toBe("tab-background-target");
    expect(backgroundPane().sessionId).toBe(backgroundTargetSessionId);
    expect(token.foreground_changed).toBe(false);
    expect(token.activation_applied).toBe(true);
  });

  it("accepts restore tokens but explicitly leaves the foreground unchanged", async () => {
    const token = await handleSocketCommand("pane.activate_tab", {
      sessionId: backgroundTargetSessionId,
    }) as ActivationToken;
    const before = visibleSelection();

    const result = await handleSocketCommand("pane.restore_activation", token);

    expect(result).toEqual({
      restored: false,
      reason: "foreground_preserved",
      foreground_changed: false,
    });
    expect(visibleSelection()).toEqual(before);
  });

  it.each([
    {},
    { target_session_id: targetSessionId },
    { previous_session_id: null, target_session_id: targetSessionId, focus_revision: 0 },
  ])("rejects malformed restore tokens without changing the foreground: %o", async (token) => {
    const before = visibleSelection();

    await expect(handleSocketCommand("pane.restore_activation", token)).rejects.toThrow();

    expect(visibleSelection()).toEqual(before);
  });

  it("launches a declared sibling without replacing the visible tab", async () => {
    const declared = {
      ...terminalTab("tab-declared", "session-declared"),
      lifecycle: "declared" as const,
      declaredTarget: "codex" as const,
    };
    useWorkspaceListStore.setState((state) => ({
      workspaces: state.workspaces.map((workspace) => workspace.id === visibleWorkspaceId
        ? {
            ...workspace,
            panes: workspace.panes.map((pane) => pane.id === visiblePaneId
              ? { ...pane, tabs: [...pane.tabs, declared] }
              : pane),
          }
        : workspace),
    }));
    useSettingsStore.setState({ declaredLaunchEnabled: true });
    const before = visibleSelection();

    const result = await handleSocketCommand("pane.launch_declared", {
      tabId: declared.id,
      requestId: "visible-declared-launch",
    });

    expect(result).toEqual({
      ok: true,
      tabId: declared.id,
      sessionId: declared.sessionId,
      pending: false,
    });
    expect(visibleSelection()).toEqual(before);
    expect(visiblePane().tabs.find((tab) => tab.id === declared.id)?.lifecycle).not.toBe("declared");
  });

  it("does not let raw workspace.select move the displayed workspace", async () => {
    const result = await handleSocketCommand("workspace.select", {
      workspaceId: backgroundWorkspaceId,
    });

    expect(result).toEqual({
      activeWorkspaceId: visibleWorkspaceId,
      requestedWorkspaceId: backgroundWorkspaceId,
      foregroundChanged: false,
    });
    expect(visibleSelection().activeWorkspaceId).toBe(visibleWorkspaceId);
  });
});

describe("human activation", () => {
  it("keeps the tab-click focus path available to a person", () => {
    useWorkspaceLayoutStore.getState().setActivePaneTab(
      visibleWorkspaceId,
      visiblePaneId,
      "tab-target",
    );
    focusController.request("tab-click", { sessionId: targetSessionId, focus: true });

    expect(visiblePane().activeTabId).toBe("tab-target");
    expect(useUiStore.getState().activePaneId).toBe(targetSessionId);
    expect(useUiStore.getState().focusRevision).toBeGreaterThan(0);
  });
});
