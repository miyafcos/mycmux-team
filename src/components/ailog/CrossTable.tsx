import { useAgentServiceVisibility } from "../../hooks/useAgentServiceVisibility";
import { useMemo, useState } from "react";

import type { PivotAxis, PivotReport } from "../../lib/ailog";
import type { AilogSelection } from "../../stores/ailogStore";
import {
  foldNote,
  foldPivot,
  heatMixPercent,
  isFilterablePivotAxis,
  OTHER_KEY,
  pivotAxisLabel,
  selectionFromPivotCell,
} from "./crossTableModel";
import { metricValue, groupLabel, metricUnit, usageAxisHint, USAGE_AXES, type UsageMetric } from "./usageModel";
import { ReportFailure, ReportNotLoaded, ReportPeriod } from "./ReportFeedback";
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
  const [expanded, setExpanded] = useState<string | null>(null);
  const visible = useAgentServiceVisibility();
  const visibleAxes = USAGE_AXES.map(axis => ({ value: axis.value, label: axis.label, title: usageAxisHint(axis, visible) }));
  const folded = useMemo(() => (report ? foldPivot(report, metric, 12, 3) : null), [report, metric]);
  const note = folded ? foldNote(folded) : null;
  const stackable = folded?.stackable ?? true;
  const max = folded ? Math.max(0, ...folded.rows.flatMap((row) => row.cells.filter((_, index) =>
    stackable || (row.key !== OTHER_KEY && folded.cols[index] !== OTHER_KEY)))) : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <ButtonGroup ariaLabel="行軸" roleLabel="行" value={rowBy} onChange={onRowBy} options={visibleAxes} />
        <ButtonGroup ariaLabel="列軸" roleLabel="列" value={colBy} onChange={onColBy} options={visibleAxes} />
      </div>
      {report ? <ReportPeriod range={report.range} /> : null}
      {error && report ? <ReportFailure label="クロス集計" error={error} range={report.range} onRetry={onRetry} /> : null}
      {error && !report ? (
        <EmptyState kind="error" message={error} onPrimary={onRetry} />
      ) : !report || !folded ? (
        loading ? null : <ReportNotLoaded label="クロス集計" onLoad={onRetry} />
      ) : folded.rows.length === 0 ? (
        <EmptyState kind="no-data" />
      ) : (
        <>
          <VScrollBox maxHeight={360} label={`${pivotAxisLabel(rowBy)}と${pivotAxisLabel(colBy)}のクロス集計`}>
            <table style={{ ...tableStyle, minWidth: 0 }}>
              <colgroup>
                <col style={{ width: "22%" }} />
                {folded.cols.map((col) => (
                  <col key={col} style={{ width: `${folded.cols.length > 0 ? 68 / folded.cols.length : 68}%` }} />
                ))}
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
                </tr>
              </thead>
              <tbody>
                {folded.rows.map((row) => (
                  <tr key={row.key}>
                    <th scope="row" style={{ ...tdLeftStyle, fontWeight: 400 }} title={axisLabel(row.key, rowBy)}>
                      {axisLabel(row.key, rowBy)}
                      <div style={noteStyle}>合計 {stackable ? <Num value={row.total} kind={metricUnit(metric)} bare /> : "—"}</div>
                      <button type="button" aria-expanded={expanded === row.key} onClick={() => setExpanded(expanded === row.key ? null : row.key)} style={tableActionButtonStyle}>詳細</button>
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
                      const additiveCell = stackable || (row.key !== OTHER_KEY && colKey !== OTHER_KEY);
                      const mix = additiveCell ? heatMixPercent(value, max) : 0;
                      const clickable = additiveCell && next !== null;
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
                          {!additiveCell ? "—" : next ? <button
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
                  </tr>
                ))}
                <tr>
                  <th scope="row" style={{ ...tdLeftStyle, fontWeight: 600 }}>合計</th>
                  {folded.colTotals.map((value, index) => (
                    <td key={folded.cols[index]} style={{ ...tdStyle, fontWeight: 600 }}>
                      {stackable ? <Num value={value} kind={metricUnit(metric)} bare /> : "—"}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </VScrollBox>
          <div style={noteStyle}>上位3項目とその他を表示。各行の合計と全項目は行の「詳細」で確認できます。</div>
          {expanded !== null ? <div role="region" aria-label="比較の行詳細" style={{ border: "1px solid var(--cmux-border)", padding: 12 }}>
            <strong>{axisLabel(expanded, rowBy)}の詳細</strong>
            <dl style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
              {report.cols.map((key, index) => {
                const source = report.rows.filter(row => row.key === expanded || (expanded === OTHER_KEY && folded.foldedRowKeys.includes(row.key)));
                const value = source.reduce((sum, row) => sum + metricValue(row.cells[index], metric), 0);
                return <div key={key}><dt style={noteStyle}>{axisLabel(key, colBy)}</dt><dd style={{ margin: 0 }}>{!stackable && (key === OTHER_KEY || expanded === OTHER_KEY) ? "—" : <Num value={value} kind={metricUnit(metric)} bare />}</dd></div>;
              })}
            </dl><button type="button" onClick={() => setExpanded(null)} style={tableActionButtonStyle}>詳細を閉じる</button>
          </div> : null}
          {note ? <div style={noteStyle}>{note}</div> : null}
          {!stackable ? (
            <div style={noteStyle}>1セッションが複数モデルに跨るため合計できません</div>
          ) : null}
          {isFilterablePivotAxis(rowBy) || isFilterablePivotAxis(colBy) ? (
            <div style={noteStyle}>セルの値を選ぶと期間全体を絞り込みます。セッションの見出しで一覧を確認できます。</div>
          ) : null}
        </>
      )}
    </div>
  );
}
