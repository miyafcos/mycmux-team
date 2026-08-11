import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";

import { focusController } from "../../lib/focusController";
import { useDashboardViewStore } from "../../stores/dashboardViewStore";
import { connectLiveBriefStore, startEventPolling, stopEventPolling, useLiveBriefStore } from "../../stores/liveBriefStore";
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
  type DashboardCardModel,
} from "./dashboardModel";
import { dashboardStrings } from "./dashboardStrings";

const AGENT_KINDS = ["claude", "codex", "claude-codex", "none"] as const;

export function DashboardView({ onClose }: { onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const [listHovered, setListHovered] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const viewState = useDashboardViewStore(useShallow((state) => ({
    sortMode: state.sortMode,
    query: state.query,
    workspaceFilter: state.workspaceFilter,
    quickFilters: state.quickFilters,
    agentFilter: state.agentFilter,
    selectedTabId: state.selectedTabId,
    setSortMode: state.setSortMode,
    setQuery: state.setQuery,
    setWorkspaceFilter: state.setWorkspaceFilter,
    setQuickFilter: state.setQuickFilter,
    setAgentFilter: state.setAgentFilter,
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
    needsHumanOnly: viewState.quickFilters.needsHumanOnly,
    agentKind: viewState.agentFilter,
  }), [cards, viewState.agentFilter, viewState.query, viewState.quickFilters.needsHumanOnly, viewState.workspaceFilter]);

  // 並べ替えの凍結: ポインタが一覧の上にある / 検索中は直前の並びを維持する。
  const frozen = listHovered || searchFocused;
  const liveOrdered = useMemo(() => orderDashboardCards(filteredCards, viewState.sortMode), [filteredCards, viewState.sortMode]);
  const orderedCards = useFrozenCardOrder(liveOrdered, frozen);
  const liveUrgent = useMemo(() => needsHumanCards(filteredCards), [filteredCards]);
  const urgentCards = useFrozenCardOrder(liveUrgent, frozen);
  const selectedCard = orderedCards.find((card) => card.tab.id === viewState.selectedTabId) ?? orderedCards[0] ?? null;
  const counts = useMemo(() => countByDisplayState(cards), [cards]);
  // 「既読にする」対象は未読の done 通知そのもの。表示状態 (done) とは一致しないことがある。
  const clearableCards = useMemo(
    () => cards.filter((card) => card.attentionCategory === "done" && card.attention?.attentionId),
    [cards],
  );
  const filterActive = Boolean(viewState.query || viewState.workspaceFilter || viewState.quickFilters.needsHumanOnly || viewState.agentFilter);

  useEffect(() => {
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    focusController.request("programmatic", { sessionId: null, focus: false });
    window.setTimeout(() => rootRef.current?.focus(), 0);
    return () => window.clearInterval(interval);
  }, []);

  // brief の購読はビュー1枚につき1本 (store 側が参照数で束ねる)。
  useEffect(() => connectLiveBriefStore(), []);

  // 意味イベントの取得は「選んでいる1セッション」だけ。閉じたら止める。
  const selectedSessionId = selectedCard?.tab.sessionId ?? null;
  useEffect(() => {
    if (!selectedSessionId) {
      stopEventPolling();
      return;
    }
    startEventPolling(selectedSessionId);
    return () => stopEventPolling();
  }, [selectedSessionId]);

  useEffect(() => {
    if (!viewState.selectedTabId && selectedCard) viewState.setSelectedTabId(selectedCard.tab.id);
  }, [selectedCard, viewState]);

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
      const delta = event.key === "j" || event.key === "ArrowDown" ? 1 : event.key === "k" || event.key === "ArrowUp" ? -1 : 0;
      if (delta && orderedCards.length) {
        event.preventDefault();
        event.stopPropagation();
        const index = selectedCard ? orderedCards.findIndex((card) => card.tab.id === selectedCard.tab.id) : 0;
        viewState.setSelectedTabId(orderedCards[(index + delta + orderedCards.length) % orderedCards.length].tab.id);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close, jumpToCard, orderedCards, selectedCard, urgentCards, viewState]);

  const clearDone = () => {
    for (const card of clearableCards) {
      if (card.attention?.attentionId) {
        useSessionAttentionStore.getState().markSeen(card.tab.id, card.attention.attentionId);
      }
    }
  };
  const toggleWorkspace = (workspaceId: string | null) => {
    viewState.setWorkspaceFilter(viewState.workspaceFilter === workspaceId ? null : workspaceId);
  };

  return <div ref={rootRef} tabIndex={-1} role="region" aria-label={dashboardStrings.viewAriaLabel} style={rootStyle}>
    <header style={headerStyle}>
      <div style={headerRowStyle}>
        <strong>{dashboardStrings.buttonTitle}</strong>
        <span style={mutedStyle}>{dashboardStrings.totalSummary(cards.length, workspaces.length)}</span>
        <span style={{ ...chipStyle, color: "var(--status-waiting)" }}>{dashboardStrings.stateNeedsHuman} {counts.needsHuman + counts.error}</span>
        <span style={{ ...chipStyle, color: "var(--status-working)" }}>{dashboardStrings.stateRunning} {counts.running}</span>
        <span style={{ ...chipStyle, color: "var(--cmux-yellow)" }}>{dashboardStrings.stateNoUpdate} {counts.noUpdate}</span>
        <span style={{ ...chipStyle, color: "var(--status-done)" }}>{dashboardStrings.stateDone} {counts.done}</span>
        <span style={{ marginLeft: "auto", color: "var(--status-done)", fontSize: "var(--cmux-font-size-sm)" }}>{dashboardStrings.liveUpdating} ●</span>
        {clearableCards.length > 0 ? <button type="button" style={buttonStyle} onClick={clearDone}>{dashboardStrings.clearDoneButton(clearableCards.length)}</button> : null}
        <button type="button" style={buttonStyle} onClick={close}>{dashboardStrings.backToSession} (Esc)</button>
      </div>
      <div style={headerRowStyle}>
        <button type="button" style={filterChipStyle(viewState.workspaceFilter === null)} onClick={() => toggleWorkspace(null)}>
          {dashboardStrings.allWorkspaces} {cards.length}
        </button>
        {workspaces.map((workspace) => <button
          key={workspace.id}
          type="button"
          style={filterChipStyle(viewState.workspaceFilter === workspace.id)}
          onClick={() => toggleWorkspace(workspace.id)}
        >{workspace.name} {cards.filter((card) => card.workspaceId === workspace.id).length}</button>)}
        <button
          type="button"
          aria-pressed={viewState.quickFilters.needsHumanOnly}
          style={filterChipStyle(viewState.quickFilters.needsHumanOnly)}
          onClick={() => viewState.setQuickFilter("needsHumanOnly", !viewState.quickFilters.needsHumanOnly)}
        >{dashboardStrings.filterNeedsHumanOnly}</button>
        <select
          aria-label={dashboardStrings.agentFilterTitle}
          value={viewState.agentFilter ?? ""}
          onChange={(event) => viewState.setAgentFilter(event.target.value || null)}
          style={controlStyle}
        >
          <option value="">{dashboardStrings.agentFilterTitle}: {dashboardStrings.allWorkspaces}</option>
          {AGENT_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
        </select>
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
          aria-label={dashboardStrings.sortByAttention}
          value={viewState.sortMode}
          onChange={(event) => viewState.setSortMode(event.target.value as "attention" | "workspace")}
          style={controlStyle}
        >
          <option value="attention">{dashboardStrings.sortByAttention}</option>
          <option value="workspace">{dashboardStrings.sortByWorkspace}</option>
        </select>
        {filterActive ? <span style={mutedStyle}>{dashboardStrings.filteredSummary(filteredCards.length, cards.length)}</span> : null}
      </div>
    </header>
    <div style={{ flex: 1, minHeight: 0, display: "flex", overflow: "hidden" }}>
      <DashboardSessionList
        needsHuman={urgentCards}
        all={orderedCards}
        selectedTabId={selectedCard?.tab.id ?? null}
        now={now}
        onSelect={viewState.setSelectedTabId}
        onJump={jumpToCard}
        onHoverChange={setListHovered}
      />
      <DashboardSessionDetail card={selectedCard} now={now} onJump={jumpToCard} />
    </div>
    <footer style={footerStyle}>{dashboardStrings.keyboardHint}</footer>
  </div>;
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
  display: "grid",
  gap: 8,
  padding: "10px 14px",
  borderBottom: "1px solid var(--cmux-border)",
  background: "var(--cmux-popover)",
};
const headerRowStyle: CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, minWidth: 0 };
const mutedStyle: CSSProperties = { color: "var(--cmux-text-secondary)", fontSize: "var(--cmux-font-size-sm)" };
const chipStyle: CSSProperties = {
  border: "1px solid var(--cmux-border)",
  borderRadius: 999,
  fontSize: "var(--cmux-font-size-sm)",
  padding: "1px 8px",
};
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
const filterChipStyle = (selected: boolean): CSSProperties => ({
  background: selected ? "color-mix(in srgb, var(--cmux-accent) 16%, transparent)" : "transparent",
  border: `1px solid ${selected ? "var(--cmux-accent)" : "var(--cmux-border)"}`,
  borderRadius: 999,
  color: "var(--cmux-text)",
  cursor: "pointer",
  fontSize: "var(--cmux-font-size-sm)",
  padding: "2px 9px",
});
const footerStyle: CSSProperties = {
  borderTop: "1px solid var(--cmux-border)",
  padding: "7px 12px",
  color: "var(--cmux-text-secondary)",
  fontSize: "var(--cmux-font-size-sm)",
};
