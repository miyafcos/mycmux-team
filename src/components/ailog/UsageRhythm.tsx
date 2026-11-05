/** Hour-of-day and weekday distributions from the existing rhythm report. */

import { useId } from "react";
import type { UsageRhythmReport } from "../../lib/ailog";
import {
  formatMetricFull,
  offsetLabel,
  peakSlot,
  slotBars,
  type RhythmMetric,
} from "./usageModel";
import { noteStyle } from "./ui";

function Bars({
  title,
  bars,
  peakLabel,
  metric,
}: {
  title: string;
  bars: { slot: number; label: string; value: number; ratio: number }[];
  peakLabel: string;
  metric: RhythmMetric;
}) {
  const titleId = useId();
  const max = bars.reduce((peak, bar) => Math.max(peak, bar.value), 0);
  return <div role="group" aria-labelledby={titleId} style={{ minWidth: 0 }}>
    <h3 id={titleId} style={{ margin: "0 0 8px", fontSize: "var(--cmux-font-size-sm)" }}>{title}</h3>
    <div style={{ ...noteStyle, marginBottom: 8 }}>{peakLabel}</div>
    {bars.map(bar => <div key={bar.slot} data-rhythm-slot={bar.slot} title={formatMetricFull(bar.value, metric)}
      style={{ display: "grid", gridTemplateColumns: "58px minmax(30px, 1fr) 96px", gap: 8, alignItems: "center", minHeight: 24, fontSize: "var(--cmux-font-size-xs)" }}>
      <span>{bar.label}{bars.length === 7 ? "曜日" : ""}</span>
      <div aria-hidden="true" style={{ height: 10, background: "var(--cmux-hover)", borderRadius: 2 }}><div style={{ width: (max > 0 ? bar.value / max * 100 : 0) + "%", height: "100%", background: "var(--cmux-accent)", borderRadius: 2 }} /></div>
      <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{bar.value.toLocaleString("ja-JP")}</span>
    </div>)}
  </div>;
}

export function UsageRhythm({
  report,
  metric,
}: {
  report: UsageRhythmReport;
  metric: RhythmMetric;
}) {
  const hours = slotBars(report.byHour, metric, "hour");
  const weekdays = slotBars(report.byWeekday, metric, "weekday");
  const peakHour = peakSlot(hours);
  const peakWeekday = peakSlot(weekdays);
  const offset = offsetLabel(report.dayOffsetMinutes);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))" }}>
        <Bars
          title={`時間帯（${offset}）`}
          bars={hours}
          peakLabel={peakHour ? `最多 ${peakHour.label}` : "記録なし"}
          metric={metric}
        />
        <Bars
          title="曜日"
          bars={weekdays}
          peakLabel={peakWeekday ? `最多 ${peakWeekday.label}曜` : "記録なし"}
          metric={metric}
        />
      </div>
    </div>
  );
}
