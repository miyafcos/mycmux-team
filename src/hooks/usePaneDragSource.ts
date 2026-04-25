import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import {
  usePaneDragStore,
  type PaneDragItem,
  type PaneDropTarget,
  type PaneDropZone,
} from "../stores/paneDragStore";
import { useUiStore } from "../stores/uiStore";
import { useWorkspaceLayoutStore } from "../stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";

const DRAG_THRESHOLD_PX = 5;
const WORKSPACE_HOVER_DELAY_MS = 350;

function getDropZone(rect: DOMRect, x: number, y: number): PaneDropZone {
  const horizontalBand = Math.min(88, Math.max(32, rect.width * 0.22));
  const verticalBand = Math.min(76, Math.max(28, rect.height * 0.22));
  const distances = [
    { zone: "left" as const, value: x - rect.left, limit: horizontalBand },
    { zone: "right" as const, value: rect.right - x, limit: horizontalBand },
    { zone: "up" as const, value: y - rect.top, limit: verticalBand },
    { zone: "down" as const, value: rect.bottom - y, limit: verticalBand },
  ].sort((a, b) => a.value - b.value);

  const nearest = distances[0];
  return nearest.value <= nearest.limit ? nearest.zone : "center";
}

function getFocusSessionId(item: PaneDragItem): string | null {
  const workspace = useWorkspaceListStore.getState().getWorkspace(item.workspaceId);
  const pane = workspace?.panes.find((candidate) => candidate.id === item.paneId);
  if (!pane) return null;
  if (item.kind === "tab") {
    return pane.tabs.find((tab) => tab.id === item.tabId)?.sessionId ?? null;
  }
  const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0];
  return activeTab?.sessionId ?? pane.sessionId;
}

function canDropTarget(item: PaneDragItem, target: PaneDropTarget): boolean {
  const listState = useWorkspaceListStore.getState();
  const sourceWorkspace = listState.getWorkspace(item.workspaceId);
  if (!sourceWorkspace) return false;

  const sourcePane = sourceWorkspace.panes.find((pane) => pane.id === item.paneId);
  if (!sourcePane) return false;

  if (target.kind === "new-workspace") {
    return item.kind === "pane" || sourcePane.tabs.some((tab) => tab.id === item.tabId);
  }

  const targetWorkspace = listState.getWorkspace(target.workspaceId);
  if (!targetWorkspace) return false;

  const targetPane = targetWorkspace.panes.find((pane) => pane.id === target.paneId);
  if (!sourcePane || !targetPane) return false;

  if (item.kind === "pane") {
    if (item.workspaceId === target.workspaceId && item.paneId === target.paneId) return false;
    return true;
  }

  const sourceTab = sourcePane.tabs.find((tab) => tab.id === item.tabId);
  if (!sourceTab) return false;

  if (item.workspaceId === target.workspaceId && item.paneId === target.paneId) {
    return target.zone === "center" || sourcePane.tabs.length > 1;
  }

  return true;
}

function resolveDropTargetAtPoint(x: number, y: number, item: PaneDragItem): PaneDropTarget | null {
  const element = document.elementFromPoint(x, y);
  if (element?.closest("[data-dnd-new-workspace-target='true']")) {
    const target = { kind: "new-workspace" as const };
    return canDropTarget(item, target) ? target : null;
  }

  const paneElement = element?.closest<HTMLElement>("[data-dnd-workspace-id][data-dnd-pane-id]");
  if (!paneElement) return null;

  const workspaceId = paneElement.getAttribute("data-dnd-workspace-id");
  const paneId = paneElement.getAttribute("data-dnd-pane-id");
  if (!workspaceId || !paneId) return null;

  const zone = getDropZone(paneElement.getBoundingClientRect(), x, y);
  const target = { kind: "pane" as const, workspaceId, paneId, zone };
  return canDropTarget(item, target) ? target : null;
}

function focusSessionSoon(sessionId: string | null): void {
  if (!sessionId) return;
  window.setTimeout(() => {
    const paneElement = document.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`);
    const textarea = paneElement?.querySelector<HTMLTextAreaElement>("textarea");
    if (textarea) {
      textarea.focus();
    } else {
      paneElement?.focus();
    }
  }, 0);
}

function commitPaneDragDrop(item: PaneDragItem, target: PaneDropTarget | null): void {
  if (!target || !canDropTarget(item, target)) return;

  const focusSessionId = getFocusSessionId(item);
  const layoutStore = useWorkspaceLayoutStore.getState();
  const listStore = useWorkspaceListStore.getState();

  if (target.kind === "new-workspace") {
    const workspaceId = crypto.randomUUID();
    const workspaceName = `Workspace ${listStore.workspaces.length + 1}`;
    const moved = item.kind === "tab"
      ? layoutStore.moveTabToNewWorkspace(
          item.workspaceId,
          item.paneId,
          item.tabId,
          workspaceId,
          workspaceName,
        )
      : layoutStore.movePaneToNewWorkspace(
          item.workspaceId,
          item.paneId,
          workspaceId,
          workspaceName,
        );
    if (!moved) return;
    useWorkspaceListStore.getState().setActiveWorkspace(workspaceId);
    useUiStore.getState().setActivePaneId(focusSessionId);
    focusSessionSoon(focusSessionId);
    return;
  }

  if (item.kind === "tab") {
    if (target.zone === "center") {
      layoutStore.moveTabToPane(
        item.workspaceId,
        item.paneId,
        item.tabId,
        target.workspaceId,
        target.paneId,
      );
    } else {
      layoutStore.moveTabToSplit(
        item.workspaceId,
        item.paneId,
        item.tabId,
        target.workspaceId,
        target.paneId,
        target.zone,
      );
    }
  } else if (target.zone === "center") {
    layoutStore.movePaneToPane(
      item.workspaceId,
      item.paneId,
      target.workspaceId,
      target.paneId,
    );
  } else {
    layoutStore.movePaneToSplit(
      item.workspaceId,
      item.paneId,
      target.workspaceId,
      target.paneId,
      target.zone,
    );
  }

  useWorkspaceListStore.getState().setActiveWorkspace(target.workspaceId);
  useUiStore.getState().setActivePaneId(focusSessionId);
  focusSessionSoon(focusSessionId);
}

export function usePaneDragSource() {
  const suppressClickRef = useRef(false);
  const hoverTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const hoverWorkspaceIdRef = useRef<string | null>(null);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    hoverWorkspaceIdRef.current = null;
    usePaneDragStore.getState().setHoverWorkspaceId(null);
  }, []);

  const updateWorkspaceHover = useCallback((x: number, y: number) => {
    const element = document.elementFromPoint(x, y);
    if (element?.closest("[data-dnd-new-workspace-target='true']")) {
      clearHoverTimer();
      return;
    }
    const workspaceElement = element?.closest<HTMLElement>("[data-dnd-workspace-target-id]");
    const workspaceId = workspaceElement?.getAttribute("data-dnd-workspace-target-id") ?? null;
    const listStore = useWorkspaceListStore.getState();

    if (!workspaceId || workspaceId === listStore.activeWorkspaceId || !listStore.getWorkspace(workspaceId)) {
      clearHoverTimer();
      return;
    }

    usePaneDragStore.getState().setHoverWorkspaceId(workspaceId);
    if (hoverWorkspaceIdRef.current === workspaceId && hoverTimerRef.current) return;

    if (hoverTimerRef.current) {
      window.clearTimeout(hoverTimerRef.current);
    }
    hoverWorkspaceIdRef.current = workspaceId;
    hoverTimerRef.current = window.setTimeout(() => {
      const dragItem = usePaneDragStore.getState().item;
      if (!dragItem) return;
      const latest = useWorkspaceListStore.getState();
      if (latest.getWorkspace(workspaceId)) {
        latest.setActiveWorkspace(workspaceId);
      }
      usePaneDragStore.getState().setHoverWorkspaceId(null);
      hoverTimerRef.current = null;
      hoverWorkspaceIdRef.current = null;
    }, WORKSPACE_HOVER_DELAY_MS);
  }, [clearHoverTimer]);

  const beginPointerDrag = useCallback((event: ReactPointerEvent<HTMLElement>, item: PaneDragItem) => {
    if (event.button !== 0) return;
    const targetElement = event.target as HTMLElement;
    if (targetElement.closest("button, input, textarea, select, [data-dnd-ignore='true']")) return;

    const sourceElement = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;

    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      clearHoverTimer();
      try {
        if (sourceElement.hasPointerCapture(pointerId)) {
          sourceElement.releasePointerCapture(pointerId);
        }
      } catch {
        // Pointer capture can already be released when the source unmounts.
      }
      document.body.style.cursor = "";
    };

    const finishDrag = (nativeEvent: PointerEvent, shouldCommit: boolean) => {
      cleanup();
      if (!dragging) return;
      nativeEvent.preventDefault();
      suppressClickRef.current = true;
      const dragState = usePaneDragStore.getState();
      if (shouldCommit) {
        commitPaneDragDrop(item, dragState.target);
      }
      usePaneDragStore.getState().clearDrag();
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    };

    function handlePointerMove(nativeEvent: PointerEvent) {
      if (nativeEvent.pointerId !== pointerId) return;
      const dx = nativeEvent.clientX - startX;
      const dy = nativeEvent.clientY - startY;
      if (!dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        dragging = true;
        suppressClickRef.current = true;
        try {
          sourceElement.setPointerCapture(pointerId);
        } catch {
          // Non-critical; window listeners still carry the drag.
        }
        document.body.style.cursor = "grabbing";
        usePaneDragStore.getState().beginDrag(item, { x: nativeEvent.clientX, y: nativeEvent.clientY });
      }

      nativeEvent.preventDefault();
      const dragStore = usePaneDragStore.getState();
      dragStore.moveDrag({ x: nativeEvent.clientX, y: nativeEvent.clientY });
      dragStore.setTarget(resolveDropTargetAtPoint(nativeEvent.clientX, nativeEvent.clientY, item));
      updateWorkspaceHover(nativeEvent.clientX, nativeEvent.clientY);
    }

    function handlePointerUp(nativeEvent: PointerEvent) {
      if (nativeEvent.pointerId !== pointerId) return;
      finishDrag(nativeEvent, true);
    }

    function handlePointerCancel(nativeEvent: PointerEvent) {
      if (nativeEvent.pointerId !== pointerId) return;
      finishDrag(nativeEvent, false);
    }

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
  }, [clearHoverTimer, updateWorkspaceHover]);

  useEffect(() => {
    return () => {
      clearHoverTimer();
    };
  }, [clearHoverTimer]);

  return {
    beginPointerDrag,
    shouldSuppressClick: () => suppressClickRef.current,
  };
}
