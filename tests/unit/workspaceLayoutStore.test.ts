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

function pane(id: string, tabIds: string[], activeTabId = tabIds[tabIds.length - 1]): Pane {
  const tabs = tabIds.map(tab);
  const activeTab = tabs.find((candidate) => candidate.id === activeTabId) ?? tabs[0];
  return {
    id,
    agentId: activeTab.agentId,
    sessionId: activeTab.sessionId,
    tabs,
    activeTabId: activeTab.id,
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
