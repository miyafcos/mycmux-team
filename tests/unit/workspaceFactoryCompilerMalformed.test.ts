import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Pane, PaneTab, Workspace } from "../../src/types";

const probe = vi.hoisted(() => ({
  armed: false,
  expected: null as Workspace | null,
}));

vi.mock("../../src/stores/workspaceFactory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/stores/workspaceFactory")>();
  return {
    ...actual,
    buildWorkspaceRecord: (input: Parameters<typeof actual.buildWorkspaceRecord>[0]) => {
      if (!probe.armed || input.name !== "案件甲") return actual.buildWorkspaceRecord(input);
      probe.armed = false;
      const paneId = input.panes[0]?.id ?? "missing-pane";
      const malformed = {
        ...input,
        splitColumns: [["ghost"], [paneId, paneId], []],
        columnWidths: [1, 2, 3],
        rowHeightsPerCol: [[1, 2], [3]],
        color: "#010203",
      };
      const normalized = actual.buildWorkspaceRecord(malformed);
      probe.expected = structuredClone(normalized);
      return normalized;
    },
  };
});

import {
  createDeterministicGroupingAllocator,
  createGroupingEngine,
  type GroupingCompileContext,
} from "./helpers/groupingTestEntrypoint";
import { defaultLayoutForTabs, type GroupingPlan } from "../../src/components/layout/tabGrouping";

const NOW = 1_800_000_000_000;

function tab(id: string): PaneTab {
  return { id, sessionId: `session-${id}`, agentId: "shell-starter", type: "terminal" };
}

function pane(id: string, tabs: PaneTab[]): Pane {
  return { id, agentId: tabs[0].agentId, sessionId: tabs[0].sessionId, activeTabId: tabs[0].id, tabs };
}

function currentLayout(): Workspace[] {
  return [{
    id: "ws-a",
    name: "mother",
    gridTemplateId: "1x1",
    panes: [pane("pane-a", [tab("t1"), tab("t2")])],
    status: "running",
    createdAt: NOW,
    splitColumns: [["pane-a"]],
    columnWidths: [1],
    rowHeightsPerCol: [[1]],
  }];
}

function plan(): GroupingPlan {
  return {
    planId: "malformed-parity",
    title: "整理案",
    rationale: "工場正規化の一致確認",
    strategy: "project",
    groups: [{
      groupId: "group-a",
      title: "案件甲",
      disposition: "reorganize",
      destination: { kind: "new_workspace", proposedName: "案件甲" },
      layout: defaultLayoutForTabs(["t1"], "案件甲"),
      tabIds: ["t1"],
      adopted: true,
    }, {
      groupId: "keep",
      title: "現状維持",
      disposition: "keep",
      destination: { kind: "current_locations" },
      layout: null,
      tabIds: ["t2"],
      adopted: true,
    }],
    unassignedTabIds: [],
    warnings: [],
  };
}

beforeEach(() => {
  probe.armed = false;
  probe.expected = null;
});

describe("compiler malformed factory parity", () => {
  it("deep-compares the complete normalized compiler record", () => {
    const current = currentLayout();
    const groupingPlan = plan();
    const context: GroupingCompileContext = {
      baseline: current[0].panes[0].tabs.map((item) => ({
        tabId: item.id,
        sessionId: item.sessionId,
        workspaceId: "ws-a",
        paneId: "pane-a",
      })),
      activeWorkspaceId: "ws-a",
      activeSessionId: "session-t1",
      allocationSeed: "malformed-seed",
      createdAt: NOW,
      newWorkspaceDefaults: { status: "running", color: "#010203" },
    };
    probe.armed = true;
    const compiled = createGroupingEngine().compileGroupingPlan(groupingPlan, current, context);
    if (!compiled.ok) throw new Error(compiled.errors.join(" / "));
    expect(compiled.ok).toBe(true);
    const id = createDeterministicGroupingAllocator(context.allocationSeed, groupingPlan.planId)
      .workspaceId("group-a");
    const compiledRecord = compiled.transaction.workspaces.find((workspace) => workspace.id === id);
    expect(compiledRecord).toEqual(probe.expected);
    const splitOnlyMutant = { ...compiledRecord, splitColumns: [["mutant-pane"]] };
    const widthsOnlyMutant = { ...compiledRecord, columnWidths: [999] };
    const rowsOnlyMutant = { ...compiledRecord, rowHeightsPerCol: [[999]] };
    expect(splitOnlyMutant).not.toEqual(probe.expected);
    expect(widthsOnlyMutant).not.toEqual(probe.expected);
    expect(rowsOnlyMutant).not.toEqual(probe.expected);
  });
});
