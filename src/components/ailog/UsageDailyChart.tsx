/**
 * Daily volume, stacked by model.
 *
 * Plain SVG rectangles driven by `usageModel.layoutStack`, so the geometry is
 * testable without a renderer. Days with no activity are drawn as empty slots
 * rather than skipped: a quiet week has to look like a quiet week.
 */

import { useState } from "react";

import { formatUsd, type SeriesGroupBy } from "../../lib/ailog";
import {
  USAGE_METRICS,
  formatMetric,
  groupLabel,
  layoutStack,
  type UsageMetric,
  type UsageModel,
} from "./usageModel";
import { noteStyle, ScrollBox } from "./ui";

const HEIGHT = 168;
const MIN_BAR = 6;
const GAP = 2;

export function UsageDailyChart({
  model,
  metric,
  mode,
  highlight,
  onHighlight,
  onPickDay,
  onOpenDigest,
  digestLinkLabel = "日別まとめへ",
  groupBy,
}: {
  model: UsageModel;
  metric: UsageMetric;
  mode: "absolute" | "share";
  highlight: string | null;
  onHighlight: (group: string | null) => void;
  onPickDay?: (day: number) => void;
  onOpenDigest?: (day: number) => void;
  digestLinkLabel?: string;
  groupBy: SeriesGroupBy;
}) {
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  if (model.days.length === 0) {
    return <div style={noteStyle}>この期間に記録がありません。期間を広げるか、再インデックスしてください。</div>;
  }

  const barWidth = Math.max(MIN_BAR, Math.min(28, Math.floor(760 / model.days.length)));
  const width = model.days.length * (barWidth + GAP);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <ScrollBox>
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="img"
          aria-label={`日別の${USAGE_METRICS.find((entry) => entry.id === metric)?.label ?? "集計"}`}
          style={{ display: "block" }}
        >
          {model.days.map((day, index) => {
            const x = index * (barWidth + GAP);
            const rects = layoutStack(day, model.max, mode);
            const tooltip = [
              day.label,
              `合計 ${formatMetric(day.total, metric)}`,
              ...rects.map((rect) => `${groupLabel(rect.group, groupBy)} ${formatMetric(rect.value, metric)}`),
              `セッション ${day.sessions}`,
              `コスト相当 ${formatUsd(day.costUsd)}`,
            ].join("\n");
            return (
              <g key={day.day}>
                <rect
                  x={x}
                  y={0}
                  width={barWidth}
                  height={HEIGHT}
                  fill="transparent"
                  style={{ cursor: onPickDay ? "pointer" : "default" }}
                  onClick={() => { setSelectedDay(day.day); onPickDay?.(day.day); }}
                >
                  <title>{tooltip}</title>
                </rect>
                {rects.map((rect) => {
                  const height = rect.height * HEIGHT;
                  const y = HEIGHT - (rect.offset + rect.height) * HEIGHT;
                  const dimmed = highlight !== null && highlight !== rect.group;
                  return (
                    <rect
                      key={`${day.day}:${rect.group}`}
                      x={x}
                      y={y}
                      width={barWidth}
                      height={Math.max(height, height > 0 ? 1 : 0)}
                      fill={rect.color}
                      opacity={dimmed ? 0.22 : 1}
                      pointerEvents="none"
                    />
                  );
                })}
              </g>
            );
          })}
        </svg>
      </ScrollBox>

      {selectedDay !== null && onOpenDigest ? <button type="button" onClick={() => onOpenDigest(selectedDay)} style={{ alignSelf: "flex-start", border: "1px solid var(--cmux-border)", borderRadius: 5, background: "var(--cmux-hover)", color: "var(--cmux-text)", padding: "3px 9px", fontSize: "var(--cmux-font-size-xs)", cursor: "pointer" }}>{digestLinkLabel}</button> : null}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {model.legend.map((entry) => {
          const active = highlight === entry.group;
          return (
            <button
              key={entry.group}
              type="button"
              onClick={() => onHighlight(active ? null : entry.group)}
              aria-pressed={active}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                border: "1px solid var(--cmux-border-hairline)",
                borderRadius: 999,
                background: active ? "var(--cmux-hover)" : "transparent",
                color: "var(--cmux-text-secondary)",
                padding: "2px 8px",
                fontSize: "var(--cmux-font-size-xs)",
                cursor: "pointer",
              }}
            >
              <span
                aria-hidden="true"
                style={{ width: 9, height: 9, borderRadius: 2, background: entry.color, display: "inline-block" }}
              />
              {groupLabel(entry.group, groupBy)}
              <span style={{ color: "var(--cmux-text-tertiary)" }}>{formatMetric(entry.value, metric)}</span>
            </button>
          );
        })}
      </div>

      <div style={noteStyle}>
        {`${model.days[0].label} 〜 ${model.days[model.days.length - 1].label}・記録のある日 ${model.days.filter((day) => day.present).length} 日`}
        {model.foldedCount > 0 ? `・下位 ${model.foldedCount} ${groupBy === "provider" ? "会社" : groupBy === "model" ? "系統" : "モデル"}は「その他」にまとめています` : ""}
      </div>
    </div>
  );
}
