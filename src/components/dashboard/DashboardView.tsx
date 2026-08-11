import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { focusController } from "../../lib/focusController";
import { useDashboardViewStore } from "../../stores/dashboardViewStore";
import { usePaneMetadataStore, useUiStore, useWorkspaceLayoutStore, useWorkspaceListStore } from "../../stores/workspaceStore";
import { useSessionAttentionStore } from "../../stores/sessionAttentionStore";
import { useStallStore } from "../../stores/stallStore";
import { hasTerminalBuffer } from "../terminal/XTermWrapper";
import { DashboardCard } from "./DashboardCard";
import { DashboardDetailPane } from "./DashboardDetailPane";
import {
  applyDashboardFilters,
  buildDashboardCards,
  groupSections,
  urgentRibbon,
  type DashboardCardModel,
} from "./dashboardModel";
import { dashboardStrings } from "./dashboardStrings";

function groupLabel(group: DashboardCardModel["group"]): string {
  if (group === "waiting") return dashboardStrings.groupWaiting;
  if (group === "stalled") return dashboardStrings.groupStalled;
  if (group === "done") return dashboardStrings.groupDone;
  if (group === "working") return dashboardStrings.groupWorking;
  return dashboardStrings.groupIdle;
}

function sectionTitle(sectionId: string, cards: readonly DashboardCardModel[]): string {
  const first = cards[0];
  if (!first) return sectionId;
  if (["waiting", "stalled", "working", "idle", "done"].includes(sectionId)) return groupLabel(sectionId as DashboardCardModel["group"]);
  if (["claude", "codex", "claude-codex", "none"].includes(sectionId)) return sectionId;
  return first.workspace.name;
}

export function DashboardView({ onClose }: { onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [now, setNow] = useState(() => Date.now());
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
  const cards = useMemo(() => buildDashboardCards(workspaces, {
    metadataBySession: metadataState.metadata,
    lastLogBySession: metadataState.lastLog,
    lastLogAtBySession: metadataState.lastLogAt,
    attentionBySession: attentionState.attentionBySession,
    seenAttentionByTab: attentionState.seenAttentionByTab,
    stallsBySession,
    now,
    hasTerminalBuffer,
  }), [attentionState, metadataState, now, stallsBySession, workspaces]);
  const filteredCards = useMemo(() => applyDashboardFilters(cards, {
    query: viewState.query,
    workspaceId: viewState.workspaceFilter,
    attentionOnly: viewState.quickFilters.attentionOnly,
    stalledOnly: viewState.quickFilters.stalledOnly,
    backgroundOnly: viewState.quickFilters.backgroundOnly,
    unobservedOnly: viewState.quickFilters.unobservedOnly,
    agentKind: viewState.agentFilter,
  }), [cards, viewState]);
  const sections = useMemo(() => groupSections(filteredCards, viewState.sortMode), [filteredCards, viewState.sortMode]);
  const orderedCards = useMemo(() => sections.flatMap((section) => section.cards), [sections]);
  const selectedCard = orderedCards.find((card) => card.tab.id === viewState.selectedTabId) ?? orderedCards[0] ?? null;
  const urgentCards = useMemo(() => urgentRibbon(filteredCards), [filteredCards]);

  useEffect(() => {
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    focusController.request("programmatic", { sessionId: null, focus: false });
    window.setTimeout(() => rootRef.current?.focus(), 0);
    return () => window.clearInterval(interval);
  }, []);

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
        const waiting = orderedCards.filter((card) => card.group === "waiting");
        if (!waiting.length) return;
        event.preventDefault();
        event.stopPropagation();
        const index = selectedCard ? waiting.findIndex((card) => card.tab.id === selectedCard.tab.id) : -1;
        viewState.setSelectedTabId(waiting[(index + 1 + waiting.length) % waiting.length].tab.id);
        return;
      }
      const delta = event.key === "j" || event.key === "ArrowDown" ? 1 : event.key === "k" || event.key === "ArrowUp" ? -1 : 0;
      if (delta && orderedCards.length) {
        event.preventDefault();
        event.stopPropagation();
        const index = selectedCard ? orderedCards.findIndex((card) => card.tab.id === selectedCard.tab.id) : 0;
        viewState.setSelectedTabId(orderedCards[(index + delta + orderedCards.length) % orderedCards.length].tab.id);
        return;
      }
      const sectionDelta = event.key === "h" || event.key === "ArrowLeft" ? -1 : event.key === "l" || event.key === "ArrowRight" ? 1 : 0;
      if (sectionDelta && sections.length) {
        event.preventDefault();
        event.stopPropagation();
        const currentSection = sections.findIndex((section) => section.cards.some((card) => card.tab.id === selectedCard?.tab.id));
        const next = sections[(Math.max(0, currentSection) + sectionDelta + sections.length) % sections.length];
        viewState.setSelectedTabId(next.cards[0].tab.id);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close, jumpToCard, orderedCards, sections, selectedCard, viewState]);

  const counts = {
    waiting: cards.filter((card) => card.group === "waiting").length,
    stalled: cards.filter((card) => card.group === "stalled").length,
    working: cards.filter((card) => card.group === "working").length,
    idle: cards.filter((card) => card.group === "idle").length,
    done: cards.filter((card) => card.group === "done").length,
  };
  const clearDone = () => {
    for (const card of cards) {
      if (card.attentionCategory === "done" && card.attention?.attentionId) {
        useSessionAttentionStore.getState().markSeen(card.tab.id, card.attention.attentionId);
      }
    }
  };

  return <div ref={rootRef} tabIndex={-1} role="region" aria-label={dashboardStrings.viewAriaLabel} style={rootStyle}>
    <header style={headerStyle}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}><strong>{dashboardStrings.buttonTitle}</strong><span style={{ color: "var(--cmux-text-secondary)", fontSize: "var(--cmux-font-size-sm)" }}>{dashboardStrings.totalSummary(cards.length, workspaces.length)}</span></div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {(["waiting", "stalled", "working", "idle", "done"] as const).map((group) => <span key={group} style={chipStyle}>{groupLabel(group)} {counts[group]}</span>)}
        </div>
      </div>
      <span style={{ color: "var(--status-done)", fontSize: "var(--cmux-font-size-xs)" }}>{dashboardStrings.liveUpdating} ●</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-end" }}>
        <input ref={searchRef} value={viewState.query} onChange={(event) => viewState.setQuery(event.target.value)} placeholder={dashboardStrings.searchPlaceholder} style={inputStyle} />
        <select aria-label={dashboardStrings.sortByAttention} value={viewState.sortMode} onChange={(event) => viewState.setSortMode(event.target.value as "attention" | "workspace" | "agent")} style={controlStyle}>
          <option value="attention">{dashboardStrings.sortByAttention}</option><option value="workspace">{dashboardStrings.sortByWorkspace}</option><option value="agent">{dashboardStrings.sortByAgent}</option>
        </select>
        {counts.done > 0 ? <button type="button" style={buttonStyle} onClick={clearDone}>{dashboardStrings.clearDoneButton(counts.done)}</button> : null}
        <button type="button" style={buttonStyle} onClick={close}>{dashboardStrings.backToSession} (Esc)</button>
      </div>
    </header>
    <div style={{ flex: 1, minHeight: 0, display: "flex", overflow: "hidden" }}>
      <aside style={railStyle}>
        <button type="button" style={railButtonStyle(viewState.workspaceFilter === null)} onClick={() => viewState.setWorkspaceFilter(null)}>{dashboardStrings.allWorkspaces} <span>{cards.length}</span></button>
        {workspaces.map((workspace) => <button key={workspace.id} type="button" style={railButtonStyle(viewState.workspaceFilter === workspace.id)} onClick={() => viewState.setWorkspaceFilter(workspace.id)}>{workspace.name} <span>{cards.filter((card) => card.workspaceId === workspace.id).length}</span></button>)}
        <strong style={railLabelStyle}>{dashboardStrings.filterTitle}</strong>
        {([ ["attentionOnly", dashboardStrings.filterAttentionOnly], ["stalledOnly", dashboardStrings.filterStalledOnly], ["backgroundOnly", dashboardStrings.filterBackgroundOnly], ["unobservedOnly", dashboardStrings.filterUnobservedOnly] ] as const).map(([key, label]) => <label key={key} style={checkStyle}><input type="checkbox" checked={viewState.quickFilters[key]} onChange={(event) => viewState.setQuickFilter(key, event.target.checked)} /> {label}</label>)}
        <strong style={railLabelStyle}>{dashboardStrings.agentFilterTitle}</strong>
        <select value={viewState.agentFilter ?? ""} onChange={(event) => viewState.setAgentFilter(event.target.value || null)} style={controlStyle}><option value="">{dashboardStrings.allWorkspaces}</option><option value="claude">claude</option><option value="codex">codex</option><option value="claude-codex">claude-codex</option><option value="none">none</option></select>
      </aside>
      <main style={{ flex: 1, minWidth: 0, overflow: "auto", padding: 14 }}>
        {viewState.query || viewState.workspaceFilter || Object.values(viewState.quickFilters).some(Boolean) || viewState.agentFilter ? <div style={{ color: "var(--cmux-text-secondary)", fontSize: "var(--cmux-font-size-xs)", marginBottom: 10 }}>{dashboardStrings.filteredSummary(filteredCards.length, cards.length)}</div> : null}
        {urgentCards.length ? <section style={{ marginBottom: 18 }}><div style={sectionHeadingStyle}>{dashboardStrings.urgentRibbonTitle}</div><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 8 }}>{urgentCards.map((card) => <DashboardCard key={card.tab.id} card={card} selected={selectedCard?.tab.id === card.tab.id} now={now} urgent onSelect={viewState.setSelectedTabId} onJump={jumpToCard} />)}</div></section> : null}
        {sections.map((section) => <section key={section.id} style={{ marginBottom: 18 }}><div style={sectionHeadingStyle}>{sectionTitle(section.id, section.cards)} ({section.cards.length})</div><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 8 }}>{section.cards.map((card) => <DashboardCard key={card.tab.id} card={card} selected={selectedCard?.tab.id === card.tab.id} now={now} onSelect={viewState.setSelectedTabId} onJump={jumpToCard} />)}</div></section>)}
      </main>
      <DashboardDetailPane card={selectedCard} now={now} onJump={jumpToCard} />
    </div>
    <footer style={{ borderTop: "1px solid var(--cmux-border)", padding: "7px 12px", color: "var(--cmux-text-secondary)", fontSize: "var(--cmux-font-size-xs)" }}>{dashboardStrings.keyboardHint}</footer>
  </div>;
}

const rootStyle = { position: "absolute" as const, inset: 0, zIndex: 40, background: "var(--cmux-bg)", color: "var(--cmux-text)", display: "flex", flexDirection: "column" as const, outline: "none" };
const headerStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" as const, padding: "12px 14px", borderBottom: "1px solid var(--cmux-border)", background: "var(--cmux-popover)" };
const chipStyle = { border: "1px solid var(--cmux-border)", borderRadius: 999, color: "var(--cmux-text-secondary)", fontSize: "var(--cmux-font-size-xs)", padding: "2px 7px" };
const controlStyle = { background: "var(--cmux-bg)", border: "1px solid var(--cmux-border)", borderRadius: "var(--cmux-radius-sm)", color: "var(--cmux-text)", fontSize: "var(--cmux-font-size-xs)", minHeight: 27, padding: "3px 6px" };
const inputStyle = { ...controlStyle, width: 240 };
const buttonStyle = { ...controlStyle, cursor: "pointer" };
const railStyle = { flex: "0 0 220px", width: 220, overflow: "auto", borderRight: "1px solid var(--cmux-border)", background: "var(--cmux-popover)", padding: 10, display: "flex", flexDirection: "column" as const, gap: 5 };
const railButtonStyle = (selected: boolean) => ({ display: "flex", justifyContent: "space-between", gap: 8, background: selected ? "color-mix(in srgb, var(--cmux-accent) 14%, transparent)" : "transparent", border: "1px solid transparent", borderRadius: "var(--cmux-radius-sm)", color: "var(--cmux-text)", cursor: "pointer", fontSize: "var(--cmux-font-size-xs)", padding: "5px 6px", textAlign: "left" as const });
const railLabelStyle = { marginTop: 12, color: "var(--cmux-text-secondary)", fontSize: "var(--cmux-font-size-xs)" };
const checkStyle = { color: "var(--cmux-text-secondary)", fontSize: "var(--cmux-font-size-xs)" };
const sectionHeadingStyle = { marginBottom: 8, color: "var(--cmux-text-secondary)", fontSize: "var(--cmux-font-size-sm)", fontWeight: 700 };
