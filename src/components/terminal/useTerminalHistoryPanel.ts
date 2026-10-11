import { useCallback, useEffect, useRef, useState } from "react";
import { focusController } from "../../lib/focusController";
import { readAgentSessionMappings } from "../../lib/ipc";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";
import { useDashboardViewStore } from "../../stores/dashboardViewStore";
import { hasExactHistoryMapping, TERMINAL_HISTORY_EVENT, TERMINAL_HISTORY_FOCUS_EVENT } from "./TerminalHistoryEntry";
import { TERMINAL_SEARCH_EVENT } from "./terminalSearchEvents";
import { beginTerminalHistoryRequest, cancelTerminalHistoryRequest, isTerminalHistoryRequestCurrent, useTerminalHistoryRequestCancellation, type TerminalHistoryRequest } from "./terminalHistoryRequests";

/** Panel state is independent of the live terminal's attach effect and props. */
export function useTerminalHistoryPanel(sessionId: string, visible = true) {
  const [transcriptPanelOpen, setPanelOpen] = useState(false);
  const [transcriptPanelFocusRequest, setFocusRequest] = useState(0);
  const openRef = useRef(false);
  const returnFocus = useRef<{ sessionId: string | null; revision: number } | null>(null);
  const context = useRef({ sessionId, visible });
  context.current = { sessionId, visible };
  useTerminalHistoryRequestCancellation(sessionId, visible);
  const setTranscriptPanelOpen = useCallback((open: boolean) => {
    if (!open) cancelTerminalHistoryRequest(sessionId);
    if (open) {
      if (!openRef.current) {
        const state = useUiStore.getState();
        returnFocus.current = { sessionId: focusController.resolveEligibleTerminal(state.activePaneId, state.lastActivePaneId, sessionId), revision: state.focusRevision };
      }
      setFocusRequest(request => request + 1);
    }
    openRef.current = open;
    setPanelOpen(open);
  }, [sessionId]);
  const openAccepted = useCallback(() => { if (openRef.current) return false; setTranscriptPanelOpen(true); return true; }, [setTranscriptPanelOpen]);
  const closeTranscriptPanel = useCallback(() => {
    setTranscriptPanelOpen(false);
    const state = useUiStore.getState();
    const previous = returnFocus.current;
    const focusedPanel = document.activeElement?.closest("[data-terminal-transcript-session]");
    const target = focusController.resolveEligibleTerminal(state.activePaneId, previous?.sessionId, state.lastActivePaneId);
    if (target && previous?.revision === state.focusRevision
      && (document.activeElement === document.body || focusedPanel?.getAttribute("data-terminal-transcript-session") === sessionId)) {
      focusController.focusEligibleTerminal(target);
    }
    returnFocus.current = null;
  }, [sessionId, setTranscriptPanelOpen]);

  useEffect(() => {
    setTranscriptPanelOpen(false);
    returnFocus.current = null;
    let disposed = false;
    const focus = (event: Event): void => {
      if ((event as CustomEvent<{ sessionId?: string }>).detail?.sessionId !== sessionId || !openRef.current) return;
      event.preventDefault();
      if (disposed || context.current.sessionId !== sessionId || !context.current.visible
        || document.hidden || useDashboardViewStore.getState().open) return;
      setFocusRequest(request => request + 1);
    };
    // A retained reader may be deliberately refocused after another selection.
    // Like U6's synchronous temporary-return observer, start a new return guard
    // on that focus entry while keeping L29's eligible opening-terminal fallback.
    const refocus = (event: FocusEvent): void => {
      if (!openRef.current || disposed || !context.current.visible || document.hidden
        || useDashboardViewStore.getState().open || !(event.target instanceof Element)
        || event.target.closest("[data-terminal-transcript-session]")?.getAttribute("data-terminal-transcript-session") !== sessionId) return;
      if (returnFocus.current) returnFocus.current.revision = useUiStore.getState().focusRevision;
    };
    const open = (event: Event): void => {
      const detail = (event as CustomEvent<{ sessionId?: string; request?: TerminalHistoryRequest }>).detail;
      if (detail?.sessionId !== sessionId || !context.current.visible || !useSettingsStore.getState().showTerminalHistoryButton) return;
      const request = detail.request ?? beginTerminalHistoryRequest(sessionId);
      const current = (): boolean => !disposed && context.current.sessionId === sessionId
        && context.current.visible && request.sessionId === sessionId && isTerminalHistoryRequestCurrent(request);
      if (!current()) return;
      // Revalidate on the click: a previous toolbar poll can outlive an agent.
      void readAgentSessionMappings([sessionId]).then((mappings) => {
        if (!current()) return;
        if (!useSettingsStore.getState().showTerminalHistoryButton || !hasExactHistoryMapping(mappings?.[sessionId])) {
          if (!request.historyOnly) window.dispatchEvent(new CustomEvent(TERMINAL_SEARCH_EVENT, { detail: { sessionId } }));
          return;
        }
        setTranscriptPanelOpen(true);
      }).catch(() => {
        if (!current()) return;
        if (!request.historyOnly) window.dispatchEvent(new CustomEvent(TERMINAL_SEARCH_EVENT, { detail: { sessionId } }));
      });
    };
    document.addEventListener("focusin", refocus, true);
    window.addEventListener(TERMINAL_HISTORY_EVENT, open);
    window.addEventListener(TERMINAL_HISTORY_FOCUS_EVENT, focus);
    return () => {
      disposed = true;
      document.removeEventListener("focusin", refocus, true);
      window.removeEventListener(TERMINAL_HISTORY_EVENT, open);
      window.removeEventListener(TERMINAL_HISTORY_FOCUS_EVENT, focus);
    };
  }, [sessionId]);

  return { transcriptPanelOpen, transcriptPanelFocusRequest, setTranscriptPanelOpen, closeTranscriptPanel, openAccepted };
}
