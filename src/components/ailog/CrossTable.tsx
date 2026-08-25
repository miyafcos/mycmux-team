import { useMemo } from "react";

import type { PivotAxis, PivotReport } from "../../lib/ailog";
import type { AilogSelection } from "../../stores/ailogStore";
import {
  foldNote,
  foldPivot,
  heatMixPercent,
  isFilterablePivotAxis,
  OTHER_KEY,
  PIVOT_AXES,
  pivotAxisLabel,
  selectionFromPivotCell,
} from "./crossTableModel";
import { groupLabel, metricUnit, type UsageMetric } from "./usageModel";
import { ButtonGroup, EmptyState, Num, VScrollBox, noteStyle, tableActionButtonStyle, tableStyle, tdLeftStyle, tdStyle, thLeftStyle, thStyle } from "./ui";

function axisLabel(value: string, axis: PivotAxis): string {
  if (value === OTHER_KEY) return "下位まとめ";
  if (value === "(unknown)") {
    if (axis === "project") return "案件未指定";
    if (axis === "model" || axis === "model_raw") return "ログにモデル名なし";
    return "不明";
  }
  if (value === "(none)") return "未指定";
  if (axis === "origin") return value === "unknown" ? "不明" : value;
  return groupLabel(value, axis);
}

export function CrossTable({
  report,
  metric,
  rowBy,
  colBy,
  loading,
  error,
  selection,
  onRetry,
  onRowBy,
  onColBy,
  onSelect,
}: {
  report: PivotReport | null;
  metric: UsageMetric;
  rowBy: PivotAxis;
  colBy: PivotAxis;
  loading: boolean;
  error: string | null;
  selection: AilogSelection | null;
  onRetry: () => void;
  onRowBy: (value: PivotAxis) => void;
  onColBy: (value: PivotAxis) => void;
  onSelect: (selection: AilogSelection | null) => void;
}) {
  const folded = useMemo(() => (report ? foldPivot(report, metric) : null), [report, metric]);
  const note = folded ? foldNote(folded) : null;
  const max = folded ? Math.max(0, ...folded.rows.flatMap((row) => row.cells)) : 0;
  const stackable = folded?.stackable ?? true;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <ButtonGroup ariaLabel="行軸" roleLabel="行" value={rowBy} onChange={onRowBy} options={PIVOT_AXES} />
        <ButtonGroup ariaLabel="列軸" roleLabel="列" value={colBy} onChange={onColBy} options={PIVOT_AXES} />
      </div>
      {error ? (
        <EmptyState kind="error" message={error} onPrimary={onRetry} />
      ) : !report || !folded ? (
        loading ? null : <EmptyState kind="no-data" />
      ) : folded.rows.length === 0 ? (
        <EmptyState kind="no-data" />
      ) : (
        <>
          <VScrollBox maxHeight={360} label={`${pivotAxisLabel(rowBy)}と${pivotAxisLabel(colBy)}のクロス集計`}>
            <table style={{ ...tableStyle, minWidth: Math.max(640, 190 + folded.cols.length * 112) }}>
              <colgroup>
                <col style={{ width: "22%" }} />
                {folded.cols.map((col) => (
                  <col key={col} style={{ width: `${folded.cols.length > 0 ? 68 / folded.cols.length : 68}%` }} />
                ))}
                <col style={{ width: "10%" }} />
              </colgroup>
              <caption style={{ ...noteStyle, captionSide: "bottom", textAlign: "left", paddingTop: 8 }}>
                {`${pivotAxisLabel(rowBy)} × ${pivotAxisLabel(colBy)}`}
              </caption>
              <thead>
                <tr>
                  <th scope="col" style={thLeftStyle}>{pivotAxisLabel(rowBy)}</th>
                  {folded.cols.map((col) => (
                    <th scope="col" key={col} style={thStyle} title={axisLabel(col, colBy)}>
                      {axisLabel(col, colBy)}
                    </th>
                  ))}
                  <th scope="col" style={thStyle}>合計</th>
                </tr>
              </thead>
              <tbody>
                {folded.rows.map((row) => (
                  <tr key={row.key}>
                    <th scope="row" style={{ ...tdLeftStyle, fontWeight: 400 }} title={axisLabel(row.key, rowBy)}>
                      {axisLabel(row.key, rowBy)}
                    </th>
                    {row.cells.map((value, index) => {
                      const colKey = folded.cols[index];
                      const next = selectionFromPivotCell(rowBy, colBy, row.key, colKey);
                      const selected = Boolean(
                        next
                        && selection
                        && (!next.model || selection.model?.key === next.model.key)
                        && (!next.project || selection.project?.key === next.project.key),
                      );
                      const mix = heatMixPercent(value, max);
                      const clickable = next !== null;
                      return (
                        <td
                          key={colKey}
                          style={{
                            ...tdStyle,
                            cursor: clickable ? "pointer" : undefined,
                            background: selected
                              ? "var(--cmux-selected)"
                              : mix > 0
                                ? `color-mix(in srgb, var(--cmux-accent) ${mix}%, transparent)`
                                : undefined,
                          }}
                        >
                          {next ? <button
                            type="button"
                            aria-pressed={selected}
                            aria-label={`${axisLabel(row.key, rowBy)}、${axisLabel(colKey, colBy)}、${value}`}
                            onClick={() => {
                              if (!selected) {
                                onSelect(next);
                                return;
                              }
                              const remaining = { ...selection };
                              if (next.model) delete remaining.model;
                              if (next.project) delete remaining.project;
                              onSelect(remaining.model || remaining.project ? remaining : null);
                            }}
                            style={{ ...tableActionButtonStyle, color: "inherit", textAlign: "right", textDecoration: "none" }}
                          ><Num value={value} kind={metricUnit(metric)} bare /></button> : <Num value={value} kind={metricUnit(metric)} bare />}
                        </td>
                      );
                    })}
                    <td style={{ ...tdStyle, fontWeight: 600 }}>
                      {stackable ? <Num value={row.total} kind={metricUnit(metric)} bare /> : "—"}
                    </td>
                  </tr>
                ))}
                <tr>
                  <th scope="row" style={{ ...tdLeftStyle, fontWeight: 600 }}>合計</th>
                  {folded.colTotals.map((value, index) => (
                    <td key={folded.cols[index]} style={{ ...tdStyle, fontWeight: 600 }}>
                      {stackable ? <Num value={value} kind={metricUnit(metric)} bare /> : "—"}
                    </td>
                  ))}
                  <td style={{ ...tdStyle, fontWeight: 700 }}>
                    {stackable ? <Num value={folded.grandTotal} kind={metricUnit(metric)} bare /> : "—"}
                  </td>
                </tr>
              </tbody>
            </table>
          </VScrollBox>
          {note ? <div style={noteStyle}>{note}</div> : null}
          {!stackable ? (
            <div style={noteStyle}>1セッションが複数モデルに跨るため合計できません</div>
          ) : null}
          {isFilterablePivotAxis(rowBy) || isFilterablePivotAxis(colBy) ? (
            <div style={noteStyle}>セルの値を選ぶと下のセッション一覧が連動します。</div>
          ) : null}
        </>
      )}
    </div>
  );
}
