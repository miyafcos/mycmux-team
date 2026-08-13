import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";

import { focusController } from "../../lib/focusController";
import { dispatchScan, type DispatchEntry } from "../../lib/ipc";
import { dispatchStateLabel } from "../../lib/notificationStatus";
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
import { hasTerminalBuffer } from "../terminal/XTermWrapper";
import { DashboardSessionDetail } from "./DashboardSessionDetail";
import { DashboardSessionList, useFrozenCardOrder } from "./DashboardSessionList";
import {
  applyDashboardFilters,
  buildDashboardCards,
  countByDisplayState,
  needsHumanCards,
  orderDashboardCards,
  partitionDashboardCards,
  type DashboardCardModel,
} from "./dashboardModel";
import { dashboardStrings } from "./dashboardStrings";
import {
  chooseOption,
  isInterventionAccepted,
  questionModel,
  useInterventionFeedbackStore,
} from "./interventionRouting";
import { ReplyComposer } from "./ReplyComposer";
import { targetKey } from "../../lib/livebrief";

const AGENT_KINDS = ["claude", "codex", "claude-codex", "none"] as const;
/** 番号キーで撃てる選択肢。ここを増やすなら dashboardStrings.numberKeyHint も直す。 */
const NUMBER_KEYS = ["1", "2", "3"];

/** 状態ごとの件数。色に加えて丸ドットを添え、色だけの符号化にしない。 */
function CountPill({ active, color, label, count, onClick }: { active: boolean; color: string; label: string; count: number; onClick: () => void }) {
  return <button type="button" aria-pressed={active} style={countPillStyle(color, active)} onClick={onClick}>
    <i style={countDotStyle(color)} />
    {label} {count}
  </button>;
}

export function DashboardView({ onClose }: { onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const [dispatchEntries, setDispatchEntries] = useState<DispatchEntry[]>([]);
  const [listHovered, setListHovered] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const viewState = useDashboardViewStore(useShallow((state) => ({
    query: state.query,
    workspaceFilter: state.workspaceFilter,
    agentFilter: state.agentFilter,
    stateFilter: state.stateFilter,
    completedExpanded: state.completedExpanded,
    selectedTabId: state.selectedTabId,
    setQuery: state.setQuery,
    setWorkspaceFilter: state.setWorkspaceFilter,
    setAgentFilter: state.setAgentFilter,
    setStateFilter: state.setStateFilter,
    setCompletedExpanded: state.setCompletedExpanded,
    setSelectedTabId: state.setSelectedTabId,
  })));
  const workspaces = useWorkspaceListStore((state) => state.workspaces);
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
  const filteredCards = useMemo(() => applyDashboardFilters(cards, {
    query: viewState.query,
    workspaceId: viewState.workspaceFilter,
    needsHumanOnly: false,
    agentKind: viewState.agentFilter,
    stateFilter: viewState.stateFilter,
  }), [cards, viewState.agentFilter, viewState.query, viewState.stateFilter, viewState.workspaceFilter]);

  // 並べ替えの凍結: ポインタが一覧の上にある / 検索中は直前の並びを維持する。
  const frozen = listHovered || searchFocused;
  const liveOrdered = useMemo(() => orderDashboardCards(filteredCards, "attention"), [filteredCards]);
  const orderedCards = useFrozenCardOrder(liveOrdered, frozen);
  const liveUrgent = useMemo(() => needsHumanCards(filteredCards), [filteredCards]);
  const urgentCards = useFrozenCardOrder(liveUrgent, frozen);
  const partitions = useMemo(() => partitionDashboardCards(orderedCards), [orderedCards]);
  const visibleCards = useMemo(() => [
    ...partitions.needsHuman,
    ...partitions.active,
    ...(viewState.completedExpanded ? partitions.deferred : []),
  ], [partitions, viewState.completedExpanded]);
  const selectedCard = visibleCards.find((card) => card.tab.id === viewState.selectedTabId) ?? visibleCards[0] ?? null;
  const counts = useMemo(() => countByDisplayState(cards), [cards]);
  // 「既読にする」対象は未読の done 通知そのもの。表示状態 (done) とは一致しないことがある。
  const clearableCards = useMemo(
    () => cards.filter((card) => card.attentionCategory === "done" && card.attention?.attentionId),
    [cards],
  );
  const filterActive = Boolean(viewState.query || viewState.workspaceFilter || viewState.stateFilter || viewState.agentFilter);

  useEffect(() => {
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    focusController.request("programmatic", { sessionId: null, focus: false });
    window.setTimeout(() => rootRef.current?.focus(), 0);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      void dispatchScan().then((entries) => { if (!disposed) setDispatchEntries(entries); }).catch(() => {});
    };
    refresh();
    const interval = window.setInterval(refresh, 30_000);
    return () => { disposed = true; window.clearInterval(interval); };
  }, []);

  // brief の購読はビュー1枚につき1本 (store 側が参照数で束ねる)。
  useEffect(() => connectLiveBriefStore(), []);

  // 意味イベントの取得は「表示中の全セッション (浅く)」+「選択中1本 (深く)」。
  // 要対応 → 選択中 → 表示順、の優先で上限まで詰める。
  const selectedSessionId = selectedCard?.tab.sessionId ?? null;
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

  const focusComposer = useCallback(() => { composerRef.current?.focus(); }, []);

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
  const toggleStateFilter = (stateFilter: "needsHuman" | "running" | "noUpdate" | "done") => {
    viewState.setStateFilter(viewState.stateFilter === stateFilter ? null : stateFilter);
  };

  return <div ref={rootRef} tabIndex={-1} role="region" aria-label={dashboardStrings.viewAriaLabel} style={rootStyle}>
    <header style={headerStyle}>
      <div style={headerRowStyle}>
        <CountPill active={viewState.stateFilter === "needsHuman"} color="var(--status-waiting)" label={dashboardStrings.stateNeedsHuman} count={counts.needsHuman + counts.error} onClick={() => toggleStateFilter("needsHuman")} />
        <CountPill active={viewState.stateFilter === "running"} color="var(--status-working)" label={dashboardStrings.stateRunning} count={counts.running} onClick={() => toggleStateFilter("running")} />
        <CountPill active={viewState.stateFilter === "noUpdate"} color="var(--cmux-status-stall)" label={dashboardStrings.stateNoUpdate} count={counts.noUpdate} onClick={() => toggleStateFilter("noUpdate")} />
        <CountPill active={viewState.stateFilter === "done"} color="var(--status-done)" label={dashboardStrings.stateDone} count={counts.done} onClick={() => toggleStateFilter("done")} />
        <input
          ref={searchRef}
          value={viewState.query}
          onChange={(event) => viewState.setQuery(event.target.value)}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          placeholder={dashboardStrings.searchPlaceholder}
          style={inputStyle}
        />
        <select
          aria-label={dashboardStrings.allWorkspaces}
          value={viewState.workspaceFilter ?? ""}
          onChange={(event) => viewState.setWorkspaceFilter(event.target.value || null)}
          style={controlStyle}
        >
          <option value="">{dashboardStrings.allWorkspaces} {cards.length}</option>
          {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{`${workspace.name} ${cards.filter((card) => card.workspaceId === workspace.id).length}`}</option>)}
        </select>
        <select
          aria-label={dashboardStrings.agentFilterTitle}
          value={viewState.agentFilter ?? ""}
          onChange={(event) => viewState.setAgentFilter(event.target.value || null)}
          style={controlStyle}
        >
          <option value="">{dashboardStrings.agentFilterTitle}: {dashboardStrings.allWorkspaces}</option>
          {AGENT_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
        </select>
        {clearableCards.length > 0 ? <button type="button" style={buttonStyle} onClick={clearDone}>{dashboardStrings.clearDoneButton(clearableCards.length)}</button> : null}
        <button type="button" style={buttonStyle} onClick={close}>{dashboardStrings.backToSession} (Esc)</button>
        {filterActive ? <span style={mutedStyle}>{dashboardStrings.filteredSummary(filteredCards.length, cards.length)}</span> : null}
      </div>
    </header>
    {dispatchEntries.length > 0 ? <section aria-label={"委譲セッション"} style={dispatchStyle}>
      <span style={dispatchTitleStyle}>{"委譲セッション"} {dispatchEntries.length}</span>
      {dispatchEntries.map((entry) => <div key={entry.slug} style={dispatchEntryStyle}>
        <span style={{ ...dispatchStateStyle, color: dispatchStateColor(entry.liveState) }}>{dispatchStateLabel(entry.liveState)}</span>
        <span>{entry.slug}</span>
        <span style={mutedStyle}>{entry.status ?? "-"}</span>
        <span style={mutedStyle}>{formatDispatchAge(entry.sessionLogAgeMinutes)}</span>
        {entry.label ? <span style={mutedStyle}>{entry.label}</span> : null}
      </div>)}
    </section> : null}
    <div style={{ flex: 1, minHeight: 0, display: "flex", overflow: "hidden" }}>
      <DashboardSessionList
        needsHuman={urgentCards}
        all={partitions.active}
        deferred={partitions.deferred}
        deferredExpanded={viewState.completedExpanded}
        hideWorkspaceBadge={viewState.workspaceFilter !== null}
        selectedTabId={selectedCard?.tab.id ?? null}
        now={now}
        onSelect={viewState.setSelectedTabId}
        onJump={jumpToCard}
        onHoverChange={setListHovered}
        onFocusComposer={focusComposer}
        onToggleDeferred={() => viewState.setCompletedExpanded(!viewState.completedExpanded)}
      />
      <DashboardSessionDetail card={selectedCard} now={now} onJump={jumpToCard} onFocusComposer={focusComposer} />
    </div>
    <footer style={footerStyle}>
      <ReplyComposer card={selectedCard} inputRef={composerRef} />
      <span style={hintStyle}>{dashboardStrings.keyboardHint}</span>
    </footer>
  </div>;
}

function formatDispatchAge(age: number): string {
  if (age < 0) return "ログなし";
  if (age < 1) return "たった今";
  if (age < 60) return `${Math.floor(age)}分前`;
  return `${Math.floor(age / 60)}時間前`;
}

function dispatchStateColor(state: DispatchEntry["liveState"]): string {
  if (state === "DONE" || state === "CLOSED") return "var(--status-done)";
  if (state === "DONE_NEEDS_REVIEW" || state === "ASK") return "var(--status-waiting)";
  if (state === "STALL") return "var(--cmux-status-stall)";
  if (state === "RATE_LIMITED") return "var(--status-waiting)";
  return "var(--status-working)";
}

const rootStyle = {
  position: "absolute" as const,
  inset: 0,
  zIndex: 40,
  background: "var(--cmux-bg)",
  color: "var(--cmux-text)",
  display: "flex",
  flexDirection: "column" as const,
  outline: "none",
  "--cmux-bg": "var(--cmux-bg-solid)",
  "--cmux-surface": "var(--cmux-surface-solid)",
} as CSSProperties;
const headerStyle: CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid var(--cmux-border)",
  background: "var(--cmux-popover)",
};
const dispatchStyle: CSSProperties = { padding: "6px 14px", borderBottom: "1px solid var(--cmux-border)", background: "var(--cmux-popover)", display: "flex", alignItems: "center", gap: 10, overflowX: "auto", fontSize: "var(--cmux-font-size-xs)" };
const dispatchTitleStyle: CSSProperties = { fontWeight: 600, flex: "0 0 auto" };
const dispatchEntryStyle: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" };
const dispatchStateStyle: CSSProperties = { fontWeight: 600 };
const headerRowStyle: CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, minWidth: 0 };
const mutedStyle: CSSProperties = { color: "var(--cmux-text-secondary)", fontSize: "var(--cmux-font-size-sm)" };
const countPillStyle = (color: string, active: boolean): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  borderRadius: "var(--cmux-radius-pill)",
  padding: "2px 9px",
  fontSize: "var(--cmux-font-size-xs)",
  background: active ? `color-mix(in srgb, ${color} 28%, transparent)` : `color-mix(in srgb, ${color} 15%, transparent)`,
  border: `1px solid ${active ? color : "transparent"}`,
  color,
  cursor: "pointer",
});
const countDotStyle = (color: string): CSSProperties => ({
  width: 7,
  height: 7,
  borderRadius: "50%",
  flex: "none",
  background: color,
});
const controlStyle: CSSProperties = {
  background: "var(--cmux-bg)",
  border: "1px solid var(--cmux-border)",
  borderRadius: "var(--cmux-radius-sm)",
  color: "var(--cmux-text)",
  fontSize: "var(--cmux-font-size-sm)",
  minHeight: 27,
  padding: "3px 6px",
};
const inputStyle: CSSProperties = { ...controlStyle, width: 240 };
const buttonStyle: CSSProperties = { ...controlStyle, cursor: "pointer" };
const footerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  minWidth: 0,
  borderTop: "1px solid var(--cmux-border)",
  padding: "7px 12px",
  color: "var(--cmux-text-secondary)",
  fontSize: "var(--cmux-font-size-sm)",
  background: "var(--cmux-popover)",
};
const hintStyle: CSSProperties = {
  flex: "0 0 auto",
  color: "var(--cmux-text-tertiary)",
  fontSize: "var(--cmux-font-size-xs)",
};
