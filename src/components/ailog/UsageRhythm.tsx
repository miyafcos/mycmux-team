/**
 * Working rhythm: lifetime totals, how many days were active, streaks, and the
 * shape of a day and a week.
 *
 * Everything here comes from SQL aggregates over `turn`, so it renders with no
 * summariser, no subprocess and no network — this is the part of the panel that
 * is always answerable.
 */

import { useId } from "react";
import { formatCount, formatDayBucket, type UsageRhythmReport } from "../../lib/ailog";
import {
  activeDayRatio,
  formatMetric,
  formatMetricFull,
  offsetLabel,
  peakSlot,
  slotBars,
  type RhythmMetric,
  usageMetricInfo,
  valueAxisTicks,
} from "./usageModel";
import { noteStyle } from "./ui";

function Stat({ label, value, hint, valueTitle }: { label: string; value: string; hint?: string; valueTitle?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-tertiary)" }}>{label}</div>
      <div title={valueTitle} style={{ fontSize: "var(--cmux-font-size-md)", fontWeight: 700, color: "var(--cmux-text)", marginTop: 2 }}>
        {value}
      </div>
      {hint ? <div style={{ ...noteStyle, marginTop: 2 }}>{hint}</div> : null}
    </div>
  );
}

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
  const ticks = valueAxisTicks(max);
  const tickBottom = (tick: number) => `${max > 0 ? (tick / max) * 100 : 0}%`;
  const tickLabel = (tick: number) => formatMetric(tick, metric).replace(/ tok$/, "").replace(/\.0(?=[万億兆]|$)/, "");
  const labels = bars.filter((_, index) => bars.length <= 12 || index % 6 === 0);
  return (
    <div role="group" aria-labelledby={titleId} style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <span id={titleId} style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-secondary)", fontWeight: 600 }}>
          {title} · {metric === "turns" ? "回" : "トークン"}
        </span>
        <span style={noteStyle}>{peakLabel}</span>
      </div>
      <div aria-hidden="true" style={{ display: "grid", gridTemplateColumns: "max-content minmax(0, 1fr)", columnGap: 8, rowGap: 10, minWidth: 0, paddingTop: 8 }}>
        <div data-rhythm-axis style={{ position: "relative", display: "grid", height: 72, fontSize: "var(--cmux-font-size-xs)", whiteSpace: "nowrap" }}>
          {ticks.map((tick) => <span key={`width-${tick}`} style={{ gridArea: "1 / 1", visibility: "hidden" }}>{tickLabel(tick)}</span>)}
          {ticks.map((tick) => <span key={tick} data-rhythm-tick style={{ position: "absolute", right: 0, bottom: tickBottom(tick), transform: "translateY(50%)", color: "var(--cmux-text-secondary)" }}>{tickLabel(tick)}</span>)}
        </div>
        <div style={{ position: "relative", display: "flex", alignItems: "flex-end", gap: 2, height: 72, minWidth: 0 }}>
          {ticks.map((tick) => <span key={tick} aria-hidden="true" style={{ position: "absolute", left: 0, right: 0, bottom: tickBottom(tick), borderTop: "1px solid var(--cmux-border-hairline)", pointerEvents: "none" }} />)}
          {bars.map((bar) => (
            <div
              key={bar.slot}
              title={`${bar.label} ${formatMetric(bar.value, metric)}`}
              style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%", minWidth: 0 }}
            >
              <div
                style={{
                  height: `${Math.max(bar.ratio * 100, bar.value > 0 ? 3 : 0)}%`,
                  background: "var(--cmux-accent)",
                  opacity: bar.value > 0 ? 0.45 + bar.ratio * 0.55 : 0.15,
                  borderRadius: 2,
                }}
              />
            </div>
          ))}
        </div>
        <div />
        <div data-rhythm-labels style={{ position: "relative", height: "1.5em", fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-secondary)" }}>
          {labels.map((bar) => (
            <span key={bar.slot} data-rhythm-label style={{ position: "absolute", left: `${((bars.indexOf(bar) + 0.5) / bars.length) * 100}%`, transform: "translateX(-50%)", whiteSpace: "nowrap" }}>{bars.length > 12 ? bar.slot : bar.label}</span>
          ))}
        </div>
      </div>
      <details>
        <summary style={{ ...noteStyle, cursor: "pointer", color: "var(--cmux-text-secondary)" }}>数値を表で見る</summary>
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8, fontSize: "var(--cmux-font-size-xs)" }}>
          <caption style={{ textAlign: "left", paddingBottom: 6 }}>{title}ごとの{usageMetricInfo(metric).label}</caption>
          <thead><tr><th scope="col" style={{ textAlign: "left" }}>{title}</th><th scope="col" style={{ textAlign: "right" }}>{usageMetricInfo(metric).label}</th></tr></thead>
          <tbody>{bars.map((bar) => <tr key={bar.slot}><th scope="row" style={{ textAlign: "left", fontWeight: 400, padding: "4px 0" }}>{bar.label}</th><td style={{ textAlign: "right" }}>{formatMetricFull(bar.value, metric)}</td></tr>)}</tbody>
        </table>
      </details>
    </div>
  );
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
  const ratio = activeDayRatio(report.activeDays, report.spanDays);
  const offset = offsetLabel(report.dayOffsetMinutes);
  const info = usageMetricInfo(metric);
  const valueOf = (day: { io: number; total: number; turns: number }) => metric === "ioTokens" ? day.io : metric === "totalTokens" ? day.total : day.turns;
  const busiestDay = report.days.reduce<(typeof report.days)[number] | null>((best, day) => !best || valueOf(day) > valueOf(best) ? day : best, null);

  const streakHint =
    report.streak.currentThroughDay !== null
      ? `${formatDayBucket(report.streak.currentThroughDay)} まで`
      : undefined;
  const longestHint =
    report.streak.longestEndDay !== null
      ? `${formatDayBucket(report.streak.longestEndDay)} まで`
      : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 150px), 1fr))" }}>
        <Stat
          label={info.label}
          value={formatMetric(valueOf(report.totals), metric)}
          valueTitle={formatMetricFull(valueOf(report.totals), metric)}
        />
        <Stat
          label="記録のある日"
          value={`${formatCount(report.activeDays)} / ${formatCount(report.spanDays)} 日`}
          hint={report.spanDays > 0 ? `最初〜最後の記録の${formatCount(report.spanDays)}日間 · ${(ratio * 100).toFixed(0)}%` : undefined}
        />
        <Stat label="連続日数" value={`${formatCount(report.streak.current)} 日`} hint={streakHint} />
        <Stat label="最長連続" value={`${formatCount(report.streak.longest)} 日`} hint={longestHint} />
        <Stat
          label="ピーク時間帯"
          value={peakHour ? peakHour.label : "—"}
          hint={peakHour ? `${formatMetric(peakHour.value, metric)}・${offset}` : undefined}
        />
        <Stat
          label="最も多い曜日"
          value={peakWeekday ? peakWeekday.label : "—"}
          hint={peakWeekday ? formatMetric(peakWeekday.value, metric) : undefined}
        />
      </div>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))" }}>
        <Bars
          title={`時間帯 (${offset})`}
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

      <div style={noteStyle}>{busiestDay && valueOf(busiestDay) > 0 ? `${info.label}が最も多い日: ${formatDayBucket(busiestDay.day)} (${formatMetric(valueOf(busiestDay), metric)})` : report.activeDays > 0 ? `この期間の${info.label}は0です。` : "この期間の記録はありません。"}</div>
    </div>
  );
}
