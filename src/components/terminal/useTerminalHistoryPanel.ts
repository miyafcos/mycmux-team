import { useCallback, useEffect, useRef, useState } from "react";
import { focusController } from "../../lib/focusController";
import { readAgentSessionMappings } from "../../lib/ipc";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";
import { hasExactHistoryMapping, TERMINAL_HISTORY_EVENT } from "./TerminalHistoryEntry";

/** Panel state is independent of the live terminal's attach effect and props. */
export function useTerminalHistoryPanel(sessionId: string) {
  const [transcriptPanelOpen, setTranscriptPanelOpen] = useState(false);
  const returnFocus = useRef<string | null>(null);
  const closeTranscriptPanel = useCallback(() => {
    setTranscriptPanelOpen(false);
    if (returnFocus.current && useUiStore.getState().activePaneId === returnFocus.current) {
      focusController.request("programmatic", { sessionId: returnFocus.current });
    }
    returnFocus.current = null;
  }, []);

  useEffect(() => {
    setTranscriptPanelOpen(false);
    returnFocus.current = null;
    let disposed = false;
    const open = (event: Event): void => {
      const requested = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (requested !== sessionId || !useSettingsStore.getState().showTerminalHistoryButton) return;
      // Revalidate on the click: a previous toolbar poll can outlive an agent.
      void readAgentSessionMappings([sessionId]).then((mappings) => {
        if (disposed || !useSettingsStore.getState().showTerminalHistoryButton
          || !hasExactHistoryMapping(mappings?.[sessionId])) return;
        returnFocus.current = useUiStore.getState().activePaneId;
        setTranscriptPanelOpen(true);
      }).catch(() => {});
    };
    window.addEventListener(TERMINAL_HISTORY_EVENT, open);
    return () => { disposed = true; window.removeEventListener(TERMINAL_HISTORY_EVENT, open); };
  }, [sessionId]);

  return { transcriptPanelOpen, setTranscriptPanelOpen, closeTranscriptPanel };
}
