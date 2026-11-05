import { memo } from "react";
import { useAgentServiceVisibility } from "../../hooks/useAgentServiceVisibility";
import type { BreakdownReport, ModelsReport, Overview, PivotAxis, PivotReport, RangePreset, SeriesGroupBy, SeriesReport, SessionsReport, UsageBucket, UsageRhythmReport } from "../../lib/ailog";
import { SESSION_PAGE_SIZE, useAilogStore, type AilogSelection, type BreakdownDimension, type SessionSort } from "../../stores/ailogStore";
import { CrossTable } from "./CrossTable";
import { AilogOverview } from "./AilogOverview";
import { AilogOrientation } from "./AilogOrientation";
import { AilogTabs } from "./AilogTabs";
import { AccountingNote } from "./AccountingNote";
import { ProjectTable } from "./ProjectTable";
import { SessionTable } from "./SessionTable";
import { UsageDaily } from "./UsageDaily";
import { UsageModelTable } from "./UsageModelTable";
import { UsageRhythmDetails } from "./UsageRhythmDetails";
import { ReworkRankings } from "./ReworkRankings";
import { HandoffTable } from "./HandoffTable";
import { UsageTotals } from "./UsageTotals";
import { WorkTagTable } from "./WorkTagTable";
import { ReportFailure, ReportPeriod, ReportNotLoaded } from "./ReportFeedback";
import { SERIES_AXES, USAGE_METRICS, usageAxisHint, type UsageMetric } from "./usageModel";
import { ButtonGroup, EmptyState, RefreshingBlock, Section, SkeletonBlock, noteStyle } from "./ui";

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
  const previousTotals = useAilogStore(state => state.previousTotals);
  const setExcludeSynthetic = useAilogStore(state => state.setExcludeSynthetic);
  const axis = useAilogStore(state => state.breakdownAxis);
  const setAxis = useAilogStore(state => state.setAilogBreakdownAxis);
  const independent = Boolean(p.series?.buckets.some(row => row.turns > 0) || p.models?.byWorkTag.length || p.sessions?.rows.length || p.breakdown?.rows.length || p.pivot?.rows.length);
  const modelAxis = axis === "usage";
  const breakdownLabel = ({ project: "案件", branch: "ブランチ", effort: "推論の深さ", origin: "起動元", title: "主題", agent: "エージェント" } as const)[p.breakdownDimension];
  const projectSel = p.selection?.project;
  const modelSel = p.selection?.model;
  const matches = Boolean(p.overview && p.series && p.overview.range.from === p.series.range.from && p.overview.range.to === p.series.range.to);
  const breakdownPeriod = (range: NonNullable<typeof p.overview>["range"]) =>
    p.overview && !p.loading && !p.error && p.overview.range.from === range.from && p.overview.range.to === range.to
      ? null : <ReportPeriod range={range} />;
  const failure = (label: string, value: string | null, retry: () => void) => value ? <ReportFailure label={label} error={value} onRetry={retry} /> : null;
  return <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
    {projectSel || modelSel ? <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {projectSel ? <button type="button" onClick={() => p.onSelect(modelSel ? { model: modelSel } : null)} style={clearFilterStyle}>案件: {projectSel.label} ×</button> : null}
      {modelSel ? <button type="button" onClick={() => p.onSelect(projectSel ? { project: projectSel } : null)} style={clearFilterStyle}>モデル: {modelSel.label} ×</button> : null}
    </div> : null}
    <RefreshingBlock busy={p.loading}>
      <section id="ailog-overview" aria-label="概要">
      {failure("概要", p.error, p.onRefresh)}
      {p.overview && p.error ? <ReportPeriod range={p.overview.range} /> : null}
      {p.overview ? <AilogOverview overview={p.overview} metric={p.metric} preset={p.preset} previousTotals={previousTotals} previousTotalsStatus={p.previousTotalsStatus} filtered={Boolean(modelSel)} /> : p.loading ? <SkeletonBlock height={90} label="概要を読み込み中" /> : !p.error ? <ReportNotLoaded label="概要" onLoad={p.onRefresh} /> : null}
      {!p.overview ? <div style={noteStyle}>セッション総数は未取得です。</div> : null}
      </section>
    </RefreshingBlock>
    {p.noData && p.statusPending ? <div style={noteStyle}>インデックス状態を確認中です。</div> : null}
    {p.noData && !p.statusPending && !p.loading && !p.usageLoading && !independent ? p.selection
      ? <EmptyState kind="no-data" title="絞り込みに一致する記録なし" message="絞り込みを解除するか、期間を広げてください。" onPrimary={() => p.onSelect(null)} primaryLabel="絞り込みを解除" />
      : <EmptyState kind={p.neverIndexed ? "not-indexed" : "no-data"} onPrimary={p.onStartIndex} busy={p.running} /> : null}
    <Section id="ailog-trend" title="日ごとの使用量">
      <div style={{ marginBottom: 10 }}><ButtonGroup ariaLabel="指標" roleLabel="指標" value={p.metric} onChange={p.onMetric} options={USAGE_METRICS.map(entry => ({ value: entry.id, label: entry.label, title: entry.hint }))} /></div>
      <RefreshingBlock busy={p.usageLoading}>{failure("日ごとの使用量", p.usageError, p.onRetryUsage)}
        {p.series && (!matches || p.usageError) ? <ReportPeriod range={p.series.range} /> : null}
        {p.series && p.overview && !matches ? <div style={noteStyle}>概要と日ごとの使用量の表示期間が異なるため、各欄の期間を確認してください。</div> : null}
        {p.series ? <UsageDaily report={p.series} metric={p.metric} onPickDay={p.onPickDay} /> : p.usageLoading ? <SkeletonBlock height={300} label="日ごとの使用量を読み込み中" /> : !p.usageError ? <ReportNotLoaded label="日ごとの使用量" onLoad={p.onRetryUsage} /> : null}
      </RefreshingBlock>
    </Section>
    <AilogTabs>{section => section === "breakdown" ? <Section id="ailog-breakdown" title="内訳">
      <ButtonGroup ariaLabel="内訳の軸" roleLabel="内訳の軸" value={axis} onChange={value => {
        setAxis(value);
        if (value !== "usage" && value !== "work") p.onBreakdownDimension(value as BreakdownDimension);
      }} options={[{ value: "usage", label: "モデル" },
        { value: "project", label: "案件" }, { value: "branch", label: "ブランチ" }, { value: "effort", label: "推論の深さ" }, { value: "origin", label: "起動元" },
        { value: "title", label: "主題" }, { value: "agent", label: "エージェント" }, { value: "work", label: "作業種別" }]} />
      {modelAxis ? <section id="ailog-compare"><RefreshingBlock busy={p.usageLoading}>
        <ButtonGroup ariaLabel="まとめ方" roleLabel="まとめ方" value={p.seriesAxis} onChange={p.onSeriesAxis} options={SERIES_AXES.map(entry => ({ value: entry.value, label: entry.label, title: usageAxisHint(entry, visible) }))} />
        <label style={{ ...noteStyle, display: "block", margin: "10px 0" }}><input type="checkbox" checked={p.excludeSynthetic} onChange={event => setExcludeSynthetic(event.target.checked)} />内部生成レコードをこの表から除く</label>
        {p.series ? <UsageModelTable report={p.series} metric={p.metric} excludeSynthetic={p.excludeSynthetic} selection={p.selection} onSelect={p.onSelect} /> : <SkeletonBlock height={200} label="内訳を読み込み中" />}
      </RefreshingBlock></section> : axis === "work" ? <section id="ailog-purpose"><RefreshingBlock busy={p.modelsLoading}>{failure("作業種別", p.modelsError, p.onRetryModels)}
        {p.models ? <>{breakdownPeriod(p.models.range)}{p.models.byWorkTag.length ? <WorkTagTable report={p.models} /> : <EmptyState kind="no-data" />}</> : p.modelsLoading ? <SkeletonBlock height={160} label="作業種別を読み込み中" /> : !p.modelsError ? <ReportNotLoaded label="作業種別" onLoad={p.onRetryModels} /> : null}
      </RefreshingBlock></section> : <section id="ailog-projects"><RefreshingBlock busy={p.breakdownLoading}>{failure("内訳", p.breakdownError, p.onRefreshBreakdown)}
        {p.breakdown ? <>{breakdownPeriod(p.breakdown.range)}<ProjectTable report={p.breakdown} overview={p.overview && p.breakdown.range.from === p.overview.range.from && p.breakdown.range.to === p.overview.range.to ? p.overview : null} selection={p.selection} onSelect={p.onSelect} dimensionLabel={breakdownLabel} projectMode={p.breakdown.dimension === "project"} /></> : p.breakdownLoading ? <SkeletonBlock height={200} label="内訳を読み込み中" /> : !p.breakdownError ? <ReportNotLoaded label="内訳" onLoad={p.onRefreshBreakdown} /> : null}
      </RefreshingBlock></section>}
      {p.series && p.overview && matches ? <UsageTotals supporting report={p.series} metric={p.metric} preset={p.preset} totals={p.overview.totals} previousTotals={previousTotals} previousTotalsStatus={p.previousTotalsStatus} turnFilterActive={Boolean(modelSel)} /> : null}
      {p.overview ? <AccountingNote accounting={p.overview.accounting} /> : null}
    </Section> : section === "comparison" ? <Section id="ailog-cross" title="比較">
      <RefreshingBlock busy={p.pivotLoading}><CrossTable report={p.pivot} metric={p.metric} rowBy={p.pivotRowBy} colBy={p.pivotColBy} loading={p.pivotLoading} error={p.pivotError} selection={p.selection} onRetry={p.onRetryPivot} onRowBy={p.onPivotRowBy} onColBy={p.onPivotColBy} onSelect={p.onSelect} /></RefreshingBlock>
    </Section> : section === "sessions" ? <Section id="ailog-sessions" title="セッション">
      {p.overview ? <AilogOrientation overview={p.overview} series={p.series} sessions={p.sessions} metric={p.metric} preset={p.preset} previousTotals={previousTotals} previousTotalsStatus={p.previousTotalsStatus} breakdownLabel={breakdownLabel} running={p.running} sessionLoading={p.sessionLoading} sessionError={p.sessionError} onStartIndex={p.onStartIndex} onOpenDetail={p.onOpenDetail} /> : null}
      <RefreshingBlock busy={p.sessionLoading}>{p.sessions ? <SessionTable report={p.sessions} sort={p.sessionSort} appliedSort={p.sessionAppliedSort} onSort={p.onSessionSort} page={p.sessionPage} appliedPage={p.sessionAppliedPage} onPage={p.onSessionPage} pageSize={SESSION_PAGE_SIZE} onOpenDetail={p.onOpenDetail} activeKey={p.detailKey} query={p.sessionQuery} appliedQuery={p.sessionAppliedQuery} onQuery={p.onSessionQuery} onRetry={p.onRetrySessions} loading={p.sessionLoading} error={p.sessionError} modelFilterActive={Boolean(modelSel)} />
        : p.sessionError ? <ReportFailure label="セッション" error={p.sessionError} onRetry={p.onRetrySessions} /> : p.sessionLoading ? <SkeletonBlock height={240} label="セッションを読み込み中" /> : <ReportNotLoaded label="セッション" onLoad={p.onRetrySessions} />}</RefreshingBlock>
    </Section> : section === "rework" ? <Section id="ailog-learning" title="手戻り"><ReworkRankings />
      {p.overview ? <div style={noteStyle}>ツール実行のまま終了した割合: {p.overview.totals.sessions ? (p.overview.rework.abandonedSessions / p.overview.totals.sessions * 100).toFixed(1) : "0"}%</div> : null}
    </Section> : section === "handoffs" ? <Section id="ailog-handoffs" title="モデル切替" subtitle="同じセッションで続けて別のモデルに切り替わった回数です。切り替えの良し悪しは判定しません。"><HandoffTable /></Section>
      : <Section id="ailog-activity" title="活動時間"><UsageRhythmDetails /></Section>}
    </AilogTabs>
  </div>;
});
UsageView.displayName = "UsageView";
const clearFilterStyle = { border: "1px solid var(--cmux-accent)", borderRadius: 999, background: "var(--cmux-hover)", color: "var(--cmux-accent-text)", padding: "2px 9px", fontSize: "var(--cmux-font-size-xs)", cursor: "pointer" };
