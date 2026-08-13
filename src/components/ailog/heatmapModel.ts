/**
 * Calendar grid for the daily cost heatmap. Pure, so the week alignment and the
 * colour thresholds can be pinned by tests.
 *
 * Day buckets arrive from `ailog_series` already snapped to the start of a
 * local day (`DAY_BOUNDARY_OFFSET_MIN`). They are used as grid keys verbatim:
 * re-rounding them here would move each day onto the preceding one.
 */

import { dayBucketWeekday, type SeriesBucket } from "../../lib/ailog";

export const DAY_MS = 86_400_000;

export interface HeatmapCell {
  ts: number;
  costUsd: number;
  sessions: number;
  turns: number;
  /** False for the padding days that only exist to square off the grid. */
  present: boolean;
}

export interface HeatmapGrid {
  /** Columns of 7 cells, Sunday first. */
  weeks: HeatmapCell[][];
  firstTs: number;
  lastTs: number;
  maxCost: number;
  /** Upper bounds of levels 1..3; level 4 is everything above the last one. */
  thresholds: number[];
  totalCost: number;
  dayCount: number;
}

/** Quartiles of the non-zero days, so a few huge days cannot flatten the rest. */
export function costThresholds(values: number[]): number[] {
  const positive = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (positive.length === 0) return [0, 0, 0];
  const at = (fraction: number) =>
    positive[Math.min(positive.length - 1, Math.floor(fraction * positive.length))];
  const raw = [at(0.25), at(0.5), at(0.75)];
  // Keep the ladder strictly increasing so two levels never claim one amount.
  const out: number[] = [];
  for (const value of raw) {
    const previous = out.length > 0 ? out[out.length - 1] : 0;
    out.push(value > previous ? value : previous);
  }
  return out;
}

export function levelOf(cost: number, thresholds: number[]): 0 | 1 | 2 | 3 | 4 {
  if (cost <= 0) return 0;
  if (cost <= thresholds[0]) return 1;
  if (cost <= thresholds[1]) return 2;
  if (cost <= thresholds[2]) return 3;
  return 4;
}

export function buildHeatmapGrid(buckets: SeriesBucket[]): HeatmapGrid {
  const byDay = new Map<number, SeriesBucket>();
  for (const bucket of buckets) {
    byDay.set(bucket.bucket, bucket);
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  if (days.length === 0) {
    return {
      weeks: [],
      firstTs: 0,
      lastTs: 0,
      maxCost: 0,
      thresholds: [0, 0, 0],
      totalCost: 0,
      dayCount: 0,
    };
  }

  const firstTs = days[0];
  const lastTs = days[days.length - 1];
  const startWeekday = dayBucketWeekday(firstTs);
  const gridStart = firstTs - startWeekday * DAY_MS;
  const endWeekday = dayBucketWeekday(lastTs);
  const gridEnd = lastTs + (6 - endWeekday) * DAY_MS;

  const weeks: HeatmapCell[][] = [];
  let column: HeatmapCell[] = [];
  for (let ts = gridStart; ts <= gridEnd; ts += DAY_MS) {
    const bucket = byDay.get(ts);
    column.push({
      ts,
      costUsd: bucket?.costUsd ?? 0,
      sessions: bucket?.sessions ?? 0,
      turns: bucket?.turns ?? 0,
      present: ts >= firstTs && ts <= lastTs,
    });
    if (column.length === 7) {
      weeks.push(column);
      column = [];
    }
  }
  if (column.length > 0) {
    while (column.length < 7) {
      const ts = column[column.length - 1].ts + DAY_MS;
      column.push({ ts, costUsd: 0, sessions: 0, turns: 0, present: false });
    }
    weeks.push(column);
  }

  const costs = [...byDay.values()].map((bucket) => bucket.costUsd);
  return {
    weeks,
    firstTs,
    lastTs,
    maxCost: costs.reduce((max, value) => Math.max(max, value), 0),
    thresholds: costThresholds(costs),
    totalCost: costs.reduce((sum, value) => sum + value, 0),
    dayCount: days.length,
  };
}

/** Inclusive day span between two clicked cells, in either drag direction. */
export function dragSpan(anchorTs: number, currentTs: number): { from: number; to: number } {
  return {
    from: Math.min(anchorTs, currentTs),
    to: Math.max(anchorTs, currentTs),
  };
}
