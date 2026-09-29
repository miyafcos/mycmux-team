import { describe, expect, it } from "vitest";

import {
  createGroupingEngine,
  hashCanonical,
  persistentLayoutProjection,
  type GroupingCompileContext,
} from "./helpers/groupingTestEntrypoint";
import { defaultLayoutForTabs, type GroupingPlan } from "../../src/components/layout/tabGrouping";
import {
  persistentLayoutEquals,
  persistentLayoutSignature,
} from "../../src/lib/persistentLayoutProjection";
import type { Pane, PaneTab, Workspace } from "../../src/types";

const NOW = 1_800_000_000_000;

function tab(id: string): PaneTab {
  return {
    id,
    sessionId: `session-${id}`,
    agentId: "shell-starter",
    type: "terminal",
    label: `label-${id}`,
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
  };
}

function workspace(id: string, name: string, paneId: string, tabIds: string[]): Workspace {
  return {
    id,
    name,
    gridTemplateId: "1x1",
    status: "running",
    createdAt: NOW,
    color: "#4C8DF6",
    pet: "clawd",
    panes: [pane(paneId, tabIds.map((tabId) => tab(tabId)))],
    splitColumns: [[paneId]],
    columnWidths: [1],
    rowHeightsPerCol: [[1]],
  };
}

function plan(): GroupingPlan {
  return {
    planId: "plan-a",
    title: "案件で分ける",
    rationale: "signature",
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
        tabIds: ["t2", "t3"],
        adopted: true,
      },
    ],
    unassignedTabIds: [],
    warnings: [],
  };
}

describe("persistent layout projection signature", () => {
  it("distinguishes an absent object key from an own undefined key", () => {
    expect(hashCanonical({ value: 1 })).not.toBe(hashCanonical({ value: 1, status: undefined }));
  });

  it("distinguishes an empty array from a sparse array with one hole", () => {
    expect(hashCanonical([])).not.toBe(hashCanonical(new Array(1)));
    expect(hashCanonical(new Array(1))).not.toBe(hashCanonical([undefined]));
  });

  it("matches the engine ticket output signature and hashCanonical(projection)", () => {
    const current = [
      workspace("ws-a", "母艦", "pane-a", ["t1", "t2"]),
      workspace("ws-b", "作業机", "pane-b", ["t3"]),
    ];
    const prepared = createGroupingEngine().prepareGroupingCommit(plan(), current, {
      baseline: current.flatMap((item) => item.panes.flatMap((itemPane) => (
        itemPane.tabs.map((itemTab) => ({
          tabId: itemTab.id,
          workspaceId: item.id,
          paneId: itemPane.id,
          sessionId: itemTab.sessionId,
        }))
      ))),
      activeWorkspaceId: "ws-a",
      activeSessionId: "session-t2",
      allocationSeed: "seed-signature",
      createdAt: NOW,
      newWorkspaceDefaults: { status: "running", pet: "clawd" },
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const workspaces = prepared.ticket.transaction.workspaces;
    expect(persistentLayoutSignature(workspaces)).toBe(prepared.ticket.outputSignature);
    expect(persistentLayoutSignature(workspaces)).toBe(
      hashCanonical(persistentLayoutProjection(workspaces)),
    );
  });

  it("treats projection-field edits as inequality and non-projection representation as equality", () => {
    const left = [workspace("ws-a", "母艦", "pane-a", ["t1"])];
    const right = structuredClone(left);
    expect(persistentLayoutEquals(left, right)).toBe(true);

    right[0] = { ...right[0], name: "改名" };
    expect(persistentLayoutEquals(left, right)).toBe(false);

    const missingWidths: Workspace[] = [{ ...left[0], columnWidths: undefined }];
    const emptyWidths: Workspace[] = [{ ...left[0], columnWidths: [] }];
    expect(persistentLayoutEquals(missingWidths, emptyWidths)).toBe(true);

    const renamed = [{ ...left[0], name: "別" }];
    expect(persistentLayoutSignature(left) === persistentLayoutSignature(renamed)).toBe(false);
    expect(persistentLayoutEquals(left, renamed)).toBe(false);
  });

  it("keeps compile input signatures injective when defaults contain undefined", () => {
    const current = [
      workspace("ws-a", "母艦", "pane-a", ["t1", "t2"]),
      workspace("ws-b", "作業机", "pane-b", ["t3"]),
    ];
    const common = {
      baseline: current.flatMap((item) => item.panes.flatMap((itemPane) => (
        itemPane.tabs.map((itemTab) => ({
          tabId: itemTab.id,
          workspaceId: item.id,
          paneId: itemPane.id,
          sessionId: itemTab.sessionId,
        }))
      ))),
      activeWorkspaceId: "ws-a",
      activeSessionId: "session-t2",
      allocationSeed: "seed-undefined-defaults",
      createdAt: NOW,
    } satisfies Omit<GroupingCompileContext, "newWorkspaceDefaults">;
    const engine = createGroupingEngine();
    const withoutUndefined = engine.prepareGroupingCommit(plan(), current, {
      ...common,
      newWorkspaceDefaults: { "group-a": { pet: "hina" } },
    });
    const withUndefined = engine.prepareGroupingCommit(plan(), current, {
      ...common,
      newWorkspaceDefaults: {
        "group-a": { pet: "hina" },
        status: undefined,
      } as unknown as GroupingCompileContext["newWorkspaceDefaults"],
    });

    expect(withoutUndefined.ok).toBe(true);
    expect(withUndefined.ok).toBe(true);
    if (!withoutUndefined.ok || !withUndefined.ok) return;
    expect(withoutUndefined.ticket.inputSignature).not.toBe(withUndefined.ticket.inputSignature);
    expect(withoutUndefined.ticket.outputSignature).toBe(withUndefined.ticket.outputSignature);
  });
});
