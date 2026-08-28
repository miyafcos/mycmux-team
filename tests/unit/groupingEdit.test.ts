import { describe, expect, it } from "vitest";

import {
  applyEditCommand,
  beginGroupingEdit,
  canUndoGroupingEdit,
  isGroupingEditDirty,
  paneRefKey,
  parsePaneRefKey,
  resetGroupingEditToAi,
  undoGroupingEdit,
  uniqueGroupingName,
} from "../../src/components/layout/groupingEdit";
import {
  isJapaneseGroupingName,
  validateEditedPlan,
  type GroupingLayout,
  type GroupingPlan,
} from "../../src/components/layout/tabGrouping";
import { hashCanonical } from "./helpers/groupingTestEntrypoint";

const ALL_TAB_IDS = ["t1", "t2", "t3", "t4"] as const;

function layout(columns: string[][][]): GroupingLayout {
  return {
    columns: columns.map((panes, columnIndex) => ({
      panes: panes.map((tabIds, paneIndex) => ({
        title: `ペイン${columnIndex + 1}${paneIndex + 1}`,
        role: "unspecified",
        tabIds: [...tabIds],
      })),
    })),
  };
}

function planWith(primaryLayout: GroupingLayout = layout([[['t1'], ['t2']], [['t3']]])): GroupingPlan {
  return {
    planId: "plan-edit",
    title: "案件で分ける",
    rationale: "案件単位",
    strategy: "project",
    groups: [
      {
        groupId: "group:a",
        title: "案件甲",
        disposition: "reorganize",
        destination: { kind: "new_workspace", proposedName: "案件甲" },
        layout: primaryLayout,
        tabIds: primaryLayout.columns.flatMap((column) => column.panes.flatMap((pane) => pane.tabIds)),
        adopted: true,
      },
      {
        groupId: "group-b",
        title: "案件乙",
        disposition: "reorganize",
        destination: { kind: "new_workspace", proposedName: "案件乙" },
        layout: layout([[['t4']]]),
        tabIds: ["t4"],
        adopted: true,
      },
    ],
    unassignedTabIds: [],
    warnings: [],
  };
}

function expectValid(plan: GroupingPlan, existingWorkspaceNames: readonly string[] = []): void {
  expect(validateEditedPlan(plan, ALL_TAB_IDS, [], existingWorkspaceNames)).toEqual([]);
}

function countTab(plan: GroupingPlan, tabId: string): number {
  return plan.groups.reduce((count, group) => count + (
    group.adopted && group.disposition === "reorganize" && group.layout
      ? group.layout.columns.flatMap((column) => column.panes).reduce(
        (paneCount, pane) => paneCount + pane.tabIds.filter((id) => id === tabId).length,
        0,
      )
      : group.tabIds.filter((id) => id === tabId).length
  ), 0) + plan.unassignedTabIds.filter((id) => id === tabId).length;
}

describe("grouping edit invariants", () => {
  it("removes the empty source pane and column in the same reassignment", () => {
    const base = planWith(layout([[['t1']], [['t2', 't3']]]));
    const session = applyEditCommand(beginGroupingEdit(base), {
      kind: "reassign_tabs",
      tabIds: ["t1"],
      target: { kind: "pane", groupId: "group:a", columnIndex: 1, paneIndex: 0 },
    });

    expect(session.plan.groups[0].layout?.columns).toHaveLength(1);
    expect(session.plan.groups[0].layout?.columns[0].panes).toHaveLength(1);
    expect(session.plan.groups[0].layout?.columns[0].panes[0].tabIds).toEqual(["t2", "t3", "t1"]);
    expectValid(session.plan);
  });

  it("uses the addressed pane when duplicate pane titles exist", () => {
    const duplicateTitles = layout([[['t1'], ['t2']], [['t3']]]);
    duplicateTitles.columns[0].panes[0].title = "作業";
    duplicateTitles.columns[0].panes[1].title = "作業";
    const session = applyEditCommand(beginGroupingEdit(planWith(duplicateTitles)), {
      kind: "reassign_tabs",
      tabIds: ["t3"],
      target: { kind: "pane", groupId: "group:a", columnIndex: 0, paneIndex: 1 },
    });
    const panes = session.plan.groups[0].layout?.columns[0].panes ?? [];

    expect(panes[0].tabIds).toEqual(["t1"]);
    expect(panes[1].tabIds).toEqual(["t2", "t3"]);
    expect(new Set(panes.map((pane) => pane.title)).size).toBe(panes.length);
    expect(countTab(session.plan, "t3")).toBe(1);
    expectValid(session.plan);
  });

  it("round-trips a pane ref and keeps resolving it after a title change", () => {
    const ref = { groupId: "group:a", columnIndex: 0, paneIndex: 1 } as const;
    expect(parsePaneRefKey(paneRefKey(ref))).toEqual(ref);
    expect(parsePaneRefKey("broken-key")).toBeNull();

    const renamed = applyEditCommand(beginGroupingEdit(planWith()), {
      kind: "rename_pane",
      pane: ref,
      title: "差し替え",
    });
    const moved = applyEditCommand(renamed, {
      kind: "reassign_tabs",
      tabIds: ["t3"],
      target: { kind: "pane", ...ref },
    });
    expect(moved.plan.groups[0].layout?.columns[0].panes[1]).toMatchObject({
      title: "差し替え",
      tabIds: ["t2", "t3"],
    });
    expectValid(moved.plan);
  });

  it("round-trips a pane ref whose group id contains a newline", () => {
    const ref = { groupId: "group\n:a", columnIndex: 2, paneIndex: 3 } as const;
    expect(parsePaneRefKey(paneRefKey(ref))).toEqual(ref);
  });

  it("rejects malformed pane keys and invalid targets atomically", () => {
    expect(parsePaneRefKey(":0:0")).toBeNull();
    expect(parsePaneRefKey("group:-1:0")).toBeNull();
    expect(parsePaneRefKey("group:1.5:0")).toBeNull();
    const session = beginGroupingEdit(planWith());
    expect(applyEditCommand(session, {
      kind: "reassign_tabs",
      tabIds: ["t1"],
      target: { kind: "pane", groupId: "missing", columnIndex: 0, paneIndex: 0 },
    })).toBe(session);
    expect(applyEditCommand(session, {
      kind: "reassign_tabs",
      tabIds: ["t1"],
      target: { kind: "pane", groupId: "group:a", columnIndex: 4, paneIndex: 0 },
    })).toBe(session);
    expect(countTab(session.plan, "t1")).toBe(1);
  });

  it("keeps existing target tabs in place and normalizes duplicate command ids", () => {
    const base = planWith(layout([[['t1', 't2'], ['t3']]]));
    const session = applyEditCommand(beginGroupingEdit(base), {
      kind: "reassign_tabs",
      tabIds: ["t2", "t3", "t3"],
      target: { kind: "pane", groupId: "group:a", columnIndex: 0, paneIndex: 0 },
    });
    expect(session.plan.groups[0].layout?.columns[0].panes[0].tabIds).toEqual(["t1", "t2", "t3"]);
    expect(countTab(session.plan, "t3")).toBe(1);
    expectValid(session.plan);
  });

  it("stashes the original layout and defers a group when its last tabs leave", () => {
    const base = planWith(layout([[['t1']], [['t2', 't3']]]));
    const session = applyEditCommand(beginGroupingEdit(base), {
      kind: "keep_current",
      tabIds: ["t1", "t2", "t3"],
    });
    expect(session.stashedLayouts["group:a"].columns.map((column) => column.panes.length)).toEqual([1, 1]);
    expect(session.plan.groups[0]).toMatchObject({
      adopted: false,
      disposition: "keep",
      destination: { kind: "current_locations" },
      layout: null,
      tabIds: [],
    });
    expect(session.plan.unassignedTabIds).toEqual(["t1", "t2", "t3"]);
    expectValid(session.plan);
  });

  it("restores and consumes a stashed layout when tabs return to an emptied group", () => {
    const base = beginGroupingEdit(planWith());
    const emptied = applyEditCommand(base, {
      kind: "keep_current",
      tabIds: ["t4"],
    });
    expect(emptied.plan.groups[1]).toMatchObject({
      adopted: false,
      disposition: "keep",
      destination: { kind: "current_locations" },
      layout: null,
      tabIds: [],
    });
    expect(emptied.stashedLayouts["group-b"]).toBeDefined();

    const restored = applyEditCommand(emptied, {
      kind: "reassign_tabs",
      tabIds: ["t4"],
      target: { kind: "group", groupId: "group-b" },
    });
    expect(restored.plan.groups[1]).toMatchObject({
      adopted: true,
      disposition: "reorganize",
      destination: { kind: "new_workspace", proposedName: "案件乙" },
      tabIds: ["t4"],
    });
    expect(restored.plan.groups[1].layout?.columns[0]?.panes[0]?.tabIds).toEqual(["t4"]);
    expect(restored.stashedLayouts["group-b"]).toBeUndefined();
    expect(restored.plan.unassignedTabIds).not.toContain("t4");
    expectValid(restored.plan);
  });

  it("stashes and restores a two-column three-pane layout without reviving removed tabs", () => {
    const base = planWith();
    const current = applyEditCommand(beginGroupingEdit(base), {
      kind: "set_group_destination",
      groupId: "group:a",
      destination: { kind: "current_locations" },
    });
    expect(current.stashedLayouts["group:a"].columns.map((column) => column.panes.length)).toEqual([2, 1]);

    const restored = applyEditCommand(current, {
      kind: "set_group_destination",
      groupId: "group:a",
      destination: { kind: "new_workspace", proposedName: "案件甲" },
    });
    expect(restored.plan.groups[0].layout?.columns.map((column) => column.panes.length)).toEqual([2, 1]);
    expect(restored.stashedLayouts["group:a"]).toBeUndefined();
    expectValid(restored.plan);

    const currentAgain = applyEditCommand(restored, {
      kind: "set_group_destination",
      groupId: "group:a",
      destination: { kind: "current_locations" },
    });
    const withoutThird = applyEditCommand(currentAgain, { kind: "keep_current", tabIds: ["t3"] });
    const filtered = applyEditCommand(withoutThird, {
      kind: "set_group_destination",
      groupId: "group:a",
      destination: { kind: "new_workspace", proposedName: "案件甲" },
    });
    expect(filtered.plan.groups[0].layout?.columns.map((column) => column.panes.length)).toEqual([2]);
    expect(filtered.plan.groups[0].tabIds).not.toContain("t3");
    expect(filtered.plan.unassignedTabIds).toContain("t3");
    expectValid(filtered.plan);
  });

  it("keeps one undo generation and preserves it across no-op commands", () => {
    const base = beginGroupingEdit(planWith());
    const first = applyEditCommand(base, { kind: "rename_group", groupId: "group:a", title: "案件甲改" });
    const second = applyEditCommand(first, { kind: "rename_group", groupId: "group:a", title: "案件甲再改" });
    const noOp = applyEditCommand(second, { kind: "reassign_tabs", tabIds: [], target: { kind: "unassigned" } });
    expect(noOp).toBe(second);
    expect(noOp.previous).toBe(second.previous);

    const undone = undoGroupingEdit(noOp);
    expect(undone.plan.groups[0].title).toBe("案件甲改");
    expect(undone.stashedLayouts).toEqual(first.stashedLayouts);
    expect(canUndoGroupingEdit(undone)).toBe(false);
    expect(undoGroupingEdit(undone)).toBe(undone);
    expectValid(undone.plan);
  });

  it("does not mutate source plans and treats same-pane or unknown moves as no-ops", () => {
    const source = planWith();
    const before = hashCanonical(source);
    const session = beginGroupingEdit(source);
    const samePane = applyEditCommand(session, {
      kind: "reassign_tabs",
      tabIds: ["t1"],
      target: { kind: "pane", groupId: "group:a", columnIndex: 0, paneIndex: 0 },
    });
    expect(samePane).toBe(session);
    expect(applyEditCommand(session, {
      kind: "reassign_tabs",
      tabIds: ["unknown"],
      target: { kind: "unassigned" },
    })).toBe(session);
    expect(hashCanonical(source)).toBe(before);
    expect(session.plan).not.toBe(source);
    expect(session.basePlan).not.toBe(source);
  });

  it("resets multiple edits to the AI plan and can undo the reset once", () => {
    const base = beginGroupingEdit(planWith());
    const renamedGroup = applyEditCommand(base, { kind: "rename_group", groupId: "group:a", title: "案件甲改" });
    const edited = applyEditCommand(renamedGroup, {
      kind: "rename_pane",
      pane: { groupId: "group:a", columnIndex: 0, paneIndex: 0 },
      title: "母艦改",
    });
    expect(isGroupingEditDirty(edited)).toBe(true);

    const reset = resetGroupingEditToAi(edited);
    expect(hashCanonical(reset.plan)).toBe(hashCanonical(reset.basePlan));
    expect(reset.stashedLayouts).toEqual({});
    expect(isGroupingEditDirty(reset)).toBe(false);

    const undone = undoGroupingEdit(reset);
    expect(hashCanonical(undone.plan)).toBe(hashCanonical(edited.plan));
    expect(canUndoGroupingEdit(undone)).toBe(false);
  });

  it("numbers created and renamed names while rejecting invalid inputs as no-ops", () => {
    let nextId = 0;
    const options = { idFactory: () => `created-${++nextId}` };
    let session = beginGroupingEdit(planWith());
    for (const tabId of ["t1", "t2", "t3"]) {
      session = applyEditCommand(session, {
        kind: "create_group",
        title: "新しいグループ",
        tabIds: [tabId],
      }, options);
    }
    expect(session.plan.groups.slice(-3).map((group) => group.title)).toEqual([
      "新しいグループ",
      "新しいグループ 2",
      "新しいグループ 3",
    ]);
    expect(session.plan.groups.slice(-3).map((group) => (
      group.destination.kind === "new_workspace" ? group.destination.proposedName : null
    ))).toEqual(["新しいグループ", "新しいグループ 2", "新しいグループ 3"]);
    expectValid(session.plan);

    const withExisting = applyEditCommand(beginGroupingEdit(planWith()), {
      kind: "create_group",
      title: "新しいグループ",
      tabIds: ["t1"],
    }, { existingWorkspaceNames: ["新しいグループ"], idFactory: () => "created-existing" });
    expect(withExisting.plan.groups.at(-1)?.title).toBe("新しいグループ 2");
    expectValid(withExisting.plan, ["新しいグループ"]);

    const clean = beginGroupingEdit(planWith());
    for (const title of ["", "   ", "あ".repeat(21), "案件/甲"]) {
      expect(applyEditCommand(clean, { kind: "rename_group", groupId: "group:a", title })).toBe(clean);
    }

    const twenty = "あ".repeat(20);
    const numbered = uniqueGroupingName(twenty, [twenty]);
    expect([...numbered]).toHaveLength(20);
    expect(numbered.endsWith(" 2")).toBe(true);
    expect(isJapaneseGroupingName(numbered)).toBe(true);
  });

  it("renames workspace and pane names uniquely while same-name edits stay no-ops", () => {
    const base = beginGroupingEdit(planWith());
    expect(applyEditCommand(base, {
      kind: "rename_new_workspace",
      groupId: "group:a",
      proposedName: "案件甲",
    })).toBe(base);
    const workspaceRenamed = applyEditCommand(base, {
      kind: "rename_new_workspace",
      groupId: "group:a",
      proposedName: "案件乙",
    });
    expect(workspaceRenamed.plan.groups[0].destination).toEqual({
      kind: "new_workspace",
      proposedName: "案件乙 2",
    });
    const paneRenamed = applyEditCommand(workspaceRenamed, {
      kind: "rename_pane",
      pane: { groupId: "group:a", columnIndex: 0, paneIndex: 0 },
      title: "ペイン12",
    });
    expect(paneRenamed.plan.groups[0].layout?.columns[0].panes[0].title).toBe("ペイン12 2");
    expectValid(paneRenamed.plan);
  });
});
