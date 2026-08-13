/**
 * Shape of the usage tab: which metric a series is measured in, how the daily
 * stack is laid out, and how models are folded into a readable number of bands.
 * Pure, so every rule below is pinned by tests rather than by reading a chart.
 *
 * The tab exists because one dataset tells opposite stories depending on the
 * metric: measured in cost one provider dominates, measured in fresh
 * input/output tokens the other does. Neither is wrong, so the metric is a
 * first-class control and every number on screen states which one it is in.
 */

import {
  DAY_OFFSET_MIN,
  formatCount,
  formatDayBucket,
  formatTokens,
  type RhythmSlot,
  type SeriesBucket,
  type SeriesGroup,
} from "../../lib/ailog";
import { MODEL_COLORS, NEUTRAL_COLOR } from "./palette";

export const DAY_MS = 86_400_000;

export type UsageMetric = "ioTokens" | "totalTokens" | "turns" | "sessions";

export interface UsageMetricInfo {
  id: UsageMetric;
  label: string;
  /** Shown under the headline number, stating what was counted. */
  hint: string;
  unit: "tokens" | "count";
}

export const USAGE_METRICS: UsageMetricInfo[] = [
  {
    id: "ioTokens",
    label: "入出力トークン",
    hint: "送った分と生成させた分。キャッシュ読み出しを含みません",
    unit: "tokens",
  },
  {
    id: "totalTokens",
    label: "総トークン",
    hint: "キャッシュ読み書きを含む、モデルが処理した総量",
    unit: "tokens",
  },
  { id: "turns", label: "ターン数", hint: "API 呼び出しの回数", unit: "count" },
  {
    id: "sessions",
    label: "セッション数",
    hint: "会話の本数。1 本が複数モデルに跨るため積み上げできません",
    unit: "count",
  },
];

export function usageMetricInfo(metric: UsageMetric): UsageMetricInfo {
  return USAGE_METRICS.find((entry) => entry.id === metric) ?? USAGE_METRICS[0];
}

/**
 * Value of one group under the selected metric.
 *
 * `totalTokens` deliberately omits reasoning tokens: Codex reports them as a
 * subset of `output` and Claude folds them into `output`, so adding them would
 * count the same tokens twice. The backend omits them from `SeriesGroup` for
 * the same reason.
 */
export function metricValue(group: SeriesGroup, metric: UsageMetric): number {
  switch (metric) {
    case "ioTokens":
      return group.input + group.output;
    case "totalTokens":
      return group.input + group.output + group.cacheRead + group.cacheWrite;
    case "turns":
      return group.turns;
    case "sessions":
      return group.sessions;
  }
}

/**
 * Whether a metric may be drawn as a stack.
 *
 * Session counts may not: one session that used three models is counted once
 * under each, so the groups of a day sum to more than the day's own session
 * total. Stacking them would draw a bar taller than the truth. Everything else
 * is a per-turn quantity and adds up exactly.
 */
export function isStackable(metric: UsageMetric): boolean {
  return metric !== "sessions";
}

export function formatMetric(value: number, metric: UsageMetric): string {
  return usageMetricInfo(metric).unit === "tokens"
    ? formatTokens(value)
    : formatCount(value);
}

// ---------------------------------------------------------------------------
// Daily stack
// ---------------------------------------------------------------------------

export interface UsageSlice {
  group: string;
  value: number;
  color: string;
}

export interface UsageDay {
  /** Start of the local day; also the map key coming from the backend. */
  day: number;
  label: string;
  total: number;
  /** Day-level session count, which is de-duplicated across models. */
  sessions: number;
  costUsd: number;
  slices: UsageSlice[];
  /** False for days filled in to keep the axis continuous. */
  present: boolean;
}

export interface UsageModel {
  days: UsageDay[];
  /** Groups in descending order of their period total, after folding. */
  legend: UsageSlice[];
  max: number;
  periodTotal: number;
  /** Groups folded into the "その他" band, if any. */
  foldedCount: number;
}

export const OTHER_GROUP = "その他";
export const UNKNOWN_GROUP = "(unknown)";
export const UNKNOWN_LABEL = "モデル不明";

/** `(unknown)` comes from turns whose transcript recorded no model name. */
export function groupLabel(group: string): string {
  if (group === UNKNOWN_GROUP) return UNKNOWN_LABEL;
  return group;
}

function colorFor(group: string, index: number): string {
  if (group === UNKNOWN_GROUP || group === OTHER_GROUP) return NEUTRAL_COLOR;
  return MODEL_COLORS[index % MODEL_COLORS.length];
}

/**
 * Fold a series into per-day stacks.
 *
 * Days with no activity inside the reported span are emitted with a zero total
 * rather than dropped, so a quiet week reads as a gap instead of silently
 * compressing the axis.
 */
export function buildUsageModel(
  buckets: SeriesBucket[],
  metric: UsageMetric,
  topN = MODEL_COLORS.length,
): UsageModel {
  const totals = new Map<string, number>();
  for (const bucket of buckets) {
    for (const group of bucket.groups) {
      totals.set(group.group, (totals.get(group.group) ?? 0) + metricValue(group, metric));
    }
  }

  const ranked = [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([group]) => group);
  const kept = ranked.slice(0, Math.max(0, topN));
  const folded = ranked.slice(kept.length);
  const colors = new Map<string, string>();
  kept.forEach((group, index) => colors.set(group, colorFor(group, index)));

  const byDay = new Map<number, SeriesBucket>();
  for (const bucket of buckets) byDay.set(bucket.bucket, bucket);
  const present = [...byDay.keys()].sort((a, b) => a - b);

  const days: UsageDay[] = [];
  if (present.length > 0) {
    for (let day = present[0]; day <= present[present.length - 1]; day += DAY_MS) {
      const bucket = byDay.get(day);
      const slices: UsageSlice[] = [];
      let otherValue = 0;
      for (const group of bucket?.groups ?? []) {
        const value = metricValue(group, metric);
        if (value <= 0) continue;
        if (colors.has(group.group)) {
          slices.push({ group: group.group, value, color: colors.get(group.group) as string });
        } else {
          otherValue += value;
        }
      }
      if (otherValue > 0) {
        slices.push({ group: OTHER_GROUP, value: otherValue, color: NEUTRAL_COLOR });
      }
      slices.sort(
        (a, b) => kept.indexOf(a.group) - kept.indexOf(b.group) || a.group.localeCompare(b.group),
      );
      days.push({
        day,
        label: formatDayBucket(day),
        total: slices.reduce((sum, slice) => sum + slice.value, 0),
        sessions: bucket?.sessions ?? 0,
        costUsd: bucket?.costUsd ?? 0,
        slices,
        present: bucket !== undefined,
      });
    }
  }

  const legend: UsageSlice[] = kept.map((group, index) => ({
    group,
    value: totals.get(group) ?? 0,
    color: colorFor(group, index),
  }));
  if (folded.length > 0) {
    legend.push({
      group: OTHER_GROUP,
      value: folded.reduce((sum, group) => sum + (totals.get(group) ?? 0), 0),
      color: NEUTRAL_COLOR,
    });
  }

  return {
    days,
    legend,
    max: days.reduce((max, day) => Math.max(max, day.total), 0),
    periodTotal: legend.reduce((sum, entry) => sum + entry.value, 0),
    foldedCount: folded.length,
  };
}

export interface StackRect {
  group: string;
  color: string;
  value: number;
  /** Fraction of the tallest day, 0..1, measured from the baseline. */
  offset: number;
  height: number;
}

/**
 * Lay one day's slices out as fractions of `max`, bottom-up.
 *
 * In share mode each day fills the full height, which answers "what was the mix
 * that day" rather than "how much was that day". A day with no activity stays
 * empty in both modes instead of being drawn as an even split of nothing.
 */
export function layoutStack(day: UsageDay, max: number, mode: "absolute" | "share"): StackRect[] {
  const denominator = mode === "share" ? day.total : max;
  if (denominator <= 0) return [];
  const rects: StackRect[] = [];
  let offset = 0;
  for (const slice of day.slices) {
    const height = slice.value / denominator;
    rects.push({ group: slice.group, color: slice.color, value: slice.value, offset, height });
    offset += height;
  }
  return rects;
}

// ---------------------------------------------------------------------------
// Rhythm
// ---------------------------------------------------------------------------

export const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

/** `+09:00` — shown next to hour-of-day figures so the axis is not ambiguous. */
export function offsetLabel(minutes = DAY_OFFSET_MIN): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${`${Math.floor(abs / 60)}`.padStart(2, "0")}:${`${abs % 60}`.padStart(2, "0")}`;
}

export interface SlotBar {
  slot: number;
  label: string;
  value: number;
  /** Fraction of the busiest slot, 0..1. */
  ratio: number;
}

export function slotBars(
  slots: RhythmSlot[],
  metric: UsageMetric,
  kind: "hour" | "weekday",
): SlotBar[] {
  const valueOf = (slot: RhythmSlot) => {
    switch (metric) {
      case "ioTokens":
        return slot.io;
      case "totalTokens":
        return slot.total;
      default:
        return slot.turns;
    }
  };
  const max = slots.reduce((peak, slot) => Math.max(peak, valueOf(slot)), 0);
  return slots.map((slot) => ({
    slot: slot.slot,
    label: kind === "hour" ? `${slot.slot}時` : (WEEKDAY_LABELS[slot.slot] ?? `${slot.slot}`),
    value: valueOf(slot),
    ratio: max > 0 ? valueOf(slot) / max : 0,
  }));
}

/** The busiest slot, or null when nothing was recorded. */
export function peakSlot(bars: SlotBar[]): SlotBar | null {
  const peak = bars.reduce<SlotBar | null>(
    (best, bar) => (best === null || bar.value > best.value ? bar : best),
    null,
  );
  return peak && peak.value > 0 ? peak : null;
}

/** `155 / 161 日 (96%)` — the share of the span that saw any activity. */
export function activeDayRatio(activeDays: number, spanDays: number): number {
  return spanDays > 0 ? activeDays / spanDays : 0;
}
