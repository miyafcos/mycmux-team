/**
 * Pure helpers for the usage cross-table: axis pairing, folding into
 * "その他", and which click can become a session-list filter.
 */

import type { PivotAxis, PivotReport, SeriesGroup } from "../../lib/ailog";
import { isStackable, metricValue, type UsageMetric } from "./usageModel";

export const PIVOT_AXES: { value: PivotAxis; label: string }[] = [
  { value: "project", label: "案件" },
  { value: "model", label: "系統" },
  { value: "model_raw", label: "モデル" },
  { value: "provider", label: "会社" },
  { value: "origin", label: "起動元" },
  { value: "effort", label: "effort" },
  { value: "kind", label: "CLI" },
];

export const PIVOT_TOP_ROWS = 12;
export const PIVOT_TOP_COLS = 8;
export const OTHER_KEY = "その他";

export function pivotAxisLabel(axis: PivotAxis): string {
  return PIVOT_AXES.find((entry) => entry.value === axis)?.label ?? axis;
}

export function firstOtherAxis(axis: PivotAxis): PivotAxis {
  return PIVOT_AXES.find((entry) => entry.value !== axis)?.value ?? "model";
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
): { type: "project" | "model"; key: string; label: string } | null {
  if (rowKey === OTHER_KEY || colKey === OTHER_KEY) return null;
  if (rowBy === "project") return { type: "project", key: rowKey, label: rowKey };
  if (colBy === "project") return { type: "project", key: colKey, label: colKey };
  if (rowBy === "model" || rowBy === "model_raw") return { type: "model", key: rowKey, label: rowKey };
  if (colBy === "model" || colBy === "model_raw") return { type: "model", key: colKey, label: colKey };
  return null;
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
    stackable: isStackable(metric),
  };
}

export function foldNote(folded: FoldedPivot): string | null {
  if (folded.foldedRows === 0 && folded.foldedCols === 0) return null;
  const parts: string[] = [];
  if (folded.foldedRows > 0) parts.push(`行 ${folded.foldedRows} 件`);
  if (folded.foldedCols > 0) parts.push(`列 ${folded.foldedCols} 件`);
  return `${parts.join("・")}を「その他」にまとめました`;
}

export function heatMixPercent(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.round(Math.min(1, value / max) * 40);
}
