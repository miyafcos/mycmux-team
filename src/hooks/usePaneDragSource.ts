import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import {
  resolveTabInsertionIndex,
  samePaneDropTarget,
  usePaneDragStore,
  type PaneDragItem,
  type PaneDropTarget,
} from "../stores/paneDragStore";
import { useWorkspaceLayoutStore } from "../stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";
import { useSavepointDragStore } from "../stores/savepointDragStore";
import { focusController } from "../lib/focusController";
import { detachedOriginForDrag, isTransferableTab } from "../lib/detachedPane";
import { isOutsideWindowViewport } from "../lib/windowEdge";
import { tearoutOperationBusy } from "../lib/tearout/operation";
import { recoveryBusy } from "../lib/tearout/recoveryNotice";
import {
  isPaneDropTargetEligible,
  prioritizePaneHandoffDropTarget,
  resolvePaneDropZone,
} from "../lib/paneHandoff";
import { capturePaneHandoffSource, resolvePaneHandoffContext as resolveHandoffContext,
  commitPaneHandoffContext } from "../lib/paneHandoffRuntime";
import { paneDndStrings } from "../components/workspace/paneDndStrings";
import { useToastStore } from "../stores/toastStore";
import { createPaneMoveRequest, executePaneMove } from "../lib/paneMoveOperation";
import { layoutStructureRevision } from "../lib/layoutMutation";
import { resolveMinimapDropZone } from "../components/dashboard/minimapModel";
import { beginNativePaneDrag, usesNativePaneDrag, beginNativeGroupDrag, usesNativeGroupDrag } from "../lib/tearout/pointerDrag";
import { moveMinimapItemToNewWorkspace } from "../components/dashboard/minimapWorkspaceActions";
import {
  TEAR_OUT_DRAG_THRESHOLD_PX,
  createTearOutDragTrace,
  type TearOutDragTrace,
  type TearOutPointerSample,
} from "../lib/tearOutDiagnostics";

const WORKSPACE_HOVER_DELAY_MS = 350;

function tearOutPointerSample(event: Pick<PointerEvent, "clientX" | "clientY" | "screenX" | "screenY">): TearOutPointerSample {
  return {
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  };
}

function clearTearOutMeasurementAfterDelay(): void {
  window.setTimeout(() => usePaneDragStore.getState().setTearOutMeasurement(null), 1_500);
}

function getFocusSessionId(item: PaneDragItem): string | null {
  const workspace = useWorkspaceListStore.getState().getWorkspace(item.workspaceId);
  const pane = workspace?.panes.find((candidate) => candidate.id === item.paneId);
  if (!pane) return null;
  if (item.kind === "tab") {
    return pane.tabs.find((tab) => tab.id === item.tabId)?.sessionId ?? null;
  }
  if (item.kind === "tab-bundle") {
    return pane.tabs.find((tab) => tab.id === item.anchorTabId)?.sessionId ?? null;
  }
  const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0];
  return activeTab?.sessionId ?? pane.sessionId;
}

function resolvePaneHandoffContext(item: PaneDragItem, targetWorkspaceId: string, targetPaneId: string) {
  return resolveHandoffContext(capturePaneHandoffSource(item), targetWorkspaceId, targetPaneId);
}

export function canDropTarget(item: PaneDragItem, target: PaneDropTarget): boolean {
  const listState = useWorkspaceListStore.getState();
  const sourceWorkspace = listState.getWorkspace(item.workspaceId);
  if (!sourceWorkspace) return false;

  const sourcePane = sourceWorkspace.panes.find((pane) => pane.id === item.paneId);
  if (!sourcePane) return false;

  if (target.kind === "new-workspace" || target.kind === "new-window") {
    // A window transfer must carry every selected tab. Unsupported tabs cannot
    // arm the tear-out at all — no banner, no promise, nothing to strand.
    const transferable = (tabId: string) => {
      const tab = sourcePane.tabs.find((candidate) => candidate.id === tabId);
      return tab !== undefined && (target.kind === "new-workspace" || isTransferableTab(tab));
    };
    if (item.kind === "pane") {
      return target.kind === "new-workspace" || sourcePane.tabs.length > 0 && sourcePane.tabs.every(isTransferableTab);
    }
    if (item.kind === "tab") return transferable(item.tabId);
    return target.kind === "new-workspace" ? item.tabIds.some(transferable)
      : item.tabIds.length > 0 && item.tabIds.every(transferable);
  }

  if (target.kind === "handoff") {
    if (item.kind === "tab-bundle") return false;
    return resolvePaneHandoffContext(item, target.workspaceId, target.paneId) !== null;
  }

  if (target.kind === "tab-index") {
    // Reorder is same-pane only. Moving a tab into another pane already has a
    // dedicated target (that pane's center/split zones), and letting the strip
    // be a second cross-pane surface would give one hover two meanings.
    return item.kind === "tab"
      && item.workspaceId === target.workspaceId
      && item.paneId === target.paneId
      && sourcePane.tabs.length >= 2
      && sourcePane.tabs.some((tab) => tab.id === item.tabId);
  }

  const targetWorkspace = listState.getWorkspace(target.workspaceId);
  if (!targetWorkspace) return false;

  const targetPane = targetWorkspace.panes.find((pane) => pane.id === target.paneId);
  if (!sourcePane || !targetPane) return false;

  if (item.kind === "tab" && !sourcePane.tabs.some((tab) => tab.id === item.tabId)) {
    return false;
  }
  if (item.kind === "tab-bundle") {
    const selectedInSource = new Set(item.tabIds);
    const isSourcePane = item.workspaceId === target.workspaceId && item.paneId === target.paneId;
    if (isSourcePane && target.zone !== "center" && sourcePane.tabs.every((tab) => selectedInSource.has(tab.id))) {
      return false;
    }
  }
  return isPaneDropTargetEligible({
    kind: item.kind === "pane" ? "pane" : "tab",
    workspaceId: item.workspaceId,
    paneId: item.paneId,
  }, target, sourcePane.tabs.length);
}

function resolveDropTargetAtPoint(x: number, y: number, item: PaneDragItem): PaneDropTarget | null {
  const element = document.elementFromPoint(x, y);
  if (item.surface === "minimap") {
    if (element?.closest("[data-minimap-new-workspace-target='true']")) {
      const target = { kind: "new-workspace" as const, surface: "minimap" as const };
      return canDropTarget(item, target) ? target : null;
    }
    const paneElement = element?.closest<HTMLElement>("[data-minimap-dnd-workspace-id][data-minimap-dnd-pane-id]");
    const workspaceId = paneElement?.getAttribute("data-minimap-dnd-workspace-id");
    const paneId = paneElement?.getAttribute("data-minimap-dnd-pane-id");
    if (!paneElement || !workspaceId || !paneId) return null;
    const prior = usePaneDragStore.getState().target;
    const previousZone = prior?.kind === "pane"
      && prior.surface === "minimap"
      && prior.workspaceId === workspaceId
      && prior.paneId === paneId
      ? prior.zone
      : "center";
    const target = {
      kind: "pane" as const,
      workspaceId,
      paneId,
      zone: resolveMinimapDropZone(paneElement.getBoundingClientRect(), x, y, previousZone),
      surface: "minimap" as const,
    };
    return canDropTarget(item, target) ? target : null;
  }
  const handoffElement = element?.closest<HTMLElement>("[data-dnd-handoff-target='true']");
  const handoffPaneElement = handoffElement?.closest<HTMLElement>(
    "[data-dnd-workspace-id][data-dnd-pane-id]",
  );
  const handoffWorkspaceId = handoffPaneElement?.getAttribute("data-dnd-workspace-id");
  const handoffPaneId = handoffPaneElement?.getAttribute("data-dnd-pane-id");
  const handoffTarget = handoffWorkspaceId && handoffPaneId
    && resolvePaneHandoffContext(item, handoffWorkspaceId, handoffPaneId)
    ? {
        kind: "handoff" as const,
        workspaceId: handoffWorkspaceId,
        paneId: handoffPaneId,
      }
    : null;

  let fallbackTarget: PaneDropTarget | null = null;
  if (element?.closest("[data-dnd-new-workspace-target='true']")) {
    const target = { kind: "new-workspace" as const };
    fallbackTarget = canDropTarget(item, target) ? target : null;
    return prioritizePaneHandoffDropTarget(Boolean(handoffElement), handoffTarget, fallbackTarget);
  }

  // The tab strip sits inside the pane, so it must be tested before the pane
  // zones: over its own strip a tab drag means "reorder", not "split up".
  const stripElement = element?.closest<HTMLElement>("[data-pane-tab-strip]");
  const stripPaneId = stripElement?.getAttribute("data-pane-tab-strip");
  const stripWorkspaceId = stripElement
    ?.closest<HTMLElement>("[data-dnd-workspace-id]")
    ?.getAttribute("data-dnd-workspace-id");
  if (stripElement && stripPaneId && stripWorkspaceId) {
    const spans = Array.from(
      stripElement.querySelectorAll<HTMLElement>("[data-tab-id]"),
    ).map((pill) => pill.getBoundingClientRect());
    const target = {
      kind: "tab-index" as const,
      workspaceId: stripWorkspaceId,
      paneId: stripPaneId,
      index: resolveTabInsertionIndex(spans, x),
    };
    // Cross-pane and single-tab drags fall through to the pane zones below.
    if (canDropTarget(item, target)) {
      return prioritizePaneHandoffDropTarget(Boolean(handoffElement), handoffTarget, target);
    }
  }

  const paneElement = element?.closest<HTMLElement>("[data-dnd-workspace-id][data-dnd-pane-id]");
  if (!paneElement) {
    return prioritizePaneHandoffDropTarget(Boolean(handoffElement), handoffTarget, null);
  }

  const workspaceId = paneElement.getAttribute("data-dnd-workspace-id");
  const paneId = paneElement.getAttribute("data-dnd-pane-id");
  if (!workspaceId || !paneId) {
    return prioritizePaneHandoffDropTarget(Boolean(handoffElement), handoffTarget, null);
  }

  const prior = usePaneDragStore.getState().target;
  const previousZone = prior?.kind === "pane"
    && prior.surface !== "minimap"
    && prior.workspaceId === workspaceId
    && prior.paneId === paneId
    ? prior.zone
    : "center";
  const zone = resolvePaneDropZone(paneElement.getBoundingClientRect(), x, y, previousZone);
  const target = { kind: "pane" as const, workspaceId, paneId, zone };
  fallbackTarget = canDropTarget(item, target) ? target : null;
  return prioritizePaneHandoffDropTarget(Boolean(handoffElement), handoffTarget, fallbackTarget);
}

function commitMinimapPaneMove(item: PaneDragItem, target: Extract<PaneDropTarget, { kind: "pane" }>): void {
  executePaneMove(createPaneMoveRequest(item, {
    kind: "split", workspaceId: target.workspaceId, paneId: target.paneId, zone: target.zone, atomic: true,
  }));
}

async function commitPaneHandoff(item: PaneDragItem,
  target: Extract<PaneDropTarget, { kind: "handoff" }>): Promise<void> {
  await commitPaneHandoffContext(resolvePaneHandoffContext(item, target.workspaceId, target.paneId));
}

function moveDragItemToNewWorkspace(
  item: PaneDragItem,
  workspaceId: string,
  workspaceName: string,
  options?: { activate?: boolean },
): boolean {
  const layoutStore = useWorkspaceLayoutStore.getState();
  if (item.kind === "tab") {
    return layoutStore.moveTabToNewWorkspace(
      item.workspaceId,
      item.paneId,
      item.tabId,
      workspaceId,
      workspaceName,
      options,
    );
  }
  if (item.kind === "tab-bundle") {
    return layoutStore.moveTabsToNewWorkspace(
      item.workspaceId,
      item.paneId,
      item.tabIds,
      item.anchorTabId,
      workspaceId,
      workspaceName,
      options,
    );
  }
  return layoutStore.movePaneToNewWorkspace(
    item.workspaceId,
    item.paneId,
    workspaceId,
    workspaceName,
    options,
  );
}

function tearOutPaneToNewWindow(
  item: PaneDragItem,
  focusSessionId: string | null,
  target: Extract<PaneDropTarget, { kind: "new-window" }>,
  trace: TearOutDragTrace | null,
): void {
  const detachedFrom = detachedOriginForDrag(useWorkspaceListStore.getState().getWorkspace(item.workspaceId), item);
  trace?.commitPending(item.workspaceId, focusSessionId);
  trace?.windowCreateRequested();
  void executePaneMove(createPaneMoveRequest(item, {
    kind: "window", x: target.screenX - 40, y: target.screenY - 20, detachedFrom,
  })).then((result) => {
    if (result.error !== undefined) throw result.error;
    const label = result.status === "moved" ? result.destinationWindow : undefined;
    if (!label) {
      trace?.failed("transfer-failed", "workspace transfer returned no destination window");
      clearTearOutMeasurementAfterDelay();
      return;
    }
    trace?.windowLabelAccepted(label);
    trace?.sourceDetached();
    trace?.committed();
    clearTearOutMeasurementAfterDelay();
  }).catch((error) => {
    trace?.failed("create-failed", String(error));
    clearTearOutMeasurementAfterDelay();
    console.error("[multiwindow] drag tear-out failed", error);
    if (!(error as { notified?: boolean })?.notified) useToastStore.getState().pushToast("新しいウィンドウを開けませんでした", "error");
  });
}

export function commitPaneDragDrop(
  item: PaneDragItem,
  target: PaneDropTarget | null,
  trace: TearOutDragTrace | null = null,
): void {
  if (!target || !canDropTarget(item, target)) return;

  if (target.kind === "new-window" && tearoutOperationBusy()) { recoveryBusy(); return; }
  const focusSessionId = getFocusSessionId(item);

  if (item.surface === "minimap") {
    if (target.kind === "pane") commitMinimapPaneMove(item, target);
    else if (target.kind === "new-workspace") moveMinimapItemToNewWorkspace(item);
    else if (target.kind === "new-window") tearOutPaneToNewWindow(item, focusSessionId, target, trace);
    return;
  }

  if (target.kind === "handoff") {
    void commitPaneHandoff(item, target);
    return;
  }

  const layoutStore = useWorkspaceLayoutStore.getState();
  const listStore = useWorkspaceListStore.getState();

  if (target.kind === "tab-index") {
    // canDropTarget already pinned this to a tab drag inside the same pane.
    if (item.kind !== "tab") return;
    layoutStore.reorderPaneTab(target.workspaceId, target.paneId, item.tabId, target.index);
    useWorkspaceListStore.getState().setActiveWorkspace(target.workspaceId);
    focusController.request("drag", { sessionId: focusSessionId, focus: true });
    return;
  }

  if (target.kind === "new-window") {
    tearOutPaneToNewWindow(item, focusSessionId, target, trace);
    return;
  }

  if (target.kind === "new-workspace") {
    const workspaceId = crypto.randomUUID();
    const workspaceName = `Workspace ${listStore.workspaces.length + 1}`;
    const moved = moveDragItemToNewWorkspace(item, workspaceId, workspaceName);
    if (!moved) return;
    useWorkspaceListStore.getState().setActiveWorkspace(workspaceId);
    focusController.request("drag", { sessionId: focusSessionId, focus: true });
    return;
  }

  const result = executePaneMove(createPaneMoveRequest(item, {
    kind: "split", workspaceId: target.workspaceId, paneId: target.paneId, zone: target.zone,
  }));
  if (result.status !== "moved") return;

  useWorkspaceListStore.getState().setActiveWorkspace(target.workspaceId);
  focusController.request("drag", { sessionId: focusSessionId, focus: true });
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
    if (usePaneDragStore.getState().item?.surface === "minimap") {
      clearHoverTimer();
      return;
    }
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
    if (useSavepointDragStore.getState().item) return;
    const targetElement = event.target as HTMLElement;
    const interactiveAncestor = targetElement.closest("button, input, textarea, select, [data-dnd-ignore='true']");
    if (interactiveAncestor && !(item.surface === "minimap" && interactiveAncestor === event.currentTarget)) return;

    if (item.kind === "tab" && usesNativePaneDrag(item)) {
      beginNativePaneDrag(event.nativeEvent, event.currentTarget, item, {
        suppress: (value) => { suppressClickRef.current = value; },
        resolve: (x, y) => usePaneDragStore.getState().setTarget(resolveDropTargetAtPoint(x, y, item)),
        commit: () => commitPaneDragDrop(item, usePaneDragStore.getState().target),
      });
      return;
    }
    if (item.kind === "pane" && usesNativeGroupDrag(item)) {
      beginNativeGroupDrag(event.nativeEvent, event.currentTarget, item, {
        suppress: (value) => { suppressClickRef.current = value; },
        resolve: (x, y) => usePaneDragStore.getState().setTarget(resolveDropTargetAtPoint(x, y, item)),
        commit: () => commitPaneDragDrop(item, usePaneDragStore.getState().target),
      });
      return;
    }

    const sourceElement = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const dragItem: PaneDragItem = item.surface === "minimap"
      ? { ...item, sourceLayoutRevision: layoutStructureRevision(useWorkspaceListStore.getState().workspaces) }
      : item;
    let dragging = false;
    let finishing = false;
    let pendingMove: PointerEvent | null = null;
    let moveFrame = 0;

    const cancelPendingMove = () => {
      if (moveFrame) {
        cancelAnimationFrame(moveFrame);
        moveFrame = 0;
      }
      pendingMove = null;
    };
    const trace = createTearOutDragTrace({
      itemKind: dragItem.kind === "pane" ? "pane" : "tab",
      itemId: dragItem.kind === "pane"
        ? dragItem.paneId
        : dragItem.kind === "tab"
          ? dragItem.tabId
          : dragItem.anchorTabId,
      pointerId,
      pointer: tearOutPointerSample(event.nativeEvent),
    }, {
      sink: (measurement) => usePaneDragStore.getState().setTearOutMeasurement(measurement),
    });

    function handleLostPointerCapture(nativeEvent: PointerEvent) {
      if (nativeEvent.pointerId !== pointerId || finishing) return;
      trace?.pointerEvent("lostpointercapture", tearOutPointerSample(nativeEvent));
      trace?.transition("capture-lost", "pointer capture was lost before drag completion");
    }

    const cleanup = () => {
      cancelPendingMove();
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("blur", handleWindowBlur);
      sourceElement.removeEventListener("lostpointercapture", handleLostPointerCapture);
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

    const finishDrag = (nativeEvent: PointerEvent | null, shouldCommit: boolean) => {
      finishing = true;
      // Whatever throws below, the drag still ends: its window listeners go, the
      // drop highlight and banner clear, and clicks work again (a throw here in
      // v0.80.2 left "離すとこのペインだけの窓になります" on screen). cleanedUp is set
      // before the call so that a cleanup that throws is not run a second time.
      let cleanedUp = false;
      try {
        if (nativeEvent) {
          trace?.pointerEvent(
            shouldCommit ? "pointerup" : "pointercancel",
            tearOutPointerSample(nativeEvent),
          );
        }
        // The release point is authoritative: a frame-coalesced move can still be
        // pending, and dropping it would commit a one-frame-stale target.
        cancelPendingMove();
        if (dragging && shouldCommit && nativeEvent) {
          applyMove(nativeEvent);
        }
        cleanedUp = true;
        cleanup();
        if (!dragging) {
          trace?.transition("cancelled", "drag threshold was not reached");
          clearTearOutMeasurementAfterDelay();
          return;
        }
        nativeEvent?.preventDefault();
        suppressClickRef.current = true;
        const dragState = usePaneDragStore.getState();
        if (shouldCommit) {
          if (dragState.target?.kind !== "new-window") {
            trace?.transition("cancelled", "pointerup did not have a tear-out target");
            clearTearOutMeasurementAfterDelay();
          }
          try {
            commitPaneDragDrop(dragItem, dragState.target, trace);
          } catch (error) {
            // Not rethrown: a pointerup handler has no caller to hand it to.
            console.error("[mycmux] drop commit failed", error);
            trace?.failed("transfer-failed", String(error));
            useToastStore.getState().pushToast(paneDndStrings.dropFailed, "error");
          }
        } else {
          trace?.transition("cancelled", "drag cancelled before commit");
          clearTearOutMeasurementAfterDelay();
        }
      } finally {
        // The clean-up owed after an earlier throw can throw as well; the drag
        // still has to leave the store.
        try {
          if (!cleanedUp) cleanup();
        } finally {
          // A drag that never crossed the threshold never entered the store.
          if (dragging) {
            // clearDrag notifies the drag store's listeners; one that throws must
            // not leave every later click on the tab suppressed.
            try {
              usePaneDragStore.getState().clearDrag();
            } finally {
              window.setTimeout(() => {
                suppressClickRef.current = false;
              }, 0);
            }
          }
        }
      }
    };

    const cancelDrag = () => finishDrag(null, false);

    function applyMove(nativeEvent: PointerEvent) {
      const dragStore = usePaneDragStore.getState();
      dragStore.moveDrag({ x: nativeEvent.clientX, y: nativeEvent.clientY });
      let target = resolveDropTargetAtPoint(nativeEvent.clientX, nativeEvent.clientY, dragItem);
      if (
        !target &&
        isOutsideWindowViewport(
          nativeEvent.clientX,
          nativeEvent.clientY,
          window.innerWidth,
          window.innerHeight,
        )
      ) {
        const candidate = {
          kind: "new-window" as const,
          screenX: nativeEvent.screenX,
          screenY: nativeEvent.screenY,
        };
        target = canDropTarget(dragItem, candidate) ? candidate : null;
      }
      if (!samePaneDropTarget(dragStore.target, target)) {
        dragStore.setTarget(target);
      }
      const pointer = tearOutPointerSample(nativeEvent);
      if (target?.kind === "new-window") {
        trace?.arm(pointer);
      } else {
        trace?.disarm(pointer, target?.kind ?? null);
        trace?.updateCandidate(pointer, target?.kind ?? null);
      }
      updateWorkspaceHover(nativeEvent.clientX, nativeEvent.clientY);
    }

    function flushMove() {
      moveFrame = 0;
      const nativeEvent = pendingMove;
      pendingMove = null;
      if (!nativeEvent || finishing || !dragging) return;
      applyMove(nativeEvent);
    }

    function handlePointerMove(nativeEvent: PointerEvent) {
      if (nativeEvent.pointerId !== pointerId) return;
      const dx = nativeEvent.clientX - startX;
      const dy = nativeEvent.clientY - startY;
      if (!dragging) {
        const threshold = dragItem.surface === "minimap" ? 5 : TEAR_OUT_DRAG_THRESHOLD_PX;
        if (Math.hypot(dx, dy) < threshold) return;
        if (useSavepointDragStore.getState().item) {
          cleanup();
          return;
        }
        dragging = true;
        suppressClickRef.current = true;
        try {
          sourceElement.setPointerCapture(pointerId);
          trace?.dragging(sourceElement.hasPointerCapture(pointerId));
        } catch {
          // Non-critical; window listeners still carry the drag.
          trace?.dragging(false);
        }
        document.body.style.cursor = "grabbing";
        usePaneDragStore.getState().beginDrag(dragItem, { x: nativeEvent.clientX, y: nativeEvent.clientY });
        nativeEvent.preventDefault();
        // The drag starts with its highlight already painted; only the stream
        // after this first move is worth coalescing.
        applyMove(nativeEvent);
        return;
      }

      nativeEvent.preventDefault();
      // Pointer events arrive well above the display rate, and each one costs
      // two hit-tests, a rect sweep of the tab strip and up to three store
      // writes. Collapse them to one pass per frame — that is all the pointer
      // ghost and the drop highlights can show anyway.
      pendingMove = nativeEvent;
      if (!moveFrame) {
        moveFrame = requestAnimationFrame(flushMove);
      }
    }

    function handlePointerUp(nativeEvent: PointerEvent) {
      if (nativeEvent.pointerId !== pointerId) return;
      finishDrag(nativeEvent, true);
    }

    function handlePointerCancel(nativeEvent: PointerEvent) {
      if (nativeEvent.pointerId !== pointerId) return;
      finishDrag(nativeEvent, false);
    }

    function handleKeyDown(nativeEvent: KeyboardEvent) {
      if (nativeEvent.key !== "Escape") return;
      nativeEvent.preventDefault();
      nativeEvent.stopPropagation();
      cancelDrag();
    }

    function handleWindowBlur() {
      cancelDrag();
    }

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("blur", handleWindowBlur);
    sourceElement.addEventListener("lostpointercapture", handleLostPointerCapture);
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
