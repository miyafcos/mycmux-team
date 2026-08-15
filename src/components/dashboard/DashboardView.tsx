import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { focusController } from "../../lib/focusController";
import { useDashboardViewStore } from "../../stores/dashboardViewStore";
import { useComposerStore } from "../../stores/composerStore";
import {
  connectLiveBriefStore,
  LIVE_EVENT_VISIBLE_LIMIT,
  stopEventPolling,
  syncDashboardEvents,
  useLiveBriefStore,
} from "../../stores/liveBriefStore";
import { usePaneMetadataStore, useUiStore, useWorkspaceLayoutStore, useWorkspaceListStore } from "../../stores/workspaceStore";
import { useSessionAttentionStore } from "../../stores/sessionAttentionStore";
import { useStallStore } from "../../stores/stallStore";
import { connectReportInboxStatusFeed, useReportInboxStore, type MachineReportCard } from "../../stores/reportInboxStore";
import { hasTerminalBuffer } from "../terminal/XTermWrapper";
import { DashboardTelemetryFallback } from "./DashboardSessionDetail";
import { DashboardSessionList, useFrozenCardOrder } from "./DashboardSessionList";
import { AskStrip } from "./AskStrip";
import { buildAskStripItems } from "./askStripModel";
import { WatchStatusRow } from "./WatchStatusRow";
import { ChatTranscript } from "./ChatTranscript";
import { QuestionCard } from "./QuestionCard";
import {
  applyDashboardFilters,
  buildDashboardCards,
  needsHumanCards,
  orderDashboardCards,
  partitionDashboardCards,
  type DashboardCardModel,
} from "./dashboardModel";
import { orderCardsByAttentionSection } from "./dashboardAttentionOrder";
import { dashboardStrings } from "./dashboardStrings";
import {
  chooseOption,
  isInterventionAccepted,
  questionModel,
  useInterventionFeedbackStore,
} from "./interventionRouting";
import { ReplyComposer } from "./ReplyComposer";
import { targetKey } from "../../lib/livebrief";
import { LayoutMinimapPanel } from "./LayoutMinimapPanel";
import { resolveDisplayState } from "./dashboardModel";
import { displayStateColor, displayStateLabel, stallLabel, statePillStyle } from "./DashboardCardRow";
import { stateLabels } from "./stateLabels";
import { ReportInbox } from "./ReportInbox";
import "./DashboardView.css";

/** 番号キーで撃てる選択肢。ここを増やすなら dashboardStrings.numberKeyHint も直す。 */
const NUMBER_KEYS = ["1", "2", "3"];

export function DashboardView({ onClose }: { onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const now = Date.now();
  const [listHovered, setListHovered] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const viewState = useDashboardViewStore(useShallow((state) => ({
    query: state.query,
    workspaceFilter: state.workspaceFilter,
    agentFilter: state.agentFilter,
    stateFilter: state.stateFilter,
    selectedTabId: state.selectedTabId,
    reportInboxOpen: state.reportInboxOpen,
    highlightedEventId: state.highlightedEventId,
    highlightedEventRequest: state.highlightedEventRequest,
    setQuery: state.setQuery,
    setWorkspaceFilter: state.setWorkspaceFilter,
    setAgentFilter: state.setAgentFilter,
    setStateFilter: state.setStateFilter,
    setSelectedTabId: state.setSelectedTabId,
    openReportInbox: state.openReportInbox,
    closeReportInbox: state.closeReportInbox,
    setHighlightedEventId: state.setHighlightedEventId,
  })));
  const workspaces = useWorkspaceListStore((state) => state.workspaces);
  const activePaneSessionId = useUiStore((state) => state.activePaneId);
  const metadataState = usePaneMetadataStore(useShallow((state) => ({
    metadata: state.metadata,
    lastLog: state.lastLog,
    lastLogAt: state.lastLogAt,
  })));
  const stallsBySession = useStallStore((state) => state.entries);
  const attentionState = useSessionAttentionStore(useShallow((state) => ({
    attentionBySession: state.attentionBySession,
    seenAttentionByTab: state.seenAttentionByTab,
  })));
  const briefsBySession = useLiveBriefStore((state) => state.briefsBySession);
  const listEventsBySession = useLiveBriefStore((state) => state.listEventsBySession);
  const reportInboxState = useReportInboxStore(useShallow((state) => ({
    cardIds: state.cardIds,
    cardsById: state.cardsById,
    receiveModeBySession: state.receiveModeBySession,
    ingestLiveBriefs: state.ingestLiveBriefs,
    ingestSemanticEvents: state.ingestSemanticEvents,
    setReceiveMode: state.setReceiveMode,
  })));
  const reportCards = useMemo(() => reportInboxState.cardIds
    .map((id) => reportInboxState.cardsById[id])
    .filter((card): card is MachineReportCard => card !== undefined), [reportInboxState.cardIds, reportInboxState.cardsById]);
  const cards = useMemo(() => buildDashboardCards(workspaces, {
    metadataBySession: metadataState.metadata,
    lastLogBySession: metadataState.lastLog,
    lastLogAtBySession: metadataState.lastLogAt,
    attentionBySession: attentionState.attentionBySession,
    seenAttentionByTab: attentionState.seenAttentionByTab,
    stallsBySession,
    briefsBySession,
    now,
    hasTerminalBuffer,
  }), [attentionState, briefsBySession, metadataState, now, stallsBySession, workspaces]);
  const minimapDisplayStateByTabId = useMemo(() => new Map(cards.map((card) => [card.tab.id, resolveDisplayState(card)] as const)), [cards]);
  const filteredCards = useMemo(() => applyDashboardFilters(cards, {
    query: viewState.query,
    workspaceId: null,
    needsHumanOnly: false,
    agentKind: null,
    stateFilter: null,
  }), [cards, viewState.query]);

  // 並べ替えの凍結: ポインタが一覧の上にある / 検索中は直前の並びを維持する。
  const frozen = listHovered || searchFocused;
  const liveOrdered = useMemo(() => orderDashboardCards(filteredCards, "attention"), [filteredCards]);
  const orderedCards = useFrozenCardOrder(liveOrdered, frozen);
  const liveUrgent = useMemo(() => needsHumanCards(filteredCards), [filteredCards]);
  const urgentCards = useFrozenCardOrder(liveUrgent, frozen);
  const partitions = useMemo(() => partitionDashboardCards(orderedCards), [orderedCards]);
  const visibleCards = useMemo(() => orderCardsByAttentionSection([
      ...urgentCards,
      ...partitions.active,
      ...partitions.deferred,
    ]), [partitions, urgentCards]);
  const selectedCard = visibleCards.find((card) => card.tab.id === viewState.selectedTabId) ?? visibleCards[0] ?? null;
  const selectedSessionId = selectedCard?.tab.sessionId ?? null;
  const highlightedReport = useMemo(() => reportCards.find((card) => (
    card.ptySessionId === selectedSessionId && card.sourceEventId === viewState.highlightedEventId
  )) ?? null, [reportCards, selectedSessionId, viewState.highlightedEventId]);
  const selectedEvents = useLiveBriefStore((state) => (
    selectedSessionId ? state.eventsBySession[selectedSessionId] : undefined
  ));
  const transcriptEvents = selectedEvents?.length
    ? selectedEvents
    : selectedSessionId ? listEventsBySession[selectedSessionId] ?? [] : [];
  const selectedDisplayState = selectedCard ? resolveDisplayState(selectedCard) : "idle";
  const selectedEventOutputAt = (selectedEvents ?? []).reduce((latest, event) => (
    event.kind.type === "agentMessage" || event.kind.type === "toolEnd" || event.kind.type === "error"
      ? Math.max(latest, event.occurredAt)
      : latest
  ), 0);
  const selectedLastOutputAt = selectedCard?.metadata?.backendLastOutputAt
    ?? (selectedEventOutputAt || null);
  const selectedElapsedMinutes = selectedCard?.noUpdateMinutes
    ?? (selectedCard?.lastActivityAt ? Math.max(0, Math.floor((now - selectedCard.lastActivityAt) / 60_000)) : null);
  const selectedElapsedText = selectedElapsedMinutes === null
    ? ""
    : selectedDisplayState === "noUpdate"
      ? dashboardStrings.noUpdateFor(selectedElapsedMinutes)
      : dashboardStrings.elapsed(selectedElapsedMinutes);
  const askItems = useMemo(() => buildAskStripItems(filteredCards.map((card) => ({
    tabId: card.tab.id,
    sessionId: card.tab.sessionId,
    label: card.label,
    brief: card.brief,
    events: listEventsBySession?.[card.tab.sessionId],
  }))), [filteredCards, listEventsBySession]);
  // 「既読にする」対象は未読の done 通知そのもの。表示状態 (done) とは一致しないことがある。
  const clearableCards = useMemo(
    () => cards.filter((card) => card.attentionCategory === "done" && card.attention?.attentionId),
    [cards],
  );
  const filterActive = Boolean(viewState.query);

  useEffect(() => {
    focusController.request("programmatic", { sessionId: null, focus: false });
    window.setTimeout(() => rootRef.current?.focus(), 0);
  }, []);

  // brief の購読はビュー1枚につき1本 (store 側が参照数で束ねる)。
  useEffect(() => connectLiveBriefStore(), []);
  useEffect(() => connectReportInboxStatusFeed(), []);

  // Reuse the dashboard's existing LiveBrief data. This only derives cards
  // from already-fetched events and never starts a separate poller.
  useEffect(() => reportInboxState.ingestLiveBriefs(Object.values(briefsBySession)), [briefsBySession, reportInboxState]);
  useEffect(() => {
    for (const [sessionId, events] of Object.entries(listEventsBySession)) {
      reportInboxState.ingestSemanticEvents(sessionId, events);
    }
  }, [listEventsBySession, reportInboxState]);

  // 意味イベントの取得は「表示中の全セッション (浅く)」+「選択中1本 (深く)」。
  // 要対応 → 選択中 → 表示順、の優先で上限まで詰める。
  const visibleKey = useMemo(() => {
    const ids: string[] = [];
    const push = (id: string | null) => { if (id && !ids.includes(id)) ids.push(id); };
    for (const card of urgentCards) push(card.tab.sessionId);
    push(selectedSessionId);
    for (const card of visibleCards) push(card.tab.sessionId);
    return ids.slice(0, LIVE_EVENT_VISIBLE_LIMIT).join(",");
  }, [selectedSessionId, urgentCards, visibleCards]);
  useEffect(() => {
    syncDashboardEvents({
      selectedId: selectedSessionId,
      visibleIds: visibleKey ? visibleKey.split(",") : [],
    });
  }, [selectedSessionId, visibleKey]);
  // ビューを閉じたら両方止める (張り替えでは止めない)。
  useEffect(() => () => stopEventPolling(), []);
  // 介入の結果表示は開いている間だけのもの。次に開いたとき前回の結果が残っていると、
  // 古い成功で勝手にカードが送られる (自動選択移動) ので閉じたら捨てる。
  useEffect(() => () => useInterventionFeedbackStore.getState().reset(), []);

  useEffect(() => {
    if (!viewState.selectedTabId && selectedCard) viewState.setSelectedTabId(selectedCard.tab.id);
  }, [selectedCard, viewState]);

  // 介入が通ったら次の要対応へ送る。ただし打ちかけの下書きがあるうちは動かさない。
  const selectedDraft = useComposerStore((state) => (selectedSessionId ? state.draftBySession[selectedSessionId] ?? "" : ""));
  const selectedTargetKey = selectedCard?.brief ? targetKey(selectedCard.brief) : null;
  const selectedResult = useInterventionFeedbackStore((state) => (selectedTargetKey ? state.resultByTarget[selectedTargetKey] : undefined));
  const advancedResultRef = useRef<unknown>(undefined);
  useEffect(() => {
    if (!selectedResult || advancedResultRef.current === selectedResult) return;
    advancedResultRef.current = selectedResult;
    if (!isInterventionAccepted(selectedResult) || selectedDraft.trim()) return;
    const next = urgentCards.find((card) => card.tab.id !== selectedCard?.tab.id);
    if (next) viewState.setSelectedTabId(next.tab.id);
  }, [selectedCard, selectedDraft, selectedResult, urgentCards, viewState]);

  // This entry point belongs to QuestionCard, so command kind is determined by
  // the UI action rather than inferred from whatever the user later types.
  const focusComposer = useCallback((questionBrief: typeof selectedCard.brief) => {
    if (selectedSessionId) {
      const composer = useComposerStore.getState();
      composer.setCommandKind(selectedSessionId, "answer-forward");
      composer.setQuestionGuard(selectedSessionId, questionBrief?.promptEventId
        ? { questionId: questionBrief.promptEventId, revision: questionBrief.ptyInputRevision }
        : null);
    }
    composerRef.current?.focus();
  }, [selectedSessionId]);
  const selectFromMinimap = useCallback((tabId: string) => {
    if (viewState.query) viewState.setQuery("");
    viewState.setSelectedTabId(tabId);
  }, [viewState]);
  const openReportSource = useCallback((report: MachineReportCard) => {
    const target = cards.find((card) => card.tab.sessionId === report.ptySessionId);
    if (!target) return;
    viewState.setSelectedTabId(target.tab.id);
    viewState.setHighlightedEventId(report.sourceEventId);
  }, [cards, viewState]);
  const selectQuestion = useCallback((tabId: string, sessionId: string) => {
    viewState.setSelectedTabId(tabId);
    window.requestAnimationFrame(() => document.getElementById(`dashboard-question-${sessionId}`)?.scrollIntoView({ block: "nearest" }));
  }, [viewState]);

  const close = useCallback(() => {
    onClose();
    focusController.focusSessionSoon(useUiStore.getState().lastActivePaneId);
  }, [onClose]);
  const jumpToCard = useCallback((card: DashboardCardModel) => {
    const keepZoom = useUiStore.getState().zoomedPaneId !== null;
    useWorkspaceListStore.getState().setActiveWorkspace(card.workspaceId);
    useWorkspaceLayoutStore.getState().setActivePaneTab(card.workspaceId, card.paneId, card.tab.id);
    if (keepZoom) useUiStore.getState().setZoomedPaneId(card.paneId);
    if (card.tab.type === undefined || card.tab.type === "terminal") {
      focusController.request("programmatic", { sessionId: card.tab.sessionId, focus: true });
    } else {
      focusController.request("programmatic", { sessionId: null, focus: false });
    }
    onClose();
  }, [onClose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "g") return;
      const target = event.target as HTMLElement | null;
      const interactive = target instanceof HTMLButtonElement || target instanceof HTMLSelectElement || Boolean(target?.closest("[data-livebrief-interactive='true']"));
      const editable = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || Boolean(target?.isContentEditable) || interactive;
      if (editable) {
        if (event.isComposing) return;
        if (event.key === "Escape" && viewState.query) {
          event.preventDefault();
          event.stopPropagation();
          viewState.setQuery("");
          rootRef.current?.focus();
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key === "/") {
        event.preventDefault();
        event.stopPropagation();
        searchRef.current?.focus();
        return;
      }
      if (event.key === "Enter" && selectedCard) {
        event.preventDefault();
        event.stopPropagation();
        jumpToCard(selectedCard);
        return;
      }
      if (event.key === "Tab") {
        if (!urgentCards.length) return;
        event.preventDefault();
        event.stopPropagation();
        const index = selectedCard ? urgentCards.findIndex((card) => card.tab.id === selectedCard.tab.id) : -1;
        viewState.setSelectedTabId(urgentCards[(index + 1 + urgentCards.length) % urgentCards.length].tab.id);
        return;
      }
      // 1/2/3: 選択中カードの選択肢をそのまま撃つ (カードのボタンと同じ経路)。
      // 選択肢が 4 個以上あるときは番号で撃たない (取り違えが起きる)。
      const numberIndex = NUMBER_KEYS.indexOf(event.key);
      if (numberIndex >= 0 && selectedCard) {
        const store = useLiveBriefStore.getState();
        const brief = store.briefsBySession[selectedCard.tab.sessionId];
        // 詳細スライスが空 (未取得・0件) なら一覧スライスで代替する。
        const detailEvents = store.eventsBySession[selectedCard.tab.sessionId];
        const events = detailEvents?.length ? detailEvents : store.listEventsBySession[selectedCard.tab.sessionId];
        const model = questionModel(brief, events);
        const option = model && model.canSend && model.options.length <= NUMBER_KEYS.length
          ? model.options[numberIndex]
          : undefined;
        if (option) {
          event.preventDefault();
          event.stopPropagation();
          void chooseOption(brief, option.id);
          return;
        }
      }
      const delta = event.key === "j" || event.key === "ArrowDown" ? 1 : event.key === "k" || event.key === "ArrowUp" ? -1 : 0;
      if (delta && visibleCards.length) {
        event.preventDefault();
        event.stopPropagation();
        const index = selectedCard ? visibleCards.findIndex((card) => card.tab.id === selectedCard.tab.id) : 0;
        viewState.setSelectedTabId(visibleCards[(index + delta + visibleCards.length) % visibleCards.length].tab.id);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close, jumpToCard, selectedCard, urgentCards, viewState, visibleCards]);

  const clearDone = () => {
    for (const card of clearableCards) {
      if (card.attention?.attentionId) {
        useSessionAttentionStore.getState().markSeen(card.tab.id, card.attention.attentionId);
      }
    }
  };
  const listControls = {
    query: viewState.query,
    searchInputRef: searchRef,
    onQueryChange: viewState.setQuery,
    onSearchFocusChange: setSearchFocused,
    onClose: close,
    clearDoneCount: clearableCards.length,
    onClearDone: clearDone,
    filteredSummary: filterActive ? dashboardStrings.filteredSummary(filteredCards.length, cards.length) : null,
    reportInboxCount: reportCards.length,
    reportInboxOpen: viewState.reportInboxOpen,
    onOpenReportInbox: viewState.openReportInbox,
  } as const;

  return <div ref={rootRef} tabIndex={-1} role="region" aria-label={dashboardStrings.viewAriaLabel} className="cmux-dashboard-view">
    <AskStrip items={askItems} onSelect={(item) => selectQuestion(item.tabId, item.sessionId)} />
    <WatchStatusRow now={now} />
    <div className="cmux-dashboard-shell">
      <DashboardSessionList
        {...listControls}
        needsHuman={urgentCards}
        all={partitions.active}
        deferred={partitions.deferred}
        hideWorkspaceBadge={false}
        selectedTabId={selectedCard?.tab.id ?? null}
        now={now}
        onSelect={viewState.setSelectedTabId}
        onJump={jumpToCard}
        onHoverChange={setListHovered}
      />
      <section data-dashboard-center="true" className="cmux-dashboard-chat-pane">
        <header className="cmux-dashboard-chat-header">
          <strong>{viewState.reportInboxOpen ? dashboardStrings.reportInboxTitle : selectedCard?.label ?? dashboardStrings.detailEmpty}</strong>
          {!viewState.reportInboxOpen && selectedCard ? <div className="cmux-dashboard-chat-header-meta">
            {selectedCard.neverStarted
              ? <span style={statePillStyle("var(--cmux-text-tertiary)")}>{dashboardStrings.stateNotStarted}</span>
              : <span title={stateLabels(selectedDisplayState).tooltip} aria-label={stateLabels(selectedDisplayState).tooltip} style={statePillStyle(displayStateColor(selectedDisplayState))}>{displayStateLabel(selectedDisplayState)}</span>}
            {selectedCard.telemetryHealth === "ended" ? <span style={statePillStyle("var(--cmux-text-tertiary)")}>{dashboardStrings.telemetryEnded}</span> : null}
            {selectedElapsedText ? <span>{selectedElapsedText}</span> : null}
            {selectedCard.stall ? <span className="cmux-dashboard-chat-header-stall">{stallLabel(selectedCard.stall.reason)}</span> : null}
          </div> : null}
          {!viewState.reportInboxOpen && selectedCard ? <span>{dashboardStrings.breadcrumb(selectedCard.workspace.name, selectedCard.tabIndex + 1, selectedCard.paneIndex + 1)}</span> : null}
          {!viewState.reportInboxOpen && selectedCard?.attentionCategory === "done" && selectedCard.attention?.attentionId
            ? <button type="button" className="cmux-dashboard-chat-header-action" onClick={() => useSessionAttentionStore.getState().markSeen(selectedCard.tab.id, selectedCard.attention?.attentionId ?? "")}>{dashboardStrings.markReadButton}</button>
            : null}
          {!viewState.reportInboxOpen && selectedCard ? <button type="button" className="cmux-dashboard-chat-header-action" title={dashboardStrings.jumpButtonTitle} onClick={() => jumpToCard(selectedCard)}>{dashboardStrings.jumpButtonTitle}</button> : null}
        </header>
        {viewState.reportInboxOpen ? <ReportInbox
          cards={reportCards}
          receiveModeBySession={reportInboxState.receiveModeBySession}
          onReceiveModeChange={reportInboxState.setReceiveMode}
          onOpenSource={openReportSource}
        /> : <>
          {selectedCard && selectedCard.telemetryHealth !== "live" && selectedCard.telemetryHealth !== "ended" ? <DashboardTelemetryFallback card={selectedCard} now={now} /> : null}
          <ChatTranscript
            events={transcriptEvents}
            sessionId={selectedSessionId}
            displayState={selectedDisplayState}
            agentKind={selectedCard?.agentKind ?? "none"}
            lastOutputAt={selectedLastOutputAt}
            targetEventId={viewState.highlightedEventId}
            targetEventRequest={viewState.highlightedEventRequest}
            syntheticSource={highlightedReport?.syntheticSource ? {
              eventId: highlightedReport.sourceEventId,
              text: highlightedReport.detail,
              at: highlightedReport.observedAt,
            } : null}
            linkContext={selectedCard ? {
              workspaceId: selectedCard.workspaceId,
              paneId: selectedCard.paneId,
              sessionId: selectedCard.tab.sessionId,
              canPreviewInternally: selectedCard.tab.type === undefined || selectedCard.tab.type === "terminal",
            } : null}
          />
          {selectedCard && selectedCard.telemetryHealth !== "ended" ? <QuestionCard brief={selectedCard.brief} events={transcriptEvents} targetLabel={`${selectedCard.workspace.name} › ${selectedCard.label}`} onFocusComposer={focusComposer} /> : null}
          <ReplyComposer card={selectedCard} inputRef={composerRef} mentionTargets={cards} />
        </>}
      </section>
      <aside className="cmux-dashboard-right-pane">
        <LayoutMinimapPanel workspaces={workspaces} displayStateByTabId={minimapDisplayStateByTabId} selectedTabId={viewState.selectedTabId} activePaneSessionId={activePaneSessionId} onSelect={selectFromMinimap} />
      </aside>
    </div>
  </div>;
}
