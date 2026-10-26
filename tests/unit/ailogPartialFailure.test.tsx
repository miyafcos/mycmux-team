// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("../../src/stores/ailogStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/stores/ailogStore")>();
  const hook = Object.assign(<Result,>(selector: (state: ReturnType<typeof actual.useAilogStore.getState>) => Result) => selector(actual.useAilogStore.getState()), actual.useAilogStore);
  return { ...actual, useAilogStore: hook };
});

import { HandoffTable } from "../../src/components/ailog/HandoffTable";
import { ReworkRankings } from "../../src/components/ailog/ReworkRankings";
import { ReportCacheStatus } from "../../src/components/ailog/ReportCacheStatus";
import { UsageView } from "../../src/components/ailog/UsageView";
import { formatLocalDateTime, type BreakdownReport, type HandoffsReport, type ModelsReport, type Overview, type PivotReport, type ReworkRankingsReport, type SeriesGroup, type SeriesReport, type SessionsReport } from "../../src/lib/ailog";
import { __resetAilogStoreForTests, invalidateAilogCaches, useAilogStore } from "../../src/stores/ailogStore";

const range = { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 4) - 1, label: "custom" };
const priceCoverage = {
  priced: { models: [], tokens: 0 }, local: { models: [], tokens: 0 },
  internal: { models: [], tokens: 0 }, flat: { models: [], tokens: 0 },
  reported: { models: [], tokens: 0 }, unknown: { models: [], tokens: 0 }, coveredTokenRatio: 1,
};
const totals = { sessions: 3, turns: 5, userMessages: 7, input: 123, output: 234, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 2, wallMs: 10, activeMs: 5, projects: 1, models: 1 };
const overview: Overview = {
  range, totals, comparePrevious: { sessionsPct: 0, costPct: 0, tokensPct: 0, reworkPct: 0 },
  topModels: [], mixedModelSessions: 0, topProjects: [], topTitles: [],
  rework: { avgScore: 0, toolErrorRate: 0, correctionHits: 0, churnFiles: 0, abandonedSessions: 0 },
  excludedInternal: { sessions: 0, costUsd: 0 }, cacheHitRate: 0, priceSource: "test",
  priceCoverage, indexFreshness: { lastIndexedAt: 0, staleFiles: 0 }, costNote: "",
};
function group(input = 123): SeriesGroup {
  return { group: "gpt-6.1-sol", sessions: 3, turns: 5, input, output: 234, cacheRead: 0, cacheWrite: 0, costUsd: 2 };
}
function series(input = 123): SeriesReport {
  return { range, bucket: "day", groupBy: "model_raw", buckets: [{ bucket: range.from, sessions: 3, turns: 5, costUsd: 2, groups: [group(input)] }], priceSource: "test", priceCoverage, costNote: "" };
}
const breakdown: BreakdownReport = {
  range, dimension: "project", rows: [{ key: "stage1-project", sessions: 3, turns: 5, input: 123, output: 234, cacheRead: 0, cacheWrite: 0, costUsd: 2, sharePct: 100, cacheHitRate: 0, avgRework: 0 }],
  overlapping: false, priceSource: "test", priceCoverage, costNote: "",
};
const pivot: PivotReport = {
  range, rowBy: "project", colBy: "model_raw", cols: ["gpt-6.1-sol"],
  rows: [{ key: "stage1-pivot", total: group(), cells: [group()] }],
  colTotals: [group()], grandTotal: group(), priceSource: "test", priceCoverage, costNote: "",
};
const models: ModelsReport = {
  range, granularity: "raw", rows: [], series: [], mixedSessions: 0, handoffs: [],
  byWorkTag: [{ workTag: "debug", sessionCount: 3, perModel: [{ model: "gpt-6.1-sol", sessions: 3, turns: 5, costUsd: 2, ingestCost: 0, generateCost: 2, avgRework: 0 }] }],
  overlapping: false, totalSessions: 3, priceSource: "test", priceCoverage, costNote: "",
};
const sessions: SessionsReport = {
  range, total: 1, priceSource: "test", costNote: "", rows: [{
    kind: "codex", sessionId: "stage1-session", title: "stage1-session-title", projectLabel: "stage1-project",
    gitBranch: null, origin: null, primaryModel: "gpt-6.1-sol", modelCount: 1, rangeModels: ["gpt-6.1-sol"], rangeModelCount: 1,
    isSidechain: false, workTags: [], startedAt: range.from, endedAt: range.to, wallMs: 10, activeMs: 5,
    turnCount: 5, userMsgCount: 7, compactCount: 0, costUsd: 2, reworkScore: 0, goalSummary: null, goalCluster: null,
  }],
};
const handoffs: HandoffsReport = { range, granularity: "raw", handoffs: [{ from: "old-model", to: "new-model", count: 4 }] };
const rework: ReworkRankingsReport = { failedCommands: [{ name: "stage1-command", target: "fixture", executions: 8, failures: 2, failureRate: 0.25 }], rewrittenFiles: [] };
const reports: Record<string, unknown> = {
  ailog_overview: overview, ailog_series: series(), ailog_breakdown: breakdown,
  ailog_pivot: pivot, ailog_models: models, ailog_sessions: sessions,
  ailog_model_handoffs: handoffs, ailog_rework_rankings: rework,
};
function deferred<Result>() {
  let resolve!: (value: Result) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Result>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function viewProps(overrides: Partial<ComponentProps<typeof UsageView>> = {}): ComponentProps<typeof UsageView> {
  const state = useAilogStore.getState();
  return {
    overview: state.overview, previousTotalsStatus: state.previousTotalsStatus,
    models: state.models, modelsLoading: state.modelsLoading, modelsError: state.modelsError,
    sessions: state.sessions, series: state.usageSeries, rhythm: state.usageRhythm,
    loading: state.loading, usageLoading: state.usageLoading, usageError: state.usageError, error: state.dashboardError,
    statusPending: false, neverIndexed: false, noData: state.overview?.totals.sessions === 0, running: false,
    preset: state.preset, metric: state.usageMetric, stack: state.usageStack, bucket: state.usageBucket,
    seriesAxis: state.usageSeriesAxis, excludeSynthetic: state.excludeSynthetic, selection: state.selection,
    breakdownDimension: state.breakdownDimension, breakdown: state.breakdown, breakdownError: state.breakdownError, breakdownLoading: state.breakdownLoading,
    sessionSort: state.sessionSort, sessionPage: state.sessionPage, sessionQuery: state.sessionQuery,
    sessionAppliedQuery: state.sessionAppliedQuery, sessionAppliedSort: state.sessionAppliedSort, sessionAppliedPage: state.sessionAppliedPage,
    sessionLoading: state.sessionLoading, sessionError: state.sessionError,
    pivot: state.pivot, pivotRowBy: state.pivotRowBy, pivotColBy: state.pivotColBy, pivotLoading: state.pivotLoading, pivotError: state.pivotError,
    detailKey: null,
    onRefresh: () => void state.refreshOverview({ force: true }),
    onRetryModels: () => void state.refreshModels({ force: true }),
    onRetryUsage: () => void state.refreshUsage({ force: true }),
    onRetrySessions: () => void state.refreshSessions({ force: true }),
    onRefreshBreakdown: () => void state.refreshBreakdown({ force: true }),
    onRetryPivot: () => void state.refreshPivot({ force: true }),
    onStartIndex: vi.fn(), onMetric: state.setUsageMetric, onStack: state.setUsageStack,
    onBucket: state.setUsageBucket, onSeriesAxis: state.setUsageSeriesAxis, onPickDay: vi.fn(),
    onSelect: state.setSelection, onBreakdownDimension: state.setBreakdownDimension,
    onPivotRowBy: state.setPivotRowBy, onPivotColBy: state.setPivotColBy,
    onSessionSort: state.setSessionSort, onSessionPage: state.setSessionPage, onSessionQuery: state.setSessionQuery, onOpenDetail: vi.fn(),
    ...overrides,
  };
}
function view(overrides: Partial<ComponentProps<typeof UsageView>> = {}) {
  return renderToStaticMarkup(<UsageView {...viewProps(overrides)} />);
}
function section(html: string, id: string) {
  const start = html.indexOf('id="' + id + '"');
  expect(start).toBeGreaterThanOrEqual(0);
  return html.slice(start, html.indexOf("</section>", start));
}
async function clickRetry(id: string) {
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<UsageView {...viewProps()} />));
    const button = [...host.querySelectorAll("#" + id + " button")].find((entry) => entry.textContent?.includes("再試行"));
    expect(button).toBeDefined();
    await act(async () => { (button as HTMLButtonElement).click(); });
  } finally {
    await act(async () => root.unmount());
  }
}

const relativeAnchor = Date.UTC(2026, 9, 20, 12);
type RelativePayload = { range: { from?: number | null; to?: number | null; anchor?: number | null; preset?: string | null }; options?: { groupBy?: string; bucket?: string; granularity?: string; rowBy?: string; colBy?: string }; dimension?: string };
function relativeReport(command: string, payload: RelativePayload): unknown {
  const end = payload.range.to ?? payload.range.anchor ?? relativeAnchor;
  const start = payload.range.from ?? end - 30 * 86_400_000;
  const actualRange = { from: start, to: end, label: payload.range.preset ?? "custom" };
  const base = reports[command] as object;
  let result: unknown = { ...base, range: actualRange };
  if (command === "ailog_overview") result = {
    ...overview, range: actualRange, totals: { ...totals, sessions: end > relativeAnchor ? 9 : 3 },
    topProjects: [{ ...breakdown.rows[0], projectLabel: "stage1-project", topTitle: "overview-title-" + end }],
  };
  if (command === "ailog_series") result = {
    ...series(end > relativeAnchor ? 765 : 123), range: actualRange,
    bucket: payload.options?.bucket ?? "day", groupBy: payload.options?.groupBy ?? "model_raw",
  };
  if (command === "ailog_breakdown") result = { ...breakdown, range: actualRange, dimension: payload.dimension ?? "project" };
  if (command === "ailog_pivot") result = { ...pivot, range: actualRange, rowBy: payload.options?.rowBy ?? "project", colBy: payload.options?.colBy ?? "model_raw" };
  if (command === "ailog_models") result = { ...models, range: actualRange, granularity: payload.options?.granularity ?? "raw" };
  if (command === "ailog_sessions") result = {
    ...sessions, range: actualRange, rows: sessions.rows.map((row) => ({ ...row, title: "relative-session-" + end })),
  };
  if (command === "ailog_rework_rankings") result = rework;
  return JSON.parse(JSON.stringify(result));
}
async function loadRelativeReports() {
  vi.spyOn(Date, "now").mockReturnValue(relativeAnchor);
  useAilogStore.getState().setPreset("30d");
  useAilogStore.setState({ rangeAnchor: relativeAnchor, reworkRankingsOpen: true, handoffsOpen: true });
  invokeMock.mockImplementation((command: string, payload: RelativePayload) => Promise.resolve(relativeReport(command, payload)));
  await useAilogStore.getState().loadUsage();
}

beforeEach(() => {
  __resetAilogStoreForTests();
  useAilogStore.getState().setCustomRange("2026-10-01", "2026-10-03");
  invokeMock.mockReset().mockImplementation((command: string) => Promise.resolve(reports[command] ?? {}));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); __resetAilogStoreForTests(); });

describe("AI log partial failures through the actual store and report components", () => {
  it("A1 loads independent reports while overview is pending, then keeps them after its initial failure", async () => {
    const pendingOverview = deferred<unknown>();
    invokeMock.mockImplementation((command: string) => command === "ailog_overview" ? pendingOverview.promise : Promise.resolve(reports[command]));
    const pending = useAilogStore.getState().loadUsage();
    await vi.waitFor(() => expect(useAilogStore.getState().sessions).toEqual(sessions));
    expect(useAilogStore.getState().loading).toBe(true);
    expect(section(view(), "ailog-trend")).toContain("<svg");
    pendingOverview.reject(new Error("overview-only-failure"));
    await pending;
    const html = view();
    expect(section(html, "ailog-overview")).toContain("overview-only-failure");
    expect(section(html, "ailog-overview")).toContain("再試行");
    expect(section(html, "ailog-compare")).toContain("gpt-6.1-sol");
    expect(section(html, "ailog-projects")).toContain("stage1-project");
    expect(section(html, "ailog-cross")).toContain("stage1-pivot");
    expect(section(html, "ailog-sessions")).toContain("stage1-session-title");
    expect(section(html, "ailog-purpose")).toContain("デバッグ");
    expect(html).not.toContain("セッション数 (期間合計)");
  });

  const resources = [
    ["refreshOverview", "ailog_overview", "overview", "dashboardError", "loading"],
    ["refreshUsage", "ailog_series", "usageSeries", "usageError", "usageLoading"],
    ["refreshModels", "ailog_models", "models", "modelsError", "modelsLoading"],
    ["refreshSessions", "ailog_sessions", "sessions", "sessionError", "sessionLoading"],
    ["refreshReworkRankings", "ailog_rework_rankings", "reworkRankings", "reworkRankingsError", "reworkRankingsLoading"],
    ["refreshModelHandoffs", "ailog_model_handoffs", "handoffs", "handoffsError", "handoffsLoading"],
  ] as const;
  it.each(resources)("A2-A4 %s distinguishes initial failure, retains data on refresh failure and during retry, then replaces it", async (action, command, field, errorField, loadingField) => {
    invokeMock.mockRejectedValueOnce(new Error("initial-failure"));
    await useAilogStore.getState()[action]({ force: true });
    expect(useAilogStore.getState()[field]).toBeNull();
    expect(useAilogStore.getState()[errorField]).toContain("initial-failure");
    await useAilogStore.getState()[action]({ force: true });
    const previous = useAilogStore.getState()[field];
    expect(previous).toEqual(reports[command]);
    invokeMock.mockRejectedValueOnce(new Error("refresh-failure"));
    await useAilogStore.getState()[action]({ force: true });
    expect(useAilogStore.getState()[field]).toBe(previous);
    expect(useAilogStore.getState()[errorField]).toContain("refresh-failure");
    const html = action === "refreshReworkRankings" ? renderToStaticMarkup(<ReworkRankings />)
      : action === "refreshModelHandoffs" ? renderToStaticMarkup(<HandoffTable />) : view();
    expect(html).toContain("refresh-failure");
    const displayedRange = action === "refreshReworkRankings" ? useAilogStore.getState().reworkRankingsRange : range;
    if (!displayedRange) throw new Error("Missing captured report range");
    expect(html).toContain(formatLocalDateTime(displayedRange.from));
    if (action === "refreshReworkRankings") {
      const request = invokeMock.mock.calls.find(([name]) => name === "ailog_rework_rankings")?.[1].range;
      expect(displayedRange).toEqual({ ...request, label: "custom" });
    }
    if (action === "refreshUsage") {
      expect(section(html, "ailog-trend")).toContain("<svg");
      expect(section(html, "ailog-compare")).toContain("gpt-6.1-sol");
    }
    if (action === "refreshModels") expect(section(html, "ailog-purpose")).toContain("デバッグ");
    if (action === "refreshReworkRankings") expect(html).toContain("stage1-command");
    if (action === "refreshModelHandoffs") expect(html).toContain("old-model");
    const retry = deferred<unknown>();
    invokeMock.mockReturnValueOnce(retry.promise);
    const pending = useAilogStore.getState()[action]({ force: true });
    expect(useAilogStore.getState()[field]).toBe(previous);
    expect(useAilogStore.getState()[errorField]).toBeNull();
    expect(useAilogStore.getState()[loadingField]).toBe(true);
    const replacement = JSON.parse(JSON.stringify(reports[command]));
    retry.resolve(replacement);
    await pending;
    expect(useAilogStore.getState()[field]).toEqual(replacement);
    expect(useAilogStore.getState()[field]).not.toBe(previous);
    expect(useAilogStore.getState()[loadingField]).toBe(false);
    expect(useAilogStore.getState()[errorField]).toBeNull();
  });

  it("A2 replaces visible series values after recovery", async () => {
    await useAilogStore.getState().refreshUsage();
    invokeMock.mockRejectedValueOnce(new Error("chart-down"));
    await useAilogStore.getState().refreshUsage({ force: true });
    expect(section(view(), "ailog-compare")).toContain("357");
    invokeMock.mockResolvedValueOnce(series(765));
    await useAilogStore.getState().refreshUsage({ force: true });
    expect(section(view(), "ailog-compare")).toContain("999");
    expect(view()).not.toContain("chart-down");
  });

  it.each([
    ["refreshModels", "ailog-purpose"],
    ["refreshSessions", "ailog-sessions"],
  ] as const)("A4 shows initial %s errors with technical details and recovery", async (action, id) => {
    invokeMock.mockRejectedValueOnce(new Error("initial-section-down"));
    await useAilogStore.getState()[action]();
    const html = section(view(), id);
    expect(html).toContain("initial-section-down");
    expect(html).toContain("<details");
    expect(html).toContain("再試行");
    expect(html).not.toContain("この期間の記録なし");
    await clickRetry(id);
    expect(section(view(), id)).not.toContain("initial-section-down");
  });

  it.each([
    ["refreshUsage", "usageSeries", (state: ReturnType<typeof useAilogStore.getState>) => state.setPreset("7d")],
    ["refreshUsage", "usageSeries", (state: ReturnType<typeof useAilogStore.getState>) => state.setSelection({ model: { key: "other", label: "other" } })],
    ["refreshUsage", "usageSeries", (state: ReturnType<typeof useAilogStore.getState>) => state.setUsageSeriesAxis("provider")],
    ["refreshUsage", "usageSeries", (state: ReturnType<typeof useAilogStore.getState>) => state.setUsageBucket("week")],
    ["refreshModels", "models", (state: ReturnType<typeof useAilogStore.getState>) => state.setGranularity("provider")],
    ["refreshReworkRankings", "reworkRankings", (state: ReturnType<typeof useAilogStore.getState>) => state.setCustomRange("2026-10-04", "2026-10-06")],
    ["refreshModelHandoffs", "handoffs", (state: ReturnType<typeof useAilogStore.getState>) => state.setSelection({ project: { key: "other", label: "other" } })],
  ] as const)("A5 drops delayed %s after a context or resource input change", async (action, field, change) => {
    const response = deferred<unknown>();
    invokeMock.mockReturnValueOnce(response.promise);
    const pending = useAilogStore.getState()[action]();
    change(useAilogStore.getState());
    response.resolve({ marker: "obsolete" });
    await pending;
    expect(useAilogStore.getState()[field]).toBeNull();
  });

  it("A5 clears loaded models on granularity changes and rejects old failures after pivot/breakdown axis changes", async () => {
    await useAilogStore.getState().refreshModels();
    useAilogStore.getState().setGranularity("provider");
    expect(useAilogStore.getState().models).toBeNull();
    const oldPivot = deferred<unknown>();
    invokeMock.mockReturnValueOnce(oldPivot.promise);
    const pendingPivot = useAilogStore.getState().refreshPivot();
    useAilogStore.getState().setPivotRowBy("effort");
    await vi.waitFor(() => expect(useAilogStore.getState().pivotLoading).toBe(false));
    oldPivot.reject(new Error("obsolete-axis-error"));
    await pendingPivot;
    expect(useAilogStore.getState().pivotError).toBeNull();
    const oldBreakdown = deferred<unknown>();
    invokeMock.mockReturnValueOnce(oldBreakdown.promise);
    const pendingBreakdown = useAilogStore.getState().refreshBreakdown();
    useAilogStore.getState().setBreakdownDimension("effort");
    oldBreakdown.reject(new Error("obsolete-breakdown-error"));
    await pendingBreakdown;
    expect(useAilogStore.getState().breakdownError).toBeNull();
  });

  it("A5 keeps different saved periods independent, labels series-only snapshots, and never combines their totals or titles", async () => {
    const olderRange = { from: range.from - 10_000, to: range.to - 10_000, label: "older-window" };
    const savedSeries = { ...series(), range: olderRange, cache: { savedAt: range.to, stale: true } };
    const latest = deferred<unknown>();
    invokeMock.mockImplementation((command: string, args: { filters: { reportCache?: string } }) =>
      command !== "ailog_series" ? Promise.resolve(reports[command])
        : args.filters.reportCache === "prefer" ? Promise.resolve(savedSeries) : latest.promise);
    const pending = useAilogStore.getState().refreshUsage();
    await vi.waitFor(() => expect(useAilogStore.getState().reportSnapshots.usage).toBeDefined());
    expect(renderToStaticMarkup(<ReportCacheStatus />)).toContain(formatLocalDateTime(olderRange.from));
    useAilogStore.setState({
      overview: { ...overview, topProjects: [{ projectLabel: "stage1-project", topTitle: "wrong-window-title" }] } as Overview,
      breakdown: { ...breakdown, range: olderRange }, pivot: { ...pivot, range: olderRange },
    });
    const html = view();
    expect(section(html, "ailog-trend")).toContain("gpt-6.1-sol");
    expect(section(html, "ailog-projects")).toContain("stage1-project");
    expect(section(html, "ailog-projects")).not.toContain("wrong-window-title");
    expect(section(html, "ailog-cross")).toContain("stage1-pivot");
    expect(section(html, "ailog-overview")).not.toContain("入出力トークン (期間合計)");
    latest.reject(new Error("newest-down"));
    await pending;
    expect(renderToStaticMarkup(<ReportCacheStatus />)).toContain("保存");
    invalidateAilogCaches();
  });

  it("A6 preserves loaded sections beside an empty overview and never fabricates total sessions without overview", () => {
    useAilogStore.setState({ overview: { ...overview, totals: { ...totals, sessions: 0 } }, usageSeries: series(), sessions, models });
    expect(section(view(), "ailog-sessions")).toContain("stage1-session-title");
    expect(section(view(), "ailog-compare")).toContain("gpt-6.1-sol");
    useAilogStore.setState({ overview: null, usageMetric: "sessions" });
    expect(view()).toContain("セッション総数は未取得");
    expect(view()).not.toContain("セッション数 (期間合計)");
    useAilogStore.setState({ overview: { ...overview, totals: { ...totals, sessions: 0 } }, usageSeries: null, sessions: null, models: null });
    expect(view({ neverIndexed: true })).toContain("記録をまだ取り込んでいません");
    expect(view()).toContain("この期間の記録なし");
  });

  it.each([
    ["refreshOverview", "ailog_overview", "ailog-overview"],
    ["refreshUsage", "ailog_series", "ailog-trend"],
    ["refreshModels", "ailog_models", "ailog-purpose"],
    ["refreshSessions", "ailog_sessions", "ailog-sessions"],
    ["refreshBreakdown", "ailog_breakdown", "ailog-projects"],
    ["refreshPivot", "ailog_pivot", "ailog-cross"],
  ] as const)("A7 %s retry button calls only %s", async (action, command, id) => {
    invokeMock.mockRejectedValueOnce(new Error("retry-this-report"));
    await useAilogStore.getState()[action]({ force: true });
    invokeMock.mockClear();
    await clickRetry(id);
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(invokeMock.mock.calls.map(([name]) => name)).toEqual([command]);
  });

  it.each([
    ["rework", "ailog_rework_rankings"],
    ["handoffs", "ailog_model_handoffs"],
  ] as const)("A3/A7 %s initial failure is visible and its retry replaces only that report", async (kind, command) => {
    invokeMock.mockImplementation((name: string) => name === command ? Promise.reject(new Error("section-down")) : Promise.resolve(reports[name]));
    const refresh = kind === "rework" ? useAilogStore.getState().refreshReworkRankings : useAilogStore.getState().refreshModelHandoffs;
    await refresh({ force: true });
    const renderReport = () => kind === "rework" ? <ReworkRankings /> : <HandoffTable />;
    expect(renderToStaticMarkup(renderReport())).toContain("読み込み失敗");
    expect(renderToStaticMarkup(renderReport())).toContain("section-down");
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(renderReport()));
      await vi.waitFor(() => expect(kind === "rework" ? useAilogStore.getState().reworkRankingsLoading : useAilogStore.getState().handoffsLoading).toBe(false));
      invokeMock.mockClear().mockImplementation((name: string) => Promise.resolve(reports[name]));
      const retry = [...host.querySelectorAll("button")].find((entry) => entry.textContent?.includes("再試行"));
      expect(retry).toBeDefined();
      await act(async () => { (retry as HTMLButtonElement).click(); });
      await vi.waitFor(() => expect(kind === "rework" ? useAilogStore.getState().reworkRankingsError : useAilogStore.getState().handoffsError).toBeNull());
      expect(invokeMock.mock.calls.map(([name]) => name)).toEqual([command]);
      await act(async () => root.render(renderReport()));
      expect(host.textContent).toContain(kind === "rework" ? "stage1-command" : "old-model");
      expect(host.textContent).not.toContain("section-down");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("A5 clears prior-period comparisons when a saved overview with a different actual window arrives", async () => {
    const latest = deferred<unknown>();
    const olderOverview = { ...overview, range: { ...range, from: range.from - 10_000, to: range.to - 10_000 }, cache: { savedAt: range.to, stale: true } };
    useAilogStore.setState({ previousTotals: totals, previousTotalsStatus: "ready" });
    invokeMock.mockImplementation((_command: string, args: { filters: { reportCache?: string } }) =>
      args.filters.reportCache === "prefer" ? Promise.resolve(olderOverview) : latest.promise);
    const pending = useAilogStore.getState().refreshOverview();
    await vi.waitFor(() => expect(useAilogStore.getState().overview).toEqual(olderOverview));
    expect(useAilogStore.getState().previousTotals).toBeNull();
    expect(view()).not.toContain("cost-change-breakdown");
    latest.reject(new Error("overview-latest-down"));
    await pending;
  });

  it("A5 clears loaded data immediately on period/filter changes and rejects an earlier request even after returning to its inputs", async () => {
    await useAilogStore.getState().loadUsage();
    await useAilogStore.getState().refreshReworkRankings();
    await useAilogStore.getState().refreshModelHandoffs();
    useAilogStore.getState().setSelection({ project: { key: "new-context", label: "new-context" } });
    expect(useAilogStore.getState()).toMatchObject({
      overview: null, usageSeries: null, models: null, sessions: null, breakdown: null,
      pivot: null, reworkRankings: null, reworkRankingsRange: null, handoffs: null, reportSnapshots: {},
    });
    const response = deferred<unknown>();
    invokeMock.mockReturnValueOnce(response.promise);
    const pending = useAilogStore.getState().refreshUsage();
    useAilogStore.getState().setUsageBucket("week");
    useAilogStore.getState().setUsageBucket("day");
    response.resolve(series());
    await pending;
    expect(useAilogStore.getState().usageSeries).toBeNull();
  });

  it("A6 distinguishes not fetched models/sessions from successful empty responses", async () => {
    expect(section(view(), "ailog-purpose")).toContain("まだ読み込んでいません");
    expect(section(view(), "ailog-sessions")).toContain("まだ読み込んでいません");
    invokeMock.mockImplementation((command: string) => Promise.resolve(command === "ailog_models" ? { ...models, byWorkTag: [] } : { ...sessions, total: 0, rows: [] }));
    await useAilogStore.getState().refreshModels();
    await useAilogStore.getState().refreshSessions();
    expect(section(view(), "ailog-purpose")).toContain("この期間の記録なし");
    expect(section(view(), "ailog-sessions")).not.toContain("まだ読み込んでいません");
    expect(section(view(), "ailog-sessions")).not.toContain("読み込み失敗");
  });

  it.each([
    ["refreshPivot", "pivot", "ailog_pivot"],
    ["refreshBreakdown", "breakdown", "ailog_breakdown"],
  ] as const)("A5 drops delayed successful %s after its axis changes", async (action, field, command) => {
    const oldResponse = deferred<unknown>();
    invokeMock.mockReturnValueOnce(oldResponse.promise);
    const pending = useAilogStore.getState()[action]();
    if (field === "pivot") useAilogStore.getState().setPivotColBy("provider");
    else useAilogStore.getState().setBreakdownDimension("effort");
    oldResponse.resolve({ ...reports[command] as object, marker: "old-axis-success" });
    await pending;
    expect(useAilogStore.getState()[field]).not.toEqual(expect.objectContaining({ marker: "old-axis-success" }));
  });

  it("A6 preserves real overview totals and does not label a failed session lookup as no candidates", async () => {
    await useAilogStore.getState().loadUsage();
    const html = section(view(), "ailog-overview");
    expect(html).toContain("357");
    expect(html).toContain("7");
    invokeMock.mockRejectedValueOnce(new Error("session-lookup-down"));
    useAilogStore.setState({ sessions: null });
    await useAilogStore.getState().refreshSessions({ force: true });
    expect(view()).toContain("セッション一覧を取得できません");
    expect(view()).not.toContain("次に確認するセッション候補はありません");
  });

  it("A7 overview-only recovery labels the unrequested prior period without claiming a pending request", async () => {
    await useAilogStore.getState().refreshOverview({ force: true });
    expect(useAilogStore.getState().previousTotalsStatus).toBe("idle");
    expect(view()).toContain("前期間は未取得です");
    expect(view()).not.toContain("前期間との比較を読み込み中");
    expect(invokeMock.mock.calls.map(([name]) => name)).toEqual(["ailog_overview"]);
  });

  it.each([
    ["force", { force: true }, 1_000],
    ["revalidate", { revalidate: true }, 1_000],
    ["elapsed", {}, 300_001],
  ] as const)("D01 %s advances the request anchor while retaining the old chart through failure and isolated retry", async (_kind, options, advance) => {
    await loadRelativeReports();
    const previous = useAilogStore.getState();
    const nextAnchor = relativeAnchor + advance;
    vi.mocked(Date.now).mockReturnValue(nextAnchor);
    const pendingSeries = deferred<unknown>();
    invokeMock.mockImplementation((command: string, payload: RelativePayload) =>
      command === "ailog_series" ? pendingSeries.promise : Promise.resolve(relativeReport(command, payload)));
    const pending = useAilogStore.getState().loadUsage(options);
    expect(useAilogStore.getState().rangeAnchor).toBe(nextAnchor);
    expect(useAilogStore.getState().usageSeries).toBe(previous.usageSeries);
    expect(useAilogStore.getState().models).toBe(previous.models);
    expect(useAilogStore.getState().sessions).toBe(previous.sessions);
    expect(useAilogStore.getState().breakdown).toBe(previous.breakdown);
    expect(useAilogStore.getState().pivot).toBe(previous.pivot);
    expect(useAilogStore.getState().handoffs).toBe(previous.handoffs);
    expect(useAilogStore.getState().reworkRankings).toBe(previous.reworkRankings);
    expect(section(view(), "ailog-trend")).toContain("<svg");
    pendingSeries.reject(new Error("relative-series-down"));
    await pending;
    const state = useAilogStore.getState();
    expect(state.usageSeries).toBe(previous.usageSeries);
    expect(state.overview?.range.to).toBe(nextAnchor);
    expect(state.sessions?.range.to).toBe(nextAnchor);
    expect(state.models?.range.to).toBe(nextAnchor);
    const html = view();
    expect(section(html, "ailog-trend")).toContain("<svg");
    expect(section(html, "ailog-compare")).toContain("357");
    expect(section(html, "ailog-trend")).toContain("relative-series-down");
    expect(section(html, "ailog-trend")).toContain("今回の要求と異なる期間");
    expect(section(html, "ailog-trend")).toContain(formatLocalDateTime(relativeAnchor));
    expect(section(html, "ailog-overview")).not.toContain("入出力トークン (期間合計)");
    const requestedWindows = invokeMock.mock.calls.map(([, payload]) => payload.range).filter((entry) => entry.preset === "30d");
    expect(requestedWindows.at(-1)?.anchor).toBe(nextAnchor);
    invokeMock.mockClear().mockImplementation((command: string, payload: RelativePayload) => Promise.resolve(relativeReport(command, payload)));
    await clickRetry("ailog-trend");
    await vi.waitFor(() => expect(useAilogStore.getState().usageError).toBeNull());
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual(["ailog_series"]);
    expect(invokeMock.mock.calls[0][1].range.anchor).toBe(nextAnchor);
    expect(useAilogStore.getState().usageSeries?.range.to).toBe(nextAnchor);
    expect(section(view(), "ailog-compare")).toContain("999");
    expect(section(view(), "ailog-trend")).not.toContain("relative-series-down");
  });

  it.each(["ailog_overview", "ailog_series"] as const)("D01 partial %s failure never mixes totals, project titles or session candidates across actual periods", async (failedCommand) => {
    await loadRelativeReports();
    const previous = useAilogStore.getState();
    const nextAnchor = relativeAnchor + 60_000;
    vi.mocked(Date.now).mockReturnValue(nextAnchor);
    invokeMock.mockImplementation((command: string, payload: RelativePayload) =>
      command === failedCommand || command === "ailog_breakdown" ? Promise.reject(new Error("partial-relative-down")) : Promise.resolve(relativeReport(command, payload)));
    await useAilogStore.getState().loadUsage({ force: true });
    const state = useAilogStore.getState();
    expect(state.breakdown).toBe(previous.breakdown);
    expect(state.overview?.range.to).toBe(failedCommand === "ailog_overview" ? relativeAnchor : nextAnchor);
    expect(state.usageSeries?.range.to).toBe(failedCommand === "ailog_series" ? relativeAnchor : nextAnchor);
    const html = view();
    expect(section(html, "ailog-overview")).not.toContain("入出力トークン (期間合計)");
    expect(section(html, "ailog-projects")).not.toContain("overview-title-" + nextAnchor);
    if (failedCommand === "ailog_overview") {
      expect(html).not.toContain("機械指標上の手戻り兆候が最大: relative-session-" + nextAnchor);
      expect(state.previousTotals).toBeNull();
    }
  });

  it.each([{ force: true }, { revalidate: true }] as const)("D01 retains every failed report and snapshot metadata across an anchor advance: %j", async (options) => {
    await loadRelativeReports();
    const previous = useAilogStore.getState();
    useAilogStore.setState({ reportSnapshots: { usage: { savedAt: relativeAnchor, stale: true, refreshing: false } } });
    vi.mocked(Date.now).mockReturnValue(relativeAnchor + 60_000);
    invokeMock.mockRejectedValue(new Error("all-relative-reports-down"));
    await useAilogStore.getState().loadUsage(options);
    const state = useAilogStore.getState();
    for (const field of ["overview", "usageSeries", "models", "sessions", "breakdown", "pivot", "handoffs", "reworkRankings", "reworkRankingsRange"] as const) {
      expect(state[field]).toBe(previous[field]);
    }
    expect(state.reportSnapshots.usage).toEqual({ savedAt: relativeAnchor, stale: true, refreshing: false });
    expect(renderToStaticMarkup(<ReportCacheStatus />)).toContain("更新できませんでした");
    expect(renderToStaticMarkup(<HandoffTable />)).toContain("all-relative-reports-down");
    expect(renderToStaticMarkup(<ReworkRankings />)).toContain("all-relative-reports-down");
  });

  const changes = [
    ["preset", (state: ReturnType<typeof useAilogStore.getState>) => state.setPreset("7d")],
    ["filter", (state: ReturnType<typeof useAilogStore.getState>) => state.setSelection({ project: { key: "new-project", label: "new-project" } })],
    ["axis", (state: ReturnType<typeof useAilogStore.getState>) => state.setUsageSeriesAxis("provider")],
    ["bucket", (state: ReturnType<typeof useAilogStore.getState>) => state.setUsageBucket("week")],
  ] as const;
  it.each(changes.flatMap(([label, change]) => (["success", "failure"] as const).map((outcome) => [label, change, outcome] as const)))(
    "D01 explicit %s change rejects the earlier relative request's late %s", async (_label, change, outcome) => {
      await loadRelativeReports();
      const oldAnchor = relativeAnchor + 1_000;
      vi.mocked(Date.now).mockReturnValue(oldAnchor);
      const oldSeries = deferred<unknown>();
      invokeMock.mockImplementation((command: string, payload: RelativePayload) =>
        command === "ailog_series" && payload.range.anchor === oldAnchor ? oldSeries.promise : Promise.resolve(relativeReport(command, payload)));
      const oldLoad = useAilogStore.getState().loadUsage({ force: true });
      change(useAilogStore.getState());
      expect(useAilogStore.getState().usageSeries).toBeNull();
      const nextAnchor = oldAnchor + 60_000;
      vi.mocked(Date.now).mockReturnValue(nextAnchor);
      await useAilogStore.getState().loadUsage({ force: true });
      const currentSeries = useAilogStore.getState().usageSeries;
      expect(currentSeries?.range.to).toBe(nextAnchor);
      if (outcome === "success") oldSeries.resolve({ marker: "obsolete-relative-response" });
      else oldSeries.reject(new Error("obsolete-relative-error"));
      await oldLoad;
      expect(useAilogStore.getState().usageSeries).toBe(currentSeries);
      expect(useAilogStore.getState().usageError).toBeNull();
      expect(invokeMock.mock.calls.filter(([command]) => command === "ailog_series").at(-1)?.[1].range.anchor).toBe(nextAnchor);
    });

  it.each(["success", "failure"] as const)("D01 drops a superseded anchor's late %s without clearing the newer data", async (outcome) => {
    await loadRelativeReports();
    const firstAnchor = relativeAnchor + 1_000;
    vi.mocked(Date.now).mockReturnValue(firstAnchor);
    const firstResponse = deferred<unknown>();
    invokeMock.mockImplementation((command: string, payload: RelativePayload) =>
      command === "ailog_series" && payload.range.anchor === firstAnchor ? firstResponse.promise : Promise.resolve(relativeReport(command, payload)));
    const firstLoad = useAilogStore.getState().loadUsage({ force: true });
    const nextAnchor = firstAnchor + 60_000;
    vi.mocked(Date.now).mockReturnValue(nextAnchor);
    await useAilogStore.getState().loadUsage({ revalidate: true });
    const currentSeries = useAilogStore.getState().usageSeries;
    if (outcome === "success") firstResponse.resolve({ marker: "obsolete-anchor" });
    else firstResponse.reject(new Error("obsolete-anchor-error"));
    await firstLoad;
    expect(useAilogStore.getState().usageSeries).toBe(currentSeries);
    expect(currentSeries?.range.to).toBe(nextAnchor);
    expect(useAilogStore.getState().usageError).toBeNull();
  });

  it("D01 keeps closed lazy reports until their next successful fetch without refetching them on refresh", async () => {
    await loadRelativeReports();
    const previous = useAilogStore.getState();
    useAilogStore.setState({ handoffsOpen: false, reworkRankingsOpen: false });
    vi.mocked(Date.now).mockReturnValue(relativeAnchor + 60_000);
    invokeMock.mockClear();
    await useAilogStore.getState().loadUsage({ force: true });
    expect(useAilogStore.getState().handoffs).toBe(previous.handoffs);
    expect(useAilogStore.getState().reworkRankings).toBe(previous.reworkRankings);
    expect(invokeMock.mock.calls.some(([command]) => command === "ailog_model_handoffs" || command === "ailog_rework_rankings")).toBe(false);
    await useAilogStore.getState().refreshModelHandoffs();
    await useAilogStore.getState().refreshReworkRankings();
    expect(useAilogStore.getState().handoffs?.range.to).toBe(relativeAnchor + 60_000);
    expect(useAilogStore.getState().reworkRankingsRange?.to).toBe(relativeAnchor + 60_000);
  });
});
