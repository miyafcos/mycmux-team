// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../src/lib/ailog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ailog")>()),
  ailogReworkRankings: vi.fn(),
}));

import { UsageView } from "../../src/components/ailog/UsageView";
import { WORK_TAG_OVERLAP_NOTE } from "../../src/components/ailog/WorkTagTable";
import { ailogReworkRankings, type ModelsReport, type Overview, type UsageRhythmReport } from "../../src/lib/ailog";
import { __resetAilogStoreForTests, useAilogStore } from "../../src/stores/ailogStore";

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

const priceCoverage = {
  priced: { models: [], tokens: 0 },
  local: { models: [], tokens: 0 },
  internal: { models: [], tokens: 0 },
  flat: { models: [], tokens: 0 },
  reported: { models: [], tokens: 0 },
  unknown: { models: [], tokens: 0 },
  coveredTokenRatio: 1,
};

const overview = {
  range: { from: 0, to: 1, label: "test" },
  totals: { sessions: 10, turns: 10, userMessages: 10, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 48.2, wallMs: 1, activeMs: 1, projects: 1, models: 1 },
  comparePrevious: { sessionsPct: 0, costPct: 0, tokensPct: 0, reworkPct: 0 },
  topModels: [], mixedModelSessions: 0, topProjects: [], topTitles: [],
  rework: { avgScore: 0, toolErrorRate: 0, correctionHits: 0, churnFiles: 0, abandonedSessions: 0 },
  excludedInternal: { sessions: 0, costUsd: 0 }, cacheHitRate: 0, priceSource: "test",
  priceCoverage, indexFreshness: { lastIndexedAt: 0, staleFiles: 0 }, costNote: "",
} satisfies Overview;

const models = {
  range: { from: 0, to: 1, label: "test" },
  granularity: "raw",
  rows: [],
  series: [],
  mixedSessions: 0,
  handoffs: [],
  byWorkTag: [
    { workTag: "debug", perModel: [{ model: "gpt-5.6-terra", sessions: 4, turns: 8, costUsd: 12.4, ingestCost: 0, generateCost: 12.4, avgRework: 0 }], sessionCount: 4 },
    { workTag: "explore", perModel: [{ model: "gpt-5.6-terra", sessions: 6, turns: 12, costUsd: 40, ingestCost: 0, generateCost: 40, avgRework: 0 }], sessionCount: 6 },
  ],
  overlapping: true,
  totalSessions: 10,
  priceSource: "test",
  priceCoverage,
  costNote: "",
} satisfies ModelsReport;

const viewProps = {
  overview: null,
  models: null,
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
    expect(html).toContain("この期間");
    expect(html).toContain("何に使ったか");
    expect(html).toContain("つまずいた場所");
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
    const period = html.indexOf("この期間");
    const usedFor = html.indexOf("何に使ったか");
    const stumble = html.indexOf("つまずいた場所");
    const trend = html.indexOf("推移");
    expect(period).toBeGreaterThanOrEqual(0);
    expect(usedFor).toBeGreaterThan(period);
    expect(stumble).toBeGreaterThan(usedFor);
    expect(trend).toBeGreaterThan(stumble);
  });

  it("notes that work-tag rows cannot be added up, without a share column", () => {
    const html = renderToStaticMarkup(<UsageView {...viewProps} overview={overview} models={models} />);
    expect(html).toContain(WORK_TAG_OVERLAP_NOTE);
    expect(html).toContain("デバッグ");
    expect(html).toContain("コード探索");
    expect(html).toContain("$12.40");
    expect(html).not.toContain("全体の");
    expect(html).not.toContain("合計は全体を超えます");
    expect(html).not.toContain("期間指定に追随");
    expect(html).not.toContain("--cmux-usage-warn");
    expect(html).not.toContain("--cmux-usage-danger");
    expect(html).not.toContain("--cmux-usage-ok");
  });

  it("does not mount rework rankings while the section stays collapsed", () => {
    const html = renderToStaticMarkup(<UsageView {...viewProps} overview={overview} models={models} />);
    expect(html).toContain("つまずいた場所");
    expect(html).not.toContain("失敗の多いコマンド");
    expect(html).not.toContain("書き直しの多いファイル");
  });
});

describe("rework rankings fetch while the section is open", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function setStumbleOpen(open: boolean) {
    const summary = [...container.querySelectorAll("summary")].find((node) => node.textContent === "つまずいた場所");
    expect(summary).toBeTruthy();
    const details = summary!.closest("details");
    expect(details).toBeTruthy();
    await act(async () => {
      details!.open = open;
      details!.dispatchEvent(new Event("toggle"));
      await Promise.resolve();
    });
    await flush();
  }

  beforeEach(async () => {
    __resetAilogStoreForTests();
    vi.mocked(ailogReworkRankings).mockReset().mockResolvedValue({ failedCommands: [], rewrittenFiles: [] });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<UsageView {...viewProps} overview={overview} models={models} />);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    __resetAilogStoreForTests();
  });

  it("does not fetch while collapsed", async () => {
    await flush();
    expect(ailogReworkRankings).not.toHaveBeenCalled();
  });

  it("fetches once on open with the current range and filters", async () => {
    await setStumbleOpen(true);
    expect(ailogReworkRankings).toHaveBeenCalledTimes(1);
    expect(ailogReworkRankings).toHaveBeenCalledWith(
      { preset: "30d" },
      expect.objectContaining({ includeSidechain: false, models: [], projects: [] }),
    );
  });

  it("reuses the cache on close and reopen", async () => {
    await setStumbleOpen(true);
    await setStumbleOpen(false);
    await setStumbleOpen(true);
    expect(ailogReworkRankings).toHaveBeenCalledTimes(1);
  });

  it("fetches again after the period changes", async () => {
    await setStumbleOpen(true);
    expect(ailogReworkRankings).toHaveBeenCalledTimes(1);
    await act(async () => {
      useAilogStore.getState().setPreset("7d");
    });
    await flush();
    expect(ailogReworkRankings).toHaveBeenCalledTimes(2);
    expect(ailogReworkRankings).toHaveBeenLastCalledWith(
      { preset: "7d" },
      expect.objectContaining({ includeSidechain: false }),
    );
  });

  it("fetches again after includeSidechain changes", async () => {
    await setStumbleOpen(true);
    await act(async () => {
      useAilogStore.getState().setIncludeSidechain(true);
    });
    await flush();
    expect(ailogReworkRankings).toHaveBeenCalledTimes(2);
    expect(ailogReworkRankings).toHaveBeenLastCalledWith(
      { preset: "30d" },
      expect.objectContaining({ includeSidechain: true }),
    );
  });

  it("fetches again after the model selection changes", async () => {
    await setStumbleOpen(true);
    await act(async () => {
      useAilogStore.getState().setSelection({ model: { key: "gpt-5.6-terra", label: "gpt-5.6-terra" } });
    });
    await flush();
    expect(ailogReworkRankings).toHaveBeenCalledTimes(2);
    expect(ailogReworkRankings).toHaveBeenLastCalledWith(
      { preset: "30d" },
      expect.objectContaining({ models: ["gpt-5.6-terra"] }),
    );
  });
});
