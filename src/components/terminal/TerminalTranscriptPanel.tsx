import { useEffect } from "react";

import { ChatTranscript } from "../dashboard/ChatTranscript";
import { holdDetailSession, useLiveBriefStore } from "../../stores/liveBriefStore";
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
  const events = detailEvents ?? listEvents ?? [];
  const detailLoaded = useLiveBriefStore((state) => state.eventsFetchedAtBySession[sessionId] != null);
  const brief = useLiveBriefStore((state) => state.briefsBySession[sessionId]);

  // Hold this session's deep poll for as long as the reader is here, whether or
  // not the Dashboard is open. The hold also keeps the backend transcript sweep
  // subscribed: without it the panel would re-read a ring nobody refreshes and
  // the conversation would freeze at whatever the Dashboard last saw.
  useEffect(() => holdDetailSession(sessionId), [sessionId]);

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
          detailLoaded={detailLoaded}
          telemetryHealth={brief?.telemetryHealth}
          lastOutputAt={brief?.lastEventAt ?? null}
        />
      </div>
    </div>
  );
}
