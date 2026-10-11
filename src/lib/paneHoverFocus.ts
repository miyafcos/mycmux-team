import type { PaneFocusMode } from "../stores/settingsStore";

export const PANE_HOVER_FOCUS_DWELL_MS = 100;

export interface PaneHoverTarget {
  workspaceId: string;
  paneId: string;
  tabId: string;
  sessionId: string;
  surface: object;
  kind: "terminal" | "launcher";
}

/** The runtime supplies facts; the reducer never reads DOM, stores or a clock. */
export interface PaneHoverSnapshot {
  mode: PaneFocusMode;
  target: PaneHoverTarget | null;
  activePaneId: string | null;
  focusRevision: number;
  layoutRevision: number;
  zoomedPaneId: string | null;
  blockerRevision: number;
  windowFocused: boolean;
  documentVisible: boolean;
  connected: boolean;
  visible: boolean;
  samePane: boolean;
  dragging: boolean;
  captured: boolean;
  blocked: boolean;
  editorFocused: boolean;
  selected: boolean;
}

export interface PaneHoverCandidate {
  snapshot: PaneHoverSnapshot;
  startedAt: number;
  generation: number;
}

export interface PaneHoverState {
  pointer: { id: number; x: number; y: number } | null;
  inside: object | null;
  down: boolean;
  ime: "known" | "unknown" | "composing";
  generation: number;
  candidate: PaneHoverCandidate | null;
}

export type PaneHoverEvent =
  | { type: "move"; now: number; snapshot: PaneHoverSnapshot; pointerId: number;
      x: number; y: number; movementX?: number; movementY?: number;
      pointerType: string; buttons: number; modified: boolean }
  | { type: "dwell"; now: number; snapshot: PaneHoverSnapshot }
  | { type: "enter" | "leave"; surface: object | null }
  | { type: "down" | "up" | "cancel" | "blur" | "focus" | "visibility" | "invalidate"
      | "compositionstart" | "compositionend" | "focuschange" }
  | { type: "key"; composing: boolean };

export type PaneHoverEffect =
  | { type: "none" | "cancel" }
  | { type: "arm"; candidate: PaneHoverCandidate }
  | { type: "activate"; candidate: PaneHoverCandidate };

export function createPaneHoverState(ime: PaneHoverState["ime"] = "known"): PaneHoverState {
  return { pointer: null, inside: null, down: false, ime, generation: 0, candidate: null };
}

export function samePaneHoverTarget(a: PaneHoverTarget | null, b: PaneHoverTarget | null): boolean {
  return !!a && !!b && a.surface === b.surface && a.workspaceId === b.workspaceId
    && a.paneId === b.paneId && a.tabId === b.tabId && a.sessionId === b.sessionId && a.kind === b.kind;
}

export function paneHoverSnapshotAllowsFocus(s: PaneHoverSnapshot): boolean {
  return s.mode === "hover" && !!s.target && s.windowFocused && s.documentVisible
    && s.connected && s.visible && !s.samePane && !s.dragging && !s.captured
    && !s.blocked && !s.editorFocused && !s.selected;
}

function unchangedCandidate(a: PaneHoverSnapshot, b: PaneHoverSnapshot): boolean {
  return samePaneHoverTarget(a.target, b.target) && a.activePaneId === b.activePaneId
    && a.focusRevision === b.focusRevision && a.layoutRevision === b.layoutRevision
    && a.zoomedPaneId === b.zoomedPaneId && a.blockerRevision === b.blockerRevision;
}

export function decidePaneHoverFocus(state: PaneHoverState, event: PaneHoverEvent): {
  state: PaneHoverState; effect: PaneHoverEffect;
} {
  const cancel = (patch: Partial<PaneHoverState> = {}) => ({
    state: { ...state, ...patch, candidate: null, generation: state.generation + 1 },
    effect: { type: "cancel" } as PaneHoverEffect,
  });
  switch (event.type) {
    case "compositionstart": return cancel({ ime: "composing" });
    case "compositionend":
    case "focuschange": return cancel({ ime: "known" });
    // Keyboard fallback is uncertain evidence; only compositionstart establishes a live composition.
    case "key": return cancel({ ime: state.ime === "composing" ? "composing" : event.composing ? "unknown" : "known" });
    case "down": return cancel({ down: true });
    case "up":
    case "cancel":
    case "blur": return cancel({ down: false });
    case "focus":
    case "visibility":
    case "invalidate": return cancel();
    case "enter":
      return state.candidate && state.inside !== event.surface
        ? cancel({ inside: event.surface })
        : { state: { ...state, inside: event.surface }, effect: { type: "none" } };
    case "leave":
      return event.surface === state.inside ? cancel({ inside: null }) : { state, effect: { type: "none" } };
    case "dwell": {
      const c = state.candidate;
      if (!c) return { state, effect: { type: "none" } };
      if (state.down || state.ime !== "known" || state.inside !== c.snapshot.target?.surface
        || !paneHoverSnapshotAllowsFocus(event.snapshot) || !unchangedCandidate(c.snapshot, event.snapshot)) {
        return cancel();
      }
      if (event.now - c.startedAt < PANE_HOVER_FOCUS_DWELL_MS) return { state, effect: { type: "none" } };
      return { state: { ...state, candidate: null }, effect: { type: "activate", candidate: c } };
    }
    case "move": {
      const pointer = { id: event.pointerId, x: event.x, y: event.y };
      const inside = event.snapshot.target?.surface ?? null;
      const previous = state.pointer;
      const moved = previous?.id === pointer.id
        ? previous.x !== pointer.x || previous.y !== pointer.y
        : !!(event.movementX || event.movementY);
      const eligible = event.pointerType === "mouse" && event.buttons === 0 && !event.modified
        && !state.down && state.ime === "known" && paneHoverSnapshotAllowsFocus(event.snapshot);
      if (!eligible) return cancel({ pointer, inside });
      const c = state.candidate;
      if (c && unchangedCandidate(c.snapshot, event.snapshot)) {
        return { state: { ...state, pointer, inside }, effect: { type: "none" } };
      }
      if (!moved) return c ? cancel({ pointer, inside }) : { state: { ...state, pointer, inside }, effect: { type: "none" } };
      const generation = state.generation + 1;
      const candidate = { snapshot: event.snapshot, startedAt: event.now, generation };
      return { state: { ...state, pointer, inside, generation, candidate }, effect: { type: "arm", candidate } };
    }
  }
}
