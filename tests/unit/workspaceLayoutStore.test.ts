import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Pane, PaneTab, Workspace } from "../../src/types";

const uuidMocks = vi.hoisted(() => ({
  v4: vi.fn(() => "pane-new"),
}));

vi.mock("uuid", () => uuidMocks);

function tab(id: string): PaneTab {
  return {
    id,
    sessionId: `session-${id}`,
    agentId: `agent-${id}`,
    type: "terminal",
  };
}

function pane(
  id: string,
  tabIds: string[],
  activeTabId = tabIds[tabIds.length - 1],
  pinnedTabId?: string,
): Pane {
  const tabs = tabIds.map(tab);
  const activeTab = tabs.find((candidate) => candidate.id === activeTabId) ?? tabs[0];
  return {
    id,
    agentId: activeTab.agentId,
    sessionId: activeTab.sessionId,
    tabs,
    activeTabId: activeTab.id,
    pinnedTabId,
  };
}

function workspace(id: string, panes: Pane[], splitColumns: string[][]): Workspace {
  return {
    id,
    name: id,
    gridTemplateId: "1x1",
    status: "running",
    createdAt: 1,
    panes,
    splitColumns,
  };
}

function setWorkspaces(workspaces: Workspace[]): void {
  useWorkspaceListStore.setState({
    workspaces,
    activeWorkspaceId: workspaces[0]?.id ?? null,
    lastActivePaneByWorkspace: {},
  });
}

function getWorkspace(id: string): Workspace {
  const found = useWorkspaceListStore.getState().workspaces.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Workspace not found: ${id}`);
  return found;
}

function getPane(workspaceId: string, paneId: string): Pane {
  const found = getWorkspace(workspaceId).panes.find((candidate) => candidate.id === paneId);
  if (!found) throw new Error(`Pane not found: ${workspaceId}/${paneId}`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  uuidMocks.v4.mockReturnValue("pane-new");
  setWorkspaces([]);
  useUiStore.setState({
    activePaneId: null,
    lastActivePaneId: null,
    zoomedPaneId: null,
  });
});

describe("workspaceLayoutStore structural moves", () => {
  it("moves a tab between panes in one workspace", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1", "a2"]), pane("pane-b", ["b1"])], [["pane-a", "pane-b"]]),
    ]);

    useWorkspaceLayoutStore.getState().moveTabToPane("source", "pane-a", "a2", "source", "pane-b");

    expect(getPane("source", "pane-a")).toMatchObject({
      activeTabId: "a1",
      sessionId: "session-a1",
      agentId: "agent-a1",
    });
    expect(getPane("source", "pane-a").tabs.map((candidate) => candidate.id)).toEqual(["a1"]);
    expect(getPane("source", "pane-b")).toMatchObject({
      activeTabId: "a2",
      sessionId: "session-a2",
      agentId: "agent-a2",
    });
    expect(getPane("source", "pane-b").tabs.map((candidate) => candidate.id)).toEqual(["b1", "a2"]);
    expect(getWorkspace("source").splitColumns).toEqual([["pane-a", "pane-b"]]);
  });

  it("moves a single tab across workspaces and removes its empty source pane", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1"]), pane("pane-b", ["b1"])], [["pane-a", "pane-b"]]),
      workspace("target", [pane("pane-c", ["c1"])], [["pane-c"]]),
    ]);

    useWorkspaceLayoutStore.getState().moveTabToPane("source", "pane-a", "a1", "target", "pane-c");

    expect(getWorkspace("source").panes.map((candidate) => candidate.id)).toEqual(["pane-b"]);
    expect(getWorkspace("source").splitColumns).toEqual([["pane-b"]]);
    expect(getPane("target", "pane-c").tabs.map((candidate) => candidate.id)).toEqual(["c1", "a1"]);
    expect(getPane("target", "pane-c")).toMatchObject({
      activeTabId: "a1",
      sessionId: "session-a1",
      agentId: "agent-a1",
    });
    expect(useWorkspaceListStore.getState().workspaces).toHaveLength(2);
  });

  it("moves a tab into a right split in one workspace", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1", "a2"]), pane("pane-b", ["b1"])], [["pane-a", "pane-b"]]),
    ]);

    useWorkspaceLayoutStore.getState().moveTabToSplit("source", "pane-a", "a2", "source", "pane-b", "right");

    expect(getPane("source", "pane-a").tabs.map((candidate) => candidate.id)).toEqual(["a1"]);
    expect(getWorkspace("source").panes.map((candidate) => candidate.id)).toEqual(["pane-a", "pane-b", "pane-new"]);
    expect(getPane("source", "pane-new")).toMatchObject({
      activeTabId: "a2",
      sessionId: "session-a2",
      agentId: "agent-a2",
    });
    expect(getPane("source", "pane-new").tabs.map((candidate) => candidate.id)).toEqual(["a2"]);
    expect(getWorkspace("source").splitColumns).toEqual([["pane-a", "pane-b"], ["pane-new"]]);
  });

  it("moves a single tab across workspaces into a down split", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1"]), pane("pane-b", ["b1"])], [["pane-a", "pane-b"]]),
      workspace("target", [pane("pane-c", ["c1"]), pane("pane-d", ["d1"])], [["pane-c", "pane-d"]]),
    ]);

    useWorkspaceLayoutStore.getState().moveTabToSplit("source", "pane-a", "a1", "target", "pane-c", "down");

    expect(getWorkspace("source").panes.map((candidate) => candidate.id)).toEqual(["pane-b"]);
    expect(getWorkspace("source").splitColumns).toEqual([["pane-b"]]);
    expect(getWorkspace("target").panes.map((candidate) => candidate.id)).toEqual(["pane-c", "pane-d", "pane-new"]);
    expect(getWorkspace("target").splitColumns).toEqual([["pane-c", "pane-new", "pane-d"]]);
    expect(getPane("target", "pane-new")).toMatchObject({
      activeTabId: "a1",
      sessionId: "session-a1",
      agentId: "agent-a1",
    });
  });

  it("merges a pane into another pane in one workspace", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1", "a2"]), pane("pane-b", ["b1"])], [["pane-a", "pane-b"]]),
    ]);

    useWorkspaceLayoutStore.getState().movePaneToPane("source", "pane-a", "source", "pane-b");

    expect(getWorkspace("source").panes.map((candidate) => candidate.id)).toEqual(["pane-b"]);
    expect(getPane("source", "pane-b").tabs.map((candidate) => candidate.id)).toEqual(["b1", "a1", "a2"]);
    expect(getPane("source", "pane-b")).toMatchObject({
      activeTabId: "a2",
      sessionId: "session-a2",
      agentId: "agent-a2",
    });
    expect(getWorkspace("source").splitColumns).toEqual([["pane-b"]]);
  });

  it("merges a pane into a pane in another workspace", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1", "a2"]), pane("pane-b", ["b1"])], [["pane-a", "pane-b"]]),
      workspace("target", [pane("pane-c", ["c1"])], [["pane-c"]]),
    ]);

    useWorkspaceLayoutStore.getState().movePaneToPane("source", "pane-a", "target", "pane-c");

    expect(getWorkspace("source").panes.map((candidate) => candidate.id)).toEqual(["pane-b"]);
    expect(getWorkspace("source").splitColumns).toEqual([["pane-b"]]);
    expect(getPane("target", "pane-c").tabs.map((candidate) => candidate.id)).toEqual(["c1", "a1", "a2"]);
    expect(getPane("target", "pane-c")).toMatchObject({
      activeTabId: "a2",
      sessionId: "session-a2",
      agentId: "agent-a2",
    });
  });

  it("moves a pane above another pane in one workspace", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1"]), pane("pane-b", ["b1"])], [["pane-a"], ["pane-b"]]),
    ]);

    useWorkspaceLayoutStore.getState().movePaneToSplit("source", "pane-a", "source", "pane-b", "up");

    expect(getWorkspace("source").panes.map((candidate) => candidate.id)).toEqual(["pane-a", "pane-b"]);
    expect(getWorkspace("source").splitColumns).toEqual([["pane-a", "pane-b"]]);
    expect(getPane("source", "pane-a").tabs.map((candidate) => candidate.id)).toEqual(["a1"]);
    expect(getPane("source", "pane-b").tabs.map((candidate) => candidate.id)).toEqual(["b1"]);
  });

  it("moves a pane across workspaces into a left split", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1", "a2"]), pane("pane-b", ["b1"])], [["pane-a", "pane-b"]]),
      workspace("target", [pane("pane-c", ["c1"]), pane("pane-d", ["d1"])], [["pane-c", "pane-d"]]),
    ]);

    useWorkspaceLayoutStore.getState().movePaneToSplit("source", "pane-a", "target", "pane-c", "left");

    expect(getWorkspace("source").panes.map((candidate) => candidate.id)).toEqual(["pane-b"]);
    expect(getWorkspace("source").splitColumns).toEqual([["pane-b"]]);
    expect(getWorkspace("target").panes.map((candidate) => candidate.id)).toEqual(["pane-c", "pane-d", "pane-a"]);
    expect(getWorkspace("target").splitColumns).toEqual([["pane-a"], ["pane-c", "pane-d"]]);
    expect(getPane("target", "pane-a")).toMatchObject({
      id: "pane-a",
      activeTabId: "a2",
      sessionId: "session-a2",
      agentId: "agent-a2",
    });
    expect(getPane("target", "pane-a").tabs.map((candidate) => candidate.id)).toEqual(["a1", "a2"]);
  });
});

describe("workspaceLayoutStore pinned tabs", () => {
  it("keeps display ownership when a tab is dropped into a pinned pane (same workspace)", () => {
    setWorkspaces([
      workspace(
        "source",
        [pane("pane-a", ["a1", "a2"]), pane("pane-b", ["b1", "b2"], "b1", "b1")],
        [["pane-a", "pane-b"]],
      ),
    ]);

    useWorkspaceLayoutStore.getState().moveTabToPane("source", "pane-a", "a2", "source", "pane-b");

    expect(getPane("source", "pane-b")).toMatchObject({
      activeTabId: "b1",
      sessionId: "session-b1",
      agentId: "agent-b1",
      pinnedTabId: "b1",
    });
    expect(getPane("source", "pane-b").tabs.map((candidate) => candidate.id)).toEqual(["b1", "b2", "a2"]);
  });

  it("keeps display ownership when a tab is dropped into a pinned pane (cross workspace)", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1", "a2"])], [["pane-a"]]),
      workspace("target", [pane("pane-c", ["c1", "c2"], "c2", "c1")], [["pane-c"]]),
    ]);

    useWorkspaceLayoutStore.getState().moveTabToPane("source", "pane-a", "a2", "target", "pane-c");

    expect(getPane("target", "pane-c")).toMatchObject({
      activeTabId: "c1",
      sessionId: "session-c1",
      agentId: "agent-c1",
      pinnedTabId: "c1",
    });
    expect(getPane("target", "pane-c").tabs.map((candidate) => candidate.id)).toEqual(["c1", "c2", "a2"]);
  });

  it("keeps display ownership when a pane is merged into a pinned pane (same workspace)", () => {
    setWorkspaces([
      workspace(
        "source",
        [pane("pane-a", ["a1", "a2"]), pane("pane-b", ["b1", "b2"], "b2", "b1")],
        [["pane-a", "pane-b"]],
      ),
    ]);

    useWorkspaceLayoutStore.getState().movePaneToPane("source", "pane-a", "source", "pane-b");

    expect(getPane("source", "pane-b")).toMatchObject({
      activeTabId: "b1",
      sessionId: "session-b1",
      agentId: "agent-b1",
      pinnedTabId: "b1",
    });
    expect(getPane("source", "pane-b").tabs.map((candidate) => candidate.id)).toEqual(["b1", "b2", "a1", "a2"]);
  });

  it("keeps display ownership when a pane is merged into a pinned pane (cross workspace)", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1", "a2"]), pane("pane-z", ["z1"])], [["pane-a", "pane-z"]]),
      workspace("target", [pane("pane-c", ["c1", "c2"], "c2", "c1")], [["pane-c"]]),
    ]);

    useWorkspaceLayoutStore.getState().movePaneToPane("source", "pane-a", "target", "pane-c");

    expect(getPane("target", "pane-c")).toMatchObject({
      activeTabId: "c1",
      sessionId: "session-c1",
      agentId: "agent-c1",
      pinnedTabId: "c1",
    });
    expect(getPane("target", "pane-c").tabs.map((candidate) => candidate.id)).toEqual(["c1", "c2", "a1", "a2"]);
  });

  it("still lets the incoming tab win when the target pane has no pin", () => {
    setWorkspaces([
      workspace(
        "source",
        [pane("pane-a", ["a1", "a2"]), pane("pane-b", ["b1", "b2"], "b1")],
        [["pane-a", "pane-b"]],
      ),
    ]);

    useWorkspaceLayoutStore.getState().moveTabToPane("source", "pane-a", "a2", "source", "pane-b");

    expect(getPane("source", "pane-b")).toMatchObject({
      activeTabId: "a2",
      sessionId: "session-a2",
    });
    expect(getPane("source", "pane-b").pinnedTabId).toBeUndefined();
  });

  it("leaves manual tab switching untouched on a pinned pane", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1", "a2", "a3"], "a1", "a1")], [["pane-a"]]),
    ]);

    useWorkspaceLayoutStore.getState().setActivePaneTab("source", "pane-a", "a3");

    expect(getPane("source", "pane-a")).toMatchObject({
      activeTabId: "a3",
      sessionId: "session-a3",
      pinnedTabId: "a1",
    });
  });

  it("toggles a pin without stealing focus and keeps the pinned tab first", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1", "a2", "a3"], "a1")], [["pane-a"]]),
    ]);

    useWorkspaceLayoutStore.getState().togglePaneTabPin("source", "pane-a", "a3");

    expect(getPane("source", "pane-a")).toMatchObject({
      activeTabId: "a1",
      sessionId: "session-a1",
      pinnedTabId: "a3",
    });
    expect(getPane("source", "pane-a").tabs.map((candidate) => candidate.id)).toEqual(["a3", "a1", "a2"]);

    useWorkspaceLayoutStore.getState().togglePaneTabPin("source", "pane-a", "a3");

    expect(getPane("source", "pane-a").pinnedTabId).toBeUndefined();
    expect(getPane("source", "pane-a").activeTabId).toBe("a1");
    expect(getPane("source", "pane-a").tabs.map((candidate) => candidate.id)).toEqual(["a3", "a1", "a2"]);
  });

  it("drops the pin when the pinned tab is closed", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1", "a2"], "a2", "a1")], [["pane-a"]]),
    ]);

    useWorkspaceLayoutStore.getState().removeTabFromPane("source", "pane-a", "a1");

    expect(getPane("source", "pane-a").pinnedTabId).toBeUndefined();
    expect(getPane("source", "pane-a").tabs.map((candidate) => candidate.id)).toEqual(["a2"]);
  });

  it("clears the source pin when the pinned tab is dragged into another pane", () => {
    setWorkspaces([
      workspace(
        "source",
        [pane("pane-a", ["a1", "a2"], "a2", "a1"), pane("pane-b", ["b1"])],
        [["pane-a", "pane-b"]],
      ),
    ]);

    useWorkspaceLayoutStore.getState().moveTabToPane("source", "pane-a", "a1", "source", "pane-b");

    expect(getPane("source", "pane-a").pinnedTabId).toBeUndefined();
    expect(getPane("source", "pane-b").pinnedTabId).toBeUndefined();
    expect(getPane("source", "pane-b")).toMatchObject({ activeTabId: "a1" });
  });

  it("clears the source pin when the pinned tab is dragged into a split", () => {
    setWorkspaces([
      workspace(
        "source",
        [pane("pane-a", ["a1", "a2"], "a2", "a1"), pane("pane-b", ["b1"])],
        [["pane-a", "pane-b"]],
      ),
    ]);

    useWorkspaceLayoutStore.getState().moveTabToSplit("source", "pane-a", "a1", "source", "pane-b", "right");

    expect(getPane("source", "pane-a").pinnedTabId).toBeUndefined();
    expect(getPane("source", "pane-new").pinnedTabId).toBeUndefined();
    expect(getPane("source", "pane-new").tabs.map((candidate) => candidate.id)).toEqual(["a1"]);
  });

  it("clears the source pin when the pinned tab is dragged into a new workspace", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1", "a2"], "a2", "a1")], [["pane-a"]]),
    ]);

    const moved = useWorkspaceLayoutStore.getState().moveTabToNewWorkspace(
      "source",
      "pane-a",
      "a1",
      "workspace-new",
      "Detached",
    );

    expect(moved).toBe(true);
    expect(getPane("source", "pane-a").pinnedTabId).toBeUndefined();
    expect(getPane("workspace-new", "pane-new").pinnedTabId).toBeUndefined();
    expect(getPane("workspace-new", "pane-new").tabs.map((candidate) => candidate.id)).toEqual(["a1"]);
  });

  it("keeps the existing activation behavior when a new-workspace option is omitted", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1", "a2"]), pane("pane-b", ["b1"])], [["pane-a", "pane-b"]]),
    ]);
    useUiStore.setState({ activePaneId: "session-a2", focusRevision: 0 });

    const moved = useWorkspaceLayoutStore.getState().moveTabToNewWorkspace(
      "source",
      "pane-a",
      "a1",
      "workspace-new",
      "Detached",
    );

    expect(moved).toBe(true);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("workspace-new");
    expect(useUiStore.getState().focusRevision).toBe(1);
  });

  it("keeps the active workspace and focus revision when a caller opts out of activation", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1", "a2"]), pane("pane-b", ["b1"])], [["pane-a", "pane-b"]]),
    ]);
    useUiStore.setState({ activePaneId: "session-a2", focusRevision: 0 });

    const moved = useWorkspaceLayoutStore.getState().moveTabToNewWorkspace(
      "source",
      "pane-a",
      "a1",
      "workspace-new",
      "Detached",
      { activate: false },
    );

    expect(moved).toBe(true);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("source");
    expect(useUiStore.getState().focusRevision).toBe(0);
    expect(getWorkspace("workspace-new").splitColumns).toEqual([["pane-new"]]);
  });

  it("also keeps the active workspace and focus revision for a passive pane move", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1"]), pane("pane-b", ["b1"])], [["pane-a", "pane-b"]]),
    ]);
    useUiStore.setState({ activePaneId: "session-b1", focusRevision: 0 });

    const moved = useWorkspaceLayoutStore.getState().movePaneToNewWorkspace(
      "source",
      "pane-a",
      "workspace-new",
      "Detached",
      { activate: false },
    );

    expect(moved).toBe(true);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("source");
    expect(useUiStore.getState().focusRevision).toBe(0);
    expect(getWorkspace("workspace-new").splitColumns).toEqual([["pane-a"]]);
  });

  it("clamps a non-pinned tab out of slot 0", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1", "a2", "a3"], "a2", "a1")], [["pane-a"]]),
    ]);

    useWorkspaceLayoutStore.getState().reorderPaneTab("source", "pane-a", "a3", 0);

    expect(getPane("source", "pane-a").tabs.map((candidate) => candidate.id))
      .toEqual(["a1", "a3", "a2"]);
    expect(getPane("source", "pane-a").pinnedTabId).toBe("a1");
    expect(getPane("source", "pane-a").activeTabId).toBe("a2");
  });

  it("unpins the pinned tab when it is dragged off the head", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1", "a2", "a3"], "a1", "a1")], [["pane-a"]]),
    ]);

    useWorkspaceLayoutStore.getState().reorderPaneTab("source", "pane-a", "a1", 2);

    expect(getPane("source", "pane-a").tabs.map((candidate) => candidate.id))
      .toEqual(["a2", "a1", "a3"]);
    expect(getPane("source", "pane-a").pinnedTabId).toBeUndefined();
    expect(getPane("source", "pane-a").activeTabId).toBe("a1");
  });

  it("keeps the pin when the pinned tab is dropped back on slot 0", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1", "a2", "a3"], "a3", "a1")], [["pane-a"]]),
    ]);

    useWorkspaceLayoutStore.getState().reorderPaneTab("source", "pane-a", "a1", 0);

    expect(getPane("source", "pane-a").tabs.map((candidate) => candidate.id))
      .toEqual(["a1", "a2", "a3"]);
    expect(getPane("source", "pane-a").pinnedTabId).toBe("a1");
  });

  it("restores a persisted pin and sorts it first", () => {
    const { panes } = useWorkspaceLayoutStore.getState().restorePanes(
      "ws-restore",
      [{
        pane_id: "pane-a",
        agent_id: "shell-starter",
        label: null,
        active_tab_id: "t1",
        pinned_tab_id: "t3",
        tabs: [
          { tab_id: "t1", agent_id: "shell-starter" },
          { tab_id: "t2", agent_id: "shell-starter" },
          { tab_id: "t3", agent_id: "shell-starter" },
        ],
      }],
      null,
      "1x1",
    );

    expect(panes[0].pinnedTabId).toBe("t3");
    expect(panes[0].tabs.map((candidate) => candidate.id)).toEqual(["t3", "t1", "t2"]);
    expect(panes[0].activeTabId).toBe("t1");
  });

  it("drops a persisted pin that no longer names a restored tab", () => {
    const { panes } = useWorkspaceLayoutStore.getState().restorePanes(
      "ws-restore",
      [{
        pane_id: "pane-a",
        agent_id: "shell-starter",
        label: null,
        active_tab_id: "t1",
        pinned_tab_id: "gone",
        tabs: [
          { tab_id: "t1", agent_id: "shell-starter" },
          { tab_id: "t2", agent_id: "shell-starter" },
        ],
      }],
      null,
      "1x1",
    );

    expect(panes[0].pinnedTabId).toBeUndefined();
    expect(panes[0].tabs.map((candidate) => candidate.id)).toEqual(["t1", "t2"]);
  });
});

describe("workspaceLayoutStore tab reorder", () => {
  it("moves a tab to the head of the strip", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1", "a2", "a3"], "a2")], [["pane-a"]]),
    ]);

    useWorkspaceLayoutStore.getState().reorderPaneTab("source", "pane-a", "a3", 0);

    expect(getPane("source", "pane-a").tabs.map((candidate) => candidate.id))
      .toEqual(["a3", "a1", "a2"]);
  });

  it("moves a tab to the end of the strip", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1", "a2", "a3"], "a2")], [["pane-a"]]),
    ]);

    useWorkspaceLayoutStore.getState().reorderPaneTab("source", "pane-a", "a1", 3);

    expect(getPane("source", "pane-a").tabs.map((candidate) => candidate.id))
      .toEqual(["a2", "a3", "a1"]);
  });

  it("keeps the displayed tab when the order changes", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1", "a2", "a3"], "a2")], [["pane-a"]]),
    ]);

    useWorkspaceLayoutStore.getState().reorderPaneTab("source", "pane-a", "a3", 1);

    expect(getPane("source", "pane-a")).toMatchObject({
      activeTabId: "a2",
      sessionId: "session-a2",
      agentId: "agent-a2",
    });
    expect(getPane("source", "pane-a").tabs.map((candidate) => candidate.id))
      .toEqual(["a1", "a3", "a2"]);
  });

  it("treats both slots around the dragged tab as a no-op", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1", "a2", "a3"], "a1")], [["pane-a"]]),
    ]);
    const before = getPane("source", "pane-a");

    useWorkspaceLayoutStore.getState().reorderPaneTab("source", "pane-a", "a2", 1);
    useWorkspaceLayoutStore.getState().reorderPaneTab("source", "pane-a", "a2", 2);

    expect(getPane("source", "pane-a")).toBe(before);
  });

  it("clamps an out-of-range slot instead of dropping the tab", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1", "a2", "a3"], "a1")], [["pane-a"]]),
    ]);

    useWorkspaceLayoutStore.getState().reorderPaneTab("source", "pane-a", "a1", 99);
    expect(getPane("source", "pane-a").tabs.map((candidate) => candidate.id))
      .toEqual(["a2", "a3", "a1"]);

    useWorkspaceLayoutStore.getState().reorderPaneTab("source", "pane-a", "a1", -5);
    expect(getPane("source", "pane-a").tabs.map((candidate) => candidate.id))
      .toEqual(["a1", "a2", "a3"]);
  });

  it("ignores unknown panes and tabs", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["a1", "a2"], "a1")], [["pane-a"]]),
    ]);
    const before = getPane("source", "pane-a");

    useWorkspaceLayoutStore.getState().reorderPaneTab("source", "pane-a", "missing", 0);
    useWorkspaceLayoutStore.getState().reorderPaneTab("source", "pane-missing", "a2", 0);
    useWorkspaceLayoutStore.getState().reorderPaneTab("missing", "pane-a", "a2", 0);

    expect(getPane("source", "pane-a")).toBe(before);
  });

  it("round-trips the reordered strip through persistence", () => {
    setWorkspaces([
      workspace("source", [pane("pane-a", ["t1", "t2", "t3"], "t1")], [["pane-a"]]),
    ]);

    useWorkspaceLayoutStore.getState().reorderPaneTab("source", "pane-a", "t3", 0);
    const savedOrder = getPane("source", "pane-a").tabs.map((candidate) => candidate.id);
    expect(savedOrder).toEqual(["t3", "t1", "t2"]);

    // The tabs array *is* the persisted order (SocketListener maps it 1:1 into
    // `tabs: [...]`), so restoring the same sequence must reproduce the strip.
    const { panes } = useWorkspaceLayoutStore.getState().restorePanes(
      "ws-restore",
      [{
        pane_id: "pane-a",
        agent_id: "shell-starter",
        label: null,
        active_tab_id: "t1",
        tabs: savedOrder.map((tabId) => ({ tab_id: tabId, agent_id: "shell-starter" })),
      }],
      null,
      "1x1",
    );

    expect(panes[0].tabs.map((candidate) => candidate.id)).toEqual(savedOrder);
    expect(panes[0].activeTabId).toBe("t1");
  });
});
