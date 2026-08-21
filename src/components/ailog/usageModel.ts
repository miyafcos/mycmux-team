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
  formatBucketLabel,
  formatCount,
  formatTokens,
  formatTokensFull,
  formatUsd,
  kindLabel,
  type PivotAxis,
  type PriceCoverage,
  type RhythmSlot,
  type SeriesBucket,
  type SeriesGroupBy,
  type SeriesGroup,
  type UsageBucket,
} from "../../lib/ailog";
import { NEUTRAL_COLOR, SERIES_TOP_N, seriesPaint, type SeriesTone } from "./modelColors";

export const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const DAY_OFFSET_MS = DAY_OFFSET_MIN * 60_000;

export type { UsageBucket };
export type UsageMetric = "ioTokens" | "totalTokens" | "turns" | "sessions" | "costUsd";
/** RhythmSlot has no cost; the rhythm view never follows the cost metric. */
export type RhythmMetric = "ioTokens" | "totalTokens" | "turns";

export interface UsageMetricInfo {
  id: UsageMetric;
  label: string;
  /** Shown under the headline number, stating what was counted. */
  hint: string;
  unit: "tokens" | "count" | "usd";
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
  {
    id: "costUsd",
    label: "コスト相当",
    hint: "単価既知分のみの推計",
    unit: "usd",
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
    case "costUsd":
      return group.costUsd;
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
  const unit = usageMetricInfo(metric).unit;
  if (unit === "usd") return formatUsd(value);
  return unit === "tokens" ? formatTokens(value) : formatCount(value);
}

export function formatMetricFull(value: number, metric: UsageMetric): string {
  const unit = usageMetricInfo(metric).unit;
  if (unit === "usd") return formatUsd(value);
  return unit === "tokens" ? formatTokensFull(value) : formatCount(value);
}

/**
 * Up to three readable value-axis ticks, never exceeding the measured peak.
 * The step is rounded down at the leading digit so a 1,234,567 peak reads
 * 0 / 600,000 / 1,200,000 instead of arbitrary decimals.
 */
export function valueAxisTicks(max: number): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0];
  const half = max / 2;
  const magnitude = 10 ** Math.floor(Math.log10(half));
  const step = Math.floor(half / magnitude) * magnitude;
  if (!Number.isFinite(step) || step <= 0) return [0, max];
  const ticks = [0, step, step * 2].filter((value) => value <= max);
  return ticks.length >= 2 ? ticks : [0, max];
}

export function metricUnit(metric: UsageMetric): "tokens" | "count" | "usd" {
  return usageMetricInfo(metric).unit;
}

/**
 * The one catalog of grouping axes.
 *
 * Both the bar chart's grouping control and the cross-table's row/column
 * controls read from here. They used to keep separate lists, which let one grow
 * an axis the other never showed.
 *
 * `model_raw` leads and is the default because it is the only axis that keeps
 * gpt-5.6's sol / terra / luna apart; `model` folds them into the family.
 * Naming them "モデル" and "シリーズ" makes the label match what the values
 * actually look like on screen, which "系統" did not.
 */
export interface UsageAxis {
  value: PivotAxis;
  label: string;
  /** Shown as the control's tooltip. */
  hint: string;
  /** Whether the bar chart may group a series by this axis. */
  series: boolean;
}

export const USAGE_AXES: UsageAxis[] = [
  {
    value: "model_raw",
    label: "モデル",
    hint: "実際に選んだモデル。gpt-5.6 の sol / terra / luna を分けて見ます",
    series: true,
  },
  {
    value: "model",
    label: "シリーズ",
    hint: "sol / terra / luna をまとめた括り (gpt-5.6, opus-5)",
    series: true,
  },
  { value: "provider", label: "会社", hint: "Anthropic / OpenAI / xAI / Google / ローカル", series: true },
  {
    value: "project",
    label: "案件",
    hint: "作業パスと編集・参照ファイルから決めた案件名",
    series: true,
  },
  { value: "effort", label: "effort", hint: "Codex の reasoning effort", series: true },
  { value: "kind", label: "CLI", hint: "Claude Code / Codex / Grok", series: true },
  { value: "origin", label: "起動元", hint: "セッションを起こした経路", series: false },
];

/** The subset the bar chart may group by, narrowed to the series axis type. */
export const SERIES_AXES = USAGE_AXES.filter(
  (axis): axis is UsageAxis & { value: SeriesGroupBy } => axis.series,
);

export function axisLabel(axis: PivotAxis): string {
  return USAGE_AXES.find((entry) => entry.value === axis)?.label ?? axis;
}

/** Long-standing name for the same lookup, kept for the series call sites. */
export const groupByLabel = axisLabel;

export function bucketNoun(bucket: UsageBucket): string {
  return bucket === "week" ? "週" : bucket === "month" ? "月" : "日";
}

/** Same wording as the model table cost column. */
export function costCoverageLabel(coverage: PriceCoverage): string {
  return coverage.coveredTokenRatio < 1
    ? `コスト相当 (単価既知の ${Math.round(coverage.coveredTokenRatio * 100)}% 分)`
    : "コスト相当";
}

export interface ChangeBreakdown {
  totalDelta: number;
  volumeEffect: number;
  rateEffect: number;
  interaction: number;
}

/**
 * Split a cost change into request volume, cost per request, and their
 * interaction. A prior period with no requests has no meaningful unit cost,
 * so it is intentionally not decomposed.
 */
export function decomposeCostChange(
  costNow: number,
  requestsNow: number,
  costPrev: number,
  requestsPrev: number,
): ChangeBreakdown | null {
  if (requestsPrev <= 0 || requestsNow < 0 || costNow < 0 || costPrev < 0) return null;
  if (requestsNow === 0 && costNow !== 0) return null;

  const previousRate = costPrev / requestsPrev;
  const currentRate = requestsNow === 0 ? 0 : costNow / requestsNow;
  const requestDelta = requestsNow - requestsPrev;
  const rateDelta = currentRate - previousRate;

  return {
    totalDelta: costNow - costPrev,
    volumeEffect: requestDelta * previousRate,
    rateEffect: requestsPrev * rateDelta,
    interaction: requestDelta * rateDelta,
  };
}

/**
 * Advance one bucket in the same JST calendar the backend uses
 * (`query.rs` `bucket_start_at`: +9h, ISO Monday weeks, month = 1st).
 */
export function nextBucketStart(ms: number, bucket: UsageBucket): number {
  if (bucket === "day") return ms + DAY_MS;
  if (bucket === "week") return ms + WEEK_MS;
  const local = new Date(ms + DAY_OFFSET_MS);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - DAY_OFFSET_MS;
}

export function rhythmMetricOf(metric: UsageMetric): RhythmMetric {
  return metric === "ioTokens" || metric === "totalTokens" || metric === "turns"
    ? metric
    : "ioTokens";
}

// ---------------------------------------------------------------------------
// Daily stack
// ---------------------------------------------------------------------------

export interface UsageSlice {
  group: string;
  value: number;
  color: string;
  tone: SeriesTone;
}

export interface UsageBucketRow {
  /** Start of the bucket; also the map key coming from the backend. */
  bucket: number;
  label: string;
  total: number;
  /** Bucket-level session count, which is de-duplicated across models. */
  sessions: number;
  costUsd: number;
  slices: UsageSlice[];
  /** False for buckets filled in to keep the axis continuous. */
  present: boolean;
}

export interface UsageModel {
  days: UsageBucketRow[];
  /** Groups in descending order of their period total, after folding. */
  legend: UsageSlice[];
  max: number;
  periodTotal: number;
  /** Groups folded into the "下位まとめ" band, if any. */
  foldedCount: number;
  /**
   * Names of those groups, ranked highest first, so the band can say what is
   * inside it. A tier such as gpt-5.6-luna falls out of the top N over a long
   * range, and an anonymous folded band hides that it was ever measured.
   */
  foldedGroups: string[];
}

export const OTHER_GROUP = "(folded)";
export const UNKNOWN_GROUP = "(unknown)";
export const UNKNOWN_LABEL = "モデル不明";

/** `(unknown)` comes from turns whose transcript recorded no model name. */
export function groupLabel(group: string, groupBy?: SeriesGroupBy): string {
  if (group === OTHER_GROUP) return "下位まとめ";
  if (group === UNKNOWN_GROUP) return UNKNOWN_LABEL;
  if (groupBy === "provider") {
    const providerLabels: Record<string, string> = {
      anthropic: "Anthropic",
      openai: "OpenAI",
      xai: "xAI",
      google: "Google",
      local: "ローカル",
      other: "その他の会社",
    };
    return providerLabels[group] ?? group;
  }
  if (groupBy === "kind") return kindLabel(group);
  if (groupBy === "effort") return group === "(none)" ? "未指定" : group;
  return group;
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
  topN = SERIES_TOP_N,
  bucketKind: UsageBucket = "day",
  groupBy: SeriesGroupBy = "model_raw",
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
  const paints = new Map<string, { color: string; tone: SeriesTone }>();
  kept.forEach((group) => paints.set(group, seriesPaint(group, groupBy)));

  const byBucket = new Map<number, SeriesBucket>();
  for (const bucket of buckets) byBucket.set(bucket.bucket, bucket);
  const present = [...byBucket.keys()].sort((a, b) => a - b);

  const days: UsageBucketRow[] = [];
  if (present.length > 0) {
    const last = present[present.length - 1];
    for (let start = present[0]; start <= last; ) {
      const bucket = byBucket.get(start);
      const slices: UsageSlice[] = [];
      let otherValue = 0;
      for (const group of bucket?.groups ?? []) {
        const value = metricValue(group, metric);
        if (value <= 0) continue;
        const paint = paints.get(group.group);
        if (paint) {
          slices.push({ group: group.group, value, ...paint });
        } else {
          otherValue += value;
        }
      }
      if (otherValue > 0) {
        slices.push({ group: OTHER_GROUP, value: otherValue, color: NEUTRAL_COLOR, tone: "neutral" });
      }
      slices.sort(
        (a, b) => kept.indexOf(a.group) - kept.indexOf(b.group) || a.group.localeCompare(b.group),
      );
      days.push({
        bucket: start,
        label: formatBucketLabel(start, bucketKind),
        total: slices.reduce((sum, slice) => sum + slice.value, 0),
        sessions: bucket?.sessions ?? 0,
        costUsd: bucket?.costUsd ?? 0,
        slices,
        present: bucket !== undefined,
      });
      const next = nextBucketStart(start, bucketKind);
      if (next <= start) break;
      start = next;
    }
  }

  const legend: UsageSlice[] = kept.map((group) => ({
    group,
    value: totals.get(group) ?? 0,
    ...(paints.get(group) as { color: string; tone: SeriesTone }),
  }));
  if (folded.length > 0) {
    legend.push({
      group: OTHER_GROUP,
      value: folded.reduce((sum, group) => sum + (totals.get(group) ?? 0), 0),
      color: NEUTRAL_COLOR,
      tone: "neutral",
    });
  }

  return {
    days,
    legend,
    max: days.reduce((max, day) => Math.max(max, day.total), 0),
    periodTotal: legend.reduce((sum, entry) => sum + entry.value, 0),
    foldedCount: folded.length,
    foldedGroups: folded,
  };
}

export interface StackRect {
  group: string;
  color: string;
  tone: SeriesTone;
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
export function layoutStack(day: UsageBucketRow, max: number, mode: "absolute" | "share"): StackRect[] {
  const denominator = mode === "share" ? day.total : max;
  if (denominator <= 0) return [];
  const rects: StackRect[] = [];
  let offset = 0;
  for (const slice of day.slices) {
    const height = slice.value / denominator;
    rects.push({ group: slice.group, color: slice.color, tone: slice.tone, value: slice.value, offset, height });
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
  metric: RhythmMetric,
  kind: "hour" | "weekday",
): SlotBar[] {
  const valueOf = (slot: RhythmSlot) => {
    switch (metric) {
      case "ioTokens":
        return slot.io;
      case "totalTokens":
        return slot.total;
      case "turns":
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
