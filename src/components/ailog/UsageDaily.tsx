import { useMemo, useState } from "react";
import type { SeriesReport } from "../../lib/ailog";
import { UsageBucketChart } from "./UsageBucketChart";
import { buildUsageGrass, grassDayStart } from "./usageGrassModel";
import { DAY_MS, buildUsageModel, formatMetricFull, groupLabel, type UsageMetric } from "./usageModel";
import { noteStyle, subtleButtonStyle, tableStyle, tdLeftStyle, tdStyle, thLeftStyle, thStyle, paintSwatchBackground, VScrollBox } from "./ui";

export function usageBoundaryNote(range: { from: number; to: number }): string {
  const first = range.from > -8_640_000_000_000_000 && range.from > grassDayStart(range.from);
  const last = range.to < grassDayStart(range.to) + DAY_MS - 1;
  return first && last ? "期間の最初と最後は途中の1日を含みます。棒は期間内に記録された量です。"
    : first ? "期間の最初は途中の1日です。棒は期間内に記録された量です。"
    : last ? "期間の最後は途中の1日です。今日の棒は現時点までの記録です。"
    : "棒は選んだ期間の1日分の記録です。";
}

/** The grass model retains the day/streak calculations; only absolute bars are rendered. */
export function UsageDaily({ report, metric, onPickDay }: { report: SeriesReport; metric: UsageMetric; onPickDay: (day: number) => void }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const days = useMemo(() => buildUsageGrass(report, metric, report.groupBy), [report, metric]);
  const model = useMemo(() => {
    const byDay = new Map(report.buckets.map(row => [grassDayStart(row.bucket), row]));
    const buckets = days.days.map(day => (byDay.has(day.day) ? { ...byDay.get(day.day)!, bucket: day.day } : { bucket: day.day, groups: [], turns: 0, sessions: 0, costUsd: 0 }));
    return buildUsageModel(buckets, metric, 12, "day", report.groupBy);
  }, [report, metric, days]);
  const pinned = selected !== null && days.days.some(day => day.day === selected) ? selected : null;
  const detail = days.breakdown(pinned ?? "all");
  const label = pinned === null ? "主な内訳" : days.days.find(day => day.day === pinned)!.label + "の内訳";
  return <div data-usage-daily>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))", gap: 20, alignItems: "start" }}>
      <div style={{ minWidth: 0 }}>
        <UsageBucketChart model={model} metric={metric} mode="absolute" highlight={highlight}
          selectedDay={pinned} onSelectDay={setSelected} onHighlight={setHighlight} onPickDay={day => setSelected(current => current === day ? null : day)} groupBy={report.groupBy} bucket="day" priceCoverage={report.priceCoverage} />
        <div style={{ ...noteStyle, marginTop: 8 }}>{days.summary}</div>
        <div role="note" style={{ ...noteStyle, marginTop: 6 }}>{usageBoundaryNote(report.range)}</div>
      </div>
      <div style={{ minWidth: 0 }}>
        <h3 style={{ margin: "0 0 8px", fontSize: "var(--cmux-font-size-sm)" }}>{label}</h3>
        <table style={tableStyle}><thead><tr><th scope="col" style={thLeftStyle}>項目</th><th scope="col" style={thStyle}>使用量</th></tr></thead>
          <tbody>{detail.rows.slice(0, pinned === null ? 3 : undefined).map(row => <tr key={row.group}>
            <th scope="row" style={{ ...tdLeftStyle, fontWeight: 400 }}><span aria-hidden="true" style={{ display: "inline-block", width: 9, height: 9, marginRight: 5, background: paintSwatchBackground(row.paint) }} />{row.label}</th>
            <td style={tdStyle} title={[row.fullValueLabel, ...row.members].join(", ")}>{row.valueLabel}{row.shareLabel ? <span style={noteStyle}> ({row.shareLabel})</span> : null}</td></tr>)}</tbody></table>
        {!detail.recorded ? <div style={noteStyle}>この範囲に記録はありません。</div> : null}
        <p style={noteStyle}>全項目・補助指標は下の「内訳」で確認できます。</p>
      </div>
    </div>
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 10 }}>
      <span style={noteStyle}>棒を選ぶと日の内訳。矢印キーで日付を移動</span>
      <button type="button" disabled={pinned === null} onClick={() => { if (pinned !== null) onPickDay(pinned); }} style={subtleButtonStyle}>この日に絞り込む</button>
      <button type="button" onClick={() => setSelected(null)} style={subtleButtonStyle}>期間全体に戻す</button>
    </div>
    <div style={{ marginTop: 8 }}><VScrollBox maxHeight={144} label="日別の数値"><table style={tableStyle}>
      <thead><tr><th scope="col" style={thLeftStyle}>日付</th><th scope="col" style={thStyle}>選択指標</th><th scope="col" style={thLeftStyle}>いちばん多い項目</th></tr></thead>
      <tbody>{days.days.map(day => <tr key={day.day}><th scope="row" style={{ ...tdLeftStyle, fontWeight: 400 }}><button type="button" onClick={() => setSelected(day.day)} style={subtleButtonStyle}>{day.label}</button></th><td style={tdStyle}>{formatMetricFull(day.value, metric)}</td><td style={tdLeftStyle}>{groupLabel(day.topLabel, report.groupBy)}</td></tr>)}</tbody>
    </table></VScrollBox></div>
  </div>;
}
