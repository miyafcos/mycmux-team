import type { LiveSessionBrief, SemanticEventEnvelope } from "../../lib/livebrief";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useSessionAttentionStore } from "../../stores/sessionAttentionStore";
import { DashboardTelemetryFallback } from "./DashboardSessionDetail";
import { ChatTranscript } from "./ChatTranscript";
import { displayStateColor, displayStateLabel, stallLabel, statePillStyle } from "./DashboardCardRow";
import { type DashboardCardModel, resolveDisplayState } from "./dashboardModel";
import { dashboardStrings } from "./dashboardStrings";
import { QuestionCard } from "./QuestionCard";
import { stateLabels } from "./stateLabels";

export function ChatColumn({
  card,
  events,
  now,
  active,
  dragging,
  dropPreview,
  motion,
  targetEventId,
  targetEventRequest,
  syntheticSource,
  onActivate,
  onClose,
  onFocusComposer,
  onJump,
  onReorderKeyDown,
}: {
  card: DashboardCardModel;
  events: readonly SemanticEventEnvelope[];
  now: number;
  active: boolean;
  dragging: boolean;
  dropPreview: boolean;
  motion: "enter" | "resize" | "exit" | "expand" | null;
  targetEventId: string | null;
  targetEventRequest: number;
  syntheticSource: { eventId: string; text: string; at: number } | null;
  onActivate: () => void;
  onClose: () => void;
  onFocusComposer: (brief: LiveSessionBrief | undefined) => void;
  onJump: () => void;
  onReorderKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}) {
  const displayState = resolveDisplayState(card);
  const eventOutputAt = events.reduce((latest, event) => (
    event.kind.type === "agentMessage" || event.kind.type === "toolEnd" || event.kind.type === "error"
      ? Math.max(latest, event.occurredAt)
      : latest
  ), 0);
  const lastOutputAt = card.metadata?.backendLastOutputAt ?? (eventOutputAt || null);
  const elapsedMinutes = card.noUpdateMinutes
    ?? (card.lastActivityAt ? Math.max(0, Math.floor((now - card.lastActivityAt) / 60_000)) : null);
  const elapsedText = elapsedMinutes === null
    ? ""
    : displayState === "noUpdate"
      ? dashboardStrings.noUpdateFor(elapsedMinutes)
      : dashboardStrings.elapsed(elapsedMinutes);

  return <article
    data-dashboard-chat-column={card.tab.id}
    data-dashboard-chat-column-motion={motion ?? "idle"}
    data-active={active ? "true" : "false"}
    data-dashboard-chat-drop-target="true"
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
      <strong>{card.label}</strong>
      <div className="cmux-dashboard-chat-header-meta">
        {card.neverStarted
          ? <span style={statePillStyle("var(--cmux-text-tertiary)")}>{dashboardStrings.stateNotStarted}</span>
          : <span title={stateLabels(displayState).tooltip} aria-label={stateLabels(displayState).tooltip} style={statePillStyle(displayStateColor(displayState))}>{displayStateLabel(displayState)}</span>}
        {card.telemetryHealth === "ended" ? <span style={statePillStyle("var(--cmux-text-tertiary)")}>{dashboardStrings.telemetryEnded}</span> : null}
        {elapsedText ? <span>{elapsedText}</span> : null}
        {card.stall ? <span className="cmux-dashboard-chat-header-stall">{stallLabel(card.stall.reason)}</span> : null}
      </div>
      <span>{dashboardStrings.breadcrumb(card.workspace.name, card.tabIndex + 1, card.paneIndex + 1)}</span>
      {card.attentionCategory === "done" && card.attention?.attentionId
        ? <button type="button" className="cmux-dashboard-chat-header-action" onClick={(event) => { event.stopPropagation(); useSessionAttentionStore.getState().markSeen(card.tab.id, card.attention?.attentionId ?? ""); }}>{dashboardStrings.markReadButton}</button>
        : null}
      <button type="button" className="cmux-dashboard-chat-header-action" title={dashboardStrings.jumpButtonTitle} onClick={(event) => { event.stopPropagation(); onJump(); }}>{dashboardStrings.jumpButtonTitle}</button>
      <button type="button" data-dashboard-chat-column-close={card.tab.id} className="cmux-dashboard-chat-column-close" aria-label={`${card.label} を閉じる`} onClick={(event) => { event.stopPropagation(); onClose(); }}>×</button>
    </header>
    <div className="cmux-dashboard-chat-column-body">
      {card.telemetryHealth !== "live" && card.telemetryHealth !== "ended" ? <DashboardTelemetryFallback card={card} now={now} /> : null}
      <ChatTranscript
        events={events}
        sessionId={card.tab.sessionId}
        displayState={displayState}
        agentKind={card.agentKind ?? "none"}
        lastOutputAt={lastOutputAt}
        targetEventId={active ? targetEventId : null}
        targetEventRequest={active ? targetEventRequest : 0}
        syntheticSource={active ? syntheticSource : null}
        linkContext={{
          workspaceId: card.workspaceId,
          paneId: card.paneId,
          sessionId: card.tab.sessionId,
          canPreviewInternally: card.tab.type === undefined || card.tab.type === "terminal",
        }}
      />
      {card.telemetryHealth !== "ended" ? <QuestionCard brief={card.brief} events={events} targetLabel={`${card.workspace.name} › ${card.label}`} onFocusComposer={onFocusComposer} /> : null}
    </div>
  </article>;
}
