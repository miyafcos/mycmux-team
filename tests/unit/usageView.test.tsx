import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageView } from "../../src/components/ailog/UsageView";
import type { UsageRhythmReport } from "../../src/lib/ailog";

const emptyRhythm: UsageRhythmReport = {
  range: { from: 0, to: 1, label: "test" },
  dayOffsetMinutes: 540,
  totals: { turns: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, io: 2, costUsd: 0 },
  days: [],
  byHour: Array.from({ length: 24 }, (_, slot) => ({ slot, turns: 0, io: 0, total: 0 })),
  byWeekday: Array.from({ length: 7 }, (_, slot) => ({ slot, turns: 0, io: 0, total: 0 })),
  activeDays: 0,
  spanDays: 1,
  firstDay: null,
  lastDay: null,
  streak: { current: 0, currentThroughDay: null, longest: 0, longestEndDay: null },
  busiestTotal: null,
  busiestIo: null,
  indexFreshness: { lastIndexedAt: 0, staleFiles: 0 },
};

const viewProps = {
  overview: null,
  sessions: null,
  series: null,
  rhythm: emptyRhythm,
  loading: false,
  usageLoading: false,
  usageError: null,
  error: null,
  statusPending: false,
  neverIndexed: false,
  noData: false,
  running: false,
  preset: "30d" as const,
  metric: "ioTokens" as const,
  stack: "absolute" as const,
  bucket: "day" as const,
  seriesAxis: "model" as const,
  excludeSynthetic: true,
  selection: null,
  breakdownDimension: "project" as const,
  breakdown: null,
  breakdownError: null,
  breakdownLoading: false,
  pivot: null,
  pivotRowBy: "project" as const,
  pivotColBy: "model" as const,
  pivotLoading: false,
  pivotError: null,
  sessionSort: "rework" as const,
  sessionPage: 0,
  detailKey: null,
  onRefresh: () => {},
  onRetryUsage: () => {},
  onStartIndex: () => {},
  onMetric: () => {},
  onStack: () => {},
  onBucket: () => {},
  onSeriesAxis: () => {},
  onPickDay: () => {},
  onSelect: () => {},
  onBreakdownDimension: () => {},
  onRefreshBreakdown: () => {},
  onPivotRowBy: () => {},
  onPivotColBy: () => {},
  onRetryPivot: () => {},
  onSessionSort: () => {},
  onSessionPage: () => {},
  onOpenDetail: () => {},
};

describe("UsageView", () => {
  it("keeps the usage information architecture and defers supporting detail", () => {
    const html = renderToStaticMarkup(<UsageView {...viewProps} />);
    expect(html).toContain("トータル");
    expect(html).toContain("推移");
    expect(html).toContain("モデル別");
    expect(html).toContain("クロス集計");
    expect(html).toContain("案件別");
    expect(html).toContain("セッション一覧");
    expect(html).toContain("稼働リズム");
    expect(html).not.toContain("詳細");
    expect(html).not.toContain("内訳の次元");
    expect(html).not.toContain("連続日数");
    expect(html).not.toContain("ピーク時間帯");
  });
});
