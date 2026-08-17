import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useShallow } from "zustand/react/shallow";

import { focusController } from "../../lib/focusController";
import type { AttentionCard, SessionRef } from "../../lib/attentionBridge";
import { workorderRetrySpawn } from "../../lib/workOrderCommands";
import {
  clampDashboardMinimapWidth,
  dashboardMinimapMaxWidth,
  DASHBOARD_CHAT_COLUMN_LIMIT,
  DASHBOARD_MINIMAP_MIN_WIDTH,
  useDashboardViewStore,
} from "../../stores/dashboardViewStore";
import { isDashboardChatDropTarget, type PaneDragItem, usePaneDragStore } from "../../stores/paneDragStore";
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
import { useWorkOrderStore } from "../../stores/workOrderStore";
import { connectReportInboxStatusFeed, useReportInboxStore, type MachineReportCard } from "../../stores/reportInboxStore";
import { hasTerminalBuffer } from "../terminal/XTermWrapper";
import { DashboardSessionList, useFrozenCardOrder } from "./DashboardSessionList";
import { AskStrip } from "./AskStrip";
import { buildAskStripItems } from "./askStripModel";
import { WatchStatusRow } from "./WatchStatusRow";
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
import { WorkOrderContract } from "./WorkOrderContract";
import { targetKey } from "../../lib/livebrief";
import { LayoutMinimapPanel } from "./LayoutMinimapPanel";
import { resolveDisplayState } from "./dashboardModel";
import { ReportInbox } from "./ReportInbox";
import { ChatColumn } from "./ChatColumn";
import "./DashboardView.css";

/** 番号キーで撃てる選択肢。ここを増やすなら dashboardStrings.numberKeyHint も直す。 */
const NUMBER_KEYS = ["1", "2", "3"];
const DASHBOARD_LIST_DRAG_THRESHOLD_PX = 9;
const DASHBOARD_CHAT_COLUMN_MOTION_MS = 180;
const DASHBOARD_CHAT_DROP_INDICATOR_WIDTH = 3;

export function clampDashboardChatDropIndicatorOffset(offsetX: number, rootWidth: number, indicatorWidth = DASHBOARD_CHAT_DROP_INDICATOR_WIDTH): number {
  const safeRootWidth = Number.isFinite(rootWidth) ? Math.max(0, rootWidth) : 0;
  const safeOffsetX = Number.isFinite(offsetX) ? offsetX : 0;
  const halfWidth = Math.min(Math.max(0, indicatorWidth / 2), safeRootWidth / 2);
  return Math.min(safeRootWidth - halfWidth, Math.max(halfWidth, safeOffsetX));
}

function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(() => (
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  ));

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  return reducedMotion;
}

export function DashboardView({ onClose }: { onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const chatColumnsRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const suppressDashboardListClickRef = useRef(false);
  const [now, setNow] = useState(() => Date.now());
  const [listHovered, setListHovered] = useState(false);
  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(intervalId);
  }, []);
  const [searchFocused, setSearchFocused] = useState(false);
  const [resizingMinimap, setResizingMinimap] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === "undefined" ? 0 : window.innerWidth);
  const [columnMotion, setColumnMotion] = useState<{ tabId: string; kind: "add" } | null>(null);
  const [closingColumn, setClosingColumn] = useState<{ card: DashboardCardModel; openIndex: number } | null>(null);
  const [draggedChatColumnTabId, setDraggedChatColumnTabId] = useState<string | null>(null);
  // Counter, not a boolean: repeated drops on a full chat area must restart the
  // pulse instead of being swallowed as "already true".
  const [chatColumnCapPulse, setChatColumnCapPulse] = useState(0);
  const previousOpenColumnTabIdsRef = useRef<string[] | null>(null);
  const reducedMotion = useReducedMotion();
  const contractsBySession = useWorkOrderStore((state) => state.contractDraftBySession);
  const viewState = useDashboardViewStore(useShallow((state) => ({
    query: state.query,
    workspaceFilter: state.workspaceFilter,
    agentFilter: state.agentFilter,
    stateFilter: state.stateFilter,
    selectedTabId: state.selectedTabId,
    chatColumnTabIds: state.chatColumnTabIds,
    activeChatColumn: state.activeChatColumn,
    reportInboxOpen: state.reportInboxOpen,
    highlightedEventId: state.highlightedEventId,
    highlightedEventRequest: state.highlightedEventRequest,
    setQuery: state.setQuery,
    setWorkspaceFilter: state.setWorkspaceFilter,
    setAgentFilter: state.setAgentFilter,
    setStateFilter: state.setStateFilter,
    setSelectedTabId: state.setSelectedTabId,
    addChatColumn: state.addChatColumn,
    moveChatColumn: state.moveChatColumn,
    insertChatColumn: state.insertChatColumn,
    setActiveChatColumn: state.setActiveChatColumn,
    removeChatColumn: state.removeChatColumn,
    openReportInbox: state.openReportInbox,
    closeReportInbox: state.closeReportInbox,
    setHighlightedEventId: state.setHighlightedEventId,
    minimapWidth: state.minimapWidth,
    setMinimapWidth: state.setMinimapWidth,
  })));
  const minimapMaxWidth = dashboardMinimapMaxWidth(viewportWidth);
  const minimapWidth = clampDashboardMinimapWidth(viewState.minimapWidth, viewportWidth);
  const workspaces = useWorkspaceListStore((state) => state.workspaces);
  const dragItem = usePaneDragStore((state) => state.item);
  const dragPointer = usePaneDragStore((state) => state.pointer);
  const dashboardChatDropPreview = usePaneDragStore((state) => state.dashboardChatDropPreview);
  const activePaneSessionId = useUiStore((state) => state.activePaneId);
  const metadataState = usePaneMetadataStore(useShallow((state) => ({
    metadata: state.metadata,
    volatileMetadata: state.volatileMetadata,
    lastLog: state.lastLog,
    lastLogAt: state.lastLogAt,
  })));
  const stallsBySession = useStallStore((state) => state.entries);
  const attentionState = useSessionAttentionStore(useShallow((state) => ({
    attentionBySession: state.attentionBySession,
    seenAttentionByTab: state.seenAttentionByTab,
    doneMarkByTab: state.doneMarkByTab,
  })));
  const briefsBySession = useLiveBriefStore((state) => state.briefsBySession);
  const eventsBySession = useLiveBriefStore((state) => state.eventsBySession);
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
    volatileMetadataBySession: metadataState.volatileMetadata,
    lastLogBySession: metadataState.lastLog,
    lastLogAtBySession: metadataState.lastLogAt,
    attentionBySession: attentionState.attentionBySession,
    seenAttentionByTab: attentionState.seenAttentionByTab,
    doneMarkByTab: attentionState.doneMarkByTab,
    stallsBySession,
    briefsBySession,
    now,
    hasTerminalBuffer,
  }), [attentionState, briefsBySession, metadataState, now, stallsBySession, workspaces]);
  const reportSourceSessionIds = useMemo(() => new Set(cards.map((card) => card.tab.sessionId)), [cards]);
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
  // selectedTabId remains the single highlight authority. The ordered column
  // state only decides which conversations stay open beside that active tab.
  const selectedCard = cards.find((card) => card.tab.id === viewState.selectedTabId) ?? visibleCards[0] ?? null;
  const chatColumnTabIds = viewState.chatColumnTabIds.length
    ? viewState.chatColumnTabIds
    : selectedCard ? [selectedCard.tab.id] : [];
  const activeChatColumn = Math.max(0, Math.min(chatColumnTabIds.length - 1, viewState.activeChatColumn));
  const chatColumnCards = chatColumnTabIds.flatMap((tabId) => {
    const card = cards.find((candidate) => candidate.tab.id === tabId);
    return card ? [card] : [];
  });
  const activeColumnTabId = chatColumnTabIds[activeChatColumn] ?? null;
  // Direct composer routing must use the same column the user sees as active.
  // Do not fall back to another card if a stale layout id disappears.
  const activeColumnCard = activeColumnTabId
    ? cards.find((candidate) => candidate.tab.id === activeColumnTabId) ?? null
    : null;
  const selectedSessionId = selectedCard?.tab.sessionId ?? null;
  const highlightedReport = useMemo(() => reportCards.find((card) => (
    card.ptySessionId === selectedSessionId && card.sourceEventId === viewState.highlightedEventId
  )) ?? null, [reportCards, selectedSessionId, viewState.highlightedEventId]);
  const activeColumnSessionId = activeColumnCard?.tab.sessionId ?? null;
  const activeColumnEvents = activeColumnSessionId ? eventsBySession[activeColumnSessionId] : undefined;
  const activeColumnTranscriptEvents = activeColumnEvents?.length
    ? activeColumnEvents
    : activeColumnSessionId ? listEventsBySession[activeColumnSessionId] ?? [] : [];
  const activeColumnQuestion = questionModel(activeColumnCard?.brief, activeColumnTranscriptEvents);
  const openChatColumns = chatColumnCards;
  const openChatColumnTabIds = useMemo(
    () => openChatColumns.map((card) => card.tab.id),
    [openChatColumns],
  );
  const renderedChatColumns = useMemo(() => {
    if (!closingColumn) return openChatColumns;
    const columns = openChatColumns.filter((card) => card.tab.id !== closingColumn.card.tab.id);
    columns.splice(Math.min(closingColumn.openIndex, columns.length), 0, closingColumn.card);
    return columns;
  }, [closingColumn, openChatColumns]);

  const refreshDashboardChatDropPreview = useCallback((item: PaneDragItem | null, pointer: { x: number; y: number } | null, columnDrag = false) => {
    const setPreview = usePaneDragStore.getState().setDashboardChatDropPreview;
    if (!item || item.kind !== "tab" || !pointer) {
      setPreview(null);
      return;
    }
    const columnsRoot = chatColumnsRef.current;
    const hit = document.elementFromPoint(pointer.x, pointer.y);
    if (!columnsRoot || !hit || !columnsRoot.contains(hit)) {
      setPreview(null);
      return;
    }
    const existingIndex = chatColumnTabIds.indexOf(item.tabId);
    if (existingIndex >= 0 && !columnDrag) {
      setPreview({ kind: "existing", tabId: item.tabId, index: existingIndex });
      return;
    }
    if (!columnDrag && chatColumnTabIds.length >= DASHBOARD_CHAT_COLUMN_LIMIT) {
      setPreview({ kind: "full" });
      return;
    }
    const rootRect = columnsRoot.getBoundingClientRect();
    const boundaries = Array.from(columnsRoot.querySelectorAll<HTMLElement>("[data-dashboard-chat-column]"))
      .flatMap((column) => {
        const tabId = column.dataset.dashboardChatColumn;
        const index = tabId ? chatColumnTabIds.indexOf(tabId) : -1;
        if (index < 0) return [];
        const rect = column.getBoundingClientRect();
        return [
          { index, x: rect.left },
          { index: index + 1, x: rect.right },
        ];
      });
    if (!boundaries.length) {
      setPreview(null);
      return;
    }
    const nearest = boundaries.reduce((best, boundary) => (
      Math.abs(boundary.x - pointer.x) < Math.abs(best.x - pointer.x) ? boundary : best
    ));
    setPreview({
      kind: "insert",
      index: nearest.index,
      offsetX: clampDashboardChatDropIndicatorOffset(nearest.x - rootRect.left, rootRect.width),
    });
  }, [chatColumnTabIds]);

  useLayoutEffect(() => {
    if (dragItem?.surface !== "minimap") return;
    refreshDashboardChatDropPreview(dragItem, dragPointer);
  }, [dragItem, dragPointer, refreshDashboardChatDropPreview]);

  useLayoutEffect(() => {
    const previous = previousOpenColumnTabIdsRef.current;
    previousOpenColumnTabIdsRef.current = openChatColumnTabIds;
    if (!previous || reducedMotion || closingColumn) return;
    const addedTabIds = openChatColumnTabIds.filter((tabId) => !previous.includes(tabId));
    if (openChatColumnTabIds.length === previous.length + 1 && addedTabIds.length === 1) {
      setColumnMotion({ tabId: addedTabIds[0], kind: "add" });
    }
  }, [closingColumn, openChatColumnTabIds, reducedMotion]);

  useEffect(() => {
    if (!columnMotion) return;
    const timer = window.setTimeout(() => setColumnMotion(null), DASHBOARD_CHAT_COLUMN_MOTION_MS);
    return () => window.clearTimeout(timer);
  }, [columnMotion]);

  useEffect(() => {
    if (!closingColumn) return;
    const timer = window.setTimeout(() => setClosingColumn(null), DASHBOARD_CHAT_COLUMN_MOTION_MS);
    return () => window.clearTimeout(timer);
  }, [closingColumn]);

  useEffect(() => {
    if (chatColumnCapPulse === 0) return;
    const timer = window.setTimeout(() => setChatColumnCapPulse(0), DASHBOARD_CHAT_COLUMN_MOTION_MS);
    return () => window.clearTimeout(timer);
  }, [chatColumnCapPulse]);
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

  useEffect(() => {
    const updateViewportWidth = () => {
      const measured = rootRef.current?.getBoundingClientRect().width ?? 0;
      setViewportWidth(measured || window.innerWidth);
    };
    updateViewportWidth();
    window.addEventListener("resize", updateViewportWidth);
    const observer = typeof ResizeObserver === "undefined" || !rootRef.current
      ? null
      : new ResizeObserver(updateViewportWidth);
    if (observer && rootRef.current) observer.observe(rootRef.current);
    return () => {
      window.removeEventListener("resize", updateViewportWidth);
      observer?.disconnect();
    };
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

  // 意味イベントの取得は「表示中の全セッション (浅く)」+「開いている列 (深く)」。
  // 要対応 → 選択中 → 表示順、の優先で上限まで詰める。
  const visibleKey = useMemo(() => {
    const ids: string[] = [];
    const push = (id: string | null) => { if (id && !ids.includes(id)) ids.push(id); };
    for (const card of urgentCards) push(card.tab.sessionId);
    for (const card of chatColumnCards) push(card.tab.sessionId);
    for (const card of visibleCards) push(card.tab.sessionId);
    return ids.slice(0, LIVE_EVENT_VISIBLE_LIMIT).join(",");
  }, [chatColumnCards, urgentCards, visibleCards]);
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
    if (viewState.selectedTabId && (!viewState.chatColumnTabIds.length
      || viewState.chatColumnTabIds[activeChatColumn] !== viewState.selectedTabId)) {
      // External selection still means click-to-replace for the active column.
      viewState.setSelectedTabId(viewState.selectedTabId);
    }
  }, [activeChatColumn, selectedCard, viewState]);

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
  const focusComposerForColumn = useCallback((columnIndex: number, sessionId: string) => (questionBrief: typeof selectedCard.brief) => {
    viewState.setActiveChatColumn(columnIndex);
    if (sessionId) {
      const composer = useComposerStore.getState();
      composer.setCommandKind(sessionId, "answer-forward");
      composer.setQuestionGuard(sessionId, questionBrief?.promptEventId
        ? { questionId: questionBrief.promptEventId, revision: questionBrief.ptyInputRevision }
        : null);
    }
    composerRef.current?.focus();
  }, [viewState]);
  const closeChatColumn = useCallback((index: number, card: DashboardCardModel) => {
    if (closingColumn || chatColumnTabIds.length <= 1 || reducedMotion) {
      viewState.removeChatColumn(index);
      return;
    }
    const openIndex = openChatColumnTabIds.indexOf(card.tab.id);
    if (openIndex < 0) {
      viewState.removeChatColumn(index);
      return;
    }
    setClosingColumn({ card, openIndex });
    viewState.removeChatColumn(index);
  }, [chatColumnTabIds.length, closingColumn, openChatColumnTabIds, reducedMotion, viewState]);
  const isChatColumnDropAtPoint = useCallback((x: number, y: number) => (
    isDashboardChatDropTarget(document.elementFromPoint(x, y))
  ), []);
  const insertChatColumnAtDropPreview = useCallback((tabId: string) => {
    const preview = usePaneDragStore.getState().dashboardChatDropPreview;
    const state = useDashboardViewStore.getState();
    const existingIndex = state.chatColumnTabIds.indexOf(tabId);
    // The store drops the insert silently when the column cap is reached, so the
    // drop reads as "nothing happened". Flag it here and let the whole chat
    // surface answer once (the corner pill alone was too easy to miss).
    if (existingIndex < 0 && state.chatColumnTabIds.length >= DASHBOARD_CHAT_COLUMN_LIMIT) {
      setChatColumnCapPulse((pulse) => pulse + 1);
      return;
    }
    const index = existingIndex >= 0
      ? existingIndex
      : preview?.kind === "insert" ? preview.index : state.chatColumnTabIds.length;
    state.insertChatColumn(tabId, index);
  }, []);
  // Minimap drags keep pointer capture on their source. Receive only the
  // dashboard's semantic target in capture phase; layout D&D and composer @
  // drops continue through their existing receivers.
  useEffect(() => {
    const receiveMinimapChatDrop = (event: PointerEvent) => {
      const item = usePaneDragStore.getState().item;
      if (!item || item.surface !== "minimap" || item.kind !== "tab") return;
      if (!isChatColumnDropAtPoint(event.clientX, event.clientY)) return;
      insertChatColumnAtDropPreview(item.tabId);
    };
    window.addEventListener("pointerup", receiveMinimapChatDrop, true);
    return () => window.removeEventListener("pointerup", receiveMinimapChatDrop, true);
  }, [insertChatColumnAtDropPreview, isChatColumnDropAtPoint]);
  const beginDashboardListDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || usePaneDragStore.getState().item) return;
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>("[data-dashboard-row]");
    const tabId = row?.getAttribute("data-dashboard-row");
    const card = tabId ? cards.find((candidate) => candidate.tab.id === tabId) : undefined;
    if (!row || !card) return;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let dashboardTarget = false;
    const item = {
      kind: "tab" as const,
      workspaceId: card.workspaceId,
      paneId: card.paneId,
      tabId: card.tab.id,
      label: card.label,
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", cancel);
      try {
        if (row.hasPointerCapture(pointerId)) row.releasePointerCapture(pointerId);
      } catch {
        // Pointer capture is optional in embedded WebViews.
      }
      document.body.style.cursor = "";
    };
    const clear = () => {
      usePaneDragStore.getState().clearDrag();
      window.setTimeout(() => { suppressDashboardListClickRef.current = false; }, 0);
    };
    const move = (nativeEvent: PointerEvent) => {
      if (nativeEvent.pointerId !== pointerId) return;
      if (!dragging) {
        if (Math.hypot(nativeEvent.clientX - startX, nativeEvent.clientY - startY) < DASHBOARD_LIST_DRAG_THRESHOLD_PX) return;
        dragging = true;
        suppressDashboardListClickRef.current = true;
        try { row.setPointerCapture(pointerId); } catch { /* Window listeners remain authoritative. */ }
        document.body.style.cursor = "grabbing";
        usePaneDragStore.getState().beginDrag(item, { x: nativeEvent.clientX, y: nativeEvent.clientY });
      }
      nativeEvent.preventDefault();
      const dragStore = usePaneDragStore.getState();
      dragStore.moveDrag({ x: nativeEvent.clientX, y: nativeEvent.clientY });
      dashboardTarget = isChatColumnDropAtPoint(nativeEvent.clientX, nativeEvent.clientY);
      refreshDashboardChatDropPreview(item, { x: nativeEvent.clientX, y: nativeEvent.clientY });
      dragStore.setTarget(null);
    };
    const finish = (nativeEvent: PointerEvent) => {
      if (nativeEvent.pointerId !== pointerId) return;
      cleanup();
      if (!dragging) return;
      nativeEvent.preventDefault();
      if (dashboardTarget) insertChatColumnAtDropPreview(item.tabId);
      clear();
    };
    const cancel = () => {
      cleanup();
      if (dragging) clear();
    };
    const onKeyDown = (nativeEvent: KeyboardEvent) => {
      if (nativeEvent.key !== "Escape") return;
      nativeEvent.preventDefault();
      nativeEvent.stopPropagation();
      cancel();
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", cancel);
  }, [cards, insertChatColumnAtDropPreview, isChatColumnDropAtPoint, refreshDashboardChatDropPreview]);
  const beginDashboardChatColumnDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>): boolean => {
    if (event.button !== 0 || !event.isPrimary || usePaneDragStore.getState().item) return false;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, textarea, select, [data-dnd-ignore='true']")) return false;
    const handle = target.closest<HTMLElement>("[data-dashboard-column-drag-handle='true']");
    const tabId = handle?.closest<HTMLElement>("[data-dashboard-chat-column]")?.dataset.dashboardChatColumn;
    const from = tabId ? chatColumnTabIds.indexOf(tabId) : -1;
    const card = tabId ? cards.find((candidate) => candidate.tab.id === tabId) : undefined;
    if (!handle || !tabId || !card || from < 0) return false;

    // Let a click reach the header, but keep article's pointer activation from
    // firing before we know whether the gesture passes the drag threshold.
    event.stopPropagation();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const item: PaneDragItem = {
      kind: "tab",
      workspaceId: card.workspaceId,
      paneId: card.paneId,
      tabId,
      label: card.label,
    };
    let dragging = false;
    let dashboardTarget = false;
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", cancel);
      try {
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      } catch {
        // Pointer capture is optional in embedded WebViews.
      }
      document.body.style.cursor = "";
    };
    const clear = () => {
      usePaneDragStore.getState().setDashboardChatDropPreview(null);
      setDraggedChatColumnTabId(null);
      window.setTimeout(() => { suppressDashboardListClickRef.current = false; }, 0);
    };
    const move = (nativeEvent: PointerEvent) => {
      if (nativeEvent.pointerId !== pointerId) return;
      if (!dragging) {
        if (Math.hypot(nativeEvent.clientX - startX, nativeEvent.clientY - startY) < DASHBOARD_LIST_DRAG_THRESHOLD_PX) return;
        dragging = true;
        suppressDashboardListClickRef.current = true;
        setDraggedChatColumnTabId(tabId);
        try { handle.setPointerCapture(pointerId); } catch { /* Window listeners remain authoritative. */ }
        document.body.style.cursor = "grabbing";
      }
      nativeEvent.preventDefault();
      dashboardTarget = isChatColumnDropAtPoint(nativeEvent.clientX, nativeEvent.clientY);
      refreshDashboardChatDropPreview(item, { x: nativeEvent.clientX, y: nativeEvent.clientY }, true);
    };
    const finish = (nativeEvent: PointerEvent) => {
      if (nativeEvent.pointerId !== pointerId) return;
      cleanup();
      if (!dragging) return;
      nativeEvent.preventDefault();
      const preview = usePaneDragStore.getState().dashboardChatDropPreview;
      if (dashboardTarget && preview?.kind === "insert") viewState.moveChatColumn(from, preview.index);
      clear();
    };
    const cancel = () => {
      cleanup();
      if (dragging) clear();
    };
    const onKeyDown = (nativeEvent: KeyboardEvent) => {
      if (nativeEvent.key !== "Escape") return;
      nativeEvent.preventDefault();
      nativeEvent.stopPropagation();
      cancel();
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", cancel);
    return true;
  }, [cards, chatColumnTabIds, isChatColumnDropAtPoint, refreshDashboardChatDropPreview, viewState]);
  const beginDashboardPointerDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (beginDashboardChatColumnDrag(event)) return;
    beginDashboardListDrag(event);
  }, [beginDashboardChatColumnDrag, beginDashboardListDrag]);
  const suppressDashboardListClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressDashboardListClickRef.current) return;
    if (!(event.target as HTMLElement).closest("[data-dashboard-row], [data-dashboard-column-drag-handle='true']")) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);
  const reorderChatColumnFromHeader = useCallback((index: number, event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || !event.altKey) return;
    if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault();
      event.stopPropagation();
      viewState.moveChatColumn(index, index - 1);
    } else if (event.key === "ArrowRight" && index < chatColumnTabIds.length - 1) {
      event.preventDefault();
      event.stopPropagation();
      viewState.moveChatColumn(index, index + 2);
    }
  }, [chatColumnTabIds.length, viewState]);
  const selectFromMinimap = useCallback((tabId: string) => {
    if (viewState.query) viewState.setQuery("");
    // 配置図で選んだのに中央がインボックスのままだと「切り替わっていない」と読まれる。
    if (viewState.reportInboxOpen) viewState.closeReportInbox();
    viewState.setSelectedTabId(tabId);
  }, [viewState]);
  const openReportSource = useCallback((report: MachineReportCard) => {
    const target = cards.find((card) => card.tab.sessionId === report.ptySessionId);
    if (!target) return;
    viewState.setSelectedTabId(target.tab.id);
    viewState.setHighlightedEventId(report.sourceEventId);
  }, [cards, viewState]);
  const cardForAttentionSession = useCallback((session: SessionRef) => cards.find((card) => (
    session.type === "pty"
      ? card.tab.sessionId === session.pty_session_id
      : card.metadata?.agentSessionId === session.logical_session_id || card.tab.agentSessionId === session.logical_session_id
  )), [cards]);
  const sessionForAttentionCard = useCallback((card: AttentionCard): SessionRef | null => {
    if (card.session) return card.session;
    if (card.primaryAction.type === "openSession" || card.primaryAction.type === "answerQuestion") return card.primaryAction.session;
    if (!card.workorderId) return null;
    const entry = Object.entries(contractsBySession).find(([, value]) => value?.workOrderId === card.workorderId);
    return entry ? { type: "pty", pty_session_id: entry[0] } : null;
  }, [contractsBySession]);
  const openAttentionSession = useCallback((session: SessionRef) => {
    const target = cardForAttentionSession(session);
    if (!target) throw new Error("attention session is unavailable");
    viewState.setSelectedTabId(target.tab.id);
  }, [cardForAttentionSession, viewState]);
  const answerAttentionQuestion = useCallback((session: SessionRef) => {
    const target = cardForAttentionSession(session);
    if (!target) throw new Error("attention session is unavailable");
    viewState.setSelectedTabId(target.tab.id);
    const composer = useComposerStore.getState();
    composer.setCommandKind(target.tab.sessionId, "answer-forward");
    composer.setQuestionGuard(target.tab.sessionId, target.brief?.promptEventId
      ? { questionId: target.brief.promptEventId, revision: target.brief.ptyInputRevision }
      : null);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }, [cardForAttentionSession, viewState]);
  const openAttentionWorkOrder = useCallback((workOrderId: string) => {
    const entry = Object.entries(contractsBySession).find(([, value]) => value?.workOrderId === workOrderId);
    if (!entry) throw new Error("work order card is unavailable");
    const target = cards.find((card) => card.tab.sessionId === entry[0]);
    if (!target) throw new Error("work order session is unavailable");
    viewState.setSelectedTabId(target.tab.id);
  }, [cards, contractsBySession, viewState]);
  const attentionActions = useMemo(() => ({
    sessionLabel: (card: AttentionCard) => {
      const session = sessionForAttentionCard(card);
      const target = session ? cardForAttentionSession(session) : undefined;
      if (target) return target.label;
      const fallback = session?.type === "pty" ? session.pty_session_id
        : session?.type === "logical" ? session.logical_session_id
          : card.workorderId ?? card.id;
      return fallback.length > 12 ? `${fallback.slice(0, 8)}…${fallback.slice(-3)}` : fallback;
    },
    openCardSession: (card: AttentionCard) => {
      const session = sessionForAttentionCard(card);
      if (!session) throw new Error("attention session is unavailable");
      return openAttentionSession(session);
    },
    openSession: openAttentionSession,
    answerQuestion: answerAttentionQuestion,
    retryWorkItem: (workOrderId: string) => workorderRetrySpawn(workOrderId).then(() => undefined),
    openWorkOrder: openAttentionWorkOrder,
  }), [answerAttentionQuestion, cardForAttentionSession, openAttentionSession, openAttentionWorkOrder, sessionForAttentionCard]);
  const reportSessionLabel = useCallback((ptySessionId: string) => {
    const target = cards.find((card) => card.tab.sessionId === ptySessionId);
    if (target) return target.label;
    return ptySessionId.length > 12 ? `${ptySessionId.slice(0, 8)}…${ptySessionId.slice(-3)}` : ptySessionId;
  }, [cards]);
  const selectQuestion = useCallback((tabId: string, sessionId: string) => {
    viewState.setSelectedTabId(tabId);
    window.requestAnimationFrame(() => document.getElementById(`dashboard-question-${sessionId}`)?.scrollIntoView({ block: "nearest" }));
  }, [viewState]);
  const resizeMinimap = useCallback((width: number) => {
    viewState.setMinimapWidth(clampDashboardMinimapWidth(width, viewportWidth));
  }, [viewState, viewportWidth]);
  const beginMinimapResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: minimapWidth };
    setResizingMinimap(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is unavailable in a few embedded WebViews; pointer
      // events still reach the separator while it remains under the pointer.
    }
  }, [minimapWidth]);
  const moveMinimapResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    resizeMinimap(drag.startWidth + drag.startX - event.clientX);
  }, [resizeMinimap]);
  const endMinimapResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    setResizingMinimap(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The browser can release capture before pointerup/cancel is delivered.
    }
  }, []);
  const resizeMinimapByKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 16;
    const next = event.key === "ArrowLeft" ? minimapWidth + step
      : event.key === "ArrowRight" ? minimapWidth - step
        : event.key === "Home" ? DASHBOARD_MINIMAP_MIN_WIDTH
          : event.key === "End" ? minimapMaxWidth
            : null;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    resizeMinimap(next);
  }, [minimapMaxWidth, minimapWidth, resizeMinimap]);

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

  return <div ref={rootRef} tabIndex={-1} role="region" aria-label={dashboardStrings.viewAriaLabel} className="cmux-dashboard-view" onPointerDownCapture={beginDashboardPointerDrag} onClickCapture={suppressDashboardListClick}>
    <AskStrip items={askItems} onSelect={(item) => selectQuestion(item.tabId, item.sessionId)} />
    <WatchStatusRow now={now} />
    <div className="cmux-dashboard-shell" style={{ "--dashboard-minimap-width": `${minimapWidth}px` } as CSSProperties}>
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
        {viewState.reportInboxOpen ? <>
          <header className="cmux-dashboard-chat-header"><strong>{dashboardStrings.reportInboxTitle}</strong></header>
          <div className="cmux-dashboard-report-drop" data-dashboard-chat-drop-target="true">
            <ReportInbox
              cards={reportCards}
              receiveModeBySession={reportInboxState.receiveModeBySession}
              sourceAvailableSessionIds={reportSourceSessionIds}
              onReceiveModeChange={reportInboxState.setReceiveMode}
              onOpenSource={openReportSource}
              attentionActions={attentionActions}
              sessionLabel={reportSessionLabel}
            />
          </div>
        </> : <div className="cmux-dashboard-chat-columns-shell">
          <div ref={chatColumnsRef} className="cmux-dashboard-chat-columns" data-dashboard-chat-drop-target="true" data-visible-columns={openChatColumns.length} data-dashboard-chat-drop-preview={dashboardChatDropPreview?.kind} data-dashboard-chat-cap-pulse={chatColumnCapPulse > 0 && !reducedMotion ? chatColumnCapPulse : undefined}>
            {renderedChatColumns.map((card) => {
              const index = chatColumnTabIds.indexOf(card.tab.id);
              const events = eventsBySession[card.tab.sessionId];
              const columnEvents = events?.length ? events : listEventsBySession[card.tab.sessionId] ?? [];
              const syntheticSource = index === activeChatColumn && highlightedReport?.syntheticSource ? {
                eventId: highlightedReport.sourceEventId,
                text: highlightedReport.detail,
                at: highlightedReport.observedAt,
              } : null;
              return <ChatColumn
                key={card.tab.id}
                card={card}
                events={columnEvents}
                now={now}
                active={index === activeChatColumn}
                dragging={card.tab.id === draggedChatColumnTabId}
                dropPreview={dashboardChatDropPreview?.kind === "existing" && dashboardChatDropPreview.tabId === card.tab.id}
                motion={closingColumn?.card.tab.id === card.tab.id
                  ? "exit"
                  : closingColumn
                    ? "expand"
                    : columnMotion
                      ? card.tab.id === columnMotion.tabId ? "enter" : "resize"
                      : null}
                targetEventId={viewState.highlightedEventId}
                targetEventRequest={viewState.highlightedEventRequest}
                syntheticSource={syntheticSource}
                onActivate={() => viewState.setActiveChatColumn(index)}
                onClose={() => closeChatColumn(index, card)}
                onFocusComposer={focusComposerForColumn(index, card.tab.sessionId)}
                onJump={() => jumpToCard(card)}
                onReorderKeyDown={(event) => reorderChatColumnFromHeader(index, event)}
              />;
            })}
            {dashboardChatDropPreview?.kind === "insert" ? <span className="cmux-dashboard-chat-drop-indicator" aria-hidden="true" data-dashboard-chat-insert-index={dashboardChatDropPreview.index} style={{ left: dashboardChatDropPreview.offsetX }} /> : null}
            {dashboardChatDropPreview?.kind === "full" ? <span className="cmux-dashboard-chat-drop-capped" aria-hidden="true">3列まで</span> : null}
          </div>
        </div>}
        {!viewState.reportInboxOpen ? <div className="cmux-dashboard-composer-destination" aria-live="polite">{activeColumnCard ? `入力先: ${activeColumnCard.label}（${activeChatColumn + 1}/${chatColumnTabIds.length}列）` : dashboardStrings.detailEmpty}</div> : null}
        <WorkOrderContract
          card={activeColumnCard}
          mentionTargets={cards}
          reportInboxOpen={viewState.reportInboxOpen}
          onFix={() => composerRef.current?.focus()}
        />
        {/* インボックスは @ で配る場所なので、入力欄はここでこそ必要になる。 */}
        <ReplyComposer card={activeColumnCard} inputRef={composerRef} mentionTargets={cards} questionActive={Boolean(activeColumnQuestion)} />
      </section>
      <div
        data-dashboard-resizer="true"
        className={`cmux-dashboard-minimap-resizer${resizingMinimap ? " is-resizing" : ""}`}
        role="separator"
        tabIndex={0}
        aria-label="配置図の幅を変更"
        aria-orientation="vertical"
        aria-valuemin={DASHBOARD_MINIMAP_MIN_WIDTH}
        aria-valuemax={minimapMaxWidth}
        aria-valuenow={minimapWidth}
        onPointerDown={beginMinimapResize}
        onPointerMove={moveMinimapResize}
        onPointerUp={endMinimapResize}
        onPointerCancel={endMinimapResize}
        onLostPointerCapture={endMinimapResize}
        onKeyDown={resizeMinimapByKeyboard}
      />
      <aside className="cmux-dashboard-right-pane">
        <LayoutMinimapPanel workspaces={workspaces} displayStateByTabId={minimapDisplayStateByTabId} selectedTabId={viewState.selectedTabId} activePaneSessionId={activePaneSessionId} onSelect={selectFromMinimap} />
      </aside>
    </div>
  </div>;
}
