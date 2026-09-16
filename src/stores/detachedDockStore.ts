import { create } from "zustand";
import { listen, emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow, getAllWindows } from "@tauri-apps/api/window";
import { useWorkspaceListStore } from "./workspaceListStore";
import { resolveTabInsertionIndex } from "./paneDragStore";
import { resolvePaneDropZone } from "../lib/paneHandoff";
import type { DetachedReturnTarget } from "../lib/detachedPane";
import { WINDOW_REGISTRY_CHANGED_EVENT } from "../lib/ipc";

export const DETACHED_DOCK_REQUEST_EVENT = "mycmux://detached-dock-request";

export const DETACHED_DRAG_EVENT = "mycmux://detached-drag";
export interface DetachedDragPayload {
  label: string;
  workspaceId: string;
  sessionId: string;
  tabId: string;
  screenX: number;
  screenY: number;
  phase: "start" | "move" | "end" | "cancel";
}

export const WINDOW_DRAG_EVENT = "mycmux://window-drag";

/**
 * A cursor position sampled by the backend while the window manager moves a
 * window. No pointer events reach the page during an OS move, so this is the
 * only way the drag stays visible to the app.
 */
export interface WindowDragSample {
  x: number;
  y: number;
  done: boolean;
}
export type DockTarget =
  | { kind: "tab-index"; workspaceId: string; paneId: string; index: number }
  | Extract<DetachedReturnTarget, { kind: "pane-zone" | "workspace" }>;
export interface DockGeometry { x: number; y: number; scale: number }

export function detachedDockTarget(
  point: Pick<DetachedDragPayload, "screenX" | "screenY">,
  geometry: DockGeometry,
  doc: Document = document,
): DockTarget | null {
  const x = point.screenX - geometry.x / geometry.scale;
  const y = point.screenY - geometry.y / geometry.scale;
  const width = doc.defaultView?.innerWidth ?? doc.documentElement.clientWidth;
  const height = doc.defaultView?.innerHeight ?? doc.documentElement.clientHeight;
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const element = doc.elementFromPoint(x, y);
  if (element?.closest('[data-dnd-new-workspace-target="true"]')) return { kind: "workspace" };
  const strip = element?.closest<HTMLElement>(".pane-tabbar");
  const pane = element?.closest<HTMLElement>("[data-dnd-pane-id][data-dnd-workspace-id]");
  const workspaceId = pane?.dataset.dndWorkspaceId;
  const paneId = pane?.dataset.dndPaneId;
  if (!pane || !workspaceId || !paneId) return null;
  if (strip) {
    const spans = Array.from(strip.querySelectorAll<HTMLElement>("[data-tab-id]"))
      .map((tab) => tab.getBoundingClientRect());
    return { kind: "tab-index", workspaceId, paneId, index: resolveTabInsertionIndex(spans, x) };
  }
  return { kind: "pane-zone", workspaceId, paneId,
    zone: resolvePaneDropZone(pane.getBoundingClientRect(), x, y) };
}

interface DetachedDockState {
  active: { label: string; workspaceId: string } | null;
  target: DockTarget | null;
  setTarget: (target: DockTarget | null) => void;
  clear: () => void;
}
export const useDetachedDockStore = create<DetachedDockState>((set, get) => ({
  active: null,
  target: null,
  setTarget: (target) => {
    const previous = get().target;
    if (previous === target || (previous?.kind === "workspace" && target?.kind === "workspace")
      || (previous && target && previous.kind !== "workspace" && target.kind !== "workspace"
      && previous.workspaceId === target.workspaceId
      && previous.paneId === target.paneId
      && ((previous.kind === "tab-index" && target.kind === "tab-index" && previous.index === target.index)
        || (previous.kind === "pane-zone" && target.kind === "pane-zone" && previous.zone === target.zone)))) return;
    set({ target });
  },
  clear: () => {
    if (get().active || get().target) set({ active: null, target: null });
  },
}));

const pending = new Map<string, DetachedReturnTarget>();
export function takeDetachedPlacements(workspaceIds: string[]): Record<string, DetachedReturnTarget> {
  const placements: Record<string, DetachedReturnTarget> = {};
  for (const id of workspaceIds) {
    const target = pending.get(id);
    if (target) placements[id] = target;
    pending.delete(id);
  }
  return placements;
}

/** Geometry is sampled once per drag; handoff is separate from native close. */
export function listenForDetachedDock(): () => void {
  const receiver = getCurrentWindow();
  let disposed = false;
  let generation = 0;
  let geometry: Promise<DockGeometry | null> | null = null;
  let latest: DetachedDragPayload | null = null;
  let frame: number | null = null;
  const clear = () => {
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    generation++;
    geometry = null;
    latest = null;
    useDetachedDockStore.getState().clear();
  };
  const handle = (payload: DetachedDragPayload) => {
    if (disposed || payload.label === receiver.label) return;
    if (payload.phase === "start") {
      clear();
      useDetachedDockStore.setState({ active: { label: payload.label, workspaceId: payload.workspaceId } });
      const current = generation;
      geometry = Promise.all([receiver.outerPosition(), receiver.scaleFactor()])
        .then(([outer, scale]) => ({ x: outer.x, y: outer.y, scale }))
        .catch((error) => {
          if (!disposed && current === generation) clear();
          console.warn("[detached-dock] Failed to read geometry:", error);
          return null;
        });
    } else {
      const active = useDetachedDockStore.getState().active;
      if (active?.label !== payload.label || active.workspaceId !== payload.workspaceId) return;
    }
    if (payload.phase === "cancel") { clear(); return; }
    if (latest?.phase === "end") return;
    latest = payload;
    if (frame === null) {
      frame = window.requestAnimationFrame(() => {
        frame = null;
        void flush();
      });
    }
  };
  const flush = async () => {
    const payload = latest;
    if (!payload) return;
    const current = generation;
    try {
      const bounds = await geometry;
      if (!bounds || disposed || current !== generation || latest !== payload) return;
      const hit = detachedDockTarget(payload, bounds);
      const owned = useWorkspaceListStore.getState().workspaces;
      const target = hit && (hit.kind === "workspace" || owned.some((workspace) => workspace.id === hit.workspaceId
        && workspace.panes.some((pane) => pane.id === hit.paneId))) ? hit : null;
      useDetachedDockStore.getState().setTarget(target);
      if (payload.phase !== "end") return;
      clear();
      if (!target) return;
      // Record placement before the source publishes and releases its workspace.
      const placement: DetachedReturnTarget = target.kind === "tab-index"
        ? { ...target, kind: "pane" } : target;
      pending.set(payload.workspaceId, placement);
      try {
        await emitTo(payload.label, DETACHED_DOCK_REQUEST_EVENT, {
          toLabel: receiver.label, workspaceId: payload.workspaceId,
        });
      } catch (error) {
        if (pending.get(payload.workspaceId) === placement) pending.delete(payload.workspaceId);
        throw error;
      }
    } catch (error) {
      if (current === generation) clear();
      console.warn("[detached-dock] Failed to handle drag:", error);
    }
  };
  const dragListener = listen<DetachedDragPayload>(DETACHED_DRAG_EVENT, (event) => { void handle(event.payload); });
  const registryListener = listen(WINDOW_REGISTRY_CHANGED_EVENT, () => {
    const current = generation;
    const active = useDetachedDockStore.getState().active;
    if (!active) return;
    void getAllWindows().then((windows) => {
      if (!disposed && current === generation && !windows.some((window) => window.label === active.label)) clear();
    }).catch((error) => console.warn("[detached-dock] Failed to check child:", error));
  });
  return () => {
    disposed = true;
    clear();
    void dragListener.then((unlisten) => unlisten()).catch(() => {});
    void registryListener.then((unlisten) => unlisten()).catch(() => {});
  };
}
