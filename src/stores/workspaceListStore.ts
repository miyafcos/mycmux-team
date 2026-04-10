import { create } from "zustand";
import { v4 as uuid } from "uuid";
import type { Workspace, GridTemplateId } from "../types";
import { useUiStore } from "./uiStore";

const WORKSPACE_COLORS = ["#89b4fa", "#a6e3a1", "#f9e2af", "#f38ba8", "#94e2d5", "#f5c2e7"];

interface CreateWorkspaceOptions {
  id?: string;
  createdAt?: number;
  color?: string;
  rowSizes?: number[];
  columnSizes?: number[][];
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
    splitRows: string[][],
    options?: CreateWorkspaceOptions,
  ) => Workspace;
  removeWorkspace: (id: string) => void;
  setActiveWorkspace: (id: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  setWorkspaceStatus: (id: string, status: Workspace["status"]) => void;
  setWorkspaceLayoutMetrics: (
    id: string,
    rowSizes?: number[],
    columnSizes?: number[][],
  ) => void;
  
  // Internal update for layout store to modify panes
  _updateWorkspacePanes: (
    id: string,
    panes: Workspace["panes"],
    splitRows?: string[][],
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

  createWorkspace: (name, gridTemplateId, panes, splitRows, options) => {
    const id = options?.id ?? uuid();
    const { workspaces } = get();
    const autoColor = options?.color ?? WORKSPACE_COLORS[workspaces.length % WORKSPACE_COLORS.length];
    
    const workspace: Workspace = {
      id,
      name,
      gridTemplateId,
      panes,
      splitRows,
      status: "running",
      createdAt: options?.createdAt ?? Date.now(),
      color: autoColor,
      rowSizes: options?.rowSizes,
      columnSizes: options?.columnSizes,
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

  setWorkspaceLayoutMetrics: (id, rowSizes, columnSizes) => {
    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === id
          ? { ...w, rowSizes, columnSizes }
          : w
      ),
    }));
  },

  _updateWorkspacePanes: (id, panes, splitRows, resetLayoutMetrics = false) => {
    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === id
          ? {
              ...w,
              panes,
              ...(splitRows !== undefined && { splitRows }),
              ...(resetLayoutMetrics ? { rowSizes: undefined, columnSizes: undefined } : {}),
            }
          : w
      ),
    }));
  },
}));
