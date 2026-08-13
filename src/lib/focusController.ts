import { useUiStore } from "../stores/uiStore";

export type FocusSource =
  | "pointer"
  | "wheel"
  | "keyboard"
  | "tab-click"
  | "tab-rename"
  | "drag"
  | "programmatic";

export type FocusIntentAction =
  | "commit"
  | "pending"
  | "abort"
  | "observe"
  | "suppress-tab-click";

export interface FocusIntent {
  sessionId?: string | null;
  previousSessionId?: string | null;
  paneId?: string | null;
  action?: FocusIntentAction;
  focus?: boolean;
  suppressMs?: number;
  pointerId?: number;
}

type FocusTarget = {
  focus: () => void;
  containsActiveElement: () => boolean;
  clearNotification?: () => void;
};

export interface FocusControllerState {
  pendingPointer: { sessionId: string; expiresAt: number; pointerId?: number } | null;
  pendingWheel: { sessionId: string; previousSessionId: string; expiresAt: number; restored: boolean } | null;
  suppressTabClickUntil: number;
}

export interface FocusControllerCoreOptions {
  now?: () => number;
  pointerFocusAllowMs?: number;
  wheelFocusSuppressMs?: number;
  tabClickSuppressMs?: number;
  commit: (sessionId: string | null) => void;
  focusSession?: (sessionId: string | null | undefined, options?: { allowInactive?: boolean }) => void;
  getActiveSessionId?: () => string | null;
}

const DEFAULT_POINTER_FOCUS_ALLOW_MS = 1500;
const DEFAULT_WHEEL_FOCUS_SUPPRESS_MS = 350;
const DEFAULT_TAB_CLICK_SUPPRESS_MS = 250;
const TERMINAL_FOCUS_RETRY_LIMIT = 8;

export function createFocusControllerCore(options: FocusControllerCoreOptions) {
  const now = options.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const pointerFocusAllowMs = options.pointerFocusAllowMs ?? DEFAULT_POINTER_FOCUS_ALLOW_MS;
  const wheelFocusSuppressMs = options.wheelFocusSuppressMs ?? DEFAULT_WHEEL_FOCUS_SUPPRESS_MS;
  const tabClickSuppressMs = options.tabClickSuppressMs ?? DEFAULT_TAB_CLICK_SUPPRESS_MS;
  const state: FocusControllerState = {
    pendingPointer: null,
    pendingWheel: null,
    suppressTabClickUntil: 0,
  };

  const clearExpired = (): void => {
    const currentTime = now();
    if (state.pendingPointer && state.pendingPointer.expiresAt < currentTime) {
      state.pendingPointer = null;
    }
    if (state.pendingWheel && state.pendingWheel.expiresAt < currentTime) {
      state.pendingWheel = null;
    }
    if (state.suppressTabClickUntil < currentTime) {
      state.suppressTabClickUntil = 0;
    }
  };

  const commit = (sessionId: string | null, focus = true): void => {
    options.commit(sessionId);
    if (focus) {
      options.focusSession?.(sessionId);
    }
  };

  return {
    state,
    request(source: FocusSource, intent: FocusIntent): void {
      clearExpired();
      const sessionId = intent.sessionId ?? null;
      const action = intent.action ?? "commit";
      if (source === "tab-rename" || action === "suppress-tab-click") {
        state.suppressTabClickUntil = now() + (intent.suppressMs ?? tabClickSuppressMs);
        return;
      }
      if (source === "pointer" && action === "pending" && sessionId) {
        state.pendingPointer = {
          sessionId,
          pointerId: intent.pointerId,
          expiresAt: now() + pointerFocusAllowMs,
        };
        if (intent.focus !== false) {
          options.focusSession?.(sessionId, { allowInactive: true });
        }
        return;
      }
      if (source === "pointer" && action === "abort") {
        state.pendingPointer = null;
        options.focusSession?.(options.getActiveSessionId?.() ?? null);
        return;
      }
      if (source === "wheel" || action === "observe") {
        const previousSessionId = intent.previousSessionId ?? options.getActiveSessionId?.() ?? null;
        if (!sessionId || !previousSessionId || sessionId === previousSessionId) {
          state.pendingWheel = null;
          return;
        }
        state.pendingWheel = {
          sessionId,
          previousSessionId,
          expiresAt: now() + wheelFocusSuppressMs,
          restored: false,
        };
        return;
      }
      if (source === "pointer" && action === "commit") {
        state.pendingPointer = null;
      }
      commit(sessionId, intent.focus !== false);
    },
    observeFocusIn(sessionId: string): "active" | "pending-pointer" | "wheel-restore" | "reconcile" {
      clearExpired();
      const activeSessionId = options.getActiveSessionId?.() ?? null;
      if (state.pendingWheel?.sessionId === sessionId && !state.pendingWheel.restored) {
        state.pendingWheel.restored = true;
        options.focusSession?.(activeSessionId ?? state.pendingWheel.previousSessionId);
        return "wheel-restore";
      }
      if (activeSessionId === sessionId) {
        return "active";
      }
      if (state.pendingPointer?.sessionId === sessionId) {
        return "pending-pointer";
      }
      options.focusSession?.(activeSessionId);
      return "reconcile";
    },
    shouldAcceptInput(sessionId: string): boolean {
      clearExpired();
      if ((options.getActiveSessionId?.() ?? null) === sessionId) return true;
      if (state.pendingPointer?.sessionId === sessionId) {
        state.pendingPointer = null;
        commit(sessionId, true);
        return true;
      }
      options.focusSession?.(options.getActiveSessionId?.() ?? null);
      return false;
    },
    shouldSuppressWheelInput(sessionId: string): boolean {
      clearExpired();
      return Boolean(
        state.pendingWheel
        && (state.pendingWheel.sessionId === sessionId || state.pendingWheel.previousSessionId === sessionId),
      );
    },
    shouldSuppressTabClick(): boolean {
      clearExpired();
      return state.suppressTabClickUntil > now();
    },
    clearSession(sessionId: string): void {
      if (state.pendingPointer?.sessionId === sessionId) state.pendingPointer = null;
      if (
        state.pendingWheel
        && (state.pendingWheel.sessionId === sessionId || state.pendingWheel.previousSessionId === sessionId)
      ) {
        state.pendingWheel = null;
      }
    },
  };
}

type FocusControllerCore = ReturnType<typeof createFocusControllerCore>;

const focusTargets = new Map<string, FocusTarget>();
const terminalLiveOutput = new Set<string>();

function getActiveSessionId(): string | null {
  return useUiStore.getState().activePaneId;
}

function commitActivePaneId(sessionId: string | null): void {
  useUiStore.getState().setActivePaneId(sessionId);
}

function getPaneSessionIds(paneEl: HTMLElement | null | undefined): string[] {
  const root = paneEl?.closest<HTMLElement>("[data-dnd-pane-id]") ?? paneEl;
  const ids = root?.getAttribute("data-pane-session-ids");
  return ids ? ids.split(/\s+/).filter(Boolean) : [];
}

function paneElementOwnsSession(paneEl: HTMLElement | null | undefined, sessionId: string | null | undefined): boolean {
  if (!paneEl || !sessionId) return false;
  const root = paneEl.closest<HTMLElement>("[data-dnd-pane-id]") ?? paneEl;
  return root.getAttribute("data-session-id") === sessionId || getPaneSessionIds(root).includes(sessionId);
}

function queryPaneElementBySessionId(sessionId: string | null | undefined): HTMLElement | null {
  if (!sessionId || typeof document === "undefined") return null;
  const direct = document.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`);
  if (direct) return direct;
  for (const candidate of document.querySelectorAll<HTMLElement>("[data-pane-session-ids]")) {
    if (getPaneSessionIds(candidate).includes(sessionId)) return candidate;
  }
  return null;
}

function focusXtermInElement(el: HTMLElement | null | undefined): boolean {
  const textarea = el?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
  if (textarea) {
    textarea.focus();
    return true;
  }
  if (el) {
    el.focus();
    return true;
  }
  return false;
}

/**
 * A pane composer is a real text field the user aimed at. The terminal refocus
 * retries run for a few hundred milliseconds, so without this they would yank
 * the caret back out of the composer a tap or two after it was opened.
 */
export function composerHoldsFocus(): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  return active instanceof Element && Boolean(active.closest("[data-composer-session]"));
}

function focusSessionSoon(
  sessionId: string | null | undefined,
  options: { allowInactive?: boolean } = {},
): void {
  if (!sessionId || typeof window === "undefined") return;
  let attempts = 0;
  const restoreFocus = (): void => {
    attempts += 1;
    if (composerHoldsFocus()) return;
    if (!options.allowInactive && getActiveSessionId() !== sessionId) return;
    const target = focusTargets.get(sessionId);
    if (target) {
      try {
        target.focus();
      } catch {
        return;
      }
      if (target.containsActiveElement() || attempts >= TERMINAL_FOCUS_RETRY_LIMIT) return;
    } else {
      const paneElement = queryPaneElementBySessionId(sessionId);
      if (focusXtermInElement(paneElement) || attempts >= TERMINAL_FOCUS_RETRY_LIMIT) return;
    }
    window.setTimeout(() => {
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(restoreFocus);
        return;
      }
      restoreFocus();
    }, attempts < 3 ? 16 : 50);
  };
  window.setTimeout(() => {
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(restoreFocus);
      return;
    }
    restoreFocus();
  }, 0);
}

function focusPaneSoon(paneId: string | null | undefined): void {
  if (!paneId || typeof window === "undefined" || typeof document === "undefined") return;
  let attempts = 0;
  const restoreFocus = (): void => {
    attempts += 1;
    const paneElement = document.querySelector<HTMLElement>(`[data-dnd-pane-id="${paneId}"]`);
    if (!paneElementOwnsSession(paneElement, getActiveSessionId())) {
      if (attempts >= TERMINAL_FOCUS_RETRY_LIMIT) return;
      window.setTimeout(() => {
        if (typeof window.requestAnimationFrame === "function") {
          window.requestAnimationFrame(restoreFocus);
          return;
        }
        restoreFocus();
      }, attempts < 3 ? 16 : 50);
      return;
    }
    if (focusXtermInElement(paneElement) || attempts >= TERMINAL_FOCUS_RETRY_LIMIT) return;
    window.setTimeout(() => {
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(restoreFocus);
        return;
      }
      restoreFocus();
    }, attempts < 3 ? 16 : 50);
  };
  window.setTimeout(() => {
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(restoreFocus);
      return;
    }
    restoreFocus();
  }, 0);
}

const core: FocusControllerCore = createFocusControllerCore({
  commit: commitActivePaneId,
  focusSession: focusSessionSoon,
  getActiveSessionId,
});

export const focusController = {
  request(source: FocusSource, intent: FocusIntent): void {
    core.request(source, intent);
  },
  commit(source: FocusSource, sessionId: string | null, intent: Omit<FocusIntent, "sessionId"> = {}): void {
    core.request(source, { ...intent, sessionId, action: "commit" });
  },
  registerTerminal(sessionId: string, target: FocusTarget): () => void {
    focusTargets.set(sessionId, target);
    return () => {
      if (focusTargets.get(sessionId) === target) {
        focusTargets.delete(sessionId);
      }
    };
  },
  observeTerminalFocusIn(sessionId: string): "active" | "pending-pointer" | "wheel-restore" | "reconcile" {
    const result = core.observeFocusIn(sessionId);
    if (result === "active") {
      focusTargets.get(sessionId)?.clearNotification?.();
    }
    return result;
  },
  shouldAcceptTerminalInput(sessionId: string): boolean {
    return core.shouldAcceptInput(sessionId);
  },
  shouldSuppressWheelFocusInput(sessionId: string): boolean {
    return core.shouldSuppressWheelInput(sessionId);
  },
  shouldSuppressTabClick(): boolean {
    return core.shouldSuppressTabClick();
  },
  focusSessionSoon,
  focusPaneSoon,
  clearSession(sessionId: string): void {
    core.clearSession(sessionId);
    focusTargets.delete(sessionId);
    terminalLiveOutput.delete(sessionId);
  },
  markTerminalHasLiveOutput(sessionId: string): void {
    terminalLiveOutput.add(sessionId);
  },
  hasTerminalLiveOutput(sessionId: string): boolean {
    return terminalLiveOutput.has(sessionId);
  },
};

export function applyStructuralActivation(sessionId: string | null | undefined): void {
  if (sessionId === undefined) return;
  commitActivePaneId(sessionId);
}
