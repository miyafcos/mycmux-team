import { useEffect, useLayoutEffect } from "react";
import { useDashboardViewStore } from "../../stores/dashboardViewStore";
import { useUiStore } from "../../stores/uiStore";

export interface TerminalHistoryRequest {
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly historyOnly?: true;
  readonly selectionRevision: number;
  readonly ownerSessionId: string | null;
  readonly focusOwner: Element | null;
}

// One operation spans the toolbar check and the panel's revalidation.
const requests = new Map<string, AbortController>();
const owners = new Map<string, Set<symbol>>();

export function cancelTerminalHistoryRequest(sessionId: string): void {
  requests.get(sessionId)?.abort();
  requests.delete(sessionId);
}

export function beginTerminalHistoryRequest(sessionId: string, historyOnly = false): TerminalHistoryRequest {
  cancelTerminalHistoryRequest(sessionId);
  const controller = new AbortController();
  const { focusRevision: selectionRevision, activePaneId: ownerSessionId } = useUiStore.getState();
  const focusOwner = document.activeElement;
  // A later focus decision consumes this opening intent even if focus returns.
  // Removing a clicked popup can leave body focused without a new decision.
  const focusChanged = (event: Event): void => {
    if (event.target !== focusOwner && !(event.target === document.body && !focusOwner?.isConnected)) controller.abort();
  };
  document.addEventListener("focusin", focusChanged, true);
  controller.signal.addEventListener("abort", () => document.removeEventListener("focusin", focusChanged, true), { once: true });
  requests.set(sessionId, controller);
  return { sessionId, signal: controller.signal, selectionRevision, ownerSessionId, focusOwner,
    ...(historyOnly ? { historyOnly: true as const } : {}) };
}

export function isTerminalHistoryRequestCurrent(request: TerminalHistoryRequest): boolean {
  const state = useUiStore.getState();
  return !request.signal.aborted && requests.get(request.sessionId)?.signal === request.signal
    && state.focusRevision === request.selectionRevision && state.activePaneId === request.ownerSessionId
    && (document.activeElement === request.focusOwner || !request.focusOwner?.isConnected && document.activeElement === document.body)
    && !document.hidden && !useDashboardViewStore.getState().open;
}

/** Visible entries and the terminal share request lifetime; hiding still invalidates work. */
export function useTerminalHistoryRequestCancellation(sessionId: string | null, visible: boolean): void {
  useLayoutEffect(() => {
    if (!sessionId) return;
    const owner = Symbol();
    const sessionOwners = owners.get(sessionId) ?? new Set<symbol>();
    sessionOwners.add(owner);
    owners.set(sessionId, sessionOwners);
    if (!visible) cancelTerminalHistoryRequest(sessionId);
    return () => {
      sessionOwners.delete(owner);
      if (sessionOwners.size === 0) {
        owners.delete(sessionId);
        cancelTerminalHistoryRequest(sessionId);
      }
    };
  }, [sessionId, visible]);
  useEffect(() => {
    if (!sessionId) return;
    const cancelIfHidden = (): void => {
      if (document.hidden || useDashboardViewStore.getState().open) cancelTerminalHistoryRequest(sessionId);
    };
    cancelIfHidden();
    document.addEventListener("visibilitychange", cancelIfHidden);
    const unsubscribe = useDashboardViewStore.subscribe(cancelIfHidden);
    return () => {
      document.removeEventListener("visibilitychange", cancelIfHidden);
      unsubscribe();
    };
  }, [sessionId]);
}
