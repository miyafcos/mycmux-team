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
import { UsageRhythm } from "../../src/components/ailog/UsageRhythm";
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
  previousTotalsStatus: "idle" as const,
  models: null,
  modelsLoading: false,
  modelsError: null,
  onRetryModels: () => {},
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
  sessionQuery: "",
  sessionAppliedQuery: "",
  sessionAppliedSort: "rework" as const,
  sessionAppliedPage: 0,
  sessionLoading: false,
  sessionError: null,
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
  onSessionQuery: () => {},
  onRetrySessions: () => {},
  onOpenDetail: () => {},
};

describe("UsageView", () => {
  it.each(["ioTokens", "sessions"] as const)("renders the daily grid for %s with grouping as its only chart control", metric => {
    const series = { range: { from: 0, to: 1, label: "検証" }, groupBy: "model" as const, bucket: "day", buckets: [],
      priceCoverage, priceSource: "test", costNote: "" };
    const html = renderToStaticMarkup(<UsageView {...viewProps} series={series} metric={metric} />);
    const section = new DOMParser().parseFromString(html, "text/html").querySelector("#ailog-trend")!;
    expect(section.querySelectorAll("[data-usage-day]")).toHaveLength(1);
    expect(section.querySelector('[aria-label="まとめ方"]')).not.toBeNull();
    expect(section.querySelector('[aria-label="単位"]')).toBeNull();
    expect(section.querySelector('[aria-label="表示"]')).toBeNull();
    expect(section.querySelector("svg")).toBeNull();
    expect(section.textContent).toContain("期間全体の内訳");
  });

  it("keeps a weekly report out of the daily grid and offers the existing load action", () => {
    const series = { range: { from: 0, to: 1, label: "検証" }, groupBy: "model" as const, bucket: "week", buckets: [],
      priceCoverage, priceSource: "test", costNote: "" };
    const html = renderToStaticMarkup(<UsageView {...viewProps} series={series} bucket="week" />);
    const section = new DOMParser().parseFromString(html, "text/html").querySelector("#ailog-trend")!;
    expect(section.querySelector("[data-usage-grass]")).toBeNull();
    expect(section.textContent).toContain("日ごとの使用量");
    expect(section.querySelector("button")).not.toBeNull();
  });

  it.each([
    ["idle", "前期間は未取得です"],
    ["loading", "前期間との比較を読み込み中"],
    ["error", "前期間を取得できません"],
  ] as const)("preserves previous-period %s when series are absent", (status, message) => {
    const html = renderToStaticMarkup(<UsageView {...viewProps} overview={overview} previousTotalsStatus={status} />);
    const document = new DOMParser().parseFromString(html, "text/html");
    expect(document.querySelector("#ailog-overview")?.textContent).toContain(message);
  });

  it("retains mismatch and previous-period failure", () => {
    const series = { range: { ...overview.range, to: 2 }, groupBy: "model" as const, bucket: "day" as const, buckets: [], priceCoverage, priceSource: "test", costNote: "" };
    const html = renderToStaticMarkup(<UsageView {...viewProps} overview={overview} series={series} previousTotalsStatus="error" />);
    expect(html).toContain("概要と日ごとの使用量の表示期間が異なるため");
    expect(html).toContain("前期間を取得できません");
  });

  it("does not add a detached percentage when series are absent", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    const root = createRoot(host);
    useAilogStore.setState({ previousTotals: { ...overview.totals, input: 10 } });
    try {
      await act(async () => root.render(<UsageView {...viewProps} overview={overview} selection={{ model: { key: "fixture", label: "fixture" } }} previousTotalsStatus="ready" />));
      expect(host.querySelector("#ailog-overview")?.textContent).not.toContain("前期間比");
      expect(host.querySelector("#ailog-overview")?.textContent).not.toContain("前期間を取得できません");
    } finally {
      await act(async () => root.unmount());
      useAilogStore.setState({ previousTotals: null });
    }
  });

  it("keeps hourly and weekday detail after the daily statistics move to the grid", () => {
    const html = renderToStaticMarkup(<UsageRhythm report={emptyRhythm} metric="ioTokens" />);
    expect(html).toContain("時間帯（+09:00）");
    expect(html).toContain("曜日");
    expect(html).not.toContain("記録のある日");
    expect(html.match(/数値を表で見る/g)).toHaveLength(2);
  });

  it("keeps the active filter visible when it matches no sessions", () => {
    const emptyOverview = { ...overview, totals: { ...overview.totals, sessions: 0 } };
    const html = renderToStaticMarkup(
      <UsageView
        {...viewProps}
        overview={emptyOverview}
        noData
        selection={{ model: { key: "gpt-5.6-sol", label: "gpt-5.6-sol" } }}
      />,
    );
    expect(html).toContain("モデル: gpt-5.6-sol ×");
    expect(html).toContain("絞り込みに一致する記録なし");
    expect(html).toContain("絞り込みを解除");
  });

  it("keeps the usage information architecture and defers supporting detail", () => {
    const html = renderToStaticMarkup(<UsageView {...viewProps} />);
    expect(html).toContain("この期間");
    expect(html).toContain("何に使ったか");
    expect(html).toContain("つまずいた場所");
    expect(html).toContain("日ごとの使用量");
    expect(html).toContain("シリーズ別");
    expect(html).toContain("2つの切り口で比較");
    expect(html).toContain("案件別");
    expect(html).toContain("セッション一覧");
    expect(html).toContain("時間帯と曜日");
    expect(html).not.toContain("詳細");
    expect(html).not.toContain("内訳の次元");
    expect(html).not.toContain("連続日数");
    expect(html).not.toContain("ピーク時間帯");
    const period = html.indexOf("この期間");
    const usedFor = html.indexOf("何に使ったか");
    const stumble = html.indexOf("つまずいた場所");
    const trend = html.indexOf("日ごとの使用量");
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
    expect(html).toContain("¥1,860");
    expect(html).not.toContain("全体の");
    expect(html).not.toContain("合計は全体を超えます");
    expect(html).not.toContain("期間指定に追随");
    expect(html).not.toContain("--cmux-usage-warn");
    expect(html).not.toContain("--cmux-usage-danger");
    expect(html).not.toContain("--cmux-usage-ok");
  });

  it("discloses agent overlap and the sidechain override next to that breakdown", () => {
    const breakdown = {
      range: overview.range,
      dimension: "agent",
      rows: [{ key: "worker", sessions: 1, turns: 2, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 1, sharePct: 100, cacheHitRate: 0, avgRework: 0 }],
      overlapping: true,
      priceSource: "test",
      priceCoverage,
      costNote: "",
    };
    const html = renderToStaticMarkup(<UsageView {...viewProps} overview={overview} breakdownDimension="agent" breakdown={breakdown} />);
    expect(html).toContain("同じターンを計上");
    expect(html).toContain("サブエージェントのターンも含める");
    expect(html).toContain("合計できません");
  });

  it("keeps the next record and page index without repeating headline totals", () => {
    const sessions = { range: overview.range, rows: [], total: 0, priceSource: "test", costNote: "" };
    const html = renderToStaticMarkup(<UsageView {...viewProps} overview={overview} sessions={sessions} />);
    expect(html).toContain("確認する記録");
    expect(html).not.toContain("3秒で分かる現在地");
    expect(html).toContain("次に見る");
    expect(html).toContain("AIログ分析のページ内索引");
    expect(html).toContain("主題・最初の依頼・案件を検索");
    expect(html).toContain("href=\"#ailog-sessions\"");
  });

  it("keeps the synthetic filter next to its affected table", () => {
    const html = renderToStaticMarkup(<UsageView {...viewProps} />);
    const document = new DOMParser().parseFromString(html, "text/html");
    expect(document.querySelector("#ailog-compare")?.textContent).toContain("内部生成レコードをこの表から除く");
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
      { preset: "30d", anchor: useAilogStore.getState().rangeAnchor },
      expect.objectContaining({ includeSidechain: true, models: [], projects: [] }),
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
      { preset: "7d", anchor: useAilogStore.getState().rangeAnchor },
      expect.objectContaining({ includeSidechain: true }),
    );
  });

  it("keeps aggregate rankings cached after includeSidechain changes", async () => {
    await setStumbleOpen(true);
    await act(async () => {
      useAilogStore.getState().setIncludeSidechain(true);
    });
    await flush();
    expect(ailogReworkRankings).toHaveBeenCalledTimes(1);
    expect(ailogReworkRankings).toHaveBeenLastCalledWith(
      { preset: "30d", anchor: useAilogStore.getState().rangeAnchor },
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
      { preset: "30d", anchor: useAilogStore.getState().rangeAnchor },
      expect.objectContaining({ models: ["gpt-5.6-terra"] }),
    );
  });
});
