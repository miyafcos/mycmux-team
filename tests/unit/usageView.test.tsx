import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DAY_OFFSET_MIN, type SeriesReport, type UsageRhythmReport } from "../../src/lib/ailog";
import { UsageView } from "../../src/components/ailog/UsageView";
import { UsageModelTable } from "../../src/components/ailog/UsageModelTable";
import { UsageTotals, summarizeUsage } from "../../src/components/ailog/UsageTotals";

const OFFSET_MS = DAY_OFFSET_MIN * 60_000;
const AUG13 = Date.UTC(2026, 7, 13) - OFFSET_MS;

function group(name: string, over: Record<string, number> = {}) {
  return {
    group: name,
    turns: 1,
    sessions: 1,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
    ...over,
  };
}

const series: SeriesReport = {
  range: { from: 0, to: 1, label: "all" },
  bucket: "day",
  groupBy: "model",
  buckets: [
    {
      bucket: AUG13,
      turns: 3,
      sessions: 2,
      costUsd: 12,
      groups: [
        group("claude-fable-5", { input: 100, output: 20, cacheRead: 5000, cacheWrite: 300, costUsd: 12, turns: 2 }),
        group("gpt-5.5", { input: 800, output: 200, cacheRead: 100, cacheWrite: 0, costUsd: 0 }),
      ],
    },
  ],
  priceSource: "default",
  unpricedModels: ["gpt-5.5"],
  costNote: "estimate",
};

const rhythm: UsageRhythmReport = {
  range: series.range,
  dayOffsetMinutes: DAY_OFFSET_MIN,
  totals: { turns: 3, input: 900, output: 220, cacheRead: 5100, cacheWrite: 300, total: 6520, io: 1120, costUsd: 12 },
  days: [{ day: AUG13, turns: 3, io: 1120, total: 6520, costUsd: 12 }],
  byHour: Array.from({ length: 24 }, (_, slot) => ({ slot, turns: slot === 15 ? 3 : 0, io: slot === 15 ? 1120 : 0, total: slot === 15 ? 6520 : 0 })),
  byWeekday: Array.from({ length: 7 }, (_, slot) => ({ slot, turns: slot === 4 ? 3 : 0, io: slot === 4 ? 1120 : 0, total: slot === 4 ? 6520 : 0 })),
  activeDays: 1,
  spanDays: 1,
  firstDay: AUG13,
  lastDay: AUG13,
  streak: { current: 1, currentThroughDay: AUG13, longest: 1, longestEndDay: AUG13 },
  busiestTotal: { day: AUG13, turns: 3, io: 1120, total: 6520, costUsd: 12 },
  busiestIo: { day: AUG13, turns: 3, io: 1120, total: 6520, costUsd: 12 },
  indexFreshness: { lastIndexedAt: Date.now(), staleFiles: 0 },
};

function render(over: Partial<Parameters<typeof UsageView>[0]> = {}) {
  return renderToStaticMarkup(
    <UsageView
      series={series}
      rhythm={rhythm}
      loading={false}
      error={null}
      metric="ioTokens"
      onMetric={() => {}}
      stack="absolute"
      onStack={() => {}}
      bucket="day"
      onBucket={() => {}}
      granularity="family"
      onGranularity={() => {}}
      rangeReady
      selectionLabel={null}
      onClearSelection={() => {}}
      onRetry={() => {}}
      onReindex={() => {}}
      {...over}
    />,
  );
}

describe("summarizeUsage", () => {
  it("splits providers by model name and leaves unknown names out of both", () => {
    const withUnknown: SeriesReport = {
      ...series,
      buckets: [{ ...series.buckets[0], groups: [...series.buckets[0].groups, group("(unknown)", { input: 7 })] }],
    };
    const io = summarizeUsage(withUnknown, "ioTokens");
    expect(io.claude).toBe(120);
    expect(io.gpt).toBe(1000);
    expect(io.other).toBe(7);
  });

  it("flips which provider dominates when the metric changes", () => {
    // The same recorded work: fresh tokens favour GPT, total tokens favour
    // Claude because almost all of its volume is cache reads.
    const io = summarizeUsage(series, "ioTokens");
    const total = summarizeUsage(series, "totalTokens");
    expect(io.gpt).toBeGreaterThan(io.claude);
    expect(total.claude).toBeGreaterThan(total.gpt);
  });

  it("reports the cache share of all tokens", () => {
    const total = summarizeUsage(series, "totalTokens");
    expect(total.cacheShare).toBeCloseTo(5400 / 6520, 6);
  });
});

describe("UsageView states", () => {
  it("shows a skeleton while loading with no data yet", () => {
    const html = render({ series: null, rhythm: null, loading: true });
    expect(html).toContain("集計を読み込み中");
  });

  it("shows the error inside the section and keeps the section heading", () => {
    const html = render({ error: "db is locked" });
    expect(html).toContain("db is locked");
    expect(html).toContain("トータル");
    expect(html).toContain("読み込みに失敗しました");
  });

  it("asks for two dates instead of rendering an empty chart", () => {
    const html = render({ rangeReady: false });
    expect(html).toContain("期間を2つの日付で指定すると反映されます");
  });

  it("renders every section when data is present", () => {
    const html = render();
    expect(html).toContain("日別 × モデル別");
    expect(html).toContain("稼働リズム");
    expect(html).toContain("モデル別の内訳");
    expect(html).toContain("2026-08-13");
  });

  it("labels the hour axis with the offset it is measured in", () => {
    expect(render()).toContain("+09:00");
  });

  it("says session counts are not stacked when that metric is selected", () => {
    const html = render({ metric: "sessions" });
    expect(html).toContain("積み上げず");
  });
});

describe("unpriced models", () => {
  it("names them in the totals rather than folding them into $0.00", () => {
    const html = renderToStaticMarkup(<UsageTotals report={series} metric="ioTokens" />);
    expect(html).toContain("gpt-5.5");
    expect(html).toContain("コスト相当に一切含まれていません");
  });

  it("stays silent when every model has a rate", () => {
    const priced: SeriesReport = { ...series, unpricedModels: [] };
    const html = renderToStaticMarkup(<UsageTotals report={priced} metric="ioTokens" />);
    expect(html).toContain("この期間のモデルはすべて単価が登録されています");
    expect(html).not.toContain("コスト相当に一切含まれていません");
  });

  it("prints 未設定 in the cost column instead of a zero amount", () => {
    const html = renderToStaticMarkup(<UsageModelTable report={series} metric="ioTokens" />);
    expect(html).toContain("未設定");
    expect(html).not.toContain("$0.00");
  });

  it("prints 算出不可 for turns that recorded no model name", () => {
    const withUnknown: SeriesReport = {
      ...series,
      buckets: [{ ...series.buckets[0], groups: [group("(unknown)", { input: 7 })] }],
    };
    const html = renderToStaticMarkup(<UsageModelTable report={withUnknown} metric="ioTokens" />);
    expect(html).toContain("モデル不明");
    expect(html).toContain("算出不可");
  });
});
