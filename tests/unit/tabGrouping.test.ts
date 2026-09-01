import { describe, expect, it, vi } from "vitest";
import type { PtyMetadataSnapshot } from "../../src/lib/ipc";
import type { Workspace } from "../../src/types";
import {
  buildGroupingPrompt,
  formatGroupingAiNote,
  groupingPromptPayload,
  isJapaneseGroupingName,
  lineageClustersFromTabs,
  parseGroupingOutput,
  scanGroupingContext,
  TAB_GROUPING_TAIL_LINES,
  type GroupingScan,
  type GroupingScanSource,
  type GroupingTab,
} from "../../src/components/layout/tabGrouping";
import { TAB_NAMING_TAIL_LINES } from "../../src/components/layout/tabSweep";

const NOW = 1_800_000_000_000;
const liveProcess = { process_status: "claude" } as PtyMetadataSnapshot[string];

function tab(id: string, overrides: Partial<Workspace["panes"][number]["tabs"][number]> = {}) {
  return {
    id,
    sessionId: `session-${id}`,
    agentId: "shell-starter",
    type: "terminal" as const,
    label: `ラベル${id}`,
    cwd: `C:/work/${id}`,
    ...overrides,
  };
}

function workspace(id: string, name: string, panes: Workspace["panes"]): Workspace {
  return {
    id,
    name,
    gridTemplateId: "1x1",
    status: "running",
    createdAt: NOW,
    panes,
    splitColumns: [panes.map((pane) => pane.id)],
  };
}

function groupingTab(id: string, overrides: Partial<GroupingTab> = {}): GroupingTab {
  return {
    id,
    sessionId: `session-${id}`,
    label: id,
    cwd: `C:/work/${id}`,
    agentKind: "claude",
    workspaceId: "ws-a",
    workspaceName: "母艦",
    paneId: "pane-1",
    column: 1,
    lastOutputAt: NOW,
    tail: ["作業中"],
    ...overrides,
  };
}

function source(overrides: Partial<GroupingScanSource> = {}): GroupingScanSource {
  return {
    workspaces: [],
    metadata: {},
    processMetadata: {},
    processMetadataAvailable: true,
    lastOutputBySession: {},
    readTail: async () => ["作業の本文", "❯"],
    now: NOW,
    ...overrides,
  };
}

function validPlanJson(tabIds: string[], extra?: Record<string, unknown>) {
  const [first, second, ...rest] = tabIds;
  return {
    schemaVersion: 1,
    plans: [
      {
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
            layout: {
              columns: [{ panes: [{ title: "母艦", role: "mother", tabIds: [first] }] }],
            },
            tabIds: [first],
          },
          {
            groupId: "g-keep",
            title: "現状維持",
            disposition: "keep",
            destination: { kind: "current_locations" },
            layout: null,
            tabIds: [second, ...rest],
          },
        ],
        unassignedTabIds: [],
        warnings: [],
        ...extra,
      },
      {
        planId: "plan-b",
        title: "移動を少なく",
        rationale: "最小移動",
        strategy: "minimal_move",
        groups: [
          {
            groupId: "g-keep-all",
            title: "ほぼ現状",
            disposition: "keep",
            destination: { kind: "current_locations" },
            layout: null,
            tabIds,
          },
        ],
        unassignedTabIds: [],
        warnings: [],
      },
    ],
  };
}

describe("isJapaneseGroupingName", () => {
  it("accepts Japanese names and proper nouns, and rejects generic English", () => {
    expect(isJapaneseGroupingName("案件甲")).toBe(true);
    expect(isJapaneseGroupingName("クロード作業")).toBe(true);
    expect(isJapaneseGroupingName("Codex")).toBe(true);
    expect(isJapaneseGroupingName("国語課+雑務")).toBe(true);
    expect(isJapaneseGroupingName("fix")).toBe(false);
    expect(isJapaneseGroupingName("build review")).toBe(false);
    expect(isJapaneseGroupingName("")).toBe(false);
    expect(isJapaneseGroupingName("あ".repeat(21))).toBe(false);
  });
});

describe("lineageClustersFromTabs", () => {
  it("unions spawn parent links into deterministic clusters", () => {
    const clusters = lineageClustersFromTabs([
      groupingTab("child-b", { origin: { kind: "agent", parentTabId: "root" } }),
      groupingTab("root", { origin: { kind: "human" } }),
      groupingTab("child-a", { origin: { kind: "agent", parentTabId: "root" } }),
      groupingTab("alone", { origin: { kind: "human" } }),
    ]);
    expect(clusters).toEqual([
      { clusterId: "lineage-1", tabIds: ["child-a", "child-b", "root"] },
    ]);
  });
});

describe("scanGroupingContext", () => {
  it("scans every live terminal across workspaces and skips DEAD tabs", async () => {
    const scan = await scanGroupingContext(source({
      workspaces: [
        workspace("ws-a", "母艦", [{
          id: "pane-1",
          agentId: "shell-starter",
          sessionId: "session-live",
          activeTabId: "live",
          tabs: [
            tab("live", { origin: { kind: "human" } }),
            tab("dead", { sessionId: "session-dead" }),
            tab("browser", { type: "browser", sessionId: "session-browser" }),
          ],
        }]),
        workspace("ws-b", "案件", [{
          id: "pane-2",
          agentId: "shell-starter",
          sessionId: "session-child",
          activeTabId: "child",
          tabs: [tab("child", { origin: { kind: "agent", parentTabId: "live" } })],
        }]),
      ],
      processMetadata: {
        "session-live": liveProcess,
        "session-child": liveProcess,
      },
      lastOutputBySession: { "session-live": NOW - 1000 },
    }));
    expect(scan.tabs.map((item) => item.id)).toEqual(["live", "child"]);
    expect(scan.tabs[0]?.workspaceName).toBe("母艦");
    expect(scan.tabs[1]?.workspaceName).toBe("案件");
    expect(scan.lineageClusters).toEqual([
      { clusterId: "lineage-1", tabIds: ["child", "live"] },
    ]);
    expect(scan.baseline).toEqual([
      { tabId: "live", workspaceId: "ws-a", paneId: "pane-1", sessionId: "session-live" },
      { tabId: "child", workspaceId: "ws-b", paneId: "pane-2", sessionId: "session-child" },
    ]);
  });

  it("uses the measured twelve-line grouping tail without changing the naming tail", async () => {
    const tail = Array.from({ length: 14 }, (_, index) => `line-${index + 1}`);
    const readTail = vi.fn(async () => tail);
    const scan = await scanGroupingContext(source({
      workspaces: [workspace("ws-a", "母艦", [{
        id: "pane-1",
        agentId: "shell-starter",
        sessionId: "session-live",
        activeTabId: "live",
        tabs: [tab("live", { origin: { kind: "human" } })],
      }])],
      processMetadata: { "session-live": liveProcess },
      readTail,
    }));

    expect(TAB_GROUPING_TAIL_LINES).toBe(12);
    expect(TAB_NAMING_TAIL_LINES).toBe(14);
    expect(readTail).toHaveBeenCalledWith("session-live", 12);
    expect(scan.tabs[0]?.tail).toEqual(tail.slice(-12));
    expect(groupingPromptPayload(scan).tabs[0]?.tail).toEqual(tail.slice(-12));
    expect(formatGroupingAiNote("codex", "gpt-test", true)).toContain("末尾12行");
  });
});

describe("buildGroupingPrompt", () => {
  it("includes lineage, every workspace, and Japanese-only output rules", () => {
    const scan: GroupingScan = {
      scannedAt: NOW,
      tabs: [
        groupingTab("root", { workspaceId: "ws-a", workspaceName: "朝の母艦" }),
        groupingTab("child", {
          workspaceId: "ws-b",
          workspaceName: "案件机",
          origin: { kind: "agent", parentTabId: "root" },
        }),
      ],
      lineageClusters: [{ clusterId: "lineage-1", tabIds: ["child", "root"] }],
      baseline: [],
      workspaceIds: ["ws-a", "ws-b"],
      workspaces: [
        workspace("ws-a", "朝の母艦", []),
        workspace("ws-b", "案件机", []),
      ],
    };
    const prompt = buildGroupingPrompt(scan);
    expect(prompt).toContain("朝の母艦");
    expect(prompt).toContain("案件机");
    expect(prompt).toContain("lineage-1");
    expect(prompt).toContain("child");
    expect(prompt).toContain("root");
    expect(prompt).toContain("全ワークスペース");
    expect(prompt).toContain("日本語");
    expect(prompt).toContain("固有名詞");
    expect(prompt).toContain("3〜8タブ");
    expect(prompt).toContain("1案件=1ワークスペースに機械的に割らない");
    expect(prompt).toContain("レイアウトは列で分けます");
    expect(prompt).toContain("裏タブ");
    expect(prompt).toContain("別のワークスペースへ隔離");
    // Each of these earns its place from a measured failure of the answer:
    // a tab claimed by two groups (v3), a tab quietly dropped (v4/v5), and
    // half the columns stacked into rows the operator called hard to read.
    expect(prompt).toContain("2つ以上のグループに入れないでください");
    expect(prompt).toContain("省略せず unassignedTabIds に入れてください");
    expect(prompt).toContain("3分の1を超えないように");
    expect(prompt).toContain("親子関係は階層で表現");
    expect(prompt).toContain("コードフェンス");
    expect(prompt).toContain("schemaVersion");
    expect(formatGroupingAiNote("claude", "opus", true)).toContain("再配置案");
  });
});

function analysisScan(ids: string[]) {
  return {
    scannedAt: NOW,
    tabs: ids.map((id) => groupingTab(id)),
    lineageClusters: [],
    baseline: ids.map((id) => ({
      tabId: id,
      workspaceId: "ws-a",
      paneId: "pane-1",
      sessionId: `session-${id}`,
    })),
    workspaceIds: ["ws-a"],
    workspaces: [workspace("ws-a", "母艦", [])],
  };
}

function onePlanJson(ids: string[]) {
  const body = validPlanJson(ids);
  return { schemaVersion: 1, plans: [body.plans[0]] };
}

describe("runGroupingAnalysis", () => {
  it("retries once when the first response has fewer than two valid plans", async () => {
    const { runGroupingAnalysis } = await import("../../src/components/layout/tabGrouping");
    const ids = ["t1", "t2"];
    let calls = 0;
    const stages: string[] = [];
    const result = await runGroupingAnalysis({
      scan: async () => analysisScan(ids),
      requestId: () => `req-${++calls}`,
      onProgress: (stage) => stages.push(stage),
      judge: async () => {
        if (calls === 1) return "not-json";
        return JSON.stringify(validPlanJson(ids));
      },
    });
    expect(calls).toBe(2);
    expect(result.retried).toBe(true);
    expect(result.parsed.status).toBe("ok");
    expect(stages).toEqual(["scanning", "judging", "validating", "retrying", "validating"]);
  });

  it("does not retry when the judge rejects with a timeout error", async () => {
    const { runGroupingAnalysis } = await import("../../src/components/layout/tabGrouping");
    const timeout = { code: "timeout", detail: "tab sweep judge timed out after 300 seconds" };
    const judge = vi.fn(async () => Promise.reject(timeout));
    const requestId = vi.fn(() => "req-timeout");
    const stages: string[] = [];

    await expect(runGroupingAnalysis({
      scan: async () => analysisScan(["t1", "t2"]),
      requestId,
      judge,
      onProgress: (stage) => stages.push(stage),
    })).rejects.toBe(timeout);

    expect(judge).toHaveBeenCalledTimes(1);
    expect(requestId).toHaveBeenCalledTimes(1);
    expect(stages).toEqual(["scanning", "judging"]);
  });

  it("shows a single valid plan after retry and does not call a third time", async () => {
    const { runGroupingAnalysis } = await import("../../src/components/layout/tabGrouping");
    const ids = ["t1", "t2"];
    let calls = 0;
    const result = await runGroupingAnalysis({
      scan: async () => analysisScan(ids),
      requestId: () => `req-${++calls}`,
      judge: async () => JSON.stringify(onePlanJson(ids)),
    });
    expect(calls).toBe(2);
    expect(result.retried).toBe(true);
    expect(result.parsed.status).toBe("ok");
    if (result.parsed.status === "ok") {
      expect(result.parsed.plans).toHaveLength(1);
      expect(result.parsed.comparisonInsufficient).toBe(true);
    }
  });

  it("fails with raw output after a second invalid response and does not retry a third time", async () => {
    const { runGroupingAnalysis } = await import("../../src/components/layout/tabGrouping");
    const ids = ["t1", "t2"];
    let calls = 0;
    const result = await runGroupingAnalysis({
      scan: async () => analysisScan(ids),
      requestId: () => `req-${++calls}`,
      judge: async () => "not-json",
    });
    expect(calls).toBe(2);
    expect(result.parsed.status).toBe("invalid");
    expect(result.raw).toBe("not-json");
  });

  it("does not retry when the first response already has two valid plans", async () => {
    const { runGroupingAnalysis } = await import("../../src/components/layout/tabGrouping");
    const ids = ["t1", "t2"];
    let calls = 0;
    const stages: string[] = [];
    const result = await runGroupingAnalysis({
      scan: async () => analysisScan(ids),
      requestId: () => `req-${++calls}`,
      judge: async () => JSON.stringify(validPlanJson(ids)),
      onProgress: (stage) => stages.push(stage),
    });
    expect(calls).toBe(1);
    expect(result.retried).toBe(false);
    expect(result.parsed.status).toBe("ok");
    expect(stages).toEqual(["scanning", "judging", "validating"]);
  });
});

describe("parseGroupingOutput", () => {
  const ids = ["t1", "t2", "t3"];
  const workspaces = ["ws-a"];

  it("accepts two valid Japanese plans", () => {
    const parsed = parseGroupingOutput(JSON.stringify(validPlanJson(ids)), ids, workspaces);
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    expect(parsed.plans).toHaveLength(2);
    expect(parsed.comparisonInsufficient).toBe(false);
  });

  it("parks a tab the judge forgot instead of throwing the plan away", () => {
    // Measured on 2026-08-30: luna drops a tab or two once the prompt carries
    // enough shape rules, and every plan in the answer can lose the same one.
    // Discarding those plans means the operator waited ~110s for nothing, so a
    // forgotten tab now means what it already meant elsewhere: stay put.
    const missing = validPlanJson(ids);
    missing.plans[0].groups[0].layout!.columns[0].panes[0].tabIds = ["t1"];
    missing.plans[0].groups[0].tabIds = ["t1"];
    missing.plans[0].groups[1].tabIds = ["t2"];
    const result = parseGroupingOutput(JSON.stringify(missing), ids, workspaces);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const plan = result.plans.find((candidate) => candidate.planId === missing.plans[0].planId);
    expect(plan).toBeDefined();
    expect(plan?.unassignedTabIds).toContain("t3");
    expect(result.droppedPlans.some((issue) => issue.reason.includes("t3"))).toBe(false);
  });

  it("rejects code fences, duplicate tabs, unknown workspaces, and plan-count overflow", () => {
    expect(parseGroupingOutput("```json\n{}\n```", ids, workspaces).status).toBe("invalid");

    const duplicate = validPlanJson(ids);
    duplicate.plans[0].groups[0].layout!.columns[0].panes[0].tabIds = ["t1", "t1"];
    duplicate.plans[0].groups[0].tabIds = ["t1", "t1"];
    const duplicateResult = parseGroupingOutput(JSON.stringify(duplicate), ids, workspaces);
    expect(duplicateResult.status).toBe("ok");
    if (duplicateResult.status === "ok") {
      expect(duplicateResult.plans.map((plan) => plan.planId)).toEqual(["plan-b"]);
      expect(duplicateResult.droppedPlans.some((issue) => issue.reason.includes("出現回数"))).toBe(true);
      expect(duplicateResult.comparisonInsufficient).toBe(true);
    }

    const unknownWs = validPlanJson(ids);
    unknownWs.plans[0].groups[0].destination = { kind: "existing_workspace", workspaceId: "missing-ws" } as never;
    unknownWs.plans[0].groups[0].layout = {
      columns: [{ panes: [{ title: "合流", role: "mixed", tabIds: ["t1"] }] }],
    };
    const unknownResult = parseGroupingOutput(JSON.stringify(unknownWs), ids, workspaces);
    expect(unknownResult.status).toBe("ok");
    if (unknownResult.status === "ok") {
      expect(unknownResult.droppedPlans.some((issue) => issue.reason.includes("存在しない"))).toBe(true);
    }

    const overflow = validPlanJson(ids);
    overflow.plans.push(
      { ...overflow.plans[1], planId: "plan-c", title: "三案目" },
      { ...overflow.plans[1], planId: "plan-d", title: "四案目" },
    );
    expect(parseGroupingOutput(JSON.stringify(overflow), ids, workspaces).status).toBe("invalid");
  });

  it("accepts a single valid plan as comparison-insufficient instead of top-level invalid", () => {
    const parsed = parseGroupingOutput(JSON.stringify(onePlanJson(ids)), ids, workspaces);
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    expect(parsed.plans).toHaveLength(1);
    expect(parsed.comparisonInsufficient).toBe(true);
  });

  it("rejects isolated UTF-16 surrogates in groupId", () => {
    for (const groupId of ["\ud800", "\udc00"]) {
      const body = onePlanJson(ids);
      body.plans[0].groups[0].groupId = groupId;
      const parsed = parseGroupingOutput(JSON.stringify(body), ids, workspaces);
      expect(parsed.status).toBe("invalid");
      if (parsed.status === "invalid") {
        expect(parsed.issues.some((issue) => issue.reason.includes("groupId") && issue.reason.includes("Unicode"))).toBe(true);
      }
    }
  });

  it("drops plans that omit required fields or mix non-string ids", () => {
    const omittedLayout = validPlanJson(ids);
    delete (omittedLayout.plans[0].groups[1] as { layout?: unknown }).layout;
    const omitted = parseGroupingOutput(JSON.stringify(omittedLayout), ids, workspaces);
    expect(omitted.status).toBe("ok");
    if (omitted.status === "ok") {
      expect(omitted.plans.map((plan) => plan.planId)).toEqual(["plan-b"]);
    }

    const badRationale = validPlanJson(ids);
    (badRationale.plans[0] as { rationale: unknown }).rationale = 7;
    const rationaleResult = parseGroupingOutput(JSON.stringify(badRationale), ids, workspaces);
    expect(rationaleResult.status).toBe("ok");
    if (rationaleResult.status === "ok") {
      expect(rationaleResult.plans.map((plan) => plan.planId)).toEqual(["plan-b"]);
    }

    const mixedUnassigned = validPlanJson(ids);
    mixedUnassigned.plans[0].groups[1].tabIds = ["t2"];
    (mixedUnassigned.plans[0] as { unassignedTabIds: unknown }).unassignedTabIds = ["t3", 9];
    const mixed = parseGroupingOutput(JSON.stringify(mixedUnassigned), ids, workspaces);
    expect(mixed.status).toBe("ok");
    if (mixed.status === "ok") {
      expect(mixed.plans.map((plan) => plan.planId)).toEqual(["plan-b"]);
    }
  });

  it("rejects a new workspace name that collides with an existing workspace", () => {
    const colliding = validPlanJson(ids);
    colliding.plans[0].groups[0].destination = { kind: "new_workspace", proposedName: "母艦" };
    const parsed = parseGroupingOutput(JSON.stringify(colliding), ids, ["ws-a"], ["母艦"]);
    expect(parsed.status).toBe("ok");
    if (parsed.status === "ok") {
      expect(parsed.droppedPlans.some((issue) => issue.reason.includes("衝突"))).toBe(true);
      expect(parsed.plans.map((plan) => plan.planId)).toEqual(["plan-b"]);
    }
  });

  it("includes labelSource in the prompt payload", () => {
    const scan: GroupingScan = {
      scannedAt: NOW,
      tabs: [groupingTab("root", { labelSource: "user" })],
      lineageClusters: [],
      baseline: [],
      workspaceIds: ["ws-a"],
      workspaces: [workspace("ws-a", "朝の母艦", [])],
    };
    expect(buildGroupingPrompt(scan)).toContain("\"labelSource\":\"user\"");
    expect(buildGroupingPrompt(scan)).toContain("mother / worker / review / mixed / unspecified");
  });
});
