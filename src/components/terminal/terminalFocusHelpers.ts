import type { Terminal } from "@xterm/xterm";
import { usePaneMetadataStore, useUiStore } from "../../stores/workspaceStore";
import { liveTerms, registerTerminalCacheEvictionCleanup, termCache } from "./terminalCache";

const TERMINAL_WHEEL_FOCUS_SUPPRESS_MS = 350;
const TERMINAL_FOCUS_RETRY_LIMIT = 8;
const TERMINAL_POINTER_FOCUS_ALLOW_MS = 1500;
const terminalPointerFocusAllowUntil = new Map<string, number>();

interface WheelFocusRestore {
  id: number;
  sessionId: string;
  previousSessionId: string;
  expiresAt: number;
  timerId: number | null;
  restored: boolean;
}

let wheelFocusRestore: WheelFocusRestore | null = null;
let wheelFocusRestoreSeq = 0;

const terminalHasLiveOutput = new Set<string>();

registerTerminalCacheEvictionCleanup((sessionId) => {
  terminalPointerFocusAllowUntil.delete(sessionId);
  terminalHasLiveOutput.delete(sessionId);
  if (
    wheelFocusRestore
    && (wheelFocusRestore.sessionId === sessionId || wheelFocusRestore.previousSessionId === sessionId)
  ) {
    clearWheelFocusRestore();
  }
});

export function markTerminalHasLiveOutput(sessionId: string): void {
  terminalHasLiveOutput.add(sessionId);
}

export function hasTerminalLiveOutput(sessionId: string): boolean {
  return terminalHasLiveOutput.has(sessionId);
}

export function allowInactiveTerminalPointerFocus(sessionId: string): void {
  if (!sessionId) return;
  terminalPointerFocusAllowUntil.set(sessionId, Date.now() + TERMINAL_POINTER_FOCUS_ALLOW_MS);
}

function shouldAllowInactiveTerminalPointerFocus(sessionId: string): boolean {
  const allowUntil = terminalPointerFocusAllowUntil.get(sessionId);
  if (!allowUntil) return false;
  if (allowUntil < Date.now()) {
    terminalPointerFocusAllowUntil.delete(sessionId);
    return false;
  }
  return true;
}

export function isPlainTerminalInputEvent(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  return e.key.length === 1 || TERMINAL_PLAIN_INPUT_KEYS.has(e.key);
}

export function focusTerminalSoon(currentTerm: Terminal, sessionId?: string): void {
  let attempts = 0;
  const focusTerminal = () => {
    attempts += 1;
    if (sessionId && useUiStore.getState().activePaneId !== sessionId) return;
    try {
      currentTerm.focus();
    } catch {
      return;
    }
    if (terminalContainsActiveElement(currentTerm) || attempts >= TERMINAL_FOCUS_RETRY_LIMIT) return;
    const retryMs = attempts < 3 ? 16 : 50;
    window.setTimeout(() => {
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(focusTerminal);
        return;
      }
      focusTerminal();
    }, retryMs);
  };

  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(focusTerminal);
    return;
  }

  setTimeout(focusTerminal, 0);
}

export function terminalContainsActiveElement(currentTerm: Terminal): boolean {
  const element = currentTerm.element;
  const activeElement = element?.ownerDocument.activeElement;
  return Boolean(element && activeElement && element.contains(activeElement));
}

export function focusTerminalIfNeeded(currentTerm: Terminal, sessionId?: string): void {
  if (!terminalContainsActiveElement(currentTerm)) {
    focusTerminalSoon(currentTerm, sessionId);
  }
}

export function isActiveTerminalInputTarget(sessionId: string): boolean {
  return useUiStore.getState().activePaneId === sessionId;
}

export function clearActiveTerminalNotification(sessionId: string): void {
  usePaneMetadataStore.getState().clearNotification(sessionId);
}

export function refocusActiveTerminalIfNeeded(): void {
  const activeSessionId = useUiStore.getState().activePaneId;
  if (!activeSessionId) return;
  const activeTerm = liveTerms.get(activeSessionId) ?? termCache.get(activeSessionId)?.term;
  if (activeTerm) {
    focusTerminalIfNeeded(activeTerm, activeSessionId);
  }
}

export function shouldAcceptTerminalInput(sessionId: string): boolean {
  if (isActiveTerminalInputTarget(sessionId)) return true;
  refocusActiveTerminalIfNeeded();
  return false;
}

function terminalFocusClockMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function clearWheelFocusRestore(id?: number): void {
  if (!wheelFocusRestore) return;
  if (id !== undefined && wheelFocusRestore.id !== id) return;
  if (wheelFocusRestore.timerId !== null && typeof window !== "undefined") {
    window.clearTimeout(wheelFocusRestore.timerId);
  }
  wheelFocusRestore = null;
}

function markWheelFocusRestore(sessionId: string, previousSessionId: string): void {
  clearWheelFocusRestore();
  const id = ++wheelFocusRestoreSeq;
  const expiresAt = terminalFocusClockMs() + TERMINAL_WHEEL_FOCUS_SUPPRESS_MS;
  const timerId =
    typeof window !== "undefined"
      ? window.setTimeout(() => clearWheelFocusRestore(id), TERMINAL_WHEEL_FOCUS_SUPPRESS_MS)
      : null;
  wheelFocusRestore = { id, sessionId, previousSessionId, expiresAt, timerId, restored: false };
}

function consumeWheelFocusRestore(sessionId: string): string | null {
  if (!wheelFocusRestore || wheelFocusRestore.sessionId !== sessionId) return null;
  if (terminalFocusClockMs() > wheelFocusRestore.expiresAt) {
    clearWheelFocusRestore();
    return null;
  }
  if (wheelFocusRestore.restored) return null;
  wheelFocusRestore.restored = true;
  const { previousSessionId } = wheelFocusRestore;
  return previousSessionId;
}

export function shouldSuppressWheelFocusInput(sessionId: string): boolean {
  if (!wheelFocusRestore) return false;
  if (terminalFocusClockMs() > wheelFocusRestore.expiresAt) {
    clearWheelFocusRestore();
    return false;
  }
  return wheelFocusRestore.sessionId === sessionId || wheelFocusRestore.previousSessionId === sessionId;
}

function restoreTerminalFocusAfterWheel(previousSessionId: string): void {
  const uiState = useUiStore.getState();
  if (uiState.activePaneId !== previousSessionId) {
    uiState.setActivePaneId(previousSessionId);
  }
  const previousTerm = liveTerms.get(previousSessionId) ?? termCache.get(previousSessionId)?.term;
  if (previousTerm) {
    focusTerminalIfNeeded(previousTerm, previousSessionId);
  }
}

export function registerTerminalFocusSync(currentTerm: Terminal, sessionId: string): () => void {
  const element = currentTerm.element;
  if (!element) return () => {};

  const syncFocusedTerminal = (): void => {
    const previousSessionId = consumeWheelFocusRestore(sessionId);
    if (previousSessionId) {
      restoreTerminalFocusAfterWheel(previousSessionId);
      return;
    }
    if (isActiveTerminalInputTarget(sessionId)) {
      clearActiveTerminalNotification(sessionId);
      return;
    }
    if (shouldAllowInactiveTerminalPointerFocus(sessionId)) {
      return;
    }
    refocusActiveTerminalIfNeeded();
  };

  element.addEventListener("focusin", syncFocusedTerminal);
  return () => element.removeEventListener("focusin", syncFocusedTerminal);
}

export function registerTerminalWheelFocusGuard(currentTerm: Terminal, sessionId: string): () => void {
  const element = currentTerm.element;
  if (!element) return () => {};

  const guardWheelFocus = (): void => {
    const activePaneId = useUiStore.getState().activePaneId;
    if (!activePaneId || activePaneId === sessionId) {
      clearWheelFocusRestore();
      return;
    }
    markWheelFocusRestore(sessionId, activePaneId);
  };

  const cancelWheelFocusGuard = (): void => clearWheelFocusRestore();

  element.addEventListener("wheel", guardWheelFocus, { capture: true, passive: true });
  element.addEventListener("pointerdown", cancelWheelFocusGuard, { capture: true });
  element.addEventListener("mousedown", cancelWheelFocusGuard, { capture: true });

  return () => {
    element.removeEventListener("wheel", guardWheelFocus, true);
    element.removeEventListener("pointerdown", cancelWheelFocusGuard, true);
    element.removeEventListener("mousedown", cancelWheelFocusGuard, true);
  };
}

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
