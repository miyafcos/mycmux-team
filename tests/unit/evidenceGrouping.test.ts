import { describe, expect, it, vi } from "vitest";
import { composeEvidencePlans, runEvidenceGroupingAnalysis } from "../../src/components/layout/evidenceGrouping";
import { buildJevRoleRequests } from "../../src/components/layout/jevGroupingDecisions";
import { validateEditedPlan, parseGroupingOutput, type GroupingScan } from "../../src/components/layout/tabGrouping";
import { buildLocalGroupingAnalysis } from "../../src/components/layout/groupingLocalPlan";
import { useLauncherDirsStore } from "../../src/stores/launcherDirsStore";
import type { PaneTab, Pane, Workspace } from "../../src/types";

const registry = [
  { section: "開発", label: "toolx (master)", path: "C:/toolx" },
  { section: "開発", label: "harbor (master)", path: "C:/harbor" },
  ...Array.from({ length: 12 }, (_, i) => ({ section: "別枠", label: "架空案件" + i, path: "D:/other/" + i })),
];
function pane(id: string, cwd: string): Pane {
  const tab: PaneTab = { id, sessionId: "session-" + id, agentId: "shell-starter", type: "terminal", cwd, label: "toolx-test-" + id, labelSource: "ai" };
  return { id: "p-" + id, tabs: [tab], activeTabId: id, sessionId: tab.sessionId, agentId: "shell-starter" };
}
function workspace(id: string, name: string, panes: Pane[]): Workspace {
  return { id, name, panes, gridTemplateId: "4x4", splitColumns: panes.map(p => [p.id]), status: "running", createdAt: 1 };
}
function scan(workspaces: Workspace[]): GroupingScan {
  const tabs = workspaces.flatMap(w => w.panes.flatMap((p, col) => p.tabs.map(t => ({
    id: t.id, sessionId: t.sessionId, label: t.label ?? "", labelSource: t.labelSource,
    cwd: t.cwd ?? "", agentKind: "codex", workspaceId: w.id, workspaceName: w.name,
    paneId: p.id, column: col + 1, lastOutputAt: 0, tail: ["unused terminal output"], origin: t.origin,
    taskTitle: "toolx 検査 " + t.id,
  }))));
  return { scannedAt: 1, tabs, workspaces, workspaceIds: workspaces.map(w => w.id),
    baseline: tabs.map(t => ({ tabId: t.id, paneId: t.paneId, sessionId: t.sessionId, workspaceId: t.workspaceId })), lineageClusters: [] };
}
function checkPlans(s: GroupingScan, plans = composeEvidencePlans(s, registry)) {
  for (const plan of plans) expect(validateEditedPlan(plan, s.tabs.map(t => t.id), s.workspaceIds, s.workspaces.map(w => w.name))).toEqual([]);
  expect(parseGroupingOutput(JSON.stringify({ schemaVersion: 1, plans }), s.tabs.map(t => t.id), s.workspaceIds, s.workspaces.map(w => w.name)).status).toBe("ok");
  const parsed = parseGroupingOutput(JSON.stringify({ schemaVersion: 1, plans }), s.tabs.map(t => t.id), s.workspaceIds, s.workspaces.map(w => w.name));
  expect(parsed.status === "ok" ? parsed.droppedPlans : parsed.issues).toEqual([]);
  return plans;
}
describe("material grouping", () => {
  it("returns three immediate plans with only one out-of-home pane moved and no new workspace", () => {
    const s = scan([workspace("today", "今日", [pane("away", "C:/toolx/task")]), workspace("home", "toolx", [pane("resident", "C:/toolx")])]);
    const plans = checkPlans(s);
    expect(plans.map(p => p.strategy)).toEqual(["minimal_move", "project", "role"]);
    const move = plans[0].groups.filter(g => g.disposition === "reorganize");
    expect(move).toHaveLength(1);
    expect(move[0].tabIds).toEqual(["away"]);
    expect(move[0].destination).toEqual({ kind: "existing_workspace", workspaceId: "home" });
    expect(plans[0].groups.some(g => g.destination.kind === "new_workspace")).toBe(false);
    expect(plans[0].rationale).toContain("1 ペイン");
  });
  it("stacks into a matching resident at four columns, otherwise the last resident", () => {
    const home = workspace("home", "toolx", [pane("resident", "C:/toolx"), ...["b", "c", "d"].map(id => pane(id, ""))]);
    const s = scan([workspace("today", "今日", [pane("away", "C:/toolx/task")]), home]);
    const plan = checkPlans(s)[0];
    expect(plan.groups[0].layout?.columns[0].panes[0].existingPaneId).toBe("p-resident");
    home.panes[0].tabs[0].cwd = "";
    const fallback = scan([s.workspaces[0], home]);
    fallback.tabs.filter(t => t.workspaceId === "home").forEach(t => { t.taskTitle = ""; });
    expect(checkPlans(fallback)[0].groups[0].layout?.columns[0].panes[0].existingPaneId).toBe("p-d");
  });
  it("keeps unknown and unscattered projects, reuses a matching workspace name and never numbers the home", () => {
    const s = scan([workspace("today", "今日", [pane("one", "C:/toolx"), pane("unknown", "")]), workspace("existing", "toolx", [])]);
    s.tabs.find(t => t.id === "unknown")!.taskTitle = "";
    const plan = checkPlans(s)[0];
    expect(plan.groups[0].destination).toEqual({ kind: "existing_workspace", workspaceId: "existing" });
    expect(plan.groups.find(g => g.disposition === "keep")?.tabIds).toEqual(["unknown"]);
    expect(plan.groups.some(g => / \d+$/.test(g.title))).toBe(false);
    expect(checkPlans(scan([workspace("only", "今日", [pane("one", "C:/toolx")])]))[0].groups[0].disposition).toBe("keep");
  });
  it("uses lineage and review titles for roles while retaining material-free panes", () => {
    const parent = pane("parent", "C:/toolx");
    const child = pane("child", "C:/toolx");
    child.tabs[0].origin = { kind: "agent", parentTabId: "parent" };
    const s = scan([workspace("today", "今日", [parent, child, pane("review", "C:/harbor"), pane("unknown", "")])]);
    s.tabs[2].taskTitle = "harbor 検収";
    s.tabs[3].taskTitle = "";
    const plan = checkPlans(s)[2];
    const moving = plan.groups.filter(g => g.disposition === "reorganize");
    expect(moving.flatMap(g => g.tabIds).sort()).toEqual(["child", "parent", "review"]);
    expect(moving.every(g => /toolx|harbor/.test(g.title))).toBe(true);
    expect(moving.every(g => g.tabIds.length <= 8)).toBe(true);
  });
  it("preserves material punctuation, generic registered words and Unicode clipping", () => {
    for (const name of ["toolx-beta", "work", "ひかり出版のとても長い登録案件についての検査"]) {
      const s = scan([workspace("today", "今日", [pane("one", "C:/special")])]);
      const plans = checkPlans(s, composeEvidencePlans(s, [{ section: "登録", label: name, path: "C:/special" }]));
      const group = plans[1].groups[0];
      expect([...group.title].length).toBeLessThanOrEqual(20);
      expect(group.title).toBe(name.length > 20 ? [...name].slice(0, 19).join("") + "…" : name);
      expect(plans[1].nameSource).toBe("evidence");
    }
  });
  it("gives a shared home to the project with the strongest evidence and keeps other projects separate", () => {
    const r = [...registry, { section: "教材", label: "北斗学院/ひかりスタ/数学", path: "C:/math" },
      { section: "教材", label: "北斗学院/ひかりスタ/理科", path: "C:/science" }];
    const s = scan([workspace("today", "今日", [pane("math", "C:/math"), pane("science", "C:/science")]),
      workspace("home", "ひかりスタ 数学", [])]);
    const plans = checkPlans(s, composeEvidencePlans(s, r));
    expect(plans[0].groups.filter(g => g.disposition === "reorganize")).toHaveLength(1);
    expect(plans[1].groups.find(g => g.tabIds.includes("math"))?.destination).toEqual({ kind: "existing_workspace", workspaceId: "home" });
    expect(plans[1].groups.find(g => g.tabIds.includes("science"))?.destination.kind).toBe("new_workspace");
  });
  it("uses facet names before numbering role groups that cannot fit together", () => {
    const r = [...registry, { section: "教材", label: "ひかりスタ/数学", path: "C:/math" },
      { section: "教材", label: "ひかりスタ/理科", path: "C:/science" }];
    const s = scan([workspace("today", "今日", Array.from({ length: 8 }, (_, i) => pane("r" + i, i < 4 ? "C:/math" : "C:/science")))]);
    s.tabs.forEach(t => { t.taskTitle = "検収"; });
    const role = checkPlans(s, composeEvidencePlans(s, r))[2];
    const names = role.groups.filter(g => g.disposition === "reorganize").map(g => g.title);
    expect(names).toHaveLength(2);
    expect(names[0]).toBe("ひかりスタ 確認・判断");
    expect(names[1]).toBe("ひかりスタ 理科 確認・判断");
    expect(names.some(n => / \d+$/.test(n))).toBe(false);
  });
  it("does not call a judge with Jev off and sends only role questions without tails with Jev on", async () => {
    const s = scan([workspace("today", "今日", [pane("one", "C:/toolx")])]);
    const judge = vi.fn(async (prompt: string) => {
      const { requests } = JSON.parse(prompt) as { requests: ReturnType<typeof buildJevRoleRequests> };
      return JSON.stringify({ answers: Object.fromEntries(requests.flatMap(r => Object.entries(r.questions).map(([key, question]) => [key, {
        type: "choice", choice: "review", confidence: 1,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(role => [role, Number(role === "review")])),
      }]))) });
    });
    useLauncherDirsStore.setState({ view: { doc: { entries: registry } } as unknown as NonNullable<ReturnType<typeof useLauncherDirsStore.getState>["view"]> });
    const deps = { scan: async () => s, judge, requestId: () => "request" };
    const local = await runEvidenceGroupingAnalysis(deps, false);
    expect(judge).not.toHaveBeenCalled();
    const updated = await runEvidenceGroupingAnalysis(deps, true);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(buildJevRoleRequests(s))).not.toContain("unused terminal output");
    expect(buildJevRoleRequests(s).flatMap(r => Object.keys(r.questions)).every(k => /^role_\d+$/.test(k))).toBe(true);
    if (local.parsed.status === "ok" && updated.parsed.status === "ok") expect(updated.parsed.plans.slice(0, 2)).toEqual(local.parsed.plans.slice(0, 2));
    const instant = buildLocalGroupingAnalysis(s, {})!;
    expect(instant.parsed.status === "ok" && instant.parsed.plans.map(p => p.strategy)).toEqual(["minimal_move", "project", "role"]);
  });
});
