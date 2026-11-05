import { formatCount, formatMoney, formatScore, type Overview, type RangePreset, type Totals } from "../../lib/ailog";
import { metricFromTotals, previousPeriodLabel } from "./UsageTotals";
import { formatMetric, formatMetricFull, usageMetricInfo, type UsageMetric } from "./usageModel";
import { noteStyle } from "./ui";

export function AilogOverview({ overview, metric, preset, previousTotals, previousTotalsStatus, filtered }: {
  overview: Overview; metric: UsageMetric; preset: RangePreset; previousTotals: Totals | null;
  previousTotalsStatus: "idle" | "loading" | "ready" | "error"; filtered: boolean;
}) {
  const value = metricFromTotals(overview.totals, metric);
  const cards = [
    { label: usageMetricInfo(metric).label, value: formatMetric(value, metric), title: formatMetricFull(value, metric) + "。" + usageMetricInfo(metric).hint,
      note: previousPeriodLabel(metric, overview.totals, previousTotals, previousTotalsStatus, preset) },
    { label: "コスト相当", value: formatMoney(overview.totals.costUsd), title: "現行の公表価格・ログ報告額による参考値。請求額ではありません。円額は設定レートによる換算です。",
      note: "価格情報あり " + Math.round(overview.priceCoverage.coveredTokenRatio * 100) + "%" },
    { label: "対象会話の依頼発話数", value: filtered ? "—" : formatCount(overview.totals.userMessages),
      title: "期間内に記録があるセッションについて、期間外を含む会話全体の利用者の依頼発話を数えます。",
      note: filtered ? "モデル絞り込み中は母数が異なるため非表示" : "期間内に記録がある会話の全発話" },
    { label: "手戻り指標の平均", value: filtered ? "—" : formatScore(overview.rework.avgScore),
      title: "対象セッションの機械的な手戻り兆候を表す相対指標の平均。0〜100で低いほど兆候が少なく、作業品質を判定する値ではありません。",
      note: filtered ? "モデル絞り込み中は母数が異なるため非表示" : "相対指標 0〜100" },
  ];
  return <div data-ailog-headlines style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))", gap: 12 }}>
    {cards.map(card => <div key={card.label} title={card.title} style={{ borderLeft: "2px solid var(--cmux-accent)", padding: "4px 12px" }}>
      <div style={noteStyle}>{card.label}</div><div style={{ fontSize: "var(--cmux-font-size-md)", fontWeight: 700, margin: "4px 0" }}>{card.value}</div><div style={noteStyle}>{card.note}</div>
    </div>)}
  </div>;
}
