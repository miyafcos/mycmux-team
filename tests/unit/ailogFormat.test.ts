import { describe, expect, it } from "vitest";

import {
  DAY_OFFSET_MIN,
  RANGE_PRESETS,
  WORK_TAG_LABELS,
  buildRange,
  dayOffsetInput,
  formatCount,
  formatDayBucket,
  formatDelta,
  formatHours,
  formatPct,
  formatRatio,
  formatTokens,
  formatTokensFull,
  formatUsd,
  formatUsdShort,
  parseDayInput,
  shiftDayInput,
  toDayInput,
  workTagHint,
  workTagLabel,
} from "../../src/lib/ailog";

const DAY_MS = 86_400_000;
/** Day boundaries are cut locally; see `DAY_OFFSET_MIN`. */
const OFFSET_MS = DAY_OFFSET_MIN * 60_000;

describe("number formatting", () => {
  it("uses locale grouping for money, tokens, counts, percentages and hours", () => {
    expect(formatUsd(1470.239)).toBe("$1,470.24");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsdShort(27_350.4)).toBe("$27,350");
    expect(formatCount(76_105)).toBe("76,105");
    expect(formatTokens(12_345_678)).toBe("1,234.6万 tok");
    expect(formatTokens(4_512)).toBe("4,512 tok");
    expect(formatTokens(938)).toBe("938 tok");
    expect(formatRatio(0.9783)).toBe("97.8%");
    expect(formatPct(59.12)).toBe("59.1%");
    expect(formatHours(116_000_000)).toBe("32.2時間");
  });

  it("never emits NaN for missing numbers", () => {
    expect(formatUsd(Number.NaN)).toBe("$0.00");
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("0 tok");
    expect(formatRatio(Number.NaN)).toBe("0.0%");
  });

  it("uses 万・億・兆 with carry and grouped mantissa", () => {
    expect(formatTokens(0)).toBe("0 tok");
    expect(formatTokens(9_999)).toBe("9,999 tok");
    expect(formatTokens(10_000)).toBe("1.0万 tok");
    expect(formatTokens(12_345_678)).toBe("1,234.6万 tok");
    expect(formatTokens(99_995_000)).toBe("9,999.5万 tok");
    expect(formatTokens(99_999_500)).toBe("1.0億 tok");
    expect(formatTokens(100_000_000)).toBe("1.0億 tok");
    expect(formatTokens(1_234_567_890)).toBe("12.3億 tok");
    expect(formatTokens(999_999_950_000)).toBe("1.0兆 tok");
    expect(formatTokens(1_500_000_000_000)).toBe("1.5兆 tok");
    expect(formatTokens(-12_345_678)).toBe("-1,234.6万 tok");
    expect(formatTokens(-99_999_500)).toBe("-1.0億 tok");
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("0 tok");
    expect(formatTokens(Number.NaN)).toBe("0 tok");
    expect(formatTokensFull(12_345_678)).toBe("12,345,678 tok");
  });

  it("marks direction on the compare-previous delta", () => {
    expect(formatDelta(12.34)).toBe("▲12.3%");
    expect(formatDelta(-4.5)).toBe("▼4.5%");
    expect(formatDelta(0)).toBe("±0.0%");
  });
});

describe("range presets", () => {
  it("offers the six documented choices", () => {
    expect(RANGE_PRESETS.map((entry) => entry.id)).toEqual([
      "7d",
      "30d",
      "90d",
      "ytd",
      "all",
      "custom",
    ]);
    expect(RANGE_PRESETS.map((entry) => entry.label)).toEqual([
      "7日",
      "30日",
      "90日",
      "今年",
      "全期間",
      "カスタム",
    ]);
  });

  it("passes presets straight through to the backend Range", () => {
    expect(buildRange("7d")).toEqual({ preset: "7d" });
    expect(buildRange("30d")).toEqual({ preset: "30d" });
    expect(buildRange("90d")).toEqual({ preset: "90d" });
    expect(buildRange("ytd")).toEqual({ preset: "ytd" });
    expect(buildRange("all")).toEqual({ preset: "all" });
  });

  it("makes a custom range inclusive on both ends", () => {
    const range = buildRange("custom", "2026-08-01", "2026-08-10");
    expect(range).toEqual({
      from: Date.UTC(2026, 7, 1) - OFFSET_MS,
      to: Date.UTC(2026, 7, 10) - OFFSET_MS + DAY_MS - 1,
    });
  });

  it("treats a single day as that whole day", () => {
    const range = buildRange("custom", "2026-08-10", "2026-08-10");
    expect(range?.from).toBe(Date.UTC(2026, 7, 10) - OFFSET_MS);
    expect(range?.to).toBe(Date.UTC(2026, 7, 10) - OFFSET_MS + DAY_MS - 1);
    expect((range?.to ?? 0) - (range?.from ?? 0)).toBe(DAY_MS - 1);
  });

  it("swaps reversed dates instead of querying an empty window", () => {
    expect(buildRange("custom", "2026-08-10", "2026-08-01")).toEqual(
      buildRange("custom", "2026-08-01", "2026-08-10"),
    );
  });

  it("returns null until both custom dates are valid", () => {
    expect(buildRange("custom")).toBeNull();
    expect(buildRange("custom", "2026-08-01")).toBeNull();
    expect(buildRange("custom", "2026-13-01", "2026-08-10")).toBeNull();
    expect(buildRange("custom", "2026-02-30", "2026-08-10")).toBeNull();
    expect(buildRange("custom", "not-a-date", "2026-08-10")).toBeNull();
  });

  it("round-trips the date input format", () => {
    expect(toDayInput(parseDayInput("2026-01-05") ?? 0)).toBe("2026-01-05");
    expect(parseDayInput("2026-01-05")).toBe(Date.UTC(2026, 0, 5) - OFFSET_MS);
  });

  it("cuts the day at local midnight, not UTC midnight", () => {
    // 2026-08-12T15:00Z is already the 13th locally; the instant one
    // millisecond earlier is still the 12th.
    const localMidnight = Date.UTC(2026, 7, 13) - OFFSET_MS;
    expect(formatDayBucket(localMidnight)).toBe("2026-08-13");
    expect(formatDayBucket(localMidnight - 1)).toBe("2026-08-12");
    // Both instants share a UTC calendar day, which is what the old UTC
    // bucketing collapsed them onto.
    expect(new Date(localMidnight).getUTCDate()).toBe(12);
    expect(new Date(localMidnight - 1).getUTCDate()).toBe(12);
  });

  it("steps day inputs without drifting across the offset", () => {
    expect(shiftDayInput("2026-08-13", -1)).toBe("2026-08-12");
    expect(shiftDayInput("2026-08-13", 1)).toBe("2026-08-14");
    expect(shiftDayInput("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDayInput("not-a-date", -1)).toBe("not-a-date");
  });

  it("derives today and yesterday in the bucketing timezone", () => {
    // 2026-08-12T16:00Z is 2026-08-13 01:00 local: a UTC-based helper would
    // answer with the 12th here.
    const now = Date.UTC(2026, 7, 12, 16, 0, 0);
    expect(dayOffsetInput(0, now)).toBe("2026-08-13");
    expect(dayOffsetInput(-1, now)).toBe("2026-08-12");
  });
});

describe("work tag labels", () => {
  const expected: Record<string, string> = {
    explore: "コード探索",
    implement: "実装",
    verify: "検証実行",
    debug: "デバッグ",
    orchestrate: "委譲・並列",
    research: "外部調査",
    converse: "相談・計画",
    longhaul: "長丁場",
  };

  it("covers every tag the indexer can emit", () => {
    expect(Object.keys(WORK_TAG_LABELS).sort()).toEqual(Object.keys(expected).sort());
    for (const [tag, label] of Object.entries(expected)) {
      expect(workTagLabel(tag)).toBe(label);
      expect(workTagHint(tag).length).toBeGreaterThan(0);
    }
  });

  it("passes an unknown tag through untouched instead of dropping it", () => {
    expect(workTagLabel("brand_new_tag")).toBe("brand_new_tag");
    expect(workTagHint("brand_new_tag")).toContain("未登録");
  });
});
