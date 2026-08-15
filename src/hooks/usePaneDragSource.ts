import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import {
  resolveTabInsertionIndex,
  usePaneDragStore,
  type PaneDragItem,
  type PaneDropTarget,
} from "../stores/paneDragStore";
import { useWorkspaceLayoutStore } from "../stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";
import { useSavepointDragStore } from "../stores/savepointDragStore";
import { focusController } from "../lib/focusController";
import { publishSavepoint } from "../lib/ipc";
import { isOutsideWindowViewport } from "../lib/windowEdge";
import { tearOutWorkspaceToNewWindow } from "../lib/workspaceTearOut";
import {
  isPaneDropTargetEligible,
  prioritizePaneHandoffDropTarget,
  resolvePaneDropZone,
  resolvePaneHandoffEligibility,
} from "../lib/paneHandoff";
import {
  commitSavepointPaste,
  resolveLiveAgentTarget,
} from "../lib/savepointHandoffRuntime";
import { onlineStrings } from "../components/online/onlineStrings";
import { usePaneMetadataStore } from "../stores/paneMetadataStore";
import { useToastStore } from "../stores/toastStore";
import { applyLayoutMutation, layoutStructureRevision } from "../lib/layoutMutation";
import { resolveMinimapDropZone } from "../components/dashboard/minimapModel";
import { moveMinimapItemToNewWorkspace } from "../components/dashboard/minimapWorkspaceActions";

const DRAG_THRESHOLD_PX = 9;
const WORKSPACE_HOVER_DELAY_MS = 350;

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

function resolvePaneHandoffContext(
  item: PaneDragItem,
  targetWorkspaceId: string,
  targetPaneId: string,
) {
  const listState = useWorkspaceListStore.getState();
  const sourceWorkspace = listState.getWorkspace(item.workspaceId);
  const sourcePane = sourceWorkspace?.panes.find((pane) => pane.id === item.paneId);
  const targetWorkspace = listState.getWorkspace(targetWorkspaceId);
  const targetPane = targetWorkspace?.panes.find((pane) => pane.id === targetPaneId);
  if (!sourcePane || !targetPane) return null;

  const sourceTab = item.kind === "tab"
    ? sourcePane.tabs.find((tab) => tab.id === item.tabId)
    : (sourcePane.tabs.find((tab) => tab.id === sourcePane.activeTabId) ?? sourcePane.tabs[0]);
  const targetTab = targetPane.tabs.find((tab) => tab.id === targetPane.activeTabId)
    ?? targetPane.tabs[0];
  const metadata = usePaneMetadataStore.getState().metadata;
  const eligibility = resolvePaneHandoffEligibility(
    {
      workspaceId: item.workspaceId,
      paneId: item.paneId,
      tab: sourceTab,
      metadata: sourceTab ? metadata[sourceTab.sessionId] : undefined,
    },
    {
      workspaceId: targetWorkspaceId,
      paneId: targetPaneId,
      tab: targetTab,
      metadata: targetTab ? metadata[targetTab.sessionId] : undefined,
    },
  );
  if (!eligibility || !targetTab) return null;
  const pasteTarget = resolveLiveAgentTarget(targetWorkspaceId, targetPaneId, targetTab.id);
  if (!pasteTarget || pasteTarget.targetKind !== eligibility.targetAgentKind) return null;
  return { eligibility, pasteTarget };
}

function canDropTarget(item: PaneDragItem, target: PaneDropTarget): boolean {
  const listState = useWorkspaceListStore.getState();
  const sourceWorkspace = listState.getWorkspace(item.workspaceId);
  if (!sourceWorkspace) return false;

  const sourcePane = sourceWorkspace.panes.find((pane) => pane.id === item.paneId);
  if (!sourcePane) return false;

  if (target.kind === "new-workspace" || target.kind === "new-window") {
    return item.kind === "pane" || sourcePane.tabs.some((tab) => tab.id === item.tabId);
  }

  if (target.kind === "handoff") {
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
  return isPaneDropTargetEligible(item, target, sourcePane.tabs.length);
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

  const zone = resolvePaneDropZone(paneElement.getBoundingClientRect(), x, y);
  const target = { kind: "pane" as const, workspaceId, paneId, zone };
  fallbackTarget = canDropTarget(item, target) ? target : null;
  return prioritizePaneHandoffDropTarget(Boolean(handoffElement), handoffTarget, fallbackTarget);
}

function commitMinimapTabDrop(item: Extract<PaneDragItem, { kind: "tab" }>, target: PaneDropTarget | null): void {
  if (!target || target.kind !== "pane" || target.surface !== "minimap" || !canDropTarget(item, target)) return;
  const listStore = useWorkspaceListStore.getState();
  const before = listStore.workspaces;
  const currentRevision = layoutStructureRevision(before);
  const mutation = {
    kind: "move-tabs" as const,
    operationId: crypto.randomUUID(),
    tabIds: [item.tabId],
    anchorTabId: item.tabId,
    to: target.zone === "center"
      ? { workspaceId: target.workspaceId, paneId: target.paneId }
      : { workspaceId: target.workspaceId, split: { paneId: target.paneId, zone: target.zone } },
    sourceLayoutRevision: item.sourceLayoutRevision ?? currentRevision,
  };
  const { workspaces, summary } = applyLayoutMutation(before, mutation, currentRevision);
  if (!summary.staleRevision && summary.moved.length > 0) {
    listStore._replaceWorkspaces(workspaces);
  }
}

async function commitPaneHandoff(
  item: PaneDragItem,
  target: Extract<PaneDropTarget, { kind: "handoff" }>,
): Promise<void> {
  const context = resolvePaneHandoffContext(item, target.workspaceId, target.paneId);
  if (!context) {
    useToastStore.getState().pushToast(onlineStrings.dragDropTargetGone, "warning");
    return;
  }

  const openingToastId = useToastStore
    .getState()
    .pushToast(onlineStrings.dragDropPreparingDraft, "info");
  try {
    const published = await publishSavepoint({
      cwd: context.eligibility.sourceCwd,
      agentKind: context.eligibility.publishAgentKind,
      agentSessionId: context.eligibility.sourceAgentSessionId,
    });
    await commitSavepointPaste(published.bundle_dir, context.pasteTarget, openingToastId);
  } catch (error) {
    console.error("[mycmux] failed to publish pane handoff", error);
    useToastStore.getState().pushToast(
      onlineStrings.dragDropErrorPrefix + String(error),
      "error",
    );
  } finally {
    useToastStore.getState().dismissToast(openingToastId);
  }
}

function commitPaneDragDrop(item: PaneDragItem, target: PaneDropTarget | null): void {
  if (!target || !canDropTarget(item, target)) return;

  if (item.surface === "minimap") {
    if (target.kind === "pane" && item.kind === "tab") commitMinimapTabDrop(item, target);
    else if (target.kind === "new-workspace") moveMinimapItemToNewWorkspace(item);
    return;
  }

  if (target.kind === "handoff") {
    void commitPaneHandoff(item, target);
    return;
  }

  const focusSessionId = getFocusSessionId(item);
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

  if (target.kind === "new-workspace" || target.kind === "new-window") {
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
    if (target.kind === "new-window") {
      // Dropped outside the window: the fresh workspace immediately tears out
      // to a new OS window at the drop point. If opening the window fails the
      // workspace simply stays here — nothing to undo, nothing lost.
      void tearOutWorkspaceToNewWindow(workspaceId, {
        x: target.screenX - 40,
        y: target.screenY - 20,
      }).catch((error) => {
        console.error("[multiwindow] drag tear-out failed", error);
        useToastStore.getState().pushToast("新しいウィンドウを開けませんでした", "error");
      });
      return;
    }
    useWorkspaceListStore.getState().setActiveWorkspace(workspaceId);
    focusController.request("drag", { sessionId: focusSessionId, focus: true });
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

    const sourceElement = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const dragItem: PaneDragItem = item.surface === "minimap" && item.kind === "tab"
      ? { ...item, sourceLayoutRevision: layoutStructureRevision(useWorkspaceListStore.getState().workspaces) }
      : item;
    let dragging = false;

    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("blur", handleWindowBlur);
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
      cleanup();
      if (!dragging) return;
      nativeEvent?.preventDefault();
      suppressClickRef.current = true;
      const dragState = usePaneDragStore.getState();
      if (shouldCommit) {
        commitPaneDragDrop(dragItem, dragState.target);
      }
      usePaneDragStore.getState().clearDrag();
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    };

    const cancelDrag = () => finishDrag(null, false);

    function handlePointerMove(nativeEvent: PointerEvent) {
      if (nativeEvent.pointerId !== pointerId) return;
      const dx = nativeEvent.clientX - startX;
      const dy = nativeEvent.clientY - startY;
      if (!dragging) {
        const threshold = dragItem.surface === "minimap" ? 5 : DRAG_THRESHOLD_PX;
        if (Math.hypot(dx, dy) < threshold) return;
        if (useSavepointDragStore.getState().item) {
          cleanup();
          return;
        }
        dragging = true;
        suppressClickRef.current = true;
        try {
          sourceElement.setPointerCapture(pointerId);
        } catch {
          // Non-critical; window listeners still carry the drag.
        }
        document.body.style.cursor = "grabbing";
        usePaneDragStore.getState().beginDrag(dragItem, { x: nativeEvent.clientX, y: nativeEvent.clientY });
      }

      nativeEvent.preventDefault();
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
      dragStore.setTarget(target);
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
