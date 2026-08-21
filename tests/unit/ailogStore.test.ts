import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

vi.mock("../../src/lib/ailog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ailog")>()),
  ailogIndexStart: vi.fn(), ailogIndexStatus: vi.fn(),
  ailogSessionDetail: vi.fn(), ailogSessionSummarize: vi.fn(), ailogSummarizeStatus: vi.fn(),
}));

import { ailogIndexStart, ailogIndexStatus, ailogSessionDetail, ailogSessionSummarize, ailogSummarizeStatus, emptyFilters } from "../../src/lib/ailog";
import { __resetAilogStoreForTests, invalidateAilogCaches, jobDisplayError, selectionFilters, useAilogStore } from "../../src/stores/ailogStore";

const indexStatus = (lastError: string | null, running = false) => ({ running, filesDone: 0, filesTotal: 0, sessions: 0, lastFinishedAt: 1, lastError });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((res) => { resolve = res; }); return { promise, resolve }; }
function totals(costUsd: number, userMessages: number) { return { sessions: 1, turns: userMessages, userMessages, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd, wallMs: 1, activeMs: 1, projects: 1, models: 1 }; }
function dashboard(from: number, to: number, costUsd: number, userMessages: number) {
  return { overview: { range: { from, to, label: "test" }, totals: totals(costUsd, userMessages) }, series: {}, models: {}, projects: {}, sessions: {} };
}

describe("AI log store U0", () => {
  beforeEach(() => { __resetAilogStoreForTests(); invokeMock.mockReset().mockResolvedValue({}); vi.mocked(ailogIndexStart).mockReset(); vi.mocked(ailogIndexStatus).mockReset(); vi.mocked(ailogSessionDetail).mockReset(); vi.mocked(ailogSessionSummarize).mockReset(); vi.mocked(ailogSummarizeStatus).mockReset(); });
  afterEach(__resetAilogStoreForTests);

  it("keeps an action failure when its following status refresh succeeds", async () => {
    vi.mocked(ailogIndexStart).mockRejectedValue(new Error("start failed"));
    await useAilogStore.getState().startIndex(false);
    vi.mocked(ailogIndexStatus).mockResolvedValue(indexStatus(null));
    await useAilogStore.getState().refreshIndexStatus();
    expect(useAilogStore.getState().index.actionError).toContain("start failed");
    expect(jobDisplayError(useAilogStore.getState().index)).toContain("start failed");
  });

  it("dismisses a background failure and clears the dismissal when a new run starts", async () => {
    vi.mocked(ailogIndexStatus).mockResolvedValue(indexStatus("old failure"));
    await useAilogStore.getState().refreshIndexStatus();
    useAilogStore.getState().dismissIndexError();
    expect(jobDisplayError(useAilogStore.getState().index)).toBeNull();
    vi.mocked(ailogIndexStart).mockResolvedValue({ started: true, alreadyRunning: false });
    vi.mocked(ailogIndexStatus).mockResolvedValue(indexStatus(null, true));
    await useAilogStore.getState().startIndex(false);
    expect(useAilogStore.getState().index.dismissedError).toBeNull();
  });

  it("starts at most one individual summary while its first request is pending", async () => {
    const pending = deferred<void>();
    vi.mocked(ailogSessionSummarize).mockReturnValue(pending.promise);
    vi.mocked(ailogSessionDetail).mockResolvedValue({} as any);
    vi.mocked(ailogSummarizeStatus).mockResolvedValue({ running: false, sessionsDone: 0, sessionsTotal: 0, sessionsRemaining: 0, lastFinishedAt: 0, lastError: null, elapsedMs: 0, estimatedInputChars: 0, inputTokens: 0, outputTokens: 0 });
    const first = useAilogStore.getState().summarizeSession("codex", "same");
    await useAilogStore.getState().summarizeSession("codex", "same");
    expect(ailogSessionSummarize).toHaveBeenCalledOnce();
    pending.resolve();
    await first;
  });

  it("does not restore a detail that closed while its individual summary was running", async () => {
    const pending = deferred<void>();
    vi.mocked(ailogSessionSummarize).mockReturnValue(pending.promise);
    vi.mocked(ailogSessionDetail).mockResolvedValue({} as any);
    vi.mocked(ailogSummarizeStatus).mockResolvedValue({ running: false, sessionsDone: 0, sessionsTotal: 0, sessionsRemaining: 0, lastFinishedAt: 0, lastError: null, elapsedMs: 0, estimatedInputChars: 0, inputTokens: 0, outputTokens: 0 });
    useAilogStore.setState({ detailKey: { kind: "codex", sessionId: "stale" } });
    const run = useAilogStore.getState().summarizeSession("codex", "stale");
    useAilogStore.getState().closeDetail();
    pending.resolve();
    await run;
    expect(ailogSessionDetail).not.toHaveBeenCalled();
    expect(useAilogStore.getState().detailKey).toBeNull();
    expect(useAilogStore.getState().detail).toBeNull();
  });

  it("sends options.groupBy on refreshUsage", async () => {
    useAilogStore.getState().setUsageSeriesAxis("model_raw");
    await useAilogStore.getState().refreshUsage();
    const seriesCall = invokeMock.mock.calls.find((call) => call[0] === "ailog_series");
    expect(seriesCall?.[1]).toMatchObject({ options: { groupBy: "model_raw" } });
  });

  it("sends project groupBy directly and derives family granularity", async () => {
    useAilogStore.getState().setUsageSeriesAxis("project");
    expect(useAilogStore.getState().granularity).toBe("family");
    await useAilogStore.getState().refreshUsage();
    const seriesCall = invokeMock.mock.calls.find((call) => call[0] === "ailog_series");
    expect(seriesCall?.[1]).toMatchObject({ options: { groupBy: "project" } });
  });

  it("sends pivot rowBy/colBy and auto-switches a duplicate axis", async () => {
    useAilogStore.getState().setPivotRowBy("model_raw");
    expect(useAilogStore.getState().pivotRowBy).toBe("model_raw");
    expect(useAilogStore.getState().pivotColBy).toBe("project");
    await Promise.resolve();
    const pivotCall = invokeMock.mock.calls.find((call) => call[0] === "ailog_pivot");
    expect(pivotCall?.[1]).toMatchObject({ options: { rowBy: "model_raw", colBy: "project" } });
  });

  it("sends filters.includeSidechain rather than snake_case", async () => {
    useAilogStore.getState().setIncludeSidechain(true);
    await useAilogStore.getState().refreshUsage();
    const seriesCall = invokeMock.mock.calls.find((call) => call[0] === "ailog_series");
    const filters = (seriesCall?.[1] as { filters: Record<string, unknown> } | undefined)?.filters;
    expect(filters).toMatchObject({ includeSidechain: true });
    expect(filters).not.toHaveProperty("include_sidechain");
  });

  it("loads the strictly adjacent prior range once and reuses it while range and filters stay unchanged", async () => {
    invokeMock.mockImplementation((command: string, args: { range: { preset?: string; from?: number; to?: number } }) => {
      if (command !== "ailog_dashboard") return {};
      if (args.range.preset === "30d") return dashboard(100, 199, 30, 20);
      expect(args.range).toEqual({ from: 0, to: 99 });
      return dashboard(0, 99, 10, 10);
    });

    await useAilogStore.getState().refresh();
    await useAilogStore.getState().refresh();

    const dashboardCalls = invokeMock.mock.calls.filter(([command]) => command === "ailog_dashboard");
    expect(dashboardCalls).toHaveLength(2);
    expect(useAilogStore.getState().previousTotals).toEqual(totals(10, 10));
  });

  it("does not fetch rework rankings from loadUsage and caches a later open", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "ailog_rework_rankings") return { failedCommands: [], rewrittenFiles: [] };
      if (command === "ailog_dashboard") return dashboard(100, 199, 30, 20);
      return {};
    });

    await useAilogStore.getState().loadUsage();
    expect(invokeMock.mock.calls.filter(([command]) => command === "ailog_rework_rankings")).toHaveLength(0);

    await useAilogStore.getState().refreshReworkRankings();
    await useAilogStore.getState().refreshReworkRankings();
    expect(invokeMock.mock.calls.filter(([command]) => command === "ailog_rework_rankings")).toHaveLength(1);
    expect(useAilogStore.getState().reworkRankings).toEqual({ failedCommands: [], rewrittenFiles: [] });
  });

  it("scopes a rework-rankings failure to that section", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "ailog_rework_rankings") return Promise.reject(new Error("rankings down"));
      return {};
    });
    await useAilogStore.getState().refreshReworkRankings();
    expect(useAilogStore.getState().reworkRankings).toBeNull();
    expect(useAilogStore.getState().reworkRankingsError).toContain("rankings down");
    expect(useAilogStore.getState().dashboardError).toBeNull();
    expect(useAilogStore.getState().usageError).toBeNull();
  });

  it("hides change data for all time and when the non-fatal prior request fails", async () => {
    invokeMock.mockImplementation((command: string, args: { range: { preset?: string; from?: number } }) => {
      if (command !== "ailog_dashboard") return {};
      if (args.range.preset === "all") return dashboard(100, 199, 30, 20);
      if (args.range.preset === "30d") return dashboard(100, 199, 30, 20);
      return Promise.reject(new Error("prior unavailable"));
    });

    useAilogStore.getState().setPreset("all");
    await useAilogStore.getState().refresh();
    expect(useAilogStore.getState().previousTotals).toBeNull();
    expect(invokeMock.mock.calls.filter(([command]) => command === "ailog_dashboard")).toHaveLength(1);

    useAilogStore.getState().setPreset("30d");
    await useAilogStore.getState().refresh();
    expect(useAilogStore.getState().overview?.totals).toEqual(totals(30, 20));
    expect(useAilogStore.getState().dashboardError).toBeNull();
    expect(useAilogStore.getState().previousTotals).toBeNull();
  });

  it("does not clear rankings when the current preset is selected again", () => {
    const report = { failedCommands: [], rewrittenFiles: [] };
    useAilogStore.setState({ reworkRankings: report, reworkRankingsLoading: false, preset: "30d" });
    useAilogStore.getState().setPreset("30d");
    expect(useAilogStore.getState().preset).toBe("30d");
    expect(useAilogStore.getState().reworkRankings).toBe(report);
  });

  it("keeps rankings until a custom range is valid", () => {
    const report = { failedCommands: [], rewrittenFiles: [] };
    useAilogStore.setState({ reworkRankings: report, preset: "30d", customFrom: "", customTo: "" });
    useAilogStore.getState().setPreset("custom");
    expect(useAilogStore.getState().reworkRankings).toBe(report);
    useAilogStore.getState().setCustomRange("2026-01-01", "");
    expect(useAilogStore.getState().reworkRankings).toBe(report);
    useAilogStore.getState().setCustomRange("2026-01-01", "2026-01-31");
    expect(useAilogStore.getState().reworkRankings).toBeNull();
  });

  it("drops a rework ranking response that started before cache invalidation", async () => {
    const first = deferred<{ failedCommands: { name: string }[]; rewrittenFiles: unknown[] }>();
    invokeMock.mockImplementation((command: string) => {
      if (command === "ailog_rework_rankings") return first.promise;
      return {};
    });
    const pending = useAilogStore.getState().refreshReworkRankings();
    invalidateAilogCaches();
    first.resolve({ failedCommands: [{ name: "stale" }], rewrittenFiles: [] });
    await pending;
    expect(useAilogStore.getState().reworkRankings).toBeNull();
  });

  it("force-refreshes open rankings from loadUsage and does not fetch while closed", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "ailog_rework_rankings") return { failedCommands: [], rewrittenFiles: [] };
      if (command === "ailog_dashboard") return dashboard(100, 199, 30, 20);
      return {};
    });
    await useAilogStore.getState().loadUsage({ force: true });
    expect(invokeMock.mock.calls.filter(([command]) => command === "ailog_rework_rankings")).toHaveLength(0);

    useAilogStore.getState().setReworkRankingsOpen(true);
    await useAilogStore.getState().loadUsage({ force: true });
    expect(invokeMock.mock.calls.filter(([command]) => command === "ailog_rework_rankings")).toHaveLength(1);
  });
});

describe("selectionFilters", () => {
  it("puts model and project on the filters together", () => {
    const filters = selectionFilters(emptyFilters(), {
      model: { key: "gpt-5.6-sol", label: "gpt-5.6-sol" },
      project: { key: "mycmux", label: "mycmux" },
    });
    expect(filters.models).toEqual(["gpt-5.6-sol"]);
    expect(filters.projects).toEqual(["mycmux"]);
  });

  it("puts a model-only selection on models", () => {
    const filters = selectionFilters(emptyFilters(), {
      model: { key: "gpt-5.6-sol", label: "gpt-5.6-sol" },
    });
    expect(filters.models).toEqual(["gpt-5.6-sol"]);
    expect(filters.projects).toEqual([]);
  });

  it("puts a project-only selection on projects", () => {
    const filters = selectionFilters(emptyFilters(), {
      project: { key: "mycmux", label: "mycmux" },
    });
    expect(filters.models).toEqual([]);
    expect(filters.projects).toEqual(["mycmux"]);
  });

  it("passes filters through when selection is null", () => {
    const base = emptyFilters();
    expect(selectionFilters(base, null)).toBe(base);
  });
});
