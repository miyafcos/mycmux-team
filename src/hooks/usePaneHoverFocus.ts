import { useEffect, useRef, type RefObject } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";
import { usePaneDragStore } from "../stores/paneDragStore";
import { useSavepointDragStore } from "../stores/savepointDragStore";
import { useDetachedDockStore } from "../stores/detachedDockStore";
import { composerHoldsFocus, focusController } from "../lib/focusController";
import { isRestorableTab } from "../lib/tabLifecycle";
import { isStartupSessionPending } from "../lib/startupSessionGate";
import { isTearoutSessionDormant } from "../lib/tearout/sessionAttachment";
import { createPaneHoverState, decidePaneHoverFocus, paneHoverSnapshotAllowsFocus,
  PANE_HOVER_FOCUS_DWELL_MS, samePaneHoverTarget,
  type PaneHoverCandidate, type PaneHoverEvent, type PaneHoverSnapshot, type PaneHoverTarget } from "../lib/paneHoverFocus";

const BLOCKERS = ".cmux-overlay-backdrop,[data-cmux-overlay-root],[role='dialog'],[role='alertdialog'],[aria-modal='true'],"
  + ".cmux-popover-panel,[role='menu'],[data-cmux-native-webview-occluder],[data-pane-hover-focus-blocker]";
const EXCLUDED = "button,a,input,textarea:not(.xterm-helper-textarea),select,iframe,embed,object,[contenteditable],[role='button'],[role='separator'],"
  + "[draggable='true'],[data-dnd-drag-handle],[data-pane-drag-handle],[data-terminal-transcript-panel],[data-terminal-history],[data-terminal-search],[data-agent-resume-recovery],"
  + "[hidden],[inert],[aria-hidden='true'],[data-composer-session],[data-declared-tab-placeholder],[data-dormant-transfer-placeholder]";

interface PaneHoverRegistration {
  enabled: boolean;
  workspaceId: string;
  paneId: string;
  tabId: string;
  sessionId: string;
  kind: PaneHoverTarget["kind"];
  onActivate: (focusGuard: () => boolean, commitHoverSelection: (commit: () => void) => void, onHoverFocusAborted: () => void) => void;
}
interface Surface { element: HTMLElement; current: () => PaneHoverRegistration }
interface FocusToken { phase: "pending" | "committed"; valid: boolean; focusGuard?: () => boolean; candidate: PaneHoverCandidate; surface: Surface; activeId?: string | null; focusRevision?: number }

function visible(element: HTMLElement, closingOverlay = false): boolean {
  if (!element.isConnected) return false;
  if (closingOverlay) return true;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.hidden || node.hasAttribute("inert") || node.getAttribute("aria-hidden") === "true") return false;
    const style = node.ownerDocument.defaultView!.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
  }
  return Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
}

function editable(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const value = node.getAttribute("contenteditable");
    if (value === "false") return false;
    if (value === "" || value === "true" || value === "plaintext-only") return true;
  }
  return (element as HTMLElement).isContentEditable === true;
}

class PaneHoverRuntime {
  private surfaces = new Map<HTMLElement, Surface>();
  private state;
  private timer: number | undefined;
  private cleanup: Array<() => void> = [];
  private observer: MutationObserver;
  private resize: ResizeObserver | undefined;
  private blockerRevision = 0;
  private owned: FocusToken | undefined;
  private committing = false;
  private buttons = 0;
  private modified = false;
  private capture = false;
  private focused: boolean;
  private lastFocus: Element | null;

  constructor(private doc: Document) {
    const win = doc.defaultView!;
    this.focused = doc.hasFocus();
    this.lastFocus = doc.activeElement;
    this.state = createPaneHoverState(this.lastFocus?.matches(".xterm-helper-textarea") ? "unknown" : "known");
    const listen = (target: EventTarget, name: string, fn: (event: Event) => void, passive = false) => {
      function paneHoverFocusListener(event: Event) { fn(event); }
      target.addEventListener(name, paneHoverFocusListener, { capture: true, passive });
      this.cleanup.push(() => target.removeEventListener(name, paneHoverFocusListener, true));
    };
    listen(doc, "pointermove", (event) => this.move(event as PointerEvent), true);
    listen(doc, "pointerenter", (event) => {
      const surface = this.resolve(event.target);
      if (surface) this.send({ type: "enter", surface: surface.element });
    }, true);
    listen(doc, "pointerleave", (event) => {
      const e = event as PointerEvent;
      const surface = this.resolve(e.target);
      if (surface && this.resolve(e.relatedTarget) !== surface) {
        if (this.owned?.phase === "pending" && this.owned.surface === surface) this.killToken();
        this.send({ type: "leave", surface: surface.element });
      }
    }, true);
    listen(doc, "pointerdown", (event) => {
      this.buttons = (event as PointerEvent).buttons || 1;
      this.invalidate("down");
    });
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) listen(doc, name, () => {
      this.buttons = 0; this.capture = false;
      this.invalidate(name === "pointerup" ? "up" : "cancel");
    });
    listen(doc, "gotpointercapture", () => { this.capture = true; this.invalidate(); });
    listen(doc, "compositionstart", () => this.invalidate("compositionstart"));
    listen(doc, "compositionend", () => this.invalidate("compositionend"));
    listen(doc, "keydown", (event) => {
      const e = event as KeyboardEvent;
      this.modified = e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
      this.killToken();
      this.send({ type: "key", composing: e.isComposing || e.key === "Process" || e.keyCode === 229 });
    });
    listen(doc, "keyup", (event) => {
      const e = event as KeyboardEvent;
      this.modified = e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
      this.invalidate();
    });
    listen(doc, "focusin", () => {
      const active = doc.activeElement;
      if (active === this.lastFocus) return;
      this.lastFocus = active;
      // Our own registered terminal/search focus is not a newer explicit selection.
      const token = this.owned, target = token?.candidate.snapshot.target;
      const ownInput = target?.kind === "terminal"
        ? active?.matches(".xterm-helper-textarea") && active.closest("[data-session-id]")?.getAttribute("data-session-id") === target.sessionId
        : active?.matches("input") && !!active.closest("[data-launcher-pane]");
      const ownFocus = token?.valid && ownInput && token.surface.element.closest("[data-dnd-pane-id]")?.contains(active);
      if (!ownFocus) this.invalidate("focuschange");
    });
    listen(doc, "focusout", () => {
      this.send({ type: "invalidate" });
    });
    listen(win, "blur", (event) => {
      if (event.target !== win && (event.target as Window | null)?.document !== doc) return;
      this.focused = false; this.buttons = 0; this.capture = false; this.invalidate("blur");
    });
    listen(win, "focus", (event) => {
      if (event.target !== win && (event.target as Window | null)?.document !== doc) return;
      this.focused = true; this.invalidate("focus");
    });
    listen(doc, "visibilitychange", () => { this.buttons = 0; this.capture = false; this.invalidate("visibility"); });
    for (const name of ["mycmux:workspace-visibility-change", "mycmux:terminal-layout-change"]) {
      listen(win, name, () => this.invalidate());
    }
    const changed = () => this.invalidate();
    const runtime = this;
    // These subscriptions belong to the enabled runtime, never to click mode.
    function paneHoverFocusStoreChanged() { changed(); }
    function paneHoverFocusUiChanged() { if (!runtime.committing) changed(); }
    function paneHoverFocusSettingsChanged(next: { paneFocusMode: string }, prev: { paneFocusMode: string }) {
      if (next.paneFocusMode !== prev.paneFocusMode) changed();
    }
    this.cleanup.push(useWorkspaceListStore.subscribe(paneHoverFocusStoreChanged));
    this.cleanup.push(useUiStore.subscribe(paneHoverFocusUiChanged));
    this.cleanup.push(usePaneDragStore.subscribe(paneHoverFocusStoreChanged));
    this.cleanup.push(useSavepointDragStore.subscribe(paneHoverFocusStoreChanged));
    this.cleanup.push(useDetachedDockStore.subscribe(paneHoverFocusStoreChanged));
    this.cleanup.push(useSettingsStore.subscribe(paneHoverFocusSettingsChanged));
    this.observer = new win.MutationObserver((records) => {
      const relevant = records.some((r) => {
        const target = r.target as Element;
        if (r.type === "attributes") {
          if (target.matches?.(BLOCKERS) || target.querySelector?.(BLOCKERS)) return true;
          if (r.attributeName === "class") return /cmux-overlay-backdrop|cmux-popover-panel/.test(r.oldValue ?? "");
          if (r.attributeName === "role") return r.oldValue === "dialog" || r.oldValue === "alertdialog" || r.oldValue === "menu";
          if (r.attributeName === "aria-modal") return r.oldValue === "true";
          return r.attributeName?.startsWith("data-") ?? false;
        }
        return [...r.addedNodes, ...r.removedNodes].some((node) => node instanceof win.Element
          && (node.matches(BLOCKERS) || (!target.closest?.(".xterm") && !!node.querySelector(BLOCKERS))));
      });
      if (relevant) { this.blockerRevision++; this.invalidate(); }
    });
    this.observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeOldValue: true,
      attributeFilter: ["class", "role", "aria-modal", "style", "hidden", "inert", "aria-hidden",
        "data-cmux-overlay-root", "data-cmux-native-webview-occluder", "data-pane-hover-focus-blocker"] });
    if (win.ResizeObserver) this.resize = new win.ResizeObserver(() => this.invalidate());
  }

  register(surface: Surface): () => void {
    this.surfaces.set(surface.element, surface);
    this.resize?.observe(surface.element);
    this.invalidate();
    return () => {
      this.surfaces.delete(surface.element);
      this.resize?.unobserve(surface.element);
      this.invalidate();
      if (this.surfaces.size === 0) {
        this.observer.disconnect(); this.resize?.disconnect();
        for (const clean of this.cleanup) clean();
        runtimes.delete(this.doc);
      }
    };
  }

  private resolve(target: EventTarget | null): Surface | undefined {
    const win = this.doc.defaultView!;
    let element = target instanceof win.Element ? target : null;
    const origin = element;
    while (element) {
      const surface = this.surfaces.get(element as HTMLElement);
      if (surface) {
        const excluded = origin?.closest(EXCLUDED);
        if (excluded && surface.element.contains(excluded)) return;
        return surface;
      }
      element = element.parentElement;
    }
  }

  private snapshot(surface?: Surface, ownFocus = false): PaneHoverSnapshot {
    const ui = useUiStore.getState(), list = useWorkspaceListStore.getState();
    const registration = surface?.current();
    const ws = registration && list.getWorkspace(registration.workspaceId);
    const pane = ws?.panes.find((p) => p.id === registration?.paneId);
    const tab = pane?.tabs.find((t) => t.id === pane.activeTabId) ?? pane?.tabs[0];
    const target = surface && registration ? { ...registration, surface: surface.element } : null;
    const normal = tab && isRestorableTab(tab) && !isStartupSessionPending(tab.sessionId) && !isTearoutSessionDormant(tab.sessionId);
    const exact = !!registration?.enabled && !!normal && tab.id === registration.tabId && tab.sessionId === registration.sessionId
      && (registration.kind === "launcher" ? tab.type === "launcher" : tab.type === undefined || tab.type === "terminal")
      && surface?.element.closest("[data-dnd-pane-id]")?.getAttribute("data-dnd-pane-id") === registration.paneId;
    const active = this.doc.activeElement;
    const ownInput = ownFocus && registration?.kind === "launcher" && surface?.element.parentElement?.contains(active);
    const protectedFocus = !!surface && !!active && !ownInput && (composerHoldsFocus() || editable(active)
      || (active.matches("input,textarea,select,iframe,embed,object") && !active.matches(".xterm-helper-textarea")));
    const blocked = !!surface && [...this.doc.querySelectorAll<HTMLElement>(BLOCKERS)].some((element) =>
      visible(element, element.matches(".cmux-overlay-backdrop,[data-cmux-overlay-root]")));
    return { mode: useSettingsStore.getState().paneFocusMode, target: exact ? target : null,
      activePaneId: ui.activePaneId, focusRevision: ui.focusRevision, layoutRevision: list.layoutRevision,
      zoomedPaneId: ui.zoomedPaneId, blockerRevision: this.blockerRevision,
      windowFocused: this.focused && this.doc.hasFocus(), documentVisible: this.doc.visibilityState === "visible",
      connected: !!surface?.element.isConnected, visible: !!surface && visible(surface.element)
        && list.activeWorkspaceId === registration?.workspaceId && (ui.zoomedPaneId === null || ui.zoomedPaneId === registration?.paneId),
      samePane: !!pane && (pane.sessionId === ui.activePaneId || pane.tabs.some((t) => t.sessionId === ui.activePaneId)),
      dragging: !!(usePaneDragStore.getState().item || useSavepointDragStore.getState().item || useDetachedDockStore.getState().active),
      captured: this.capture || this.buttons !== 0 || this.modified,
      blocked, editorFocused: protectedFocus, selected: this.doc.getSelection()?.isCollapsed === false };
  }

  private move(event: PointerEvent): void {
    this.buttons = event.buttons; this.modified = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
    if (event.target instanceof this.doc.defaultView!.Element && event.target.hasPointerCapture?.(event.pointerId)) this.capture = true;
    const pointer = this.state.pointer;
    const surface = this.resolve(event.target);
    const cheapReject = event.pointerType !== "mouse" || event.buttons !== 0 || this.modified
      || this.state.down || this.state.ime !== "known";
    const pending = this.owned?.phase === "pending" ? this.owned : undefined;
    if (pending) {
      if (!cheapReject && surface === pending.surface && pending.focusGuard?.()) {
        // Acquisition already owns this dwell. Movement inside it only updates the hit point.
        this.state = { ...this.state, pointer: { id: event.pointerId, x: event.clientX, y: event.clientY }, inside: surface.element };
        return;
      }
      this.killToken();
    }
    if (!this.state.candidate && pointer?.id === event.pointerId
      && pointer.x === event.clientX && pointer.y === event.clientY) return;
    // Detailed DOM gates only at arm/dwell/acquisition; same-surface motion retains its start.
    const c = this.state.candidate;
    const snapshot = c && surface?.element === c.snapshot.target?.surface
      ? c.snapshot : this.snapshot(cheapReject ? undefined : surface);
    this.send({ type: "move", snapshot, now: this.doc.defaultView!.performance.now(), pointerId: event.pointerId,
      x: event.clientX, y: event.clientY, movementX: event.movementX, movementY: event.movementY,
      pointerType: event.pointerType, buttons: event.buttons, modified: this.modified });
  }

  private send(event: PaneHoverEvent): void {
    const result = decidePaneHoverFocus(this.state, event);
    this.state = result.state;
    if (result.effect.type === "cancel") this.clearTimer();
    if (result.effect.type === "arm") {
      this.killToken(); this.clearTimer();
      const runtime = this;
      this.timer = this.doc.defaultView!.setTimeout(function paneHoverFocusDwell() {
        runtime.timer = undefined;
        const pointer = runtime.state.pointer;
        const hit = pointer && runtime.doc.elementFromPoint(pointer.x, pointer.y);
        const surface = runtime.resolve(hit || null);
        runtime.send({ type: "dwell", now: runtime.doc.defaultView!.performance.now(), snapshot: runtime.snapshot(surface) });
      }, PANE_HOVER_FOCUS_DWELL_MS);
    }
    if (result.effect.type === "activate") this.activate(result.effect.candidate);
  }

  private activate(candidate: PaneHoverCandidate): void {
    const surface = this.surfaces.get(candidate.snapshot.target?.surface as HTMLElement);
    if (!surface) return;
    const token: FocusToken = { phase: "pending", valid: true, candidate, surface };
    this.owned = token;
    const guard = () => {
      if (!token.valid || this.owned !== token || this.state.down || this.state.ime !== "known") return false;
      try {
        if (token.phase === "pending") {
          const pointer = this.state.pointer;
          if (!pointer || this.resolve(this.doc.elementFromPoint(pointer.x, pointer.y)) !== surface) return false;
        }
        const s = this.snapshot(surface, true);
        const expectedId = token.activeId === undefined ? candidate.snapshot.activePaneId : token.activeId;
        const expectedRevision = token.focusRevision ?? candidate.snapshot.focusRevision;
        return paneHoverSnapshotAllowsFocus({ ...s, samePane: false })
          && samePaneHoverTarget(s.target, candidate.snapshot.target) && s.activePaneId === expectedId
          && s.focusRevision === expectedRevision && s.layoutRevision === candidate.snapshot.layoutRevision
          && s.zoomedPaneId === candidate.snapshot.zoomedPaneId && s.blockerRevision === candidate.snapshot.blockerRevision;
      } catch {
        return false;
      }
    };
    token.focusGuard = guard;
    if (!guard()) { this.killToken(); return; }
    const recordCommit = () => {
      const ui = useUiStore.getState();
      token.activeId = ui.activePaneId; token.focusRevision = ui.focusRevision;
      if (ui.activePaneId !== candidate.snapshot.target?.sessionId) this.killToken();
      else token.phase = "committed";
    };
    const commitHoverSelection = (commit: () => void) => {
      if (!guard()) return;
      this.committing = true;
      try { commit(); recordCommit(); }
      finally { this.committing = false; }
    };
    this.committing = true;
    try { surface.current().onActivate(guard, commitHoverSelection, () => { if (this.owned === token) this.killToken(); }); }
    finally { this.committing = false; }
    // Launcher claims synchronously. Terminal remains owned by A until focus is acquired.
    if (useUiStore.getState().activePaneId === candidate.snapshot.target?.sessionId) recordCommit();
  }

  private killToken(): void {
    const token = this.owned;
    if (!token) return;
    token.valid = false;
    this.owned = undefined;
    if (token.focusGuard) focusController.cancelHoverFocus(token.focusGuard);
  }
  private clearTimer(): void {
    if (this.timer !== undefined) this.doc.defaultView!.clearTimeout(this.timer);
    this.timer = undefined;
  }
  private invalidate(type: "invalidate" | "down" | "up" | "cancel" | "blur" | "focus" | "visibility"
    | "compositionstart" | "compositionend" | "focuschange" = "invalidate"): void {
    this.killToken(); this.send({ type });
  }
}

const runtimes = new WeakMap<Document, PaneHoverRuntime>();

/** Registration only: click mode allocates no hover runtime resources. */
export function usePaneHoverFocus(ref: RefObject<HTMLElement | null>, registration: PaneHoverRegistration): boolean {
  const mode = useSettingsStore((s) => s.paneFocusMode);
  const latest = useRef(registration); latest.current = registration;
  const enabled = registration.enabled && mode === "hover";
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element || !element.closest("[data-dnd-pane-id]")) return;
    const doc = element.ownerDocument;
    let runtime = runtimes.get(doc);
    if (!runtime) { runtime = new PaneHoverRuntime(doc); runtimes.set(doc, runtime); }
    return runtime.register({ element, current: () => latest.current });
  }, [ref, enabled, registration.workspaceId, registration.paneId, registration.tabId, registration.sessionId, registration.kind]);
  return enabled;
}
