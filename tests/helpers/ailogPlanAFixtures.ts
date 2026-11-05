import type { ComponentProps } from "react";
import type { BreakdownReport, HandoffsReport, ModelsReport, Overview, PivotReport, ReworkRankingsReport, SeriesGroup, SeriesReport, SessionsReport, UsageRhythmReport } from "../../src/lib/ailog";
import { UsageView } from "../../src/components/ailog/UsageView";
import { useAilogStore } from "../../src/stores/ailogStore";
export const range = { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 4) - 1, label: "custom" };
export const priceCoverage = {
  priced: { models: [], tokens: 0 }, local: { models: [], tokens: 0 },
  internal: { models: [], tokens: 0 }, flat: { models: [], tokens: 0 },
  reported: { models: [], tokens: 0 }, unknown: { models: [], tokens: 0 }, coveredTokenRatio: 1,
};
export const totals = { sessions: 3, turns: 5, userMessages: 7, input: 123, output: 234, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 2, wallMs: 10, activeMs: 5, projects: 1, models: 1 };
export const overview: Overview = {
  range, totals, comparePrevious: { sessionsPct: 0, costPct: 0, tokensPct: 0, reworkPct: 0 },
  topModels: [], mixedModelSessions: 0, topProjects: [], topTitles: [],
  rework: { avgScore: 0, toolErrorRate: 0, correctionHits: 0, churnFiles: 0, abandonedSessions: 0 },
  excludedInternal: { sessions: 0, costUsd: 0 }, cacheHitRate: 0, priceSource: "test",
  priceCoverage, indexFreshness: { lastIndexedAt: 0, staleFiles: 0 }, costNote: "",
};
export function group(input = 123): SeriesGroup {
  return { group: "gpt-6.1-sol", sessions: 3, turns: 5, input, output: 234, cacheRead: 0, cacheWrite: 0, costUsd: 2 };
}
export function series(input = 123): SeriesReport {
  return { range, bucket: "day", groupBy: "model_raw", buckets: [{ bucket: range.from, sessions: 3, turns: 5, costUsd: 2, groups: [group(input)] }], priceSource: "test", priceCoverage, costNote: "" };
}
export const breakdown: BreakdownReport = {
  range, dimension: "project", rows: [{ key: "stage1-project", sessions: 3, turns: 5, input: 123, output: 234, cacheRead: 0, cacheWrite: 0, costUsd: 2, sharePct: 100, cacheHitRate: 0, avgRework: 0 }],
  overlapping: false, priceSource: "test", priceCoverage, costNote: "",
};
export const pivot: PivotReport = {
  range, rowBy: "project", colBy: "model_raw", cols: ["gpt-6.1-sol"],
  rows: [{ key: "stage1-pivot", total: group(), cells: [group()] }],
  colTotals: [group()], grandTotal: group(), priceSource: "test", priceCoverage, costNote: "",
};
export const models: ModelsReport = {
  range, granularity: "raw", rows: [], series: [], mixedSessions: 0, handoffs: [],
  byWorkTag: [{ workTag: "debug", sessionCount: 3, perModel: [{ model: "gpt-6.1-sol", sessions: 3, turns: 5, costUsd: 2, ingestCost: 0, generateCost: 2, avgRework: 0 }] }],
  overlapping: false, totalSessions: 3, priceSource: "test", priceCoverage, costNote: "",
};
export const sessions: SessionsReport = {
  range, total: 1, priceSource: "test", costNote: "", rows: [{
    kind: "codex", sessionId: "stage1-session", title: "stage1-session-title", projectLabel: "stage1-project",
    gitBranch: null, origin: null, primaryModel: "gpt-6.1-sol", modelCount: 1, rangeModels: ["gpt-6.1-sol"], rangeModelCount: 1,
    isSidechain: false, workTags: [], startedAt: range.from, endedAt: range.to, wallMs: 10, activeMs: 5,
    turnCount: 5, userMsgCount: 7, compactCount: 0, costUsd: 2, reworkScore: 0, goalSummary: null, goalCluster: null,
  }],
};
export const handoffs: HandoffsReport = { range, granularity: "raw", handoffs: [{ from: "old-model", to: "new-model", count: 4 }] };
export const rework: ReworkRankingsReport = { failedCommands: [{ name: "stage1-command", target: "fixture", executions: 8, failures: 2, failureRate: 0.25 }], rewrittenFiles: [] };
export const reports: Record<string, unknown> = {
  ailog_overview: overview, ailog_series: series(), ailog_breakdown: breakdown,
  ailog_pivot: pivot, ailog_models: models, ailog_sessions: sessions,
  ailog_model_handoffs: handoffs, ailog_rework_rankings: rework,
};
export const rhythm: UsageRhythmReport = {
  range, dayOffsetMinutes: 540, totals: { turns: 5, input: 123, output: 234, cacheRead: 0, cacheWrite: 0, total: 357, io: 357, costUsd: 2 },
  days: [], byHour: Array.from({ length: 24 }, (_, slot) => ({ slot, turns: slot, io: slot * 10, total: slot * 20 })),
  byWeekday: Array.from({ length: 7 }, (_, slot) => ({ slot, turns: slot, io: slot * 10, total: slot * 20 })),
  activeDays: 1, spanDays: 3, firstDay: range.from, lastDay: range.to, streak: { current: 1, currentThroughDay: range.from, longest: 1, longestEndDay: range.from },
  busiestTotal: null, busiestIo: null, indexFreshness: { lastIndexedAt: 1, staleFiles: 0 },
};
reports.ailog_usage_rhythm = rhythm;
export function viewProps(overrides: Partial<ComponentProps<typeof UsageView>> = {}): ComponentProps<typeof UsageView> {
  const state = useAilogStore.getState();
  return {
    overview: state.overview, previousTotalsStatus: state.previousTotalsStatus,
    models: state.models, modelsLoading: state.modelsLoading, modelsError: state.modelsError,
    sessions: state.sessions, series: state.usageSeries, rhythm: state.usageRhythm,
    loading: state.loading, usageLoading: state.usageLoading, usageError: state.usageError, error: state.dashboardError,
    statusPending: false, neverIndexed: false, noData: state.overview?.totals.sessions === 0, running: false,
    preset: state.preset, metric: state.usageMetric, bucket: state.usageBucket,
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
    onStartIndex: () => {}, onMetric: state.setUsageMetric,
     onSeriesAxis: state.setUsageSeriesAxis, onPickDay: () => {},
    onSelect: state.setSelection, onBreakdownDimension: state.setBreakdownDimension,
    onPivotRowBy: state.setPivotRowBy, onPivotColBy: state.setPivotColBy,
    onSessionSort: state.setSessionSort, onSessionPage: state.setSessionPage, onSessionQuery: state.setSessionQuery, onOpenDetail: () => {},
    ...overrides,
  };
}