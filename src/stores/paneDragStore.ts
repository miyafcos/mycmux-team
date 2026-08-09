import { create } from "zustand";

export type PaneDropZone = "center" | "left" | "right" | "up" | "down";

export type PaneDragItem =
  | {
      kind: "tab";
      workspaceId: string;
      paneId: string;
      tabId: string;
      label: string;
    }
  | {
      kind: "pane";
      workspaceId: string;
      paneId: string;
      label: string;
      tabCount: number;
    };

export type PaneDropTarget =
  | {
      kind: "pane";
      workspaceId: string;
      paneId: string;
      zone: PaneDropZone;
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
  beginDrag: (item: PaneDragItem, pointer: PointerPosition) => void;
  moveDrag: (pointer: PointerPosition) => void;
  setTarget: (target: PaneDropTarget | null) => void;
  setHoverWorkspaceId: (workspaceId: string | null) => void;
  clearDrag: () => void;
}

export const usePaneDragStore = create<PaneDragState>((set) => ({
  item: null,
  pointer: null,
  target: null,
  hoverWorkspaceId: null,
  beginDrag: (item, pointer) => set({
    item,
    pointer,
    target: null,
    hoverWorkspaceId: null,
  }),
  moveDrag: (pointer) => set({ pointer }),
  setTarget: (target) => set({ target }),
  setHoverWorkspaceId: (hoverWorkspaceId) => set({ hoverWorkspaceId }),
  clearDrag: () => set({
    item: null,
    pointer: null,
    target: null,
    hoverWorkspaceId: null,
  }),
}));
