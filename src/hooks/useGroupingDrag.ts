import {
  useCallback,
  createElement,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { tabGroupingStrings } from "../components/dashboard/dashboardStrings";
import {
  groupingAutoScrollStep,
  groupingDragReduce,
  groupingDragTabsArePresent,
  groupingDropIsNoop,
  resolveGroupingDropTarget,
  type GroupingDragCancelReason,
  type GroupingDragEffect,
  type GroupingDragOrigin,
  type GroupingDragState,
} from "../components/layout/groupingDrag";
import type { GroupingEditTarget } from "../components/layout/groupingEdit";
import type { GroupingPlan } from "../components/layout/tabGrouping";

export interface UseGroupingDragOptions {
  readonly enabled: boolean;
  readonly mode: string;
  readonly plan: GroupingPlan | null;
  readonly selectedTabIds: ReadonlySet<string>;
  readonly validDropIds: ReadonlySet<string>;
  readonly targetsByDropId: ReadonlyMap<string, GroupingEditTarget>;
  readonly dropNames: ReadonlyMap<string, string>;
  readonly tabLabels: ReadonlyMap<string, string>;
  readonly revisionToken: unknown;
  readonly layoutRevision: string;
  readonly onToggleTab: (tabId: string) => void;
  readonly onMove: (
    tabIds: readonly string[],
    target: GroupingEditTarget,
    announce: string,
  ) => void;
  readonly onCancel?: (reason: GroupingDragCancelReason, announce: boolean) => void;
}

export interface UseGroupingDragResult {
  readonly onTabPointerDown: (
    event: ReactPointerEvent<HTMLElement>,
    tabId: string,
  ) => void;
  readonly ghost: ReactNode;
  readonly active: boolean;
}

interface DragView {
  readonly origin: GroupingDragOrigin;
  readonly portalRoot: Element;
  readonly x: number;
  readonly y: number;
}

interface DragSession {
  readonly source: HTMLElement;
  readonly pointerId: number;
  readonly revisionToken: unknown;
  readonly layoutRevision: string;
  readonly previousBodyCursor: string;
  readonly focusOrigin: Element | null;
  readonly panelRoot: HTMLElement | null;
  readonly editmapRoot: HTMLElement | Document;
  readonly scrollContainer: HTMLElement | null;
  readonly reducedMotion: boolean;
  dragStarted: boolean;
  lostCaptureTimeout: number | null;
  handlePointerMove: (event: PointerEvent) => void;
  handlePointerUp: (event: PointerEvent) => void;
  handlePointerCancel: (event: PointerEvent) => void;
  handleKeyDown: (event: KeyboardEvent) => void;
  handleBlur: () => void;
  handleVisibilityChange: () => void;
  handleResize: () => void;
  handleScroll: () => void;
  handleWheel: (event: WheelEvent) => void;
  handleSecondaryPointerDown: (event: PointerEvent) => void;
  handleContextMenu: (event: MouseEvent) => void;
  handleLostPointerCapture: () => void;
}

interface PendingFocus {
  readonly source: HTMLElement;
  readonly sourceTabId: string;
  readonly dropId: string | null;
  readonly focusOrigin: Element | null;
  readonly panelRoot: HTMLElement | null;
}

function hitTestDropElement(
  x: number,
  y: number,
  validDropIds: ReadonlySet<string>,
): HTMLElement | null {
  // WebView2: clientX/clientY are already CSS pixels; never scale hit-test coordinates by devicePixelRatio.
  let elements: readonly Element[];
  try {
    if (typeof document.elementsFromPoint === "function") {
      elements = document.elementsFromPoint(x, y);
    } else if (typeof document.elementFromPoint === "function") {
      const element = document.elementFromPoint(x, y);
      elements = element ? [element] : [];
    } else {
      return null;
    }
  } catch {
    return null;
  }
  for (const element of elements) {
    const target = element.closest<HTMLElement>("[data-drop-id]");
    const dropId = target?.getAttribute("data-drop-id");
    if (target && dropId && validDropIds.has(dropId)) return target;
  }
  return null;
}

function dropElementWithin(root: HTMLElement | Document, dropId: string): HTMLElement | null {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    try {
      return root.querySelector<HTMLElement>(`[data-drop-id="${CSS.escape(dropId)}"]`);
    } catch {
      // Fall through to exact attribute comparison for incomplete selector engines.
    }
  }
  return [...root.querySelectorAll<HTMLElement>("[data-drop-id]")]
    .find((element) => element.getAttribute("data-drop-id") === dropId) ?? null;
}

function tabElementWithin(root: HTMLElement, tabId: string): HTMLElement | null {
  return [...root.querySelectorAll<HTMLElement>("[data-tab-id]")]
    .find((element) => element.getAttribute("data-tab-id") === tabId) ?? null;
}

function focusIfAvailable(element: Element | null): boolean {
  if (!(element instanceof HTMLElement) || !document.contains(element)) return false;
  element.focus();
  return document.activeElement === element;
}

function hitTestDropId(x: number, y: number, validDropIds: ReadonlySet<string>): string | null {
  return hitTestDropElement(x, y, validDropIds)?.getAttribute("data-drop-id") ?? null;
}

export function useGroupingDrag(options: UseGroupingDragOptions): UseGroupingDragResult {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const stateRef = useRef<GroupingDragState>({ phase: "idle" });
  const sessionRef = useRef<DragSession | null>(null);
  const latestPointRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const activeTargetRef = useRef<HTMLElement | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusRef = useRef<PendingFocus | null>(null);
  const [dragView, setDragView] = useState<DragView | null>(null);
  const [active, setActive] = useState(false);

  const removeDragArtifacts = useCallback((session: DragSession): void => {
    delete document.documentElement.dataset.cmuxGroupingDrag;
    window.removeEventListener("pointermove", session.handlePointerMove);
    window.removeEventListener("pointerup", session.handlePointerUp);
    window.removeEventListener("pointercancel", session.handlePointerCancel);
    window.removeEventListener("keydown", session.handleKeyDown, true);
    window.removeEventListener("blur", session.handleBlur);
    document.removeEventListener("visibilitychange", session.handleVisibilityChange);
    window.removeEventListener("resize", session.handleResize);
    window.removeEventListener("scroll", session.handleScroll, true);
    window.removeEventListener("wheel", session.handleWheel, true);
    window.removeEventListener("pointerdown", session.handleSecondaryPointerDown, true);
    window.removeEventListener("contextmenu", session.handleContextMenu, true);
    session.source.removeEventListener("lostpointercapture", session.handleLostPointerCapture);
    if (session.lostCaptureTimeout !== null) {
      window.clearTimeout(session.lostCaptureTimeout);
      session.lostCaptureTimeout = null;
    }
    if (
      typeof session.source.hasPointerCapture === "function"
      && session.source.hasPointerCapture(session.pointerId)
      && typeof session.source.releasePointerCapture === "function"
    ) {
      try {
        session.source.releasePointerCapture(session.pointerId);
      } catch {
        // The browser can release capture before cleanup runs.
      }
    }
    document.body.style.cursor = session.previousBodyCursor;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    activeTargetRef.current?.classList.remove("is-drop-active");
    activeTargetRef.current?.setAttribute("data-grouping-drop-state", "idle");
    activeTargetRef.current = null;
    session.source.classList.remove("is-dragging");
    session.panelRoot?.classList.remove("is-drag-active");
    latestPointRef.current = null;
    if (sessionRef.current === session) sessionRef.current = null;
  }, []);

  const endSession = useCallback((session: DragSession, dropId: string | null): void => {
    pendingFocusRef.current = {
      source: session.source,
      sourceTabId: stateRef.current.phase === "idle"
        ? session.source.getAttribute("data-tab-id") ?? ""
        : stateRef.current.origin.sourceTabId,
      dropId,
      focusOrigin: session.focusOrigin,
      panelRoot: session.panelRoot,
    };
    removeDragArtifacts(session);
    setDragView(null);
    setActive(false);
  }, [removeDragArtifacts]);

  const cancelSession = useCallback((reason: GroupingDragCancelReason): void => {
    const session = sessionRef.current;
    if (!session) return;
    const dropId = activeTargetRef.current?.getAttribute("data-drop-id") ?? null;
    const reduced = groupingDragReduce(stateRef.current, { kind: "cancel", reason });
    stateRef.current = reduced.state;
    try {
      if (reduced.effect.kind === "cancelled") {
        optionsRef.current.onCancel?.(reduced.effect.reason, session.dragStarted);
      }
    } finally {
      endSession(session, dropId);
    }
  }, [endSession]);

  const handleEffect = useCallback((effect: GroupingDragEffect, session: DragSession): void => {
    if (effect.kind === "begin") {
      session.dragStarted = true;
      document.documentElement.dataset.cmuxGroupingDrag = "1";
      if (typeof session.source.setPointerCapture === "function") {
        try {
          session.source.setPointerCapture(session.pointerId);
        } catch {
          // Pointer capture is an enhancement; window listeners remain authoritative.
        }
      }
      session.source.classList.add("is-dragging");
      session.panelRoot?.classList.add("is-drag-active");
      document.body.style.cursor = "grabbing";
      const point = latestPointRef.current ?? { pointerId: session.pointerId, x: effect.origin.x, y: effect.origin.y };
      setDragView({
        origin: effect.origin,
        portalRoot: session.source.closest("[data-cmux-overlay-root]")
          ?? document.querySelector("[data-cmux-themed-root]")
          ?? document.body,
        x: point.x,
        y: point.y,
      });
      return;
    }
    if (effect.kind === "click") {
      try {
        optionsRef.current.onToggleTab(effect.sourceTabId);
      } finally {
        endSession(session, null);
      }
      return;
    }
    if (effect.kind === "cancelled") {
      try {
        optionsRef.current.onCancel?.(effect.reason, session.dragStarted);
      } finally {
        endSession(session, activeTargetRef.current?.getAttribute("data-drop-id") ?? null);
      }
      return;
    }
    if (effect.kind !== "drop") return;

    const current = optionsRef.current;
    let cancelReason: GroupingDragCancelReason | null = null;
    if (!Object.is(current.revisionToken, session.revisionToken)) cancelReason = "revision-changed";
    if (cancelReason === null && current.layoutRevision !== session.layoutRevision) {
      cancelReason = "layout-changed";
    }
    const containmentRoot = effect.dropId === "keep-current"
      ? session.panelRoot ?? session.editmapRoot
      : session.editmapRoot;
    const dropElement = cancelReason === null && containmentRoot
      ? dropElementWithin(containmentRoot, effect.dropId)
      : null;
    if (cancelReason === null && (!dropElement || !containmentRoot?.contains(dropElement))) {
      cancelReason = "target-gone";
    }
    const target = cancelReason === null
      ? resolveGroupingDropTarget(effect.dropId, current.validDropIds, current.targetsByDropId)
      : null;
    if (cancelReason === null && target === null) cancelReason = "target-gone";
    if (cancelReason === null && !groupingDragTabsArePresent(current.plan, effect.tabIds)) {
      cancelReason = "stale-selection";
    }
    if (cancelReason === null && target && groupingDropIsNoop(current.plan, effect.tabIds, target)) {
      cancelReason = "noop";
    }
    if (cancelReason !== null) {
      const cancelled = groupingDragReduce(stateRef.current, {
        kind: "cancel",
        reason: cancelReason,
      });
      stateRef.current = cancelled.state;
      try {
        if (cancelled.effect.kind === "cancelled") {
          current.onCancel?.(cancelled.effect.reason, session.dragStarted);
        }
      } finally {
        endSession(session, effect.dropId);
      }
      return;
    }
    if (target === null) {
      cancelSession("target-gone");
      return;
    }

    const announce = target.kind === "unassigned"
      ? tabGroupingStrings.keepAnnounce(effect.tabIds.length)
      : tabGroupingStrings.moveAnnounce(
          effect.tabIds.length,
          current.dropNames.get(effect.dropId) ?? effect.dropId,
        );
    try {
      current.onMove(effect.tabIds, target, announce);
    } finally {
      stateRef.current = groupingDragReduce(stateRef.current, { kind: "settle" }).state;
      endSession(session, effect.dropId);
    }
  }, [cancelSession, endSession]);

  const onTabPointerDown = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    tabId: string,
  ): void => {
    const current = optionsRef.current;
    if (!current.enabled || event.button !== 0 || !event.isPrimary || stateRef.current.phase !== "idle") return;
    const target = event.target;
    const nestedInteractive = target instanceof Element
      ? target.closest("button, input, textarea, select")
      : null;
    if (nestedInteractive && nestedInteractive !== event.currentTarget) return;

    const source = event.currentTarget;
    const tabIds = current.selectedTabIds.has(tabId)
      ? [...current.selectedTabIds]
      : [tabId];
    const origin: GroupingDragOrigin = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      sourceTabId: tabId,
      tabIds,
    };
    stateRef.current = groupingDragReduce(stateRef.current, { kind: "press", origin }).state;
    latestPointRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };

    const session: DragSession = {
      source,
      pointerId: event.pointerId,
      revisionToken: current.revisionToken,
      layoutRevision: current.layoutRevision,
      previousBodyCursor: document.body.style.cursor,
      focusOrigin: document.activeElement,
      panelRoot: source.closest<HTMLElement>(".cmux-tab-grouping"),
      editmapRoot: source.closest<HTMLElement>(".cmux-tab-grouping-editmap") ?? document,
      scrollContainer: source.closest<HTMLElement>(".cmux-tab-grouping-editmap"),
      reducedMotion: typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      dragStarted: false,
      lostCaptureTimeout: null,
      handlePointerMove: () => undefined,
      handlePointerUp: () => undefined,
      handlePointerCancel: () => undefined,
      handleKeyDown: () => undefined,
      handleBlur: () => undefined,
      handleVisibilityChange: () => undefined,
      handleResize: () => undefined,
      handleScroll: () => undefined,
      handleWheel: () => undefined,
      handleSecondaryPointerDown: () => undefined,
      handleContextMenu: () => undefined,
      handleLostPointerCapture: () => undefined,
    };

    const processPoint = (point: { pointerId: number; x: number; y: number }): void => {
      if (!point || point.pointerId !== session.pointerId || sessionRef.current !== session) return;
      if (ghostRef.current) {
        ghostRef.current.style.transform = `translate3d(${point.x + 12}px, ${point.y + 12}px, 0)`;
      }
      const nextTarget = hitTestDropElement(
        point.x,
        point.y,
        optionsRef.current.validDropIds,
      );
      const nextDropId = nextTarget?.getAttribute("data-drop-id") ?? null;
      const reduced = groupingDragReduce(stateRef.current, {
        kind: "move",
        pointerId: point.pointerId,
        x: point.x,
        y: point.y,
        dropId: nextDropId,
      });
      const nextActiveTarget = reduced.state.phase === "dragging" ? nextTarget : null;
      if (nextActiveTarget !== activeTargetRef.current) {
        activeTargetRef.current?.classList.remove("is-drop-active");
        activeTargetRef.current?.setAttribute("data-grouping-drop-state", "idle");
        nextActiveTarget?.classList.add("is-drop-active");
        nextActiveTarget?.setAttribute("data-grouping-drop-state", "active");
        activeTargetRef.current = nextActiveTarget;
      }
      stateRef.current = reduced.state;
      handleEffect(reduced.effect, session);
    };

    const runFrame = (): void => {
      rafRef.current = null;
      const point = latestPointRef.current;
      if (!point) return;
      processPoint(point);
      if (
        sessionRef.current === session
        && stateRef.current.phase === "dragging"
        && session.scrollContainer
        && !session.reducedMotion
      ) {
        const scroll = session.scrollContainer;
        const bounds = scroll.getBoundingClientRect();
        const delta = groupingAutoScrollStep(point.y, bounds, scroll);
        if (delta !== 0) {
          scroll.scrollTop += delta;
          processPoint(point);
          if (sessionRef.current === session && rafRef.current === null) {
            rafRef.current = requestAnimationFrame(runFrame);
          }
        }
      }
    };

    session.handlePointerMove = (nativeEvent): void => {
      if (nativeEvent.pointerId !== session.pointerId) return;
      latestPointRef.current = {
        pointerId: nativeEvent.pointerId,
        x: nativeEvent.clientX,
        y: nativeEvent.clientY,
      };
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(runFrame);
      nativeEvent.preventDefault();
    };
    session.handlePointerUp = (nativeEvent): void => {
      if (nativeEvent.pointerId !== session.pointerId) return;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
        const point = {
          pointerId: nativeEvent.pointerId,
          x: nativeEvent.clientX,
          y: nativeEvent.clientY,
        };
        latestPointRef.current = point;
        processPoint(point);
        if (sessionRef.current !== session) return;
      }
      const dropId = hitTestDropId(
        nativeEvent.clientX,
        nativeEvent.clientY,
        optionsRef.current.validDropIds,
      );
      const reduced = groupingDragReduce(stateRef.current, {
        kind: "release",
        pointerId: nativeEvent.pointerId,
        dropId,
      });
      stateRef.current = reduced.state;
      handleEffect(reduced.effect, session);
    };
    session.handlePointerCancel = (nativeEvent): void => {
      if (nativeEvent.pointerId !== session.pointerId) return;
      cancelSession("pointercancel");
    };
    session.handleKeyDown = (nativeEvent): void => {
      if (nativeEvent.key === "Escape") {
        nativeEvent.preventDefault();
        nativeEvent.stopPropagation();
        cancelSession("escape");
      } else if (nativeEvent.key === "Tab") {
        cancelSession("focus-moved");
      } else if (stateRef.current.phase === "dragging" || stateRef.current.phase === "dropping") {
        nativeEvent.preventDefault();
        nativeEvent.stopImmediatePropagation();
      }
    };
    session.handleBlur = (): void => cancelSession("blur");
    session.handleVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") cancelSession("blur");
    };
    session.handleResize = (): void => cancelSession("resize");
    session.handleScroll = (): void => {
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(runFrame);
    };
    session.handleWheel = (nativeEvent): void => {
      if (
        nativeEvent.ctrlKey
        && (stateRef.current.phase === "dragging" || stateRef.current.phase === "dropping")
      ) {
        nativeEvent.preventDefault();
        nativeEvent.stopImmediatePropagation();
      }
    };
    session.handleSecondaryPointerDown = (nativeEvent): void => {
      if (nativeEvent.button === 0) return;
      nativeEvent.preventDefault();
      cancelSession("secondary-button");
    };
    session.handleContextMenu = (nativeEvent): void => {
      nativeEvent.preventDefault();
      cancelSession("secondary-button");
    };
    session.handleLostPointerCapture = (): void => {
      if (session.lostCaptureTimeout !== null) return;
      // WebView2: lostpointercapture can precede pointerup; defer the cancel by one task so a real drop wins.
      session.lostCaptureTimeout = window.setTimeout(() => {
        session.lostCaptureTimeout = null;
        if (sessionRef.current === session && stateRef.current.phase === "dragging") {
          cancelSession("lost-capture");
        }
      }, 0);
    };
    sessionRef.current = session;
    setActive(true);
    window.addEventListener("pointermove", session.handlePointerMove, { passive: false });
    window.addEventListener("pointerup", session.handlePointerUp);
    window.addEventListener("pointercancel", session.handlePointerCancel);
    window.addEventListener("keydown", session.handleKeyDown, true);
    window.addEventListener("blur", session.handleBlur);
    document.addEventListener("visibilitychange", session.handleVisibilityChange);
    window.addEventListener("resize", session.handleResize);
    window.addEventListener("scroll", session.handleScroll, { capture: true, passive: true });
    window.addEventListener("wheel", session.handleWheel, { capture: true, passive: false });
    window.addEventListener("pointerdown", session.handleSecondaryPointerDown, true);
    window.addEventListener("contextmenu", session.handleContextMenu, true);
    session.source.addEventListener("lostpointercapture", session.handleLostPointerCapture);
    // WebView2 may omit pointerleave at web-content boundaries; window pointer events are authoritative.
  }, [cancelSession, handleEffect]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    if (options.mode !== "edit") {
      cancelSession("mode-changed");
      return;
    }
    if (!Object.is(options.revisionToken, session.revisionToken)) {
      cancelSession("revision-changed");
      return;
    }
    if (options.layoutRevision !== session.layoutRevision) {
      cancelSession("layout-changed");
      return;
    }
    if (!options.enabled) cancelSession("unmount");
  }, [cancelSession, options.enabled, options.layoutRevision, options.mode, options.revisionToken]);

  useEffect(() => {
    if (dragView !== null) return;
    const pending = pendingFocusRef.current;
    if (!pending) return;
    pendingFocusRef.current = null;
    if (focusIfAvailable(pending.source)) return;
    const dropElement = pending.panelRoot && pending.dropId
      ? dropElementWithin(pending.panelRoot, pending.dropId)
      : null;
    if (dropElement && focusIfAvailable(tabElementWithin(dropElement, pending.sourceTabId))) return;
    if (focusIfAvailable(dropElement)) return;
    focusIfAvailable(pending.focusOrigin);
  }, [dragView]);

  useEffect(() => () => {
    const session = sessionRef.current;
    if (!session) return;
    const reduced = groupingDragReduce(stateRef.current, {
      kind: "cancel",
      reason: "unmount",
    });
    stateRef.current = reduced.state;
    try {
      if (reduced.effect.kind === "cancelled") {
        optionsRef.current.onCancel?.(reduced.effect.reason, session.dragStarted);
      }
    } finally {
      removeDragArtifacts(session);
    }
  }, [removeDragArtifacts]);

  const ghost = dragView
    ? createPortal(
        createElement(
          "div",
          {
            ref: ghostRef,
            className: "cmux-tab-grouping-ghost",
            "data-grouping-ghost": "true",
            "aria-hidden": "true",
            style: { transform: `translate3d(${dragView.x + 12}px, ${dragView.y + 12}px, 0)` },
          },
          createElement(
            "span",
            { className: "cmux-tab-grouping-ghost-label" },
            options.tabLabels.get(dragView.origin.sourceTabId) ?? dragView.origin.sourceTabId,
          ),
          dragView.origin.tabIds.length > 1
            ? createElement(
                "span",
                { className: "cmux-tab-grouping-ghost-count" },
                tabGroupingStrings.dragGhostCount(dragView.origin.tabIds.length),
              )
            : null,
        ),
        dragView.portalRoot,
      )
    : null;

  return { onTabPointerDown, ghost, active };
}
