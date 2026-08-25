/**
 * Working rhythm: lifetime totals, how many days were active, streaks, and the
 * shape of a day and a week.
 *
 * Everything here comes from SQL aggregates over `turn`, so it renders with no
 * summariser, no subprocess and no network — this is the part of the panel that
 * is always answerable.
 */

import { formatCount, formatDayBucket, formatTokens, formatTokensFull, type UsageRhythmReport } from "../../lib/ailog";
import {
  activeDayRatio,
  formatMetric,
  offsetLabel,
  peakSlot,
  slotBars,
  type RhythmMetric,
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
  const max = bars.reduce((peak, bar) => Math.max(peak, bar.value), 0);
  const ticks = valueAxisTicks(max);
  const tickBottom = (tick: number) => `${max > 0 ? (tick / max) * 100 : 0}%`;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-secondary)", fontWeight: 600 }}>
          {title}
        </span>
        <span style={noteStyle}>{peakLabel}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "52px minmax(0, 1fr)", gap: 4, minWidth: 0 }}>
        <div style={{ position: "relative", height: 56 }}>
          {ticks.map((tick) => <span key={tick} style={{ position: "absolute", right: 0, bottom: tickBottom(tick), transform: "translateY(50%)", color: "var(--cmux-text-tertiary)", fontSize: "var(--cmux-font-size-xs)", whiteSpace: "nowrap" }}>{formatMetric(tick, metric)}</span>)}
        </div>
        <div style={{ position: "relative", display: "flex", alignItems: "flex-end", gap: 2, height: 56, minWidth: 0 }}>
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
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "52px minmax(0, 1fr)", gap: 4 }}>
        <div />
        <div style={{ display: "flex", gap: 2 }}>
          {bars.map((bar, index) => (
          <div
            key={bar.slot}
            style={{
              flex: 1,
              textAlign: "center",
              fontSize: "var(--cmux-font-size-xs)",
              color: "var(--cmux-text-tertiary)",
              minWidth: 0,
              overflow: "hidden",
            }}
          >
            {bars.length > 12 ? (index % 3 === 0 ? bar.slot : "") : bar.label}
          </div>
          ))}
        </div>
      </div>
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
          label="総トークン"
          value={formatTokens(report.totals.total)}
          hint={`うち入出力 ${formatTokens(report.totals.io)}`}
          valueTitle={formatTokensFull(report.totals.total)}
        />
        <Stat
          label="記録がある区間の稼働日"
          value={`${formatCount(report.activeDays)} / ${formatCount(report.spanDays)} 日`}
          hint={report.spanDays > 0 ? `最初の記録日〜最後の記録日を分母 · ${(ratio * 100).toFixed(0)}%` : undefined}
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

      {report.busiestIo || report.busiestTotal ? (
        <div style={noteStyle}>
          {report.busiestIo
            ? `入出力が最も多い日: ${formatDayBucket(report.busiestIo.day)} (${formatTokens(report.busiestIo.io)})`
            : ""}
          {report.busiestIo && report.busiestTotal ? "・" : ""}
          {report.busiestTotal
            ? `総トークンが最も多い日: ${formatDayBucket(report.busiestTotal.day)} (${formatTokens(report.busiestTotal.total)})`
            : ""}
        </div>
      ) : null}
    </div>
  );
}
