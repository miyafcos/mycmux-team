/** The one-surface AI log dashboard. Navigation never starts LLM work. */
import { Fragment, useCallback, useEffect, useLayoutEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { OverlayShell } from "../common/OverlayShell";
import { toDayInput } from "../../lib/ailog";
import { useAilogStore } from "../../stores/ailogStore";
import { jobDisplayError, useAilogJobStore } from "../../stores/useAilogJobStore";
import { useAiSettingsStore } from "../../stores/aiSettingsStore";
import { aiSettingsStrings } from "../settings/settingsStrings";
import { DigestView } from "./DigestView";
import { QuestionBoard } from "./QuestionBoard";
import { ChangeView } from "./ChangeView";
import { LearningView } from "./LearningView";
import { RecordView } from "./RecordView";
import { RangeBar } from "./RangeBar";
import { SessionDetailView } from "./SessionDetailView";
import { dailyDigestNavigation, findingKindsForSegment, isExplicitLlmIntent, recordNavigation, type PanelSegment } from "./panelModel";
import { buildQuestionCards, type QuestionCardData } from "./questionModel";
import { markAilogVisited, markDigestRead, readAilogLastVisit, saveQuestionAnswers, type AilogLastVisit } from "../../lib/ailogLastVisit";
import { EmptyState, RefreshingBlock, SkeletonBlock, noteStyle, subtleButtonStyle } from "./ui";

interface AiLogPanelProps { open: boolean; visible: boolean; closing?: boolean; onClose: () => void; }

export function AiLogPanel({ open, visible, closing = false, onClose }: AiLogPanelProps) {
  const [segment, setSegment] = useState<PanelSegment>("change");
  const [visit, setVisit] = useState<AilogLastVisit>(() => readAilogLastVisit());
  const [detailOpen, setDetailOpen] = useState(false);
  const store = useAilogStore(useShallow((state) => ({
    preset: state.preset, customFrom: state.customFrom, customTo: state.customTo,
    summaryPreset: state.summaryPreset, excludeSynthetic: state.excludeSynthetic,
    includeSidechain: state.includeSidechain, granularity: state.granularity,
    sessionSort: state.sessionSort, sessionPage: state.sessionPage, selection: state.selection,
    breakdownDimension: state.breakdownDimension, overview: state.overview, breakdown: state.breakdown,
    breakdownError: state.breakdownError, breakdownLoading: state.breakdownLoading,
    sessions: state.sessions, detail: state.detail, detailKey: state.detailKey,
    transcript: state.transcript, transcriptLoading: state.transcriptLoading,
    transcriptError: state.transcriptError, sessionSummarizing: state.sessionSummarizing,
    sessionSummarizeError: state.sessionSummarizeError, findings: state.findings,
    rankings: state.rankings, learningHasMore: state.learningHasMore, findingKind: state.findingKind,
    findingQuery: state.findingQuery, loading: state.loading, dashboardError: state.dashboardError,
    detailLoading: state.detailLoading, detailError: state.detailError, digestDate: state.digestDate, digestReport: state.digestReport,
    digestLoading: state.digestLoading, digestGenerating: state.digestGenerating,
    digestError: state.digestError, learningLoading: state.learningLoading,
    learningError: state.learningError, efficiency: state.efficiency, ruleCheck: state.ruleCheck,
    experimentLoading: state.experimentLoading, experimentError: state.experimentError,
    usageMetric: state.usageMetric, usageStack: state.usageStack, usageBucket: state.usageBucket,
    usageSeries: state.usageSeries, usageRhythm: state.usageRhythm, usageLoading: state.usageLoading,
    usageError: state.usageError, lastLoadMs: state.lastLoadMs,
    setPreset: state.setPreset, setCustomRange: state.setCustomRange,
    setUsageMetric: state.setUsageMetric, setUsageStack: state.setUsageStack,
    setUsageBucket: state.setUsageBucket, refreshUsage: state.refreshUsage,
    loadSegment: state.loadSegment, preloadSegments: state.preloadSegments,
    setSummaryPreset: state.setSummaryPreset, setExcludeSynthetic: state.setExcludeSynthetic,
    setIncludeSidechain: state.setIncludeSidechain, setGranularity: state.setGranularity,
    setSessionSort: state.setSessionSort, setSessionPage: state.setSessionPage,
    setSelection: state.setSelection, setBreakdownDimension: state.setBreakdownDimension,
    refreshBreakdown: state.refreshBreakdown, refreshExperiment: state.refreshExperiment,
    openDetail: state.openDetail, summarizeSession: state.summarizeSession,
    closeDetail: state.closeDetail, setDigestDate: state.setDigestDate,
    stepDigestDate: state.stepDigestDate, refreshDigest: state.refreshDigest,
    generateDigest: state.generateDigest, setFindingKind: state.setFindingKind,
    setFindingQuery: state.setFindingQuery, refreshLearning: state.refreshLearning,
  })));
  const aiEnabled = useAiSettingsStore((s) => s.aiEnabled);
  const aiDisabledReason = aiEnabled ? undefined : aiSettingsStrings.disabledReason;

  useEffect(() => {
    if (open) setVisit(readAilogLastVisit());
    else markAilogVisited();
  }, [open]);
  const closeDetail = useCallback(() => { setDetailOpen(false); store.closeDetail(); }, [store.closeDetail]);
  useEffect(() => {
    if (open) return;
    setSegment("change");
    closeDetail();
  }, [closeDetail, open]);
  useEffect(() => () => { store.closeDetail(); }, [store.closeDetail]);

  const refreshVisibleSegment = useCallback(async (force = false): Promise<void> => {
    if (!open) return;
    await store.loadSegment(segment, { force });
    void store.preloadSegments(segment);
  }, [open, segment, store.loadSegment, store.preloadSegments]);

  useLayoutEffect(() => { void refreshVisibleSegment(); }, [refreshVisibleSegment, store.preset, store.customFrom, store.customTo, store.includeSidechain, store.selection, store.granularity, store.usageBucket, store.breakdownDimension, store.digestDate, store.findingKind, store.findingQuery]);


  if (!visible) return null;
  const visibleBusy = segment === "record"
    ? store.usageLoading || store.loading || store.breakdownLoading
    : segment === "how"
        ? store.experimentLoading
        : segment === "daily"
          ? store.digestLoading || store.digestGenerating
          : store.learningLoading;
  const jobSnapshot = useAilogJobStore.getState();
  const indexStatus = jobSnapshot.index.status; const summarizeStatus = jobSnapshot.summarize.status;
  const running = indexStatus?.running ?? false;
  const statusPending = indexStatus === null && jobSnapshot.index.statusError === null;
  const neverIndexed = indexStatus !== null && indexStatus.lastFinishedAt === 0;
  const noData = Boolean(store.overview) && (store.overview?.totals.sessions ?? 0) === 0;
  const openDetail = useCallback((kind: string, sessionId: string) => { setDetailOpen(true); void store.openDetail(kind, sessionId); }, [store.openDetail]);
  const activeSegmentLoad = useCallback(() => void refreshVisibleSegment(true), [refreshVisibleSegment]);
  const runExplicitLlm = useCallback((intent: string, action: () => Promise<void>) => {
    if (!aiEnabled) return;
    if (isExplicitLlmIntent(intent)) void action();
  }, [aiEnabled]);
  const openDailyDigest = useCallback((day: number) => {
    const target = dailyDigestNavigation(toDayInput(day));
    setSegment(target.segment); store.setDigestDate(target.date);
  }, [store.setDigestDate]);
  const openRecord = useCallback((day: number) => {
    const target = recordNavigation(toDayInput(day));
    setSegment(target.segment); store.setCustomRange(target.from, target.to);
  }, [store.setCustomRange]);
  const changeSegment = useCallback((nextSegment: PanelSegment) => {
    const allowed = findingKindsForSegment(nextSegment);
    if (allowed.length > 0 && store.findingKind && !allowed.includes(store.findingKind)) store.setFindingKind(null);
    setSegment(nextSegment);
  }, [store.findingKind, store.setFindingKind]);
  const closePanel = useCallback(() => { closeDetail(); onClose(); }, [closeDetail, onClose]);
  const refreshBreakdown = useCallback(() => void store.refreshBreakdown({ force: true }), [store.refreshBreakdown]);
  const retryUsage = useCallback(() => void store.refreshUsage({ force: true }), [store.refreshUsage]);
  const pickUsageDay = useCallback((day: number) => { const value = toDayInput(day); store.setCustomRange(value, value); }, [store.setCustomRange]);
  const retryDigest = useCallback(() => void store.refreshDigest(undefined, { force: true }), [store.refreshDigest]);
  const copyText = useCallback((text: string) => { void navigator.clipboard.writeText(text); }, []);
  const previousDigest = useCallback(() => store.stepDigestDate(-1), [store.stepDigestDate]);
  const nextDigest = useCallback(() => store.stepDigestDate(1), [store.stepDigestDate]);
  const regenerateDigest = useCallback(() => runExplicitLlm("regenerateDigest", () => store.generateDigest(true)), [runExplicitLlm, store.generateDigest]);
  const startIndex = useCallback(() => void useAilogJobStore.getState().startIndex(false), []);
  const startSummarize = useCallback(() => runExplicitLlm("startSummarize", () => useAilogJobStore.getState().startSummarize(store.summaryPreset)), [runExplicitLlm, store.summaryPreset]);
  const loadMoreFindings = useCallback(() => void store.refreshLearning({ append: true, kinds: findingKindsForSegment("learning"), includeRankings: true }), [store.refreshLearning]);
  const openQuestionRecords = useCallback((card: QuestionCardData) => {
    store.setSessionSort(card.sort);
    store.setSelection(card.modelKey ? { type: "model", key: card.modelKey, label: card.modelKey } : null);
    setSegment("record");
  }, [store.setSelection, store.setSessionSort]);
  const questions = store.efficiency ? buildQuestionCards(store.efficiency) : [];
  useEffect(() => {
    if (segment === "how" && store.efficiency) saveQuestionAnswers(Object.fromEntries(buildQuestionCards(store.efficiency).map((card) => [card.id, card.answer])));
  }, [segment, store.efficiency]);
  useEffect(() => {
    if (segment === "daily" && store.digestReport?.digest) markDigestRead(store.digestReport.date);
  }, [segment, store.digestReport]);

  return <OverlayShell open={open} closing={closing} onClose={closePanel} closeOnEscape={!detailOpen} size="full" ariaLabel="AIログ分析" id="ailog-panel">
    <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--cmux-border)" }}>
      <div><div style={{ fontSize: 14, fontWeight: 700 }}>AI ログ分析</div><div role="status" aria-live="polite" style={{ ...noteStyle, marginTop: 2 }}>{visibleBusy ? "集計を更新中…" : store.overview ? `${store.overview.range.label} · ${store.overview.totals.sessions.toLocaleString("en-US")} セッション` : "—"}{import.meta.env.DEV && store.lastLoadMs[segment] !== undefined ? ` · ${store.lastLoadMs[segment]!.toFixed(0)}ms` : ""}</div></div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}><button type="button" aria-label="閉じる" onClick={closePanel} style={{ ...subtleButtonStyle, padding: "3px 8px" }}>×</button></div>
    </header>
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}><div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "12px 16px 20px", minWidth: 0 }}>
      <RangeBar preset={store.preset} customFrom={store.customFrom} customTo={store.customTo} onPreset={store.setPreset} onCustomRange={store.setCustomRange} summaryPreset={store.summaryPreset} onSummaryPreset={store.setSummaryPreset} open={open} onJobsSettled={activeSegmentLoad} onStartSummarize={startSummarize} overview={store.overview} usageRhythm={store.usageRhythm} aiDisabledReason={aiDisabledReason} onRefresh={activeSegmentLoad} loading={visibleBusy} excludeSynthetic={store.excludeSynthetic} onExcludeSynthetic={store.setExcludeSynthetic} includeSidechain={store.includeSidechain} onIncludeSidechain={store.setIncludeSidechain} />
      <Segment buttons={[["change", "変化"], ["how", "問い"], ["learning", "学び"], ["record", "記録"], ["daily", "日別"]]} value={segment} onChange={changeSegment} />
      {segment === "change" ? <ChangeView visit={visit} sessions={store.sessions} findings={store.findings} digestReport={store.digestReport} indexStatus={indexStatus} questions={questions} onOpenLearning={() => setSegment("learning")} onOpenQuestions={() => setSegment("how")} onOpenDaily={() => setSegment("daily")} /> : null}
      {segment === "record" ? <RefreshingBlock busy={visibleBusy}><RecordView overview={store.overview} sessions={store.sessions} series={store.usageSeries} rhythm={store.usageRhythm} loading={store.loading} usageLoading={store.usageLoading} usageError={store.usageError} error={store.dashboardError} statusPending={statusPending} neverIndexed={neverIndexed} noData={noData} running={running} preset={store.preset} metric={store.usageMetric} stack={store.usageStack} bucket={store.usageBucket} granularity={store.granularity} excludeSynthetic={store.excludeSynthetic} selection={store.selection} breakdownDimension={store.breakdownDimension} breakdown={store.breakdown} breakdownError={store.breakdownError} breakdownLoading={store.breakdownLoading} sessionSort={store.sessionSort} sessionPage={store.sessionPage} detailKey={store.detailKey} onRefresh={activeSegmentLoad} onRetryUsage={retryUsage} onStartIndex={startIndex} onMetric={store.setUsageMetric} onStack={store.setUsageStack} onBucket={store.setUsageBucket} onGranularity={store.setGranularity} onPickDay={pickUsageDay} onOpenDigest={openDailyDigest} onSelect={store.setSelection} onBreakdownDimension={store.setBreakdownDimension} onRefreshBreakdown={refreshBreakdown} onSessionSort={store.setSessionSort} onSessionPage={store.setSessionPage} onOpenDetail={openDetail} /></RefreshingBlock> : null}
      {segment === "how" ? <RefreshingBlock busy={visibleBusy}><QuestionBoard report={store.efficiency} loading={store.experimentLoading} error={store.experimentError} onOpenRecords={openQuestionRecords} /></RefreshingBlock> : null}
      {segment === "daily" ? (
          store.digestReport ? <RefreshingBlock busy={visibleBusy}><DigestView report={store.digestReport} loading={store.digestLoading} generating={store.digestGenerating} error={store.digestError} onRetry={retryDigest} onPrevious={previousDigest} onNext={nextDigest} onRegenerate={regenerateDigest} summarizeStatus={summarizeStatus} summarizeError={jobDisplayError(jobSnapshot.summarize)} onStartSummarize={startSummarize} aiDisabledReason={aiDisabledReason} onOpenRecord={() => openRecord(Date.parse(store.digestDate))} onCopySuggestion={copyText} /></RefreshingBlock>
            : <DigestView report={store.digestReport} loading={store.digestLoading} generating={store.digestGenerating} error={store.digestError} onRetry={retryDigest} onPrevious={previousDigest} onNext={nextDigest} onRegenerate={regenerateDigest} summarizeStatus={summarizeStatus} summarizeError={jobDisplayError(jobSnapshot.summarize)} onStartSummarize={startSummarize} aiDisabledReason={aiDisabledReason} onOpenRecord={() => openRecord(Date.parse(store.digestDate))} onCopySuggestion={copyText} />
      ) : null}
      {segment === "learning" ? <RefreshingBlock busy={visibleBusy}><LearningView findings={store.findings} rankings={store.rankings} rules={store.ruleCheck} hasMore={store.learningHasMore} kind={store.findingKind} query={store.findingQuery} loading={store.learningLoading} error={store.learningError} onKindChange={store.setFindingKind} onQueryChange={store.setFindingQuery} onLoadMore={loadMoreFindings} onOpenDetail={openDetail} onOpenRecord={openRecord} onCopyRule={copyText} /></RefreshingBlock> : null}
    </div></div>
    {detailOpen ? <OverlayShell open={detailOpen} onClose={closeDetail} size="wide" layer="top" ariaLabel="セッション詳細">{store.detailError ? <EmptyState kind="error" message={store.detailError} onPrimary={() => store.detailKey ? void store.openDetail(store.detailKey.kind, store.detailKey.sessionId) : undefined} primaryLabel="再試行" /> : store.detailLoading ? <div style={{ padding: 16 }}><SkeletonBlock height={120} label="詳細を読み込み中" /></div> : store.detail ? <div style={{ padding: 16, overflowY: "auto" }}><SessionDetailView detail={store.detail} transcript={store.transcript} transcriptLoading={store.transcriptLoading} transcriptError={store.transcriptError} sessionSummarizing={store.sessionSummarizing} sessionSummarizeError={store.sessionSummarizeError} aiDisabledReason={aiDisabledReason} onSummarize={() => runExplicitLlm("summarizeSession", () => store.summarizeSession(store.detail!.session.kind, store.detail!.session.sessionId))} onClose={closeDetail} /></div> : null}</OverlayShell> : null}
  </OverlayShell>;
}

function Segment<T extends string>({ buttons, value, onChange }: { buttons: readonly (readonly [T, string])[]; value: T; onChange: (value: T) => void }) {
  return <div role="group" aria-label="段" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>{buttons.map(([id, label]) => {
    const active = value === id;
    return <Fragment key={id}>
      {id === "daily" ? <span aria-hidden="true" style={{ width: 1, alignSelf: "stretch", background: "var(--cmux-border)", margin: "0 3px" }} /> : null}
      <button type="button" aria-pressed={active} onClick={() => onChange(id)} style={{ ...subtleButtonStyle, background: active ? "var(--cmux-accent)" : "var(--cmux-hover)", color: active ? "var(--cmux-on-accent)" : "var(--cmux-text)", borderColor: active ? "var(--cmux-accent)" : "var(--cmux-border)" }}>{label}</button>
    </Fragment>;
  })}</div>;
}
