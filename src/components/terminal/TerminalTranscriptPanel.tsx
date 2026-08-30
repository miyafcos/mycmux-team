import { useEffect } from "react";

import { ChatTranscript } from "../dashboard/ChatTranscript";
import { stopEventPolling, syncDashboardEvents, useLiveBriefStore } from "../../stores/liveBriefStore";
import { useDashboardViewStore } from "../../stores/dashboardViewStore";
import { terminalTurnStrings } from "./terminalTurnStrings";

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
}

export function TerminalTranscriptPanel({
  sessionId,
  tabId,
  agentKind = "none",
  onClose,
  onOpenDashboard,
}: TerminalTranscriptPanelProps) {
  const detailEvents = useLiveBriefStore((state) => state.eventsBySession[sessionId]);
  const listEvents = useLiveBriefStore((state) => state.listEventsBySession[sessionId]);
  const dashboardOpen = useDashboardViewStore((state) => state.open);
  const events = detailEvents?.length ? detailEvents : listEvents ?? [];

  // The Dashboard owns the detail poll while it is open; borrow it only while
  // the reader is here, and hand it back on the way out.
  useEffect(() => {
    if (dashboardOpen) return;
    syncDashboardEvents({ selectedId: sessionId, visibleIds: [sessionId] });
    return () => stopEventPolling();
  }, [dashboardOpen, sessionId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="terminal-transcript-panel" data-terminal-transcript-panel="true">
      <div className="terminal-transcript-panel__head">
        <span className="terminal-transcript-panel__title">{terminalTurnStrings.conversationHistory}</span>
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
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="terminal-transcript-panel__body">
        {/* Hidden behind the Dashboard, the pane must not claim a turn request
            the Dashboard's own transcript is there to answer. */}
        <ChatTranscript
          events={events}
          sessionId={sessionId}
          tabId={dashboardOpen ? null : tabId}
          agentKind={agentKind as never}
          detailLoaded={Boolean(detailEvents?.length)}
        />
      </div>
    </div>
  );
}
