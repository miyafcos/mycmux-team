import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { ChatTranscript } from "../dashboard/ChatTranscript";
import { holdDetailSession, useLiveBriefStore } from "../../stores/liveBriefStore";
import { useDashboardViewStore } from "../../stores/dashboardViewStore";
import { terminalTurnStrings } from "./terminalTurnStrings";
import { captureTemporaryFocusReturn } from "../../lib/focusController";
import { useArchiveDescriptor, useTranscriptHistory } from "../dashboard/useTranscriptHistory";
import { descriptorKey, type TranscriptHistoryReader } from "../../stores/transcriptHistoryStore";
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
}: TerminalTranscriptPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Opening/focusing history owns this interaction without activating its PTY.
  const [panelFocused, setPanelFocused] = useState(true);
  const focusReturnRef = useRef<ReturnType<typeof captureTemporaryFocusReturn> | null>(null);
  useEffect(() => {
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
  const lastFocusRequest = useRef(focusRequest);
  useLayoutEffect(() => {
    if (lastFocusRequest.current === focusRequest) return;
    lastFocusRequest.current = focusRequest;
    if (visible && !dashboardOpen) panelRef.current?.querySelector<HTMLInputElement>("[data-transcript-search-input]")?.focus();
  }, [focusRequest, visible, dashboardOpen]);
  const events = detailEvents ?? listEvents ?? [];
  const detailLoaded = useLiveBriefStore((state) => state.eventsFetchedAtBySession[sessionId] != null);
  const brief = useLiveBriefStore((state) => state.briefsBySession[sessionId]);
  const mode = useSettingsStore((s) => s.conversationHistoryMode);
  const mappedDescriptor = useArchiveDescriptor(sessionId, tabId);
  // The hook can still contain a previous binding during a props transition.
  const descriptor = mappedDescriptor?.ptySessionId === sessionId && mappedDescriptor.tabId === tabId ? mappedDescriptor : null;
  const [search] = useState(() => new TranscriptSearch());
  const searchState = useSyncExternalStore(search.subscribe, search.getSnapshot, search.getSnapshot);
  const retained = useRef({ sessionId, tabId, enabled: false, archiveStarted: false });
  if (retained.current.sessionId !== sessionId || retained.current.tabId !== tabId) retained.current = { sessionId, tabId, enabled: false, archiveStarted: false };
  if (archiveReader || agentKind === "claude" || agentKind === "claude-codex" || agentKind === "codex" || descriptor) retained.current.enabled = true;
  const ordinaryArchive = mode !== "legacy" && retained.current.enabled;
  const archiveEnabled = ordinaryArchive || !!searchState.normalizedQuery;
  // Legacy clear pauses display; null would freeze a still-valid binding.
  if (archiveEnabled) retained.current.archiveStarted = true;
  const reader = useTranscriptHistory(retained.current.archiveStarted ? descriptor : null, retained.current.archiveStarted ? archiveReader : undefined);
  const readerState = useSyncExternalStore(reader?.subscribe ?? noSubscription, reader?.getSnapshot ?? noSnapshot, reader?.getSnapshot ?? noSnapshot);
  const exactDescriptor = descriptor && (!readerState || readerState.status !== "closed" && !["bindingChanged", "sourceChanged", "identityMismatch"].includes(readerState.error ?? "") && descriptorKey(readerState.descriptor) === descriptorKey(descriptor)) ? descriptor : null;
  const [documentVisible, setDocumentVisible] = useState(!document.hidden);
  useEffect(() => {
    const changed = () => setDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  const searchActive = visible && !dashboardOpen && documentVisible && panelFocused;
  useEffect(() => { reader?.setVisible(archiveEnabled && visible && !dashboardOpen && documentVisible); }, [reader, archiveEnabled, visible, dashboardOpen, documentVisible]);
  useLayoutEffect(() => { search.setContext(exactDescriptor, searchActive); }, [search, exactDescriptor, searchActive]);
  useEffect(() => () => search.dispose(), [search]);
  const attention = useSessionAttentionStore((s) => s.attentionBySession[sessionId]);

  // Hold this session's deep poll for as long as the reader is here, whether or
  // not the Dashboard is open. The hold also keeps the backend transcript sweep
  // subscribed: without it the panel would re-read a ring nobody refreshes and
  // the conversation would freeze at whatever the Dashboard last saw.
  useEffect(() => archiveEnabled ? undefined : holdDetailSession(sessionId), [sessionId, archiveEnabled]);
  useEffect(() => archiveEnabled ? connectLiveBriefStore() : undefined, [archiveEnabled]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !event.isComposing && !(event.target as Element)?.closest?.("[data-transcript-search]") && panelRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        event.stopPropagation();
        finish();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div ref={panelRef} className="terminal-transcript-panel" data-terminal-transcript-panel="true" data-terminal-transcript-session={sessionId}
      onFocusCapture={() => setPanelFocused(true)}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPanelFocused(false); }}>
      <div className="terminal-transcript-panel__head">
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
      </div>
      <TranscriptHistorySearchBar search={search} onClose={finish} visible={visible && !dashboardOpen} newTail={!!readerState?.newTail || !!readerState?.pages.some(page => searchState.snapshotEnd && BigInt(page.snapshotEnd) > BigInt(searchState.snapshotEnd))} />
      <div className="terminal-transcript-panel__body">
        {/* Hidden behind the Dashboard, the pane must not claim a turn request
            the Dashboard's own transcript is there to answer. */}
        <ChatTranscript
          events={events}
          sessionId={sessionId}
          tabId={dashboardOpen ? null : tabId}
          agentKind={agentKind as never}
          detailLoaded={detailLoaded}
          telemetryHealth={brief?.telemetryHealth}
          lastOutputAt={brief?.lastEventAt ?? null}
          archiveEnabled={archiveEnabled}
          archiveDescriptor={archiveEnabled ? descriptor : null}
          archiveReader={archiveEnabled ? reader ?? undefined : undefined}
          archiveVisible={visible && !dashboardOpen}
          transcriptSearch={searchActive && exactDescriptor && searchState.identity === descriptorKey(exactDescriptor) ? {
            query: searchState.normalizedQuery,
            targetId: searchState.matches[searchState.selected] ?? null,
            generation: searchState.generation,
            navigation: searchState.navigation,
            identity: searchState.identity,
            snapshotEnd: searchState.snapshotEnd,
            sourceGeneration: searchState.sourceGeneration,
          } : undefined}
          onSearchNavigation={search.setNavigationState}
        />
      </div>
    </div>
  );
}
