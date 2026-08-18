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
  type UsageMetric,
  type UsageModel,
} from "./usageModel";
import { Num, noteStyle } from "./ui";

const HEIGHT = 168;
const GAP = 2;

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
  const slot = width / model.days.length;
  const barWidth = Math.max(1, Math.min(28, slot - GAP));
  const unit = bucketNoun(bucket);
  const presentCount = model.days.filter((row) => row.present).length;
  const costNote = metric === "costUsd" && priceCoverage ? costCoverageLabel(priceCoverage) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <div ref={widthRef} style={{ minWidth: 0 }}>
        <svg
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="img"
          aria-label={`${unit}別の${USAGE_METRICS.find((entry) => entry.id === metric)?.label ?? "集計"}`}
          style={{ display: "block", width: "100%", height: HEIGHT }}
        >
          {model.days.map((row, index) => {
            const x = index * slot;
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
                style={{ width: 9, height: 9, borderRadius: 2, background: entry.color, display: "inline-block" }}
              />
              {groupLabel(entry.group, groupBy)}
              <span style={{ color: "var(--cmux-text-tertiary)" }}><Num value={entry.value} kind={metricUnit(metric)} /></span>
            </button>
          );
        })}
      </div>

      <div style={noteStyle}>
        {`${model.days[0].label} 〜 ${model.days[model.days.length - 1].label}・記録のある${unit} ${presentCount} ${unit}`}
        {model.foldedCount > 0 ? `・下位 ${model.foldedCount} ${groupByLabel(groupBy)}は「その他」にまとめています` : ""}
        {costNote ? `・${costNote}` : ""}
        {slot < 3 ? "・1日1本では細すぎます。単位を「週」にすると読めます。" : ""}
      </div>
    </div>
  );
}
