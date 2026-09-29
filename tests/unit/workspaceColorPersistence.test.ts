import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { toConfig } from "../../src/components/layout/SocketListener";
import { WORKSPACE_COLORS } from "../../src/lib/workspaceColors";
import type { Pane, PaneTab, Workspace } from "../../src/types";

const BLUE = WORKSPACE_COLORS[0].value;
const PINK = WORKSPACE_COLORS[6].value;

function tab(): PaneTab {
  return { id: "tab-1", sessionId: "terminal-1", agentId: "claude-code", type: "terminal" };
}

function pane(): Pane {
  const item = tab();
  return {
    id: "pane-1",
    agentId: item.agentId,
    sessionId: item.sessionId,
    tabs: [item],
    activeTabId: item.id,
  };
}

function workspace(color?: string): Workspace {
  return {
    id: "workspace",
    name: "Workspace",
    gridTemplateId: "1x1",
    status: "running",
    createdAt: 1,
    color,
    panes: [pane()],
    splitColumns: [["pane-1"]],
  };
}

beforeEach(() => {
  useWorkspaceListStore.setState({
    workspaces: [workspace()],
    activeWorkspaceId: "workspace",
    lastActivePaneByWorkspace: {},
  });
});

describe("setWorkspaceColor", () => {
  it("sets a palette color on the targeted workspace only", () => {
    useWorkspaceListStore.setState({
      workspaces: [workspace(), { ...workspace(), id: "other" }],
      activeWorkspaceId: "workspace",
      lastActivePaneByWorkspace: {},
    });

    useWorkspaceListStore.getState().setWorkspaceColor("workspace", BLUE);

    expect(useWorkspaceListStore.getState().getWorkspace("workspace")?.color).toBe(BLUE);
    expect(useWorkspaceListStore.getState().getWorkspace("other")?.color).toBeUndefined();
  });

  it("replaces an existing color and clears it with undefined", () => {
    const store = useWorkspaceListStore.getState();
    store.setWorkspaceColor("workspace", BLUE);
    store.setWorkspaceColor("workspace", PINK);
    expect(useWorkspaceListStore.getState().getWorkspace("workspace")?.color).toBe(PINK);

    store.setWorkspaceColor("workspace", undefined);
    expect(useWorkspaceListStore.getState().getWorkspace("workspace")?.color).toBeUndefined();
  });

  it("normalizes casing and refuses colors outside the palette", () => {
    const store = useWorkspaceListStore.getState();

    store.setWorkspaceColor("workspace", BLUE.toLowerCase());
    expect(useWorkspaceListStore.getState().getWorkspace("workspace")?.color).toBe(BLUE);

    store.setWorkspaceColor("workspace", "#010203");
    expect(useWorkspaceListStore.getState().getWorkspace("workspace")?.color).toBeUndefined();
  });

  it("leaves the list untouched for an unknown workspace id", () => {
    useWorkspaceListStore.getState().setWorkspaceColor("missing", BLUE);
    expect(useWorkspaceListStore.getState().getWorkspace("workspace")?.color).toBeUndefined();
  });
});

describe("workspace color persistence round trip", () => {
  it("serializes the color into the saved workspace config", () => {
    expect(toConfig(workspace(BLUE)).color).toBe(BLUE);
  });

  it("saves null rather than dropping the key when no color is set", () => {
    const saved = toConfig(workspace());
    expect(saved.color).toBeNull();
    expect("color" in saved).toBe(true);
  });

  it("restores a saved color through the createWorkspace restore path", () => {
    const saved = toConfig(workspace(BLUE));

    useWorkspaceListStore.setState({
      workspaces: [],
      activeWorkspaceId: null,
      lastActivePaneByWorkspace: {},
    });
    useWorkspaceListStore.getState().createWorkspace(
      saved.name,
      saved.grid_template_id as Workspace["gridTemplateId"],
      [pane()],
      [["pane-1"]],
      {
        id: saved.id,
        createdAt: saved.created_at,
        color: saved.color ?? undefined,
        activate: false,
      },
    );

    expect(useWorkspaceListStore.getState().getWorkspace("workspace")?.color).toBe(BLUE);
  });

  it("drops a color that is no longer in the palette while restoring", () => {
    useWorkspaceListStore.setState({
      workspaces: [],
      activeWorkspaceId: null,
      lastActivePaneByWorkspace: {},
    });
    useWorkspaceListStore.getState().createWorkspace(
      "Workspace",
      "1x1",
      [pane()],
      [["pane-1"]],
      { id: "workspace", createdAt: 1, color: "#0F0F0F", activate: false },
    );

    expect(useWorkspaceListStore.getState().getWorkspace("workspace")?.color).toBeUndefined();
  });
});
