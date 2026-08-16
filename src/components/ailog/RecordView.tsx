import { memo, useMemo, useState } from "react";

import type { BreakdownReport, Overview, RangePreset, SeriesReport, SessionsReport, UsageRhythmReport } from "../../lib/ailog";
import type { AilogSelection, BreakdownDimension, SessionSort } from "../../stores/ailogStore";
import { SESSION_PAGE_SIZE } from "../../stores/ailogStore";
import { ProjectTable } from "./ProjectTable";
import { SessionTable } from "./SessionTable";
import { SummaryCards } from "./SummaryCards";
import { UsageDailyChart } from "./UsageDailyChart";
import { UsageModelTable } from "./UsageModelTable";
import { UsageRhythm } from "./UsageRhythm";
import { UsageTotals } from "./UsageTotals";
import { buildUsageModel, isStackable, USAGE_METRICS, type UsageMetric } from "./usageModel";
import { ButtonGroup, DeferredDetails, EmptyState, Section, SkeletonBlock, noteStyle } from "./ui";

export const RecordView = memo(function RecordView(props: {
  overview: Overview | null; sessions: SessionsReport | null; series: SeriesReport | null; rhythm: UsageRhythmReport | null;
  loading: boolean; usageLoading: boolean; usageError: string | null; error: string | null; statusPending: boolean; neverIndexed: boolean; noData: boolean; running: boolean;
  preset: RangePreset; metric: UsageMetric; stack: "absolute" | "share"; bucket: "day" | "week" | "month"; granularity: "provider" | "family" | "raw"; excludeSynthetic: boolean;
  selection: AilogSelection | null; breakdownDimension: BreakdownDimension; breakdown: BreakdownReport | null; breakdownError: string | null; breakdownLoading: boolean; sessionSort: SessionSort; sessionPage: number;
  detailKey: { kind: string; sessionId: string } | null;
  onRefresh: () => void; onRetryUsage: () => void; onStartIndex: () => void; onMetric: (metric: UsageMetric) => void; onStack: (stack: "absolute" | "share") => void; onBucket: (bucket: "day" | "week" | "month") => void; onGranularity: (value: "provider" | "family" | "raw") => void;
  onPickDay: (day: number) => void; onOpenDigest: (day: number) => void; onSelect: (selection: AilogSelection | null) => void; onBreakdownDimension: (value: BreakdownDimension) => void; onRefreshBreakdown: () => void; onSessionSort: (value: SessionSort) => void; onSessionPage: (value: number) => void; onOpenDetail: (kind: string, sessionId: string) => void;
}) {
  const p = props;
  const [highlight, setHighlight] = useState<string | null>(null);
  const model = useMemo(() => p.series ? buildUsageModel(p.series.buckets, p.metric) : null, [p.series, p.metric]);
  const groupingLabel = p.granularity === "provider" ? "会社" : p.granularity === "family" ? "系統" : "モデル";
  const usageReady = Boolean(p.series && p.rhythm);

  if (p.error) return <EmptyState kind="error" message={p.error} onPrimary={p.onRefresh} primaryLabel="再試行" />;
  if (p.loading && !p.overview) return <div style={{ display: "flex", flexDirection: "column", gap: 10 }}><SkeletonBlock height={70} label="記録を読み込み中" /><SkeletonBlock height={160} label="集計を読み込み中" /></div>;
  if (p.noData && p.statusPending) return <div style={noteStyle}>インデックス状態を確認中です。</div>;
  if (p.noData) return <EmptyState kind={p.neverIndexed ? "not-indexed" : "no-data"} onPrimary={p.onStartIndex} busy={p.running} />;

  return <>
    <Section title="トータル" subtitle="コスト相当ではなく、実際に処理した量で並べています。">
      {p.usageError ? <EmptyState kind="error" message={p.usageError} onPrimary={p.onRetryUsage} /> : !usageReady ? (p.usageLoading ? <SkeletonBlock height={220} label="集計を読み込み中" /> : <EmptyState kind="no-data" />) : <><ButtonGroup ariaLabel="指標" roleLabel="指標" value={p.metric} onChange={p.onMetric} options={USAGE_METRICS.map((entry) => ({ value: entry.id, label: entry.label, title: entry.hint }))} /><div style={{ marginTop: 12 }}><UsageTotals report={p.series!} metric={p.metric} /></div></>}
    </Section>
    {usageReady ? <Section title={isStackable(p.metric) ? `日別 × ${groupingLabel}別` : "日別 (ターン数)"} subtitle="棒をクリックするとその日だけに期間を絞れます。">
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}><ButtonGroup ariaLabel="単位" roleLabel="単位" value={p.bucket} onChange={p.onBucket} options={[{ value: "day", label: "日" }, { value: "week", label: "週" }, { value: "month", label: "月" }]} /><ButtonGroup ariaLabel="表示" roleLabel="表示" value={p.stack} onChange={p.onStack} options={[{ value: "absolute", label: "実数" }, { value: "share", label: "構成比" }]} /><ButtonGroup ariaLabel="まとめ方" roleLabel="まとめ方" value={p.granularity} onChange={p.onGranularity} options={[{ value: "provider", label: "会社" }, { value: "family", label: "系統" }, { value: "raw", label: "モデル" }]} /></div>
      {model ? <UsageDailyChart model={model} metric={isStackable(p.metric) ? p.metric : "turns"} mode={p.stack} highlight={highlight} onHighlight={setHighlight} onPickDay={p.onPickDay} onOpenDigest={p.onOpenDigest} digestLinkLabel="日別へ" groupBy={p.series!.groupBy} /> : null}
    </Section> : null}
    {p.overview ? <SummaryCards overview={p.overview} preset={p.preset} /> : null}
    <Section title="案件別">
      {p.selection?.type === "project" ? <button type="button" onClick={() => p.onSelect(null)} style={clearFilterStyle}>{`絞り込み中: ${p.selection.label} ×`}</button> : null}
      {p.breakdownError ? <EmptyState kind="error" message={p.breakdownError} onPrimary={p.onRefreshBreakdown} /> : p.breakdown ? <ProjectTable report={p.breakdown} overview={p.overview!} selection={p.selection} onSelect={p.onSelect} dimensionLabel={({ project: "案件", branch: "ブランチ", effort: "effort", origin: "起動元", title: "主題", agent: "エージェント" })[p.breakdownDimension]} projectMode={p.breakdownDimension === "project"} /> : p.breakdownLoading ? <SkeletonBlock height={120} label="更新中…" /> : null}
    </Section>
    <Section title="セッション一覧">{p.sessions ? <SessionTable report={p.sessions} sort={p.sessionSort} onSort={p.onSessionSort} page={p.sessionPage} onPage={p.onSessionPage} pageSize={SESSION_PAGE_SIZE} onOpenDetail={p.onOpenDetail} activeKey={p.detailKey} priceCoverage={p.overview?.priceCoverage} /> : null}</Section>
    <DeferredDetails summary="稼働リズム">{p.rhythm ? <UsageRhythm report={p.rhythm} metric={p.metric} /> : null}</DeferredDetails>
    <DeferredDetails summary="モデル表">{p.series ? <UsageModelTable report={p.series} metric={p.metric} excludeSynthetic={p.excludeSynthetic} /> : null}</DeferredDetails>
    <DeferredDetails summary="内訳の次元"><ButtonGroup ariaLabel="内訳" value={p.breakdownDimension} onChange={p.onBreakdownDimension} options={[{ value: "project", label: "案件" }, { value: "branch", label: "ブランチ" }, { value: "effort", label: "effort" }, { value: "origin", label: "起動元" }, { value: "title", label: "主題" }, { value: "agent", label: "エージェント" }]} /></DeferredDetails>
  </>;
});

RecordView.displayName = "RecordView";

const clearFilterStyle = { alignSelf: "flex-start", border: "1px solid var(--cmux-accent)", borderRadius: 999, background: "var(--cmux-hover)", color: "var(--cmux-accent)", padding: "2px 9px", fontSize: "var(--cmux-font-size-xs)", cursor: "pointer" };
