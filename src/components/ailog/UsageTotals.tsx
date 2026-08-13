/**
 * Headline figures for the usage tab.
 *
 * The Claude/GPT split card is the reason this tab exists: the same recorded
 * work reads as one provider dominating or the other, purely depending on the
 * metric. Cost is shown, but demoted and labelled, because unpriced models make
 * it an undercount by construction.
 */

import { formatCount, formatUsd, type SeriesReport } from "../../lib/ailog";
import { formatMetric, metricValue, usageMetricInfo, type UsageMetric } from "./usageModel";
import { Chip, cardStyle, noteStyle } from "./ui";

export interface UsageTotalsData {
  metricTotal: number;
  costUsd: number;
  claude: number;
  gpt: number;
  other: number;
  cacheShare: number;
  unpricedModels: string[];
}

/**
 * Attribute a group to a provider by its model name.
 *
 * Deliberately literal: `(unknown)` and anything unrecognised fall into
 * `other` rather than being guessed into a bucket, so the split never claims
 * more certainty than the transcript gave.
 */
function providerOf(group: string): "claude" | "gpt" | "other" {
  if (group.startsWith("claude") || /^(opus|sonnet|haiku|fable|mythos)/.test(group)) return "claude";
  if (group.startsWith("gpt") || group.startsWith("codex")) return "gpt";
  return "other";
}

export function summarizeUsage(report: SeriesReport, metric: UsageMetric): UsageTotalsData {
  let metricTotal = 0;
  let costUsd = 0;
  let claude = 0;
  let gpt = 0;
  let other = 0;
  let cacheTokens = 0;
  let allTokens = 0;

  for (const bucket of report.buckets) {
    for (const group of bucket.groups) {
      const value = metricValue(group, metric);
      metricTotal += value;
      costUsd += group.costUsd;
      cacheTokens += group.cacheRead + group.cacheWrite;
      allTokens += group.input + group.output + group.cacheRead + group.cacheWrite;
      const provider = providerOf(group.group);
      if (provider === "claude") claude += value;
      else if (provider === "gpt") gpt += value;
      else other += value;
    }
  }

  return {
    metricTotal,
    costUsd,
    claude,
    gpt,
    other,
    cacheShare: allTokens > 0 ? cacheTokens / allTokens : 0,
    unpricedModels: report.unpricedModels,
  };
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ ...cardStyle, padding: "10px 12px 12px", minWidth: 0 }}>
      <div style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-tertiary)" }}>{label}</div>
      {children}
    </div>
  );
}

export function UsageTotals({
  report,
  metric,
}: {
  report: SeriesReport;
  metric: UsageMetric;
}) {
  const data = summarizeUsage(report, metric);
  const info = usageMetricInfo(metric);
  const pct = (value: number) =>
    data.metricTotal > 0 ? `${((value / data.metricTotal) * 100).toFixed(1)}%` : "—";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
        <Card label={`${info.label} (期間合計)`}>
          <div style={{ fontSize: "var(--cmux-font-size-md)", fontWeight: 700, marginTop: 3 }}>
            {formatMetric(data.metricTotal, metric)}
          </div>
          <div style={{ ...noteStyle, marginTop: 3 }}>{info.hint}</div>
        </Card>

        <Card label="Claude / GPT の内訳">
          <div style={{ fontSize: "var(--cmux-font-size-md)", fontWeight: 700, marginTop: 3 }}>
            {`${pct(data.claude)} / ${pct(data.gpt)}`}
          </div>
          <div style={{ ...noteStyle, marginTop: 3 }}>
            {`Claude ${formatMetric(data.claude, metric)}・GPT ${formatMetric(data.gpt, metric)}`}
            {data.other > 0 ? `・その他 ${formatMetric(data.other, metric)}` : ""}
          </div>
        </Card>

        <Card label="コスト相当 (副次)">
          <div style={{ fontSize: "var(--cmux-font-size-md)", fontWeight: 700, marginTop: 3, color: "var(--cmux-text-secondary)" }}>
            {formatUsd(data.costUsd)}
          </div>
          <div style={{ ...noteStyle, marginTop: 3 }}>
            請求額ではありません。この指標の順位とは一致しません。
          </div>
        </Card>

        <Card label="コスト算入外">
          <div style={{ fontSize: "var(--cmux-font-size-md)", fontWeight: 700, marginTop: 3 }}>
            {data.unpricedModels.length > 0 ? `${formatCount(data.unpricedModels.length)} モデル` : "なし"}
          </div>
          <div style={{ ...noteStyle, marginTop: 3 }}>
            {data.unpricedModels.length > 0
              ? `${data.unpricedModels.slice(0, 3).join(", ")}${data.unpricedModels.length > 3 ? " ほか" : ""} は単価未設定`
              : "この期間のモデルはすべて単価が登録されています"}
          </div>
        </Card>
      </div>

      {metric === "totalTokens" && data.cacheShare > 0 ? (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <Chip tone="warn">{`総トークンの ${(data.cacheShare * 100).toFixed(1)}% はキャッシュ読み書き`}</Chip>
          <span style={noteStyle}>実際に送った・書かせた量は「入出力トークン」で見てください。</span>
        </div>
      ) : null}

      {data.unpricedModels.length > 0 ? (
        <div style={{ ...noteStyle, color: "var(--cmux-usage-warn)" }}>
          {`${data.unpricedModels.join(", ")} は公表料率が登録されていないため、コスト相当に一切含まれていません。トークン量には含まれています。`}
        </div>
      ) : null}
    </div>
  );
}
