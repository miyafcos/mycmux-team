import { formatLocalDateTime } from "../../lib/ailog";
import { useAilogStore } from "../../stores/ailogStore";
import { reportRangeLabel } from "./ReportFeedback";
import { noteStyle } from "./ui";

/** Saved numbers remain visibly provisional, including failed replacements. */
export function ReportCacheStatus() {
  const snapshots = useAilogStore((state) => state.reportSnapshots);
  const overview = useAilogStore((state) => state.overview);
  const series = useAilogStore((state) => state.usageSeries);
  const breakdown = useAilogStore((state) => state.breakdown);
  const pivot = useAilogStore((state) => state.pivot);
  const rhythm = useAilogStore((state) => state.usageRhythm);
  const preset = useAilogStore((state) => state.preset);
  const customFrom = useAilogStore((state) => state.customFrom);
  const customTo = useAilogStore((state) => state.customTo);
  const selection = useAilogStore((state) => state.selection);
  const failed = useAilogStore((state) => Boolean(state.dashboardError || state.usageError || state.breakdownError || state.pivotError || state.usageRhythmError));
  const entries = Object.entries(snapshots);
  if (entries.length === 0) return null;
  const savedAt = Math.min(...entries.map(([, entry]) => entry.savedAt));
  const refreshing = entries.some(([, entry]) => entry.refreshing);
  const reports = { overview, usage: series, breakdown, pivot, rhythm };
  const labels = { overview: "概要", usage: "推移", breakdown: "内訳", pivot: "クロス集計", rhythm: "稼働リズム" };
  const selectedPeriod = preset === "custom" ? `${customFrom} 〜 ${customTo}`
    : ({ "7d": "直近7日", "30d": "直近30日", "90d": "直近90日", ytd: "今年", all: "全期間" })[preset];
  return <div role="status" aria-live="polite" data-testid="ailog-snapshot-status" style={{ ...noteStyle, marginTop: 2 }}>
    {`保存済みの集計（保存: ${formatLocalDateTime(savedAt)}）を表示 · ${refreshing ? "最新の記録を集計中…" : failed ? "最新の集計を更新できませんでした" : "前回の集計を表示しています"}`}
    <div>{`現在の条件: ${selectedPeriod}${selection?.project ? ` · 案件 ${selection.project.label}` : ""}${selection?.model ? ` · モデル ${selection.model.label}` : ""}`}</div>
    {entries.map(([slot, entry]) => {
      const report = reports[slot as keyof typeof reports];
      return report ? <div key={slot}>
        {`${labels[slot as keyof typeof labels]} · 保存時の期間 ${reportRangeLabel(report.range)} · 保存: ${formatLocalDateTime(entry.savedAt)}${entry.stale ? " · 保存時点から更新あり" : ""}`}
      </div> : null;
    })}
  </div>;
}
