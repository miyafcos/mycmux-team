import { describe, expect, it } from "vitest";

import { DAY_OFFSET_MIN, type RhythmSlot, type SeriesBucket, type SeriesGroup } from "../../src/lib/ailog";
import { MODEL_COLORS, NEUTRAL_COLOR } from "../../src/components/ailog/palette";
import {
  DAY_MS,
  OTHER_GROUP,
  UNKNOWN_GROUP,
  activeDayRatio,
  buildUsageModel,
  groupLabel,
  isStackable,
  layoutStack,
  metricValue,
  offsetLabel,
  peakSlot,
  slotBars,
} from "../../src/components/ailog/usageModel";

const OFFSET_MS = DAY_OFFSET_MIN * 60_000;
/** Local midnight opening 2026-08-13 (15:00Z on the 12th). */
const AUG13 = Date.UTC(2026, 7, 13) - OFFSET_MS;

function group(name: string, over: Partial<SeriesGroup> = {}): SeriesGroup {
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

function bucket(day: number, groups: SeriesGroup[], over: Partial<SeriesBucket> = {}): SeriesBucket {
  return {
    bucket: day,
    turns: groups.reduce((sum, entry) => sum + entry.turns, 0),
    sessions: groups.reduce((sum, entry) => sum + entry.sessions, 0),
    costUsd: groups.reduce((sum, entry) => sum + entry.costUsd, 0),
    groups,
    ...over,
  };
}

describe("usage metrics", () => {
  const row = group("opus-5", {
    input: 100,
    output: 20,
    cacheRead: 900,
    cacheWrite: 40,
    turns: 7,
    sessions: 3,
  });

  it("counts fresh input and output for the io metric", () => {
    expect(metricValue(row, "ioTokens")).toBe(120);
  });

  it("adds cache traffic for the total metric and never adds reasoning", () => {
    // 100 + 20 + 900 + 40. `SeriesGroup` carries no reasoning field precisely
    // so that this sum cannot double-count tokens already inside `output`.
    expect(metricValue(row, "totalTokens")).toBe(1060);
    expect(Object.keys(row)).not.toContain("reasoning");
  });

  it("passes turn and session counts through untouched", () => {
    expect(metricValue(row, "turns")).toBe(7);
    expect(metricValue(row, "sessions")).toBe(3);
  });

  it("refuses to stack session counts", () => {
    // One session spanning three models is counted under each, so per-group
    // sums exceed the day's own session total.
    expect(isStackable("sessions")).toBe(false);
    expect(isStackable("turns")).toBe(true);
    expect(isStackable("ioTokens")).toBe(true);
    expect(isStackable("totalTokens")).toBe(true);
  });
});

describe("daily stack", () => {
  it("keeps a day per calendar slot, including quiet ones", () => {
    const model = buildUsageModel(
      [
        bucket(AUG13, [group("a", { input: 10 })]),
        // Nothing on the 14th.
        bucket(AUG13 + 2 * DAY_MS, [group("a", { input: 30 })]),
      ],
      "ioTokens",
    );

    expect(model.days.map((day) => day.label)).toEqual([
      "2026-08-13",
      "2026-08-14",
      "2026-08-15",
    ]);
    expect(model.days.map((day) => day.present)).toEqual([true, false, true]);
    expect(model.days[1].total).toBe(0);
    expect(model.days[1].slices).toEqual([]);
  });

  it("labels day buckets in the bucketing timezone", () => {
    const model = buildUsageModel([bucket(AUG13, [group("a", { input: 1 })])], "ioTokens");
    expect(model.days[0].label).toBe("2026-08-13");
    // The same instant is still the 12th in UTC, which is what the old
    // bucketing displayed.
    expect(new Date(AUG13).getUTCDate()).toBe(12);
  });

  it("folds everything past topN into one band without losing the total", () => {
    const groups = Array.from({ length: 10 }, (_, index) =>
      group(`m${index}`, { input: 100 - index }),
    );
    const model = buildUsageModel([bucket(AUG13, groups)], "ioTokens", 8);

    expect(model.legend).toHaveLength(9);
    expect(model.legend[8].group).toBe(OTHER_GROUP);
    expect(model.foldedCount).toBe(2);
    const expected = groups.reduce((sum, entry) => sum + entry.input, 0);
    expect(model.periodTotal).toBe(expected);
    expect(model.days[0].total).toBe(expected);
  });

  it("gives a model the same colour on every day, and greys the unknown band", () => {
    const model = buildUsageModel(
      [
        bucket(AUG13, [group("a", { input: 50 }), group(UNKNOWN_GROUP, { input: 5 })]),
        bucket(AUG13 + DAY_MS, [group("b", { input: 40 }), group("a", { input: 10 })]),
      ],
      "ioTokens",
    );

    const colourOf = (dayIndex: number, name: string) =>
      model.days[dayIndex].slices.find((slice) => slice.group === name)?.color;
    expect(colourOf(0, "a")).toBe(colourOf(1, "a"));
    expect(colourOf(0, "a")).toBe(MODEL_COLORS[0]);
    expect(colourOf(0, UNKNOWN_GROUP)).toBe(NEUTRAL_COLOR);
    expect(groupLabel(UNKNOWN_GROUP)).toBe("モデル不明");
    expect(groupLabel("opus-5")).toBe("opus-5");
  });

  it("stacks a day's slices to the height of the busiest day", () => {
    const model = buildUsageModel(
      [
        bucket(AUG13, [group("a", { input: 60 }), group("b", { input: 40 })]),
        bucket(AUG13 + DAY_MS, [group("a", { input: 50 })]),
      ],
      "ioTokens",
    );

    const tall = layoutStack(model.days[0], model.max, "absolute");
    expect(tall.map((rect) => rect.height)).toEqual([0.6, 0.4]);
    expect(tall[0].offset).toBe(0);
    expect(tall[1].offset).toBeCloseTo(0.6, 10);

    const short = layoutStack(model.days[1], model.max, "absolute");
    expect(short[0].height).toBeCloseTo(0.5, 10);
  });

  it("fills the height in share mode and stays empty on a silent day", () => {
    const model = buildUsageModel(
      [
        bucket(AUG13, [group("a", { input: 1 }), group("b", { input: 3 })]),
        bucket(AUG13 + 2 * DAY_MS, [group("a", { input: 10 })]),
      ],
      "ioTokens",
    );

    const shares = layoutStack(model.days[0], model.max, "share");
    expect(shares.reduce((sum, rect) => sum + rect.height, 0)).toBeCloseTo(1, 10);
    expect(shares.every((rect) => Number.isFinite(rect.height))).toBe(true);

    const quiet = layoutStack(model.days[1], model.max, "share");
    expect(quiet).toEqual([]);
  });

  it("returns an empty model rather than throwing on no data", () => {
    const model = buildUsageModel([], "totalTokens");
    expect(model.days).toEqual([]);
    expect(model.legend).toEqual([]);
    expect(model.max).toBe(0);
    expect(model.periodTotal).toBe(0);
    expect(layoutStack({ day: 0, label: "", total: 0, sessions: 0, costUsd: 0, slices: [], present: false }, 0, "absolute")).toEqual([]);
  });

  it("carries the day-level session count, not the sum of its groups", () => {
    // Two models, one shared session: the day total must stay 1.
    const model = buildUsageModel(
      [bucket(AUG13, [group("a", { sessions: 1 }), group("b", { sessions: 1 })], { sessions: 1 })],
      "ioTokens",
    );
    expect(model.days[0].sessions).toBe(1);
  });
});

describe("rhythm", () => {
  const slots = (values: number[]): RhythmSlot[] =>
    values.map((value, index) => ({ slot: index, turns: value, io: value * 2, total: value * 3 }));

  it("scales bars against the busiest slot", () => {
    const bars = slotBars(slots([0, 5, 10, 0]), "turns", "hour");
    expect(bars.map((bar) => bar.ratio)).toEqual([0, 0.5, 1, 0]);
    expect(bars.map((bar) => bar.label)).toEqual(["0時", "1時", "2時", "3時"]);
  });

  it("reads the metric the caller selected", () => {
    const bars = slotBars(slots([1, 2]), "totalTokens", "hour");
    expect(bars.map((bar) => bar.value)).toEqual([3, 6]);
  });

  it("names weekdays with Sunday first", () => {
    const bars = slotBars(slots([0, 0, 0, 0, 1, 0, 0]), "turns", "weekday");
    expect(bars.map((bar) => bar.label)).toEqual(["日", "月", "火", "水", "木", "金", "土"]);
    expect(peakSlot(bars)?.label).toBe("木");
  });

  it("reports no peak when nothing was recorded", () => {
    expect(peakSlot(slotBars(slots([0, 0, 0]), "turns", "hour"))).toBeNull();
  });

  it("states the offset the hour axis is measured in", () => {
    expect(offsetLabel(540)).toBe("+09:00");
    expect(offsetLabel(0)).toBe("+00:00");
    expect(offsetLabel(-330)).toBe("-05:30");
  });

  it("never divides by a zero span", () => {
    expect(activeDayRatio(155, 161)).toBeCloseTo(0.9627, 4);
    expect(activeDayRatio(0, 0)).toBe(0);
  });
});
