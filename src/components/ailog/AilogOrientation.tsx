import { formatScore, type Overview, type RangePreset, type SeriesReport, type SessionsReport, type Totals } from "../../lib/ailog";
import { type UsageMetric } from "./usageModel";
import { noteStyle } from "./ui";

export function AilogOrientation({
  overview,
  sessions,
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
  const nextSession = sessions?.rows.reduce((best, row) => (
    !best || row.reworkScore > best.reworkScore ? row : best
  ), sessions.rows[0]);
  return <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
    {overview.indexFreshness.staleFiles > 0 ? <button type="button" disabled={running} onClick={onStartIndex} style={noteStyle}>記録を更新（未反映 {overview.indexFreshness.staleFiles} ファイル）</button> : null}
    {nextSession && !sessionLoading ? <button type="button" onClick={() => onOpenDetail(nextSession.kind, nextSession.sessionId)} style={{ ...noteStyle, color: "var(--cmux-accent-text)", background: "transparent", border: "1px solid var(--cmux-border)", borderRadius: 4, cursor: "pointer", padding: "4px 8px" }}>
      会話候補を開く: {nextSession.title?.trim() || "（無題）"}（手戻り {formatScore(nextSession.reworkScore)}）
    </button> : <span style={noteStyle}>{sessionLoading ? "会話候補を更新中" : sessionError ? "セッション一覧を取得できませんでした" : "会話候補なし"}</span>}
  </div>;
}
