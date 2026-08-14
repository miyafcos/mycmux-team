/**
 * Daily cost calendar. Drag across cells to set a custom range; the whole
 * dashboard follows.
 *
 * The legend prints the real amounts behind each shade — "薄い / 濃い" alone
 * would make the reader guess at the money.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { dayBucketMonth, formatCount, formatDayBucket, formatUsd, toDayInput } from "../../lib/ailog";
import type { SeriesReport } from "../../lib/ailog";
import { buildHeatmapGrid, dragSpan, levelOf, type HeatmapCell } from "./heatmapModel";
import { noteStyle } from "./ui";

const CELL = "var(--cmux-font-size-xs)";
const CELL_GAP = 2;
const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

const LEVEL_ALPHA = [0, 0.22, 0.42, 0.68, 1];

function cellBackground(level: number, selected: boolean): string {
  if (level === 0) {
    return selected ? "color-mix(in srgb, var(--cmux-accent) 18%, var(--cmux-hover))" : "var(--cmux-hover)";
  }
  const alpha = Math.round(LEVEL_ALPHA[level] * 100);
  return `color-mix(in srgb, var(--cmux-accent) ${alpha}%, var(--cmux-surface))`;
}

export function CostHeatmap({
  series,
  onSelectRange,
}: {
  series: SeriesReport;
  onSelectRange: (from: string, to: string) => void;
}) {
  const grid = useMemo(() => buildHeatmapGrid(series.buckets), [series.buckets]);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [hoverTs, setHoverTs] = useState<number | null>(null);
  const draggingRef = useRef(false);

  const commit = useCallback(
    (from: number, to: number) => {
      onSelectRange(toDayInput(from), toDayInput(to));
    },
    [onSelectRange],
  );

  // A drag that ends outside the grid still counts: the pointer-up listener is
  // on the document, so releasing over the page does not strand the selection.
  useEffect(() => {
    if (anchor === null) return;
    const handleUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      const end = hoverTs ?? anchor;
      const span = dragSpan(anchor, end);
      setAnchor(null);
      commit(span.from, span.to);
    };
    document.addEventListener("pointerup", handleUp);
    return () => document.removeEventListener("pointerup", handleUp);
  }, [anchor, commit, hoverTs]);

  if (grid.weeks.length === 0) {
    return <div style={noteStyle}>この期間には日別の記録がありません。期間を広げると表示されます。</div>;
  }

  const selection = anchor !== null ? dragSpan(anchor, hoverTs ?? anchor) : null;
  const isSelected = (cell: HeatmapCell) =>
    selection !== null && cell.ts >= selection.from && cell.ts <= selection.to;

  const monthLabels: { index: number; label: string }[] = [];
  let lastMonth = -1;
  grid.weeks.forEach((week, index) => {
    const month = dayBucketMonth(week[0].ts);
    if (month !== lastMonth) {
      monthLabels.push({ index, label: `${month + 1}月` });
      lastMonth = month;
    }
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <div style={{ overflowX: "auto", paddingBottom: 4 }}>
        <div style={{ display: "flex", gap: 4, minWidth: "min-content" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: CELL_GAP, paddingTop: 14 }}>
            {WEEKDAY_LABELS.map((label, index) => (
              <div
                key={label}
                style={{
                  height: CELL,
                  fontSize: "var(--cmux-font-size-xs)",
                  lineHeight: CELL,
                  color: "var(--cmux-text-tertiary)",
                  visibility: index % 2 === 1 ? "visible" : "hidden",
                }}
              >
                {label}
              </div>
            ))}
          </div>
          <div style={{ minWidth: "min-content" }}>
            <div style={{ display: "flex", gap: CELL_GAP, height: CELL }}>
              {grid.weeks.map((_, index) => {
                const label = monthLabels.find((entry) => entry.index === index);
                return (
                  <div
                    key={index}
                    style={{ width: CELL, fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-tertiary)", whiteSpace: "nowrap" }}
                  >
                    {label?.label ?? ""}
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: CELL_GAP, marginTop: 2 }}>
              {grid.weeks.map((week, weekIndex) => (
                <div key={weekIndex} style={{ display: "flex", flexDirection: "column", gap: CELL_GAP }}>
                  {week.map((cell) => {
                    const level = cell.present ? levelOf(cell.costUsd, grid.thresholds) : 0;
                    const selected = isSelected(cell);
                    return (
                      <div
                        key={cell.ts}
                        role="button"
                        tabIndex={-1}
                        aria-label={`${formatDayBucket(cell.ts)} ${formatUsd(cell.costUsd)} ${formatCount(cell.sessions)}セッション`}
                        title={
                          cell.present
                            ? `${formatDayBucket(cell.ts)}\n${formatUsd(cell.costUsd)}\n${formatCount(cell.sessions)} セッション / ${formatCount(cell.turns)} ターン`
                            : formatDayBucket(cell.ts)
                        }
                        onPointerDown={(event) => {
                          event.preventDefault();
                          draggingRef.current = true;
                          setAnchor(cell.ts);
                          setHoverTs(cell.ts);
                        }}
                        onPointerEnter={() => {
                          if (draggingRef.current) setHoverTs(cell.ts);
                        }}
                        style={{
                          width: CELL,
                          height: CELL,
                          borderRadius: 2,
                          background: cellBackground(level, selected),
                          outline: selected ? "1px solid var(--cmux-accent)" : "none",
                          opacity: cell.present ? 1 : 0.25,
                          cursor: "pointer",
                        }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", ...noteStyle }}>
        <span>ドラッグで期間を選べます</span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span>$0</span>
          {[1, 2, 3, 4].map((level) => (
            <span
              key={level}
              style={{ width: CELL, height: CELL, borderRadius: 2, background: cellBackground(level, false) }}
            />
          ))}
          <span>
            {`≤${formatUsd(grid.thresholds[0])} / ≤${formatUsd(grid.thresholds[1])} / ≤${formatUsd(grid.thresholds[2])} / 最大 ${formatUsd(grid.maxCost)}`}
          </span>
        </span>
        <span>
          {`${formatDayBucket(grid.firstTs)} 〜 ${formatDayBucket(grid.lastTs)}・記録のある日 ${formatCount(grid.dayCount)} 日・合計 ${formatUsd(grid.totalCost)}`}
        </span>
        <span>日付は JST 基準です</span>
      </div>
    </div>
  );
}
