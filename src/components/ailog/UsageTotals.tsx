/**
 * Headline figures for the usage tab.
 *
 * The Claude/GPT split card is the reason this tab exists: the same recorded
 * work reads as one provider dominating or the other, purely depending on the
 * metric. Cost is shown, but demoted and labelled, because unpriced models make
 * it an undercount by construction.
 */

import { formatDelta, formatDuration, formatPct, formatMoney, type ComparePrevious, type PriceCoverage, type RangePreset, type SeriesReport, type Totals } from "../../lib/ailog";
import { costCoverageLabel, decomposeCostChange, formatMetric, formatMetricFull, metricValue, usageMetricInfo, type UsageMetric } from "./usageModel";
import { Chip, cardStyle, noteStyle } from "./ui";

export interface UsageTotalsData {
  metricTotal: number;
  costUsd: number;
  claude: number;
  gpt: number;
  other: number;
  cacheShare: number;
  priceCoverage: PriceCoverage;
}

/** Select only comparisons which describe the currently selected metric. */
export function periodDeltaForMetric(metric: UsageMetric, comparePrevious: ComparePrevious | null, preset: RangePreset): number | null {
  if (preset === "all" || comparePrevious === null) return null;
  switch (metric) {
    case "ioTokens":
    case "totalTokens":
      return null;
    case "sessions":
      return comparePrevious.sessionsPct;
    case "costUsd":
      return comparePrevious.costPct;
    case "turns":
      return null;
  }
}

export function metricFromTotals(totals: Totals, metric: UsageMetric): number {
  switch (metric) {
    case "ioTokens": return totals.input + totals.output;
    case "totalTokens": return totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
    case "sessions": return totals.sessions;
    case "turns": return totals.turns;
    case "costUsd": return totals.costUsd;
  }
}

export function periodDeltaFromTotals(metric: UsageMetric, current: Totals, previous: Totals | null, preset: RangePreset): number | null {
  if (preset === "all" || previous === null) return null;
  const before = metricFromTotals(previous, metric);
  if (before === 0) return null;
  return ((metricFromTotals(current, metric) - before) / Math.abs(before)) * 100;
}

/**
 * Attribute a group to a provider by its model name.
 *
 * Deliberately literal: `(unknown)` and anything unrecognised fall into
 * `other` rather than being guessed into a bucket, so the split never claims
 * more certainty than the transcript gave.
 */
function providerOf(group: string): "claude" | "gpt" | "other" {
  if (group === "anthropic" || group.startsWith("claude") || /^(opus|sonnet|haiku|fable|mythos)/.test(group)) return "claude";
  if (group === "openai" || group.startsWith("gpt") || group.startsWith("codex")) return "gpt";
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
    priceCoverage: report.priceCoverage,
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

function percentChange(current: number, previous: number): string | null {
  if (previous === 0) return null;
  return formatDelta(((current - previous) / Math.abs(previous)) * 100);
}

function signedMoney(value: number): string {
  if (Math.abs(value) < 0.005) return `±${formatMoney(0)}`;
  return `${value > 0 ? "+" : "-"}${formatMoney(Math.abs(value))}`;
}

function effectPercent(value: number, previousCost: number): string {
  if (previousCost === 0) return "—";
  const pct = (value / Math.abs(previousCost)) * 100;
  if (Math.abs(pct) < 0.05) return "±0.0%";
  return `${pct > 0 ? "+" : "-"}${Math.abs(pct).toFixed(1)}%`;
}

function ChangeLine({ label, value, previousCost, warn, testId }: { label: string; value: number; previousCost: number; warn: boolean; testId: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: "var(--cmux-font-size-xs)" }}>
      <span style={{ color: "var(--cmux-text-secondary)" }}>{label}</span>
      <span data-testid={testId} style={warn ? { color: "var(--cmux-usage-warn)", fontVariantNumeric: "tabular-nums" } : { fontVariantNumeric: "tabular-nums" }}>
        {`${signedMoney(value)} (${effectPercent(value, previousCost)})`}
      </span>
    </div>
  );
}

export function UsageTotals({
  report,
  metric,
  preset,
  totals,
  previousTotals,
  turnFilterActive = false,
}: {
  report: SeriesReport;
  metric: UsageMetric;
  preset: RangePreset;
  totals: Totals;
  previousTotals: Totals | null;
  turnFilterActive?: boolean;
}) {
  const data = summarizeUsage(report, metric);
  const info = usageMetricInfo(metric);
  const headlineTotal = metric === "sessions" ? totals.sessions : data.metricTotal;
  const pct = (value: number) =>
    data.metricTotal > 0 ? `${((value / data.metricTotal) * 100).toFixed(1)}%` : "—";
  const periodDelta = periodDeltaFromTotals(metric, totals, previousTotals, preset);
  const requestDelta = previousTotals ? percentChange(totals.userMessages, previousTotals.userMessages) : null;
  const currentCostPerRequest = totals.userMessages > 0 ? totals.costUsd / totals.userMessages : null;
  const previousCostPerRequest = previousTotals && previousTotals.userMessages > 0
    ? previousTotals.costUsd / previousTotals.userMessages
    : null;
  const costPerRequestDelta = currentCostPerRequest !== null && previousCostPerRequest !== null
    ? percentChange(currentCostPerRequest, previousCostPerRequest)
    : null;
  const waitMs = totals.wallMs - totals.activeMs;
  const waitPct = totals.wallMs > 0 ? formatPct((waitMs / totals.wallMs) * 100) : "—";
  const costChange = !turnFilterActive && previousTotals && preset !== "all"
    ? decomposeCostChange(totals.costUsd, totals.userMessages, previousTotals.costUsd, previousTotals.userMessages)
    : null;
  const showProviderSplit = metric !== "sessions" && (report.groupBy === "provider" || report.groupBy === "model" || report.groupBy === "model_raw");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 190px), 1fr))" }}>
        <Card label={`${info.label} (期間合計)`}>
          <div title={formatMetricFull(headlineTotal, metric)} style={{ fontSize: "var(--cmux-font-size-md)", fontWeight: 700, marginTop: 3 }}>
            {formatMetric(headlineTotal, metric)}
          </div>
          {periodDelta !== null ? <div style={{ ...noteStyle, marginTop: 3 }}>{`${formatDelta(periodDelta)} 前期間比`}</div> : null}
          <div style={{ ...noteStyle, marginTop: 3 }}>{info.hint}</div>
        </Card>

        {showProviderSplit ? <Card label="Claude / GPT の内訳">
          <div style={{ fontSize: "var(--cmux-font-size-md)", fontWeight: 700, marginTop: 3 }}>
            {`${pct(data.claude)} / ${pct(data.gpt)}`}
          </div>
          <div style={{ ...noteStyle, marginTop: 3 }}>
            {`Claude ${formatMetric(data.claude, metric)}・GPT ${formatMetric(data.gpt, metric)}`}
            {data.other > 0 ? `・その他 ${formatMetric(data.other, metric)}` : ""}
          </div>
        </Card> : null}

        {metric === "costUsd" ? null : (
          <Card label={data.priceCoverage.coveredTokenRatio < 1 ? `コスト相当 (対象トークンのうち価格情報あり ${Math.round(data.priceCoverage.coveredTokenRatio * 100)}%)` : "コスト相当 (副次)"}>
            <div style={{ fontSize: "var(--cmux-font-size-md)", fontWeight: 700, marginTop: 3, color: "var(--cmux-text-secondary)" }}>
              {formatMoney(data.costUsd)}
            </div>
            <div style={{ ...noteStyle, marginTop: 3 }}>
              請求額ではありません。円額は設定レートでの換算です。この指標の順位とは一致しません。
            </div>
          </Card>
        )}

        {!turnFilterActive ? <Card label="対象セッションの依頼数">
          <div style={{ fontSize: "var(--cmux-font-size-md)", fontWeight: 700, marginTop: 3 }}>{totals.userMessages.toLocaleString("ja-JP")}</div>
          {requestDelta !== null ? <div style={{ ...noteStyle, marginTop: 3 }}>{`${requestDelta} 前期間比`}</div> : null}
          <div style={{ ...noteStyle, marginTop: 3 }}>選んだ期間に記録のあるセッションについて、セッション全体の依頼発話を数えます。</div>
        </Card> : null}

        {!turnFilterActive ? <Card label="1依頼あたりのコスト相当">
          <div style={{ fontSize: "var(--cmux-font-size-md)", fontWeight: 700, marginTop: 3, color: costPerRequestDelta !== null && costPerRequestDelta.startsWith("▲") ? "var(--cmux-usage-warn)" : undefined }}>
            {currentCostPerRequest === null ? "—" : formatMoney(currentCostPerRequest)}
          </div>
          {costPerRequestDelta !== null ? <div style={{ ...noteStyle, marginTop: 3, color: costPerRequestDelta.startsWith("▲") ? "var(--cmux-usage-warn)" : undefined }}>{`${costPerRequestDelta} 前期間比`}</div> : null}
          <div style={{ ...noteStyle, marginTop: 3 }}>期間内のコスト相当を、対象セッション全体の依頼数で割った値です。</div>
        </Card> : null}

        {!turnFilterActive ? <Card label="対象セッションの未帰属時間">
          <div style={{ fontSize: "var(--cmux-font-size-md)", fontWeight: 700, marginTop: 3 }}>{`${formatDuration(waitMs)} (実時間の ${waitPct})`}</div>
          <div style={{ ...noteStyle, marginTop: 3 }}>対象セッション全体の開始から終了までの実時間から、ターン所要時間の合計を引いた残りです。AIの思考と人が離席していた時間のどちらかには断定しません。</div>
        </Card> : null}

      </div>

      {costChange ? (
        <div data-testid="cost-change-breakdown" style={{ ...cardStyle, padding: "10px 12px 12px" }}>
          <div style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-tertiary)" }}>コスト相当の変化</div>
          <div style={{ fontSize: "var(--cmux-font-size-sm)", fontWeight: 700, marginTop: 3 }}>{`前期間より ${signedMoney(costChange.totalDelta)} (${effectPercent(costChange.totalDelta, previousTotals!.costUsd)})`}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 8 }}>
            <ChangeLine label="依頼回数の変化分" value={costChange.volumeEffect} previousCost={previousTotals!.costUsd} warn={false} testId="cost-volume-effect" />
            <ChangeLine label="1依頼あたり平均の変化分" value={costChange.rateEffect} previousCost={previousTotals!.costUsd} warn={costChange.rateEffect > 0} testId="cost-rate-effect" />
            <ChangeLine label="両方の変化が重なる分" value={costChange.interaction} previousCost={previousTotals!.costUsd} warn={false} testId="cost-interaction-effect" />
          </div>
          <div style={{ ...noteStyle, marginTop: 7 }}>差を数式上で分解した目安です。原因を特定するものではありません。</div>
        </div>
      ) : null}

      {turnFilterActive ? <div style={noteStyle}>モデルで絞り込み中は、トークンとコスト相当が該当モデルのターン、依頼回数と実時間がセッション全体になります。母数が混ざる指標は表示していません。</div> : null}

      {metric === "costUsd" ? (
        <div style={noteStyle}>{`${costCoverageLabel(data.priceCoverage)}。請求額ではありません。円額は設定レートでの換算です。`}</div>
      ) : null}

      {metric === "totalTokens" && data.cacheShare > 0 ? (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <Chip tone="warn">{`総トークンの ${(data.cacheShare * 100).toFixed(1)}% はキャッシュ読み書き`}</Chip>
          <span style={noteStyle}>実際に送った・書かせた量は「入出力トークン」で見てください。</span>
        </div>
      ) : null}

      <div style={noteStyle}>
        {`入出力トークンは送った文章と生成した文章の量。総トークンはそれにキャッシュ読み書きを含む量です${data.cacheShare > 0 ? `（この期間は ${(data.cacheShare * 100).toFixed(1)}% がキャッシュ読み書き）` : ""}。`}
      </div>
      <div style={noteStyle}>推論トークンは出力に含まれるため、二重計上を避けて別加算しません。</div>

    </div>
  );
}
