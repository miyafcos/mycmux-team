import { create } from "zustand";
import { v4 as uuid } from "uuid";
import type { Workspace, GridTemplateId } from "../types";
import { WORKSPACE_COLORS } from "../lib/workspaceColors";
import { useUiStore } from "./uiStore";

interface CreateWorkspaceOptions {
  id?: string;
  createdAt?: number;
  color?: string;
  columnWidths?: number[];
  rowHeightsPerCol?: number[][];
  activate?: boolean;
}

/**
 * Workspace List Store - Manages workspace CRUD and active selection
 * Separated from layout/panes to minimize re-renders
 */
interface WorkspaceListState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;

  // Getters
  getActiveWorkspace: () => Workspace | undefined;
  getWorkspace: (id: string) => Workspace | undefined;

  // Workspace CRUD
  createWorkspace: (
    name: string,
    gridTemplateId: GridTemplateId,
    panes: Workspace["panes"],
    splitColumns: string[][],
    options?: CreateWorkspaceOptions,
  ) => Workspace;
  removeWorkspace: (id: string) => void;
  setActiveWorkspace: (id: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  setWorkspaceStatus: (id: string, status: Workspace["status"]) => void;
  reorderWorkspaces: (fromIndex: number, toIndex: number) => void;
  setWorkspaceLayoutMetrics: (
    id: string,
    columnWidths?: number[],
    rowHeightsPerCol?: number[][],
  ) => void;
  
  // Internal update for layout store to modify panes
  _updateWorkspacePanes: (
    id: string,
    panes: Workspace["panes"],
    splitColumns?: string[][],
    resetLayoutMetrics?: boolean,
  ) => void;
}

export const useWorkspaceListStore = create<WorkspaceListState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,

  getActiveWorkspace: () => {
    const { workspaces, activeWorkspaceId } = get();
    return workspaces.find((w) => w.id === activeWorkspaceId);
  },

  getWorkspace: (id) => {
    return get().workspaces.find((w) => w.id === id);
  },

  createWorkspace: (name, gridTemplateId, panes, splitColumns, options) => {
    const id = options?.id ?? uuid();
    const { workspaces } = get();
    const autoColor = options?.color ?? WORKSPACE_COLORS[workspaces.length % WORKSPACE_COLORS.length];

    const workspace: Workspace = {
      id,
      name,
      gridTemplateId,
      panes,
      splitColumns,
      status: "running",
      createdAt: options?.createdAt ?? Date.now(),
      color: autoColor,
      columnWidths: options?.columnWidths,
      rowHeightsPerCol: options?.rowHeightsPerCol,
    };

    set((state) => ({
      workspaces: [...state.workspaces, workspace],
      activeWorkspaceId: options?.activate === false ? state.activeWorkspaceId : id,
    }));

    return workspace;
  },

  removeWorkspace: (id) => {
    set((state) => {
      const remaining = state.workspaces.filter((w) => w.id !== id);
      const newActiveId =
        state.activeWorkspaceId === id
          ? remaining[remaining.length - 1]?.id ?? null
          : state.activeWorkspaceId;
      return { workspaces: remaining, activeWorkspaceId: newActiveId };
    });
  },

  setActiveWorkspace: (id) => {
    const workspace = get().workspaces.find((w) => w.id === id);
    const currentActivePaneId = useUiStore.getState().activePaneId;
    const nextActivePaneId = workspace?.panes.find((pane) => pane.sessionId === currentActivePaneId)?.sessionId
      ?? workspace?.panes[0]?.sessionId
      ?? null;
    set({ activeWorkspaceId: id });
    useUiStore.getState().setActivePaneId(nextActivePaneId);
  },

  renameWorkspace: (id, name) => {
    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === id ? { ...w, name } : w
      ),
    }));
  },

  setWorkspaceStatus: (id, status) => {
    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === id ? { ...w, status } : w
      ),
    }));
  },

  reorderWorkspaces: (fromIndex, toIndex) => {
    set((state) => {
      if (fromIndex === toIndex) return state;
      const next = [...state.workspaces];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return { workspaces: next };
    });
  },

  setWorkspaceLayoutMetrics: (id, columnWidths, rowHeightsPerCol) => {
    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === id
          ? { ...w, columnWidths, rowHeightsPerCol }
          : w
      ),
    }));
  },

  _updateWorkspacePanes: (id, panes, splitColumns, resetLayoutMetrics = false) => {
    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === id
          ? {
              ...w,
              panes,
              ...(splitColumns !== undefined && { splitColumns }),
              ...(resetLayoutMetrics ? { columnWidths: undefined, rowHeightsPerCol: undefined } : {}),
            }
          : w
      ),
    }));
  },
}));
