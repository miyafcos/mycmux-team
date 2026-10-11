import { describe, expect, it } from "vitest";
import {
  ACTIVE_WATCH_MAX,
  MAIN_SESSIONS_MAX,
  buildLocalGroupingAnalysis,
  buildLocalGroupingPlan,
  buildPresetGroupingPlan,
  withRequestedGroupingPlan,
} from "../../src/components/layout/groupingLocalPlan";
import { parseGroupingOutput, validateEditedPlan, type GroupingScan, type GroupingTab } from "../../src/components/layout/tabGrouping";
import { normalizeEditedPlan } from "../../src/components/layout/groupingEdit";
import { compileGroupingPlan } from "./helpers/groupingTestEntrypoint";
import type { Pane, PaneTab, Workspace } from "../../src/types";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

function tab(id: string, overrides: Partial<GroupingTab> = {}): GroupingTab {
  return {
    id, sessionId: `session-${id}`, label: id, cwd: "/work/sample", agentKind: "codex",
    origin: { kind: "agent" }, workspaceId: "source", workspaceName: "作業机", paneId: `pane-${id}`,
    column: 1, lastOutputAt: NOW - 30 * MINUTE,
    attention: { working: false, waiting: null, unreadCompletion: false }, tail: [], ...overrides,
  };
}

function scanOf(tabs: GroupingTab[], names: Record<string, string> = { source: "作業机" }): GroupingScan {
  const workspaces: Workspace[] = Object.entries(names).map(([id, name]) => {
    const local = tabs.filter(tab => tab.workspaceId === id);
    const paneIds = [...new Set(local.map(tab => tab.paneId))];
    const panes: Pane[] = paneIds.map(paneId => {
      const members = local.filter(tab => tab.paneId === paneId);
      const paneTabs: PaneTab[] = members.map(tab => ({
        id: tab.id, sessionId: tab.sessionId, agentId: "shell-starter", type: "terminal", label: tab.label, origin: tab.origin,
      }));
      return { id: paneId, agentId: "shell-starter", sessionId: paneTabs[0].sessionId, tabs: paneTabs,
        activeTabId: paneTabs[0].id, label: members[0].label };
    });
    const columns: string[][] = [];
    for (const paneId of paneIds) {
      const column = local.find(tab => tab.paneId === paneId)!.column - 1;
      (columns[column] ??= []).push(paneId);
    }
    if (panes.length === 0) {
      const id = `empty-${name}`;
      panes.push({ id, agentId: "", sessionId: "", activeTabId: "", tabs: [] });
      columns.push([id]);
    }
    return { id, name, panes, splitColumns: columns.filter(Boolean), gridTemplateId: "1x1", status: "running", createdAt: NOW };
  });
  return { scannedAt: NOW, tabs, workspaces, workspaceIds: workspaces.map(workspace => workspace.id), lineageClusters: [],
    baseline: tabs.map(tab => ({ tabId: tab.id, sessionId: tab.sessionId, workspaceId: tab.workspaceId, paneId: tab.paneId })) };
}

function selected(scan: GroupingScan, strategy: "active_watch" | "main_sessions"): string[] {
  return buildPresetGroupingPlan(scan, strategy).groups[0]?.tabIds ?? [];
}

function requireValid(scan: GroupingScan, strategy: "active_watch" | "main_sessions") {
  const plan = buildPresetGroupingPlan(scan, strategy);
  expect(validateEditedPlan(plan, scan.tabs.map(tab => tab.id), scan.workspaceIds, scan.workspaces.map(workspace => workspace.name))).toEqual([]);
  const normalized = normalizeEditedPlan(plan);
  expect(normalized.groups[0]?.layout).toEqual(plan.groups[0]?.layout);
  expect(normalized.groups[0]?.destination).toEqual(plan.groups[0]?.destination);
  if (plan.groups.length > 0) {
    const alternatives = [plan, { ...plan, planId: "roundtrip-alternative" }];
    const parsed = Reflect.apply(parseGroupingOutput, undefined, [
      JSON.stringify({ schemaVersion: 1, plans: alternatives }), scan.tabs.map(tab => tab.id),
      scan.workspaceIds, scan.workspaces.map(workspace => workspace.name), undefined, alternatives,
    ]) as ReturnType<typeof parseGroupingOutput>;
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") throw new Error("Preset did not round-trip");
    expect(parsed.plans[0].groups[0].layout).toEqual(plan.groups[0].layout);
    expect(parsed.plans.map(value => value.groups[0].destination)).toEqual(alternatives.map(value => value.groups[0].destination));
  }
  const compiled = compileGroupingPlan(normalized, scan.workspaces, {
    baseline: scan.baseline, activeWorkspaceId: "source", activeSessionId: scan.tabs[0]?.sessionId ?? null,
    allocationSeed: "preset-test", createdAt: NOW,
  });
  expect(compiled.ok, compiled.ok ? undefined : compiled.errors.join(" / ")).toBe(true);
  if (!compiled.ok) throw new Error("Preset did not compile");
  return { plan, compiled };
}

describe("active watch local preset", () => {
  it("selects exactly working, approval, question, unread completion, and four-minute output; keeps two idle sessions", () => {
    const scan = scanOf([
      tab("working", { attention: { working: true, waiting: null, unreadCompletion: false } }),
      tab("approval", { attention: { working: false, waiting: "approval", unreadCompletion: false } }),
      tab("question", { attention: { working: false, waiting: "question", unreadCompletion: false } }),
      tab("unread", { attention: { working: false, waiting: null, unreadCompletion: true } }),
      tab("recent", { lastOutputAt: NOW - 4 * MINUTE }), tab("idle-1"), tab("idle-2"),
    ]);
    const { plan, compiled } = requireValid(scan, "active_watch");
    expect(plan.groups[0].tabIds).toEqual(["approval", "question", "working", "recent", "unread"]);
    expect(plan.groups[0].destination).toEqual({ kind: "new_workspace", proposedName: "稼働中", nameEdited: true });
    expect(plan.groups[1]).toMatchObject({ disposition: "keep", layout: null, destination: { kind: "current_locations" }, tabIds: ["idle-1", "idle-2"] });
    expect(compiled.transaction.expected.movedTabIds).toHaveLength(5);
    expect(compiled.transaction.expected.keptTabIds).toEqual(["idle-1", "idle-2"]);
  });

  it("caps 17 candidates at 16 with reply waits, working, errors, and recent output in priority order", () => {
    const recent = Array.from({ length: 12 }, (_, index) => tab(`recent-${index}`, { lastOutputAt: NOW - index * 1000 }));
    const scan = scanOf([...recent,
      tab("error", { attention: { working: false, waiting: "error", unreadCompletion: false } }),
      tab("rate", { attention: { working: false, waiting: "rate_limited", unreadCompletion: false } }),
      tab("working", { attention: { working: true, waiting: null, unreadCompletion: false } }),
      tab("input", { attention: { working: false, waiting: "input", unreadCompletion: false } }),
      tab("approval", { attention: { working: true, waiting: "approval", unreadCompletion: false } }),
    ]);
    const { plan } = requireValid(scan, "active_watch");
    expect(plan.groups[0].tabIds).toHaveLength(ACTIVE_WATCH_MAX);
    expect(plan.groups[0].tabIds.slice(0, 5)).toEqual(["input", "approval", "working", "error", "rate"]);
    expect(plan.groups[1].tabIds).toEqual(["recent-11"]);
    expect(plan.rationale).toContain("上限のため 1 本は残しました");
    expect(plan.groups[0].layout?.columns).toHaveLength(4);
    expect(plan.groups[0].layout?.columns.every(column => column.panes.length === 4)).toBe(true);
  });

  it("uses the five-minute boundary and returns an empty valid plan when nothing qualifies", () => {
    const scan = scanOf([tab("boundary", { lastOutputAt: NOW - 5 * MINUTE }), tab("older", { lastOutputAt: NOW - 5 * MINUTE - 1 })]);
    expect(selected(scan, "active_watch")).toEqual(["boundary"]);
    const idle = scanOf([tab("idle-1"), tab("idle-2", { lastOutputAt: null })]);
    const { plan, compiled } = requireValid(idle, "active_watch");
    expect(plan.groups).toEqual([]);
    expect(plan.rationale).toContain("いま該当なし");
    expect(plan.unassignedTabIds).toEqual(["idle-1", "idle-2"]);
    expect(compiled.transaction.expected.movedTabIds).toEqual([]);
  });

  it("does not pull an idle lineage child into the monitored group", () => {
    const scan = scanOf([tab("parent", { attention: { working: true, waiting: null, unreadCompletion: false } }),
      tab("child", { origin: { kind: "agent", parentTabId: "parent" } })]);
    expect(selected(scan, "active_watch")).toEqual(["parent"]);
  });

  it.each([0, 1, 3, 4])("reuses the matching workspace with %i resident columns and preserves its residents", columns => {
    const residents = Array.from({ length: columns }, (_, index) => tab(`resident-${index}`, { workspaceId: "watch", column: index + 1 }));
    const scan = scanOf([tab("working", { attention: { working: true, waiting: null, unreadCompletion: false } }), ...residents],
      { source: "作業机", watch: "稼働中" });
    const { plan, compiled } = requireValid(scan, "active_watch");
    expect(plan.groups[0].destination).toEqual({ kind: "existing_workspace", workspaceId: "watch" });
    expect(compiled.transaction.expected.newWorkspaceIds).toEqual([]);
    for (const resident of residents) expect(compiled.transaction.expected.tabs[resident.id].paneId).toBe(resident.paneId);
    expect(compiled.transaction.workspaces.find(workspace => workspace.id === "watch")?.splitColumns?.length).toBeLessThanOrEqual(4);
  });

  it("shows 15 sessions beside a resident and keeps destination-capacity overflow in place", () => {
    const watched = Array.from({ length: 16 }, (_, index) => tab(`watched-${index}`, { lastOutputAt: NOW - index }));
    const scan = scanOf([...watched, tab("resident", { workspaceId: "watch" })], { source: "作業机", watch: "稼働中" });
    const { plan, compiled } = requireValid(scan, "active_watch");
    expect(plan.groups[0].tabIds).toEqual(watched.slice(0, 15).map(tab => tab.id));
    expect(plan.groups[1].tabIds).toEqual(["watched-15", "resident"]);
    expect(plan.rationale).toContain("合流先の表示容量のため 1 本は残しました");
    expect(compiled.transaction.expected.tabs.resident.paneId).toBe("pane-resident");
    const destination = compiled.transaction.workspaces.find(workspace => workspace.id === "watch")!;
    expect(destination.splitColumns).toHaveLength(4);
    expect(destination.splitColumns?.every(column => column.length === 4)).toBe(true);
    expect(destination.panes.map(pane => pane.activeTabId).sort()).toEqual(["resident", ...watched.slice(0, 15).map(tab => tab.id)].sort());
    expect(compiled.transaction.expected.tabs["watched-15"]).toMatchObject({ workspaceId: "source", paneId: "pane-watched-15", sessionId: "session-watched-15" });
  });
});

describe("main sessions local preset", () => {
  it("ranks reply waits, human origin, evidenced mother role, then newest output", () => {
    const scan = scanOf([
      tab("fresh-agent", { lastOutputAt: NOW }),
      tab("mother", { lastOutputAt: NOW - 2 * MINUTE }),
      tab("child", { origin: { kind: "agent", parentTabId: "mother" } }),
      tab("human", { origin: { kind: "human" }, lastOutputAt: NOW - 30 * MINUTE }),
      tab("waiting", { attention: { working: false, waiting: "question", unreadCompletion: false }, lastOutputAt: null }),
    ]);
    const { plan } = requireValid(scan, "main_sessions");
    expect(plan.groups[0].tabIds).toEqual(["waiting", "human", "mother"]);
    expect(plan.groups[0].tabIds).toHaveLength(MAIN_SESSIONS_MAX);
    expect(plan.groups[1].tabIds).toEqual(["fresh-agent", "child"]);
  });

  it("ranks an evidenced human mother ahead of a fresher human session", () => {
    const scan = scanOf([tab("fresh", { origin: { kind: "human" }, lastOutputAt: NOW }),
      tab("mother", { origin: { kind: "human" } }), tab("child", { origin: { kind: "agent", parentTabId: "mother" } })]);
    expect(selected(scan, "main_sessions")).toEqual(["mother", "fresh", "child"]);
  });

  it("breaks ties by workspace order, column order, then scan order", () => {
    const scan = scanOf([tab("late-column", { workspaceId: "first", column: 2 }),
      tab("other-workspace", { workspaceId: "second" }), tab("first-column", { workspaceId: "first" }),
      tab("same-column", { workspaceId: "first" })], { first: "最初", second: "次" });
    expect(selected(scan, "main_sessions")).toEqual(["first-column", "same-column", "late-column"]);
    expect(selected(scan, "main_sessions")).toEqual(selected(scan, "main_sessions"));
  });

  it("uses one session when only one exists and reuses メイン", () => {
    const scan = scanOf([tab("only")], { source: "作業机", main: "メイン" });
    const { plan } = requireValid(scan, "main_sessions");
    expect(plan.groups[0].tabIds).toEqual(["only"]);
    expect(plan.groups[0].destination).toEqual({ kind: "existing_workspace", workspaceId: "main" });
    expect(buildLocalGroupingPlan(scan, {}, { requestedStrategy: "main_sessions" })).toEqual(plan);
  });

  it("returns an empty plan for no terminal sessions", () => {
    const plan = buildPresetGroupingPlan(scanOf([]), "main_sessions");
    expect(plan.groups).toEqual([]);
    expect(plan.rationale).toContain("いま該当なし");
  });
});

describe("requested strategy analysis composition", () => {
  it("pins the preset, then the role alternative, then a deterministic alternative without mutating the input", () => {
    const scan = scanOf([tab("working", { attention: { working: true, waiting: null, unreadCompletion: false } })]);
    const analysis = buildLocalGroupingAnalysis(scan, {})!;
    const requested = withRequestedGroupingPlan(analysis, "active_watch");
    expect(requested.parsed.status).toBe("ok");
    if (requested.parsed.status !== "ok" || analysis.parsed.status !== "ok") throw new Error("Invalid analysis");
    expect(requested.parsed.plans).toHaveLength(3);
    expect(requested.parsed.plans[0].strategy).toBe("active_watch");
    expect(requested.parsed.plans.map(plan => plan.strategy)).toEqual(["active_watch", "role", "minimal_move"]);
    expect(requested.parsed.plans[1]).toBe(analysis.parsed.plans[2]);
    expect(requested.parsed.plans[2]).toBe(analysis.parsed.plans[0]);
    expect(analysis.parsed.plans[0].strategy).toBe("minimal_move");
    expect(withRequestedGroupingPlan(analysis)).toBe(analysis);
  });

  it("shows an empty requested plan immediately rather than returning null", () => {
    const analysis = buildLocalGroupingAnalysis(scanOf([]), {}, { requestedStrategy: "active_watch" })!;
    expect(analysis.parsed.status).toBe("ok");
    if (analysis.parsed.status !== "ok") throw new Error("Invalid analysis");
    expect(analysis.parsed.plans[0]).toMatchObject({ strategy: "active_watch", groups: [] });
  });
});
