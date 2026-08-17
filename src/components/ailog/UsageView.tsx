import { memo, useMemo, useState } from "react";

import type { BreakdownReport, Overview, PivotAxis, PivotReport, RangePreset, SeriesGroupBy, SeriesReport, SessionsReport, UsageBucket, UsageRhythmReport } from "../../lib/ailog";
import type { AilogSelection, BreakdownDimension, SessionSort } from "../../stores/ailogStore";
import { SESSION_PAGE_SIZE } from "../../stores/ailogStore";
import { CrossTable } from "./CrossTable";
import { ProjectTable } from "./ProjectTable";
import { SessionTable } from "./SessionTable";
import { SummaryCards } from "./SummaryCards";
import { UsageBucketChart } from "./UsageBucketChart";
import { UsageModelTable } from "./UsageModelTable";
import { UsageRhythm } from "./UsageRhythm";
import { UsageTotals } from "./UsageTotals";
import { bucketNoun, buildUsageModel, groupByLabel, isStackable, rhythmMetricOf, USAGE_METRICS, type UsageMetric } from "./usageModel";
import { ButtonGroup, DeferredDetails, EmptyState, Section, SkeletonBlock, noteStyle } from "./ui";

type DetailTab = "rhythm" | "models" | "dimension";

export const UsageView = memo(function UsageView(props: {
  overview: Overview | null; sessions: SessionsReport | null; series: SeriesReport | null; rhythm: UsageRhythmReport | null;
  loading: boolean; usageLoading: boolean; usageError: string | null; error: string | null; statusPending: boolean; neverIndexed: boolean; noData: boolean; running: boolean;
  preset: RangePreset; metric: UsageMetric; stack: "absolute" | "share"; bucket: UsageBucket; seriesAxis: SeriesGroupBy; excludeSynthetic: boolean;
  selection: AilogSelection | null; breakdownDimension: BreakdownDimension; breakdown: BreakdownReport | null; breakdownError: string | null; breakdownLoading: boolean; sessionSort: SessionSort; sessionPage: number;
  pivot: PivotReport | null; pivotRowBy: PivotAxis; pivotColBy: PivotAxis; pivotLoading: boolean; pivotError: string | null;
  detailKey: { kind: string; sessionId: string } | null;
  onRefresh: () => void; onRetryUsage: () => void; onStartIndex: () => void; onMetric: (metric: UsageMetric) => void; onStack: (stack: "absolute" | "share") => void; onBucket: (bucket: UsageBucket) => void; onSeriesAxis: (value: SeriesGroupBy) => void;
  onPickDay: (day: number) => void; onSelect: (selection: AilogSelection | null) => void; onBreakdownDimension: (value: BreakdownDimension) => void; onRefreshBreakdown: () => void; onPivotRowBy: (value: PivotAxis) => void; onPivotColBy: (value: PivotAxis) => void; onRetryPivot: () => void; onSessionSort: (value: SessionSort) => void; onSessionPage: (value: number) => void; onOpenDetail: (kind: string, sessionId: string) => void;
}) {
  const p = props;
  const [highlight, setHighlight] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("rhythm");
  const model = useMemo(() => p.series ? buildUsageModel(p.series.buckets, p.metric, undefined, p.bucket) : null, [p.series, p.metric, p.bucket]);
  const groupingLabel = groupByLabel(p.series?.groupBy ?? p.seriesAxis);
  const unit = bucketNoun(p.bucket);
  const usageReady = Boolean(p.series && p.rhythm);

  if (p.error) return <EmptyState kind="error" message={p.error} onPrimary={p.onRefresh} primaryLabel="再試行" />;
  if (p.loading && !p.overview) return <div style={{ display: "flex", flexDirection: "column", gap: 10 }}><SkeletonBlock height={70} label="記録を読み込み中" /><SkeletonBlock height={160} label="集計を読み込み中" /></div>;
  if (p.noData && p.statusPending) return <div style={noteStyle}>インデックス状態を確認中です。</div>;
  if (p.noData) return <EmptyState kind={p.neverIndexed ? "not-indexed" : "no-data"} onPrimary={p.onStartIndex} busy={p.running} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(260px, 0.8fr)", gap: 12, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          {usageReady ? (
            <Section title={isStackable(p.metric) ? `${unit}別 × ${groupingLabel}別` : `${unit}別 (ターン数)`} subtitle="棒をクリックするとその日だけに期間を絞れます。">
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                <ButtonGroup ariaLabel="単位" roleLabel="単位" value={p.bucket} onChange={p.onBucket} options={[{ value: "day", label: "日" }, { value: "week", label: "週" }, { value: "month", label: "月" }]} />
                <ButtonGroup ariaLabel="表示" roleLabel="表示" value={p.stack} onChange={p.onStack} options={[{ value: "absolute", label: "実数" }, { value: "share", label: "構成比" }]} />
                <ButtonGroup ariaLabel="まとめ方" roleLabel="まとめ方" value={p.seriesAxis} onChange={p.onSeriesAxis} options={[{ value: "provider", label: "会社" }, { value: "model", label: "系統" }, { value: "model_raw", label: "モデル" }, { value: "project", label: "案件" }]} />
              </div>
              {model ? <UsageBucketChart model={model} metric={isStackable(p.metric) ? p.metric : "turns"} mode={p.stack} highlight={highlight} onHighlight={setHighlight} onPickDay={p.onPickDay} groupBy={p.series!.groupBy} bucket={p.bucket} priceCoverage={p.series!.priceCoverage} /> : null}
            </Section>
          ) : p.usageError ? (
            <EmptyState kind="error" message={p.usageError} onPrimary={p.onRetryUsage} />
          ) : p.usageLoading ? (
            <SkeletonBlock height={220} label="集計を読み込み中" />
          ) : (
            <EmptyState kind="no-data" />
          )}
          <Section title="クロス集計" subtitle="時間を外して、2つの軸で積み替えた表です。">
            {p.pivotLoading && !p.pivot ? (
              <SkeletonBlock height={180} label="クロス集計を読み込み中" />
            ) : (
              <CrossTable
                report={p.pivot}
                metric={p.metric}
                rowBy={p.pivotRowBy}
                colBy={p.pivotColBy}
                loading={p.pivotLoading}
                error={p.pivotError}
                selection={p.selection}
                onRetry={p.onRetryPivot}
                onRowBy={p.onPivotRowBy}
                onColBy={p.onPivotColBy}
                onSelect={p.onSelect}
              />
            )}
          </Section>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <Section title="トータル" subtitle={p.metric === "costUsd" ? "単価既知分のみの推計です。請求額ではありません。" : "コスト相当ではなく、実際に処理した量で並べています。"}>
            {p.usageError ? <EmptyState kind="error" message={p.usageError} onPrimary={p.onRetryUsage} /> : !usageReady ? (p.usageLoading ? <SkeletonBlock height={120} label="集計を読み込み中" /> : <EmptyState kind="no-data" />) : (
              <>
                <ButtonGroup ariaLabel="指標" roleLabel="指標" value={p.metric} onChange={p.onMetric} options={USAGE_METRICS.map((entry) => ({ value: entry.id, label: entry.label, title: entry.hint }))} />
                <div style={{ marginTop: 12 }}><UsageTotals report={p.series!} metric={p.metric} /></div>
              </>
            )}
          </Section>
          {p.overview ? <SummaryCards overview={p.overview} preset={p.preset} /> : null}
          <Section title="案件別">
            {p.selection?.type === "project" ? <button type="button" onClick={() => p.onSelect(null)} style={clearFilterStyle}>{`絞り込み中: ${p.selection.label} ×`}</button> : null}
            {p.breakdownError ? <EmptyState kind="error" message={p.breakdownError} onPrimary={p.onRefreshBreakdown} /> : p.breakdown ? <ProjectTable report={p.breakdown} overview={p.overview!} selection={p.selection} onSelect={p.onSelect} dimensionLabel={({ project: "案件", branch: "ブランチ", effort: "effort", origin: "起動元", title: "主題", agent: "エージェント" })[p.breakdownDimension]} projectMode={p.breakdownDimension === "project"} /> : p.breakdownLoading ? <SkeletonBlock height={120} label="更新中…" /> : null}
          </Section>
        </div>
      </div>
      <Section title="セッション一覧">{p.sessions ? <SessionTable report={p.sessions} sort={p.sessionSort} onSort={p.onSessionSort} page={p.sessionPage} onPage={p.onSessionPage} pageSize={SESSION_PAGE_SIZE} onOpenDetail={p.onOpenDetail} activeKey={p.detailKey} priceCoverage={p.overview?.priceCoverage} /> : null}</Section>
      <DeferredDetails summary="詳細">
        <div style={{ marginBottom: 10 }}>
          <ButtonGroup
            ariaLabel="詳細"
            value={detailTab}
            onChange={setDetailTab}
            options={[
              { value: "rhythm", label: "稼働リズム" },
              { value: "models", label: "モデル表" },
              { value: "dimension", label: "内訳の次元" },
            ]}
          />
        </div>
        {detailTab === "rhythm" ? (p.rhythm ? <UsageRhythm report={p.rhythm} metric={rhythmMetricOf(p.metric)} /> : null) : null}
        {detailTab === "models" ? (p.series ? <UsageModelTable report={p.series} metric={p.metric} excludeSynthetic={p.excludeSynthetic} /> : null) : null}
        {detailTab === "dimension" ? (
          <ButtonGroup ariaLabel="内訳" value={p.breakdownDimension} onChange={p.onBreakdownDimension} options={[{ value: "project", label: "案件" }, { value: "branch", label: "ブランチ" }, { value: "effort", label: "effort" }, { value: "origin", label: "起動元" }, { value: "title", label: "主題" }, { value: "agent", label: "エージェント" }]} />
        ) : null}
      </DeferredDetails>
    </div>
  );
});

UsageView.displayName = "UsageView";

const clearFilterStyle = { alignSelf: "flex-start", border: "1px solid var(--cmux-accent)", borderRadius: 999, background: "var(--cmux-hover)", color: "var(--cmux-accent)", padding: "2px 9px", fontSize: "var(--cmux-font-size-xs)", cursor: "pointer" };
