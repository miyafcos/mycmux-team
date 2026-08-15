/** The one-surface AI log dashboard. Navigation never starts LLM work. */
import { Fragment, useCallback, useEffect, useLayoutEffect, useState } from "react";

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
import { RangeBar } from "./RangeBar";
import { SessionDetailView } from "./SessionDetailView";
import { dailyDigestNavigation, findingKindsForSegment, isExplicitLlmIntent, recordBreakdownNavigation, type PanelSegment } from "./panelModel";
import { EmptyState, RefreshingBlock, SkeletonBlock, noteStyle, subtleButtonStyle } from "./ui";
import { UsageView } from "./UsageView";

interface AiLogPanelProps { open: boolean; visible: boolean; closing?: boolean; onClose: () => void; }

export function AiLogPanel({ open, visible, closing = false, onClose }: AiLogPanelProps) {
  const [segment, setSegment] = useState<PanelSegment>("when");
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
    setSegment("when");
    closeDetail();
  }, [closeDetail, open]);
  useEffect(() => () => { store.closeDetail(); }, [store.closeDetail]);

  const refreshVisibleSegment = useCallback(async (force = false): Promise<void> => {
    if (!open) return;
    await store.loadSegment(segment, { force });
    void store.preloadSegments(segment);
  }, [open, segment, store.loadSegment, store.preloadSegments]);

  useLayoutEffect(() => { void refreshVisibleSegment(); }, [refreshVisibleSegment, store.preset, store.customFrom, store.customTo, store.excludeSynthetic, store.includeSidechain, store.selection, store.leafDimension, store.granularity, store.usageBucket, store.breakdownDimension, store.digestDate, store.findingKind, store.findingQuery]);

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
  const visibleBusy = segment === "when"
    ? store.usageLoading
    : segment === "what"
      ? store.loading || store.breakdownLoading
      : segment === "how"
        ? store.experimentLoading
        : segment === "daily"
          ? store.digestLoading || store.digestGenerating
          : store.learningLoading;
  const indexStatus = store.index.status; const summarizeStatus = store.summarize.status;
  const statusPending = indexStatus === null && store.index.statusError === null;
  const neverIndexed = indexStatus !== null && indexStatus.lastFinishedAt === 0;
  const noData = Boolean(store.overview) && (store.overview?.totals.sessions ?? 0) === 0;
  const openDetail = (kind: string, sessionId: string) => { setDetailOpen(true); void store.openDetail(kind, sessionId); };
  const activeSegmentLoad = () => void refreshVisibleSegment(true);
  const dailyDigestLinkLabel = "日別まとめへ";
  const runExplicitLlm = (intent: string, action: () => Promise<void>) => {
    if (!aiEnabled) return;
    if (isExplicitLlmIntent(intent)) void action();
  };
  const openDailyDigest = (day: number) => {
    const target = dailyDigestNavigation(toDayInput(day));
    setSegment(target.segment); store.setDigestDate(target.date);
  };
  const openRecordBreakdown = (day: number) => {
    const target = recordBreakdownNavigation(toDayInput(day));
    setSegment(target.segment); store.setCustomRange(target.from, target.to);
  };
  const changeSegment = (nextSegment: PanelSegment) => {
    const allowed = nextSegment === "recurring" || nextSegment === "decisions" ? findingKindsForSegment(nextSegment) : [];
    if (allowed.length > 0 && store.findingKind && !allowed.includes(store.findingKind)) store.setFindingKind(null);
    setSegment(nextSegment);
  };
  const closePanel = () => { closeDetail(); onClose(); };
  const recordBreakdownContent = <RecordBreakdownView overview={store.overview} series={store.series} models={store.models} sessions={store.sessions} loading={store.loading} error={store.dashboardError} statusPending={statusPending} neverIndexed={neverIndexed} noData={noData} running={running} preset={store.preset} excludeSynthetic={store.excludeSynthetic} topN={store.topN} selection={store.selection} breakdownDimension={store.breakdownDimension} breakdown={store.breakdown} breakdownError={store.breakdownError} breakdownLoading={store.breakdownLoading} sessionSort={store.sessionSort} sessionPage={store.sessionPage} leafDimension={store.leafDimension} detailKey={store.detailKey} onRefresh={activeSegmentLoad} onStartIndex={() => void store.startIndex(false)} onSelectRange={store.setCustomRange} onTopN={store.setTopN} onSelect={store.setSelection} onBreakdownDimension={store.setBreakdownDimension} onRefreshBreakdown={() => void store.refreshBreakdown({ force: true })} onSessionSort={store.setSessionSort} onSessionPage={store.setSessionPage} onOpenDetail={openDetail} />;

  return <OverlayShell open={open} closing={closing} onClose={closePanel} closeOnEscape={!detailOpen} size="full" ariaLabel="AIログ分析" id="ailog-panel">
    <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--cmux-border)" }}>
      <div><div style={{ fontSize: 14, fontWeight: 700 }}>AI ログ分析</div><div role="status" aria-live="polite" style={{ ...noteStyle, marginTop: 2 }}>{visibleBusy ? "集計を更新中…" : store.overview ? `${store.overview.range.label} · ${store.overview.totals.sessions.toLocaleString("en-US")} セッション` : "—"}</div></div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}><button type="button" aria-label="閉じる" onClick={closePanel} style={{ ...subtleButtonStyle, padding: "3px 8px" }}>×</button></div>
    </header>
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}><div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "12px 16px 20px", minWidth: 0 }}>
      {(running && !store.index.eventsAvailable) || (summarizing && !store.summarize.eventsAvailable) ? <div style={noteStyle}>進捗イベントに接続できないため、状態を短い間隔で確認しています。</div> : null}
      <RangeBar preset={store.preset} customFrom={store.customFrom} customTo={store.customTo} onPreset={store.setPreset} onCustomRange={store.setCustomRange} summaryPreset={store.summaryPreset} onSummaryPreset={store.setSummaryPreset} overview={store.overview} usageRhythm={store.usageRhythm} indexStatus={indexStatus} indexProgress={store.index.progress} indexError={jobDisplayError(store.index)} onDismissIndexError={store.dismissIndexError} onStartIndex={() => void store.startIndex(false)} onCancelIndex={() => void store.cancelIndex()} summarizeStatus={summarizeStatus} summarizeProgress={store.summarize.progress} summarizeError={jobDisplayError(store.summarize)} onDismissSummarizeError={store.dismissSummarizeError} onStartSummarize={() => runExplicitLlm("startSummarize", () => store.startSummarize())} aiDisabledReason={aiDisabledReason} onCancelSummarize={() => void store.cancelSummarize()} onRefresh={activeSegmentLoad} loading={visibleBusy} excludeSynthetic={store.excludeSynthetic} onExcludeSynthetic={store.setExcludeSynthetic} includeSidechain={store.includeSidechain} onIncludeSidechain={store.setIncludeSidechain} />
      <Segment buttons={[['when','全体'],['what','内訳'],['how','比較'],['daily','日別まとめ'],['recurring','繰り返しの罠'],['decisions','決定事項']]} value={segment} onChange={changeSegment} />
      {segment === "when" ? (
          statusPending ? <div style={noteStyle}>インデックス状態を確認中です…</div>
            : neverIndexed ? <EmptyState kind="not-indexed" onPrimary={() => void store.startIndex(false)} busy={indexStatus?.running} />
              : store.usageSeries && store.usageRhythm ? <RefreshingBlock busy={visibleBusy}><UsageView series={store.usageSeries} rhythm={store.usageRhythm} loading={store.usageLoading} error={store.usageError} metric={store.usageMetric} onMetric={store.setUsageMetric} stack={store.usageStack} onStack={store.setUsageStack} bucket={store.usageBucket} onBucket={store.setUsageBucket} granularity={store.granularity} onGranularity={store.setGranularity} rangeReady={store.currentRange() !== null} onRetry={() => void store.refreshUsage({ force: true })} onPickDay={(day) => { const value = toDayInput(day); store.setCustomRange(value, value); }} onOpenDigest={openDailyDigest} digestLinkLabel={dailyDigestLinkLabel} /></RefreshingBlock>
                : <UsageView series={store.usageSeries} rhythm={store.usageRhythm} loading={store.usageLoading} error={store.usageError} metric={store.usageMetric} onMetric={store.setUsageMetric} stack={store.usageStack} onStack={store.setUsageStack} bucket={store.usageBucket} onBucket={store.setUsageBucket} granularity={store.granularity} onGranularity={store.setGranularity} rangeReady={store.currentRange() !== null} onRetry={() => void store.refreshUsage({ force: true })} onPickDay={(day) => { const value = toDayInput(day); store.setCustomRange(value, value); }} onOpenDigest={openDailyDigest} digestLinkLabel={dailyDigestLinkLabel} />
        ) : null}
      {segment === "what" ? (store.overview ? <RefreshingBlock busy={visibleBusy}>{recordBreakdownContent}</RefreshingBlock> : recordBreakdownContent) : null}
      {segment === "how" ? (store.efficiency && store.ruleCheck ? <RefreshingBlock busy={visibleBusy}><ExperimentView report={store.efficiency} rules={store.ruleCheck} loading={store.experimentLoading} error={store.experimentError} onOpenDetail={openDetail} /></RefreshingBlock> : <ExperimentView report={store.efficiency} rules={store.ruleCheck} loading={store.experimentLoading} error={store.experimentError} onOpenDetail={openDetail} />) : null}
      {segment === "daily" ? (
          store.digestReport ? <RefreshingBlock busy={visibleBusy}><DigestView report={store.digestReport} loading={store.digestLoading} generating={store.digestGenerating} error={store.digestError} onRetry={() => void store.refreshDigest(undefined, { force: true })} onPrevious={() => store.stepDigestDate(-1)} onNext={() => store.stepDigestDate(1)} onRegenerate={() => runExplicitLlm("regenerateDigest", () => store.generateDigest(true))} summarizeStatus={summarizeStatus} summarizeError={jobDisplayError(store.summarize)} onStartSummarize={() => runExplicitLlm("startSummarize", () => store.startSummarize())} aiDisabledReason={aiDisabledReason} /></RefreshingBlock>
            : <DigestView report={store.digestReport} loading={store.digestLoading} generating={store.digestGenerating} error={store.digestError} onRetry={() => void store.refreshDigest(undefined, { force: true })} onPrevious={() => store.stepDigestDate(-1)} onNext={() => store.stepDigestDate(1)} onRegenerate={() => runExplicitLlm("regenerateDigest", () => store.generateDigest(true))} summarizeStatus={summarizeStatus} summarizeError={jobDisplayError(store.summarize)} onStartSummarize={() => runExplicitLlm("startSummarize", () => store.startSummarize())} aiDisabledReason={aiDisabledReason} />
      ) : null}
      {segment === "recurring" || segment === "decisions" ? (
        store.findings ? <RefreshingBlock busy={visibleBusy}><LearningView findings={store.findings} rankings={store.rankings} hasMore={store.learningHasMore} kind={store.findingKind} query={store.findingQuery} loading={store.learningLoading} error={store.learningError} onKindChange={store.setFindingKind} onQueryChange={store.setFindingQuery} onLoadMore={() => void store.refreshLearning({ append: true, kinds: findingKindsForSegment(segment), includeRankings: segment === "recurring" })} onOpenDetail={openDetail} onOpenBreakdown={openRecordBreakdown} title={segment === "recurring" ? "繰り返しの罠" : "決定事項"} allowedKinds={findingKindsForSegment(segment)} showRankings={segment === "recurring"} /></RefreshingBlock>
          : <LearningView findings={store.findings} rankings={store.rankings} hasMore={store.learningHasMore} kind={store.findingKind} query={store.findingQuery} loading={store.learningLoading} error={store.learningError} onKindChange={store.setFindingKind} onQueryChange={store.setFindingQuery} onLoadMore={() => void store.refreshLearning({ append: true, kinds: findingKindsForSegment(segment), includeRankings: segment === "recurring" })} onOpenDetail={openDetail} onOpenBreakdown={openRecordBreakdown} title={segment === "recurring" ? "繰り返しの罠" : "決定事項"} allowedKinds={findingKindsForSegment(segment)} showRankings={segment === "recurring"} />
      ) : null}
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
