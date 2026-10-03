import { formatLocalDateTime } from "../../lib/ailog";
import { useAilogStore } from "../../stores/ailogStore";
import { noteStyle } from "./ui";

/** Saved numbers remain visibly provisional, including failed replacements. */
export function ReportCacheStatus() {
  const snapshots = useAilogStore((state) => state.reportSnapshots);
  const overview = useAilogStore((state) => state.overview);
  const entries = Object.values(snapshots);
  if (entries.length === 0) return null;
  const savedAt = Math.min(...entries.map((entry) => entry.savedAt));
  const refreshing = entries.some((entry) => entry.refreshing);
  return <div role="status" aria-live="polite" data-testid="ailog-snapshot-status" style={{ ...noteStyle, marginTop: 2 }}>
    {`保存済みの集計（保存: ${formatLocalDateTime(savedAt)}）を表示 · ${refreshing ? "最新の記録を集計中…" : "最新の集計を更新できませんでした"}`}
    {snapshots.overview && overview ? ` · 保存時の期間 ${formatLocalDateTime(overview.range.from)} 〜 ${formatLocalDateTime(overview.range.to)}` : ""}
  </div>;
}
