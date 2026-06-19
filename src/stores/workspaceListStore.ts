import { create } from "zustand";
import { v4 as uuid } from "uuid";
import type { Workspace, GridTemplateId, AgentSessionKind } from "../types";
import { normalizeReadableSplitColumns, reconcileSplitColumnsForPanes } from "../lib/layoutColumns";
import { useUiStore } from "./uiStore";

function workspaceContainsPane(workspace: Workspace | undefined, paneId: string | null): boolean {
  return Boolean(paneId && workspace?.panes.some((pane) => pane.id === paneId));
}

function clearZoomIfMissingFromWorkspace(workspace: Workspace | undefined): void {
  const uiState = useUiStore.getState();
  if (uiState.zoomedPaneId && !workspaceContainsPane(workspace, uiState.zoomedPaneId)) {
    uiState.setZoomedPaneId(null);
  }
}

const DEFAULT_LAYOUT_SIZE = 1;

function fallbackColumns(workspace: Workspace): string[][] {
  return workspace.splitColumns && workspace.splitColumns.length > 0
    ? workspace.splitColumns
    : [workspace.panes.map((pane) => pane.id)];
}

function normalizeSplitColumns(splitColumns: string[][], paneIds: string[]): string[][] {
  return reconcileSplitColumnsForPanes(normalizeReadableSplitColumns(splitColumns), paneIds);
}

function columnWidthsMatch(columns: string[][], columnWidths: number[] | undefined): boolean {
  return Boolean(
    columnWidths
      && columnWidths.length === columns.length
      && columnWidths.every((size) => positiveSize(size) !== null),
  );
}

function rowHeightsMatch(columns: string[][], rowHeightsPerCol: number[][] | undefined): boolean {
  return Boolean(
    rowHeightsPerCol
      && rowHeightsPerCol.length === columns.length
      && rowHeightsPerCol.every((row, index) =>
        row.length === columns[index].length
        && row.every((size) => positiveSize(size) !== null),
      ),
  );
}

function bestPreviousColumnIndex(
  nextColumn: string[],
  previousColumns: string[][],
  usedIndices: Set<number>,
): number {
  let bestIndex = -1;
  let bestOverlap = 0;
  for (let index = 0; index < previousColumns.length; index += 1) {
    if (usedIndices.has(index)) continue;
    const overlap = nextColumn.filter((paneId) => previousColumns[index].includes(paneId)).length;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function columnsRequireBalancedWidths(previousColumns: string[][], nextColumns: string[][]): boolean {
  if (previousColumns.length !== nextColumns.length) return true;
  const usedIndices = new Set<number>();
  return nextColumns.some((nextColumn) => {
    const previousIndex = bestPreviousColumnIndex(nextColumn, previousColumns, usedIndices);
    if (previousIndex < 0) return true;
    usedIndices.add(previousIndex);
    return false;
  });
}

function positiveSize(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function reconcileColumnWidths(workspace: Workspace, nextColumns: string[][]): number[] | undefined {
  if (nextColumns.length === 0) return undefined;
  const previousColumns = fallbackColumns(workspace);
  if (columnsRequireBalancedWidths(previousColumns, nextColumns)) {
    return nextColumns.map(() => DEFAULT_LAYOUT_SIZE);
  }
  const previousWidths = workspace.columnWidths;
  const usedIndices = new Set<number>();

  return nextColumns.map((nextColumn) => {
    const previousIndex = bestPreviousColumnIndex(nextColumn, previousColumns, usedIndices);
    if (previousIndex >= 0) {
      usedIndices.add(previousIndex);
      const previousWidth = positiveSize(previousWidths?.[previousIndex]);
      if (previousWidth !== null) return previousWidth;
    }
    return DEFAULT_LAYOUT_SIZE;
  });
}

function reconcileRowHeightsPerCol(workspace: Workspace, nextColumns: string[][]): number[][] | undefined {
  if (nextColumns.length === 0) return undefined;
  const previousColumns = fallbackColumns(workspace);
  const previousRows = workspace.rowHeightsPerCol;
  const usedIndices = new Set<number>();

  return nextColumns.map((nextColumn) => {
    const previousIndex = bestPreviousColumnIndex(nextColumn, previousColumns, usedIndices);
    if (previousIndex >= 0) {
      usedIndices.add(previousIndex);
      const previousHeights = previousRows?.[previousIndex];
      if (
        previousHeights
        && previousHeights.length === nextColumn.length
        && previousHeights.every((size) => positiveSize(size) !== null)
      ) {
        return previousHeights;
      }
    }
    return nextColumn.map(() => DEFAULT_LAYOUT_SIZE);
  });
}

function reconcileLayoutMetrics(
  workspace: Workspace,
  nextSplitColumns: string[][] | undefined,
  resetLayoutMetrics: boolean,
): Pick<Workspace, "columnWidths" | "rowHeightsPerCol"> | undefined {
  if (!resetLayoutMetrics) return undefined;
  if (!nextSplitColumns || nextSplitColumns.length === 0) {
    return { columnWidths: undefined, rowHeightsPerCol: undefined };
  }
  return {
    columnWidths: reconcileColumnWidths(workspace, nextSplitColumns),
    rowHeightsPerCol: reconcileRowHeightsPerCol(workspace, nextSplitColumns),
  };
}

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
    const normalizedSplitColumns = normalizeSplitColumns(splitColumns, panes.map((pane) => pane.id));

    const workspace: Workspace = {
      id,
      name,
      gridTemplateId,
      panes,
      splitColumns: normalizedSplitColumns,
      status: "running",
      createdAt: options?.createdAt ?? Date.now(),
      color: options?.color,
      columnWidths: columnWidthsMatch(normalizedSplitColumns, options?.columnWidths)
        ? options?.columnWidths
        : undefined,
      rowHeightsPerCol: rowHeightsMatch(normalizedSplitColumns, options?.rowHeightsPerCol)
        ? options?.rowHeightsPerCol
        : undefined,
    };

    set((state) => ({
      workspaces: [...state.workspaces, workspace],
      activeWorkspaceId: options?.activate === false ? state.activeWorkspaceId : id,
    }));

    if (options?.activate !== false) {
      clearZoomIfMissingFromWorkspace(workspace);
    }

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
    const { workspaces, activeWorkspaceId } = get();
    clearZoomIfMissingFromWorkspace(workspaces.find((w) => w.id === activeWorkspaceId));
  },

  setActiveWorkspace: (id) => {
    const workspace = get().workspaces.find((w) => w.id === id);
    const uiState = useUiStore.getState();
    const currentActivePaneId = uiState.activePaneId;
    const nextActivePaneId = workspace?.panes.find((pane) => pane.sessionId === currentActivePaneId)?.sessionId
      ?? workspace?.panes[0]?.sessionId
      ?? null;
    set({ activeWorkspaceId: id });
    uiState.setActivePaneId(nextActivePaneId);
    clearZoomIfMissingFromWorkspace(workspace);
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
      workspaces: state.workspaces.map((w) => {
        if (w.id !== id) return w;
        const columns = fallbackColumns(w);
        return {
          ...w,
          columnWidths: columnWidthsMatch(columns, columnWidths) ? columnWidths : undefined,
          rowHeightsPerCol: rowHeightsMatch(columns, rowHeightsPerCol) ? rowHeightsPerCol : undefined,
        };
      }),
    }));
  },

  _updateWorkspacePanes: (id, panes, splitColumns, resetLayoutMetrics = false) => {
    set((state) => ({
      workspaces: state.workspaces.map((w) => {
        if (w.id !== id) return w;
        const normalizedSplitColumns = splitColumns !== undefined
          ? normalizeSplitColumns(splitColumns, panes.map((pane) => pane.id))
          : undefined;
        const layoutMetrics = reconcileLayoutMetrics(w, normalizedSplitColumns, resetLayoutMetrics);
        return {
          ...w,
          panes,
          ...(normalizedSplitColumns !== undefined && { splitColumns: normalizedSplitColumns }),
          ...(layoutMetrics ?? {}),
        };
      }),
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
