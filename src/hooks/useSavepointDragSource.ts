import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { joinSavepointFull, joinSavepointSummary } from "../lib/ipc";
import {
  prepareSavepointDropOpen,
  resolveSavepointPaneDropIntent,
  resolveSavepointReleaseDisposition,
  type SavepointReleaseDisposition,
} from "../lib/savepointHandoff";
import {
  commitSavepointPaste,
  resolveLiveAgentTarget,
} from "../lib/savepointHandoffRuntime";
import { onlineStrings } from "../components/online/onlineStrings";
import { resolveSpawnPlan } from "../components/layout/socketCommands";
import { shareSavepointTransfer } from "../lib/savepointTransfer";
import { usePaneDragStore } from "../stores/paneDragStore";
import {
  useSavepointDragStore,
  type SavepointDragItem,
  type SavepointDragOwner,
  type SavepointDropTarget,
  type SavepointSpawnDropTarget,
} from "../stores/savepointDragStore";
import { useToastStore } from "../stores/toastStore";
import { useWorkspaceLayoutStore } from "../stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";

const DRAG_THRESHOLD_PX = 9;
const WORKSPACE_HOVER_DELAY_MS = 350;

function resolveSpawnTarget(
  workspaceId: string,
  paneId: string,
  direction: "left" | "right",
): SavepointSpawnDropTarget | null {
  const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
  if (!workspace?.panes.some((candidate) => candidate.id === paneId)) return null;
  return { mode: "spawn", workspaceId, paneId, direction };
}

function revalidateDropTarget(target: SavepointDropTarget): SavepointDropTarget | null {
  if (target.mode === "export") return target;
  if (target.mode === "spawn") {
    return resolveSpawnTarget(target.workspaceId, target.paneId, target.direction);
  }
  const latest = resolveLiveAgentTarget(target.workspaceId, target.paneId, target.tabId);
  return latest?.sessionId === target.sessionId ? latest : null;
}

interface SavepointDropResolution {
  target: SavepointDropTarget | null;
  onCancelSurface: boolean;
}

function resolveDropAtPoint(x: number, y: number): SavepointDropResolution {
  const element = document.elementFromPoint(x, y);
  if (element?.closest<HTMLElement>("[data-savepoint-export-target='true']")) {
    return { target: { mode: "export" }, onCancelSurface: false };
  }
  if (element?.closest<HTMLElement>("[data-savepoint-drop-cancel='true']")) {
    return { target: null, onCancelSurface: true };
  }
  const pasteChip = element?.closest<HTMLElement>("[data-savepoint-paste-target='true']");
  const pastePane = pasteChip?.closest<HTMLElement>(
    "[data-savepoint-drop-pane='true'][data-dnd-workspace-id][data-dnd-pane-id]",
  );
  const pasteWorkspaceId = pastePane?.getAttribute("data-dnd-workspace-id");
  const pastePaneId = pastePane?.getAttribute("data-dnd-pane-id");
  if (pasteWorkspaceId && pastePaneId) {
    const target = resolveLiveAgentTarget(pasteWorkspaceId, pastePaneId);
    if (target) return { target, onCancelSurface: false };
  }
  const tabElement = element?.closest<HTMLElement>(
    "[data-savepoint-drop-workspace-id][data-savepoint-drop-pane-id][data-savepoint-drop-tab-id]",
  );
  if (tabElement) {
    const workspaceId = tabElement.getAttribute("data-savepoint-drop-workspace-id");
    const paneId = tabElement.getAttribute("data-savepoint-drop-pane-id");
    const tabId = tabElement.getAttribute("data-savepoint-drop-tab-id");
    if (workspaceId && paneId && tabId) {
      const target = resolveLiveAgentTarget(workspaceId, paneId, tabId);
      return {
        target: target ?? resolveSpawnTarget(workspaceId, paneId, "right"),
        onCancelSurface: false,
      };
    }
  }

  const paneElement = element?.closest<HTMLElement>(
    "[data-savepoint-drop-pane='true'][data-dnd-workspace-id][data-dnd-pane-id]",
  );
  if (!paneElement) return { target: null, onCancelSurface: false };
  const workspaceId = paneElement.getAttribute("data-dnd-workspace-id");
  const paneId = paneElement.getAttribute("data-dnd-pane-id");
  if (!workspaceId || !paneId) return { target: null, onCancelSurface: false };
  const pasteTarget = resolveLiveAgentTarget(workspaceId, paneId);
  const intent = resolveSavepointPaneDropIntent(
    paneElement.getBoundingClientRect(),
    x,
    y,
    pasteTarget !== null,
  );
  if (!intent) return { target: null, onCancelSurface: false };
  if (intent.mode === "paste") return { target: pasteTarget, onCancelSurface: false };
  return {
    target: resolveSpawnTarget(workspaceId, paneId, intent.direction),
    onCancelSurface: false,
  };
}

async function commitSavepointDrop(
  item: SavepointDragItem,
  target: SavepointDropTarget,
): Promise<void> {
  if (target.mode === "export") {
    try {
      const result = await shareSavepointTransfer(item.bundleDir, item.label);
      if (result) {
        useToastStore.getState().pushToast(onlineStrings.transferSaved, "info");
      }
    } catch (error) {
      console.error("[mycmux] failed to export dropped savepoint", error);
      useToastStore.getState().pushToast(
        onlineStrings.transferSaveErrorPrefix + String(error),
        "error",
      );
    }
    return;
  }

  if (target.mode === "paste") {
    await commitSavepointPaste(item.bundleDir, target);
    return;
  }

  const initialTarget = revalidateDropTarget(target);
  if (!initialTarget || initialTarget.mode !== "spawn") {
    useToastStore.getState().pushToast(onlineStrings.dragDropTargetGone, "warning");
    return;
  }
  const openingToastId = useToastStore
    .getState()
    .pushToast(onlineStrings.dragDropSpawning, "info");

  try {
    const prepared = await prepareSavepointDropOpen(
      item.bundleDir,
      joinSavepointFull,
      joinSavepointSummary,
    );
    if (prepared.mode === "handoff") {
      console.warn(
        "[mycmux] full resume unavailable for dropped savepoint; falling back to handoff",
        prepared.fullResumeError,
      );
      useToastStore.getState().pushToast(
        onlineStrings.dragDropFullResumeFallback,
        "warning",
      );
    }
    const latestTarget = revalidateDropTarget(initialTarget);
    if (!latestTarget || latestTarget.mode !== "spawn") {
      useToastStore.getState().pushToast(onlineStrings.dragDropTargetGone, "warning");
      return;
    }

    const workspace = useWorkspaceListStore.getState().getWorkspace(latestTarget.workspaceId);
    if (!workspace) {
      useToastStore.getState().pushToast(onlineStrings.dragDropTargetGone, "warning");
      return;
    }
    const beforePaneIds = new Set(workspace.panes.map((pane) => pane.id));
    const paneOptions = prepared.mode === "full"
      ? {
          agentId: prepared.joined.agent_kind === "codex" ? "codex" : "claude-code",
          label: item.label,
          cwd: prepared.joined.resolved_cwd,
          commandArgv: prepared.joined.command_argv,
        }
      : resolveSpawnPlan({
          target: item.sourceAgentKind,
          handoffFromSessionId: item.sourceSessionId,
          handoffFromKind: item.sourceAgentKind,
          label: item.label,
          cwd: prepared.joined.resolved_cwd,
        }, prepared.joined.handoff_path).paneOptions;
    useWorkspaceListStore.getState().setActiveWorkspace(latestTarget.workspaceId);
    const layoutStore = useWorkspaceLayoutStore.getState();
    layoutStore.addPaneToWorkspaceWithOptions(
      latestTarget.workspaceId,
      latestTarget.paneId,
      "right",
      paneOptions,
    );
    const updatedWorkspace = useWorkspaceListStore.getState().getWorkspace(latestTarget.workspaceId);
    const newPanes = updatedWorkspace?.panes.filter((pane) => !beforePaneIds.has(pane.id)) ?? [];
    if (newPanes.length !== 1) throw new Error("savepoint drop could not identify the new pane");
    if (latestTarget.direction === "left") {
      layoutStore.movePaneToSplit(
        latestTarget.workspaceId,
        newPanes[0].id,
        latestTarget.workspaceId,
        latestTarget.paneId,
        "left",
      );
    }
    if (prepared.mode === "full") {
      useToastStore.getState().pushToast(
        prepared.joined.cwd_missing ? onlineStrings.joinCwdMissing : onlineStrings.dragDropResumed,
        prepared.joined.cwd_missing ? "warning" : "info",
      );
    } else {
      useToastStore.getState().pushToast(
        prepared.joined.cwd_missing ? onlineStrings.dragDropCwdMissing : onlineStrings.dragDropSpawned,
        prepared.joined.cwd_missing ? "warning" : "info",
      );
    }
  } catch (error) {
    console.error("[mycmux] failed to use dropped savepoint", error);
    useToastStore.getState().pushToast(
      onlineStrings.dragDropErrorPrefix + String(error),
      "error",
    );
  } finally {
    useToastStore.getState().dismissToast(openingToastId);
  }
}

export function useSavepointDragSource() {
  const suppressClickRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const hoverWorkspaceIdRef = useRef<string | null>(null);
  const dragOwnerRef = useRef<SavepointDragOwner>(Symbol("savepoint-drag-owner"));

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    hoverWorkspaceIdRef.current = null;
    const dragStore = useSavepointDragStore.getState();
    if (dragStore.owner === dragOwnerRef.current) dragStore.setHoverWorkspaceId(null);
  }, []);

  const updateWorkspaceHover = useCallback((x: number, y: number) => {
    if (useSavepointDragStore.getState().owner !== dragOwnerRef.current) return;
    const element = document.elementFromPoint(x, y);
    const workspaceElement = element?.closest<HTMLElement>("[data-dnd-workspace-target-id]");
    const workspaceId = workspaceElement?.getAttribute("data-dnd-workspace-target-id") ?? null;
    const listStore = useWorkspaceListStore.getState();

    if (!workspaceId || workspaceId === listStore.activeWorkspaceId || !listStore.getWorkspace(workspaceId)) {
      clearHoverTimer();
      return;
    }

    useSavepointDragStore.getState().setHoverWorkspaceId(workspaceId);
    if (hoverWorkspaceIdRef.current === workspaceId && hoverTimerRef.current !== null) return;
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);

    hoverWorkspaceIdRef.current = workspaceId;
    hoverTimerRef.current = window.setTimeout(() => {
      const dragStore = useSavepointDragStore.getState();
      hoverTimerRef.current = null;
      hoverWorkspaceIdRef.current = null;
      if (!dragStore.item || dragStore.owner !== dragOwnerRef.current) return;
      const latest = useWorkspaceListStore.getState();
      if (latest.getWorkspace(workspaceId)) latest.setActiveWorkspace(workspaceId);
      dragStore.setHoverWorkspaceId(null);
    }, WORKSPACE_HOVER_DELAY_MS);
  }, [clearHoverTimer]);

  const beginPointerDrag = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    item: SavepointDragItem,
  ) => {
    if (event.button !== 0) return;
    if (usePaneDragStore.getState().item) return;
    if (useSavepointDragStore.getState().item) return;
    const targetElement = event.target as HTMLElement;
    const dragHandle = targetElement.closest("[data-savepoint-drag-handle='true']");
    if (!dragHandle && targetElement.closest("button, input, textarea, select, [data-dnd-ignore='true']")) return;
    if (event.pointerType === "touch" && !dragHandle) return;

    cleanupRef.current?.();
    const sourceElement = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;

    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      window.removeEventListener("keydown", handleKeyDown, true);
      clearHoverTimer();
      try {
        if (sourceElement.hasPointerCapture(pointerId)) sourceElement.releasePointerCapture(pointerId);
      } catch {
        // The source can unmount after workspace hover switching.
      }
      document.body.style.cursor = "";
      if (cleanupRef.current === cleanup) cleanupRef.current = null;
    };

    const releaseClickSuppressionAfterPointerEnd = () => {
      let fallbackTimer = 0;
      const release = () => {
        window.removeEventListener("pointerup", handleRelease, true);
        window.removeEventListener("pointercancel", handleRelease, true);
        if (fallbackTimer) window.clearTimeout(fallbackTimer);
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      };
      const handleRelease = (releaseEvent: PointerEvent) => {
        if (releaseEvent.pointerId !== pointerId) return;
        release();
      };
      window.addEventListener("pointerup", handleRelease, true);
      window.addEventListener("pointercancel", handleRelease, true);
      fallbackTimer = window.setTimeout(release, 3000);
    };

    const finishDrag = (
      disposition: SavepointReleaseDisposition,
      nativeEvent?: Event,
      waitForPointerEnd = false,
    ) => {
      cleanup();
      if (!dragging) return;
      nativeEvent?.preventDefault();
      const dragState = useSavepointDragStore.getState();
      if (dragState.owner !== dragOwnerRef.current || !dragState.item) return;
      suppressClickRef.current = true;
      const droppedItem = dragState.item;
      const droppedTarget = dragState.target;
      dragState.clearDrag(dragOwnerRef.current);
      if (disposition === "commit") {
        if (droppedTarget) {
          void commitSavepointDrop(droppedItem, droppedTarget);
        } else {
          useToastStore.getState().pushToast(onlineStrings.dragDropInvalidTarget, "warning");
        }
      } else if (disposition === "invalid") {
        useToastStore.getState().pushToast(onlineStrings.dragDropInvalidTarget, "warning");
      }
      if (waitForPointerEnd) {
        releaseClickSuppressionAfterPointerEnd();
      } else {
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
    };

    function handlePointerMove(nativeEvent: PointerEvent) {
      if (nativeEvent.pointerId !== pointerId) return;
      const dx = nativeEvent.clientX - startX;
      const dy = nativeEvent.clientY - startY;
      if (!dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        if (usePaneDragStore.getState().item) {
          cleanup();
          return;
        }
        const dragStore = useSavepointDragStore.getState();
        if (!dragStore.beginDrag(item, {
          x: nativeEvent.clientX,
          y: nativeEvent.clientY,
        }, dragOwnerRef.current)) {
          cleanup();
          return;
        }
        dragging = true;
        suppressClickRef.current = true;
        try {
          sourceElement.setPointerCapture(pointerId);
        } catch {
          // Window listeners still carry the drag if pointer capture fails.
        }
        document.body.style.cursor = "grabbing";
      }

      nativeEvent.preventDefault();
      const dragStore = useSavepointDragStore.getState();
      if (dragStore.owner !== dragOwnerRef.current) {
        cleanup();
        return;
      }
      dragStore.moveDrag({ x: nativeEvent.clientX, y: nativeEvent.clientY });
      dragStore.setTarget(resolveDropAtPoint(nativeEvent.clientX, nativeEvent.clientY).target);
      updateWorkspaceHover(nativeEvent.clientX, nativeEvent.clientY);
    }

    function handlePointerUp(nativeEvent: PointerEvent) {
      if (nativeEvent.pointerId !== pointerId) return;
      const release = resolveDropAtPoint(nativeEvent.clientX, nativeEvent.clientY);
      const dragStore = useSavepointDragStore.getState();
      if (dragStore.owner === dragOwnerRef.current) dragStore.setTarget(release.target);
      finishDrag(
        resolveSavepointReleaseDisposition(release.onCancelSurface, release.target !== null),
        nativeEvent,
      );
    }

    function handlePointerCancel(nativeEvent: PointerEvent) {
      if (nativeEvent.pointerId === pointerId) finishDrag("cancel", nativeEvent);
    }

    function handleKeyDown(nativeEvent: KeyboardEvent) {
      if (nativeEvent.key === "Escape") finishDrag("cancel", nativeEvent, true);
    }

    cleanupRef.current = cleanup;
    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    window.addEventListener("keydown", handleKeyDown, true);
  }, [clearHoverTimer, updateWorkspaceHover]);

  useEffect(() => () => {
    cleanupRef.current?.();
    useSavepointDragStore.getState().clearDrag(dragOwnerRef.current);
  }, []);

  return {
    beginPointerDrag,
    shouldSuppressClick: () => suppressClickRef.current,
  };
}
