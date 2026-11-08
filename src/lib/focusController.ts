import { useUiStore } from "../stores/uiStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";

export type FocusSource =
  | "hover"
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
  focusGuard?: () => boolean;
  commitHoverSelection?: (commit: () => void) => void;
  onHoverFocusAborted?: () => void;
}

interface SessionFocusOptions {
  allowInactive?: boolean;
  requireEligibleTerminal?: boolean;
  focusGuard?: () => boolean;
  requireRegisteredTarget?: boolean;
  acquireFocus?: (target: FocusTarget) => void;
  onFocused?: (ownsFocus?: () => boolean) => void;
  onFocusAborted?: () => void;
}

interface HoverFocusOwnership {
  sessionId: string;
  focusGuard?: () => boolean;
  allowsFocus: () => boolean;
  abort: () => void;
  focusReport?: () => void;
}

type FocusTarget = {
  focus: () => void;
  containsActiveElement: () => boolean;
  clearNotification?: () => void;
  isEligible?: () => boolean;
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
  focusSession?: (sessionId: string | null | undefined, options?: SessionFocusOptions) => void;
  getActiveSessionId?: () => string | null;
}

const DEFAULT_POINTER_FOCUS_ALLOW_MS = 1500;
const DEFAULT_WHEEL_FOCUS_SUPPRESS_MS = 350;
const DEFAULT_TAB_CLICK_SUPPRESS_MS = 250;
const TERMINAL_FOCUS_RETRY_LIMIT = 8;

function notifyHoverFocusAborted(intent: FocusIntent): void {
  try { intent.onHoverFocusAborted?.(); }
  catch { /* Rejected hover cleanup must not block a newer explicit request. */ }
}

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

  let pendingHover: HoverFocusOwnership | null = null;
  let acquiringHover: HoverFocusOwnership | null = null;
  let hoverRecovery: { sessionId: string | null; owner: HoverFocusOwnership; options: SessionFocusOptions } | null = null;

  const liveHoverRecovery = () => {
    if (hoverRecovery) {
      try { if (hoverRecovery.options.focusGuard?.() !== false) return hoverRecovery; }
      catch { /* Dead ownership must not affect a later independent observation. */ }
      hoverRecovery = null;
    }
    return null;
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

  const commit = (sessionId: string | null, focus = true, focusOptions?: SessionFocusOptions): void => {
    options.commit(sessionId);
    if (focus) {
      if (focusOptions) options.focusSession?.(sessionId, focusOptions);
      else options.focusSession?.(sessionId);
    }
  };

  return {
    state,
    request(source: FocusSource, intent: FocusIntent): void {
      clearExpired();
      if (source !== "hover") {
        pendingHover?.abort();
        pendingHover = null; hoverRecovery = null;
      }
      const sessionId = intent.sessionId ?? null;
      const action = intent.action ?? "commit";
      if (source === "hover" && (action !== "commit" || intent.focus === false || !options.focusSession)) {
        notifyHoverFocusAborted(intent);
        return;
      }
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
      if (source === "hover") {
        if (!sessionId) { notifyHoverFocusAborted(intent); return; }
        state.pendingPointer = null;
        state.pendingWheel = null;
        const previous = options.getActiveSessionId?.() ?? null;
        const abort = () => {
          token.focusReport = undefined;
          if (pendingHover !== token) return;
          pendingHover = null;
          if (hoverRecovery?.owner === token) hoverRecovery = null;
          notifyHoverFocusAborted(intent);
        };
        const token: HoverFocusOwnership = { sessionId, focusGuard: intent.focusGuard, abort, allowsFocus: () => {
          try {
            if (pendingHover === token && (options.getActiveSessionId?.() ?? null) === previous
              && intent.focusGuard?.() !== false) return true;
          } catch { /* Uncertain hover ownership must never focus. */ }
          abort();
          return false;
        } };
        pendingHover?.abort();
        pendingHover = token;
        // Queued recovery retains its guard; only live ownership influences future observations.
        hoverRecovery = { sessionId: previous, owner: token, options: { focusGuard: token.allowsFocus, requireRegisteredTarget: true } };
        options.focusSession?.(sessionId, {
          allowInactive: true, requireRegisteredTarget: true, focusGuard: token.allowsFocus,
          onFocusAborted: abort,
          acquireFocus: (target) => {
            token.focusReport = undefined;
            acquiringHover = token;
            try { target.focus(); }
            finally {
              acquiringHover = null;
              if (!target.containsActiveElement()) token.focusReport = undefined;
            }
          },
          onFocused: (ownsFocus = () => true) => {
            let committed = false;
            const finish = () => {
              if (!token.allowsFocus()) return;
              pendingHover = null;
              options.commit(sessionId);
              if (hoverRecovery?.owner === token && (options.getActiveSessionId?.() ?? null) === sessionId) {
                hoverRecovery = { sessionId, owner: token, options: { focusGuard: intent.focusGuard, requireRegisteredTarget: true } };
                committed = true;
              }
            };
            if (intent.commitHoverSelection) intent.commitHoverSelection(finish);
            else finish();
            // The runtime records its new revision before the deferred protocol report is released.
            const report = token.focusReport;
            token.focusReport = undefined;
            if (!report || !committed || hoverRecovery?.owner !== token
              || (options.getActiveSessionId?.() ?? null) !== sessionId || !ownsFocus()) return;
            try { if (intent.focusGuard?.() === false) return; }
            catch { return; }
            report();
          },
        });
      } else {
        commit(sessionId, intent.focus !== false);
      }
    },
    observeFocusIn(sessionId: string): "active" | "pending-pointer" | "pending-hover" | "wheel-restore" | "reconcile" {
      clearExpired();
      const activeSessionId = options.getActiveSessionId?.() ?? null;
      if (pendingHover?.sessionId === sessionId && pendingHover.allowsFocus()) return "pending-hover";
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
      const recovery = liveHoverRecovery();
      if (recovery && recovery.sessionId === activeSessionId) {
        options.focusSession?.(activeSessionId, recovery.options);
        return "reconcile";
      }
      options.focusSession?.(activeSessionId);
      return "reconcile";
    },
    shouldAcceptInput(sessionId: string): boolean {
      clearExpired();
      if ((options.getActiveSessionId?.() ?? null) === sessionId) return true;
      // Other inactive bytes from focus() must neither pass nor queue a competing recovery.
      if (acquiringHover?.sessionId === sessionId) return false;
      if (state.pendingPointer?.sessionId === sessionId) {
        state.pendingPointer = null;
        commit(sessionId, true);
        return true;
      }
      const recovery = liveHoverRecovery();
      if (recovery && recovery.sessionId === (options.getActiveSessionId?.() ?? null)) {
        options.focusSession?.(recovery.sessionId, recovery.options);
        return false;
      }
      options.focusSession?.(options.getActiveSessionId?.() ?? null);
      return false;
    },
    deferHoverFocusReport(sessionId: string, data: string, accept: () => void): boolean {
      if (data !== "\x1b[I" || acquiringHover?.sessionId !== sessionId) return false;
      const token = acquiringHover;
      if (pendingHover === token && token.allowsFocus()) token.focusReport ??= accept;
      // A report from a canceled synchronous acquisition is consumed without delivery.
      return true;
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
    cancelHoverFocus(focusGuard: () => boolean): void {
      if (pendingHover?.focusGuard === focusGuard) pendingHover.abort();
      if (hoverRecovery?.owner.focusGuard === focusGuard) hoverRecovery = null;
    },
    invalidatePendingIntents(): void {
      state.pendingPointer = null;
      state.pendingWheel = null;
    },
    clearSession(sessionId: string): void {
      if (pendingHover?.sessionId === sessionId) pendingHover.abort();
      if (hoverRecovery?.sessionId === sessionId) hoverRecovery = null;
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

interface FocusReturnOwner {
  isLive: () => boolean;
  fallback: () => HTMLElement | null;
}
const focusReturnOwners = new WeakMap<HTMLElement, FocusReturnOwner>();
export type PaneFocusReturn = ((temporary: HTMLElement | null) => void) & { cancel: () => void };

/** Hosts without a workspace pane must explicitly validate their own lifetime. */
export function registerFocusReturnOwner(root: HTMLElement, owner: FocusReturnOwner): () => void {
  focusReturnOwners.set(root, owner);
  return () => { if (focusReturnOwners.get(root) === owner) focusReturnOwners.delete(root); };
}

/** Explicit completion of pane-owned temporary UI must not steal a newer focus. */
export function capturePaneFocusReturn(
  element: HTMLElement | null,
  trigger: HTMLElement | null,
  isPaneLive?: () => boolean,
): PaneFocusReturn {
  let paneRoot = element;
  while (paneRoot && !paneRoot.matches("[data-dnd-pane-id]") && !focusReturnOwners.has(paneRoot)) paneRoot = paneRoot.parentElement;
  const owner = paneRoot ? focusReturnOwners.get(paneRoot) : undefined;
  const isLive = isPaneLive ?? (owner ? () => focusReturnOwners.get(paneRoot!) === owner && owner.isLive() : () => {
    const state = useWorkspaceListStore.getState();
    const workspaceId = paneRoot?.dataset.dndWorkspaceId;
    const paneId = paneRoot?.dataset.dndPaneId;
    const zoomed = useUiStore.getState().zoomedPaneId;
    return state.activeWorkspaceId === workspaceId && (!zoomed || zoomed === paneId)
      && Boolean(state.workspaces.find(ws => ws.id === workspaceId)?.panes.some(p => p.id === paneId));
  });
  const revision = useUiStore.getState().focusRevision;
  if (!paneRoot) return Object.assign(() => {}, { cancel: () => {} });
  const root = paneRoot;
  const doc = root.ownerDocument;
  let lastFocused = doc.activeElement;
  let cancelled = false;
  const owns = (target: EventTarget | null): target is Element => {
    if (!(target instanceof doc.defaultView!.Element) || target.ownerDocument !== doc) return false;
    if (root.contains(target)) return true;
    const portal = target.closest<HTMLElement>("[data-pane-focus-pane-id]");
    return Boolean(root.dataset.dndPaneId && portal?.dataset.paneFocusPaneId === root.dataset.dndPaneId
      && portal.dataset.paneFocusWorkspaceId === root.dataset.dndWorkspaceId);
  };
  const cancel = (): void => {
    cancelled = true;
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("focusin", onFocusIn, true);
  };
  const onPointerDown = (event: Event): void => { if (!root.isConnected || !owns(event.target)) cancel(); };
  const onFocusIn = (event: Event): void => {
    if (!root.isConnected) { cancel(); return; }
    if (owns(event.target)) lastFocused = event.target;
    // Removal or disabling during completion can itself leave body focused.
    // Outside pointer/focus intent still cancels, even when it also ends on body.
    else if (event.target !== doc.body || (lastFocused?.isConnected && !lastFocused.matches(":disabled"))) cancel();
  };
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("focusin", onFocusIn, true);
  const restore = (temporary: HTMLElement | null): void => {
    if (cancelled) return;
    cancel(); // Each completion is consumed, including a rejected/superseded return.
    if (!paneRoot?.isConnected || !isLive() || useUiStore.getState().focusRevision !== revision) return;
    const active = doc.activeElement;
    if (active && active !== doc.body && !temporary?.contains(active)) return;
    if ((!active || active === doc.body) && (!lastFocused || !temporary?.contains(lastFocused)
      || (lastFocused.isConnected && !lastFocused.matches(":disabled")))) return;
    const preferred = trigger?.isConnected && paneRoot.contains(trigger) ? trigger : null;
    const target = preferred ?? (owner ? owner.fallback() : paneRoot.querySelector<HTMLElement>(".pane-active-heading[tabindex]") ?? paneRoot);
    if (!target?.isConnected || !paneRoot.contains(target) || target.closest("[hidden],[aria-hidden='true']")) return;
    target.focus({ preventScroll: true });
  };
  return Object.assign(restore, { cancel });
}

/** Synchronous temporary UI completion may follow a new focus entry.
 * Async jobs must keep using the single-use capture above, never this observer.
 */
export function captureTemporaryFocusReturn(
  element: HTMLElement | null,
  trigger: HTMLElement | null,
  temporary: () => HTMLElement | null,
  isPaneLive?: () => boolean,
): PaneFocusReturn {
  const doc = element?.ownerDocument;
  let pending = capturePaneFocusReturn(element, trigger, isPaneLive);
  let finished = false;
  const onFocusIn = (event: Event): void => {
    const surface = temporary();
    if (finished || !doc || !(event.target instanceof doc.defaultView!.Element)
      || !surface?.isConnected || surface.ownerDocument !== doc || !surface.contains(event.target)
      || surface.closest("[hidden],[aria-hidden='true'],[inert]")) return;
    pending.cancel();
    pending = capturePaneFocusReturn(element, trigger, isPaneLive);
  };
  const cancel = (): void => {
    finished = true;
    doc?.removeEventListener("focusin", onFocusIn, true);
    pending.cancel();
  };
  doc?.addEventListener("focusin", onFocusIn, true);
  const restore = (surface: HTMLElement | null): void => {
    if (finished) return;
    finished = true;
    doc?.removeEventListener("focusin", onFocusIn, true);
    pending(surface);
    pending.cancel();
  };
  return Object.assign(restore, { cancel });
}

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
  const textarea = Array.from(el?.querySelectorAll<HTMLTextAreaElement>(".xterm-helper-textarea") ?? [])
    .find(candidate => !candidate.closest("[hidden],[aria-hidden='true']"));
  if (textarea) {
    textarea.focus();
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

// A retry belongs to its terminal/pane and to the window that scheduled it.
// Keep both timer kinds so unmount/close cannot leave a callback in a dead window.
const focusRetryCancellations = new Map<string, Set<() => void>>();

function cancelFocusRetries(owner: string): void {
  for (const cancel of [...(focusRetryCancellations.get(owner) ?? [])]) cancel();
}

function trackFocusRetry(owner: string, onCancelled?: () => void) {
  const ownerWindow = window;
  const timers = new Set<number>();
  const frames = new Set<number>();
  let active = true;
  const isLive = () => active && typeof window !== "undefined" && window === ownerWindow && !ownerWindow.closed;
  const finish = (): void => {
    active = false;
    // Preserve the receiver: bare WebView2 timer methods can throw Illegal invocation.
    timers.forEach(id => ownerWindow.clearTimeout(id));
    frames.forEach(id => ownerWindow.cancelAnimationFrame(id));
    timers.clear(); frames.clear();
    ownerWindow.removeEventListener?.("pagehide", cancel);
    ownerWindow.removeEventListener?.("beforeunload", cancel);
    const owners = focusRetryCancellations.get(owner);
    owners?.delete(cancel);
    if (owners?.size === 0) focusRetryCancellations.delete(owner);
  };
  const cancel = (): void => {
    if (!active) return;
    finish();
    onCancelled?.();
  };
  const owners = focusRetryCancellations.get(owner) ?? new Set<() => void>();
  owners.add(cancel);
  focusRetryCancellations.set(owner, owners);
  ownerWindow.addEventListener?.("pagehide", cancel);
  ownerWindow.addEventListener?.("beforeunload", cancel);
  const schedule = (callback: () => void, delay: number): void => {
    if (!isLive()) { cancel(); return; }
    // A callback that throws ends the retry, as it did before cancellation existed.
    const run = (): void => {
      try { callback(); } catch (error) { finish(); throw error; }
    };
    const timer = ownerWindow.setTimeout(() => {
      timers.delete(timer);
      if (!isLive()) { cancel(); return; }
      if (typeof ownerWindow.requestAnimationFrame === "function") {
        // Some hosts invoke RAF synchronously; do not retain an already-fired frame.
        let frame: number | undefined;
        let fired = false;
        frame = ownerWindow.requestAnimationFrame(() => {
          fired = true;
          if (frame !== undefined) frames.delete(frame);
          if (!isLive()) { cancel(); return; }
          run();
        });
        if (!fired) frames.add(frame);
      } else run();
    }, delay);
    timers.add(timer);
  };
  return { schedule, finish, cancel };
}

function focusSessionSoon(
  sessionId: string | null | undefined,
  options: SessionFocusOptions = {},
): void {
  if (!sessionId || typeof window === "undefined" || window.closed) { options.onFocusAborted?.(); return; }
  const revision = useUiStore.getState().focusRevision;
  const retry = trackFocusRetry(`session:${sessionId}`, () => options.onFocusAborted?.());
  let attempts = 0;
  const restoreFocus = (): void => {
    if (options.requireRegisteredTarget) {
      try {
        if (!focusTargets.has(sessionId) || options.focusGuard?.() === false) { retry.cancel(); return; }
      } catch {
        retry.cancel();
        return;
      }
    }
    attempts += 1;
    if (composerHoldsFocus() || useUiStore.getState().focusRevision !== revision) { retry.cancel(); return; }
    if (!options.allowInactive && getActiveSessionId() !== sessionId) { retry.cancel(); return; }
    const target = focusTargets.get(sessionId);
    if (options.requireEligibleTerminal && !isTerminalEligible(sessionId)) { retry.finish(); return; }
    if (target) {
      try {
        if (options.acquireFocus) options.acquireFocus(target);
        else target.focus();
      } catch {
        retry.cancel();
        return;
      }
      if (options.onFocused) {
        try {
          if (target.containsActiveElement()) {
            if (focusTargets.get(sessionId) === target && options.focusGuard?.() !== false) {
              retry.finish();
              try { options.onFocused(() => focusTargets.get(sessionId) === target && target.containsActiveElement()); }
              catch { options.onFocusAborted?.(); }
            } else retry.cancel();
            return;
          }
        } catch { retry.cancel(); return; }
        if (attempts >= TERMINAL_FOCUS_RETRY_LIMIT) { retry.cancel(); return; }
      } else {
        if (target.containsActiveElement() || attempts >= TERMINAL_FOCUS_RETRY_LIMIT) { retry.finish(); return; }
      }
    } else {
      if (options.requireRegisteredTarget) { retry.cancel(); return; }
      const paneElement = queryPaneElementBySessionId(sessionId);
      if (focusXtermInElement(paneElement) || attempts >= TERMINAL_FOCUS_RETRY_LIMIT) { retry.finish(); return; }
    }
    retry.schedule(restoreFocus, attempts < 3 ? 16 : 50);
  };
  retry.schedule(restoreFocus, 0);
}

function isTerminalEligible(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  try {
    return focusTargets.get(sessionId)?.isEligible?.() === true;
  } catch {
    return false;
  }
}

function focusPaneSoon(paneId: string | null | undefined): void {
  if (!paneId || typeof window === "undefined" || window.closed || typeof document === "undefined") return;
  const revision = useUiStore.getState().focusRevision;
  const retry = trackFocusRetry(`pane:${paneId}`);
  let attempts = 0;
  const restoreFocus = (): void => {
    attempts += 1;
    if (composerHoldsFocus() || useUiStore.getState().focusRevision !== revision) { retry.finish(); return; }
    const paneElement = document.querySelector<HTMLElement>(`[data-dnd-pane-id="${paneId}"]`);
    if (!paneElementOwnsSession(paneElement, getActiveSessionId())) {
      if (attempts >= TERMINAL_FOCUS_RETRY_LIMIT) { retry.finish(); return; }
      retry.schedule(restoreFocus, attempts < 3 ? 16 : 50);
      return;
    }
    if (focusXtermInElement(paneElement) || attempts >= TERMINAL_FOCUS_RETRY_LIMIT) { retry.finish(); return; }
    retry.schedule(restoreFocus, attempts < 3 ? 16 : 50);
  };
  retry.schedule(restoreFocus, 0);
}

const core: FocusControllerCore = createFocusControllerCore({
  commit: commitActivePaneId,
  focusSession: focusSessionSoon,
  getActiveSessionId,
});

// Selection may come directly from a document or native webview, so cancel old
// terminal intent even when it did not pass through request(). Rename timing
// is independent and deliberately survives this cancellation.
useUiStore.subscribe((state, previous) => {
  if (state.focusRevision !== previous.focusRevision) core.invalidatePendingIntents();
});

export const focusController = {
  request(source: FocusSource, intent: FocusIntent): void {
    if (source === "hover" && (!intent.sessionId || !focusTargets.has(intent.sessionId))) {
      notifyHoverFocusAborted(intent);
      return;
    }
    core.request(source, intent);
  },
  commit(source: FocusSource, sessionId: string | null, intent: Omit<FocusIntent, "sessionId"> = {}): void {
    if (source === "hover" && (!sessionId || !focusTargets.has(sessionId))) {
      notifyHoverFocusAborted(intent);
      return;
    }
    core.request(source, { ...intent, sessionId, action: "commit" });
  },
  registerTerminal(sessionId: string, target: FocusTarget): () => void {
    // Retries are looked up by session on every tick, so a terminal that is
    // remounted (drag to another pane) must keep them. Window teardown and
    // clearSession() are the only cancellations.
    focusTargets.set(sessionId, target);
    return () => {
      if (focusTargets.get(sessionId) === target) focusTargets.delete(sessionId);
    };
  },
  resolveEligibleTerminal(...sessionIds: (string | null | undefined)[]): string | null {
    return sessionIds.find(isTerminalEligible) ?? null;
  },
  focusEligibleTerminal(sessionId: string): void {
    if (!isTerminalEligible(sessionId)) return;
    focusController.request("programmatic", { sessionId, focus: false });
    focusSessionSoon(sessionId, { requireEligibleTerminal: true });
  },
  observeTerminalFocusIn(sessionId: string): "active" | "pending-pointer" | "pending-hover" | "wheel-restore" | "reconcile" {
    const result = core.observeFocusIn(sessionId);
    if (result === "active") {
      focusTargets.get(sessionId)?.clearNotification?.();
    }
    return result;
  },
  shouldAcceptTerminalInput(sessionId: string): boolean {
    return core.shouldAcceptInput(sessionId);
  },
  deferHoverFocusReport(sessionId: string, data: string, accept: () => void): boolean {
    return core.deferHoverFocusReport(sessionId, data, accept);
  },
  shouldSuppressWheelFocusInput(sessionId: string): boolean {
    return core.shouldSuppressWheelInput(sessionId);
  },
  shouldSuppressTabClick(): boolean {
    return core.shouldSuppressTabClick();
  },
  cancelHoverFocus(focusGuard: () => boolean): void { core.cancelHoverFocus(focusGuard); },
  focusSessionSoon,
  focusPaneSoon,
  clearSession(sessionId: string): void {
    cancelFocusRetries(`session:${sessionId}`);
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
