import { usePaneDragStore, type PaneDragItem } from "../../stores/paneDragStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { nativePaneTearoutEnabled } from "./feature";
import { isDetachableTab, isTransferableTab } from "../detachedPane";
import { outsideTearoutStrip } from "./model";
import { tearoutTab, tearoutPane, tearoutWorkspace, canRegrabTearoutTab, canRegrabTearoutPane, regrabTearoutWindow } from "./runtime";
import { TearoutRecord } from "./record";
import { windowLabel } from "../windowContext";
import { afterTearoutFrame } from "./macFrame";

export function usesNativePaneDrag(item: PaneDragItem): boolean {
  if (!nativePaneTearoutEnabled(useSettingsStore.getState().nativePaneTearoutEnabled)
    || item.kind !== "tab" || item.surface === "minimap") return false;
  const tab = useWorkspaceListStore.getState().getWorkspace(item.workspaceId)?.panes
    .find((pane) => pane.id === item.paneId)?.tabs.find((tab) => tab.id === item.tabId);
  return Boolean(tab && isDetachableTab(tab));
}

interface DragCallbacks { suppress: (value: boolean) => void; resolve: (x: number, y: number) => void; commit: () => void }
export function usesNativeGroupDrag(item: PaneDragItem): boolean {
  if (!nativePaneTearoutEnabled(useSettingsStore.getState().nativePaneTearoutEnabled)
    || item.kind !== "pane" || item.surface === "minimap") return false;
  const pane = useWorkspaceListStore.getState().getWorkspace(item.workspaceId)?.panes.find(pane => pane.id === item.paneId);
  return Boolean(pane?.tabs.length && pane.tabs.every(isTransferableTab));
}
export function usesNativeWorkspaceDrag(workspaceId: string): boolean {
  const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
  return nativePaneTearoutEnabled(useSettingsStore.getState().nativePaneTearoutEnabled)
    && Boolean(workspace?.panes.length && workspace.panes.every(pane => pane.tabs.length && pane.tabs.every(isTransferableTab)));
}
export function beginNativePaneDrag(event: PointerEvent, element: HTMLElement,
  item: Extract<PaneDragItem, { kind: "tab" }>,
  callbacks: DragCallbacks): void {
  beginNativeRegionDrag(event, element, item, callbacks);
}
export function beginNativeGroupDrag(event: PointerEvent, element: HTMLElement,
  item: Extract<PaneDragItem, { kind: "pane" }>, callbacks: DragCallbacks): void {
  beginNativeRegionDrag(event, element, item, callbacks);
}
function beginNativeRegionDrag(event: PointerEvent, element: HTMLElement,
  item: Extract<PaneDragItem, { kind: "tab" | "pane" }>, callbacks: DragCallbacks): void {
  const strip = element.closest<HTMLElement>(".pane-tabbar");
  if (!strip) return;
  const bounds = strip.getBoundingClientRect();
  const grip = element.getBoundingClientRect();
  const gap = { x: grip.x, y: grip.y, width: grip.width, height: grip.height };
  const downAt = Date.now();
  let record: TearoutRecord | null = null;
  let dragging = false;
  let handed = false;
  let cancelFrame: (() => void) | null = null;
  let latest: { x: number; y: number } | null = null;
  const cleanup = () => {
    cancelFrame?.(); cancelFrame = null; latest = null;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("blur", cancel);
    try { if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId); } catch { /* Unmounted source. */ }
    document.body.style.cursor = "";
    try {
      usePaneDragStore.getState().clearDrag();
    } finally {
      window.setTimeout(() => callbacks.suppress(false), 0);
    }
  };
  function move(next: PointerEvent) {
    if (next.pointerId !== event.pointerId || handed) return;
    if (!dragging && Math.hypot(next.clientX - event.clientX, next.clientY - event.clientY) < 9) return;
    if (!dragging) {
      dragging = true;
      record = new TearoutRecord(crypto.randomUUID(), item.kind === "tab" ? item.tabId : item.paneId, windowLabel(), downAt,
        item.kind === "tab" ? "pane" : "tab", item.kind === "tab" ? 1 : item.tabCount);
      callbacks.suppress(true);
      try { element.setPointerCapture(event.pointerId); } catch { /* Window listeners remain active. */ }
      document.body.style.cursor = "grabbing";
      usePaneDragStore.getState().beginDrag(item, { x: next.clientX, y: next.clientY });
    }
    next.preventDefault();
    if (item.kind === "tab" ? canRegrabTearoutTab(item) : canRegrabTearoutPane(item)) {
      handed = true;
      cleanup();
      void regrabTearoutWindow(record!).catch((error) => console.warn("[tearout] regrab failed", error));
      return;
    }
    if (outsideTearoutStrip(next.clientX, next.clientY, bounds)) {
      handed = true;
      record!.outside(Date.now());
      // Release capture before asking Tauri to enter the native move loop.
      cleanup();
      const offset = { x: event.clientX - grip.x, y: event.clientY - bounds.y };
      void (item.kind === "tab" ? tearoutTab(item, gap, offset, record!) : tearoutPane(item, gap, offset, record!))
        .catch((error) => {
          record!.error("unexpected_failure");
          void record!.finish("failed_restored").catch(() => {});
          console.warn("[tearout] pane transfer failed", error);
        });
      return;
    }
    latest = { x: next.clientX, y: next.clientY };
    if (!cancelFrame) cancelFrame = afterTearoutFrame(() => {
      cancelFrame = null;
      const point = latest; latest = null;
      if (!point || handed) return;
      usePaneDragStore.getState().moveDrag(point);
      callbacks.resolve(point.x, point.y);
    });
  }
  function up(next: PointerEvent) {
    if (next.pointerId !== event.pointerId || handed) return;
    try {
      if (dragging) { callbacks.resolve(next.clientX, next.clientY); callbacks.commit(); }
    } finally {
      cleanup();
      void record?.finish("reordered").catch((error) => console.warn("[tearout] log failed", error));
    }
  }
  function cancel() {
    if (handed) return;
    cleanup();
    void record?.finish("cancelled_before_tearout").catch((error) => console.warn("[tearout] log failed", error));
  }
  function key(next: KeyboardEvent) { if (next.key === "Escape") { next.preventDefault(); cancel(); } }
  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key, true);
  window.addEventListener("blur", cancel);
}

/** Vertical sidebar movement remains a reorder; crossing its outer boundary tears out. */
export function beginNativeWorkspaceDrag(event: PointerEvent, element: HTMLElement, workspaceId: string, callbacks: DragCallbacks): void {
  const sidebar = element.closest<HTMLElement>('[data-dnd-workspace-sidebar="true"]');
  if (!sidebar) return;
  const bounds = sidebar.getBoundingClientRect();
  const grip = element.getBoundingClientRect();
  const gap = { x: grip.x, y: grip.y, width: grip.width, height: grip.height };
  const downAt = Date.now();
  let record: TearoutRecord | null = null;
  let dragging = false;
  let handed = false;
  let cancelFrame: (() => void) | null = null;
  let latest: { x: number; y: number } | null = null;
  const cleanup = () => {
    cancelFrame?.(); cancelFrame = null; latest = null;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("blur", cancel);
    try { if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId); } catch { /* Removed source. */ }
    document.body.style.cursor = "";
    window.setTimeout(() => callbacks.suppress(false), 0);
  };
  function move(next: PointerEvent) {
    if (next.pointerId !== event.pointerId || handed) return;
    if (!dragging && Math.hypot(next.clientX - event.clientX, next.clientY - event.clientY) < 9) return;
    if (!dragging) {
      dragging = true;
      const count = useWorkspaceListStore.getState().getWorkspace(workspaceId)?.panes.reduce((count, pane) => count + pane.tabs.length, 0) ?? 0;
      record = new TearoutRecord(crypto.randomUUID(), workspaceId, windowLabel(), downAt, "workspace", count);
      callbacks.suppress(true);
      try { element.setPointerCapture(event.pointerId); } catch { /* Window listeners remain active. */ }
      document.body.style.cursor = "grabbing";
    }
    next.preventDefault();
    if (outsideTearoutStrip(next.clientX, next.clientY, bounds)) {
      handed = true;
      record!.outside(Date.now());
      cleanup();
      void tearoutWorkspace(workspaceId, gap, { x: event.clientX - grip.x, y: event.clientY - grip.y }, record!)
        .catch(error => {
          record!.error("unexpected_failure");
          void record!.finish("failed_restored").catch(() => {});
          console.warn("[tearout] workspace transfer failed", error);
        });
      return;
    }
    latest = { x: next.clientX, y: next.clientY };
    if (!cancelFrame) cancelFrame = afterTearoutFrame(() => {
      cancelFrame = null;
      const point = latest; latest = null;
      if (point && !handed) callbacks.resolve(point.x, point.y);
    });
  }
  function up(next: PointerEvent) {
    if (next.pointerId !== event.pointerId || handed) return;
    try {
      if (dragging) { callbacks.resolve(next.clientX, next.clientY); callbacks.commit(); }
    } finally {
      cleanup();
      void record?.finish("reordered").catch(error => console.warn("[tearout] log failed", error));
    }
  }
  function cancel() {
    if (handed) return;
    cleanup();
    void record?.finish("cancelled_before_tearout").catch(error => console.warn("[tearout] log failed", error));
  }
  function key(next: KeyboardEvent) { if (next.key === "Escape") { next.preventDefault(); cancel(); } }
  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key, true);
  window.addEventListener("blur", cancel);
}
