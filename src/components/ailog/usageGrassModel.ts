import { DAY_OFFSET_MIN, formatBucketLabel, type SeriesGroupBy, type SeriesReport } from "../../lib/ailog";
import { NEUTRAL_COLOR, seriesPaint, type SeriesPaint } from "./modelColors";
import { DAY_MS, OTHER_GROUP, WEEKDAY_LABELS, formatMetric, formatMetricFull, groupLabel, metricValue, usageMetricInfo, type UsageMetric } from "./usageModel";
import type { GrassLevel } from "./grassScale";

const OFFSET = DAY_OFFSET_MIN * 60_000;
const DATE_LIMIT = 8_640_000_000_000_000;
export const grassDayStart = (ms: number): number => Math.floor((ms + OFFSET) / DAY_MS) * DAY_MS - OFFSET;
export const grassDateLabel = (day: number): string => `${formatBucketLabel(day, "day")}（${WEEKDAY_LABELS[new Date(day + OFFSET).getUTCDay()]}）`;

export interface GrassBreakdownRow {
  group: string; label: string; value: number; valueLabel: string; fullValueLabel: string;
  share: number | null; shareLabel: string | null; ratio: number; paint: SeriesPaint; members: string[];
}
export interface GrassBreakdown {
  rows: GrassBreakdownRow[]; total: number; totalLabel: string; fullTotalLabel: string; foldedCount: number; recorded: boolean;
}
export interface GrassDay {
  day: number; label: string; shortLabel: string; value: number; valueLabel: string; fullValueLabel: string;
  recorded: boolean; level: GrassLevel; column: number; row: number; tooltip: string; tooltipValueLabel: string; topLabel: string;
}
export interface GrassLegend {
  level: GrassLevel; min: number | null; max: number | null; label: string;
}
export interface UsageGrassModel {
  days: GrassDay[]; weeks: (GrassDay | null)[][]; months: { column: number; label: string }[];
  legend: GrassLegend[]; activeDays: number; current: { count: number; end: number | null };
  longest: { count: number; end: number | null }; peak: GrassDay | null; summary: string;
  summaryItems: { label: string; value: string }[];
  periodState: "empty" | "zero" | "positive"; periodMessage: string | null;
  recordedDays: GrassDay[]; breakdown: (scope: "all" | number) => GrassBreakdown;
}

/** Nearest-rank quartiles. Equality stays in the lower band. */
export function grassLevels(values: readonly number[]): GrassLevel[] {
  const positive = values.filter(value => value > 0).sort((a, b) => a - b);
  if (!positive.length) return values.map(() => 0);
  if (positive[0] === positive[positive.length - 1]) return values.map(value => value > 0 ? 4 : 0);
  const thresholds = [0.25, 0.5, 0.75].map(p => positive[Math.ceil(p * positive.length) - 1]);
  return values.map(value => value <= 0 ? 0 : (1 + thresholds.filter(q => value > q).length) as GrassLevel);
}

/** Geometry stays pure too; the renderer only measures its available width. */
export function grassLayout(width: number, columns: number) {
  const available = Math.max(0, width - 28);
  let cell = 16;
  while (cell > 10 && columns * cell + Math.max(0, columns - 1) * (cell <= 11 ? 2 : 3) > available) cell--;
  const gap = cell <= 11 ? 2 : 3;
  return { cell, gap, width: columns * cell + Math.max(0, columns - 1) * gap + 28 };
}

export function buildUsageGrass(report: SeriesReport, metric: UsageMetric, groupBy: SeriesGroupBy): UsageGrassModel {
  const end = grassDayStart(report.range.to);
  const allTime = report.range.from < -DATE_LIMIT;
  const firstRecord = report.buckets.filter(bucket => bucket.turns > 0 && bucket.bucket <= end)
    .reduce<number | null>((first, bucket) => first === null ? grassDayStart(bucket.bucket) : Math.min(first, grassDayStart(bucket.bucket)), null);
  const start = allTime ? firstRecord : grassDayStart(report.range.from);
  const buckets = new Map(report.buckets.map(bucket => [grassDayStart(bucket.bucket), bucket]));
  const firstRow = start === null ? 0 : (new Date(start + OFFSET).getUTCDay() + 6) % 7;
  const amounts = new Map<string, number>();
  const daily = new Map<number, GrassBreakdown>();
  const days: GrassDay[] = [];
  const metricInfo = usageMetricInfo(metric);

  const makeBreakdown = (values: Map<string, number>, total: number, recorded: boolean, extended = false): GrassBreakdown => {
    const sorted = [...values].filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"));
    const folded = sorted.slice(8);
    const visible = sorted.slice(0, 8).map(([group, value]) => ({ group, value, members: [] as string[] }));
    if (folded.length) visible.push({ group: OTHER_GROUP, value: folded.reduce((sum, [, value]) => sum + value, 0), members: folded.map(([name]) => groupLabel(name, groupBy)) });
    const max = Math.max(0, ...visible.map(row => row.value));
    return {
      total, totalLabel: `${extended ? "延べ " : ""}${formatMetric(total, metric)}`, fullTotalLabel: formatMetricFull(total, metric), recorded, foldedCount: folded.length,
      rows: visible.map(row => {
        const share = metric === "sessions" ? null : total > 0 ? row.value / total * 100 : 0;
        return { ...row, label: groupLabel(row.group, groupBy), valueLabel: formatMetric(row.value, metric), fullValueLabel: formatMetricFull(row.value, metric),
          share, shareLabel: share === null ? null : `${share.toFixed(1)}%`, ratio: max > 0 ? row.value / max : 0,
          paint: row.group === OTHER_GROUP ? { color: NEUTRAL_COLOR, tone: "neutral" } : seriesPaint(row.group, groupBy) };
      }),
    };
  };

  if (start !== null && Number.isFinite(start) && Number.isFinite(end)) {
    for (let day = start; day <= end; day += DAY_MS) {
      const bucket = buckets.get(day);
      const values = new Map<string, number>();
      for (const group of bucket?.groups ?? []) {
        const value = metricValue(group, metric);
        values.set(group.group, (values.get(group.group) ?? 0) + value);
        amounts.set(group.group, (amounts.get(group.group) ?? 0) + value);
      }
      const value = metric === "sessions" ? bucket?.sessions ?? 0 : [...values.values()].reduce((sum, n) => sum + n, 0);
      const recorded = (bucket?.turns ?? 0) > 0;
      const breakdown = makeBreakdown(values, value, recorded);
      daily.set(day, breakdown);
      const top = breakdown.rows[0];
      const label = grassDateLabel(day);
      const topLabel = !recorded ? "記録なし" : value > 0 && top ? `${top.label}${top.shareLabel === null ? "" : ` ${top.shareLabel}`}` : "—";
      const tooltipValueLabel = `${metricInfo.unit === "count" ? `${metricInfo.label} ` : ""}${formatMetric(value, metric)}`;
      const seat = days.length + firstRow;
      days.push({ day, label, shortLabel: formatBucketLabel(day, "day"), value, valueLabel: formatMetric(value, metric), fullValueLabel: formatMetricFull(value, metric),
        recorded, level: 0, column: Math.floor(seat / 7), row: seat % 7, tooltip: `${label} · ${tooltipValueLabel}${topLabel === "—" ? "" : ` · ${topLabel}`}`, tooltipValueLabel, topLabel });
    }
  }
  const levels = grassLevels(days.map(day => day.value));
  days.forEach((day, i) => { day.level = levels[i]; });
  const weeks: (GrassDay | null)[][] = Array.from({ length: days.length ? days[days.length - 1].column + 1 : 0 }, () => Array<GrassDay | null>(7).fill(null));
  for (const day of days) weeks[day.column][day.row] = day;
  const candidates: { column: number; label: string }[] = [];
  for (const day of days) {
    const date = new Date(day.day + OFFSET);
    if (day === days[0] || date.getUTCDate() === 1) {
      candidates.push({ column: day.column, label: `${date.getUTCMonth() + 1}月` });
    }
  }
  if (candidates.length > 1 && candidates[1].column - candidates[0].column < 3) candidates.shift();
  const months = candidates.reduce<typeof candidates>((kept, candidate) => {
    if (!kept.length || candidate.column - kept[kept.length - 1].column >= 3) kept.push(candidate);
    return kept;
  }, []);
  const legend: GrassLegend[] = ([0, 1, 2, 3, 4] as GrassLevel[]).map(level => {
    const values = days.filter(day => day.level === level).map(day => day.value);
    const min = values.length ? Math.min(...values) : null;
    const max = values.length ? Math.max(...values) : null;
    return { level, min, max, label: level === 0 ? days.some(day => day.recorded && day.value === 0) ? "0 または記録なし" : "記録なし" : min === null || max === null ? "—" : min === max ? formatMetric(min, metric) : `${formatMetric(min, metric)}〜${formatMetric(max, metric)}` };
  });
  let run = 0;
  let current = { count: 0, end: null as number | null };
  let longest = { count: 0, end: null as number | null };
  let peak: GrassDay | null = null;
  for (const day of days) {
    run = day.recorded ? run + 1 : 0;
    if (day.recorded) current = { count: run, end: day.day };
    if (run > 0 && run >= longest.count) longest = { count: run, end: day.day };
    if (day.value > 0 && (!peak || day.value >= peak.value)) peak = day;
  }
  const activeDays = days.filter(day => day.recorded).length;
  const summaryItems = [
    { label: "記録のある日", value: `${activeDays} / ${days.length} 日` },
    { label: "連続", value: `${current.count} 日${current.end === null ? "" : `（${formatBucketLabel(current.end, "day")} まで）`}` },
    { label: "最長", value: `${longest.count} 日` },
    ...(peak ? [{ label: "最多", value: `${peak.label} ${peak.valueLabel}` }] : []),
  ];
  const summary = summaryItems.map(item => `${item.label} ${item.value}`).join(" · ");
  const periodState = activeDays === 0 ? "empty" : peak === null ? "zero" : "positive";
  const periodMessage = periodState === "empty" ? "この期間の記録はありません。" : periodState === "zero" ? `この期間の${metricInfo.label}は0です。` : null;
  const overall = makeBreakdown(amounts, days.reduce((sum, day) => sum + day.value, 0), activeDays > 0, metric === "sessions");
  const empty = makeBreakdown(new Map(), 0, false);
  return { days, weeks, months, legend, activeDays, current, longest, peak, summary, summaryItems, periodState, periodMessage, recordedDays: days.filter(day => day.recorded).reverse(),
    breakdown: scope => scope === "all" ? overall : daily.get(scope) ?? empty };
}
