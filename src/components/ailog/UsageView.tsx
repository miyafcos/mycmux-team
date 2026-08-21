import { memo, useMemo, useState } from "react";

import type { BreakdownReport, ModelsReport, Overview, PivotAxis, PivotReport, RangePreset, SeriesGroupBy, SeriesReport, SessionsReport, UsageBucket, UsageRhythmReport } from "../../lib/ailog";
import type { AilogSelection, BreakdownDimension, SessionSort } from "../../stores/ailogStore";
import { SESSION_PAGE_SIZE, useAilogStore } from "../../stores/ailogStore";
import { CrossTable } from "./CrossTable";
import { ProjectTable } from "./ProjectTable";
import { SessionTable } from "./SessionTable";
import { SummaryCards } from "./SummaryCards";
import { UsageBucketChart } from "./UsageBucketChart";
import { UsageModelTable } from "./UsageModelTable";
import { UsageRhythm } from "./UsageRhythm";
import { ReworkRankings } from "./ReworkRankings";
import { UsageTotals } from "./UsageTotals";
import { WorkTagTable } from "./WorkTagTable";
import { bucketNoun, buildUsageModel, groupByLabel, isStackable, rhythmMetricOf, SERIES_AXES, USAGE_METRICS, type UsageMetric } from "./usageModel";
import { ButtonGroup, DeferredDetails, EmptyState, Section, SkeletonBlock, noteStyle } from "./ui";

export const UsageView = memo(function UsageView(props: {
  overview: Overview | null; models: ModelsReport | null; sessions: SessionsReport | null; series: SeriesReport | null; rhythm: UsageRhythmReport | null;
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
  const model = useMemo(() => p.series ? buildUsageModel(p.series.buckets, p.metric, undefined, p.bucket, p.series.groupBy) : null, [p.series, p.metric, p.bucket]);
  const groupingLabel = groupByLabel(p.series?.groupBy ?? p.seriesAxis);
  const unit = bucketNoun(p.bucket);
  const usageReady = Boolean(p.series && p.rhythm);
  const projectSel = p.selection?.project;
  const modelSel = p.selection?.model;
  const previousTotals = useAilogStore((state) => state.previousTotals);

  if (p.error) return <EmptyState kind="error" message={p.error} onPrimary={p.onRefresh} primaryLabel="再試行" />;
  if (p.loading && !p.overview) return <div style={{ display: "flex", flexDirection: "column", gap: 10 }}><SkeletonBlock height={70} label="記録を読み込み中" /><SkeletonBlock height={160} label="集計を読み込み中" /></div>;
  if (p.noData && p.statusPending) return <div style={noteStyle}>インデックス状態を確認中です。</div>;
  if (p.noData) return <EmptyState kind={p.neverIndexed ? "not-indexed" : "no-data"} onPrimary={p.onStartIndex} busy={p.running} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {projectSel || modelSel ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {projectSel ? (
            <button type="button" onClick={() => p.onSelect(modelSel ? { model: modelSel } : null)} style={clearFilterStyle}>{`案件: ${projectSel.label} ×`}</button>
          ) : null}
          {modelSel ? (
            <button type="button" onClick={() => p.onSelect(projectSel ? { project: projectSel } : null)} style={clearFilterStyle}>{`モデル: ${modelSel.label} ×`}</button>
          ) : null}
        </div>
      ) : null}
      <Section title="この期間" subtitle={p.metric === "costUsd" ? "この期間の記録と前期間からの変化です。単価既知分のみの推計で、請求額ではありません。" : "この期間の記録と前期間からの変化です。コスト相当ではなく、実際に処理した量で並べています。"}>
        {p.usageError ? <EmptyState kind="error" message={p.usageError} onPrimary={p.onRetryUsage} /> : !usageReady ? (p.usageLoading ? <SkeletonBlock height={120} label="集計を読み込み中" /> : <EmptyState kind="no-data" />) : (
          <>
            <ButtonGroup ariaLabel="指標" roleLabel="指標" value={p.metric} onChange={p.onMetric} options={USAGE_METRICS.map((entry) => ({ value: entry.id, label: entry.label, title: entry.hint }))} />
            <div style={{ marginTop: 12 }}><UsageTotals report={p.series!} metric={p.metric} comparePrevious={p.overview?.comparePrevious ?? null} preset={p.preset} totals={p.overview!.totals} previousTotals={previousTotals} /></div>
          </>
        )}
        {p.overview ? <div style={{ marginTop: 12 }}><SummaryCards overview={p.overview} preset={p.preset} /></div> : null}
      </Section>
      <Section title="何に使ったか" subtitle="探索・実装・デバッグなど、作業の種類ごとのコストです。">
        {p.models?.byWorkTag && p.models.byWorkTag.length > 0 ? (
          <WorkTagTable report={p.models} />
        ) : p.loading && !p.models ? (
          <SkeletonBlock height={120} label="作業種別を読み込み中" />
        ) : (
          <EmptyState kind="no-data" />
        )}
      </Section>
      <DeferredDetails summary="つまずいた場所">
        <ReworkRankings />
      </DeferredDetails>
      <Section title="推移" subtitle={`${unit}別 × ${groupingLabel}別。棒をクリックするとその日だけに期間を絞れます。`}>
        {usageReady ? (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <ButtonGroup ariaLabel="単位" roleLabel="単位" value={p.bucket} onChange={p.onBucket} options={[{ value: "day", label: "日" }, { value: "week", label: "週" }, { value: "month", label: "月" }]} />
              <ButtonGroup ariaLabel="表示" roleLabel="表示" value={p.stack} onChange={p.onStack} options={[{ value: "absolute", label: "実数" }, { value: "share", label: "構成比" }]} />
              <ButtonGroup ariaLabel="まとめ方" roleLabel="まとめ方" value={p.seriesAxis} onChange={p.onSeriesAxis} options={SERIES_AXES.map((axis) => ({ value: axis.value, label: axis.label, title: axis.hint }))} />
            </div>
            {model ? <UsageBucketChart model={model} metric={isStackable(p.metric) ? p.metric : "turns"} mode={p.stack} highlight={highlight} onHighlight={setHighlight} onPickDay={p.onPickDay} groupBy={p.series!.groupBy} bucket={p.bucket} priceCoverage={p.series!.priceCoverage} /> : null}
          </>
        ) : p.usageError ? (
          <EmptyState kind="error" message={p.usageError} onPrimary={p.onRetryUsage} />
        ) : p.usageLoading ? (
          <SkeletonBlock height={220} label="集計を読み込み中" />
        ) : (
          <EmptyState kind="no-data" />
        )}
      </Section>
      <Section title="モデル別" subtitle="選んだ分類ごとの内訳です。">
        {p.usageError ? (
          <EmptyState kind="error" message={p.usageError} onPrimary={p.onRetryUsage} />
        ) : p.series ? (
          <UsageModelTable report={p.series} metric={p.metric} excludeSynthetic={p.excludeSynthetic} selection={p.selection} onSelect={p.onSelect} />
        ) : p.usageLoading ? (
          <SkeletonBlock height={160} label="集計を読み込み中" />
        ) : (
          <EmptyState kind="no-data" />
        )}
      </Section>
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
      <Section title="案件別" subtitle="内訳の軸を切り替えて比較できます。">
        <div style={{ marginBottom: 10 }}>
          <ButtonGroup ariaLabel="内訳" roleLabel="内訳" value={p.breakdownDimension} onChange={p.onBreakdownDimension} options={[{ value: "project", label: "案件" }, { value: "branch", label: "ブランチ" }, { value: "effort", label: "effort" }, { value: "origin", label: "起動元" }, { value: "title", label: "主題" }, { value: "agent", label: "エージェント" }]} />
        </div>
        {p.breakdownError ? <EmptyState kind="error" message={p.breakdownError} onPrimary={p.onRefreshBreakdown} /> : p.breakdown ? <ProjectTable report={p.breakdown} overview={p.overview!} selection={p.selection} onSelect={p.onSelect} dimensionLabel={({ project: "案件", branch: "ブランチ", effort: "effort", origin: "起動元", title: "主題", agent: "エージェント" })[p.breakdownDimension]} projectMode={p.breakdownDimension === "project"} /> : p.breakdownLoading ? <SkeletonBlock height={120} label="更新中…" /> : null}
      </Section>
      <Section title="セッション一覧" subtitle="並べ替えて確認できます。行をクリックすると中身を開きます。">{p.sessions ? <SessionTable report={p.sessions} sort={p.sessionSort} onSort={p.onSessionSort} page={p.sessionPage} onPage={p.onSessionPage} pageSize={SESSION_PAGE_SIZE} onOpenDetail={p.onOpenDetail} activeKey={p.detailKey} priceCoverage={p.overview?.priceCoverage} /> : null}</Section>
      <DeferredDetails summary="稼働リズム" subtitle="全期間の集計です（上の期間指定に追随しません）。">
        {p.rhythm ? <UsageRhythm report={p.rhythm} metric={rhythmMetricOf(p.metric)} /> : null}
      </DeferredDetails>
    </div>
  );
});

UsageView.displayName = "UsageView";

const clearFilterStyle = { alignSelf: "flex-start", border: "1px solid var(--cmux-accent)", borderRadius: 999, background: "var(--cmux-hover)", color: "var(--cmux-accent)", padding: "2px 9px", fontSize: "var(--cmux-font-size-xs)", cursor: "pointer" };
