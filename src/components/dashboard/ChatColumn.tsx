import { getAgentDormancyRecord, type PreviewArtifactInfo } from "../../lib/ipc";
import { PEER_WEB_TRANSCRIPT_UNAVAILABLE } from "../../stores/webPaneTranscriptStore";
import { dormantAgentDescription, resolveDormantResumeIdentity } from "../../lib/agentDormancy";
import type { LiveSessionBrief, SemanticEventEnvelope } from "../../lib/livebrief";
import { useCallback, useEffect, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { WebPaneTranscriptEntry } from "../../stores/webPaneTranscriptStore";
import { useSessionAttentionStore } from "../../stores/sessionAttentionStore";
import { useComposerStore, type DashboardOptimisticMessage } from "../../stores/composerStore";
import { DashboardTelemetryFallback } from "./DashboardSessionDetail";
import { ChatTranscript } from "./ChatTranscript";
import { displayStateColor, displayStateLabel, stallLabel, statePillStyle } from "./DashboardCardRow";
import { type DashboardCardModel, resolveDisplayState } from "./dashboardModel";
import { dashboardStrings } from "./dashboardStrings";
import { dashboardActivity } from "./dashboardActivity";
import { instrumentLineFromTelemetry } from "./instrumentLine";
import { QuestionCard } from "./QuestionCard";
import { stateLabels } from "./stateLabels";
import { useArchiveDescriptor } from "./useTranscriptHistory";
import { useSettingsStore } from "../../stores/settingsStore";
import { Check, ExternalLink, MoreHorizontal, Pin, PinOff, RotateCcw, X } from "lucide-react";

const EMPTY_OPTIMISTIC_MESSAGES: readonly DashboardOptimisticMessage[] = [];
const EMPTY_EVENTS: readonly SemanticEventEnvelope[] = [];

function chatStatePillStyle(color: string): CSSProperties {
  return {
    ...statePillStyle(color),
    fontSize: "var(--cmux-chat-meta-size)",
    borderRadius: "var(--cmux-chat-radius-inline)",
    padding: "0 var(--cmux-chat-space-3)",
  };
}

function useReducedMotion(): boolean {
  const getPreference = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  const [reducedMotion, setReducedMotion] = useState(getPreference);

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

export function ChatColumn({
  card,
  events,
  now,
  active,
  columnColor,
  pinned,
  dragging,
  dropPreview,
  motion,
  targetEventId,
  targetEventRequest,
  syntheticSource,
  onActivate,
  onTogglePin,
  onClose,
  onFocusComposer,
  onJump,
  onReorderKeyDown,
  onPreviewArtifact,
  webTranscript = null,
  onRefreshWebTranscript,
  detailLoaded = false,
}: {
  card: DashboardCardModel;
  events: readonly SemanticEventEnvelope[];
  now: number;
  active: boolean;
  columnColor?: string;
  pinned: boolean;
  dragging: boolean;
  dropPreview: boolean;
  motion: "enter" | "resize" | "exit" | "expand" | null;
  targetEventId: string | null;
  targetEventRequest: number;
  syntheticSource: { eventId: string; text: string; at: number } | null;
  onActivate: () => void;
  onTogglePin: () => void;
  onClose: () => void;
  onFocusComposer: (brief: LiveSessionBrief | undefined) => void;
  onJump: () => void;
  onReorderKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  onPreviewArtifact?: (info: PreviewArtifactInfo) => void;
  /** Set for a Web tab: what its pane was showing at the last read. */
  webTranscript?: WebPaneTranscriptEntry | null;
  onRefreshWebTranscript?: () => void;
  detailLoaded?: boolean;
}) {
  const sessionId = card.tab.sessionId;
  const [navigationTarget, setNavigationTarget] = useState<HTMLDivElement | null>(null);
  const dormantDescription = card.neverStarted || card.telemetryHealth === "live" ? undefined : dormantAgentDescription(card.mark);
  const savedRecord = useSessionAttentionStore((state) => state.dormantCompletionsBySession[sessionId]?.receipt);
  const resumeIdentity = resolveDormantResumeIdentity(card.tab);
  const recordKey = dormantDescription && savedRecord && resumeIdentity?.agentKind === savedRecord.agentKind
    && resumeIdentity.resumeSessionId === savedRecord.agentSessionId ? `${sessionId}:${savedRecord.agentSessionId}:${savedRecord.savedAt}` : null;
  const [record, setRecord] = useState<{ key: string; events: readonly SemanticEventEnvelope[]; error?: string } | null>(null);
  useEffect(() => {
    if (!recordKey || !savedRecord) return;
    let cancelled = false;
    void getAgentDormancyRecord(savedRecord).then((result) => {
      if (!cancelled) setRecord({ key: recordKey, events: result.events });
    }).catch((error) => {
      if (!cancelled) setRecord({ key: recordKey, events: EMPTY_EVENTS, error: `保存した会話を開けませんでした: ${String(error)}` });
    });
    return () => { cancelled = true; };
  }, [recordKey, savedRecord, sessionId]);
  const recordLoaded = recordKey !== null && record?.key === recordKey;
  const historyMode = useSettingsStore((s) => s.conversationHistoryMode);
  const archiveEligible = historyMode !== "legacy" && !webTranscript && !recordKey && !card.neverStarted && (card.agentKind === "claude" || card.agentKind === "claude-codex" || card.agentKind === "codex");
  const archiveDescriptor = useArchiveDescriptor(sessionId, card.tab.id, archiveEligible);
  const transcriptEvents = recordKey ? recordLoaded ? record.events : EMPTY_EVENTS : events;
  const optimisticMessages = useComposerStore((state) => state.dashboardOptimisticMessagesBySession[sessionId] ?? EMPTY_OPTIMISTIC_MESSAGES);
  const collapseOptimisticMessages = useComposerStore((state) => state.collapseDashboardOptimisticMessages);
  const requestOptimisticRetry = useComposerStore((state) => state.requestDashboardOptimisticRetry);
  const reducedMotion = useReducedMotion();
  const displayState = resolveDisplayState(card);
  const eventOutputAt = transcriptEvents.reduce((latest, event) => (
    event.kind.type === "agentMessage" || event.kind.type === "toolEnd" || event.kind.type === "error"
      ? Math.max(latest, event.occurredAt)
      : latest
  ), 0);
  const lastOutputAt = card.volatileMetadata?.backendLastOutputAt ?? (eventOutputAt || null);
  const elapsedMinutes = card.noUpdateMinutes
    ?? (card.lastActivityAt ? Math.max(0, Math.floor((now - card.lastActivityAt) / 60_000)) : null);
  const elapsedText = elapsedMinutes === null
    ? ""
    : displayState === "noUpdate"
      ? dashboardStrings.noUpdateFor(elapsedMinutes)
      : card.telemetryHealth === "live" ? dashboardStrings.lastActivityAgo(elapsedMinutes) : dashboardStrings.elapsed(elapsedMinutes);
  const instrument = instrumentLineFromTelemetry(
    card.telemetry,
    card.metadata?.agentSessionId ?? card.brief?.agentSessionId ?? card.tab.agentSessionId,
  );

  const archiveEcho = useCallback((messages:readonly {text:string;occurredAt:number}[])=>collapseOptimisticMessages(sessionId,messages),[collapseOptimisticMessages,sessionId]);
  useEffect(() => {
    if(archiveEligible) return;
    const transcriptMessages = transcriptEvents.flatMap((event) => (
      event.kind.type === "userMessage" ? [{ text: event.kind.text, occurredAt: event.occurredAt }] : []
    ));
    if (transcriptMessages.length) collapseOptimisticMessages(sessionId, transcriptMessages);
  }, [collapseOptimisticMessages, transcriptEvents, sessionId, archiveEligible]);

  return <article
    data-dashboard-chat-column={card.tab.id}
    data-dashboard-chat-column-motion={motion ?? "idle"}
    data-active={active ? "true" : "false"}
    data-dashboard-chat-drop-target="true"
    style={columnColor ? { "--cmux-chat-column-color": columnColor } as CSSProperties : undefined}
    className={`cmux-dashboard-chat-column${active ? " is-active" : ""}${dragging ? " is-drag-source" : ""}${dropPreview ? " is-drop-existing" : ""}${motion ? ` is-${motion}` : ""}`}
    onPointerDown={onActivate}
  >
    <header
      className="cmux-dashboard-chat-header"
      data-dashboard-column-drag-handle="true"
      tabIndex={0}
      role="group"
      aria-label={`${card.label} のチャット列。Alt+左矢印またはAlt+右矢印で並べ替え`}
      onClick={onActivate}
      onKeyDown={onReorderKeyDown}
    >
      <div className="cmux-dashboard-chat-header-lane"><div className="cmux-dashboard-chat-header-content">
      <div className="cmux-dashboard-chat-identity">
        <span className="cmux-dashboard-chat-color" aria-hidden="true" />
        <strong title={card.label}>{card.label}</strong>
        {card.windowLabel && card.windowLabel !== "main" ? <span className="cmux-dashboard-peer-window">{dashboardStrings.peerWindow}</span> : null}
        <div className="cmux-dashboard-chat-header-meta">
          {card.neverStarted
            ? <span style={chatStatePillStyle("var(--cmux-text-tertiary)")}>{dashboardStrings.stateNotStarted}</span>
            : <span title={stateLabels(displayState).tooltip} aria-label={stateLabels(displayState).tooltip} style={chatStatePillStyle(displayStateColor(displayState))}>{displayStateLabel(displayState)}</span>}
          {card.manualDoneAt !== undefined ? <span data-dashboard-manual-done={card.tab.id} style={chatStatePillStyle("var(--cmux-text-tertiary)")}>{dashboardStrings.manualDoneBadge}</span> : null}
          {card.stall && (card.telemetryHealth !== "live" || card.stall.reason !== "no_output") ? <span className="cmux-dashboard-chat-header-stall">{stallLabel(card.stall.reason)}</span> : null}
        </div>
      </div>
      <div className="cmux-dashboard-chat-actions">
        <div className="cmux-dashboard-chat-navigation" ref={setNavigationTarget} />
        <details className="cmux-dashboard-chat-details" onClick={(event) => event.stopPropagation()}>
          <summary aria-label="会話の詳細" title="会話の詳細"><MoreHorizontal size={16} aria-hidden="true" /></summary>
          <div className="cmux-dashboard-chat-detail-content">
            <span data-dashboard-breadcrumb>{dashboardStrings.breadcrumb(card.workspace.name, card.paneIndex + 1, card.tabIndex + 1)}</span>
            {dashboardActivity(card) && dashboardActivity(card) !== displayStateLabel(displayState) ? <span>{dashboardActivity(card)}</span> : null}
            {elapsedText ? <span>{elapsedText}</span> : null}
            {card.telemetryHealth === "ended" ? <span>{dashboardStrings.telemetryEnded}</span> : null}
            {instrument ? <span className="cmux-dashboard-chat-header-instrument" data-dashboard-instrument={card.tab.id} title={instrument}>{instrument}</span> : null}
            <button type="button" data-dashboard-manual-done-toggle={card.tab.id} className="cmux-dashboard-chat-header-action" aria-label={card.manualDoneAt === undefined ? dashboardStrings.markDoneButton : dashboardStrings.unmarkDoneButton} title={card.manualDoneAt === undefined ? dashboardStrings.markDoneTitle : dashboardStrings.unmarkDoneTitle} onClick={() => {
              const store = useSessionAttentionStore.getState();
              if (card.manualDoneAt !== undefined) store.clearDoneMark(card.tab.id);
              else {
                store.markDone(card.tab.id, Date.now());
                if (card.attention?.attentionId) store.markSeen(card.tab.id, card.attention.attentionId);
              }
            }}><Check size={15} aria-hidden="true" />{card.manualDoneAt === undefined ? dashboardStrings.markDoneButton : dashboardStrings.unmarkDoneButton}</button>
          </div>
        </details>
        <button type="button" className="cmux-dashboard-chat-header-action" aria-label={dormantDescription ? "会話を再開" : dashboardStrings.jumpButtonTitle} title={dormantDescription ?? dashboardStrings.jumpButtonTitle} onClick={(event) => { event.stopPropagation(); onJump(); }}>{dormantDescription ? <RotateCcw size={15} aria-hidden="true" /> : <ExternalLink size={15} aria-hidden="true" />}</button>
        <button type="button" data-dashboard-chat-column-pin={card.tab.id} className="cmux-dashboard-chat-header-action" aria-pressed={pinned} aria-label={pinned ? dashboardStrings.chatColumnUnpinAriaLabel : dashboardStrings.chatColumnPinAriaLabel} title={pinned ? dashboardStrings.chatColumnUnpinAriaLabel : dashboardStrings.chatColumnPinAriaLabel} onClick={(event) => { event.stopPropagation(); onTogglePin(); }}>{pinned ? <PinOff size={15} aria-hidden="true" /> : <Pin size={15} aria-hidden="true" />}</button>
        <button type="button" data-dashboard-chat-column-close={card.tab.id} className="cmux-dashboard-chat-column-close" aria-label={`${card.label} を閉じる`} title="閉じる" onClick={(event) => { event.stopPropagation(); onClose(); }}><X size={16} aria-hidden="true" /></button>
      </div>
      </div></div>
    </header>
    <div className="cmux-dashboard-chat-column-body">
      {dormantDescription ? <p>{dormantDescription}</p> : null}
      {recordKey && !recordLoaded ? <p role="status">保存した会話を読み込んでいます</p> : null}
      {recordLoaded && record.error ? <p role="alert">{record.error}</p> : null}
      {card.tab.type === "web" && card.windowLabel
        ? <p>{PEER_WEB_TRANSCRIPT_UNAVAILABLE}</p>
        : webTranscript
        ? <WebTranscriptStatus entry={webTranscript} onRefresh={onRefreshWebTranscript} />
        : !recordKey && card.telemetryHealth !== "live" && card.telemetryHealth !== "ended"
          ? <DashboardTelemetryFallback card={card} now={now} />
          : null}
      <ChatTranscript
        compact
        navigationTarget={navigationTarget}
        events={transcriptEvents}
        sessionId={card.tab.sessionId}
        tabId={card.tab.id}
        displayState={displayState}
        agentKind={card.agentKind ?? "none"}
        lastOutputAt={lastOutputAt}
        telemetryHealth={recordKey ? "ended" : card.telemetryHealth}
        targetEventId={active ? targetEventId : null}
        targetEventRequest={active ? targetEventRequest : 0}
        syntheticSource={active ? syntheticSource : null}
        detailLoaded={recordKey ? recordLoaded : detailLoaded}
        linkContext={{
          workspaceId: card.workspaceId,
          paneId: card.paneId,
          sessionId: card.tab.sessionId,
          canPreviewInternally: card.tab.type === undefined || card.tab.type === "terminal",
          openInDashboardPreview: onPreviewArtifact,
        }}
        archiveEnabled={archiveEligible}
        archiveDescriptor={archiveDescriptor}
        onArchiveUserMessages={archiveEcho}
      />
      {optimisticMessages.length ? <div className="cmux-dashboard-optimistic-messages" aria-live="polite">
        {optimisticMessages.map((message) => <div
          key={message.id}
          data-dashboard-optimistic-message={message.id}
          data-delivery-state={message.state}
          data-optimistic-motion={reducedMotion ? undefined : "true"}
          className={`cmux-dashboard-msg is-user is-optimistic is-${message.state}${reducedMotion ? "" : " is-optimistic-motion"}`}
        >
          <div className="cmux-dashboard-msg-who"><span>{message.state === "sending" ? dashboardStrings.composerMessageSending : message.state === "sent" ? message.error ? dashboardStrings.dispatchUnconfirmed : dashboardStrings.composerMessageSent : dashboardStrings.composerMessageFailed}</span></div>
          <div className="cmux-dashboard-msg-plain">{message.text}</div>
          {message.state === "failed" ? <div className="cmux-dashboard-optimistic-retry"><span>{message.error ?? dashboardStrings.composerMessageFailed}</span><button type="button" onClick={() => requestOptimisticRetry(sessionId, message.id)}>{dashboardStrings.composerRetry}</button></div> : null}
        </div>)}
      </div> : null}
      {!webTranscript && !recordKey && card.telemetryHealth !== "ended" ? <QuestionCard
        brief={card.brief}
        events={events}
        targetLabel={`${card.workspace.name} › ${card.label}`}
        onFocusComposer={onFocusComposer}
        sessionId={card.tab.sessionId}
        attention={card.attention}
      /> : null}
    </div>
  </article>;
}

/**
 * What a Web column can say about its own freshness.
 *
 * The turns come from reading the page, not from a session log, so the column
 * states when it read and lets the reader force another one. Without this the
 * bubbles' clock times (all stamped at the first read) would be the only hint,
 * and they would read as message times.
 */
function WebTranscriptStatus({ entry, onRefresh }: {
  entry: WebPaneTranscriptEntry;
  onRefresh?: () => void;
}) {
  const clock = entry.fetchedAt
    ? new Date(entry.fetchedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })
    : null;
  const notes = [
    entry.signedOut ? dashboardStrings.webTranscriptSignedOut : null,
    entry.generating ? dashboardStrings.webTranscriptGenerating : null,
    entry.truncated ? dashboardStrings.webTranscriptTruncated : null,
  ].filter((note) => note !== null);
  return <div className="cmux-dashboard-web-transcript-status" data-dashboard-web-transcript-status="true">
    <span className="cmux-dashboard-web-transcript-source">{dashboardStrings.webTranscriptSource}</span>
    <span className="cmux-dashboard-web-transcript-when">
      {clock ? dashboardStrings.webTranscriptFetchedAt(clock) : dashboardStrings.webTranscriptLoading}
    </span>
    {notes.map((note) => <span key={note} className="cmux-dashboard-web-transcript-note">{note}</span>)}
    {entry.error ? <span className="cmux-dashboard-web-transcript-error" role="alert">{entry.error}</span> : null}
    {onRefresh ? <button
      type="button"
      className="cmux-dashboard-chat-header-action"
      data-dashboard-web-transcript-refresh="true"
      disabled={entry.loading}
      onClick={(event) => { event.stopPropagation(); onRefresh(); }}
    >{dashboardStrings.webTranscriptRefresh}</button> : null}
  </div>;
}
