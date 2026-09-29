import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceConfig } from "../../src/lib/ipc";
import { applyLayoutMutation } from "../../src/lib/layoutMutation";
import { persistentLayoutEquals } from "../../src/lib/persistentLayoutProjection";
import { restoreWorkspaceConfigs } from "../../src/lib/workspaceRestore";
import { useUiStore } from "../../src/stores/uiStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Pane, PaneTab, Workspace } from "../../src/types";

const uuidMocks = vi.hoisted(() => ({ v4: vi.fn(() => "pane-new") }));
vi.mock("uuid", () => uuidMocks);

function tab(id: string): PaneTab {
  return { id, sessionId: `session-${id}`, agentId: `agent-${id}`, type: "terminal" };
}

function pane(id: string, tabIds: string[] = [`tab-${id}`]): Pane {
  const tabs = tabIds.map(tab);
  return {
    id,
    agentId: tabs[0].agentId,
    sessionId: tabs[0].sessionId,
    tabs,
    activeTabId: tabs[0].id,
  };
}

function workspace(
  panes: Pane[],
  splitColumns: string[][],
  metrics: Partial<Workspace> = {},
): Workspace {
  return {
    id: "ws",
    name: "ws",
    gridTemplateId: "1x1",
    status: "running",
    createdAt: 1,
    panes,
    splitColumns,
    ...metrics,
  };
}

function seed(target: Workspace): void {
  useWorkspaceListStore.setState({
    workspaces: [target],
    activeWorkspaceId: target.id,
    lastActivePaneByWorkspace: {},
  });
}

function current(): Workspace {
  const found = useWorkspaceListStore.getState().getWorkspace("ws");
  if (!found) throw new Error("workspace disappeared");
  return found;
}

function expectSizes(actual: number[] | undefined, expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((size, index) => expect(actual?.[index]).toBeCloseTo(size, 12));
}

/** Two columns, the divider between them dragged to 70 % of the width. */
function pinnedTwoColumns(): Workspace {
  return workspace([pane("a"), pane("b")], [["a"], ["b"]], {
    columnWidths: [0.7, 0.3],
    rowHeightsPerCol: [[1], [1]],
    columnDividerPins: [true],
    rowDividerPinsPerCol: [[], []],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  uuidMocks.v4.mockReturnValue("pane-new");
  useWorkspaceListStore.setState({
    workspaces: [],
    activeWorkspaceId: null,
    lastActivePaneByWorkspace: {},
  });
  useUiStore.setState({ activePaneId: null, lastActivePaneId: null, zoomedPaneId: null });
});

describe("splitting through the layout store", () => {
  it("splits the source column's own share when a pane is added to its right", () => {
    seed(pinnedTwoColumns());

    useWorkspaceLayoutStore.getState().addPaneToWorkspace("ws", "b", "right");

    const after = current();
    expect(after.splitColumns).toEqual([["a"], ["b"], ["pane-new"]]);
    expectSizes(after.columnWidths, [0.7, 0.15, 0.15]);
    expect(after.columnDividerPins).toEqual([true, false]);
  });

  it("splits the source column's own share when a pane is added to its left", () => {
    seed(pinnedTwoColumns());

    // The drag-and-drop paths carry the same hint for a left drop, which is the
    // case the layout alone cannot work out.
    useWorkspaceLayoutStore.getState().insertRestoredPaneToSplit(
      "ws",
      "b",
      pane("pane-left"),
      "left",
    );

    const after = current();
    expect(after.splitColumns).toEqual([["a"], ["pane-left"], ["b"]]);
    expectSizes(after.columnWidths, [0.7, 0.15, 0.15]);
    expect(after.columnDividerPins).toEqual([true, false]);
  });

  it("splits within a column when a pane is added below the source", () => {
    seed(workspace([pane("a"), pane("b"), pane("c")], [["a", "b", "c"]], {
      columnWidths: [1],
      rowHeightsPerCol: [[0.5, 0.25, 0.25]],
      columnDividerPins: [],
      rowDividerPinsPerCol: [[true, false]],
    }));

    useWorkspaceLayoutStore.getState().addPaneToWorkspace("ws", "c", "down");

    const after = current();
    expect(after.splitColumns).toEqual([["a", "b", "c", "pane-new"]]);
    expectSizes(after.rowHeightsPerCol?.[0], [0.5, 1 / 6, 1 / 6, 1 / 6]);
    expect(after.rowDividerPinsPerCol).toEqual([[true, false, false]]);
  });

  it("splits within a column when a pane is added above the source", () => {
    seed(workspace([pane("a"), pane("b")], [["a", "b"]], {
      columnWidths: [1],
      rowHeightsPerCol: [[0.7, 0.3]],
      columnDividerPins: [],
      rowDividerPinsPerCol: [[true]],
    }));

    useWorkspaceLayoutStore.getState().insertRestoredPaneToSplit("ws", "b", pane("pane-up"), "up");

    const after = current();
    expect(after.splitColumns).toEqual([["a", "pane-up", "b"]]);
    expectSizes(after.rowHeightsPerCol?.[0], [0.7, 0.15, 0.15]);
    expect(after.rowDividerPinsPerCol).toEqual([[true, false]]);
  });
});

describe("closing through the layout store", () => {
  it("keeps the remembered position when only one side of the closed pane was pinned", () => {
    seed(workspace([pane("a"), pane("b"), pane("c")], [["a"], ["b"], ["c"]], {
      columnWidths: [0.7, 0.15, 0.15],
      rowHeightsPerCol: [[1], [1], [1]],
      columnDividerPins: [true, false],
      rowDividerPinsPerCol: [[], [], []],
    }));

    useWorkspaceLayoutStore.getState().removePaneFromWorkspace("ws", "b");

    const after = current();
    expect(after.splitColumns).toEqual([["a"], ["c"]]);
    expectSizes(after.columnWidths, [0.7, 0.3]);
    expect(after.columnDividerPins).toEqual([true]);
  });

  it("forgets both positions when the closed pane was pinned on both sides", () => {
    seed(workspace([pane("a"), pane("b"), pane("c")], [["a"], ["b"], ["c"]], {
      columnWidths: [0.3, 0.4, 0.3],
      rowHeightsPerCol: [[1], [1], [1]],
      columnDividerPins: [true, true],
      rowDividerPinsPerCol: [[], [], []],
    }));

    useWorkspaceLayoutStore.getState().removePaneFromWorkspace("ws", "b");

    const after = current();
    expectSizes(after.columnWidths, [0.5, 0.5]);
    expect(after.columnDividerPins).toEqual([false]);
  });

  it("balances a workspace saved before divider pins existed on its next split", () => {
    seed(workspace([pane("a"), pane("b")], [["a"], ["b"]], {
      columnWidths: [2, 5],
      rowHeightsPerCol: [[1], [1]],
    }));

    useWorkspaceLayoutStore.getState().addPaneToWorkspace("ws", "b", "right");

    const after = current();
    expectSizes(after.columnWidths, [1 / 3, 1 / 3, 1 / 3]);
    expect(after.columnDividerPins).toEqual([false, false]);
  });
});

describe("applyLayoutMutation", () => {
  /** A ‖ B ‖ C with the A|B divider dragged to 70 % of the width. */
  const dragged = (): Workspace[] => [
    workspace([pane("a"), pane("b"), pane("c")], [["a"], ["b"], ["c"]], {
      columnWidths: [0.7, 0.15, 0.15],
      rowHeightsPerCol: [[1], [1], [1]],
      columnDividerPins: [true, false],
      rowDividerPinsPerCol: [[], [], []],
    }),
  ];

  it("cuts a left-zone drop out of the pane it was dropped against", () => {
    const { workspaces } = applyLayoutMutation(dragged(), {
      kind: "move-tabs",
      operationId: "op",
      tabIds: ["tab-c"],
      anchorTabId: "tab-c",
      to: { workspaceId: "ws", split: { paneId: "b", zone: "left" } },
      sourceLayoutRevision: 0,
    }, 0);

    const after = workspaces[0];
    expect(after.splitColumns).toEqual([["a"], ["pane-op"], ["b"]]);
    expectSizes(after.columnWidths, [0.7, 0.15, 0.15]);
    expect(after.columnDividerPins).toEqual([true, false]);
  });

  it("keeps the dragged divider when a right-zone drop splits the other column", () => {
    const { workspaces } = applyLayoutMutation(dragged(), {
      kind: "move-tabs",
      operationId: "op",
      tabIds: ["tab-c"],
      anchorTabId: "tab-c",
      to: { workspaceId: "ws", split: { paneId: "b", zone: "right" } },
      sourceLayoutRevision: 0,
    }, 0);

    const after = workspaces[0];
    expect(after.splitColumns).toEqual([["a"], ["b"], ["pane-op"]]);
    expectSizes(after.columnWidths, [0.7, 0.15, 0.15]);
    expect(after.columnDividerPins).toEqual([true, false]);
  });

  it("guesses the neighbour before a drop that names no source pane", () => {
    const { workspaces } = applyLayoutMutation(dragged(), {
      kind: "move-tabs",
      operationId: "op",
      tabIds: ["tab-c"],
      anchorTabId: "tab-c",
      to: { workspaceId: "ws", newPane: { column: 2, row: 0 } },
      sourceLayoutRevision: 0,
    }, 0);

    const after = workspaces[0];
    expect(after.splitColumns).toEqual([["a"], ["b"], ["pane-op"]]);
    expectSizes(after.columnWidths, [0.7, 0.15, 0.15]);
    expect(after.columnDividerPins).toEqual([true, false]);
  });
});

describe("setWorkspaceLayoutMetrics", () => {
  it("stores sizes and pins that describe the current columns", () => {
    seed(pinnedTwoColumns());

    useWorkspaceListStore.getState().setWorkspaceLayoutMetrics(
      "ws",
      [0.4, 0.6],
      [[1], [1]],
      [true],
      [[], []],
    );

    const after = current();
    expect(after.columnWidths).toEqual([0.4, 0.6]);
    expect(after.columnDividerPins).toEqual([true]);
  });

  it("rejects a pin list that does not match the number of dividers", () => {
    seed(pinnedTwoColumns());

    useWorkspaceListStore.getState().setWorkspaceLayoutMetrics(
      "ws",
      [0.4, 0.6],
      [[1], [1]],
      [true, false],
      [[], []],
    );

    const after = current();
    expect(after.columnWidths).toEqual([0.4, 0.6]);
    expect(after.columnDividerPins).toBeUndefined();
  });

  it("drops the pins along with sizes the columns cannot accept", () => {
    seed(pinnedTwoColumns());

    useWorkspaceListStore.getState().setWorkspaceLayoutMetrics(
      "ws",
      [0.4],
      [[1], [1]],
      [true],
      [[], []],
    );

    const after = current();
    expect(after.columnWidths).toBeUndefined();
    expect(after.columnDividerPins).toBeUndefined();
  });

  it("counts a pin-only change as a layout change", () => {
    seed(pinnedTwoColumns());
    const before = useWorkspaceListStore.getState().layoutRevision;

    useWorkspaceListStore.getState().setWorkspaceLayoutMetrics(
      "ws",
      [0.7, 0.3],
      [[1], [1]],
      [false],
      [[], []],
    );

    expect(current().columnDividerPins).toEqual([false]);
    expect(useWorkspaceListStore.getState().layoutRevision).toBe(before + 1);
  });
});

describe("restoring a saved workspace", () => {
  const savedConfig = (
    overrides: Partial<WorkspaceConfig> = {},
  ): WorkspaceConfig => ({
    id: "restored",
    name: "Restored",
    grid_template_id: "2x1",
    created_at: 1,
    panes: [
      { pane_id: "a", agent_id: "shell-starter", label: null, tabs: [
        { tab_id: "tab-a", session_id: "pty-a", agent_id: "shell-starter", type: "terminal" },
      ] },
      { pane_id: "b", agent_id: "shell-starter", label: null, tabs: [
        { tab_id: "tab-b", session_id: "pty-b", agent_id: "shell-starter", type: "terminal" },
      ] },
    ],
    split_columns: [[0], [1]],
    column_widths: [0.7, 0.3],
    row_heights_per_col: [[1], [1]],
    column_divider_pins: [true],
    row_divider_pins_per_col: [[], []],
    ...overrides,
  });

  function restored(config: WorkspaceConfig): Workspace {
    restoreWorkspaceConfigs([config]);
    const found = useWorkspaceListStore.getState().getWorkspace(config.id);
    if (!found) throw new Error("workspace was not restored");
    return found;
  }

  it("brings the dragged dividers back with the widths", () => {
    const workspaceState = restored(savedConfig());

    expect(workspaceState.columnWidths).toEqual([0.7, 0.3]);
    expect(workspaceState.columnDividerPins).toEqual([true]);
    expect(workspaceState.rowDividerPinsPerCol).toEqual([[], []]);
  });

  it("ignores a saved pin list that no longer fits the columns", () => {
    const workspaceState = restored(savedConfig({ column_divider_pins: [true, false] }));

    expect(workspaceState.columnWidths).toEqual([0.7, 0.3]);
    expect(workspaceState.columnDividerPins).toBeUndefined();
  });

  it("reads a workspace saved before divider pins existed", () => {
    const workspaceState = restored(savedConfig({
      column_divider_pins: undefined,
      row_divider_pins_per_col: undefined,
    }));

    expect(workspaceState.columnWidths).toEqual([0.7, 0.3]);
    expect(workspaceState.columnDividerPins).toBeUndefined();
    expect(workspaceState.rowDividerPinsPerCol).toBeUndefined();
  });
});

describe("persistent layout projection", () => {
  it("treats a change of divider pins alone as a difference", () => {
    const before = pinnedTwoColumns();
    const after = { ...before, columnDividerPins: [false] };

    expect(persistentLayoutEquals([before], [before])).toBe(true);
    expect(persistentLayoutEquals([before], [after])).toBe(false);
  });
});
