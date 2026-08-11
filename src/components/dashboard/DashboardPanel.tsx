import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { AgentKindIcon } from "../icons/AgentIcons";
import { focusController } from "../../lib/focusController";
import { deriveDisplayStatus } from "../../lib/notificationStatus";
import { getTabDisplayLabel } from "../../lib/tabDisplayLabel";
import { useRecentInputStore } from "../../stores/recentInputStore";
import { useStallStore, type StallEntry } from "../../stores/stallStore";
import {
  attentionCategory,
  attentionDetail,
  useSessionAttentionStore,
  type AttentionCategory,
  type SessionAttention,
} from "../../stores/sessionAttentionStore";
import {
  usePaneMetadataStore,
  useUiStore,
  useWorkspaceLayoutStore,
  useWorkspaceListStore,
} from "../../stores/workspaceStore";
import type { Pane, PaneTab, Workspace } from "../../types";
import { getTerminalWriteCounter, hasTerminalBuffer } from "../terminal/XTermWrapper";
import { readPaneTail } from "../layout/socketCommands";
import { dashboardStrings } from "./dashboardStrings";

type DashboardGroup = "waiting" | "stalled" | "working" | "done";
type DashboardStatus = DashboardGroup | "error" | "unobserved" | "idle";

interface DashboardCardModel {
  workspace: Workspace;
  workspaceId: string;
  workspaceIndex: number;
  pane: Pane;
  paneId: string;
  paneIndex: number;
  tab: PaneTab;
  tabIndex: number;
  background: boolean;
  attention?: SessionAttention;
  attentionCategory: AttentionCategory | null;
  group: DashboardGroup;
  status: DashboardStatus;
  stall?: StallEntry;
}

interface DashboardPanelProps {
  open: boolean;
  visible: boolean;
  closing?: boolean;
  onClose: () => void;
}

const GROUP_ORDER: DashboardGroup[] = ["waiting", "stalled", "working", "done"];
const ATTENTION_PRIORITY: Record<AttentionCategory, number> = { waiting: 0, error: 1, done: 2 };
const statusColors: Record<DashboardStatus, string> = {
  waiting: "#d69e2e",
  error: "#e05a47",
  stalled: "#8b5cf6",
  working: "#3b82f6",
  done: "#38a169",
  unobserved: "#64748b",
  idle: "#64748b",
};

function groupLabel(group: DashboardGroup): string {
  if (group === "waiting") return dashboardStrings.groupWaiting;
  if (group === "stalled") return dashboardStrings.groupStalled;
  if (group === "working") return dashboardStrings.groupWorking;
  return dashboardStrings.groupDone;
}

function elapsedLabel(at: number | undefined, now: number): string {
  if (!at) return "";
  return `${Math.max(0, Math.floor((now - at) / 60_000))}m`;
}

function buildDashboardCards(
  workspaces: Workspace[],
  metadata: Array<ReturnType<typeof usePaneMetadataStore.getState>["metadata"][string] | undefined>,
  attentionBySession: Array<SessionAttention | undefined>,
  seenAttentionByTab: Map<string, string>,
  stalls: Array<StallEntry | undefined>,
): DashboardCardModel[] {
  let item = 0;
  const cards: DashboardCardModel[] = [];
  for (const [workspaceIndex, workspace] of workspaces.entries()) {
    for (const [paneIndex, pane] of workspace.panes.entries()) {
      for (const [tabIndex, tab] of pane.tabs.entries()) {
        const metadataItem = metadata[item];
        const attention = attentionBySession[item];
        const category = attentionCategory(tab.id, attention, seenAttentionByTab);
        const isUnobserved = !hasTerminalBuffer(tab.sessionId);
        const stall = stalls[item];
        const stalled = Boolean(stall);
        const activity = deriveDisplayStatus(metadataItem);
        const group: DashboardGroup = category === "waiting" || category === "error"
          ? "waiting"
          : category === "done"
            ? "done"
            : stalled
              ? "stalled"
              : "working";
        const status: DashboardStatus = category === "error"
          ? "error"
          : category ?? (stalled ? "stalled" : (isUnobserved ? "unobserved" : activity));
        cards.push({
          workspace,
          workspaceId: workspace.id,
          workspaceIndex,
          pane,
          paneId: pane.id,
          paneIndex,
          tab,
          tabIndex,
          background: tab.id !== pane.activeTabId,
          attention,
          attentionCategory: category,
          group,
          status,
          stall,
        });
        item += 1;
      }
    }
  }
  return cards;
}

function sortCards(cards: DashboardCardModel[]): DashboardCardModel[] {
  return [...cards].sort((left, right) => {
    const leftPriority = left.attentionCategory ? ATTENTION_PRIORITY[left.attentionCategory] : 3;
    const rightPriority = right.attentionCategory ? ATTENTION_PRIORITY[right.attentionCategory] : 3;
    return leftPriority - rightPriority
      || (left.attention?.occurrenceOrder ?? 0) - (right.attention?.occurrenceOrder ?? 0)
      || left.workspaceIndex - right.workspaceIndex
      || left.paneIndex - right.paneIndex
      || left.tabIndex - right.tabIndex;
  });
}

export function DashboardPanel({ open, visible, closing = false, onClose }: DashboardPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const [sortMode, setSortMode] = useState<"attention" | "workspace">("attention");
  const [now, setNow] = useState(() => Date.now());
  const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
  const [peekTabId, setPeekTabId] = useState<string | null>(null);
  const workspaces = useWorkspaceListStore((state) => state.workspaces);
  const sessionIds = useMemo(() => workspaces.flatMap((workspace) => workspace.panes.flatMap((pane) => pane.tabs.map((tab) => tab.sessionId))), [workspaces]);
  const metadata = usePaneMetadataStore(useShallow((state) => sessionIds.map((sessionId) => state.metadata[sessionId])));
  const stalls = useStallStore(useShallow((state) => sessionIds.map((sessionId) => state.entries[sessionId])));
  const attentionBySession = useSessionAttentionStore(useShallow((state) => sessionIds.map((sessionId) => state.attentionBySession[sessionId])));
  const seenAttentionByTab = useSessionAttentionStore((state) => state.seenAttentionByTab);

  const cards = useMemo(
    () => buildDashboardCards(workspaces, metadata, attentionBySession, seenAttentionByTab, stalls),
    [attentionBySession, metadata, seenAttentionByTab, stalls, workspaces],
  );
  const orderedCards = useMemo(() => sortCards(cards), [cards]);
  const selectedCard = orderedCards.find((card) => card.tab.id === selectedTabId) ?? orderedCards[0] ?? null;
  const peekCard = orderedCards.find((card) => card.tab.id === peekTabId) ?? null;

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    window.setTimeout(() => panelRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (visible) return;
    const previous = previouslyFocusedRef.current;
    if (previous && document.contains(previous)) previous.focus();
  }, [visible]);

  useEffect(() => {
    if (!open || selectedTabId || orderedCards.length === 0) return;
    setSelectedTabId(orderedCards[0].tab.id);
  }, [open, orderedCards, selectedTabId]);

  useEffect(() => {
    if (!selectedCard) return;
    cardRefs.current.get(selectedCard.tab.id)?.scrollIntoView({ block: "nearest" });
  }, [selectedCard]);

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
    if (!open || closing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLElement && event.target.isContentEditable)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (peekTabId) setPeekTabId(null);
        else onClose();
        return;
      }
      if (event.key === "Enter" && selectedCard) {
        event.preventDefault();
        setPeekTabId(selectedCard.tab.id);
        return;
      }
      if (peekTabId && (event.key === "ArrowLeft" || event.key === "ArrowRight") && orderedCards.length) {
        event.preventDefault();
        const index = orderedCards.findIndex((card) => card.tab.id === peekTabId);
        const delta = event.key === "ArrowLeft" ? -1 : 1;
        const nextIndex = (index + delta + orderedCards.length) % orderedCards.length;
        setPeekTabId(orderedCards[nextIndex].tab.id);
        setSelectedTabId(orderedCards[nextIndex].tab.id);
        return;
      }
      const delta = event.key === "j" || event.key === "ArrowDown" ? 1 : event.key === "k" || event.key === "ArrowUp" ? -1 : 0;
      if (delta && orderedCards.length) {
        event.preventDefault();
        const index = selectedCard ? orderedCards.findIndex((card) => card.tab.id === selectedCard.tab.id) : 0;
        setSelectedTabId(orderedCards[(index + delta + orderedCards.length) % orderedCards.length].tab.id);
        return;
      }
      if (event.key === "Tab") {
        const waiting = orderedCards.filter((card) => card.group === "waiting");
        if (!waiting.length) return;
        event.preventDefault();
        const index = selectedCard ? waiting.findIndex((card) => card.tab.id === selectedCard.tab.id) : -1;
        setSelectedTabId(waiting[(index + 1 + waiting.length) % waiting.length].tab.id);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closing, onClose, open, orderedCards, peekTabId, selectedCard]);

  if (!visible) return null;

  const groupCounts = GROUP_ORDER.reduce<Record<DashboardGroup, number>>((counts, group) => {
    counts[group] = cards.filter((card) => card.group === group).length;
    return counts;
  }, { waiting: 0, stalled: 0, working: 0, done: 0 });
  const backgroundCount = cards.filter((card) => card.background).length;
  const visibleCount = cards.length - backgroundCount;
  const clearDone = () => {
    for (const card of cards) {
      if (card.attentionCategory === "done" && card.attention?.attentionId) {
        useSessionAttentionStore.getState().markSeen(card.tab.id, card.attention.attentionId);
      }
    }
  };

  return (
    <div className={`cmux-overlay-backdrop${closing ? " is-closing" : ""}`} inert={closing ? true : undefined} aria-hidden={closing ? true : undefined} style={backdropStyle} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div id="dashboard-panel" ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={dashboardStrings.panelAriaLabel} className={`cmux-overlay-panel${closing ? " is-closing" : ""}`} style={panelStyle} onMouseDown={(event) => event.stopPropagation()}>
        <header style={headerStyle}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{dashboardStrings.buttonTitle}</div>
            <div style={{ color: "var(--cmux-text-secondary)", fontSize: 12, marginTop: 3 }}>{dashboardStrings.countUnit(cards.length)}</div>
          </div>
          <div style={chipRowStyle}>
            {GROUP_ORDER.map((group) => <span key={group} style={chipStyle}>{groupLabel(group)} {groupCounts[group]}</span>)}
            <span style={chipStyle}>{dashboardStrings.visibleCount} {visibleCount}</span>
            <span style={chipStyle}>{dashboardStrings.backgroundCount} {backgroundCount}</span>
          </div>
          <div style={{ ...chipRowStyle, justifyContent: "flex-end" }}>
            <span style={{ color: "#4ade80", fontSize: 12 }}>{dashboardStrings.liveUpdating}</span>
            <button type="button" onClick={() => setSortMode((value) => value === "attention" ? "workspace" : "attention")} style={buttonStyle}>{sortMode === "attention" ? dashboardStrings.sortByWorkspace : dashboardStrings.sortByAttention}</button>
            {groupCounts.done > 0 ? <button type="button" onClick={clearDone} style={buttonStyle}>{dashboardStrings.clearDoneButton(groupCounts.done)}</button> : null}
          </div>
        </header>
        <main style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 16 }}>
          {cards.length === 0 ? <div style={{ color: "var(--cmux-text-secondary)", padding: 24 }}>{dashboardStrings.emptyState}</div> : sortMode === "attention" ? (
            GROUP_ORDER.map((group) => {
              const groupCards = orderedCards.filter((card) => card.group === group);
              if (!groupCards.length) return null;
              return <DashboardSection key={group} title={groupLabel(group)} subtitle={group === "waiting" ? dashboardStrings.groupWaitingSub : group === "stalled" ? dashboardStrings.groupStalledSub : undefined} cards={groupCards} selectedTabId={selectedCard?.tab.id ?? null} now={now} cardRefs={cardRefs} onSelect={setSelectedTabId} onPeek={setPeekTabId} onJump={jumpToCard} />;
            })
          ) : (
            workspaces.map((workspace) => {
              const workspaceCards = sortCards(cards.filter((card) => card.workspaceId === workspace.id));
              if (!workspaceCards.length) return null;
              const workspaceBackground = workspaceCards.filter((card) => card.background).length;
              return <DashboardSection key={workspace.id} title={`${workspace.name} · ${dashboardStrings.countUnit(workspaceCards.length)}`} subtitle={`${dashboardStrings.backgroundCount} ${workspaceBackground}`} cards={workspaceCards} selectedTabId={selectedCard?.tab.id ?? null} now={now} cardRefs={cardRefs} onSelect={setSelectedTabId} onPeek={setPeekTabId} onJump={jumpToCard} />;
            })
          )}
        </main>
        {peekCard ? <DashboardPeek card={peekCard} cards={orderedCards} now={now} onClose={() => setPeekTabId(null)} onChange={(card) => { setPeekTabId(card.tab.id); setSelectedTabId(card.tab.id); }} onJump={jumpToCard} /> : null}
      </div>
    </div>
  );
}

function DashboardSection({ title, subtitle, cards, selectedTabId, now, cardRefs, onSelect, onPeek, onJump }: { title: string; subtitle?: string; cards: DashboardCardModel[]; selectedTabId: string | null; now: number; cardRefs: React.MutableRefObject<Map<string, HTMLDivElement>>; onSelect: (tabId: string) => void; onPeek: (tabId: string) => void; onJump: (card: DashboardCardModel) => void }) {
  return <section style={{ marginBottom: 18 }}>
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}><strong>{title}</strong>{subtitle ? <span style={{ color: "var(--cmux-text-secondary)", fontSize: 12 }}>{subtitle}</span> : null}</div>
    <div style={{ display: "grid", gap: 8 }}>{cards.map((card) => <DashboardCard key={card.tab.id} card={card} selected={selectedTabId === card.tab.id} now={now} cardRefs={cardRefs} onSelect={onSelect} onPeek={onPeek} onJump={onJump} />)}</div>
  </section>;
}

function DashboardCard({ card, selected, now, cardRefs, onSelect, onPeek, onJump }: { card: DashboardCardModel; selected: boolean; now: number; cardRefs: React.MutableRefObject<Map<string, HTMLDivElement>>; onSelect: (tabId: string) => void; onPeek: (tabId: string) => void; onJump: (card: DashboardCardModel) => void }) {
  const [metadata, lastLog] = usePaneMetadataStore(useShallow((state) => [
    state.metadata[card.tab.sessionId],
    state.lastLog[card.tab.sessionId],
  ]));
  const recentInput = useRecentInputStore((state) => state.recentBySession[card.tab.sessionId]);
  const label = getTabDisplayLabel(card.tab, !card.background, { [card.tab.sessionId]: metadata });
  const statusAt = metadata?.screenStatusAt ?? metadata?.agentStatusAt;
  const asking = attentionDetail(card.attention);
  const done = card.group === "done";
  return <div ref={(element) => { if (element) cardRefs.current.set(card.tab.id, element); else cardRefs.current.delete(card.tab.id); }} role="button" tabIndex={-1} onClick={() => onSelect(card.tab.id)} style={{ border: `1px solid ${selected ? "var(--cmux-accent)" : "var(--cmux-border)"}`, borderLeft: `3px solid ${statusColors[card.status]}`, borderRadius: 7, padding: "10px 12px", opacity: done ? 0.62 : 1, background: "var(--cmux-bg)", outline: selected ? "2px solid color-mix(in srgb, var(--cmux-accent) 45%, transparent)" : "none" }}>
    <div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
      <AgentKindIcon kind={metadata?.agentKind ?? card.tab.agentKind} size={14} />
      <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</strong>
      <span style={{ color: "var(--cmux-text-secondary)", fontSize: 12 }}>{dashboardStrings.paneLocation(card.tabIndex + 1, card.paneIndex + 1)}</span>
      {card.background ? <span style={badgeStyle}>{dashboardStrings.backgroundBadge}</span> : null}
      {card.status === "unobserved" ? <span style={badgeStyle}>{dashboardStrings.unobservedBadge}</span> : null}
      <span style={{ ...badgeStyle, color: statusColors[card.status], marginLeft: "auto" }}>{groupLabel(card.group)}</span>
      <span style={{ color: "var(--cmux-text-secondary)", fontSize: 12 }}>{elapsedLabel(statusAt, now)}</span>
      <button type="button" style={buttonStyle} onClick={(event) => { event.stopPropagation(); onPeek(card.tab.id); }}>{dashboardStrings.peekButton}</button>
      <button type="button" title={dashboardStrings.jumpButtonTitle} style={buttonStyle} onClick={(event) => { event.stopPropagation(); onJump(card); }}>{dashboardStrings.jumpButton}</button>
    </div>
    {!done ? <div style={{ display: "grid", gap: 5, marginTop: 8, fontSize: 12 }}>
      {recentInput ? <InfoLine label={dashboardStrings.myInstructionLabel} value={recentInput.text} /> : null}
      {asking ? <InfoLine label={dashboardStrings.agentAskingLabel} value={asking} /> : null}
      {card.stall ? <StallReason entry={card.stall} now={now} /> : null}
      {lastLog ? <div style={{ fontFamily: "monospace", color: "var(--cmux-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lastLog}</div> : null}
    </div> : null}
  </div>;
}

function StallReason({ entry, now }: { entry: StallEntry; now: number }) {
  const reason = entry.reason === "queued_input"
    ? dashboardStrings.stallQueuedInput
    : entry.reason === "pty_dead"
      ? dashboardStrings.stallPtyDead
      : dashboardStrings.stallNoOutput;
  return <div style={{ display: "grid", gap: 4, padding: "4px 9px", borderRadius: 7, border: "1px solid #4a3d59", background: "#231c2e", color: "#d8c6ea" }}>
    <InfoLine label={reason} value={dashboardStrings.stallSince(Math.max(0, Math.floor((now - entry.since) / 60_000)))} />
    {entry.reason === "queued_input" && entry.detail ? <InfoLine label={dashboardStrings.stallQueuedPreviewLabel} value={entry.detail} /> : null}
  </div>;
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return <div style={{ display: "flex", gap: 8, minWidth: 0 }}><span style={{ color: "var(--cmux-text-secondary)", flex: "0 0 auto" }}>{label}</span><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span></div>;
}

function DashboardPeek({ card, cards, now, onClose, onChange, onJump }: { card: DashboardCardModel; cards: DashboardCardModel[]; now: number; onClose: () => void; onChange: (card: DashboardCardModel) => void; onJump: (card: DashboardCardModel) => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [unobserved, setUnobserved] = useState(false);
  const writeCounterRef = useRef<number | null>(null);
  const recentInput = useRecentInputStore((state) => state.recentBySession[card.tab.sessionId]);
  const metadata = usePaneMetadataStore((state) => state.metadata[card.tab.sessionId]);
  const label = getTabDisplayLabel(card.tab, !card.background, { [card.tab.sessionId]: metadata });
  const index = cards.findIndex((candidate) => candidate.tab.id === card.tab.id);
  const previous = cards[(index - 1 + cards.length) % cards.length];
  const next = cards[(index + 1) % cards.length];
  const refresh = useCallback(async () => {
    const counter = getTerminalWriteCounter(card.tab.sessionId);
    if (writeCounterRef.current === counter && lines.length) return;
    writeCounterRef.current = counter;
    try {
      setLines(await readPaneTail(card.tab.sessionId, 40));
      setUnobserved(false);
    } catch {
      setLines([]);
      setUnobserved(true);
    }
  }, [card.tab.sessionId, lines.length]);
  useEffect(() => {
    writeCounterRef.current = null;
    void refresh();
    const interval = window.setInterval(() => {
      if (hasTerminalBuffer(card.tab.sessionId)) void refresh();
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [card.tab.sessionId, refresh]);
  return <div style={{ position: "absolute", inset: 12, background: "var(--cmux-popover)", border: "1px solid var(--cmux-border)", borderRadius: 8, boxShadow: "var(--cmux-shadow-dialog)", display: "flex", flexDirection: "column", padding: 16, zIndex: 1 }}>
    <div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
      <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{card.workspace.name} › {label} › {dashboardStrings.paneLocation(card.tabIndex + 1, card.paneIndex + 1)}</strong>
      <span style={{ color: "var(--cmux-text-secondary)", fontSize: 12, marginLeft: "auto" }}>{elapsedLabel(metadata?.screenStatusAt ?? metadata?.agentStatusAt, now)}</span>
      <button type="button" style={buttonStyle} onClick={() => onChange(previous)}>{dashboardStrings.peekPrev}</button>
      <button type="button" style={buttonStyle} onClick={() => onChange(next)}>{dashboardStrings.peekNext}</button>
      <button type="button" style={buttonStyle} onClick={() => onJump(card)}>{dashboardStrings.jumpButton}</button>
      <button type="button" style={buttonStyle} onClick={onClose}>{dashboardStrings.peekEscHint}</button>
    </div>
    <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
      {recentInput ? <InfoLine label={dashboardStrings.myInstructionLabel} value={recentInput.text} /> : null}
      {attentionDetail(card.attention) ? <InfoLine label={dashboardStrings.agentAskingLabel} value={attentionDetail(card.attention) ?? ""} /> : null}
    </div>
    <pre style={{ flex: 1, minHeight: 0, overflow: "auto", margin: "14px 0 0", padding: 12, borderRadius: 6, background: "var(--cmux-bg)", fontSize: 12, whiteSpace: "pre-wrap" }}>{unobserved ? dashboardStrings.unobservedBadge : lines.join("\n")}</pre>
  </div>;
}

const backdropStyle = { position: "fixed" as const, inset: 0, background: "var(--cmux-backdrop)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 1000, padding: 16 };
const panelStyle = { width: "min(1380px, calc(100vw - 32px))", height: "min(920px, calc(100vh - 32px))", background: "var(--cmux-popover)", border: "1px solid var(--cmux-border)", borderRadius: 10, boxShadow: "var(--cmux-shadow-dialog)", color: "var(--cmux-text)", overflow: "hidden", display: "flex", flexDirection: "column" as const, position: "relative" as const };
const headerStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--cmux-border)", flexWrap: "wrap" as const };
const chipRowStyle = { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" as const };
const chipStyle = { fontSize: 11, color: "var(--cmux-text-secondary)", border: "1px solid var(--cmux-border)", borderRadius: 999, padding: "2px 6px" };
const badgeStyle = { fontSize: 11, border: "1px solid var(--cmux-border)", borderRadius: 999, padding: "1px 5px" };
const buttonStyle = { background: "transparent", border: "1px solid var(--cmux-border)", color: "var(--cmux-text)", borderRadius: 4, cursor: "pointer", padding: "3px 7px", fontSize: 12 };
