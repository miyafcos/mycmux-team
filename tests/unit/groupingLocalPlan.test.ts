import { describe, expect, it } from "vitest";

import {
  LOCAL_GROUPING_ATTENTION_TITLE,
  LOCAL_GROUPING_PLAN_ID,
  buildLocalGroupingAnalysis,
  buildLocalGroupingPlan,
  buildLocalGroupingScan,
  localBuckets,
  localLayout,
  localProjectKeys,
} from "../../src/components/layout/groupingLocalPlan";
import {
  TAB_GROUPING_MAX_COLUMNS,
  validateEditedPlan,
  type GroupingScan,
  type GroupingTab,
} from "../../src/components/layout/tabGrouping";
import type { Pane, PaneTab, Workspace } from "../../src/types";

const NOW = 1_788_000_000_000;

function tab(id: string, overrides: Partial<GroupingTab> = {}): GroupingTab {
  return {
    id,
    sessionId: `session-${id}`,
    label: id,
    cwd: "C:/Users/miyaz",
    agentKind: "claude",
    workspaceId: "ws-a",
    workspaceName: "母艦",
    paneId: "pane-1",
    column: 1,
    lastOutputAt: NOW,
    tail: [],
    ...overrides,
  };
}

function scanOf(tabs: GroupingTab[], workspaceNames: Record<string, string> = { "ws-a": "母艦" }): GroupingScan {
  return {
    scannedAt: NOW,
    tabs,
    lineageClusters: [],
    baseline: tabs.map((entry) => ({
      tabId: entry.id,
      workspaceId: entry.workspaceId,
      paneId: entry.paneId,
      sessionId: entry.sessionId,
    })),
    workspaceIds: Object.keys(workspaceNames),
    workspaces: Object.entries(workspaceNames).map(([id, name]) => ({
      id,
      name,
      gridTemplateId: "1x1",
      status: "running",
      createdAt: NOW,
      panes: [],
      splitColumns: [[]],
    })) as Workspace[],
  };
}

function projectTabs(): GroupingTab[] {
  return [
    tab("m1", { cwd: "C:/Users/miyaz/work/momosta/math", label: "数学 監視" }),
    tab("m2", { cwd: "C:/Users/miyaz/work/momosta/science", label: "理科 量産" }),
    tab("d1", { cwd: "C:/Users/miyaz/dev/mycmux", label: "配置図" }),
    tab("d2", { cwd: "C:/Users/miyaz/dev/mycmux/src", label: "受入判定" }),
  ];
}

describe("localProjectKeys", () => {
  it("cuts at the deepest folder two tabs share", () => {
    const keys = localProjectKeys(projectTabs());
    expect(keys.get("m1")).toBe("C:/Users/miyaz/work/momosta");
    expect(keys.get("m2")).toBe("C:/Users/miyaz/work/momosta");
    expect(keys.get("d1")).toBe("C:/Users/miyaz/dev/mycmux");
    expect(keys.get("d2")).toBe("C:/Users/miyaz/dev/mycmux");
  });

  it("drops a tab that shares nothing onto the common root", () => {
    const keys = localProjectKeys([
      ...projectTabs(),
      tab("lonely", { cwd: "D:/elsewhere/alone" }),
    ]);
    expect(keys.get("lonely")).toBe("");
  });

  it("treats an empty cwd as rootless", () => {
    expect(localProjectKeys([tab("a", { cwd: "" }), tab("b", { cwd: "" })]).get("a")).toBe("");
  });
});

describe("localBuckets", () => {
  it("keeps a lineage together even when the child sits in another folder", () => {
    const tabs = [
      tab("parent", { cwd: "C:/Users/miyaz/work/momosta/math" }),
      tab("sibling", { cwd: "C:/Users/miyaz/work/momosta/science" }),
      tab("child", {
        cwd: "C:/Users/miyaz/dev/mycmux",
        origin: { kind: "agent", parentTabId: "parent" },
      }),
      tab("other", { cwd: "C:/Users/miyaz/dev/mycmux" }),
    ];
    const buckets = localBuckets(tabs, {});
    const withChild = buckets.find((bucket) => bucket.tabs.some((entry) => entry.id === "child"));
    expect(withChild?.tabs.map((entry) => entry.id).sort()).toEqual(["child", "parent", "sibling"]);
  });

  it("isolates attention tabs ahead of every project bucket", () => {
    const buckets = localBuckets(projectTabs(), { m1: "error" });
    expect(buckets[0].attention).toBe(true);
    expect(buckets[0].tabs.map((entry) => entry.id)).toEqual(["m1"]);
    expect(buckets.slice(1).flatMap((bucket) => bucket.tabs.map((entry) => entry.id))).not.toContain("m1");
  });

  it("leaves waiting and done tabs in their project bucket", () => {
    const buckets = localBuckets(projectTabs(), { m1: "waiting", d1: "done" });
    expect(buckets.some((bucket) => bucket.attention)).toBe(false);
  });
});

describe("localLayout", () => {
  it("uses columns only and never adds a second pane to a column", () => {
    const layout = localLayout(projectTabs(), "案件");
    expect(layout).not.toBeNull();
    expect(layout!.columns.length).toBe(4);
    for (const column of layout!.columns) expect(column.panes).toHaveLength(1);
  });

  it("stacks the overflow as back tabs instead of growing rows", () => {
    const many = Array.from({ length: 9 }, (_, index) => tab(`t${index}`));
    const layout = localLayout(many, "案件")!;
    expect(layout.columns.length).toBe(TAB_GROUPING_MAX_COLUMNS);
    for (const column of layout.columns) expect(column.panes).toHaveLength(1);
    const placed = layout.columns.flatMap((column) => column.panes.flatMap((pane) => pane.tabIds));
    expect(placed.sort()).toEqual(many.map((entry) => entry.id).sort());
    expect(layout.columns.some((column) => column.panes[0].tabIds.length > 1)).toBe(true);
  });

  it("puts a lineage in one pane and marks it the mother", () => {
    const layout = localLayout([
      tab("root"),
      tab("kid", { origin: { kind: "agent", parentTabId: "root" } }),
      tab("solo"),
    ], "案件")!;
    const motherPane = layout.columns.flatMap((column) => column.panes).find((pane) => pane.role === "mother");
    expect(motherPane?.tabIds).toEqual(["root", "kid"]);
  });
});

describe("buildLocalGroupingPlan", () => {
  const attention = {} as Record<string, "waiting" | "error" | "done" | null>;

  it("produces a plan the shared validator accepts", () => {
    const scan = scanOf(projectTabs());
    const plan = buildLocalGroupingPlan(scan, attention)!;
    expect(plan.planId).toBe(LOCAL_GROUPING_PLAN_ID);
    expect(validateEditedPlan(plan, scan.tabs.map((entry) => entry.id), scan.workspaceIds, ["母艦"])).toEqual([]);
  });

  it("names groups after the shared folder, dropping characters and generic words the rules ban", () => {
    const scan = scanOf([
      tab("a", { cwd: "C:/Users/miyaz/work_momosta_rika/one" }),
      tab("b", { cwd: "C:/Users/miyaz/work_momosta_rika/two" }),
      tab("c", { cwd: "C:/Users/miyaz/dev/mycmux" }),
      tab("d", { cwd: "C:/Users/miyaz/dev/mycmux" }),
    ]);
    const titles = buildLocalGroupingPlan(scan, attention)!.groups.map((group) => group.title);
    // "work" is on the banned generic-word list, so the name keeps the part
    // that actually identifies the folder instead of falling back to "miyaz".
    expect(titles).toContain("momosta rika");
    expect(titles).toContain("mycmux");
  });

  it("never reuses an existing workspace name for a new workspace", () => {
    const scan = scanOf(projectTabs(), { "ws-a": "mycmux", "ws-b": "母艦" });
    const plan = buildLocalGroupingPlan(scan, attention)!;
    const proposed = plan.groups
      .filter((group) => group.destination.kind === "new_workspace")
      .map((group) => group.destination.kind === "new_workspace" ? group.destination.proposedName : "");
    expect(proposed).not.toContain("mycmux");
    expect(validateEditedPlan(plan, scan.tabs.map((entry) => entry.id), scan.workspaceIds, ["mycmux", "母艦"])).toEqual([]);
  });

  it("isolates an attention tab into its own workspace", () => {
    const scan = scanOf(projectTabs());
    const plan = buildLocalGroupingPlan(scan, { d1: "error" })!;
    const isolated = plan.groups.find((group) => group.title === LOCAL_GROUPING_ATTENTION_TITLE)!;
    expect(isolated.tabIds).toEqual(["d1"]);
    expect(isolated.disposition).toBe("reorganize");
  });

  it("leaves an unshared tab unassigned rather than inventing a group for it", () => {
    const scan = scanOf([...projectTabs(), tab("lonely", { cwd: "D:/elsewhere/alone" })]);
    const plan = buildLocalGroupingPlan(scan, attention)!;
    expect(plan.unassignedTabIds).toEqual(["lonely"]);
  });

  it("returns null when there are too few tabs to be worth moving", () => {
    expect(buildLocalGroupingPlan(scanOf([tab("a"), tab("b")]), attention)).toBeNull();
  });

  it("returns null when every group would stay exactly where it is", () => {
    const settled = [
      tab("a", { cwd: "C:/Users/miyaz/work/momosta", workspaceId: "ws-a" }),
      tab("b", { cwd: "C:/Users/miyaz/work/momosta", workspaceId: "ws-a" }),
      tab("c", { cwd: "C:/Users/miyaz/dev/mycmux", workspaceId: "ws-b" }),
      tab("d", { cwd: "C:/Users/miyaz/dev/mycmux", workspaceId: "ws-b" }),
    ];
    expect(buildLocalGroupingPlan(scanOf(settled, { "ws-a": "母艦", "ws-b": "開発" }), attention)).toBeNull();
  });

  it("wraps the plan as an analysis the panel can hydrate", () => {
    const analysis = buildLocalGroupingAnalysis(scanOf(projectTabs()), attention)!;
    expect(analysis.parsed.status).toBe("ok");
    expect(analysis.raw).toBe("");
    if (analysis.parsed.status === "ok") expect(analysis.parsed.plans).toHaveLength(1);
  });
});

describe("buildLocalGroupingScan", () => {
  function paneTab(id: string, overrides: Partial<PaneTab> = {}): PaneTab {
    return {
      id,
      sessionId: `session-${id}`,
      type: "terminal",
      label: id,
      cwd: "C:/Users/miyaz/work/momosta",
      ...overrides,
    } as PaneTab;
  }

  it("keeps every terminal tab without asking the backend anything", async () => {
    const pane = {
      id: "pane-1",
      sessionId: "session-a",
      tabs: [paneTab("a"), paneTab("b")],
      cwd: "C:/Users/miyaz/work/momosta",
    } as unknown as Pane;
    const workspaces = [{
      id: "ws-a",
      name: "母艦",
      gridTemplateId: "1x1",
      status: "running",
      createdAt: NOW,
      panes: [pane],
      splitColumns: [["pane-1"]],
    }] as Workspace[];

    const scan = await buildLocalGroupingScan({ workspaces, metadata: {}, attentionByTabId: {}, now: NOW });

    // The real scan would drop both tabs here: with no PTY snapshot every tab
    // reads as dead. The local scan keeps them and carries no tail.
    expect(scan.tabs.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(scan.tabs.every((entry) => entry.tail.length === 0)).toBe(true);
    expect(scan.baseline).toHaveLength(2);
  });
});
