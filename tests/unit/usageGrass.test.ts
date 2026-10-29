import { describe, expect, it } from "vitest";
import { buildRange, parseDayInput, type SeriesBucket, type SeriesGroup, type SeriesReport } from "../../src/lib/ailog";
import { buildUsageGrass, grassLevels } from "../../src/components/ailog/usageGrassModel";
import { DAY_MS, OTHER_GROUP } from "../../src/components/ailog/usageModel";
import { NEUTRAL_COLOR, seriesPaint } from "../../src/components/ailog/modelColors";

const day = (value: string) => parseDayInput(value)!;
const group = (name: string, value: number, sessions = 1): SeriesGroup => ({ group: name, input: value, output: 0, cacheRead: value * 2, cacheWrite: value, turns: value > 0 ? 1 : 0, sessions, costUsd: value / 100 });
function bucket(date: string, value: number, groups = [group("gpt-6.1-sol", value)]): SeriesBucket {
  return { bucket: day(date), turns: groups.reduce((sum, g) => sum + g.turns, 0), sessions: 1, costUsd: groups.reduce((sum, g) => sum + g.costUsd, 0), groups };
}
function report(from: number, to: number, buckets: SeriesBucket[] = []): SeriesReport {
  const empty = { models: [], tokens: 0 };
  return { range: { from, to, label: "検証" }, bucket: "day", groupBy: "model_raw", buckets, priceSource: "test", priceCoverage: { priced: empty, local: empty, internal: empty, flat: empty, reported: empty, unknown: empty, coveredTokenRatio: 1 }, costNote: "" };
}

describe("daily usage model", () => {
  it("includes both partial endpoint days in the rolling 30-day range", () => {
    const now = Date.parse("2026-10-29T15:00:00+09:00");
    const model = buildUsageGrass(report(now - 30 * DAY_MS, now), "ioTokens", "model_raw");
    expect(model.days).toHaveLength(31);
    expect(model.days[0].day).toBe(day("2026-09-29"));
    expect(model.days.at(-1)?.day).toBe(day("2026-10-29"));
  });
  it("uses buildRange's inclusive final millisecond without adding October 29", () => {
    const range = buildRange("custom", "2026-10-01", "2026-10-28")!;
    const model = buildUsageGrass(report(range.from!, range.to!, [bucket("2026-09-30", 99), bucket("2026-10-01", 1), bucket("2026-10-29", 99)]), "ioTokens", "model_raw");
    expect(model.days).toHaveLength(28);
    expect(model.days[0].day).toBe(day("2026-10-01"));
    expect(model.days.at(-1)?.day).toBe(day("2026-10-28"));
    expect(model.breakdown("all").total).toBe(1);
  });
  it("starts all-time at the first recorded day, even with unordered or zero-turn buckets", () => {
    const model = buildUsageGrass(report(-2305843009213693952, day("2026-10-06"), [bucket("2026-10-05", 5), bucket("2026-10-01", 0), bucket("2026-10-03", 3)]), "ioTokens", "model_raw");
    expect(model.days.map(d => d.shortLabel)).toEqual(["10/3", "10/4", "10/5", "10/6"]);
    expect(buildUsageGrass(report(-2305843009213693952, day("2026-10-06")), "ioTokens", "model_raw").days).toEqual([]);
  });
  it("puts Monday through Sunday in rows 0 through 6 and leaves outside seats empty", () => {
    const model = buildUsageGrass(report(day("2026-10-01"), day("2026-10-06")), "ioTokens", "model_raw");
    expect(model.weeks.map(week => week.map(d => d?.shortLabel ?? null))).toEqual([
      [null, null, null, "10/1", "10/2", "10/3", "10/4"],
      ["10/5", "10/6", null, null, null, null, null],
    ]);
  });
  it("uses nearest-rank quartiles with equality in the lower level", () => {
    expect(grassLevels([0, 1, 2, 3, 4, 5, 6, 7, 8])).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
    expect(grassLevels([2, 2, 2, 3, 3, 4, 4, 5])).toEqual([1, 1, 1, 2, 2, 3, 3, 4]);
  });
  it("puts a single positive magnitude at level 4 and non-positive values at 0", () => {
    expect(grassLevels([0, 7, 7, -2])).toEqual([0, 4, 4, 0]);
    expect(grassLevels([0, 0, -1])).toEqual([0, 0, 0]);
  });
  it("reports the actual value range of every occupied legend level", () => {
    const entries = Array.from({ length: 8 }, (_, i) => bucket(`2026-10-0${i + 1}`, i + 1));
    const model = buildUsageGrass(report(day("2026-10-01"), day("2026-10-09"), entries), "ioTokens", "model_raw");
    expect(model.legend.map(l => [l.min, l.max])).toEqual([[0, 0], [1, 2], [3, 4], [5, 6], [7, 8]]);
    expect(model.legend[0].label).toBe("記録なし");
    expect(model.legend[1].label).toBe("1 tok〜2 tok");
  });
  it("drops the initial month label when the next month is less than three columns away", () => {
    const model = buildUsageGrass(report(day("2026-09-29"), day("2026-11-04")), "turns", "model_raw");
    expect(model.months.map(m => m.label)).toEqual(["10月", "11月"]);
    expect(model.months[1].column - model.months[0].column).toBeGreaterThanOrEqual(3);
    const spaced = buildUsageGrass(report(day("2026-10-05"), day("2026-11-30")), "turns", "model_raw");
    expect(spaced.months[0]).toEqual({ column: 0, label: "10月" });
  });
  it("counts recorded days independently of the metric, ends the current streak at the last record, and resolves peak ties to the newer date", () => {
    const entries = [1, 2, 3, 5, 6].map(n => bucket(`2026-10-0${n}`, n === 3 || n === 6 ? 20 : 2));
    const model = buildUsageGrass(report(day("2026-10-01"), day("2026-10-08"), entries), "ioTokens", "model_raw");
    expect(model.activeDays).toBe(5);
    expect(model.current).toEqual({ count: 2, end: day("2026-10-06") });
    expect(model.longest).toEqual({ count: 3, end: day("2026-10-03") });
    expect(model.peak?.day).toBe(day("2026-10-06"));
    const zeroMetric = { ...entries[0], groups: [group("gpt-6.1-sol", 0)], turns: 2 };
    const zero = buildUsageGrass(report(day("2026-10-01"), day("2026-10-02"), [zeroMetric]), "ioTokens", "model_raw");
    expect(zero.activeDays).toBe(1);
    expect(zero.days.map(d => d.level)).toEqual([0, 0]);
    expect(zero.recordedDays.map(d => d.day)).toEqual([day("2026-10-01")]);
  });
  it("aggregates the period, retains eight groups, and lists every folded name in a neutral row", () => {
    const groups = Array.from({ length: 11 }, (_, i) => group(`sample-${String(i).padStart(2, "0")}`, 11 - i));
    const entries = [bucket("2026-10-01", 0, groups), bucket("2026-10-02", 0, [group("sample-10", 30)])];
    const model = buildUsageGrass(report(day("2026-10-01"), day("2026-10-02"), entries), "ioTokens", "model_raw");
    const overall = model.breakdown("all");
    expect(overall.total).toBe(96);
    expect(overall.rows).toHaveLength(9);
    expect(overall.rows[0].group).toBe("sample-10");
    expect(overall.rows.at(-1)).toMatchObject({ group: OTHER_GROUP, value: 9, members: ["sample-07", "sample-08", "sample-09"], paint: { color: NEUTRAL_COLOR, tone: "neutral" } });
    expect(overall.rows.reduce((sum, row) => sum + row.share!, 0)).toBeCloseTo(100, 5);
    expect(overall.rows.reduce((sum, row) => sum + Number(row.shareLabel!.replace("%", "")), 0)).toBeCloseTo(100, 0);
    expect(model.breakdown(day("2026-10-01")).rows[0].group).toBe("sample-00");
  });
  it("sorts equal-valued groups by name", () => {
    const model = buildUsageGrass(report(day("2026-10-01"), day("2026-10-01"), [bucket("2026-10-01", 0, [group("sample-b", 2), group("sample-a", 2)])]), "ioTokens", "model_raw");
    expect(model.breakdown("all").rows.map(r => r.group)).toEqual(["sample-a", "sample-b"]);
  });
  it("keeps the same name's paint when its ranking changes", () => {
    const entries = [bucket("2026-10-01", 0, [group("gpt-6.1-sol", 9), group("claude-opus-5-5", 1)]), bucket("2026-10-02", 0, [group("gpt-6.1-sol", 1), group("claude-opus-5-5", 9)])];
    const model = buildUsageGrass(report(day("2026-10-01"), day("2026-10-02"), entries), "ioTokens", "model_raw");
    expect(model.breakdown(entries[0].bucket).rows[0].group).not.toBe(model.breakdown(entries[1].bucket).rows[0].group);
    for (const entry of entries) for (const row of model.breakdown(entry.bucket).rows) expect(row.paint).toEqual(seriesPaint(row.group, "model_raw"));
  });
  it("uses bucket sessions for each day and their extended sum for the period, with no percentages", () => {
    const entries = ["2026-10-01", "2026-10-02"].map(date => ({ ...bucket(date, 0, [group("sample-a", 1, 3), group("sample-b", 1, 2)]), sessions: 4 }));
    const model = buildUsageGrass(report(day("2026-10-01"), day("2026-10-02"), entries), "sessions", "model_raw");
    expect(model.days.map(d => d.value)).toEqual([4, 4]);
    expect(model.breakdown("all").total).toBe(8);
    expect(model.breakdown("all").totalLabel).toBe("延べ 8");
    expect(model.breakdown("all").rows.map(r => r.value)).toEqual([6, 4]);
    expect(model.breakdown("all").rows.every(r => r.share === null && r.shareLabel === null)).toBe(true);
    expect(model.breakdown(day("2026-10-01")).total).toBe(4);
    expect(model.days[0].tooltip).not.toContain("%");
  });
  it.each([["totalTokens", 40], ["turns", 1], ["costUsd", 0.1]] as const)("evaluates %s using metricValue", (metric, expected) => {
    const model = buildUsageGrass(report(day("2026-10-01"), day("2026-10-01"), [bucket("2026-10-01", 10)]), metric, "model_raw");
    expect(model.days[0].value).toBe(expected);
  });
});

describe("truthful empty and zero-value usage", () => {
  it("keeps an empty period separate from recorded zero values and omits its peak", () => {
    const model = buildUsageGrass(report(day("2026-10-01"), day("2026-10-03")), "ioTokens", "model_raw");
    expect(model.periodState).toBe("empty");
    expect(model.periodMessage).toBe("この期間の記録はありません。");
    expect(model.peak).toBeNull();
    expect(model.summaryItems.map(item => item.label)).toEqual(["記録のある日", "連続", "最長"]);
    expect(model.summary).not.toContain("最多");
    expect(model.breakdown("all").recorded).toBe(false);
  });
  it("keeps recorded all-zero periods distinct and never claims a peak", () => {
    const entry = bucket("2026-10-01", 20, [{ ...group("unpriced-model", 20), costUsd: 0 }]);
    const model = buildUsageGrass(report(day("2026-10-01"), day("2026-10-03"), [entry]), "costUsd", "model_raw");
    expect(model.periodState).toBe("zero");
    expect(model.periodMessage).toBe("この期間のコスト相当は0です。");
    expect(model.activeDays).toBe(1);
    expect(model.peak).toBeNull();
    expect(model.summaryItems.map(item => item.label)).not.toContain("最多");
    expect(model.summary).not.toContain("最多");
    expect(model.breakdown("all")).toMatchObject({ recorded: true, rows: [], foldedCount: 0 });
  });
  it("chooses a positive peak before later zero days in a mixed period", () => {
    const entries = [bucket("2026-10-01", 15), { ...bucket("2026-10-03", 0), turns: 2 }];
    const model = buildUsageGrass(report(day("2026-10-01"), day("2026-10-04"), entries), "ioTokens", "model_raw");
    expect(model.periodState).toBe("positive");
    expect(model.periodMessage).toBeNull();
    expect(model.peak).toMatchObject({ day: day("2026-10-01"), value: 15 });
    expect(model.summaryItems.at(-1)).toEqual({ label: "最多", value: "10/1（木） 15 tok" });
  });
  it("omits a leading group from recorded zero-day hints and reserves no-record for absent days", () => {
    const entry = bucket("2026-10-01", 20, [{ ...group("unpriced-model", 20), costUsd: 0 }]);
    const model = buildUsageGrass(report(day("2026-10-01"), day("2026-10-02"), [entry]), "costUsd", "model_raw");
    expect(model.days[0]).toMatchObject({ recorded: true, topLabel: "—", tooltip: "10/1（木） · ¥0.0" });
    expect(model.days[1]).toMatchObject({ recorded: false, topLabel: "記録なし", tooltip: "10/2（金） · ¥0.0 · 記録なし" });
  });
  it("uses the zero-or-absent legend title only when a recorded zero day exists", () => {
    const without = buildUsageGrass(report(day("2026-10-01"), day("2026-10-02"), [bucket("2026-10-01", 15)]), "ioTokens", "model_raw");
    const withZero = buildUsageGrass(report(day("2026-10-01"), day("2026-10-02"), [{ ...bucket("2026-10-01", 0), turns: 1 }]), "ioTokens", "model_raw");
    expect(without.legend[0].label).toBe("記録なし");
    expect(withZero.legend[0].label).toBe("0 または記録なし");
  });
  it.each(["ioTokens", "sessions"] as const)("filters non-positive %s groups before ranking and counting folded rows for both scopes", metric => {
    const positive = Array.from({ length: 9 }, (_, i) => group("positive-" + i, 20 - i, 20 - i));
    const nonPositive = [group("zero-after-ninth", 0, 0), group("negative-after-ninth", -1, -1)];
    const entry = bucket("2026-10-01", 0, [...positive, ...nonPositive]);
    const model = buildUsageGrass(report(day("2026-10-01"), day("2026-10-02"), [entry]), metric, "model_raw");
    for (const scope of ["all", entry.bucket] as const) {
      const data = model.breakdown(scope);
      expect(data.rows).toHaveLength(9);
      expect(data.foldedCount).toBe(1);
      expect(data.rows.at(-1)).toMatchObject({ group: OTHER_GROUP, value: 12, members: ["positive-8"] });
      expect(data.rows.every(row => row.value > 0)).toBe(true);
    }
    const eight = buildUsageGrass(report(entry.bucket, entry.bucket, [{ ...entry, groups: [...positive.slice(0, 8), ...nonPositive] }]), metric, "model_raw");
    expect(eight.breakdown("all").rows).toHaveLength(8);
    expect(eight.breakdown("all").foldedCount).toBe(0);
    expect(eight.breakdown(entry.bucket).rows).toHaveLength(8);
    expect(eight.breakdown(entry.bucket).foldedCount).toBe(0);
  });
  it.each([["turns", "ターン数", 23], ["sessions", "セッション数", 4]] as const)("names the %s count in the accessible hint", (metric, label, value) => {
    const entry = { ...bucket("2026-10-01", 10, [{ ...group("sample", 10, 4), turns: 23 }]), sessions: 4 };
    const model = buildUsageGrass(report(entry.bucket, entry.bucket, [entry]), metric, "model_raw");
    expect(model.days[0].tooltipValueLabel).toBe(label + " " + value);
    expect(model.days[0].tooltip).toBe("10/1（木） · " + label + " " + value + (metric === "sessions" ? " · sample" : " · sample 100.0%"));
  });
  it("writes a singleton legend band as one value", () => {
    const entry = bucket("2026-10-01", 15);
    const model = buildUsageGrass(report(entry.bucket, entry.bucket, [entry]), "ioTokens", "model_raw");
    expect(model.legend[4]).toMatchObject({ min: 15, max: 15, label: "15 tok" });
  });
  it("stores display labels rather than raw provider IDs in folded members", () => {
    const groups = [...Array.from({ length: 8 }, (_, i) => group("sample-" + i, 20 - i)), group("local", 2), group("(unknown)", 1)];
    const entry = bucket("2026-10-01", 0, groups);
    const model = buildUsageGrass(report(entry.bucket, entry.bucket, [entry]), "ioTokens", "provider");
    expect(model.breakdown("all").rows.at(-1)?.members).toEqual(["ローカル", "ログにモデル名なし"]);
    expect(model.breakdown(entry.bucket).rows.at(-1)?.members).toEqual(["ローカル", "ログにモデル名なし"]);
  });
});
