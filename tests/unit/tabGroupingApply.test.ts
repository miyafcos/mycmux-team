import { describe, expect, it } from "vitest";
import type { Workspace } from "../../src/types";
import {
  classifyStale,
  compileGroupingPlan,
  commitGroupingPlan,
  defaultLayoutForTabs,
  dismissGroupingUndo,
  getGroupingUndoMemory,
  layoutSignature,
  recallGroupingUndo,
  restoreGroupingUndo,
  sessionIdSet,
  setGroupAdopted,
  type AnalysisBaselineEntry,
  type GroupingCommitDependencies,
  type GroupingPlan,
} from "../../src/components/layout/tabGrouping";

const NOW = 1_800_000_000_000;

function tab(id: string, workspaceHint = "a") {
  return {
    id,
    sessionId: `session-${id}`,
    agentId: "shell-starter",
    type: "terminal" as const,
    label: `ラベル${id}`,
    cwd: `C:/work/${workspaceHint}/${id}`,
  };
}

function workspace(id: string, name: string, paneId: string, tabIds: string[]): Workspace {
  const tabs = tabIds.map((tabId) => tab(tabId, id));
  return {
    id,
    name,
    gridTemplateId: "1x1",
    status: "running",
    createdAt: NOW,
    panes: [{
      id: paneId,
      agentId: "shell-starter",
      sessionId: tabs[0]?.sessionId ?? `${paneId}-empty`,
      activeTabId: tabs[0]?.id ?? "",
      tabs,
    }],
    splitColumns: [[paneId]],
  };
}

function baselineOf(workspaces: Workspace[]): AnalysisBaselineEntry[] {
  return workspaces.flatMap((item) => item.panes.flatMap((pane) => pane.tabs.map((tabItem) => ({
    tabId: tabItem.id,
    workspaceId: item.id,
    paneId: pane.id,
    sessionId: tabItem.sessionId,
  }))));
}

function planFor(tabIds: string[], existingId = "ws-a"): GroupingPlan {
  const [first, ...rest] = tabIds;
  return {
    planId: "plan-a",
    title: "案件で分ける",
    rationale: "案件単位",
    strategy: "project",
    groups: [
      {
        groupId: "g-new",
        title: "案件甲",
        disposition: "reorganize",
        destination: { kind: "new_workspace", proposedName: "案件甲" },
        layout: defaultLayoutForTabs([first], "母艦"),
        tabIds: [first],
        adopted: true,
      },
      {
        groupId: "g-keep",
        title: "現状維持",
        disposition: "keep",
        destination: { kind: "current_locations" },
        layout: null,
        tabIds: rest,
        adopted: true,
      },
    ],
    unassignedTabIds: [],
    warnings: [],
  };
}

function memoryStore(initial: Workspace[]): GroupingCommitDependencies & { workspaces: Workspace[]; replaceCount: number } {
  let workspaces = structuredClone(initial) as Workspace[];
  let activeWorkspaceId: string | null = initial[0]?.id ?? null;
  let activeSessionId: string | null = initial[0]?.panes[0]?.sessionId ?? null;
  const lastActivePaneByWorkspace: Record<string, string> = {};
  const listeners = new Set<() => void>();
  let seq = 0;
  const store = {
    workspaces,
    replaceCount: 0,
    getWorkspaces: () => workspaces,
    getActiveWorkspaceId: () => activeWorkspaceId,
    getActiveSessionId: () => activeSessionId,
    getLastActivePaneByWorkspace: () => lastActivePaneByWorkspace,
    restoreSelection: (snapshot: { lastActivePaneByWorkspace: Record<string, string> }) => {
      Object.assign(lastActivePaneByWorkspace, snapshot.lastActivePaneByWorkspace);
    },
    replaceWorkspaces: (next: Workspace[]) => {
      store.replaceCount += 1;
      workspaces = next;
      store.workspaces = next;
      for (const listener of listeners) listener();
    },
    setActiveWorkspace: (id: string) => {
      activeWorkspaceId = id;
    },
    applyActivation: (sessionId: string | null) => {
      activeSessionId = sessionId;
    },
    subscribeLayout: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    now: () => NOW,
    uuid: () => `id-${++seq}`,
    choosePet: () => "clawd",
  };
  return store;
}

describe("compileGroupingPlan", () => {
  it("builds a new workspace, merges into an existing one, and leaves empty workspaces in place", () => {
    const workspaces = [
      workspace("ws-a", "母艦", "pane-a", ["t1", "t2"]),
      workspace("ws-b", "作業机", "pane-b", ["t3"]),
    ];
    const compiled = compileGroupingPlan({
      planId: "plan-a",
      title: "案件で分ける",
      rationale: "",
      strategy: "project",
      groups: [
        {
          groupId: "g-new",
          title: "案件甲",
          disposition: "reorganize",
          destination: { kind: "new_workspace", proposedName: "案件甲" },
          layout: {
            columns: [{ panes: [{ title: "母艦", role: "mother", tabIds: ["t1"] }] }],
          },
          tabIds: ["t1"],
          adopted: true,
        },
        {
          groupId: "g-merge",
          title: "作業机へ",
          disposition: "reorganize",
          destination: { kind: "existing_workspace", workspaceId: "ws-b" },
          layout: {
            columns: [{ panes: [{ title: "作業", role: "worker", tabIds: ["t2"] }] }],
          },
          tabIds: ["t2"],
          adopted: true,
        },
        {
          groupId: "g-keep",
          title: "残す",
          disposition: "keep",
          destination: { kind: "current_locations" },
          layout: null,
          tabIds: ["t3"],
          adopted: true,
        },
      ],
      unassignedTabIds: [],
      warnings: [],
    }, workspaces, {
      baseline: baselineOf(workspaces),
      activeWorkspaceId: "ws-a",
      activeSessionId: "session-t1",
      uuid: (() => {
        let n = 0;
        return () => `new-${++n}`;
      })(),
      now: () => NOW,
      choosePet: () => "clawd",
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.transaction.workspaces.map((item) => item.id)).toEqual(["ws-a", "ws-b", "new-2"]);
    expect(compiled.transaction.workspaces.find((item) => item.id === "new-2")?.name).toBe("案件甲");
    expect(compiled.transaction.expected.tabs.t1.workspaceId).toBe("new-2");
    expect(compiled.transaction.expected.tabs.t2.workspaceId).toBe("ws-b");
    expect(compiled.transaction.expected.tabs.t3.workspaceId).toBe("ws-b");
    expect(compiled.transaction.expected.emptyWorkspaceIds).toEqual(["ws-a"]);
    expect(compiled.transaction.workspaces.some((item) => item.id === "ws-a")).toBe(true);
    expect(compiled.transaction.workspaces.find((item) => item.id === "ws-b")?.splitColumns?.length).toBeGreaterThan(1);

    const emptied = compileGroupingPlan({
      planId: "plan-empty",
      title: "空にする",
      rationale: "",
      strategy: "minimal_move",
      groups: [
        {
          groupId: "g-all",
          title: "全部移す",
          disposition: "reorganize",
          destination: { kind: "new_workspace", proposedName: "新机" },
          layout: defaultLayoutForTabs(["t1", "t2"], "まとめ"),
          tabIds: ["t1", "t2"],
          adopted: true,
        },
      ],
      unassignedTabIds: [],
      warnings: [],
    }, [workspace("ws-a", "母艦", "pane-a", ["t1", "t2"])], {
      baseline: baselineOf([workspace("ws-a", "母艦", "pane-a", ["t1", "t2"])]),
      activeWorkspaceId: "ws-a",
      activeSessionId: "session-t1",
      uuid: (() => {
        let n = 0;
        return () => `empty-${++n}`;
      })(),
      choosePet: () => undefined,
    });
    expect(emptied.ok).toBe(true);
    if (!emptied.ok) return;
    expect(emptied.transaction.expected.emptyWorkspaceIds).toEqual(["ws-a"]);
    expect(emptied.transaction.workspaces.some((item) => item.id === "ws-a")).toBe(true);
  });
});

describe("stale classification", () => {
  it("blocks closed, session-mismatched, moved target tabs and missing destinations", () => {
    const baseline = baselineOf([workspace("ws-a", "母艦", "pane-a", ["t1", "t2"])]);
    const current = [
      workspace("ws-a", "母艦", "pane-a", ["t2"]),
      workspace("ws-b", "別机", "pane-b", ["t1"]),
    ];
    current[1].panes[0].tabs[0].sessionId = "session-t1-replaced";
    const issues = classifyStale(
      baseline,
      current,
      new Set(["t1"]),
      new Set(["missing-ws"]),
    );
    expect(issues.map((issue) => issue.code).sort()).toEqual([
      "session_mismatch",
      "tab_moved",
      "workspace_missing",
    ]);
  });

  it("skips non-target tab movement", () => {
    const before = [workspace("ws-a", "母艦", "pane-a", ["t1", "t2"])];
    const after = [
      workspace("ws-a", "母艦", "pane-a", ["t1"]),
      workspace("ws-b", "別机", "pane-b", ["t2"]),
    ];
    expect(classifyStale(baselineOf(before), after, new Set(["t1"]), new Set())).toEqual([]);
  });
});

describe("commit and undo", () => {
  it("commits atomically, reports empty workspaces without deleting them, and expires undo after a later layout change", () => {
    const initial = [workspace("ws-a", "母艦", "pane-a", ["t1", "t2"])];
    const deps = memoryStore(initial);
    const result = commitGroupingPlan(planFor(["t1", "t2"]), baselineOf(initial), deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.moved.map((item) => item.tabId)).toEqual(["t1"]);
    expect(deps.workspaces.some((item) => item.name === "案件甲")).toBe(true);
    expect(deps.workspaces.some((item) => item.id === "ws-a")).toBe(true);

    const undone = restoreGroupingUndo(deps);
    expect(undone.ok).toBe(true);
    expect(deps.workspaces.map((item) => item.id)).toEqual(["ws-a"]);
    expect(sessionIdSet(deps.workspaces)).toEqual(["session-t1", "session-t2"]);

    const again = commitGroupingPlan(planFor(["t1", "t2"]), baselineOf(deps.workspaces), deps);
    expect(again.ok).toBe(true);
    deps.replaceWorkspaces([
      ...deps.workspaces,
      workspace("ws-manual", "手動", "pane-m", ["t9"]),
    ]);
    const expired = restoreGroupingUndo(deps);
    expect(expired.ok).toBe(false);
  });

  it("does not apply deferred groups", () => {
    const initial = [workspace("ws-a", "母艦", "pane-a", ["t1", "t2"])];
    const deferred = setGroupAdopted(planFor(["t1", "t2"]), "g-new", false);
    const compiled = compileGroupingPlan(deferred, initial, {
      baseline: baselineOf(initial),
      activeWorkspaceId: "ws-a",
      activeSessionId: "session-t1",
      uuid: () => "unused",
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.transaction.expected.movedTabIds).toEqual([]);
    expect(compiled.transaction.workspaces).toHaveLength(1);
  });

  it("rolls back when the committed layout does not match expectedResult", () => {
    const initial = [workspace("ws-a", "母艦", "pane-a", ["t1", "t2"])];
    const deps = memoryStore(initial);
    const originalReplace = deps.replaceWorkspaces;
    let corruptOnce = true;
    deps.replaceWorkspaces = (next) => {
      if (corruptOnce) {
        corruptOnce = false;
        originalReplace(next.map((item) => ({
          ...item,
          panes: item.panes.map((pane) => ({
            ...pane,
            tabs: pane.tabs.filter((tabItem) => tabItem.id !== "t2"),
          })),
        })));
        return;
      }
      originalReplace(next);
    };
    const result = commitGroupingPlan(planFor(["t1", "t2"]), baselineOf(initial), deps);
    expect(result.ok).toBe(false);
    expect(deps.workspaces.map((item) => item.id)).toEqual(["ws-a"]);
    expect(deps.workspaces[0]?.panes[0]?.tabs.map((tabItem) => tabItem.id)).toEqual(["t1", "t2"]);
  });

  it("refuses reorganize+current_locations without deleting any tab", () => {
    const initial = [workspace("ws-a", "母艦", "pane-a", ["t1", "t2"])];
    const plan = planFor(["t1", "t2"]);
    plan.groups[0].destination = { kind: "current_locations" };
    const compiled = compileGroupingPlan(plan, initial, {
      baseline: baselineOf(initial),
      activeWorkspaceId: "ws-a",
      activeSessionId: "session-t1",
    });
    expect(compiled.ok).toBe(false);
    const deps = memoryStore(initial);
    const result = commitGroupingPlan(plan, baselineOf(initial), deps);
    expect(result.ok).toBe(false);
    expect(sessionIdSet(deps.workspaces)).toEqual(["session-t1", "session-t2"]);
    expect(deps.workspaces[0]?.panes[0]?.tabs.map((tabItem) => tabItem.id)).toEqual(["t1", "t2"]);
    expect(deps.replaceCount).toBe(0);
  });

  it("clears stale session identity from an emptied workspace pane", () => {
    const initial = [workspace("ws-a", "母艦", "pane-a", ["t1", "t2"])];
    const compiled = compileGroupingPlan({
      planId: "plan-empty",
      title: "空にする",
      rationale: "",
      strategy: "minimal_move",
      groups: [{
        groupId: "g-all",
        title: "全部移す",
        disposition: "reorganize",
        destination: { kind: "new_workspace", proposedName: "新机" },
        layout: defaultLayoutForTabs(["t1", "t2"], "まとめ"),
        tabIds: ["t1", "t2"],
        adopted: true,
      }],
      unassignedTabIds: [],
      warnings: [],
    }, initial, {
      baseline: baselineOf(initial),
      activeWorkspaceId: "ws-a",
      activeSessionId: "session-t1",
      uuid: (() => { let n = 0; return () => `x-${++n}`; })(),
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const emptied = compiled.transaction.workspaces.find((item) => item.id === "ws-a");
    expect(emptied?.panes[0]?.tabs).toEqual([]);
    expect(emptied?.panes[0]?.sessionId).toBe("");
    expect(emptied?.panes[0]?.activeTabId).toBe("");
    expect(sessionIdSet(compiled.transaction.workspaces).sort()).toEqual(["session-t1", "session-t2"]);
  });

  it("lists a closed target tab as tab_closed and does not replace", () => {
    const before = [workspace("ws-a", "母艦", "pane-a", ["t1", "t2"])];
    const current = [workspace("ws-a", "母艦", "pane-a", ["t2"])];
    const issues = classifyStale(baselineOf(before), current, new Set(["t1"]), new Set());
    expect(issues.map((issue) => issue.code)).toContain("tab_closed");
    const deps = memoryStore(current);
    const result = commitGroupingPlan(planFor(["t1", "t2"]), baselineOf(before), deps);
    expect(result.ok).toBe(false);
    expect(result.stale?.some((issue) => issue.code === "tab_closed")).toBe(true);
    expect(deps.replaceCount).toBe(0);
  });

  it("follows lastActivePaneId when the dashboard has cleared activePaneId", () => {
    const initial = [workspace("ws-a", "母艦", "pane-a", ["t1", "t2"])];
    initial[0].panes[0].activeTabId = "t2";
    initial[0].panes[0].sessionId = "session-t2";
    const deps = memoryStore(initial);
    deps.getActiveSessionId = () => "session-t2";
    const result = commitGroupingPlan(planFor(["t2", "t1"]), baselineOf(initial), deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transaction.expected.focusSessionId).toBe("session-t2");
    expect(deps.getActiveSessionId()).toBe("session-t2");
    expect(deps.replaceCount).toBe(1);
  });

  it("compiles the same proposal twice into identical transactions", () => {
    const initial = [workspace("ws-a", "母艦", "pane-a", ["t1", "t2"])];
    const options = {
      baseline: baselineOf(initial),
      activeWorkspaceId: "ws-a",
      activeSessionId: "session-t1",
    };
    const first = compileGroupingPlan(planFor(["t1", "t2"]), initial, options);
    const second = compileGroupingPlan(planFor(["t1", "t2"]), initial, options);
    expect(first).toEqual(second);
  });

  it("hides undo on dismiss and restores it with recall", () => {
    const initial = [workspace("ws-a", "母艦", "pane-a", ["t1", "t2"])];
    const deps = memoryStore(initial);
    expect(commitGroupingPlan(planFor(["t1", "t2"]), baselineOf(initial), deps).ok).toBe(true);
    dismissGroupingUndo();
    expect(getGroupingUndoMemory()?.hidden).toBe(true);
    recallGroupingUndo();
    expect(getGroupingUndoMemory()?.hidden).toBe(false);
    expect(restoreGroupingUndo(deps).ok).toBe(true);
    expect(layoutSignature(deps.workspaces)).toBe(layoutSignature(initial));
  });

  it("keeps every original tab object field after a successful move", () => {
    const initial = [workspace("ws-a", "母艦", "pane-a", ["t1", "t2"])];
    initial[0].panes[0].tabs[0].label = "元ラベル";
    initial[0].panes[0].tabs[0].cwd = "C:/keep";
    const deps = memoryStore(initial);
    const result = commitGroupingPlan(planFor(["t1", "t2"]), baselineOf(initial), deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const moved = deps.workspaces.flatMap((item) => item.panes.flatMap((pane) => pane.tabs)).find((tabItem) => tabItem.id === "t1");
    expect(moved?.sessionId).toBe("session-t1");
    expect(moved?.label).toBe("元ラベル");
    expect(moved?.cwd).toBe("C:/keep");
    expect(sessionIdSet(deps.workspaces)).toEqual(["session-t1", "session-t2"]);
  });
});
