import { formatLocalDateTime, type RangeOut } from "../../lib/ailog";
import { EmptyState, noteStyle, subtleButtonStyle } from "./ui";
import { useAilogStore } from "../../stores/ailogStore";

export function reportRangeLabel(range: RangeOut): string {
  const start = Number.isNaN(new Date(range.from).getTime()) ? "開始指定なし" : formatLocalDateTime(range.from);
  return `${start} 〜 ${formatLocalDateTime(range.to)}`;
}

export function ReportPeriod({ range }: { range: RangeOut }) {
  const preset = useAilogStore((state) => state.preset);
  const requestedAnchor = useAilogStore((state) => state.rangeAnchor);
  const differentPeriod = preset !== "custom" && range.to !== requestedAnchor;
  return <div style={noteStyle} data-report-range-to={range.to}>
    {`表示データの期間 ${reportRangeLabel(range)}`}
    {differentPeriod ? <span title={new Date(requestedAnchor).toISOString()}>{` · 今回の要求と異なる期間のデータです（要求の終端: ${formatLocalDateTime(requestedAnchor)}）`}</span> : null}
  </div>;
}

export function ReportNotLoaded({ label, onLoad }: { label: string; onLoad: () => void }) {
  return <div style={noteStyle}>{label}をまだ読み込んでいません。 <button type="button" onClick={onLoad} style={subtleButtonStyle}>{label}を読み込む</button></div>;
}

export function ReportFailure({ label, error, range, onRetry }: {
  label: string;
  error: string;
  range?: RangeOut | null;
  onRetry: () => void;
}) {
  if (!range) return <EmptyState kind="error" title={`${label}の読み込み失敗`} message={error} onPrimary={onRetry} primaryLabel={`${label}を再試行`} />;
  return <div role="alert" style={{ ...noteStyle, color: "var(--cmux-red)" }}>
    {`${label}を更新できませんでした。直前の集計を表示しています。`}
    <ReportPeriod range={range} />
    <button type="button" onClick={onRetry} style={subtleButtonStyle}>{`${label}を再試行`}</button>
    <details><summary>技術情報</summary>{error}</details>
  </div>;
}
