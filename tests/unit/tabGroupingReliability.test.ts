import { describe, expect, it, vi } from "vitest";
import {
  buildGroupingPrompt,
  parseGroupingOutput,
  runGroupingAnalysis,
  scanGroupingContext,
  validateEditedPlan,
  type GroupingScan,
  type GroupingScanSource,
} from "../../src/components/layout/tabGrouping";

// Reproduces the supplied 19-pane / 3-plan shape with existing destination names.
const ids = Array.from({ length: 19 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
const names = ["ポケット開発", "モモスタ数学", "判断・業務", "要確認"];
function response(tabIds = ids) {
  return {
    schemaVersion: 1,
    plans: ["project", "role", "minimal_move"].map((strategy, i) => ({
      planId: `plan-${i}`,
      title: ["案件中心の再配置", "役割中心の再配置", "最小移動の再配置"][i],
      rationale: "関連するペインをまとめます",
      strategy,
      groups: [tabIds.slice(0, 8), tabIds.slice(8, 11), tabIds.slice(11, 15), tabIds.slice(15)].map((groupIds, index) => ({
        groupId: `group-${index}`,
        title: names[index],
        disposition: "reorganize",
        destination: { kind: "new_workspace", proposedName: names[index] },
        layout: { columns: [{ panes: [{ title: "作業", role: "worker", tabIds: groupIds }] }] },
        tabIds: groupIds,
      })),
      unassignedTabIds: [],
      warnings: [],
    })),
  };
}
function scan(): GroupingScan {
  return {
    scannedAt: 1,
    tabs: ids.map((id, i) => ({
      id, sessionId: `session-${id}`, label: `作業${i}`, cwd: "C:/work/project",
      agentKind: "codex", workspaceId: "existing", workspaceName: names[0],
      paneId: `pane-${i}`, column: 1, lastOutputAt: 1, tail: [],
      origin: i ? { kind: "agent" as const, parentTabId: ids[0] } : { kind: "human" as const },
    })),
    lineageClusters: [{ clusterId: "lineage-1", tabIds: ids }],
    baseline: ids.map((id, i) => ({ tabId: id, sessionId: `session-${id}`, workspaceId: "existing", paneId: `pane-${i}` })),
    workspaceIds: ["existing"],
    workspaces: [{ id: "existing", name: names[0], panes: [], gridTemplateId: "1x1", status: "running", createdAt: 1 }],
  };
}
describe("grouping reliability", () => {
  it("keeps multiple comparison plans instead of reducing choice to meet a time budget", () => {
    const prompt = buildGroupingPrompt(scan());
    expect(prompt).toContain("プランを2〜3件");
    expect(prompt).toContain("切り口の異なる案");
    expect(prompt).not.toContain("プランを1件だけ");
  });

  it("keeps scan, judge and total timings on a successful result", async () => {
    let clock = 0;
    const result = await runGroupingAnalysis({
      now: () => clock,
      scan: async () => { clock += 120; return scan(); },
      judge: async () => { clock += 880; return JSON.stringify(response()); },
      requestId: () => "timed",
    });
    expect(result.timings).toEqual({
      totalMs: 1000, scanMs: 120, judgeMs: 880, validationMs: 0, judgeRequests: 1,
    });
    expect(result.parsed.status).toBe("ok");
  });

  it("includes both judge calls in retry timings without dropping the scan time", async () => {
    let clock = 0;
    let calls = 0;
    const result = await runGroupingAnalysis({
      now: () => clock,
      scan: async () => { clock += 200; return scan(); },
      judge: async () => {
        clock += 500;
        return ++calls === 1 ? "invalid" : JSON.stringify(response());
      },
      requestId: () => "retry-timed",
    });
    expect(result.timings).toEqual({
      totalMs: 1200, scanMs: 200, judgeMs: 1000, validationMs: 0, judgeRequests: 2,
    });
    expect(result.retried).toBe(true);
  });

  it("repairs invalid output even when the first answer was slow", async () => {
    let clock = 0;
    let calls = 0;
    const judge = vi.fn(async () => {
      clock += 10_000;
      return ++calls === 1 ? "invalid" : JSON.stringify(response());
    });
    const result = await runGroupingAnalysis({
      now: () => clock, scan: async () => scan(), judge, requestId: () => "slow",
    });
    expect(result.parsed.status).toBe("ok");
    expect(result.retried).toBe(true);
    expect(judge).toHaveBeenCalledTimes(2);
    expect(result.timings?.judgeMs).toBe(20_000);
  });

  it("keeps all three 19-pane plans when their new names already exist", () => {
    const parsed = parseGroupingOutput(JSON.stringify(response()), ids, ["existing"], names);
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    expect(parsed.plans).toHaveLength(3);
    for (const plan of parsed.plans) {
      expect(plan.groups.flatMap((group) => group.tabIds)).toEqual(ids);
      expect(validateEditedPlan(plan, ids, ["existing"], new Set(names))).toEqual([]);
      expect(plan.groups.map((group) => group.destination)).toEqual(names.map((name) => ({
        kind: "new_workspace", proposedName: `${name} 2`,
      })));
      expect(plan.warnings).toHaveLength(4);
    }
  });

  it("reserves unchanged names and keeps numbered names within 20 characters", () => {
    const body = response();
    const long = "あ".repeat(20);
    body.plans[0].groups[0].destination.proposedName = long;
    body.plans[0].groups[1].destination.proposedName = "あ".repeat(18) + " 2";
    body.plans[0].groups[2].destination.proposedName = long;
    const parsed = parseGroupingOutput(JSON.stringify(body), ids, ["existing"], [long]);
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    const plan = parsed.plans.find((p) => p.planId === "plan-0")!;
    expect(plan).toBeDefined();
    const destinations = plan.groups.map((g) => g.destination.kind === "new_workspace" ? g.destination.proposedName : "");
    expect(destinations.slice(0, 3)).toEqual(["あ".repeat(18) + " 3", "あ".repeat(18) + " 2", "あ".repeat(18) + " 4"]);
    expect(validateEditedPlan(plan, ids, ["existing"], new Set([long]))).toEqual([]);
  });

  it("returns one usable plan without another judge request", async () => {
    const body = response();
    body.plans = body.plans.slice(0, 1);
    const judge = vi.fn(async () => JSON.stringify(body));
    const result = await runGroupingAnalysis({ scan: async () => scan(), judge, requestId: () => "request" });
    expect(result.parsed.status).toBe("ok");
    expect(judge).toHaveBeenCalledTimes(1);
    expect(result.retried).toBe(false);
  });

  it("sends validation feedback when every plan is unusable", async () => {
    const judge = vi.fn(async (_prompt: string) => "not-json");
    await runGroupingAnalysis({ scan: async () => scan(), judge, requestId: () => "request" });
    expect(judge).toHaveBeenCalledTimes(2);
    expect(judge.mock.calls[1]?.[0]).toContain("JSON として解釈できません");
    expect(judge.mock.calls[1]?.[0]).not.toEqual(judge.mock.calls[0]?.[0]);
  });

  it("uses short references on the wire and restores every reference before validation", async () => {
    const current = scan();
    let shortIds: string[] = [];
    const judge = vi.fn(async (prompt: string) => {
      const payload = JSON.parse(prompt.split("\n").at(-1)!);
      shortIds = payload.tabs.map((tab: { id: string }) => tab.id);
      expect(shortIds.every((id) => id.length < 8)).toBe(true);
      expect(payload.tabs[1].origin.parentTabId).toBe(shortIds[0]);
      expect(payload.lineageClusters[0].tabIds).toEqual(shortIds);
      const compact = response(shortIds);
      for (const plan of compact.plans) for (const group of plan.groups) Reflect.deleteProperty(group, "tabIds");
      expect(new TextEncoder().encode(JSON.stringify(compact)).length)
        .toBeLessThan(new TextEncoder().encode(JSON.stringify(response())).length * 0.6);
      return JSON.stringify(compact);
    });
    const result = await runGroupingAnalysis({ scan: async () => current, judge, requestId: () => "request" });
    expect(result.parsed.status).toBe("ok");
    if (result.parsed.status !== "ok") return;
    expect(result.parsed.plans[0].groups.flatMap((g) => g.tabIds)).toEqual(ids);
    expect(result.scan).toBe(current);
    expect(JSON.stringify(response(shortIds)).length).toBeLessThan(JSON.stringify(response()).length * 0.7);
  });

  it("restores existing destinations, kept tabs, warnings and unassigned tabs without changing prose", async () => {
    const judge = vi.fn(async (prompt: string) => {
      const payload = JSON.parse(prompt.split("\n").at(-1)!);
      const refs = payload.tabs.map((tab: { id: string }) => tab.id);
      return JSON.stringify({
        schemaVersion: 1,
        plans: [{
          planId: "mixed-refs", title: "部分的に整理", rationale: refs[0], strategy: "minimal_move",
          groups: [
            { groupId: "move", title: "作業", disposition: "reorganize",
              destination: { kind: "existing_workspace", workspaceId: payload.workspaces[0].id },
              layout: { columns: [{ panes: [{ title: "作業", role: "worker", tabIds: [refs[0]] }] }] } },
            { groupId: "keep", title: "現状維持", disposition: "keep",
              destination: { kind: "current_locations" }, layout: null, tabIds: refs.slice(1, -1) },
          ],
          unassignedTabIds: [refs.at(-1)],
          warnings: [{ code: "LOW_CONFIDENCE", message: refs[0], tabIds: [refs[0], refs.at(-1)] }],
        }],
      });
    });
    const result = await runGroupingAnalysis({ scan: async () => scan(), judge, requestId: () => "request" });
    expect(result.parsed.status).toBe("ok");
    if (result.parsed.status !== "ok") return;
    const plan = result.parsed.plans[0];
    expect(plan.groups[0].destination).toEqual({ kind: "existing_workspace", workspaceId: "existing" });
    expect(plan.groups.flatMap((group) => group.tabIds)).toEqual(ids.slice(0, -1));
    expect(plan.unassignedTabIds).toEqual([ids.at(-1)]);
    expect(plan.warnings[0].tabIds).toEqual([ids[0], ids.at(-1)]);
    expect(plan.rationale).toBe("@t1");
    expect(plan.warnings[0].message).toBe("@t1");
    expect(result.raw).toContain("@t1");
  });

  it.each(["duplicate", "unknown"])("still rejects %s references instead of applying a partial guess", async (failure) => {
    const judge = vi.fn(async (prompt: string) => {
      const payload = JSON.parse(prompt.split("\n").at(-1)!);
      const refs = payload.tabs.map((tab: { id: string }) => tab.id);
      const body = response(refs);
      for (const plan of body.plans) {
        const group = plan.groups[0];
        group.layout.columns[0].panes[0].tabIds[0] = failure === "duplicate" ? refs[1] : "@t9999";
        group.tabIds = [...group.layout.columns[0].panes[0].tabIds];
      }
      return JSON.stringify(body);
    });
    const result = await runGroupingAnalysis({ scan: async () => scan(), judge, requestId: () => "request" });
    expect(result.parsed.status).toBe("invalid");
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it("does not reuse an existing real ID as another pane's short reference", async () => {
    const current = scan();
    current.tabs[5].id = "@t1";
    current.lineageClusters = [];
    const judge = vi.fn(async (prompt: string) => {
      const payload = JSON.parse(prompt.split("\n").at(-1)!);
      const refs = payload.tabs.map((tab: { id: string }) => tab.id);
      expect(refs).not.toContain("@t1");
      return JSON.stringify(response(refs));
    });
    const result = await runGroupingAnalysis({ scan: async () => current, judge, requestId: () => "request" });
    expect(result.parsed.status).toBe("ok");
    if (result.parsed.status === "ok") {
      expect(result.parsed.plans[0].groups.flatMap((g) => g.tabIds)).toEqual(current.tabs.map((tab) => tab.id));
    }
  });

  it("reads tails concurrently with a bounded number of requests and stable ordering", async () => {
    const current = scan();
    let active = 0;
    let peak = 0;
    const source: GroupingScanSource = {
      workspaces: [{
        ...current.workspaces[0],
        panes: [{
          id: "pane", agentId: "shell-starter", sessionId: "s0",
          tabs: ids.map((id, i) => ({ id, sessionId: `s${i}`, agentId: "shell-starter", type: "terminal" as const })),
        }],
        splitColumns: [["pane"]],
      }],
      metadata: {}, processMetadata: {}, processMetadataAvailable: false,
      lastOutputBySession: {}, skipLivenessFilter: true, now: 1,
      readTail: async (sessionId) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        if (sessionId === "s2") throw new Error("unavailable");
        return [sessionId];
      },
    };
    const result = await scanGroupingContext(source);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(result.tabs.map((tab) => tab.id)).toEqual(ids);
    expect(result.tabs[2].tail).toEqual([]);
    expect(result.tabs[18].tail).toEqual(["s18"]);
  });
});
