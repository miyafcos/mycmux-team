import { memo, useMemo, useState } from "react";

import type { BreakdownReport, ModelsReport, Overview, PivotAxis, PivotReport, RangePreset, SeriesGroupBy, SeriesReport, SessionsReport, UsageBucket, UsageRhythmReport } from "../../lib/ailog";
import type { AilogSelection, BreakdownDimension, SessionSort } from "../../stores/ailogStore";
import { SESSION_PAGE_SIZE, useAilogStore } from "../../stores/ailogStore";
import { CrossTable } from "./CrossTable";
import { AilogOrientation } from "./AilogOrientation";
import { ProjectTable } from "./ProjectTable";
import { SessionTable } from "./SessionTable";
import { SummaryCards } from "./SummaryCards";
import { UsageBucketChart } from "./UsageBucketChart";
import { UsageModelTable } from "./UsageModelTable";
import { UsageRhythm } from "./UsageRhythm";
import { ReworkRankings } from "./ReworkRankings";
import { UsageTotals } from "./UsageTotals";
import { WorkTagTable } from "./WorkTagTable";
import { HANDOFF_SECTION_SUMMARY, HandoffTable } from "./HandoffTable";
import { bucketNoun, buildUsageModel, groupByLabel, isStackable, rhythmMetricOf, SERIES_AXES, USAGE_METRICS, usageMetricInfo, type UsageMetric } from "./usageModel";
import { ButtonGroup, DeferredDetails, EmptyState, Section, SkeletonBlock, noteStyle } from "./ui";

export const UsageView = memo(function UsageView(props: {
  overview: Overview | null; previousTotalsStatus: "idle" | "loading" | "ready" | "error"; models: ModelsReport | null; sessions: SessionsReport | null; series: SeriesReport | null; rhythm: UsageRhythmReport | null;
  loading: boolean; usageLoading: boolean; usageError: string | null; error: string | null; statusPending: boolean; neverIndexed: boolean; noData: boolean; running: boolean;
  preset: RangePreset; metric: UsageMetric; stack: "absolute" | "share"; bucket: UsageBucket; seriesAxis: SeriesGroupBy; excludeSynthetic: boolean;
  selection: AilogSelection | null; breakdownDimension: BreakdownDimension; breakdown: BreakdownReport | null; breakdownError: string | null; breakdownLoading: boolean; sessionSort: SessionSort; sessionPage: number;
  sessionQuery: string; sessionAppliedQuery: string; sessionAppliedSort: SessionSort; sessionAppliedPage: number; sessionLoading: boolean; sessionError: string | null;
  pivot: PivotReport | null; pivotRowBy: PivotAxis; pivotColBy: PivotAxis; pivotLoading: boolean; pivotError: string | null;
  detailKey: { kind: string; sessionId: string } | null;
  onRefresh: () => void; onRetryUsage: () => void; onStartIndex: () => void; onMetric: (metric: UsageMetric) => void; onStack: (stack: "absolute" | "share") => void; onBucket: (bucket: UsageBucket) => void; onSeriesAxis: (value: SeriesGroupBy) => void;
  onPickDay: (day: number) => void; onSelect: (selection: AilogSelection | null) => void; onBreakdownDimension: (value: BreakdownDimension) => void; onRefreshBreakdown: () => void; onPivotRowBy: (value: PivotAxis) => void; onPivotColBy: (value: PivotAxis) => void; onRetryPivot: () => void; onSessionSort: (value: SessionSort) => void; onSessionPage: (value: number) => void; onSessionQuery: (value: string) => void; onRetrySessions: () => void; onOpenDetail: (kind: string, sessionId: string) => void;
}) {
  const p = props;
  const [highlight, setHighlight] = useState<string | null>(null);
  const model = useMemo(() => p.series ? buildUsageModel(p.series.buckets, p.metric, undefined, p.bucket, p.series.groupBy) : null, [p.series, p.metric, p.bucket]);
  const groupingLabel = groupByLabel(p.series?.groupBy ?? p.seriesAxis);
  const unit = bucketNoun(p.bucket);
  const seriesMatchesOverview = Boolean(p.series && p.overview
    && p.series.range.from === p.overview.range.from
    && p.series.range.to === p.overview.range.to);
  const usageReady = Boolean(p.series && p.rhythm && seriesMatchesOverview && !p.usageLoading && !p.usageError);
  const projectSel = p.selection?.project;
  const modelSel = p.selection?.model;
  const previousTotals = useAilogStore((state) => state.previousTotals);
  const breakdownLabel = ({ project: "案件", branch: "ブランチ", effort: "推論の深さ", origin: "起動元", title: "主題", agent: "エージェント" } as const)[p.breakdownDimension];
  const rhythmMetric = rhythmMetricOf(p.metric);
  const breakdownMatchesOverview = Boolean(p.breakdown && p.overview
    && p.breakdown.range.from === p.overview.range.from
    && p.breakdown.range.to === p.overview.range.to
    && p.breakdown.dimension === p.breakdownDimension);
  const pivotMatchesOverview = Boolean(p.pivot && p.overview
    && p.pivot.range.from === p.overview.range.from
    && p.pivot.range.to === p.overview.range.to
    && p.pivot.rowBy === p.pivotRowBy
    && p.pivot.colBy === p.pivotColBy);

  if (p.error && !p.overview && !usageReady) return <EmptyState kind="error" message={p.error} onPrimary={p.onRefresh} primaryLabel="再試行" />;
  if (p.loading && !p.overview) return <div style={{ display: "flex", flexDirection: "column", gap: 10 }}><SkeletonBlock height={70} label="記録を読み込み中" /><SkeletonBlock height={160} label="集計を読み込み中" /></div>;
  if (p.noData && p.statusPending) return <div style={noteStyle}>インデックス状態を確認中です。</div>;
  if (p.noData && !p.selection) return <EmptyState kind={p.neverIndexed ? "not-indexed" : "no-data"} onPrimary={p.onStartIndex} busy={p.running} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {p.error ? <div role="alert" style={{ ...noteStyle, color: "var(--cmux-red)" }}>一部の集計を更新できませんでした。直前の値を表示しています。<details><summary>技術情報</summary>{p.error}</details></div> : null}
      {p.overview ? <AilogOrientation overview={p.overview} series={usageReady ? p.series : null} sessions={p.sessions} sessionLoading={p.sessionLoading} sessionError={p.sessionError} metric={p.metric} preset={p.preset} previousTotals={previousTotals} previousTotalsStatus={p.previousTotalsStatus} breakdownLabel={breakdownLabel} running={p.running} onStartIndex={p.onStartIndex} onOpenDetail={p.onOpenDetail} /> : null}
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
      {p.noData && p.selection ? (
        <EmptyState
          kind="no-data"
          title="絞り込みに一致する記録なし"
          message="選択中の絞り込みを解除するか、期間を広げてください。"
          onPrimary={() => p.onSelect(null)}
          primaryLabel="絞り込みを解除"
        />
      ) : null}
      <Section id="ailog-overview" title="この期間" subtitle={p.metric === "costUsd" ? "この期間の記録と前期間からの変化です。価格情報のある記録から計算した参考値で、請求額ではありません。円額は設定した為替レートでの換算です。" : "この期間の記録と前期間からの変化です。コスト相当ではなく、実際に処理した量で並べています。"}>
        {p.usageError ? <EmptyState kind="error" message={p.usageError} onPrimary={p.onRetryUsage} /> : !usageReady ? (p.usageLoading ? <SkeletonBlock height={120} label="集計を読み込み中" /> : <EmptyState kind="no-data" />) : (
          <>
            <ButtonGroup ariaLabel="指標" roleLabel="指標" value={p.metric} onChange={p.onMetric} options={USAGE_METRICS.map((entry) => ({ value: entry.id, label: entry.label, title: entry.hint }))} />
            <div style={{ marginTop: 12 }}><UsageTotals report={p.series!} metric={p.metric} preset={p.preset} totals={p.overview!.totals} previousTotals={previousTotals} turnFilterActive={Boolean(modelSel)} /></div>
          </>
        )}
        {p.overview && !modelSel ? <div style={{ marginTop: 12 }}><SummaryCards overview={p.overview} preset={p.preset} /></div> : null}
      </Section>
      <Section id="ailog-purpose" title="何に使ったか" subtitle="探索・実装・デバッグなど、作業の種類ごとのコストです。">
        {p.models?.byWorkTag && p.models.byWorkTag.length > 0 ? (
          <WorkTagTable report={p.models} />
        ) : p.loading && !p.models ? (
          <SkeletonBlock height={120} label="作業種別を読み込み中" />
        ) : (
          <EmptyState kind="no-data" />
        )}
      </Section>
      <DeferredDetails id="ailog-learning" summary="つまずいた場所">
        <ReworkRankings />
      </DeferredDetails>
      <DeferredDetails id="ailog-handoffs" summary={HANDOFF_SECTION_SUMMARY} subtitle="同じセッションの中で、続けて別のモデルに切り替わった回数です。回数を数えているだけで、切り替えが良かったかどうかは判定していません。">
        <HandoffTable />
      </DeferredDetails>
      <Section id="ailog-trend" title="推移" subtitle={`${unit}別 × ${groupingLabel}別。期間の棒を選ぶと、その期間だけに絞れます。`}>
        {usageReady ? (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <ButtonGroup ariaLabel="単位" roleLabel="単位" value={p.bucket} onChange={p.onBucket} options={[{ value: "day", label: "日" }, { value: "week", label: "週" }, { value: "month", label: "月" }]} />
              <ButtonGroup ariaLabel="表示" roleLabel="表示" value={p.stack} onChange={p.onStack} options={[{ value: "absolute", label: "実数" }, { value: "share", label: "構成比" }]} />
              <ButtonGroup ariaLabel="まとめ方" roleLabel="まとめ方" value={p.seriesAxis} onChange={p.onSeriesAxis} options={SERIES_AXES.map((axis) => ({ value: axis.value, label: axis.label, title: axis.hint }))} />
            </div>
            {model && isStackable(p.metric) ? <UsageBucketChart model={model} metric={p.metric} mode={p.stack} highlight={highlight} onHighlight={setHighlight} onPickDay={p.onPickDay} groupBy={p.series!.groupBy} bucket={p.bucket} priceCoverage={p.series!.priceCoverage} /> : <div style={noteStyle}>セッション数は分類間で重複するため、この積み上げグラフでは表示しません。分類別の値は下の内訳表で確認できます。</div>}
          </>
        ) : p.usageError ? (
          <EmptyState kind="error" message={p.usageError} onPrimary={p.onRetryUsage} />
        ) : p.usageLoading ? (
          <SkeletonBlock height={220} label="集計を読み込み中" />
        ) : (
          <EmptyState kind="no-data" />
        )}
      </Section>
      <Section id="ailog-compare" title={`${groupingLabel}別`} subtitle="選んだ分類ごとの内訳です。">
        {p.usageError ? (
          <EmptyState kind="error" message={p.usageError} onPrimary={p.onRetryUsage} />
        ) : p.series && seriesMatchesOverview && !p.usageLoading ? (
          <UsageModelTable report={p.series} metric={p.metric} excludeSynthetic={p.excludeSynthetic} selection={p.selection} onSelect={p.onSelect} />
        ) : p.usageLoading ? (
          <SkeletonBlock height={160} label="集計を読み込み中" />
        ) : (
          <EmptyState kind="no-data" />
        )}
      </Section>
      <Section id="ailog-cross" title="2つの切り口で比較" subtitle="時間を外して、2つの軸で積み替えた表です。">
        {p.pivotLoading && !p.pivot ? (
          <SkeletonBlock height={180} label="クロス集計を読み込み中" />
        ) : (
          <CrossTable
            report={pivotMatchesOverview ? p.pivot : null}
            metric={p.metric}
            rowBy={p.pivotRowBy}
            colBy={p.pivotColBy}
            loading={p.pivotLoading || Boolean(p.pivot && !pivotMatchesOverview)}
            error={p.pivotError}
            selection={p.selection}
            onRetry={p.onRetryPivot}
            onRowBy={p.onPivotRowBy}
            onColBy={p.onPivotColBy}
            onSelect={p.onSelect}
          />
        )}
      </Section>
      <Section id="ailog-projects" title={`${breakdownLabel}別`} subtitle="内訳の軸を切り替えて比較できます。">
        <div style={{ marginBottom: 10 }}>
          <ButtonGroup ariaLabel="内訳" roleLabel="内訳" value={p.breakdownDimension} onChange={p.onBreakdownDimension} options={[{ value: "project", label: "案件" }, { value: "branch", label: "ブランチ" }, { value: "effort", label: "推論の深さ" }, { value: "origin", label: "起動元" }, { value: "title", label: "主題" }, { value: "agent", label: "エージェント" }]} />
        </div>
        {p.breakdownError ? <EmptyState kind="error" message={p.breakdownError} onPrimary={p.onRefreshBreakdown} /> : breakdownMatchesOverview ? <ProjectTable report={p.breakdown!} overview={p.overview!} selection={p.selection} onSelect={p.onSelect} dimensionLabel={breakdownLabel} projectMode={p.breakdownDimension === "project"} /> : p.breakdownLoading || p.breakdown ? <SkeletonBlock height={120} label="内訳を更新中" /> : null}
      </Section>
      <Section id="ailog-sessions" title="セッション一覧" subtitle="検索と並び替えは、この一覧だけを更新します。概要やグラフはそのまま残ります。">{p.sessions ? <SessionTable report={p.sessions} sort={p.sessionSort} appliedSort={p.sessionAppliedSort} onSort={p.onSessionSort} page={p.sessionPage} appliedPage={p.sessionAppliedPage} onPage={p.onSessionPage} pageSize={SESSION_PAGE_SIZE} onOpenDetail={p.onOpenDetail} activeKey={p.detailKey} query={p.sessionQuery} appliedQuery={p.sessionAppliedQuery} onQuery={p.onSessionQuery} onRetry={p.onRetrySessions} loading={p.sessionLoading} error={p.sessionError} modelFilterActive={Boolean(modelSel)} /> : null}</Section>
      <DeferredDetails summary={`稼働リズム（${usageMetricInfo(rhythmMetric).label}）`} subtitle={`${rhythmMetric !== p.metric ? `選択中の「${usageMetricInfo(p.metric).label}」は稼働リズム未対応のため、入出力トークンを表示します。` : ""}選択中の期間と絞り込みに追随します。稼働日の分母だけは、期間内の最初の記録日から最後の記録日までです。`}>
        {p.rhythm ? <UsageRhythm report={p.rhythm} metric={rhythmMetric} /> : null}
      </DeferredDetails>
    </div>
  );
});

UsageView.displayName = "UsageView";

const clearFilterStyle = { alignSelf: "flex-start", border: "1px solid var(--cmux-accent)", borderRadius: 999, background: "var(--cmux-hover)", color: "var(--cmux-accent)", padding: "2px 9px", fontSize: "var(--cmux-font-size-xs)", cursor: "pointer" };
