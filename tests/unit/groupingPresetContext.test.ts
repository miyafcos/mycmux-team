// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({
  process: {} as Record<string, unknown>, output: {} as Record<string, number>,
  roleChoice: "unspecified",
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "agent_session_titles") return [];
    if (command === "run_jev_grouping_judge") {
      const payload = JSON.parse(args!.prompt as string);
      const answers: Record<string, unknown> = {};
      for (const request of payload.requests) for (const [key, question] of Object.entries(request.questions)) {
        const criteria = (question as { criteria: Record<string, string> }).criteria;
        answers[key] = { type: "choice", choice: harness.roleChoice, confidence: 1,
          probabilities: Object.fromEntries(Object.keys(criteria).map(name => [name, Number(name === harness.roleChoice)])) };
      }
      return JSON.stringify({ answers });
    }
    return true;
  }),
}));
vi.mock("@tauri-apps/api/core", async importOriginal => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()), invoke: harness.invoke,
}));
vi.mock("../../src/lib/ipc", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/lib/ipc")>()),
  getPtyMetadataSnapshot: vi.fn(async () => harness.process),
  getSessionOutputSnapshot: vi.fn(async () => harness.output),
}));

import {
  buildGroupingPrompt, groupingPromptPayload, parseGroupingOutput, runGroupingAnalysis, scanGroupingContext,
  readGroupingPreset, GROUPING_PRESET_STORAGE_KEY, type GroupingScan, type GroupingScanSource,
} from "../../src/components/layout/tabGrouping";
import { GROUPING_STRATEGY_ORDER, orderGroupingPlansForDisplay } from "../../src/components/layout/TabGroupingPanel";
import { buildLocalGroupingAnalysis, buildPresetGroupingPlan } from "../../src/components/layout/groupingLocalPlan";
import { buildJevRoleRequests } from "../../src/components/layout/jevGroupingDecisions";
import { tabGroupingStrings } from "../../src/components/dashboard/dashboardStrings";
import {
  __resetGroupingPrecomputeForTests, groupingEvidencePrompt, groupingFingerprints,
  generateForegroundGroupingAnalysis, rememberGroupingAnalysis, peekGroupingPrecompute,
} from "../../src/lib/groupingPrecompute";
import { useSessionAttentionStore, type SessionAttention } from "../../src/stores/sessionAttentionStore";
import { useAskQuestionStore } from "../../src/stores/askQuestionStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useLauncherDirsStore } from "../../src/stores/launcherDirsStore";
import { useAiSettingsStore } from "../../src/stores/aiSettingsStore";
import { useJevSettingsStore } from "../../src/stores/jevSettingsStore";
import type { Workspace } from "../../src/types";

const NOW = Date.now();
const EMPTY = { working: false, waiting: null, unreadCompletion: false };
function attention(overrides: Partial<SessionAttention> = {}): SessionAttention {
  return { sessionId: "session-a", sessionEpoch: 1, attentionId: "event-1", kind: "none", detail: null,
    sessionRevision: 1, uiState: "idle", stateSince: NOW, occurrenceOrder: 1, ...overrides };
}
function workspace(ids = ["a"]): Workspace {
  const tabs = ids.map(id => ({ id, sessionId: `session-${id}`, agentId: "shell-starter", type: "terminal" as const,
    label: `作業${id}`, origin: { kind: "human" as const } }));
  return { id: "source", name: "作業机", gridTemplateId: "1x1", status: "running", createdAt: NOW,
    panes: [{ id: "pane", agentId: "shell-starter", sessionId: tabs[0].sessionId, activeTabId: tabs[0].id, tabs }], splitColumns: [["pane"]] };
}
function source(overrides: Partial<GroupingScanSource> = {}): GroupingScanSource {
  return { workspaces: [workspace()], metadata: {}, processMetadata: { "session-a": { process_status: "codex" } } as GroupingScanSource["processMetadata"],
    processMetadataAvailable: true, lastOutputBySession: {}, readTail: async () => [], now: NOW, ...overrides };
}
async function workingScan(): Promise<GroupingScan> {
  return scanGroupingContext(source({ attentionBySession: { "session-a": attention({ uiState: "working" }) } }));
}
beforeEach(() => {
  harness.invoke.mockClear();
  harness.process = { "session-a": { process_status: "codex" } };
  harness.output = {};
  harness.roleChoice = "unspecified";
  localStorage.clear();
  __resetGroupingPrecomputeForTests();
  useSessionAttentionStore.getState().resetForTests();
  useAskQuestionStore.getState().resetForTests();
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
});
afterEach(() => {
  __resetGroupingPrecomputeForTests();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("grouping attention scan", () => {
  it.each([
    ["working", { uiState: "working" }, { ...EMPTY, working: true }],
    ["input", { kind: "input", uiState: "waiting" }, { ...EMPTY, waiting: "input" }],
    ["approval", { kind: "approval", uiState: "waiting" }, { ...EMPTY, waiting: "approval" }],
    ["error", { kind: "error" }, { ...EMPTY, waiting: "error" }],
    ["rate_limited", { kind: "rate_limited" }, { ...EMPTY, waiting: "rate_limited" }],
    ["unread completion", { kind: "done", uiState: "done" }, { ...EMPTY, unreadCompletion: true }],
    ["none", {}, EMPTY],
  ] as const)("maps %s from the canonical attention store", async (_name, state, expected) => {
    useSessionAttentionStore.setState({ attentionBySession: { "session-a": attention(state) } });
    const canonical = useSessionAttentionStore.getState();
    const scan = await scanGroupingContext(source({ attentionBySession: canonical.attentionBySession, seenAttentionByTab: canonical.seenAttentionByTab }));
    expect(scan.tabs[0].attention).toEqual(expected);
  });

  it("uses metadata working status even when canonical attention is idle", async () => {
    const scan = await scanGroupingContext(source({ metadata: { "session-a": { agentStatus: "working" } }, attentionBySession: { "session-a": attention() } }));
    expect(scan.tabs[0].attention).toEqual({ ...EMPTY, working: true });
  });

  it("maps a detected question screen and a stopped question using the sweep predicate", async () => {
    useAskQuestionStore.getState().setStopReason("session-a", "needs_confirmation");
    let scan = await scanGroupingContext(source({ questionsBySession: useAskQuestionStore.getState().bySession }));
    expect(scan.tabs[0].attention?.waiting).toBe("question");
    scan = await scanGroupingContext(source({ questionsBySession: { "session-a": { screen: {} as never, stopReason: null } } }));
    expect(scan.tabs[0].attention?.waiting).toBe("question");
    scan = await scanGroupingContext(source({ questionsBySession: { "session-a": { screen: null, stopReason: null } } }));
    expect(scan.tabs[0].attention).toEqual(EMPTY);
  });

  it("uses tab-specific seen IDs for completion and rejects a completion without an occurrence ID", async () => {
    const seen = new Map([["a", "event-1"]]);
    let scan = await scanGroupingContext(source({ attentionBySession: { "session-a": attention({ kind: "done" }) }, seenAttentionByTab: seen }));
    expect(scan.tabs[0].attention?.unreadCompletion).toBe(false);
    scan = await scanGroupingContext(source({ attentionBySession: { "session-a": attention({ kind: "done", attentionId: "event-2" }) }, seenAttentionByTab: seen }));
    expect(scan.tabs[0].attention?.unreadCompletion).toBe(true);
    scan = await scanGroupingContext(source({ attentionBySession: { "session-a": attention({ kind: "done", attentionId: null }) } }));
    expect(scan.tabs[0].attention?.unreadCompletion).toBe(false);
  });

  it("defaults injected legacy sources to no attention without reading unrelated store state", async () => {
    useSessionAttentionStore.setState({ attentionBySession: { "session-a": attention({ uiState: "working" }) } });
    expect((await scanGroupingContext(source())).tabs[0].attention).toEqual(EMPTY);
  });

  it("loads real default store attention/questions and backend output snapshots", async () => {
    useWorkspaceListStore.setState({ workspaces: [workspace()], layoutRevision: useWorkspaceListStore.getState().layoutRevision + 1 });
    useSessionAttentionStore.setState({ attentionBySession: { "session-a": attention({ kind: "done" }) } });
    useAskQuestionStore.getState().setStopReason("session-a", "needs_confirmation");
    harness.output = { "session-a": NOW - 1000 };
    const scan = await scanGroupingContext();
    expect(scan.tabs[0].attention).toEqual({ ...EMPTY, waiting: "question", unreadCompletion: true });
    expect(scan.tabs[0].lastOutputAt).toBe(NOW - 1000);
  });
});

describe("strategy payloads and full-plan compatibility", () => {
  it("defines both strategies, their labels, descriptions, and display order", async () => {
    expect(GROUPING_STRATEGY_ORDER).toEqual(["active_watch", "main_sessions", "minimal_move", "project", "role", "mixed"]);
    expect(tabGroupingStrings.strategyActiveWatch).toBe("稼働中だけ");
    expect(tabGroupingStrings.strategyMainSessions).toBe("メインだけ");
    expect(tabGroupingStrings.strategyActiveWatchDescription).toContain("次の返事待ち");
    expect(tabGroupingStrings.strategyMainSessionsDescription).toContain("2〜3本");
    const scan = await workingScan();
    const plans = GROUPING_STRATEGY_ORDER.map(strategy => ({ ...buildPresetGroupingPlan(scan, "active_watch"), strategy, planId: strategy }));
    expect(orderGroupingPlansForDisplay([...plans].reverse()).map(plan => plan.strategy)).toEqual([...GROUPING_STRATEGY_ORDER]);
    expect(orderGroupingPlansForDisplay(plans, "main_sessions")[0].strategy).toBe("main_sessions");
  });

  it.each(["active_watch", "main_sessions"] as const)("includes %s and attention in the payload and prompt", async strategy => {
    const scan = await workingScan();
    const payload = groupingPromptPayload(scan, strategy);
    expect(payload.requested_strategy).toBe(strategy);
    expect(payload.tabs[0].attention).toEqual({ ...EMPTY, working: true });
    const prompt = buildGroupingPrompt(scan, payload);
    expect(prompt).toContain(`requested_strategy=${strategy}`);
    expect(prompt).toContain("1本目の案は必ずこの strategy");
    expect(prompt).toContain("attention.unreadCompletion");
    expect(prompt).toContain("直近5分");
    expect(prompt).toContain("origin.kind=human");
    expect(prompt).toContain("母艦の役割");
    expect(prompt).toContain("同名ワークスペース");
  });

  it("parses and round-trips both new strategies without tightening the existing output rules", async () => {
    const scan = await workingScan();
    const plans = [buildPresetGroupingPlan(scan, "active_watch"), buildPresetGroupingPlan(scan, "main_sessions")];
    const raw = JSON.stringify({ schemaVersion: 1, plans });
    const parsed = Reflect.apply(parseGroupingOutput, undefined,
      [raw, ["a"], ["source"], ["作業机"], undefined, plans]) as ReturnType<typeof parseGroupingOutput>;
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") throw new Error("Parse failed");
    expect(parsed.plans).toEqual(plans);
    expect(parsed.comparisonInsufficient).toBe(false);
    const model = parseGroupingOutput(raw, ["a"], ["source"], ["作業机"]);
    expect(model.status).toBe("ok");
    if (model.status !== "ok") throw new Error("Model parse failed");
    for (const plan of model.plans) expect(plan.groups[0].destination).not.toHaveProperty("nameEdited");
    const existing = plans.map((plan, index) => ({ ...plan, strategy: index === 0 ? "minimal_move" : "project" }));
    expect(parseGroupingOutput(JSON.stringify({ schemaVersion: 1, plans: existing }), ["a"], ["source"]).status).toBe("ok");
  });

  it("keeps requested_strategy and restores IDs through full-plan validation and retry", async () => {
    const scan = await workingScan();
    const prompts: string[] = [];
    const judge = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      if (prompts.length === 1) return "{}";
      const payload = JSON.parse(prompt.split("\n").at(-1)!);
      const plans = ["active_watch", "project"].map((strategy, index) => ({
        planId: `plan-${index}`, title: "確認案", rationale: "検証", strategy,
        groups: [{ groupId: `group-${index}`, title: "今のまま", disposition: "keep", destination: { kind: "current_locations" },
          layout: null, tabIds: payload.tabs.map((tab: { id: string }) => tab.id) }], unassignedTabIds: [], warnings: [],
      }));
      return JSON.stringify({ schemaVersion: 1, plans });
    });
    const result = await runGroupingAnalysis({ scan: async () => scan, judge, requestId: () => `request-${prompts.length}`, requestedStrategy: "active_watch" });
    expect(result.retried).toBe(true);
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) expect(JSON.parse(prompt.split("\n").at(-1)!).requested_strategy).toBe("active_watch");
    expect(result.parsed.status).toBe("ok");
    if (result.parsed.status !== "ok") throw new Error("Parse failed");
    expect(result.parsed.plans[0].groups[0].tabIds).toEqual(["a"]);
  });

  it("falls back to recommended if reading storage throws", () => {
    localStorage.setItem(GROUPING_PRESET_STORAGE_KEY, "active_watch");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    expect(readGroupingPreset()).toBe("recommended");
  });
});

describe("evidence production integration", () => {
  it("forwards context with absolute pane indices across role batches and retains the decision schema", async () => {
    const ids = Array.from({ length: 49 }, (_, index) => `tab-${index}`);
    const scan = await scanGroupingContext(source({ workspaces: [workspace(ids)], skipLivenessFilter: true,
      attentionBySession: { "session-tab-48": attention({ uiState: "working" }) }, lastOutputBySession: { "session-tab-48": NOW - 1000 } }));
    const requests = buildJevRoleRequests(scan);
    expect(requests).toHaveLength(2);
    const payload = JSON.parse(groupingEvidencePrompt(JSON.stringify({ requests }), scan, "main_sessions"));
    expect(payload.requested_strategy).toBe("main_sessions");
    expect(payload.requests[1].state.requested_strategy).toBe("main_sessions");
    expect(payload.requests[1].state.panes.pane_48.attention.working).toBe(true);
    expect(payload.requests[1].state.panes.pane_48.lastOutputAt).toBe(NOW - 1000);
    expect(payload.requests[0].state.panes.pane_0.attention).toEqual(EMPTY);
    expect(payload.requests.map((request: { questions: unknown }) => request.questions)).toEqual(requests.map(request => request.questions));
    expect(payload.requests[0].state.grouping_context.instructions.join("\n")).toContain("1本目の案は必ずこの strategy");
  });

  it("treats attention as exact freshness rather than a layout change", async () => {
    const scan = await workingScan();
    const changed = structuredClone(scan);
    changed.tabs[0].attention = { ...EMPTY, waiting: "approval" };
    expect(groupingFingerprints(changed).structural).toBe(groupingFingerprints(scan).structural);
    expect(groupingFingerprints(changed).exact).not.toBe(groupingFingerprints(scan).exact);
  });

  it.each(["active_watch", "main_sessions"] as const)("uses real %s production flow without changing the recommended cache", async strategy => {
    useWorkspaceListStore.setState({ workspaces: [workspace()], layoutRevision: useWorkspaceListStore.getState().layoutRevision + 1 });
    useSessionAttentionStore.setState({ attentionBySession: { "session-a": attention({ uiState: "working" }) } });
    useLauncherDirsStore.setState({ view: { doc: { entries: [] } } as never });
    useAiSettingsStore.setState({ aiEnabled: true });
    useJevSettingsStore.setState({ enabled: true, loaded: true });
    const recommended = buildLocalGroupingAnalysis(await workingScan(), {})!;
    rememberGroupingAnalysis(recommended);
    const produced = await generateForegroundGroupingAnalysis(true, undefined, strategy);
    expect(produced.kind).toBe("ready");
    if (produced.kind !== "ready" || produced.analysis.parsed.status !== "ok") throw new Error("No ready result");
    expect(produced.analysis.parsed.plans).toHaveLength(3);
    expect(produced.analysis.parsed.plans[0].strategy).toBe(strategy);
    const request = harness.invoke.mock.calls.find(([command]) => command === "run_jev_grouping_judge");
    expect(request).toBeDefined();
    const payload = JSON.parse(request![1]!.prompt as string);
    expect(payload.requests[0].state.requested_strategy).toBe(strategy);
    expect(payload.requests[0].state.panes.pane_0.attention.working).toBe(true);
    const cached = peekGroupingPrecompute();
    expect(cached.kind).toBe("fresh");
    if (cached.kind !== "fresh") throw new Error("Cache changed");
    expect(cached.analysis).toBe(recommended);
  });

  it.each(["active_watch", "main_sessions"] as const)("retains changed AI roles in the %s production result without replacing the recommendation cache", async strategy => {
    const layout = workspace(["a", "b"]);
    for (const tab of layout.panes[0].tabs) tab.cwd = "/work/sample";
    useWorkspaceListStore.setState({ workspaces: [layout], layoutRevision: useWorkspaceListStore.getState().layoutRevision + 1 });
    harness.process = { "session-a": { process_status: "codex" }, "session-b": { process_status: "codex" } };
    useSessionAttentionStore.setState({ attentionBySession: { "session-a": attention({ uiState: "working" }) } });
    useLauncherDirsStore.setState({ view: { doc: { entries: [{ section: "開発", label: "架空案件", path: "/work/sample" }] } } as never });
    useAiSettingsStore.setState({ aiEnabled: true });
    useJevSettingsStore.setState({ enabled: true, loaded: true });
    const recommended = buildLocalGroupingAnalysis(await scanGroupingContext(), {})!;
    const originalRecommended = structuredClone(recommended);
    rememberGroupingAnalysis(recommended);
    let firstPreset: unknown;
    let firstRole: unknown;
    for (const [choice, label] of [["review", "確認・判断"], ["worker", "制作・実装"]]) {
      harness.roleChoice = choice;
      const produced = await generateForegroundGroupingAnalysis(true, undefined, strategy);
      if (produced.kind !== "ready" || produced.analysis.parsed.status !== "ok") throw new Error("No ready result");
      const plans = produced.analysis.parsed.plans;
      expect(plans.map(plan => plan.strategy)).toEqual([strategy, "role", "minimal_move"]);
      expect(plans[1].groups.find(group => group.disposition === "reorganize")?.title).toContain(label);
      if (firstRole !== undefined) {
        expect(plans[1]).not.toEqual(firstRole);
        expect(plans[0]).toEqual(firstPreset);
      }
      firstPreset = structuredClone(plans[0]);
      firstRole = structuredClone(plans[1]);
      const cached = peekGroupingPrecompute();
      if (cached.kind !== "fresh") throw new Error("Recommendation cache changed");
      expect(cached.analysis).toBe(recommended);
      expect(recommended).toEqual(originalRecommended);
    }
    expect(harness.invoke.mock.calls.filter(([command]) => command === "run_jev_grouping_judge")).toHaveLength(2);
  });
});
