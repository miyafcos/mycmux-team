/**
 * Volume stacked by group, one bar per day / week / month bucket.
 *
 * Plain SVG rectangles driven by `usageModel.layoutStack`, so the geometry is
 * testable without a renderer. Buckets with no activity are drawn as empty slots
 * rather than skipped: a quiet week has to look like a quiet week.
 */

import { useState } from "react";

import { useElementWidth } from "../../hooks/useElementWidth";
import { formatUsd, type PriceCoverage, type SeriesGroupBy, type UsageBucket } from "../../lib/ailog";
import {
  OTHER_GROUP,
  USAGE_METRICS,
  bucketNoun,
  costCoverageLabel,
  formatMetricFull,
  groupByLabel,
  groupLabel,
  layoutStack,
  metricUnit,
  formatMetric,
  type UsageMetric,
  type UsageModel,
  valueAxisTicks,
} from "./usageModel";
import { ChartHatchDefs, Num, noteStyle, paintFill, paintSwatchBackground } from "./ui";

const HEIGHT = 168;
const GAP = 2;
const AXIS_WIDTH = 52;

export function UsageBucketChart({
  model,
  metric,
  mode,
  highlight,
  onHighlight,
  onPickDay,
  onOpenDigest,
  digestLinkLabel = "日別まとめへ",
  groupBy,
  bucket,
  priceCoverage,
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
  bucket: UsageBucket;
  priceCoverage?: PriceCoverage;
}) {
  const { ref: widthRef, width: measured } = useElementWidth();
  const [selectedBucket, setSelectedBucket] = useState<number | null>(null);
  if (model.days.length === 0) {
    return <div style={noteStyle}>この期間に記録がありません。期間を広げるか、再インデックスしてください。</div>;
  }

  const width = measured > 0 ? measured : 760;
  const plotWidth = Math.max(1, width - AXIS_WIDTH);
  const slot = plotWidth / model.days.length;
  const barWidth = Math.max(1, Math.min(28, slot - GAP));
  const unit = bucketNoun(bucket);
  const presentCount = model.days.filter((row) => row.present).length;
  const costNote = metric === "costUsd" && priceCoverage ? costCoverageLabel(priceCoverage) : null;
  const ticks = mode === "share" ? [0, 0.5, 1] : valueAxisTicks(model.max);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <div ref={widthRef} style={{ minWidth: 0 }}>
        <svg
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="img"
          aria-label={`${unit}別の${USAGE_METRICS.find((entry) => entry.id === metric)?.label ?? "集計"}`}
          style={{ display: "block", width: "100%", height: HEIGHT }}
        >
          <ChartHatchDefs paints={[...model.legend, ...model.days.flatMap((row) => row.slices)]} />
          {ticks.map((tick) => {
            const y = mode === "share" ? HEIGHT - tick * HEIGHT : (model.max > 0 ? HEIGHT - (tick / model.max) * HEIGHT : HEIGHT);
            const label = mode === "share" ? `${Math.round(tick * 100)}%` : formatMetric(tick, metric);
            return <g key={tick} pointerEvents="none"><line x1={AXIS_WIDTH} x2={width} y1={y} y2={y} stroke="var(--cmux-border-hairline)" /><text x={AXIS_WIDTH - 4} y={y} textAnchor="end" dominantBaseline="middle" fill="var(--cmux-text-tertiary)" fontSize="var(--cmux-font-size-xs)">{label}</text></g>;
          })}
          {model.days.map((row, index) => {
            const x = AXIS_WIDTH + index * slot;
            const rects = layoutStack(row, model.max, mode);
            const tooltip = [
              row.label,
              `合計 ${formatMetricFull(row.total, metric)}`,
              ...rects.map((rect) => `${groupLabel(rect.group, groupBy)} ${formatMetricFull(rect.value, metric)}`),
              `セッション ${row.sessions}`,
              `コスト相当 ${formatUsd(row.costUsd)}`,
            ].join("\n");
            return (
              <g key={row.bucket}>
                <rect
                  x={x}
                  y={0}
                  width={barWidth}
                  height={HEIGHT}
                  fill="transparent"
                  style={{ cursor: onPickDay ? "pointer" : "default" }}
                  onClick={() => { setSelectedBucket(row.bucket); onPickDay?.(row.bucket); }}
                >
                  <title>{tooltip}</title>
                </rect>
                {rects.map((rect) => {
                  const height = rect.height * HEIGHT;
                  const y = HEIGHT - (rect.offset + rect.height) * HEIGHT;
                  const dimmed = highlight !== null && highlight !== rect.group;
                  return (
                    <rect
                      key={`${row.bucket}:${rect.group}`}
                      x={x}
                      y={y}
                      width={barWidth}
                      height={Math.max(height, height > 0 ? 1 : 0)}
                      fill={paintFill(rect)}
                      opacity={dimmed ? 0.22 : 1}
                      pointerEvents="none"
                    />
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>

      {selectedBucket !== null && onOpenDigest ? <button type="button" onClick={() => onOpenDigest(selectedBucket)} style={{ alignSelf: "flex-start", border: "1px solid var(--cmux-border)", borderRadius: 5, background: "var(--cmux-hover)", color: "var(--cmux-text)", padding: "3px 9px", fontSize: "var(--cmux-font-size-xs)", cursor: "pointer" }}>{digestLinkLabel}</button> : null}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {model.legend.map((entry) => {
          const active = highlight === entry.group;
          return (
            <button
              key={entry.group}
              type="button"
              onClick={() => onHighlight(active ? null : entry.group)}
              aria-pressed={active}
              title={entry.group === OTHER_GROUP && model.foldedGroups.length > 0 ? model.foldedGroups.join(" / ") : undefined}
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
                style={{ width: 9, height: 9, borderRadius: 2, background: paintSwatchBackground(entry), display: "inline-block" }}
              />
              {groupLabel(entry.group, groupBy)}
              <span style={{ color: "var(--cmux-text-tertiary)" }}><Num value={entry.value} kind={metricUnit(metric)} /></span>
            </button>
          );
        })}
      </div>

      <div style={noteStyle}>
        {`${model.days[0].label} 〜 ${model.days[model.days.length - 1].label}・記録のある${unit} ${presentCount} / ${model.days.length} ${unit}`}
        {model.foldedCount > 0 ? `・下位 ${model.foldedCount} ${groupByLabel(groupBy)}は「下位まとめ」にまとめています` : ""}
        {costNote ? `・${costNote}` : ""}
        {slot < 3 ? "・1日1本では細すぎます。単位を「週」にすると読めます。" : ""}
      </div>
    </div>
  );
}
