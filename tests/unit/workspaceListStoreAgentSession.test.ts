import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetLiveAgentSessionConflictReporterForTests,
  useWorkspaceListStore,
} from "../../src/stores/workspaceListStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { __resetToastStoreForTests, useToastStore } from "../../src/stores/toastStore";
import type { Pane, PaneTab, Workspace } from "../../src/types";

function tab(id: string, sessionId: string, savedSessionId?: string): PaneTab {
  return {
    id,
    sessionId,
    agentId: "claude-code",
    type: "terminal",
    agentKind: savedSessionId ? "claude" : undefined,
    agentSessionId: savedSessionId,
    claudeSessionId: savedSessionId,
  };
}

function pane(id: string, item: PaneTab): Pane {
  return {
    id,
    agentId: item.agentId,
    sessionId: item.sessionId,
    tabs: [item],
    activeTabId: item.id,
    agentKind: item.agentKind,
    agentSessionId: item.agentSessionId,
    claudeSessionId: item.claudeSessionId,
  };
}

function workspace(ownerSession = "shared-session"): Workspace {
  return {
    id: "workspace",
    name: "Workspace",
    gridTemplateId: "2x1",
    status: "running",
    createdAt: 1,
    panes: [
      pane("pane-owner", tab("tab-owner", "terminal-owner", ownerSession)),
      pane("pane-target", tab("tab-target", "terminal-target")),
    ],
    splitColumns: [["pane-owner", "pane-target"]],
  };
}

beforeEach(() => {
  __resetToastStoreForTests();
  __resetLiveAgentSessionConflictReporterForTests();
  useWorkspaceListStore.setState({
    workspaces: [workspace()],
    activeWorkspaceId: "workspace",
    lastActivePaneByWorkspace: {},
  });
});

describe("setPaneAgentSessionFromMetadata", () => {
  it("rejects a duplicate incoming claim without overwriting either tab", () => {
    const result = useWorkspaceListStore.getState().setPaneAgentSessionFromMetadata(
      "terminal-target",
      { agentKind: "claude", agentSessionId: "shared-session", claudeSessionId: "shared-session" },
    );

    expect(result).toEqual({
      accepted: false,
      applied: false,
      conflict: {
        key: "claude:shared-session",
        ownerSessionId: "terminal-owner",
        incomingSessionId: "terminal-target",
      },
    });
    const panes = useWorkspaceListStore.getState().workspaces[0].panes;
    expect(panes[0].tabs[0].agentSessionId).toBe("shared-session");
    expect(panes[1].tabs[0].agentSessionId).toBeUndefined();
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it("does not overwrite a target's different saved session when rejecting a claim", () => {
    const current = workspace();
    current.panes[1] = pane("pane-target", tab("tab-target", "terminal-target", "target-session"));
    useWorkspaceListStore.setState({ workspaces: [current] });

    const result = useWorkspaceListStore.getState().setPaneAgentSessionFromMetadata(
      "terminal-target",
      { agentKind: "claude", agentSessionId: "shared-session", claudeSessionId: "shared-session" },
    );
    expect(result.applied).toBe(false);
    expect(useWorkspaceListStore.getState().workspaces[0].panes[1].tabs[0].agentSessionId)
      .toBe("target-session");
  });

  it("accepts an idempotent owner claim and the same raw id under another kind", () => {
    const owner = useWorkspaceListStore.getState().setPaneAgentSessionFromMetadata(
      "terminal-owner",
      { agentKind: "claude", agentSessionId: "shared-session", claudeSessionId: "shared-session" },
    );
    expect(owner.applied).toBe(true);

    const differentKind = useWorkspaceListStore.getState().setPaneAgentSessionFromMetadata(
      "terminal-target",
      { agentKind: "codex", agentSessionId: "shared-session" },
    );
    expect(differentKind.applied).toBe(true);
    expect(useWorkspaceListStore.getState().workspaces[0].panes[1].tabs[0].agentKind).toBe("codex");
  });

  it("still allows an explicit clear", () => {
    const result = useWorkspaceListStore.getState().setPaneAgentSessionFromMetadata(
      "terminal-owner",
      null,
    );
    expect(result.applied).toBe(true);
    const owner = useWorkspaceListStore.getState().workspaces[0].panes[0].tabs[0];
    expect(owner.agentKind).toBeUndefined();
    expect(owner.agentSessionId).toBeUndefined();
    expect(owner.claudeSessionId).toBeUndefined();
  });

  it("distinguishes a missing target from a duplicate conflict", () => {
    const result = useWorkspaceListStore.getState().setPaneAgentSessionFromMetadata(
      "missing-terminal",
      { agentKind: "claude", agentSessionId: "new-session", claudeSessionId: "new-session" },
    );
    expect(result).toEqual({ accepted: true, applied: false });
    expect(result.conflict).toBeUndefined();
    expect(useToastStore.getState().toasts).toEqual([]);

    const duplicate = useWorkspaceListStore.getState().setPaneAgentSessionFromMetadata(
      "missing-duplicate-terminal",
      { agentKind: "claude", agentSessionId: "shared-session", claudeSessionId: "shared-session" },
    );
    expect(duplicate.conflict).toEqual({
      key: "claude:shared-session",
      ownerSessionId: "terminal-owner",
      incomingSessionId: "missing-duplicate-terminal",
    });
  });

  it("mirrors the selected tab identity exactly instead of retaining the previous tab", () => {
    const owner = tab("tab-owner", "terminal-owner", "owner-session");
    const parked = tab("tab-parked", "terminal-parked");
    parked.suppressedAgentSessions = [{
      agentKind: "claude",
      agentSessionId: "parked-session",
      claudeSessionId: "parked-session",
    }];
    const mixedPane = pane("pane-mixed", owner);
    mixedPane.tabs = [owner, parked];
    useWorkspaceListStore.setState({
      workspaces: [{
        id: "workspace",
        name: "Workspace",
        gridTemplateId: "1x1",
        status: "running",
        createdAt: 1,
        panes: [mixedPane],
        splitColumns: [["pane-mixed"]],
      }],
    });

    useWorkspaceLayoutStore.getState().setActivePaneTab("workspace", "pane-mixed", "tab-parked");

    const updated = useWorkspaceListStore.getState().workspaces[0].panes[0];
    expect(updated.activeTabId).toBe("tab-parked");
    expect(updated.agentKind).toBeUndefined();
    expect(updated.agentSessionId).toBeUndefined();
    expect(updated.claudeSessionId).toBeUndefined();
    expect(updated.suppressedAgentSessions).toEqual(parked.suppressedAgentSessions);
  });

  it("notifies again when the same live conflict is resolved and later recurs", () => {
    const targetPayload = {
      agentKind: "claude" as const,
      agentSessionId: "shared-session",
      claudeSessionId: "shared-session",
    };
    useWorkspaceListStore.getState().setPaneAgentSessionFromMetadata("terminal-target", targetPayload);
    expect(useToastStore.getState().toasts).toHaveLength(1);

    useWorkspaceListStore.getState().setPaneAgentSessionFromMetadata("terminal-owner", null);
    useWorkspaceListStore.getState().setPaneAgentSessionFromMetadata("terminal-target", targetPayload);
    useWorkspaceListStore.getState().setPaneAgentSessionFromMetadata("terminal-target", null);
    useWorkspaceListStore.getState().setPaneAgentSessionFromMetadata("terminal-owner", targetPayload);
    useWorkspaceListStore.getState().setPaneAgentSessionFromMetadata("terminal-target", targetPayload);

    expect(useToastStore.getState().toasts).toHaveLength(2);
  });
});
