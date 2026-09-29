import { describe, expect, it, vi } from "vitest";
import { composeJevPlans, runJevGroupingAnalysis } from "../../src/components/layout/jevGrouping";
import { buildJevRequests, buildJevFocusedRequests, jevPairKey, readJevJudgements, validateJevResponse, type JevAnswer, type JevJudgements } from "../../src/components/layout/jevGroupingDecisions";
import { parseGroupingOutput, type GroupingScan } from "../../src/components/layout/tabGrouping";
import { compileGroupingPlan } from "./helpers/groupingTestEntrypoint";
import { mockGroupingScan } from "./fixtures/tabGroupingMockScenario";

function scan(): GroupingScan {
  const source = structuredClone(mockGroupingScan);
  const template = source.tabs[0];
  source.tabs = Array.from({ length: 9 }, (_, i) => ({
    ...template, id: `t${i}`, sessionId: `session-${i}`, paneId: `pane-${i}`, column: i + 1,
    workspaceId: "w", workspaceName: "Workspace", label: i < 3 ? `Alpha 作業${i}` : i < 6 ? `Beta 作業${i}` : i < 8 ? `業務${i}` : "",
    cwd: "C:/Users/example", tail: i === 8 ? [] : [`Current task ${i}`],
    origin: i === 1 || i === 2 ? { kind: "agent" as const, parentTabId: "t0" }
      : i === 4 || i === 5 ? { kind: "agent" as const, parentTabId: "t3" } : { kind: "human" as const },
  }));
  source.lineageClusters = [{ clusterId: "a", tabIds: ["t0", "t1", "t2"] }, { clusterId: "b", tabIds: ["t3", "t4", "t5"] }];
  source.workspaces = [{ ...source.workspaces[0], id: "w", name: "Workspace",
    panes: source.tabs.map((t) => ({ ...source.workspaces[0].panes[0], id: t.paneId, sessionId: t.sessionId,
      activeTabId: t.id, tabs: [{ ...source.workspaces[0].panes[0].tabs[0], id: t.id, sessionId: t.sessionId, label: t.label, origin: t.origin }] })),
    splitColumns: source.tabs.map((t) => [t.paneId]),
  }];
  source.workspaceIds = ["w"];
  source.baseline = source.tabs.map((t) => ({ tabId: t.id, paneId: t.paneId, workspaceId: "w", sessionId: t.sessionId }));
  return source;
}
function judgements(): JevJudgements {
  const s = scan();
  const relations: JevJudgements["relations"] = {};
  s.tabs.forEach((_, a) => { for (let b = a + 1; b < s.tabs.length; b += 1) {
    const same = a < 6 && b < 6 && Math.floor(a / 3) === Math.floor(b / 3);
    relations[jevPairKey(a, b)] = { kind: same ? "same" : "different", same: same ? 0.95 : 0.01,
      related: 0.02, different: same ? 0.03 : 0.97, confidence: 0.95 };
  } });
  return { roles: ["mother", "worker", "worker", "mother", "worker", "review", "review", "review", "unspecified"],
    health: ["normal", "normal", "normal", "normal", "normal", "normal", "waiting", "waiting", "unknown"], relations };
}

describe("Jev product grouping", () => {
  it("keeps three legal complete plans, related tasks together and unrelated tasks apart", () => {
    const s = scan(); const plans = composeJevPlans(s, judgements());
    expect(plans.map((p) => p.strategy)).toEqual(["project", "role", "minimal_move"]);
    const parsed = parseGroupingOutput(JSON.stringify({ schemaVersion: 1, plans }), s.tabs.map((t) => t.id), ["w"], ["Workspace"]);
    expect(parsed.status).toBe("ok");
    if (parsed.status === "ok") expect(parsed.droppedPlans).toEqual([]);
    for (const plan of plans) {
      expect(plan.groups.flatMap((g) => g.tabIds).sort()).toEqual(s.tabs.map((t) => t.id).sort());
      for (const family of [["t0", "t1", "t2"], ["t3", "t4", "t5"]]) {
        expect(plan.groups.filter((g) => g.tabIds.some((id) => family.includes(id)))).toHaveLength(1);
      }
      expect(plan.groups.find((g) => g.tabIds.includes("t8"))?.disposition).toBe("keep");
    }
    expect(plans[0].groups.some((g) => g.tabIds.includes("t0") && g.tabIds.includes("t3"))).toBe(false);
    expect(plans[0].groups.some((g) => g.tabIds.includes("t6") && g.tabIds.includes("t7"))).toBe(false);
    expect(plans[1].groups.some((g) => g.tabIds.includes("t6") && g.tabIds.includes("t7"))).toBe(true);
  });
  it("shows family members in separate visible panes and gives the role view a wider layout", () => {
    const plans = composeJevPlans(scan(), judgements());
    const project = plans[0].groups.find((g) => g.tabIds.includes("t0"))!;
    const role = plans[1].groups.find((g) => g.tabIds.includes("t0"))!;
    expect(project.layout?.columns).toHaveLength(1);
    expect(project.layout?.columns[0].panes).toHaveLength(3);
    expect(role.layout?.columns.length).toBeGreaterThan(1);
    for (const plan of plans) for (const group of plan.groups) for (const column of group.layout?.columns ?? []) {
      expect(column.panes.length).toBeLessThanOrEqual(4);
      for (const pane of column.panes) expect(pane.tabIds).toHaveLength(1);
    }
  });
  it("compiles every recommendation to real terminal moves without creating or losing sessions", () => {
    const s = scan();
    for (const plan of composeJevPlans(s, judgements())) {
      const result = compileGroupingPlan(plan, s.workspaces, {
        baseline: s.baseline, activeWorkspaceId: "w", activeSessionId: s.tabs[0].sessionId,
        allocationSeed: "jev-test", createdAt: 123,
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) continue;
      const terminals = result.transaction.workspaces.flatMap((w) => w.panes.flatMap((p) => p.tabs));
      expect(terminals.map((t) => t.sessionId).sort()).toEqual(s.tabs.map((t) => t.sessionId).sort());
      expect(result.transaction.expected.movedTabIds.length).toBeGreaterThan(0);
    }
  });
  it("does not force tiny unrelated projects into a minimum-size workspace", () => {
    const j = judgements();
    const plan = composeJevPlans(scan(), j)[0];
    expect(plan.groups.find((g) => g.tabIds.includes("t6"))?.tabIds).toEqual(["t6"]);
  });
  it("has bounded batches and sends only decision data, without session IDs or answer labels", () => {
    const s = scan();
    s.tabs[0].tail.push("sk-or-" + "x".repeat(30));
    const requests = buildJevRequests(s);
    expect(requests.every((r) => Object.keys(r.questions).length <= 48)).toBe(true);
    const raw = JSON.stringify(requests);
    expect(raw).not.toContain("sk-or-");
    expect(raw).not.toContain("session-0");
    expect(raw).toContain("credential omitted");
    expect(raw).toContain("panes.pane_0");
    expect(Object.values(requests[0].state.panes as Record<string, { projectDirectory: string | null }>)[0].projectDirectory).toBeNull();
  });
  it("rejects unexpected keys and invalid response probabilities", () => {
    const requests = [{ state: {}, questions: { a: { type: "noul" as const, instructions: "Check", criteria: { true: "Yes", false: "No" } } } }];
    expect(() => validateJevResponse('{"answers":{"b":{"type":"noul","noul":0.8}}}', requests)).toThrow();
    expect(() => validateJevResponse('{"answers":{"a":{"type":"noul","noul":1.1}}}', requests)).toThrow();
  });
  it("keeps empty shell prompts unknown and rechecks ambiguous connections without downgrading confident projects", () => {
    const s = scan(); s.tabs[8].tail = ["PS C:/Users/example>"];
    const answers: Record<string, JevAnswer> = {};
    for (const request of buildJevRequests(s)) for (const [key, q] of Object.entries(request.questions)) {
      if (q.type === "noul") answers[key] = { type: "noul", noul: key.startsWith("compat") ? 0.5 : 0.95 };
      else {
        const value = key.startsWith("health") ? "normal" : "worker";
        answers[key] = { type: "choice", choice: value, confidence: 1,
          probabilities: Object.fromEntries(Object.keys(q.criteria).map((k) => [k, k === value ? 1 : 0])) };
      }
    }
    answers.pair_6_7 = { type: "noul", noul: 0.1 };
    const focused = buildJevFocusedRequests(s, answers);
    expect(focused.map((r) => Object.keys(r.questions))).toEqual([["pair_6_7"]]);
    const j = readJevJudgements(s, answers);
    expect(j.health[8]).toBe("unknown");
    expect(j.roles[8]).toBe("unspecified");
    expect(j.relations.pair_0_8.kind).toBe("unknown");
    expect(composeJevPlans(s, j)[0].groups.find((g) => g.tabIds.includes("t8"))?.disposition).toBe("keep");
  });
  it("runs both decision stages and validates all three plans through the production parser", async () => {
    const s = scan(); const j = judgements();
    const judge = vi.fn(async (raw: string) => {
      const input = JSON.parse(raw) as { requests: ReturnType<typeof buildJevRequests> };
      const answers: Record<string, unknown> = {};
      for (const request of input.requests) for (const [key, q] of Object.entries(request.questions)) {
        if (q.type === "noul") {
          const [_, a, b] = key.split("_");
          answers[key] = { type: "noul", noul: key === "pair_0_6" ? 0.5 : j.relations[jevPairKey(+a, +b)].same };
        } else {
          const i = Number(key.split("_")[1]);
          const value = key.startsWith("role") ? j.roles[i] : key.startsWith("health") ? j.health[i] : "different";
          answers[key] = { type: "choice", choice: value, confidence: 1,
            probabilities: Object.fromEntries(Object.keys(q.criteria).map((k) => [k, k === value ? 1 : 0])) };
        }
      }
      return JSON.stringify({ answers });
    });
    const result = await runJevGroupingAnalysis({ scan: async () => s, judge, requestId: () => "test" });
    expect(judge).toHaveBeenCalledTimes(2);
    expect(result.parsed.status).toBe("ok");
    if (result.parsed.status === "ok") expect(result.parsed.plans).toHaveLength(3);
    expect(result.timings?.judgeRequests).toBe(2);
  });
});
