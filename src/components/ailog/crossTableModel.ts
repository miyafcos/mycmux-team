/**
 * Pure helpers for the usage cross-table: axis pairing, folding into
 * a folded band, and which click can become a session-list filter.
 */

import type { PivotAxis, PivotReport, SeriesGroup } from "../../lib/ailog";
import type { AilogSelection } from "../../stores/ailogStore";
import { axisLabel, isStackable, metricValue, USAGE_AXES, type UsageMetric } from "./usageModel";

export const PIVOT_AXES = USAGE_AXES.map((axis) => ({ value: axis.value, label: axis.label, title: axis.hint }));

export const PIVOT_TOP_ROWS = 12;
export const PIVOT_TOP_COLS = 10;
export const OTHER_KEY = "(folded)";

export function pivotAxisLabel(axis: PivotAxis): string {
  return axisLabel(axis);
}

const AXIS_FALLBACK_ORDER: PivotAxis[] = ["project", "model_raw", "model", "provider", "kind", "effort", "origin"];
export function firstOtherAxis(axis: PivotAxis): PivotAxis {
  return AXIS_FALLBACK_ORDER.find((value) => value !== axis) ?? "model_raw";
}

export function nextPivotAxes(
  current: { rowBy: PivotAxis; colBy: PivotAxis },
  change: { rowBy?: PivotAxis; colBy?: PivotAxis },
): { rowBy: PivotAxis; colBy: PivotAxis } {
  let rowBy = change.rowBy ?? current.rowBy;
  let colBy = change.colBy ?? current.colBy;
  if (rowBy === colBy) {
    if (change.rowBy !== undefined) colBy = firstOtherAxis(rowBy);
    else rowBy = firstOtherAxis(colBy);
  }
  return { rowBy, colBy };
}

export function isFilterablePivotAxis(axis: PivotAxis): axis is "project" | "model" | "model_raw" {
  return axis === "project" || axis === "model" || axis === "model_raw";
}

export function selectionFromPivotCell(
  rowBy: PivotAxis,
  colBy: PivotAxis,
  rowKey: string,
  colKey: string,
): AilogSelection | null {
  if (rowKey === OTHER_KEY || colKey === OTHER_KEY) return null;
  const pick = (axis: PivotAxis, key: string): AilogSelection | null =>
    key === "(unknown)" || key === "unknown" ? null
    : axis === "project" ? { project: { key, label: key } }
    : (axis === "model" || axis === "model_raw") ? { model: { key, label: key } }
    : null;
  const rowSelection = pick(rowBy, rowKey);
  const colSelection = pick(colBy, colKey);
  if ((isFilterablePivotAxis(rowBy) && !rowSelection) || (isFilterablePivotAxis(colBy) && !colSelection)) {
    return null;
  }
  const merged = { ...rowSelection, ...colSelection };
  return Object.keys(merged).length > 0 ? merged : null;
}

export interface FoldedPivotRow {
  key: string;
  total: number;
  cells: number[];
}

export interface FoldedPivot {
  cols: string[];
  rows: FoldedPivotRow[];
  colTotals: number[];
  grandTotal: number;
  foldedRows: number;
  foldedCols: number;
  /**
   * The keys behind those counts, so the note can say what went into the band.
   * A tier such as gpt-5.6-luna drops out of the top N over a long range, and an
   * anonymous folded band hides that it was ever measured.
   */
  foldedRowKeys: string[];
  foldedColKeys: string[];
  stackable: boolean;
}

function rankKeys(entries: { key: string; score: number }[]): string[] {
  return [...entries]
    .sort((left, right) => right.score - left.score || left.key.localeCompare(right.key))
    .map((entry) => entry.key);
}

function cellValue(report: PivotReport, row: { cells: SeriesGroup[] }, colKey: string, metric: UsageMetric): number {
  const index = report.cols.indexOf(colKey);
  if (index < 0) return 0;
  return metricValue(row.cells[index], metric);
}

export function foldPivot(
  report: PivotReport,
  metric: UsageMetric,
  topRows = PIVOT_TOP_ROWS,
  topCols = PIVOT_TOP_COLS,
): FoldedPivot {
  const keptRowKeys = rankKeys(report.rows.map((row) => ({ key: row.key, score: metricValue(row.total, metric) }))).slice(
    0,
    Math.max(0, topRows),
  );
  const foldedRowKeys = report.rows.map((row) => row.key).filter((key) => !keptRowKeys.includes(key));
  const keptColKeys = rankKeys(report.cols.map((key, index) => ({
    key,
    score: metricValue(report.colTotals[index], metric),
  }))).slice(0, Math.max(0, topCols));
  const foldedColKeys = report.cols.filter((key) => !keptColKeys.includes(key));
  const rowByKey = new Map(report.rows.map((row) => [row.key, row]));

  const sumCells = (sourceKeys: string[], colKey: string): number =>
    sourceKeys.reduce((sum, key) => {
      const row = rowByKey.get(key);
      return row ? sum + cellValue(report, row, colKey, metric) : sum;
    }, 0);

  const makeRow = (key: string, sourceKeys: string[]): FoldedPivotRow => {
    const cells = keptColKeys.map((colKey) => sumCells(sourceKeys, colKey));
    if (foldedColKeys.length > 0) {
      cells.push(foldedColKeys.reduce((sum, colKey) => sum + sumCells(sourceKeys, colKey), 0));
    }
    return { key, total: cells.reduce((sum, value) => sum + value, 0), cells };
  };

  const rows = keptRowKeys.map((key) => makeRow(key, [key]));
  if (foldedRowKeys.length > 0) rows.push(makeRow(OTHER_KEY, foldedRowKeys));
  const cols = foldedColKeys.length > 0 ? [...keptColKeys, OTHER_KEY] : keptColKeys;
  const colTotals = cols.map((_, index) => rows.reduce((sum, row) => sum + row.cells[index], 0));
  return {
    cols,
    rows,
    colTotals,
    grandTotal: rows.reduce((sum, row) => sum + row.total, 0),
    foldedRows: foldedRowKeys.length,
    foldedCols: foldedColKeys.length,
    foldedRowKeys,
    foldedColKeys,
    stackable: isStackable(metric),
  };
}

/** Past this many the note is longer than the table it annotates. */
const MAX_NAMED_FOLDED = 4;

function namedList(keys: string[]): string {
  if (keys.length <= MAX_NAMED_FOLDED) return keys.join(" / ");
  return `${keys.slice(0, MAX_NAMED_FOLDED).join(" / ")} ほか ${keys.length - MAX_NAMED_FOLDED} 件`;
}

export function foldNote(folded: FoldedPivot): string | null {
  if (folded.foldedRows === 0 && folded.foldedCols === 0) return null;
  const parts: string[] = [];
  if (folded.foldedRows > 0) {
    parts.push(`行 ${folded.foldedRows} 件 (${namedList(folded.foldedRowKeys)})`);
  }
  if (folded.foldedCols > 0) {
    parts.push(`列 ${folded.foldedCols} 件 (${namedList(folded.foldedColKeys)})`);
  }
  return `${parts.join("・")}を「下位まとめ」にまとめました`;
}

export function heatMixPercent(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.round(Math.min(1, value / max) * 40);
}
