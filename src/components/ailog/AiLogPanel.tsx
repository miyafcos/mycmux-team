/** The two-surface AI log dashboard. Navigation never starts LLM work. */
import { useCallback, useEffect, useState } from "react";

import { OverlayShell } from "../common/OverlayShell";
import { listenIndexProgress, listenSummarizeProgress, toDayInput } from "../../lib/ailog";
import { jobDisplayError, useAilogStore } from "../../stores/ailogStore";
import { useAilogPolling } from "../../hooks/useAilogPolling";
import { useAiSettingsStore } from "../../stores/aiSettingsStore";
import { aiSettingsStrings } from "../settings/settingsStrings";
import { DigestView } from "./DigestView";
import { ExperimentView } from "./ExperimentView";
import { LearningView } from "./LearningView";
import { RecordBreakdownView } from "./RecordBreakdownView";
import { PriceSettings } from "./PriceSettings";
import { RangeBar } from "./RangeBar";
import { SessionDetailView } from "./SessionDetailView";
import { dailyDigestNavigation, findingKindsForSegment, isExplicitLlmIntent, loadersForSegment, recordBreakdownNavigation, shouldRefreshBreakdown, type AilogSurface, type InsightSegment, type RecordSegment } from "./panelModel";
import { EmptyState, Section, SkeletonBlock, noteStyle, subtleButtonStyle } from "./ui";
import { UsageView } from "./UsageView";

interface AiLogPanelProps { open: boolean; visible: boolean; closing?: boolean; onClose: () => void; }

export function AiLogPanel({ open, visible, closing = false, onClose }: AiLogPanelProps) {
  const [surface, setSurface] = useState<AilogSurface>("record");
  const [recordSegment, setRecordSegment] = useState<RecordSegment>("when");
  const [insightSegment, setInsightSegment] = useState<InsightSegment>("daily");
  const [detailOpen, setDetailOpen] = useState(false);
  const store = useAilogStore();
  const aiEnabled = useAiSettingsStore((s) => s.aiEnabled);
  const aiDisabledReason = aiEnabled ? undefined : aiSettingsStrings.disabledReason;

  useEffect(() => {
    if (!open) return;
    void store.refreshIndexStatus();
    void store.refreshSummarizeStatus();
    // No report and no LLM work is started here: both are segment-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const closeDetail = useCallback(() => { setDetailOpen(false); store.closeDetail(); }, [store.closeDetail]);
  useEffect(() => {
    if (open) return;
    setSurface("record");
    setRecordSegment("when");
    setInsightSegment("daily");
    closeDetail();
  }, [closeDetail, open]);
  useEffect(() => () => { store.closeDetail(); }, [store.closeDetail]);

  const refreshVisibleSegment = useCallback(async (): Promise<void> => {
    if (!open) return;
    const loaders = loadersForSegment(surface, surface === "record" ? recordSegment : insightSegment);
    if (loaders.includes("usage")) return store.refreshUsage();
    if (loaders.includes("breakdown") && shouldRefreshBreakdown(surface, recordSegment)) {
      await Promise.all([store.refresh(), store.refreshBreakdown(), store.refreshPrices()]);
      return;
    }
    if (loaders.includes("experiment")) return store.refreshExperiment();
    if (loaders.includes("digest")) return store.refreshDigest();
    if (loaders.includes("findings")) return store.refreshLearning({ kinds: findingKindsForSegment(insightSegment), includeRankings: loaders.includes("rankings") });
  }, [insightSegment, open, recordSegment, store.refresh, store.refreshBreakdown, store.refreshDigest, store.refreshExperiment, store.refreshLearning, store.refreshPrices, store.refreshUsage, surface]);

  useEffect(() => { void refreshVisibleSegment(); }, [refreshVisibleSegment, store.preset, store.customFrom, store.customTo, store.includeSidechain, store.selection, store.leafDimension, store.granularity, store.usageBucket, store.breakdownDimension, store.digestDate, store.findingKind, store.findingQuery]);

  useEffect(() => {
    if (!open) return;
    let unlisten: (() => void) | undefined; let cancelled = false;
    store.setSummarizeEventsAvailable(true);
    void listenSummarizeProgress((progress) => store.applySummarizeProgress(progress)).then((fn) => { if (cancelled) fn(); else unlisten = fn; }).catch(() => { if (!cancelled) store.setSummarizeEventsAvailable(false); });
    return () => { cancelled = true; unlisten?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let unlisten: (() => void) | undefined; let cancelled = false;
    store.setIndexEventsAvailable(true);
    void listenIndexProgress((progress) => store.applyIndexProgress(progress)).then((fn) => { if (cancelled) fn(); else unlisten = fn; }).catch(() => { if (!cancelled) store.setIndexEventsAvailable(false); });
    return () => { cancelled = true; unlisten?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const running = store.index.status?.running ?? false;
  const summarizing = store.summarize.status?.running ?? false;
  useAilogPolling({ open, indexRunning: running, summarizeRunning: summarizing, eventsHealthy: (!running || store.index.eventsAvailable) && (!summarizing || store.summarize.eventsAvailable), refreshIndexStatus: store.refreshIndexStatus, refreshSummarizeStatus: store.refreshSummarizeStatus, refreshReports: refreshVisibleSegment });

  if (!visible) return null;
  const indexStatus = store.index.status; const summarizeStatus = store.summarize.status;
  const statusPending = indexStatus === null && store.index.statusError === null;
  const neverIndexed = indexStatus !== null && indexStatus.lastFinishedAt === 0;
  const noData = Boolean(store.overview) && (store.overview?.totals.sessions ?? 0) === 0;
  const openDetail = (kind: string, sessionId: string) => { setDetailOpen(true); void store.openDetail(kind, sessionId); };
  const activeRecordLoad = () => void refreshVisibleSegment();
  const dailyDigestLinkLabel = "その日のまとめへ";
  const runExplicitLlm = (intent: string, action: () => Promise<void>) => {
    if (!aiEnabled) return;
    if (isExplicitLlmIntent(intent)) void action();
  };
  const openDailyDigest = (day: number) => {
    const target = dailyDigestNavigation(toDayInput(day));
    setSurface(target.surface); setInsightSegment(target.segment); store.setDigestDate(target.date);
  };
  const openRecordBreakdown = (day: number) => {
    const target = recordBreakdownNavigation(toDayInput(day));
    setSurface(target.surface); setRecordSegment(target.segment); store.setCustomRange(target.from, target.to);
  };
  const changeInsightSegment = (segment: InsightSegment) => {
    const allowed = findingKindsForSegment(segment);
    if (allowed.length > 0 && store.findingKind && !allowed.includes(store.findingKind)) store.setFindingKind(null);
    setInsightSegment(segment);
  };
  const closePanel = () => { closeDetail(); onClose(); };

  return <OverlayShell open={open} closing={closing} onClose={closePanel} closeOnEscape={!detailOpen} size="full" ariaLabel="AIログ分析" id="ailog-panel">
    <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--cmux-border)" }}>
      <div><div style={{ fontSize: 14, fontWeight: 700 }}>AI ログ分析</div><div role="status" aria-live="polite" style={{ ...noteStyle, marginTop: 2 }}>{store.loading ? "集計を更新中…" : store.overview ? `${store.overview.range.label} · ${store.overview.totals.sessions.toLocaleString("en-US")} セッション` : "—"}</div></div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}><button type="button" aria-pressed={surface === "record"} onClick={() => setSurface("record")} style={subtleButtonStyle}>使った量</button><button type="button" aria-pressed={surface === "insight"} onClick={() => setSurface("insight")} style={subtleButtonStyle}>わかったこと</button><button type="button" aria-label="閉じる" onClick={closePanel} style={{ ...subtleButtonStyle, padding: "3px 8px" }}>×</button></div>
    </header>
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}><div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "12px 16px 20px", minWidth: 0 }}>
      {(running && !store.index.eventsAvailable) || (summarizing && !store.summarize.eventsAvailable) ? <div style={noteStyle}>進捗イベントに接続できないため、状態を短い間隔で確認しています。</div> : null}
      {surface === "record" ? <>
        <RangeBar preset={store.preset} customFrom={store.customFrom} customTo={store.customTo} onPreset={store.setPreset} onCustomRange={store.setCustomRange} summaryPreset={store.summaryPreset} onSummaryPreset={store.setSummaryPreset} overview={store.overview} indexStatus={indexStatus} indexProgress={store.index.progress} indexError={jobDisplayError(store.index)} onDismissIndexError={store.dismissIndexError} onStartIndex={() => void store.startIndex(false)} onCancelIndex={() => void store.cancelIndex()} summarizeStatus={summarizeStatus} summarizeProgress={store.summarize.progress} summarizeError={jobDisplayError(store.summarize)} onDismissSummarizeError={store.dismissSummarizeError} onStartSummarize={() => runExplicitLlm("startSummarize", () => store.startSummarize())} aiDisabledReason={aiDisabledReason} onCancelSummarize={() => void store.cancelSummarize()} onRefresh={activeRecordLoad} loading={recordSegment === "when" ? store.usageLoading : recordSegment === "what" ? store.loading : store.experimentLoading} excludeSynthetic={store.excludeSynthetic} onExcludeSynthetic={store.setExcludeSynthetic} includeSidechain={store.includeSidechain} onIncludeSidechain={store.setIncludeSidechain} />
        <Segment buttons={[['when','いつ・どれだけ'],['what','何に'],['how','使い方で変わる？']]} value={recordSegment} onChange={setRecordSegment} />
        {recordSegment === "when" ? (statusPending ? <div style={noteStyle}>インデックス状態を確認中です…</div> : neverIndexed ? <EmptyState kind="not-indexed" onPrimary={() => void store.startIndex(false)} busy={indexStatus?.running} /> : <UsageView series={store.usageSeries} rhythm={store.usageRhythm} loading={store.usageLoading} error={store.usageError} metric={store.usageMetric} onMetric={store.setUsageMetric} stack={store.usageStack} onStack={store.setUsageStack} bucket={store.usageBucket} onBucket={store.setUsageBucket} granularity={store.granularity} onGranularity={store.setGranularity} rangeReady={store.currentRange() !== null} selectionLabel={store.selection?.key ?? null} onClearSelection={() => store.setSelection(null)} onRetry={() => void store.refreshUsage()} onReindex={() => void store.startIndex(false)} onPickDay={(day) => { const value = toDayInput(day); store.setCustomRange(value, value); }} onOpenDigest={openDailyDigest} digestLinkLabel={dailyDigestLinkLabel} />) : null}
        {recordSegment === "what" ? <><RecordBreakdownView overview={store.overview} series={store.series} models={store.models} sessions={store.sessions} loading={store.loading} error={store.dashboardError} statusPending={statusPending} neverIndexed={neverIndexed} noData={noData} running={running} preset={store.preset} excludeSynthetic={store.excludeSynthetic} topN={store.topN} granularity={store.granularity} selection={store.selection} breakdownDimension={store.breakdownDimension} breakdown={store.breakdown} breakdownError={store.breakdownError} sessionSort={store.sessionSort} sessionPage={store.sessionPage} leafDimension={store.leafDimension} detailKey={store.detailKey} onRefresh={() => void refreshVisibleSegment()} onStartIndex={() => void store.startIndex(false)} onSelectRange={store.setCustomRange} onTopN={store.setTopN} onGranularity={store.setGranularity} onSelect={store.setSelection} onBreakdownDimension={store.setBreakdownDimension} onRefreshBreakdown={() => void store.refreshBreakdown()} onSessionSort={store.setSessionSort} onSessionPage={store.setSessionPage} onOpenDetail={openDetail} /><Section title="単価設定"><PriceSettings prices={store.prices} unpricedModels={store.overview?.unpricedModels ?? []} loading={store.pricesLoading} error={store.pricesError} repricedSessions={store.repricedSessions} onSave={async (entry) => { if (await store.savePrice(entry)) await refreshVisibleSegment(); }} /></Section></> : null}
        {recordSegment === "how" ? <ExperimentView report={store.efficiency} rules={store.ruleCheck} loading={store.experimentLoading} error={store.experimentError} onOpenDetail={openDetail} /> : null}
      </> : <>
        <Segment buttons={[['daily','その日のまとめ'],['recurring','何度も起きてること'],['decisions','決めたこと']]} value={insightSegment} onChange={changeInsightSegment} />
        {insightSegment === "daily" ? <DigestView report={store.digestReport} loading={store.digestLoading} generating={store.digestGenerating} error={store.digestError} onRetry={() => void store.refreshDigest()} onPrevious={() => store.stepDigestDate(-1)} onNext={() => store.stepDigestDate(1)} onRegenerate={() => runExplicitLlm("regenerateDigest", () => store.generateDigest(true))} summarizeStatus={summarizeStatus} summarizeError={jobDisplayError(store.summarize)} onStartSummarize={() => runExplicitLlm("startSummarize", () => store.startSummarize())} aiDisabledReason={aiDisabledReason} /> : <LearningView findings={store.findings} rankings={store.rankings} hasMore={store.learningHasMore} kind={store.findingKind} query={store.findingQuery} loading={store.learningLoading} error={store.learningError} onKindChange={store.setFindingKind} onQueryChange={store.setFindingQuery} onLoadMore={() => void store.refreshLearning({ append: true, kinds: findingKindsForSegment(insightSegment), includeRankings: insightSegment === "recurring" })} onOpenDetail={openDetail} onOpenBreakdown={openRecordBreakdown} title={insightSegment === "recurring" ? "何度も起きてること" : "決めたこと"} allowedKinds={findingKindsForSegment(insightSegment)} showRankings={insightSegment === "recurring"} />}
      </>}
    </div></div>
    {detailOpen ? <OverlayShell open={detailOpen} onClose={closeDetail} size="wide" layer="top" ariaLabel="セッション詳細">{store.detailError ? <EmptyState kind="error" message={store.detailError} onPrimary={() => store.detailKey ? void store.openDetail(store.detailKey.kind, store.detailKey.sessionId) : undefined} primaryLabel="再試行" /> : store.detailLoading ? <div style={{ padding: 16 }}><SkeletonBlock height={120} label="詳細を読み込み中" /></div> : store.detail ? <div style={{ padding: 16, overflowY: "auto" }}><SessionDetailView detail={store.detail} transcript={store.transcript} transcriptLoading={store.transcriptLoading} transcriptError={store.transcriptError} sessionSummarizing={store.sessionSummarizing} sessionSummarizeError={store.sessionSummarizeError} aiDisabledReason={aiDisabledReason} onSummarize={() => runExplicitLlm("summarizeSession", () => store.summarizeSession(store.detail!.session.kind, store.detail!.session.sessionId))} onClose={closeDetail} /></div> : null}</OverlayShell> : null}
  </OverlayShell>;
}

function Segment<T extends string>({ buttons, value, onChange }: { buttons: readonly (readonly [T, string])[]; value: T; onChange: (value: T) => void }) {
  return <div role="group" aria-label="段" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>{buttons.map(([id, label]) => <button key={id} type="button" aria-pressed={value === id} onClick={() => onChange(id)} style={subtleButtonStyle}>{label}</button>)}</div>;
}
