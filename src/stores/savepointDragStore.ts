import { create } from "zustand";
import type { AgentSessionKind } from "../types";

export interface SavepointDragItem {
  kind: "savepoint";
  sourceWorkspaceId: string;
  bundleDir: string;
  label: string;
  sourceSessionId: string;
  sourceAgentKind: "claude" | "codex";
  checkpointId?: string | null;
}

export interface SavepointPasteDropTarget {
  mode: "paste";
  workspaceId: string;
  paneId: string;
  tabId: string;
  sessionId: string;
  targetKind: AgentSessionKind;
}

export interface SavepointSpawnDropTarget {
  mode: "spawn";
  workspaceId: string;
  paneId: string;
  direction: "left" | "right";
}

export interface SavepointExportDropTarget {
  mode: "export";
}

export type SavepointDropTarget =
  | SavepointPasteDropTarget
  | SavepointSpawnDropTarget
  | SavepointExportDropTarget;

interface PointerPosition {
  x: number;
  y: number;
}

export type SavepointDragOwner = symbol;

interface SavepointDragState {
  item: SavepointDragItem | null;
  pointer: PointerPosition | null;
  target: SavepointDropTarget | null;
  hoverWorkspaceId: string | null;
  owner: SavepointDragOwner | null;
  beginDrag: (
    item: SavepointDragItem,
    pointer: PointerPosition,
    owner: SavepointDragOwner,
  ) => boolean;
  moveDrag: (pointer: PointerPosition) => void;
  setTarget: (target: SavepointDropTarget | null) => void;
  setHoverWorkspaceId: (workspaceId: string | null) => void;
  clearDrag: (owner?: SavepointDragOwner) => void;
}

export const useSavepointDragStore = create<SavepointDragState>((set, get) => ({
  item: null,
  pointer: null,
  target: null,
  hoverWorkspaceId: null,
  owner: null,
  beginDrag: (item, pointer, owner) => {
    if (get().item !== null || get().owner !== null) return false;
    set({
      item,
      pointer,
      target: null,
      hoverWorkspaceId: null,
      owner,
    });
    return true;
  },
  moveDrag: (pointer) => set({ pointer }),
  setTarget: (target) => set({ target }),
  setHoverWorkspaceId: (hoverWorkspaceId) => set({ hoverWorkspaceId }),
  clearDrag: (owner) => {
    if (owner !== undefined && get().owner !== owner) return;
    set({
      item: null,
      pointer: null,
      target: null,
      hoverWorkspaceId: null,
      owner: null,
    });
  },
}));
