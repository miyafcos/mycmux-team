import type { Terminal } from "@xterm/xterm";
import { focusController } from "../../lib/focusController";
import { usePaneMetadataStore, useUiStore } from "../../stores/workspaceStore";
import { registerTerminalCacheEvictionCleanup } from "./terminalCache";

const TERMINAL_PLAIN_INPUT_KEYS = new Set([
  "Backspace",
  "Delete",
  "Enter",
  "Escape",
  "Tab",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Insert",
]);

registerTerminalCacheEvictionCleanup((sessionId) => {
  focusController.clearSession(sessionId);
});

export function markTerminalHasLiveOutput(sessionId: string): void {
  focusController.markTerminalHasLiveOutput(sessionId);
}

export function hasTerminalLiveOutput(sessionId: string): boolean {
  return focusController.hasTerminalLiveOutput(sessionId);
}

export function allowInactiveTerminalPointerFocus(sessionId: string): void {
  focusController.request("pointer", { sessionId, action: "pending", focus: false });
}

export function isPlainTerminalInputEvent(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  return e.key.length === 1 || TERMINAL_PLAIN_INPUT_KEYS.has(e.key);
}

export function terminalContainsActiveElement(currentTerm: Terminal): boolean {
  const element = currentTerm.element;
  const activeElement = element?.ownerDocument.activeElement;
  return Boolean(element && activeElement && element.contains(activeElement));
}

export function focusTerminalSoon(currentTerm: Terminal, sessionId?: string): void {
  if (sessionId) {
    focusController.focusSessionSoon(sessionId);
    return;
  }
  try {
    currentTerm.focus();
  } catch {
    // Terminal may have been disposed between copy completion and focus restore.
  }
}

export function focusTerminalIfNeeded(currentTerm: Terminal, sessionId?: string): void {
  if (terminalContainsActiveElement(currentTerm)) return;
  focusTerminalSoon(currentTerm, sessionId);
}

export function isActiveTerminalInputTarget(sessionId: string): boolean {
  return useUiStore.getState().activePaneId === sessionId;
}

export function clearActiveTerminalNotification(sessionId: string): void {
  usePaneMetadataStore.getState().clearNotification(sessionId);
}

export function refocusActiveTerminalIfNeeded(): void {
  focusController.focusSessionSoon(useUiStore.getState().activePaneId);
}

export function shouldAcceptTerminalInput(sessionId: string): boolean {
  return focusController.shouldAcceptTerminalInput(sessionId);
}

export function shouldSuppressWheelFocusInput(sessionId: string): boolean {
  return focusController.shouldSuppressWheelFocusInput(sessionId);
}

export function registerTerminalFocusSync(currentTerm: Terminal, sessionId: string): () => void {
  const element = currentTerm.element;
  if (!element) return () => {};

  const unregister = focusController.registerTerminal(sessionId, {
    focus: () => currentTerm.focus(),
    containsActiveElement: () => terminalContainsActiveElement(currentTerm),
    clearNotification: () => clearActiveTerminalNotification(sessionId),
  });
  const syncFocusedTerminal = (): void => {
    focusController.observeTerminalFocusIn(sessionId);
  };

  element.addEventListener("focusin", syncFocusedTerminal);
  return () => {
    element.removeEventListener("focusin", syncFocusedTerminal);
    unregister();
  };
}

export function registerTerminalWheelFocusGuard(currentTerm: Terminal, sessionId: string): () => void {
  const element = currentTerm.element;
  if (!element) return () => {};

  const guardWheelFocus = (): void => {
    const activePaneId = useUiStore.getState().activePaneId;
    focusController.request("wheel", { sessionId, previousSessionId: activePaneId, action: "observe" });
  };

  const cancelWheelFocusGuard = (): void => {
    focusController.request("wheel", { sessionId: null, action: "observe" });
  };

  element.addEventListener("wheel", guardWheelFocus, { capture: true, passive: true });
  element.addEventListener("pointerdown", cancelWheelFocusGuard, { capture: true });
  element.addEventListener("mousedown", cancelWheelFocusGuard, { capture: true });

  return () => {
    element.removeEventListener("wheel", guardWheelFocus, true);
    element.removeEventListener("pointerdown", cancelWheelFocusGuard, true);
    element.removeEventListener("mousedown", cancelWheelFocusGuard, true);
  };
}
