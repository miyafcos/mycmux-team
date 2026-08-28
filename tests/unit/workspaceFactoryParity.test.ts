import { beforeEach, describe, expect, it } from "vitest";

import {
  createDeterministicGroupingAllocator,
  createGroupingEngine,
  type GroupingCompileContext,
} from "./helpers/groupingTestEntrypoint";
import { defaultLayoutForTabs, type GroupingPlan } from "../../src/components/layout/tabGrouping";
import { WORKSPACE_COLORS } from "../../src/lib/workspaceColors";
import {
  buildWorkspaceRecord,
  normalizeWorkspaceLayout,
} from "../../src/stores/workspaceFactory";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Pane, PaneTab, Workspace } from "../../src/types";

const NOW = 1_800_000_000_000;
const BLUE = WORKSPACE_COLORS[0].value;

function tab(id: string, overrides: Partial<PaneTab> = {}): PaneTab {
  return {
    id,
    sessionId: `session-${id}`,
    agentId: "shell-starter",
    type: "terminal",
    label: `label-${id}`,
    cwd: `C:/work/${id}`,
    ...overrides,
  };
}

function pane(id: string, tabs: PaneTab[]): Pane {
  const active = tabs[0];
  return {
    id,
    agentId: active?.agentId ?? "",
    sessionId: active?.sessionId ?? "",
    activeTabId: active?.id ?? "",
    tabs,
    label: `pane-${id}`,
  };
}

function seedWorkspace(): Workspace {
  return {
    id: "ws-a",
    name: "母艦",
    gridTemplateId: "1x1",
    status: "running",
    createdAt: NOW,
    pet: "clawd",
    panes: [pane("pane-a", [tab("t1"), tab("t2")])],
    splitColumns: [["pane-a"]],
    columnWidths: [1],
    rowHeightsPerCol: [[1]],
  };
}

function groupingPlan(): GroupingPlan {
  return {
    planId: "plan-a",
    title: "案件で分ける",
    rationale: "parity",
    strategy: "project",
    groups: [
      {
        groupId: "group-a",
        title: "案件甲",
        disposition: "reorganize",
        destination: { kind: "new_workspace", proposedName: "案件甲" },
        layout: defaultLayoutForTabs(["t1"], "案件甲"),
        tabIds: ["t1"],
        adopted: true,
      },
      {
        groupId: "group-keep",
        title: "現状維持",
        disposition: "keep",
        destination: { kind: "current_locations" },
        layout: null,
        tabIds: ["t2"],
        adopted: true,
      },
    ],
    unassignedTabIds: [],
    warnings: [],
  };
}

function contextFor(workspaces: readonly Workspace[]): GroupingCompileContext {
  return {
    baseline: workspaces.flatMap((item) => item.panes.flatMap((itemPane) => (
      itemPane.tabs.map((itemTab) => ({
        tabId: itemTab.id,
        workspaceId: item.id,
        paneId: itemPane.id,
        sessionId: itemTab.sessionId,
      }))
    ))),
    activeWorkspaceId: "ws-a",
    activeSessionId: "session-t2",
    allocationSeed: "seed-parity",
    createdAt: NOW,
    newWorkspaceDefaults: { status: "running", pet: "clawd", color: BLUE },
  };
}

function resetListStore(): void {
  useWorkspaceListStore.setState({
    workspaces: [],
    activeWorkspaceId: null,
    lastActivePaneByWorkspace: {},
    layoutRevision: 0,
  });
}

beforeEach(() => {
  resetListStore();
});

describe("workspace factory parity", () => {
  it("matches createWorkspace and grouping compiler records field-for-field", () => {
    const current = [seedWorkspace()];
    const plan = groupingPlan();
    const context = contextFor(current);
    const compiled = createGroupingEngine().compileGroupingPlan(plan, current, context);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error(compiled.errors.join(" / "));

    const newId = compiled.transaction.expected.newWorkspaceIds[0];
    const compiledRecord = compiled.transaction.workspaces.find((item) => item.id === newId);
    expect(compiledRecord).toBeDefined();
    if (!compiledRecord) return;

    const created = useWorkspaceListStore.getState().createWorkspace(
      compiledRecord.name,
      compiledRecord.gridTemplateId,
      structuredClone(compiledRecord.panes),
      structuredClone(compiledRecord.splitColumns ?? []),
      {
        id: compiledRecord.id,
        createdAt: compiledRecord.createdAt,
        color: compiledRecord.color,
        pet: compiledRecord.pet,
        columnWidths: compiledRecord.columnWidths,
        rowHeightsPerCol: compiledRecord.rowHeightsPerCol,
        activate: false,
      },
    );

    const factoryRecord = buildWorkspaceRecord({
      id: compiledRecord.id,
      name: compiledRecord.name,
      gridTemplateId: compiledRecord.gridTemplateId,
      panes: structuredClone(compiledRecord.panes),
      splitColumns: structuredClone(compiledRecord.splitColumns ?? []),
      status: compiledRecord.status,
      createdAt: compiledRecord.createdAt,
      color: compiledRecord.color,
      pet: compiledRecord.pet,
      columnWidths: compiledRecord.columnWidths,
      rowHeightsPerCol: compiledRecord.rowHeightsPerCol,
    });

    expect(created).toEqual(compiledRecord);
    expect(factoryRecord).toEqual(compiledRecord);
    expect(useWorkspaceListStore.getState().workspaces.map((item) => item.id)).toEqual([created.id]);
  });

  it("normalizes broken splitColumns, mismatched metrics, and unknown colors the same way", () => {
    const panes = [pane("pane-a", [tab("t1")])];
    const brokenSplit = [["ghost"], ["pane-a", "pane-a"], []];
    const mismatchedWidths = [1, 2, 3];
    const mismatchedRows = [[1, 2], [3]];
    const unknownColor = "#010203";
    const input = {
      id: "ws-norm",
      name: "正規化",
      gridTemplateId: "1x1" as const,
      panes,
      splitColumns: brokenSplit,
      status: "running" as const,
      createdAt: NOW,
      color: unknownColor,
      pet: "clawd",
      columnWidths: mismatchedWidths,
      rowHeightsPerCol: mismatchedRows,
    };

    const factoryRecord = buildWorkspaceRecord(input);
    const created = useWorkspaceListStore.getState().createWorkspace(
      input.name,
      input.gridTemplateId,
      structuredClone(panes),
      structuredClone(brokenSplit),
      {
        id: input.id,
        createdAt: input.createdAt,
        color: unknownColor,
        pet: input.pet,
        columnWidths: mismatchedWidths,
        rowHeightsPerCol: mismatchedRows,
        activate: false,
      },
    );

    expect(factoryRecord.splitColumns).toEqual([["pane-a"]]);
    expect(factoryRecord.columnWidths).toBeUndefined();
    expect(factoryRecord.rowHeightsPerCol).toBeUndefined();
    expect(factoryRecord.color).toBeUndefined();
    expect(created).toEqual(factoryRecord);

    const allocator = createDeterministicGroupingAllocator("seed-abnormal", "plan-abnormal");
    const current = [seedWorkspace()];
    const plan = groupingPlan();
    plan.planId = "plan-abnormal";
    const context = contextFor(current);
    context.allocationSeed = "seed-abnormal";
    context.newWorkspaceDefaults = { status: "running", pet: "clawd", color: unknownColor };
    const compiled = createGroupingEngine().compileGroupingPlan(plan, current, context);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const compiledId = allocator.workspaceId("group-a");
    const compiledRecord = compiled.transaction.workspaces.find((item) => item.id === compiledId);
    expect(compiledRecord?.color).toBeUndefined();
  });

  it("does not mutate caller arrays", () => {
    const panes = [pane("pane-a", [tab("t1")])];
    const splitColumns = [["ghost", "pane-a"], []];
    const columnWidths = [8, 9];
    const rowHeightsPerCol = [[3], [4, 5]];
    const panesSnapshot = structuredClone(panes);
    const splitSnapshot = structuredClone(splitColumns);
    const widthsSnapshot = [...columnWidths];
    const rowsSnapshot = structuredClone(rowHeightsPerCol);

    buildWorkspaceRecord({
      id: "ws-immutable",
      name: "非破壊",
      gridTemplateId: "1x1",
      panes,
      splitColumns,
      status: "running",
      createdAt: NOW,
      columnWidths,
      rowHeightsPerCol,
    });
    useWorkspaceListStore.getState().createWorkspace(
      "非破壊",
      "1x1",
      panes,
      splitColumns,
      {
        id: "ws-immutable-store",
        createdAt: NOW,
        pet: "clawd",
        columnWidths,
        rowHeightsPerCol,
        activate: false,
      },
    );
    normalizeWorkspaceLayout({
      id: "ws-immutable-norm",
      name: "非破壊",
      gridTemplateId: "1x1",
      status: "running",
      createdAt: NOW,
      panes,
      splitColumns,
      columnWidths,
      rowHeightsPerCol,
    });

    expect(panes).toEqual(panesSnapshot);
    expect(splitColumns).toEqual(splitSnapshot);
    expect(columnWidths).toEqual(widthsSnapshot);
    expect(rowHeightsPerCol).toEqual(rowsSnapshot);
  });

  it("is deterministic for the same fully resolved input", () => {
    const input = {
      id: "ws-det",
      name: "決定性",
      gridTemplateId: "1x1" as const,
      panes: [pane("pane-a", [tab("t1")])],
      splitColumns: [["pane-a"]],
      status: "running" as const,
      createdAt: NOW,
      color: BLUE,
      pet: "clawd",
      columnWidths: [1],
      rowHeightsPerCol: [[1]],
    };

    expect(buildWorkspaceRecord(input)).toEqual(buildWorkspaceRecord(input));
    expect(normalizeWorkspaceLayout(buildWorkspaceRecord(input)))
      .toEqual(buildWorkspaceRecord(input));
  });
});
