import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { ArrowDownToLine, Search, X } from "lucide-react";
import { ArchiveTranscript } from "../dashboard/ArchiveTranscript";
import type { DashboardCardModel } from "../dashboard/dashboardModel";
const AgentTabConversationControls = lazy(() => import("./AgentTabConversationControls").then(module => ({ default: module.AgentTabConversationControls })));
const AgentTabOptimisticMessages = lazy(() => import("./AgentTabConversationControls").then(module => ({ default: module.AgentTabOptimisticMessages })));
import { agentTabStrings } from "./agentTabStrings";
import { conversationFallback } from "./agentTabConversationModel";
import { useComposerStore } from "../../stores/composerStore";
import { useKeybindingStore } from "../../stores/keybindingStore";
import { focusController } from "../../lib/focusController";
import { useUiStore } from "../../stores/uiStore";

import { ChatTranscript } from "../dashboard/ChatTranscript";
import { holdDetailSession, useLiveBriefStore } from "../../stores/liveBriefStore";
import { useDashboardViewStore } from "../../stores/dashboardViewStore";
import { terminalTurnStrings } from "./terminalTurnStrings";
import { captureTemporaryFocusReturn } from "../../lib/focusController";
import { useArchiveDescriptor, useTranscriptHistory } from "../dashboard/useTranscriptHistory";
import { descriptorKey, type HistoryState, type TranscriptHistoryReader } from "../../stores/transcriptHistoryStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { connectLiveBriefStore } from "../../stores/liveBriefStore";
import { useSessionAttentionStore } from "../../stores/sessionAttentionStore";
import { TranscriptSearch } from "../../stores/transcriptSearchStore";
import { TranscriptHistorySearchBar } from "./TranscriptHistorySearchBar";

const noSubscription = () => () => {};
const noSnapshot = () => null;

/**
 * The conversation history, read inside the pane it belongs to.
 *
 * A claude pane draws on the alternate screen and keeps nothing in its buffer,
 * so the turn chip used to have only one thing to offer: leaving for the
 * Dashboard. This renders the same transcript the Dashboard renders -- the same
 * component, the same events, the same turn-jump requests -- over the terminal
 * instead of away from it.
 */

export interface TerminalTranscriptPanelProps {
  sessionId: string;
  tabId: string | null;
  agentKind?: string;
  onClose: () => void;
  onOpenDashboard?: () => void;
  archiveReader?: TranscriptHistoryReader;
  visible?: boolean;
  focusRequest?: number;
  fullTab?: {
    card: DashboardCardModel | null; cards: readonly DashboardCardModel[];
    active: boolean; inputRef: RefObject<HTMLTextAreaElement | null>;
    onEscape: () => void; onVisible: (visible: boolean) => void; top?: number;
  };
}

export function TerminalTranscriptPanel({
  sessionId,
  tabId,
  agentKind = "none",
  onClose,
  onOpenDashboard,
  archiveReader,
  visible = true,
  focusRequest = 0,
  fullTab,
}: TerminalTranscriptPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Opening/focusing history owns this interaction without activating its PTY.
  const [panelFocused, setPanelFocused] = useState(true);
  const focusReturnRef = useRef<ReturnType<typeof captureTemporaryFocusReturn> | null>(null);
  useEffect(() => {
    if (fullTab) return;
    const owner = panelRef.current;
    focusReturnRef.current = captureTemporaryFocusReturn(owner, null, () => panelRef.current);
    return () => focusReturnRef.current?.cancel();
  }, []);
  const finish = () => {
    onClose();
    focusReturnRef.current?.(panelRef.current);
  };
  const detailEvents = useLiveBriefStore((state) => state.eventsBySession[sessionId]);
  const listEvents = useLiveBriefStore((state) => state.listEventsBySession[sessionId]);
  const dashboardOpen = useDashboardViewStore((state) => state.open);
  const [documentVisible, setDocumentVisible] = useState(!document.hidden);
  useEffect(() => {
    const changed = () => setDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  const live = visible && !dashboardOpen && documentVisible;
  const [tabSearchOpen, setTabSearchOpen] = useState(false);
  const [navigationTarget, setNavigationTarget] = useState<HTMLDivElement | null>(null);
  const lastFocusRequest = useRef(focusRequest);
  const events = detailEvents ?? listEvents ?? [];
  const detailLoaded = useLiveBriefStore((state) => state.eventsFetchedAtBySession[sessionId] != null);
  const brief = useLiveBriefStore((state) => state.briefsBySession[sessionId]);
  const mode = useSettingsStore((s) => s.conversationHistoryMode);
  const mappedDescriptor = useArchiveDescriptor(sessionId, tabId, !fullTab || live);
  // The hook can still contain a previous binding during a props transition.
  const descriptor = mappedDescriptor?.ptySessionId === sessionId && mappedDescriptor.tabId === tabId ? mappedDescriptor : null;
  const [search] = useState(() => new TranscriptSearch());
  const searchState = useSyncExternalStore(search.subscribe, search.getSnapshot, search.getSnapshot);
  const retained = useRef({ sessionId, tabId, enabled: false, archiveStarted: false });
  if (retained.current.sessionId !== sessionId || retained.current.tabId !== tabId) retained.current = { sessionId, tabId, enabled: false, archiveStarted: false };
  if (archiveReader || agentKind === "claude" || agentKind === "claude-codex" || agentKind === "codex" || descriptor) retained.current.enabled = true;
  const openTabSearch = useCallback(() => {
    if (!live || !retained.current.enabled) return;
    setTabSearchOpen(true);
    panelRef.current?.querySelector<HTMLInputElement>("[data-transcript-search-input]")?.focus();
  }, [live]);
  useLayoutEffect(() => {
    if (lastFocusRequest.current === focusRequest) return;
    lastFocusRequest.current = focusRequest;
    if (visible && !dashboardOpen) {
      if (fullTab) openTabSearch();
      else panelRef.current?.querySelector<HTMLInputElement>("[data-transcript-search-input]")?.focus();
    }
  }, [focusRequest, visible, dashboardOpen, openTabSearch]);
  useLayoutEffect(() => {
    if (fullTab && tabSearchOpen && live && retained.current.enabled) panelRef.current?.querySelector<HTMLInputElement>("[data-transcript-search-input]")?.focus();
  }, [tabSearchOpen, focusRequest, live]);
  const ordinaryArchive = mode !== "legacy" && retained.current.enabled;
  const archiveEnabled = ordinaryArchive || !!searchState.normalizedQuery;
  // Legacy clear pauses display; null would freeze a still-valid binding.
  if (archiveEnabled) retained.current.archiveStarted = true;
  const reader = useTranscriptHistory(retained.current.archiveStarted && (!fullTab || live) ? descriptor : null, retained.current.archiveStarted ? archiveReader : undefined);
  const readerState = useSyncExternalStore(reader?.subscribe ?? noSubscription, reader?.getSnapshot ?? noSnapshot, reader?.getSnapshot ?? noSnapshot);
  const exactDescriptor = descriptor && (!readerState || readerState.status !== "closed" && !["bindingChanged", "sourceChanged", "identityMismatch"].includes(readerState.error ?? "") && descriptorKey(readerState.descriptor) === descriptorKey(descriptor)) ? descriptor : null;
  const searchActive = visible && !dashboardOpen && documentVisible && panelFocused;
  useEffect(() => { reader?.setVisible(archiveEnabled && visible && !dashboardOpen && documentVisible); }, [reader, archiveEnabled, visible, dashboardOpen, documentVisible]);
  useLayoutEffect(() => { search.setContext(exactDescriptor, searchActive); }, [search, exactDescriptor, searchActive]);
  useEffect(() => () => search.dispose(), [search]);
  const attention = useSessionAttentionStore((s) => s.attentionBySession[sessionId]);

  // Hold this session's deep poll for as long as the reader is here, whether or
  // not the Dashboard is open. The hold also keeps the backend transcript sweep
  // subscribed: without it the panel would re-read a ring nobody refreshes and
  // the conversation would freeze at whatever the Dashboard last saw.
  const holdEvents = fullTab ? live : !archiveEnabled;
  const connectBrief = fullTab ? live : archiveEnabled;
  useEffect(() => holdEvents ? holdDetailSession(sessionId) : undefined, [sessionId, holdEvents]);
  useEffect(() => connectBrief ? connectLiveBriefStore() : undefined, [connectBrief]);

  // Only a failed read is reopened. Ordinary diagnostics leave its scan alone.
  const sourceKey = descriptor ? descriptorKey(descriptor) : null;
  const retry = useRef({ reader, sourceKey, delay: 3000 });
  if (retry.current.reader !== reader || retry.current.sourceKey !== sourceKey) retry.current = { reader, sourceKey, delay: 3000 };
  useEffect(() => {
    if (!fullTab || !live || !reader || !descriptor) return;
    if (descriptorKey(reader.snapshot.descriptor) !== descriptorKey(descriptor)) {
      reader.reopen(descriptor);
      return;
    }
    if (readerState?.status === "ready" && !readerState.error) {
      retry.current.delay = 3000;
      return;
    }
    if (!readerState?.error && readerState?.status !== "frozen" && readerState?.status !== "error") return;
    const delay = retry.current.delay;
    const timer = window.setTimeout(() => {
      retry.current.delay = Math.min(delay * 2, 60_000);
      reader.reopen(descriptor);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [Boolean(fullTab), live, reader, descriptor, readerState?.status, readerState?.error]);

  const fallback = fullTab ? conversationFallback({ agentKind, brief, events, archiveEnabled, descriptor, history: readerState }) : null;
  const lastReadable = useRef<{ sourceKey: string; state: HistoryState } | null>(null);
  if (!fullTab || !archiveEnabled || sourceKey !== lastReadable.current?.sourceKey) lastReadable.current = null;
  if (fullTab && archiveEnabled && sourceKey && !fallback && readerState) lastReadable.current = { sourceKey, state: readerState };
  else if (fallback !== "loading") lastReadable.current = null;
  const keepWhileLoading = Boolean(fullTab && archiveEnabled && fallback === "loading" && sourceKey && lastReadable.current?.sourceKey === sourceKey);
  const retainedArchiveState = keepWhileLoading && lastReadable.current ? { ...lastReadable.current.state, status: "opening" as const, loading: "initial" as const } : undefined;
  // A search-only legacy reader must not replace the conversation or release its focus.
  const displayFallback = fullTab && !ordinaryArchive && archiveEnabled
    ? conversationFallback({ agentKind, brief, events, archiveEnabled: false, descriptor, history: readerState })
    : keepWhileLoading ? null : fallback;
  const covered = Boolean(fullTab && !displayFallback && live);
  useLayoutEffect(() => {
    fullTab?.onVisible(covered);
    return () => fullTab?.onVisible(false);
  }, [covered, fullTab?.onVisible]);
  useLayoutEffect(() => {
    if (!covered || !fullTab?.active) return;
    const focused = document.activeElement;
    if (focused instanceof Element && focused.closest("[role=dialog],[role=menu],[aria-modal=true]")) return;
    if (panelRef.current?.contains(focused) && focused !== panelRef.current) return;
    if (fullTab.inputRef.current && !fullTab.inputRef.current.disabled) fullTab.inputRef.current.focus();
    else panelRef.current?.focus();
  }, [covered, fullTab?.active, sessionId]);
  const archiveEcho = useCallback((messages: readonly { text: string; occurredAt: number }[]) =>
    useComposerStore.getState().collapseDashboardOptimisticMessages(sessionId, messages), [sessionId]);

  useEffect(() => {
    if (fullTab) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !event.isComposing && !(event.target as Element)?.closest?.("[data-transcript-search]") && panelRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        event.stopPropagation();
        finish();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, Boolean(fullTab)]);

  const legacyBottom = useRef(true);
  const [legacyNewTail, setLegacyNewTail] = useState(false);
  const previousLegacy = useRef<{ sessionId: string; lastId: string | null } | null>(null);
  useEffect(() => {
    const previous = previousLegacy.current;
    previousLegacy.current = { sessionId, lastId: events[events.length - 1]?.eventId ?? null };
    if (!fullTab || archiveEnabled || !live || previous?.sessionId !== sessionId || !previous.lastId) return;
    const from = events.findIndex(event => event.eventId === previous.lastId);
    const arrived = from >= 0 ? events.slice(from + 1).filter(event => ["agentMessage", "toolStart", "toolEnd"].includes(event.kind.type)) : [];
    if (!arrived.length) return;
    if (!legacyBottom.current) { setLegacyNewTail(true); return; }
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (motion?.matches) return;
    const log = panelRef.current?.querySelector("[role=log]");
    const nodes = new Set<HTMLElement>();
    if (arrived.some(event => event.kind.type === "agentMessage")) {
      const replies = log?.querySelectorAll<HTMLElement>(".is-agent");
      if (replies?.length) nodes.add(replies[replies.length - 1]);
    }
    if (arrived.some(event => event.kind.type === "toolStart" || event.kind.type === "toolEnd")) {
      const tools = log?.querySelectorAll<HTMLElement>(".cmux-dashboard-toolfold");
      if (tools?.length) nodes.add(tools[tools.length - 1]);
    }
    nodes.forEach(node => node.setAttribute("data-agent-tab-arrival", "true"));
    const clear = () => nodes.forEach(node => node.removeAttribute("data-agent-tab-arrival"));
    const reduce = () => { if (motion?.matches) clear(); };
    const timer = window.setTimeout(clear, 1500);
    motion?.addEventListener?.("change", reduce);
    return () => { window.clearTimeout(timer); clear(); motion?.removeEventListener?.("change", reduce); };
  }, [events, sessionId, archiveEnabled, live, Boolean(fullTab)]);

  const searchBar = <TranscriptHistorySearchBar search={search} autoFocus={!fullTab || tabSearchOpen} inline={!!fullTab}
    preserveAppShortcuts={!!fullTab} onClose={fullTab ? () => { setTabSearchOpen(false); search.setQuery(""); fullTab.inputRef.current?.focus(); } : finish}
    visible={visible && !dashboardOpen} newTail={!!readerState?.newTail || !!readerState?.pages.some(page => searchState.snapshotEnd && BigInt(page.snapshotEnd) > BigInt(searchState.snapshotEnd))} />;
  const transcriptSearch = searchActive && exactDescriptor && searchState.identity === descriptorKey(exactDescriptor) ? {
    query: searchState.normalizedQuery, targetId: searchState.matches[searchState.selected] ?? null,
    generation: searchState.generation, navigation: searchState.navigation, identity: searchState.identity,
    snapshotEnd: searchState.snapshotEnd, sourceGeneration: searchState.sourceGeneration,
  } : undefined;
  if (fullTab && !live) return null;
  if (fullTab && displayFallback) return <div className="agent-tab-conversation-fallback" data-agent-tab-fallback={displayFallback} role="status" style={{ top: fullTab.top ?? 0 }}>
    {agentTabStrings.fallback[displayFallback]}
  </div>;

  return (
    <div ref={panelRef} className={`terminal-transcript-panel${fullTab ? " terminal-transcript-panel--tab" : ""}`}
      tabIndex={fullTab ? -1 : undefined}
      style={fullTab ? { top: fullTab.top ?? 0 } : undefined}
      onPointerDown={fullTab ? () => {
        if (useUiStore.getState().activePaneId !== sessionId) focusController.request("pointer", { sessionId, focus: false });
      } : undefined}
      onKeyDown={fullTab ? event => {
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        const actions = useKeybindingStore.getState().getActionsForEvent(event.nativeEvent);
        if (actions.includes("terminal.search")) {
          event.preventDefault(); event.stopPropagation(); openTabSearch(); return;
        }
        const target = event.target as Element;
        const editing = Boolean(target.closest("input,textarea,select,[contenteditable=true],[data-transcript-search]"));
        if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "c") {
          if (!window.getSelection()?.toString() && !editing) event.preventDefault();
          event.stopPropagation(); return;
        }
        if (actions.length) return;
        if (!editing && event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.metaKey) {
          event.preventDefault(); event.stopPropagation(); fullTab.onEscape(); return;
        }
        if (!editing && !event.ctrlKey && !event.altKey && !event.metaKey && event.key.length === 1
          && !target.closest("button,a,[role=menu]")) {
          const input = fullTab.inputRef.current;
          if (!input || input.disabled) return;
          event.preventDefault(); event.stopPropagation(); input.focus();
          const draft = useComposerStore.getState().draftBySession[sessionId] ?? "";
          const start = input.selectionStart ?? draft.length, end = input.selectionEnd ?? start;
          useComposerStore.getState().setDraft(sessionId, draft.slice(0, start) + event.key + draft.slice(end));
          queueMicrotask(() => { if (input.isConnected) input.setSelectionRange(start + event.key.length, start + event.key.length); });
        }
      } : undefined} data-terminal-transcript-panel="true" data-terminal-transcript-session={sessionId}
      onFocusCapture={() => {
        setPanelFocused(true);
        if (fullTab && useUiStore.getState().activePaneId !== sessionId) focusController.request("programmatic", { sessionId, focus: false });
      }}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPanelFocused(false); }}>
      {fullTab ? <div className="terminal-transcript-panel__head" data-tab-search-open={tabSearchOpen}>
        <div className="agent-tab-view-switch">
          <button type="button" aria-pressed="true" aria-label={agentTabStrings.toConversation} onClick={() => fullTab.inputRef.current?.focus()}>
            <span className="agent-tab-view-full">{agentTabStrings.conversation}</span><span className="agent-tab-view-short">{agentTabStrings.conversationShort}</span>
          </button>
          <button type="button" aria-pressed="false" aria-label={agentTabStrings.toTerminal} onClick={onClose}>{agentTabStrings.terminalButton}</button>
        </div>
        <div ref={setNavigationTarget} className="agent-tab-navigation" hidden={tabSearchOpen} />
        {tabSearchOpen ? searchBar : null}
        {retained.current.enabled ? <button type="button" className="agent-tab-search-toggle" aria-label={tabSearchOpen ? agentTabStrings.closeSearch : agentTabStrings.search}
          aria-expanded={tabSearchOpen} onClick={() => {
            if (tabSearchOpen) { search.setQuery(""); fullTab.inputRef.current?.focus(); }
            setTabSearchOpen(open => !open);
          }}>{tabSearchOpen ? <X aria-hidden="true" /> : <Search aria-hidden="true" />}</button> : null}
      </div> : <div className="terminal-transcript-panel__head">
        <span className="terminal-transcript-panel__title">{terminalTurnStrings.conversationHistory}</span>
        <span style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-dim)" }}>
          {archiveEnabled ? "会話記録から過去を読む" : terminalTurnStrings.recentHistory}
        </span>
        {archiveEnabled && brief?.telemetryHealth === "ended" ? <span className="archive-state">終了した会話</span> : null}
        {brief?.pendingInputKind || brief?.pendingPrompt || attention?.kind === "input" || attention?.kind === "approval" ? <button type="button" className="terminal-transcript-panel__link" onClick={finish}>端末で回答</button> : null}
        {onOpenDashboard ? (
          <button type="button" className="terminal-transcript-panel__link" onClick={onOpenDashboard}>
            {terminalTurnStrings.openInDashboard}
          </button>
        ) : null}
        <button
          type="button"
          className="terminal-transcript-panel__close"
          aria-label={terminalTurnStrings.closePanel}
          title={terminalTurnStrings.closePanel}
          onClick={finish}
        >
          ×
        </button>
      </div>}
      {!fullTab ? searchBar : null}
      <div className="terminal-transcript-panel__body" onScrollCapture={fullTab && !archiveEnabled ? event => {
        const node = event.target as HTMLElement;
        if (node.getAttribute("role") !== "log") return;
        legacyBottom.current = node.scrollHeight - node.clientHeight - node.scrollTop <= 24;
        if (legacyBottom.current) setLegacyNewTail(false);
      } : undefined}>
        {/* Hidden behind the Dashboard, the pane must not claim a turn request
            the Dashboard's own transcript is there to answer. */}
        {fullTab && archiveEnabled ? <ArchiveTranscript compact tabPresentation navigationTarget={navigationTarget} navigationHidden={tabSearchOpen}
          descriptor={descriptor} prepared={reader ?? undefined} retainedState={retainedArchiveState}
          visible={visible && !dashboardOpen} tabId={dashboardOpen || !live ? null : tabId}
          context={fullTab.card ? { workspaceId: fullTab.card.workspaceId, paneId: fullTab.card.paneId, sessionId, canPreviewInternally: true } : null}
          onUserMessages={archiveEcho} transcriptSearch={transcriptSearch} onSearchNavigation={search.setNavigationState} /> : <ChatTranscript
          navigationTarget={fullTab ? navigationTarget : undefined}
          compact={fullTab ? true : undefined}
          events={events}
          sessionId={sessionId}
          tabId={dashboardOpen || fullTab && !live ? null : tabId}
          agentKind={agentKind as never}
          detailLoaded={detailLoaded}
          telemetryHealth={brief?.telemetryHealth}
          lastOutputAt={brief?.lastEventAt ?? null}
          archiveEnabled={archiveEnabled}
          archiveDescriptor={archiveEnabled ? descriptor : null}
          archiveReader={archiveEnabled ? reader ?? undefined : undefined}
          archiveRetainedState={retainedArchiveState}
          archiveVisible={visible && !dashboardOpen}
          onArchiveUserMessages={fullTab ? archiveEcho : undefined}
          linkContext={fullTab?.card ? { workspaceId: fullTab.card.workspaceId, paneId: fullTab.card.paneId, sessionId, canPreviewInternally: true } : undefined}
          transcriptSearch={transcriptSearch}
          onSearchNavigation={search.setNavigationState}
        />}
        {fullTab ? <Suspense fallback={null}><AgentTabOptimisticMessages sessionId={sessionId} events={events} archiveEnabled={archiveEnabled} /></Suspense> : null}
      </div>
      {fullTab && !archiveEnabled && legacyNewTail ? <button type="button" className="agent-tab-new-records" onClick={() => {
        const log = panelRef.current?.querySelector<HTMLElement>("[role=log]");
        if (log) { log.scrollTop = log.scrollHeight; log.dispatchEvent(new Event("scroll")); }
        legacyBottom.current = true; setLegacyNewTail(false);
      }}><ArrowDownToLine aria-hidden="true" />{agentTabStrings.newRecords}</button> : null}
      {fullTab ? <Suspense fallback={null}><AgentTabConversationControls sessionId={sessionId} tabId={tabId} agentKind={agentKind} live={live} brief={brief} events={events} attention={attention}
        card={fullTab.card} cards={fullTab.cards} inputRef={fullTab.inputRef} active={fullTab.active} onTerminal={onClose} /></Suspense> : null}
    </div>
  );
}
