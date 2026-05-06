import { create } from "zustand";
import { v4 as uuid } from "uuid";
import type { Workspace, GridTemplateId, AgentSessionKind } from "../types";
import { useUiStore } from "./uiStore";

export interface PaneAgentSessionPayload {
  claudeSessionId?: string;
  agentKind?: AgentSessionKind;
  agentSessionId?: string;
}

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

  /**
   * Sync live agent session metadata (from Rust pty_metadata event) into
   * Pane.claudeSessionId / agentKind / agentSessionId so that toConfig() can
   * persist them. `sessionId` matches either pane.sessionId or any tab.sessionId.
   * Pass `null` to clear (e.g. when the pane returns to a bare shell).
   */
  setPaneAgentSessionFromMetadata: (
    sessionId: string,
    payload: PaneAgentSessionPayload | null,
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

    const workspace: Workspace = {
      id,
      name,
      gridTemplateId,
      panes,
      splitColumns,
      status: "running",
      createdAt: options?.createdAt ?? Date.now(),
      color: options?.color,
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

  setPaneAgentSessionFromMetadata: (sessionId, payload) => {
    set((state) => {
      let mutated = false;
      const workspaces = state.workspaces.map((ws) => {
        let workspaceMutated = false;
        const panes = ws.panes.map((pane) => {
          const tabIdx = pane.tabs.findIndex((t) => t.sessionId === sessionId);
          const isPaneMatch = pane.sessionId === sessionId;
          if (tabIdx === -1 && !isPaneMatch) return pane;

          const tabs = pane.tabs.map((tab, i) => {
            if (i !== tabIdx) return tab;
            if (payload === null) {
              const next = { ...tab };
              delete next.claudeSessionId;
              delete next.agentKind;
              delete next.agentSessionId;
              return next;
            }
            return {
              ...tab,
              claudeSessionId: payload.claudeSessionId ?? tab.claudeSessionId,
              agentKind: payload.agentKind ?? tab.agentKind,
              agentSessionId: payload.agentSessionId ?? tab.agentSessionId,
            };
          });

          // Mirror the live session onto the pane only when the matched tab is
          // active (or when the match was on pane.sessionId itself).
          const matchedTab = tabIdx >= 0 ? pane.tabs[tabIdx] : null;
          const mirrorOntoPane =
            isPaneMatch || (matchedTab !== null && matchedTab.id === pane.activeTabId);

          let nextPane: typeof pane;
          if (!mirrorOntoPane) {
            nextPane = { ...pane, tabs };
          } else if (payload === null) {
            const cleared = { ...pane, tabs };
            delete cleared.claudeSessionId;
            delete cleared.agentKind;
            delete cleared.agentSessionId;
            nextPane = cleared;
          } else {
            nextPane = {
              ...pane,
              tabs,
              claudeSessionId: payload.claudeSessionId ?? pane.claudeSessionId,
              agentKind: payload.agentKind ?? pane.agentKind,
              agentSessionId: payload.agentSessionId ?? pane.agentSessionId,
            };
          }
          workspaceMutated = true;
          return nextPane;
        });
        if (!workspaceMutated) return ws;
        mutated = true;
        return { ...ws, panes };
      });
      return mutated ? { workspaces } : state;
    });
  },
}));
