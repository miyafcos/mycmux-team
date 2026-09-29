import { formatDelta, formatScore, type Overview, type RangePreset, type SeriesReport, type SessionsReport, type Totals } from "../../lib/ailog";
import { formatMetric, groupByLabel, usageMetricInfo, type UsageMetric } from "./usageModel";
import { metricFromTotals, periodDeltaFromTotals } from "./UsageTotals";
import { noteStyle } from "./ui";

export function AilogOrientation({
  overview,
  series,
  sessions,
  metric,
  preset,
  previousTotals,
  previousTotalsStatus,
  breakdownLabel,
  running,
  sessionLoading,
  sessionError,
  onStartIndex,
  onOpenDetail,
}: {
  overview: Overview;
  series: SeriesReport | null;
  sessions: SessionsReport | null;
  metric: UsageMetric;
  preset: RangePreset;
  previousTotals: Totals | null;
  previousTotalsStatus: "idle" | "loading" | "ready" | "error";
  breakdownLabel: string;
  running: boolean;
  sessionLoading: boolean;
  sessionError: string | null;
  onStartIndex: () => void;
  onOpenDetail: (kind: string, sessionId: string) => void;
}) {
  const total = metricFromTotals(overview.totals, metric);
  const delta = periodDeltaFromTotals(metric, overview.totals, previousTotals, preset);
  const groupingLabel = groupByLabel(series?.groupBy ?? "provider");
  const pageLinks = [
    ["ailog-overview", "概要"],
    ["ailog-purpose", "使い道"],
    ["ailog-trend", "推移"],
    ["ailog-learning", "つまずき"],
    ["ailog-handoffs", "切り替え"],
    ["ailog-compare", `${groupingLabel}別`],
    ["ailog-cross", "2軸比較"],
    ["ailog-projects", `${breakdownLabel}別`],
    ["ailog-sessions", "セッション"],
  ] as const;
  const nextSession = sessions?.rows.reduce((best, row) => (
    !best || row.reworkScore > best.reworkScore ? row : best
  ), sessions.rows[0]);
  const next = overview.indexFreshness.staleFiles > 0
    ? running
      ? `${overview.indexFreshness.staleFiles.toLocaleString("ja-JP")}ファイルを取り込み中です。`
      : `未反映 ${overview.indexFreshness.staleFiles.toLocaleString("ja-JP")}ファイル。選ぶと取り込みを開始します。`
    : sessionLoading
      ? "セッション一覧を更新中です。"
    : nextSession
      ? `${sessionError ? "直前" : "表示中"}の一覧で、機械指標上の手戻り兆候が最大: ${nextSession.title?.trim() || "（無題）"}（${formatScore(nextSession.reworkScore)}）`
      : "次に確認するセッション候補はありません。";
  const change = preset === "all"
    ? "全期間では前期間比較なし"
    : previousTotalsStatus === "loading" || previousTotalsStatus === "idle"
      ? "前期間との比較を読み込み中"
    : previousTotalsStatus === "error" || previousTotals === null
      ? "前期間を取得できません"
      : delta === null
        ? "前期間の値が0のため比率なし"
        : `${usageMetricInfo(metric).label} 前期間比 ${formatDelta(delta)}`;

  return (
    <div style={{ borderTop: "1px solid var(--cmux-border)", borderBottom: "1px solid var(--cmux-border)", padding: "9px 0", display: "flex", flexDirection: "column", gap: 8 }}>
      <div aria-label="3秒で分かる現在地" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 8 }}>
        <Status label="現在" value={`${overview.range.label} · ${overview.totals.sessions.toLocaleString("ja-JP")}セッション · ${usageMetricInfo(metric).label} ${formatMetric(total, metric)}`} />
        <Status label="変化" value={change} />
        <Status
          label="次に見る"
          value={next}
          action={overview.indexFreshness.staleFiles > 0 && !running ? onStartIndex : overview.indexFreshness.staleFiles === 0 && nextSession && !sessionLoading ? () => onOpenDetail(nextSession.kind, nextSession.sessionId) : undefined}
        />
      </div>
      <nav aria-label="AIログ分析のページ内索引" style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
        <span style={noteStyle}>移動:</span>
        {pageLinks.map(([id, label]) => (
          <a key={id} href={`#${id}`} style={{ ...noteStyle, color: "var(--cmux-accent)", padding: "2px 5px" }}>{label}</a>
        ))}
      </nav>
    </div>
  );
}

function Status({ label, value, action }: { label: string; value: string; action?: () => void }) {
  const body = <><strong style={{ color: "var(--cmux-text)", marginRight: 6 }}>{label}</strong>{value}</>;
  return action ? (
    <button type="button" onClick={action} style={{ ...noteStyle, border: 0, background: "transparent", padding: 0, textAlign: "left", color: "var(--cmux-text-secondary)", cursor: "pointer" }}>{body}</button>
  ) : <div style={{ ...noteStyle, color: "var(--cmux-text-secondary)" }}>{body}</div>;
}
