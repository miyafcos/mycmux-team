import { useAgentServiceVisibility } from "../../hooks/useAgentServiceVisibility";
import { memo } from "react";

import type { BreakdownReport, ModelsReport, Overview, PivotAxis, PivotReport, RangePreset, SeriesGroupBy, SeriesReport, SessionsReport, UsageBucket, UsageRhythmReport } from "../../lib/ailog";
import type { AilogSelection, BreakdownDimension, SessionSort } from "../../stores/ailogStore";
import { SESSION_PAGE_SIZE, useAilogStore } from "../../stores/ailogStore";
import { CrossTable } from "./CrossTable";
import { AilogOrientation } from "./AilogOrientation";
import { AccountingNote } from "./AccountingNote";
import { ProjectTable } from "./ProjectTable";
import { SessionTable } from "./SessionTable";
import { SummaryCards } from "./SummaryCards";
import { UsageGrass } from "./UsageGrass";
import { UsageModelTable } from "./UsageModelTable";
import { UsageRhythmDetails } from "./UsageRhythmDetails";
import { ReworkRankings } from "./ReworkRankings";
import { previousPeriodLabel, UsageTotals } from "./UsageTotals";
import { ReportFailure, ReportNotLoaded, ReportPeriod } from "./ReportFeedback";
import { WorkTagTable } from "./WorkTagTable";
import { HANDOFF_SECTION_SUMMARY, HandoffTable } from "./HandoffTable";
import { groupByLabel, rhythmMetricOf, usageAxisHint, SERIES_AXES, USAGE_METRICS, usageMetricInfo, type UsageMetric } from "./usageModel";
import { ButtonGroup, DeferredDetails, EmptyState, Section, SkeletonBlock, noteStyle } from "./ui";

export const UsageView = memo(function UsageView(props: {
  overview: Overview | null; previousTotalsStatus: "idle" | "loading" | "ready" | "error"; models: ModelsReport | null; sessions: SessionsReport | null; series: SeriesReport | null; rhythm: UsageRhythmReport | null;
  modelsLoading: boolean; modelsError: string | null; onRetryModels: () => void;
  loading: boolean; usageLoading: boolean; usageError: string | null; error: string | null; statusPending: boolean; neverIndexed: boolean; noData: boolean; running: boolean;
  preset: RangePreset; metric: UsageMetric; bucket: UsageBucket; seriesAxis: SeriesGroupBy; excludeSynthetic: boolean;
  selection: AilogSelection | null; breakdownDimension: BreakdownDimension; breakdown: BreakdownReport | null; breakdownError: string | null; breakdownLoading: boolean; sessionSort: SessionSort; sessionPage: number;
  sessionQuery: string; sessionAppliedQuery: string; sessionAppliedSort: SessionSort; sessionAppliedPage: number; sessionLoading: boolean; sessionError: string | null;
  pivot: PivotReport | null; pivotRowBy: PivotAxis; pivotColBy: PivotAxis; pivotLoading: boolean; pivotError: string | null;
  detailKey: { kind: string; sessionId: string } | null;
  onRefresh: () => void; onRetryUsage: () => void; onStartIndex: () => void; onMetric: (metric: UsageMetric) => void; onSeriesAxis: (value: SeriesGroupBy) => void;
  onPickDay: (day: number) => void; onSelect: (selection: AilogSelection | null) => void; onBreakdownDimension: (value: BreakdownDimension) => void; onRefreshBreakdown: () => void; onPivotRowBy: (value: PivotAxis) => void; onPivotColBy: (value: PivotAxis) => void; onRetryPivot: () => void; onSessionSort: (value: SessionSort) => void; onSessionPage: (value: number) => void; onSessionQuery: (value: string) => void; onRetrySessions: () => void; onOpenDetail: (kind: string, sessionId: string) => void;
}) {
  const visible = useAgentServiceVisibility();
  const p = props;
  const groupingLabel = groupByLabel(p.series?.groupBy ?? p.seriesAxis);
  const seriesMatchesOverview = Boolean(p.series && p.overview
    && p.series.range.from === p.overview.range.from
    && p.series.range.to === p.overview.range.to);
  const usageReady = Boolean(p.series && p.series.groupBy === p.seriesAxis && p.series.bucket === p.bucket);
  const grassReady = usageReady && p.series?.bucket === "day";
  const projectSel = p.selection?.project;
  const modelSel = p.selection?.model;
  const previousTotals = useAilogStore((state) => state.previousTotals);
  const setExcludeSynthetic = useAilogStore((state) => state.setExcludeSynthetic);
  const breakdownLabel = ({ project: "案件", branch: "ブランチ", effort: "推論の深さ", origin: "起動元", title: "主題", agent: "エージェント" } as const)[p.breakdownDimension];
  const rhythmMetric = rhythmMetricOf(p.metric);
  const breakdown = p.breakdown?.dimension === p.breakdownDimension ? p.breakdown : null;
  const pivot = p.pivot?.rowBy === p.pivotRowBy && p.pivot.colBy === p.pivotColBy ? p.pivot : null;
  const breakdownOverview = breakdown && p.overview
    && breakdown.range.from === p.overview.range.from && breakdown.range.to === p.overview.range.to ? p.overview : null;
  const overviewSessions = p.sessions && p.overview
    && p.sessions.range.from === p.overview.range.from && p.sessions.range.to === p.overview.range.to ? p.sessions : null;
  const hasIndependentData = Boolean((usageReady && p.series?.buckets.length) || breakdown?.rows.length || pivot?.rows.length
    || p.models?.byWorkTag.length || p.sessions?.rows.length);

  return (
    <div aria-busy={p.loading || p.usageLoading} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {p.noData && p.statusPending ? <div style={noteStyle}>インデックス状態を確認中です。</div> : null}
      {p.noData && !p.statusPending && !p.selection && !hasIndependentData ? <><AccountingNote accounting={p.overview?.accounting} /><EmptyState kind={p.neverIndexed ? "not-indexed" : "no-data"} onPrimary={p.onStartIndex} busy={p.running} /></> : null}
      {p.overview ? <AilogOrientation overview={p.overview} series={usageReady && seriesMatchesOverview ? p.series : null} sessions={overviewSessions} sessionLoading={p.sessionLoading} sessionError={p.sessionError} metric={p.metric} preset={p.preset} previousTotals={previousTotals} previousTotalsStatus={p.previousTotalsStatus} breakdownLabel={breakdownLabel} running={p.running} onStartIndex={p.onStartIndex} onOpenDetail={p.onOpenDetail} /> : null}
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
      {p.noData && p.selection && !hasIndependentData ? (
        <EmptyState
          kind="no-data"
          title="絞り込みに一致する記録なし"
          message="選択中の絞り込みを解除するか、期間を広げてください。"
          onPrimary={() => p.onSelect(null)}
          primaryLabel="絞り込みを解除"
        />
      ) : null}
      <Section id="ailog-overview" title="この期間">
        {p.error ? <ReportFailure label="概要" error={p.error} range={p.overview?.range} onRetry={p.onRefresh} /> : null}
        {p.overview ? <ReportPeriod range={p.overview.range} /> : p.loading ? <SkeletonBlock height={70} label="概要を読み込み中" /> : !p.error ? <ReportNotLoaded label="概要" onLoad={p.onRefresh} /> : null}
        {!p.overview ? <div style={noteStyle}>概要を取得するまで、セッション総数は未取得です。</div> : null}
        {usageReady ? <ButtonGroup ariaLabel="指標" roleLabel="指標" value={p.metric} onChange={p.onMetric} options={USAGE_METRICS.map((entry) => ({ value: entry.id, label: entry.label, title: entry.hint }))} /> : null}
        {usageReady && p.series && p.overview && seriesMatchesOverview ? <div style={{ marginTop: 12 }}><UsageTotals report={p.series} metric={p.metric} preset={p.preset} totals={p.overview.totals} previousTotals={previousTotals} previousTotalsStatus={p.previousTotalsStatus} turnFilterActive={Boolean(modelSel)} /></div> : p.overview && usageReady ? <div style={noteStyle}>概要と日ごとの使用量の表示期間が異なるため、期間合計と前期間比は表示していません。</div> : null}
        {p.overview && !(usageReady && seriesMatchesOverview) && p.preset !== "all" && (p.previousTotalsStatus !== "ready" || previousTotals === null) ? <div style={noteStyle}>{previousPeriodLabel(p.metric, p.overview.totals, previousTotals, p.previousTotalsStatus, p.preset)}</div> : null}
        {p.overview ? <div style={{ marginTop: 12 }}><AccountingNote accounting={p.overview.accounting} /></div> : null}
        {p.overview && !modelSel ? <div style={{ marginTop: 12 }}><SummaryCards overview={p.overview} preset={p.preset} showCost={false} /></div> : null}
      </Section>
      <Section id="ailog-purpose" title="何に使ったか" subtitle="探索・実装・デバッグなど、作業の種類ごとのコストです。">
        {p.modelsError ? <ReportFailure label="作業種別" error={p.modelsError} range={p.models?.range} onRetry={p.onRetryModels} /> : null}
        {p.models ? <ReportPeriod range={p.models.range} /> : null}
        {p.models?.byWorkTag && p.models.byWorkTag.length > 0 ? (
          <WorkTagTable report={p.models} />
        ) : p.models ? <EmptyState kind="no-data" /> : p.modelsLoading ? (
          <SkeletonBlock height={120} label="作業種別を読み込み中" />
        ) : !p.modelsError ? <ReportNotLoaded label="作業種別" onLoad={p.onRetryModels} /> : null}
      </Section>
      <DeferredDetails id="ailog-learning" summary="つまずいた場所">
        <ReworkRankings />
      </DeferredDetails>
      <DeferredDetails id="ailog-handoffs" summary={HANDOFF_SECTION_SUMMARY} subtitle="同じセッションの中で、続けて別のモデルに切り替わった回数です。回数を数えているだけで、切り替えが良かったかどうかは判定していません。">
        <HandoffTable />
      </DeferredDetails>
      <Section id="ailog-trend" title="日ごとの使用量" subtitle="1 マスが 1 日です。マスを選ぶと、内訳がその日のものに切り替わります。">
        {grassReady && p.series ? <ReportPeriod range={p.series.range} /> : null}
        {p.usageError && grassReady ? <ReportFailure label="日ごとの使用量" error={p.usageError} range={p.series?.range} onRetry={p.onRetryUsage} /> : null}
        {grassReady && p.series ? (
          <>
            <div style={{ marginBottom: 16 }}>
              <ButtonGroup ariaLabel="まとめ方" roleLabel="まとめ方" value={p.seriesAxis} onChange={p.onSeriesAxis} options={SERIES_AXES.map((axis) => ({ value: axis.value, label: axis.label, title: usageAxisHint(axis, visible) }))} />
            </div>
            <UsageGrass report={p.series} metric={p.metric} onPickDay={p.onPickDay} />
          </>
        ) : p.usageError ? (
          <ReportFailure label="日ごとの使用量" error={p.usageError} onRetry={p.onRetryUsage} />
        ) : p.usageLoading ? (
          <SkeletonBlock height={220} label="日ごとの使用量を読み込み中" />
        ) : (
          <ReportNotLoaded label="日ごとの使用量" onLoad={p.onRetryUsage} />
        )}
      </Section>
      <Section id="ailog-compare" title={`${groupingLabel}別`} subtitle="選んだ分類ごとの内訳です。">
        <label style={{ ...noteStyle, display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }} title="内部生成レコード（<synthetic>）だけを、この内訳表から除きます。他の集計は変わりません。">
          <input type="checkbox" checked={p.excludeSynthetic} onChange={(event) => setExcludeSynthetic(event.target.checked)} />
          内部生成レコードをこの表から除く
        </label>
        {usageReady && p.series ? <ReportPeriod range={p.series.range} /> : null}
        {p.usageError && usageReady ? <ReportFailure label="日ごとの使用量" error={p.usageError} range={p.series?.range} onRetry={p.onRetryUsage} /> : null}
        {usageReady ? (
          <UsageModelTable report={p.series!} metric={p.metric} excludeSynthetic={p.excludeSynthetic} selection={p.selection} onSelect={p.onSelect} />
        ) : p.usageError ? <ReportFailure label="日ごとの使用量" error={p.usageError} onRetry={p.onRetryUsage} /> : p.usageLoading ? (
          <SkeletonBlock height={160} label="集計を読み込み中" />
        ) : (
          <ReportNotLoaded label="日ごとの使用量" onLoad={p.onRetryUsage} />
        )}
      </Section>
      <Section id="ailog-cross" title="2つの切り口で比較" subtitle="行と列の項目を選んで比較できます。">
        {p.pivotLoading && !pivot ? (
          <SkeletonBlock height={180} label="クロス集計を読み込み中" />
        ) : (
          <CrossTable
            report={pivot}
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
      <Section id="ailog-projects" title={`${breakdownLabel}別`} subtitle="内訳の軸を切り替えて比較できます。">
        <div style={{ marginBottom: 10 }}>
          <ButtonGroup ariaLabel="内訳" roleLabel="内訳" value={p.breakdownDimension} onChange={p.onBreakdownDimension} options={[{ value: "project", label: "案件" }, { value: "branch", label: "ブランチ" }, { value: "effort", label: "推論の深さ" }, { value: "origin", label: "起動元" }, { value: "title", label: "主題" }, { value: "agent", label: "エージェント" }]} />
        </div>
        {p.breakdownError ? <ReportFailure label="内訳" error={p.breakdownError} range={breakdown?.range} onRetry={p.onRefreshBreakdown} /> : null}
        {breakdown ? <><ReportPeriod range={breakdown.range} />{breakdown.rows.length > 0 ? <ProjectTable report={breakdown} overview={breakdownOverview} selection={p.selection} onSelect={p.onSelect} dimensionLabel={breakdownLabel} projectMode={p.breakdownDimension === "project"} /> : <EmptyState kind="no-data" />}</> : p.breakdownLoading ? <SkeletonBlock height={120} label="内訳を更新中" /> : !p.breakdownError ? <ReportNotLoaded label="内訳" onLoad={p.onRefreshBreakdown} /> : null}
      </Section>
      <Section id="ailog-sessions" title="セッション一覧" subtitle="検索と並び替えは、この一覧だけを更新します。概要やグラフはそのまま残ります。">{p.sessions ? <SessionTable report={p.sessions} sort={p.sessionSort} appliedSort={p.sessionAppliedSort} onSort={p.onSessionSort} page={p.sessionPage} appliedPage={p.sessionAppliedPage} onPage={p.onSessionPage} pageSize={SESSION_PAGE_SIZE} onOpenDetail={p.onOpenDetail} activeKey={p.detailKey} query={p.sessionQuery} appliedQuery={p.sessionAppliedQuery} onQuery={p.onSessionQuery} onRetry={p.onRetrySessions} loading={p.sessionLoading} error={p.sessionError} modelFilterActive={Boolean(modelSel)} /> : p.sessionError ? <ReportFailure label="セッション一覧" error={p.sessionError} onRetry={p.onRetrySessions} /> : p.sessionLoading ? <SkeletonBlock height={120} label="セッション一覧を読み込み中" /> : <ReportNotLoaded label="セッション一覧" onLoad={p.onRetrySessions} />}</Section>
      <DeferredDetails summary={`時間帯と曜日（${usageMetricInfo(rhythmMetric).label}）`} subtitle={rhythmMetric !== p.metric ? `ここでは入出力トークンを表示しています。${usageMetricInfo(p.metric).label}には対応していません。` : "選択中の期間・絞り込みで集計しています。"}>
        <UsageRhythmDetails metric={rhythmMetric} />
      </DeferredDetails>
    </div>
  );
});

UsageView.displayName = "UsageView";

const clearFilterStyle = { alignSelf: "flex-start", border: "1px solid var(--cmux-accent)", borderRadius: 999, background: "var(--cmux-hover)", color: "var(--cmux-accent)", padding: "2px 9px", fontSize: "var(--cmux-font-size-xs)", cursor: "pointer" };
