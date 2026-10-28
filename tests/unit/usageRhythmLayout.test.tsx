import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UsageRhythm } from "../../src/components/ailog/UsageRhythm";
import type { UsageRhythmReport } from "../../src/lib/ailog";

const firstDay = Date.UTC(2026, 9, 20);
const days = [
  { day: firstDay, io: 100, total: 300, turns: 9, costUsd: 0 },
  { day: firstDay + 86400000, io: 200, total: 250, turns: 3, costUsd: 0 },
];
const report: UsageRhythmReport = {
  range: { from: firstDay, to: firstDay + 2 * 86400000, label: "検証" },
  dayOffsetMinutes: 540,
  totals: { input: 200, output: 100, cacheRead: 250, cacheWrite: 0, io: 300, total: 550, turns: 12, costUsd: 0 },
  days,
  byHour: Array.from({ length: 24 }, (_, slot) => ({ slot, io: slot * 10, total: slot * 20, turns: slot })),
  byWeekday: Array.from({ length: 7 }, (_, slot) => ({ slot, io: slot * 10, total: slot * 20, turns: slot })),
  activeDays: 2, spanDays: 2, firstDay, lastDay: days[1].day,
  streak: { current: 2, currentThroughDay: days[1].day, longest: 2, longestEndDay: days[1].day },
  busiestIo: days[1], busiestTotal: days[0], indexFreshness: { lastIndexedAt: 1, staleFiles: 0 },
};

describe("usage rhythm layout and metric", () => {
  it.each([
    ["ioTokens", "入出力トークン", "300 tok", "2026-10-21 (200 tok)"],
    ["totalTokens", "総トークン", "550 tok", "2026-10-20 (300 tok)"],
    ["turns", "ターン数", "12", "2026-10-20 (9)"],
  ] as const)("aligns the headline and busiest day with %s", (metric, label, total, busiest) => {
    const html = renderToStaticMarkup(<UsageRhythm report={report} metric={metric} />);
    expect(html).toContain(`${label}が最も多い日: ${busiest}`);
    expect(html).toContain(`title="${total}"`);
  });

  it("uses intrinsic tick width and separate sparse hour labels", () => {
    const html = renderToStaticMarkup(<UsageRhythm report={report} metric="ioTokens" />);
    expect(html).toContain("grid-template-columns:max-content minmax(0, 1fr)");
    expect(html).not.toContain("52px minmax");
    expect(html).toContain("data-rhythm-label");
    expect(html).not.toContain("overflow:hidden");
  });

  it("provides native keyboard disclosures and full values for all slots", () => {
    const html = renderToStaticMarkup(<UsageRhythm report={report} metric="ioTokens" />);
    expect(html.match(/数値を表で見る/g)).toHaveLength(2);
    expect(html.match(/<th scope="row"/g)).toHaveLength(31);
    expect(html).toContain("23時");
    expect(html).toContain("230 tok");
  });

  it("does not claim a busiest day when the selected metric is zero", () => {
    const empty = {
      ...report,
      totals: { ...report.totals, turns: 0 },
      days: days.map((day) => ({ ...day, turns: 0 })),
      byHour: report.byHour.map((slot) => ({ ...slot, turns: 0 })),
      byWeekday: report.byWeekday.map((slot) => ({ ...slot, turns: 0 })),
    };
    const html = renderToStaticMarkup(<UsageRhythm report={empty} metric="turns" />);
    expect(html).not.toContain("ターン数が最も多い日");
    expect(html).toContain("この期間のターン数は0です。");
    expect(html).not.toContain("この期間の記録はありません。");
    expect(html.match(/記録なし/g)).toHaveLength(2);
  });

  it("distinguishes an empty period from records with a zero selected metric", () => {
    const empty = {
      ...report,
      activeDays: 0,
      days: [],
      totals: { ...report.totals, input: 0, output: 0, cacheRead: 0, io: 0, total: 0, turns: 0 },
      byHour: report.byHour.map((slot) => ({ ...slot, io: 0, total: 0, turns: 0 })),
      byWeekday: report.byWeekday.map((slot) => ({ ...slot, io: 0, total: 0, turns: 0 })),
    };
    const html = renderToStaticMarkup(<UsageRhythm report={empty} metric="ioTokens" />);
    expect(html).toContain("この期間の記録はありません。");
    expect(html).not.toContain("入出力トークンが最も多い日");
  });
});
