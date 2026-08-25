/** The one-surface AI log dashboard. Navigation never starts LLM work. */
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { OverlayShell } from "../common/OverlayShell";
import { shiftDayInput, toDayInput, type UsageBucket } from "../../lib/ailog";
import { useAilogAutoIndex } from "../../hooks/useAilogAutoIndex";
import { useAilogStore } from "../../stores/ailogStore";
import { jobDisplayError, useAilogJobStore } from "../../stores/useAilogJobStore";
import { useAiSettingsStore } from "../../stores/aiSettingsStore";
import { aiSettingsStrings } from "../settings/settingsStrings";
import { IndexBadge } from "./IndexBadge";
import { PanelMenu } from "./PanelMenu";
import { RangeBar } from "./RangeBar";
import { SessionDetailView } from "./SessionDetailView";
import { UsageView } from "./UsageView";
import { isExplicitLlmIntent } from "./panelModel";
import { EmptyState, SkeletonBlock, noteStyle, subtleButtonStyle } from "./ui";

interface AiLogPanelProps { open: boolean; visible: boolean; closing?: boolean; onClose: () => void; }

export function bucketInputRange(day: number, bucket: UsageBucket): { from: string; to: string } {
  const from = toDayInput(day);
  if (bucket === "day") return { from, to: from };
  if (bucket === "week") return { from, to: shiftDayInput(from, 6) };
  const [year, month] = from.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from, to: `${year}-${`${month}`.padStart(2, "0")}-${`${lastDay}`.padStart(2, "0")}` };
}

export function AiLogPanel({ open, visible, closing = false, onClose }: AiLogPanelProps) {
  const [detailOpen, setDetailOpen] = useState(false);
  const store = useAilogStore(useShallow((state) => ({
    preset: state.preset, customFrom: state.customFrom, customTo: state.customTo,
    summaryPreset: state.summaryPreset, excludeSynthetic: state.excludeSynthetic,
    includeSidechain: state.includeSidechain, granularity: state.granularity, usageSeriesAxis: state.usageSeriesAxis,
    sessionSort: state.sessionSort, sessionPage: state.sessionPage, sessionQuery: state.sessionQuery, sessionAppliedQuery: state.sessionAppliedQuery,
    sessionAppliedSort: state.sessionAppliedSort, sessionAppliedPage: state.sessionAppliedPage,
    sessionLoading: state.sessionLoading, sessionError: state.sessionError, selection: state.selection,
    breakdownDimension: state.breakdownDimension, overview: state.overview, previousTotalsStatus: state.previousTotalsStatus, models: state.models, breakdown: state.breakdown,
    breakdownError: state.breakdownError, breakdownLoading: state.breakdownLoading,
    sessions: state.sessions, detail: state.detail, detailKey: state.detailKey,
    transcript: state.transcript, transcriptLoading: state.transcriptLoading,
    transcriptError: state.transcriptError, sessionSummarizing: state.sessionSummarizing,
    sessionSummarizeError: state.sessionSummarizeError, loading: state.loading, dashboardError: state.dashboardError,
    detailLoading: state.detailLoading, detailError: state.detailError,
    usageMetric: state.usageMetric, usageStack: state.usageStack, usageBucket: state.usageBucket,
    usageSeries: state.usageSeries, usageRhythm: state.usageRhythm, usageLoading: state.usageLoading,
    usageError: state.usageError, lastLoadMs: state.lastLoadMs, usdJpyRate: state.usdJpyRate,
    pivot: state.pivot, pivotRowBy: state.pivotRowBy, pivotColBy: state.pivotColBy,
    pivotLoading: state.pivotLoading, pivotError: state.pivotError,
    setPreset: state.setPreset, setCustomRange: state.setCustomRange,
    setUsageMetric: state.setUsageMetric, setUsageStack: state.setUsageStack,
    setUsageBucket: state.setUsageBucket, refreshUsage: state.refreshUsage, refreshPivot: state.refreshPivot,
    setPivotRowBy: state.setPivotRowBy, setPivotColBy: state.setPivotColBy,
    loadUsage: state.loadUsage,
    setSummaryPreset: state.setSummaryPreset, setExcludeSynthetic: state.setExcludeSynthetic,
    setIncludeSidechain: state.setIncludeSidechain, setGranularity: state.setGranularity, setUsageSeriesAxis: state.setUsageSeriesAxis,
    setSessionSort: state.setSessionSort, setSessionPage: state.setSessionPage, setSessionQuery: state.setSessionQuery,
    refreshSessions: state.refreshSessions,
    setSelection: state.setSelection, setBreakdownDimension: state.setBreakdownDimension,
    refreshBreakdown: state.refreshBreakdown,
    openDetail: state.openDetail, loadTranscript: state.loadTranscript, summarizeSession: state.summarizeSession,
    closeDetail: state.closeDetail, setUsdJpyRate: state.setUsdJpyRate, loadUsdJpyRate: state.loadUsdJpyRate,
  })));
  const aiEnabled = useAiSettingsStore((s) => s.aiEnabled);
  const aiDisabledReason = aiEnabled ? undefined : aiSettingsStrings.disabledReason;
  const index = useAilogJobStore((state) => state.index);
  const summarize = useAilogJobStore((state) => state.summarize);
  const dismissIndexError = useAilogJobStore((state) => state.dismissIndexError);
  const dismissSummarizeError = useAilogJobStore((state) => state.dismissSummarizeError);

  const closeDetail = useCallback(() => { setDetailOpen(false); store.closeDetail(); }, [store.closeDetail]);
  useEffect(() => {
    if (open) return;
    closeDetail();
  }, [closeDetail, open]);
  useEffect(() => () => { store.closeDetail(); }, [store.closeDetail]);

  const refreshUsageSurface = useCallback(async (force = false): Promise<void> => {
    if (!open) return;
    await store.loadUsage({ force });
  }, [open, store.loadUsage]);

  useLayoutEffect(() => {
    void refreshUsageSurface();
  }, [refreshUsageSurface, store.preset, store.customFrom, store.customTo, store.includeSidechain, store.selection, store.granularity, store.usageSeriesAxis, store.usageBucket, store.breakdownDimension]);
  useEffect(() => {
    if (!open) return;
    void store.loadUsdJpyRate();
  }, [open, store.loadUsdJpyRate]);

  const activeLoad = useCallback(() => void refreshUsageSurface(true), [refreshUsageSurface]);
  useAilogAutoIndex(open, activeLoad);

  const openDetail = useCallback((kind: string, sessionId: string) => { setDetailOpen(true); void store.openDetail(kind, sessionId); }, [store.openDetail]);
  const runExplicitLlm = useCallback((intent: string, action: () => Promise<void>) => {
    if (!aiEnabled) return;
    if (isExplicitLlmIntent(intent)) void action();
  }, [aiEnabled]);
  const closePanel = useCallback(() => { closeDetail(); onClose(); }, [closeDetail, onClose]);
  const refreshBreakdown = useCallback(() => void store.refreshBreakdown({ force: true }), [store.refreshBreakdown]);
  const applySessionQuery = useCallback((value: string) => { store.setSessionQuery(value); void store.refreshSessions(); }, [store.refreshSessions, store.setSessionQuery]);
  const retryUsage = useCallback(() => void store.refreshUsage({ force: true }), [store.refreshUsage]);
  const retryPivot = useCallback(() => void store.refreshPivot({ force: true }), [store.refreshPivot]);
  const pickUsageDay = useCallback((day: number) => {
    const range = bucketInputRange(day, store.usageBucket);
    store.setCustomRange(range.from, range.to);
  }, [store.setCustomRange, store.usageBucket]);
  const startIndex = useCallback(() => void useAilogJobStore.getState().startIndex(false), []);
  const startSummarize = useCallback(() => runExplicitLlm("startSummarize", () => useAilogJobStore.getState().startSummarize(store.summaryPreset)), [runExplicitLlm, store.summaryPreset]);

  if (!visible) return null;

  const visibleBusy = store.usageLoading || store.loading || store.breakdownLoading || store.pivotLoading;
  const running = index.status?.running ?? false;
  const statusPending = index.status === null && index.statusError === null;
  const neverIndexed = index.status !== null && index.status.lastFinishedAt === 0;
  const noData = Boolean(store.overview) && (store.overview?.totals.sessions ?? 0) === 0;
  const indexError = !index.autoStarted ? jobDisplayError(index) : null;
  const summarizeError = jobDisplayError(summarize);

  return <OverlayShell open={open} closing={closing} onClose={closePanel} closeOnEscape={!detailOpen} size="full" ariaLabel="AIログ分析" id="ailog-panel">
    <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "12px 16px", borderBottom: "1px solid var(--cmux-border)" }}>
      <div style={{ minWidth: 0 }}>
        <h1 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>AI ログ分析</h1>
        <div role="status" aria-live="polite" style={{ ...noteStyle, marginTop: 2 }}>
          {store.overview ? `${store.overview.range.label} · ${store.overview.totals.sessions.toLocaleString("ja-JP")} セッション${visibleBusy ? " · 直前の集計を表示したまま更新中…" : ""}` : visibleBusy ? "集計を読み込み中…" : "—"}
          {import.meta.env.DEV && store.lastLoadMs !== null ? ` · ${store.lastLoadMs.toFixed(0)}ms` : ""}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flexWrap: "wrap" }}>
        <IndexBadge />
        <PanelMenu summaryPreset={store.summaryPreset} onSummaryPreset={store.setSummaryPreset} aiDisabledReason={aiDisabledReason} onStartSummarize={startSummarize} />
        <button type="button" aria-label="閉じる" onClick={closePanel} style={{ ...subtleButtonStyle, padding: "3px 8px" }}>×</button>
      </div>
    </header>
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}><div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "12px 16px 20px", minWidth: 0 }}>
      <RangeBar preset={store.preset} customFrom={store.customFrom} customTo={store.customTo} onPreset={store.setPreset} onCustomRange={store.setCustomRange} overview={store.overview} usageRhythm={store.usageRhythm} onRefresh={activeLoad} loading={visibleBusy} excludeSynthetic={store.excludeSynthetic} onExcludeSynthetic={store.setExcludeSynthetic} includeSidechain={store.includeSidechain} onIncludeSidechain={store.setIncludeSidechain} usdJpyRate={store.usdJpyRate} onUsdJpyRate={store.setUsdJpyRate} />
      {indexError ? <div role="alert" style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-red)", overflowWrap: "anywhere" }}>新しい記録を取り込めませんでした。表示中の集計は前回分です。 <button type="button" onClick={startIndex} style={subtleButtonStyle}>再試行</button> <button type="button" onClick={dismissIndexError} style={subtleButtonStyle}>閉じる</button><details><summary>技術情報</summary>{indexError}</details></div> : null}
      {summarizeError ? <div role="alert" style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-red)", overflowWrap: "anywhere" }}>要約を更新できませんでした。 <button type="button" onClick={startSummarize} style={subtleButtonStyle}>再試行</button> <button type="button" onClick={dismissSummarizeError} style={subtleButtonStyle}>閉じる</button><details><summary>技術情報</summary>{summarizeError}</details></div> : null}
      <UsageView overview={store.overview} previousTotalsStatus={store.previousTotalsStatus} models={store.models} sessions={store.sessions} series={store.usageSeries} rhythm={store.usageRhythm} loading={store.loading} usageLoading={store.usageLoading} usageError={store.usageError} error={store.dashboardError} statusPending={statusPending} neverIndexed={neverIndexed} noData={noData} running={running} preset={store.preset} metric={store.usageMetric} stack={store.usageStack} bucket={store.usageBucket} seriesAxis={store.usageSeriesAxis} excludeSynthetic={store.excludeSynthetic} selection={store.selection} breakdownDimension={store.breakdownDimension} breakdown={store.breakdown} breakdownError={store.breakdownError} breakdownLoading={store.breakdownLoading} pivot={store.pivot} pivotRowBy={store.pivotRowBy} pivotColBy={store.pivotColBy} pivotLoading={store.pivotLoading} pivotError={store.pivotError} sessionSort={store.sessionSort} sessionPage={store.sessionPage} sessionQuery={store.sessionQuery} sessionAppliedQuery={store.sessionAppliedQuery} sessionAppliedSort={store.sessionAppliedSort} sessionAppliedPage={store.sessionAppliedPage} sessionLoading={store.sessionLoading} sessionError={store.sessionError} detailKey={store.detailKey} onRefresh={activeLoad} onRetryUsage={retryUsage} onStartIndex={startIndex} onMetric={store.setUsageMetric} onStack={store.setUsageStack} onBucket={store.setUsageBucket} onSeriesAxis={store.setUsageSeriesAxis} onPickDay={pickUsageDay} onSelect={store.setSelection} onBreakdownDimension={store.setBreakdownDimension} onRefreshBreakdown={refreshBreakdown} onPivotRowBy={store.setPivotRowBy} onPivotColBy={store.setPivotColBy} onRetryPivot={retryPivot} onSessionSort={store.setSessionSort} onSessionPage={store.setSessionPage} onSessionQuery={applySessionQuery} onRetrySessions={store.refreshSessions} onOpenDetail={openDetail} />
    </div></div>
    {detailOpen ? <OverlayShell open={detailOpen} onClose={closeDetail} size="wide" layer="top" ariaLabel="セッション詳細">{store.detailError ? <EmptyState kind="error" message={store.detailError} onPrimary={() => store.detailKey ? void store.openDetail(store.detailKey.kind, store.detailKey.sessionId) : undefined} primaryLabel="再試行" /> : store.detailLoading ? <div style={{ padding: 16 }}><SkeletonBlock height={120} label="詳細を読み込み中" /></div> : store.detail ? <div style={{ padding: 16, overflowY: "auto" }}><SessionDetailView detail={store.detail} transcript={store.transcript} transcriptLoading={store.transcriptLoading} transcriptError={store.transcriptError} sessionSummarizing={store.sessionSummarizing} sessionSummarizeError={store.sessionSummarizeError} aiDisabledReason={aiDisabledReason} onSummarize={() => runExplicitLlm("summarizeSession", () => store.summarizeSession(store.detail!.session.kind, store.detail!.session.sessionId))} onLoadTranscript={() => store.detailKey ? void store.loadTranscript(store.detailKey.kind, store.detailKey.sessionId) : undefined} onClose={closeDetail} /></div> : null}</OverlayShell> : null}
  </OverlayShell>;
}
