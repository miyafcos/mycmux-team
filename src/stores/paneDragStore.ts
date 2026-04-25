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
      kind: "new-workspace";
    };

interface PointerPosition {
  x: number;
  y: number;
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
