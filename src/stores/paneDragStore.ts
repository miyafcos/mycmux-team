import { create } from "zustand";
import type { TearOutMeasurementSnapshot } from "../lib/tearOutDiagnostics";

export type PaneDropZone = "center" | "left" | "right" | "up" | "down";
export type PaneDragSurface = "workspace" | "minimap";

/**
 * Presentation-only feedback for a tab dragged over Dashboard's chat columns.
 * This is deliberately separate from PaneDropTarget: Dashboard columns are view
 * state, not a workspace-layout mutation target.
 */
export type DashboardChatDropPreview =
  | { kind: "insert"; index: number; offsetX: number }
  | { kind: "existing"; tabId: string; index: number }
  | { kind: "full" }
  | null;

export type PaneDragItem =
  | {
      kind: "tab";
      workspaceId: string;
      paneId: string;
      tabId: string;
      label: string;
      /** The minimap has atomic, non-focusing drop semantics. */
      surface?: PaneDragSurface;
      sourceLayoutRevision?: string;
    }
  | {
      /**
       * A minimap-only tab bundle. The anchor remains the tab the user grabbed;
       * tabIds are frozen together with the structural revision at drag start.
       */
      kind: "tab-bundle";
      workspaceId: string;
      paneId: string;
      tabIds: string[];
      anchorTabId: string;
      label: string;
      surface: "minimap";
      sourceLayoutRevision?: string;
    }
  | {
      kind: "pane";
      workspaceId: string;
      paneId: string;
      label: string;
      tabCount: number;
      surface?: PaneDragSurface;
      sourceLayoutRevision?: string;
    };

export type PaneDropTarget =
  {
      kind: "pane";
      workspaceId: string;
      paneId: string;
      zone: PaneDropZone;
      surface?: PaneDragSurface;
    }
  | {
      /**
       * Chrome-style reorder inside one pane's tab strip. `index` is an
       * insertion slot measured against the pane's current tabs array
       * (0..tabs.length): the dragged tab lands before the tab currently at
       * that index, and `tabs.length` means "after the last pill".
       */
      kind: "tab-index";
      workspaceId: string;
      paneId: string;
      index: number;
    }
  | {
      kind: "new-workspace";
      surface?: PaneDragSurface;
    }
  | {
      /**
       * Pointer released outside the window (Phase 3c drag tear-out): the
       * dragged tab/pane becomes a new workspace in a new OS window at the
       * recorded screen point. Set by the drag loop's viewport check, never by
       * DOM hit-testing — there is no element out there to hit.
       */
      kind: "new-window";
      screenX: number;
      screenY: number;
    }
  | {
      kind: "handoff";
      workspaceId: string;
      paneId: string;
    };

interface PointerPosition {
  x: number;
  y: number;
}

/**
 * The dashboard owns its receipt/commit path because its columns are view
 * state, not workspace layout. Keeping this selector here makes the semantic
 * target explicit without extending the layout drag core.
 */
export function isDashboardChatDropTarget(element: Element | null): boolean {
  return Boolean(element?.closest("[data-dashboard-chat-drop-target='true']"));
}

/** Only the horizontal span of a tab pill matters for insertion hit-testing. */
export interface TabPillSpan {
  left: number;
  right: number;
}

/**
 * Pure hit-test behind the `tab-index` drop target: the insertion slot is the
 * number of pills whose horizontal midpoint sits at or left of the pointer.
 * `spans` must be in tab-strip order; the result is clamped to
 * 0..spans.length by construction.
 */
export function resolveTabInsertionIndex(spans: readonly TabPillSpan[], x: number): number {
  let index = 0;
  for (const span of spans) {
    if (x < (span.left + span.right) / 2) break;
    index += 1;
  }
  return index;
}

interface PaneDragState {
  item: PaneDragItem | null;
  pointer: PointerPosition | null;
  target: PaneDropTarget | null;
  hoverWorkspaceId: string | null;
  dashboardChatDropPreview: DashboardChatDropPreview;
  tearOutMeasurement: TearOutMeasurementSnapshot | null;
  beginDrag: (item: PaneDragItem, pointer: PointerPosition) => void;
  moveDrag: (pointer: PointerPosition) => void;
  setTarget: (target: PaneDropTarget | null) => void;
  setHoverWorkspaceId: (workspaceId: string | null) => void;
  setDashboardChatDropPreview: (preview: DashboardChatDropPreview) => void;
  setTearOutMeasurement: (measurement: TearOutMeasurementSnapshot | null) => void;
  clearDrag: () => void;
}

export const usePaneDragStore = create<PaneDragState>((set) => ({
  item: null,
  pointer: null,
  target: null,
  hoverWorkspaceId: null,
  dashboardChatDropPreview: null,
  tearOutMeasurement: null,
  beginDrag: (item, pointer) => set({
    item,
    pointer,
    target: null,
    hoverWorkspaceId: null,
    dashboardChatDropPreview: null,
  }),
  moveDrag: (pointer) => set({ pointer }),
  setTarget: (target) => set({ target }),
  setHoverWorkspaceId: (hoverWorkspaceId) => set({ hoverWorkspaceId }),
  setDashboardChatDropPreview: (dashboardChatDropPreview) => set({ dashboardChatDropPreview }),
  setTearOutMeasurement: (tearOutMeasurement) => set({ tearOutMeasurement }),
  clearDrag: () => set({
    item: null,
    pointer: null,
    target: null,
    hoverWorkspaceId: null,
    dashboardChatDropPreview: null,
  }),
}));
