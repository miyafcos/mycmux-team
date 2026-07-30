import { create } from "zustand";
import { v4 as uuid } from "uuid";
import type { Workspace, GridTemplateId, AgentSessionKind } from "../types";
import { normalizeReadableSplitColumns, reconcileSplitColumnsForPanes } from "../lib/layoutColumns";
import {
  columnWidthsMatch,
  fallbackColumns,
  reconcileLayoutMetrics,
  rowHeightsMatch,
} from "../lib/layoutMetrics";
import { useUiStore } from "./uiStore";
import { applyStructuralActivation } from "../lib/focusController";
import { useToastStore } from "./toastStore";
import { bump as bumpPaintStat } from "../lib/paintStats";

function workspaceContainsPane(workspace: Workspace | undefined, paneId: string | null): boolean {
  return Boolean(paneId && workspace?.panes.some((pane) => pane.id === paneId));
}

function workspaceContainsSession(workspace: Workspace | undefined, sessionId: string | null): boolean {
  return Boolean(
    sessionId
      && workspace?.panes.some((pane) =>
        pane.sessionId === sessionId || pane.tabs.some((tab) => tab.sessionId === sessionId),
      ),
  );
}

function clearZoomIfMissingFromWorkspace(workspace: Workspace | undefined): void {
  const uiState = useUiStore.getState();
  if (uiState.zoomedPaneId && !workspaceContainsPane(workspace, uiState.zoomedPaneId)) {
    uiState.setZoomedPaneId(null);
  }
}

function normalizeSplitColumns(splitColumns: string[][], paneIds: string[]): string[][] {
  return reconcileSplitColumnsForPanes(normalizeReadableSplitColumns(splitColumns), paneIds);
}

function paneIdsChanged(previousPanes: Workspace["panes"], nextPanes: Workspace["panes"]): boolean {
  if (previousPanes.length !== nextPanes.length) return true;
  const previousPaneIds = new Set(previousPanes.map((pane) => pane.id));
  return nextPanes.some((pane) => !previousPaneIds.has(pane.id));
}

function splitColumnsChanged(previousColumns: string[][], nextColumns: string[][]): boolean {
  if (previousColumns.length !== nextColumns.length) return true;
  return previousColumns.some((previousColumn, columnIndex) => {
    const nextColumn = nextColumns[columnIndex];
    return previousColumn.length !== nextColumn.length
      || previousColumn.some((paneId, rowIndex) => paneId !== nextColumn[rowIndex]);
  });
}

export interface PaneAgentSessionPayload {
  claudeSessionId?: string;
  agentKind?: AgentSessionKind;
  agentSessionId?: string;
}

export interface PaneAgentSessionConflict {
  key: string;
  ownerSessionId: string;
  incomingSessionId: string;
}

export interface PaneAgentSessionUpdateResult {
  accepted: boolean;
  applied: boolean;
  conflict?: PaneAgentSessionConflict;
}

const reportedLiveAgentSessionConflicts = new Set<string>();

export function agentSessionIdentityKey(
  agentKind: AgentSessionKind | undefined,
  agentSessionId: string | undefined,
  claudeSessionId: string | undefined,
): string | null {
  const kind = agentKind ?? (claudeSessionId ? "claude" : undefined);
  const sessionId = agentSessionId ?? claudeSessionId;
  return kind && sessionId ? `${kind}:${sessionId}` : null;
}

function paneAgentSessionKey(pane: Workspace["panes"][number]): string | null {
  return agentSessionIdentityKey(pane.agentKind, pane.agentSessionId, pane.claudeSessionId);
}

function tabAgentSessionKey(tab: Workspace["panes"][number]["tabs"][number]): string | null {
  return agentSessionIdentityKey(tab.agentKind, tab.agentSessionId, tab.claudeSessionId);
}

function findAgentSessionTarget(
  workspaces: Workspace[],
  terminalSessionId: string,
): Workspace["panes"][number] | Workspace["panes"][number]["tabs"][number] | null {
  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      const tab = pane.tabs.find((candidate) => candidate.sessionId === terminalSessionId);
      if (tab) return tab;
      if (pane.sessionId === terminalSessionId) return pane;
    }
  }
  return null;
}

function findOtherAgentSessionOwner(
  workspaces: Workspace[],
  key: string,
  incomingSessionId: string,
): string | null {
  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      if (pane.tabs.length === 0) {
        if (pane.sessionId !== incomingSessionId && paneAgentSessionKey(pane) === key) {
          return pane.sessionId;
        }
        continue;
      }
      for (const tab of pane.tabs) {
        if (tab.sessionId !== incomingSessionId && tabAgentSessionKey(tab) === key) {
          return tab.sessionId;
        }
      }
    }
  }
  return null;
}

function reportLiveAgentSessionConflict(conflict: PaneAgentSessionConflict): void {
  const signature = `${conflict.key}|${conflict.ownerSessionId}|${conflict.incomingSessionId}`;
  if (reportedLiveAgentSessionConflicts.has(signature)) return;
  reportedLiveAgentSessionConflicts.add(signature);
  console.warn("[persist] rejected duplicate live agent session claim:", conflict);
  useToastStore
    .getState()
    .pushToast("同じ会話IDが別のタブにあるため、重複した復元割り当てを止めました", "warning");
}

function clearReportedLiveAgentSessionConflicts(sessionId: string, key?: string | null): void {
  for (const signature of reportedLiveAgentSessionConflicts) {
    const [reportedKey, ownerSessionId, incomingSessionId] = signature.split("|");
    if ((key === undefined || key === null || reportedKey === key)
      && (ownerSessionId === sessionId || incomingSessionId === sessionId)) {
      reportedLiveAgentSessionConflicts.delete(signature);
    }
  }
}

export function __resetLiveAgentSessionConflictReporterForTests(): void {
  reportedLiveAgentSessionConflicts.clear();
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
  lastActivePaneByWorkspace: Record<string, string>;

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
  ) => PaneAgentSessionUpdateResult;
}

export const useWorkspaceListStore = create<WorkspaceListState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  lastActivePaneByWorkspace: {},

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
      const { [id]: _removed, ...lastActivePaneByWorkspace } = state.lastActivePaneByWorkspace;
      return { workspaces: remaining, activeWorkspaceId: newActiveId, lastActivePaneByWorkspace };
    });
    const { workspaces, activeWorkspaceId } = get();
    clearZoomIfMissingFromWorkspace(workspaces.find((w) => w.id === activeWorkspaceId));
  },

  setActiveWorkspace: (id) => {
    const state = get();
    const workspace = state.workspaces.find((w) => w.id === id);
    if (workspace && state.activeWorkspaceId !== id) {
      bumpPaintStat("tab-switch");
    }
    const uiState = useUiStore.getState();
    const currentActivePaneId = uiState.activePaneId;
    let lastActivePaneByWorkspace = state.lastActivePaneByWorkspace;
    if (state.activeWorkspaceId && currentActivePaneId) {
      lastActivePaneByWorkspace = {
        ...lastActivePaneByWorkspace,
        [state.activeWorkspaceId]: currentActivePaneId,
      };
    }

    const recordedPaneId = lastActivePaneByWorkspace[id] ?? null;
    const recordedPaneIsValid = workspaceContainsSession(workspace, recordedPaneId);
    const nextActivePaneId = recordedPaneIsValid
      ? recordedPaneId
      : workspace?.panes[0]?.sessionId ?? null;

    if (recordedPaneId && !recordedPaneIsValid) {
      const { [id]: _stale, ...rest } = lastActivePaneByWorkspace;
      lastActivePaneByWorkspace = rest;
    }

    set({ activeWorkspaceId: id, lastActivePaneByWorkspace });
    applyStructuralActivation(nextActivePaneId);
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
        const columns = fallbackColumns(w.splitColumns, w.panes.map((pane) => pane.id));
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
        const paneIds = panes.map((pane) => pane.id);
        const panesChanged = paneIdsChanged(w.panes, panes);
        const previousSplitColumns = fallbackColumns(w.splitColumns, w.panes.map((pane) => pane.id));
        const normalizedSplitColumns = normalizeSplitColumns(
          splitColumns ?? previousSplitColumns,
          paneIds,
        );
        const splitLayoutChanged = splitColumnsChanged(previousSplitColumns, normalizedSplitColumns);
        const layoutMetrics = reconcileLayoutMetrics(
          previousSplitColumns,
          w.columnWidths,
          w.rowHeightsPerCol,
          normalizedSplitColumns,
          resetLayoutMetrics || panesChanged || splitLayoutChanged,
        );
        return {
          ...w,
          panes,
          splitColumns: normalizedSplitColumns,
          ...(layoutMetrics ?? {}),
        };
      }),
    }));
  },

  setPaneAgentSessionFromMetadata: (sessionId, payload) => {
    let result: PaneAgentSessionUpdateResult = { accepted: true, applied: false };
    set((state) => {
      if (payload !== null) {
        const target = findAgentSessionTarget(state.workspaces, sessionId);
        const mergedKind = payload.agentKind ?? target?.agentKind;
        const mergedClaudeId = payload.claudeSessionId ?? target?.claudeSessionId;
        const mergedAgentId = payload.agentSessionId ?? target?.agentSessionId;
        const incomingKey = agentSessionIdentityKey(mergedKind, mergedAgentId, mergedClaudeId);
        if (incomingKey) {
          // Keep the established owner. Monitor metadata is heuristic and can
          // transiently point a live pane at a dormant pane's saved identity;
          // transferring ownership here would destroy the known-good marker.
          const ownerSessionId = findOtherAgentSessionOwner(state.workspaces, incomingKey, sessionId);
          if (ownerSessionId) {
            result = {
              accepted: false,
              applied: false,
              conflict: {
                key: incomingKey,
                ownerSessionId,
                incomingSessionId: sessionId,
              },
            };
            return state;
          }
        }
        if (!target) return state;
      }

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
      result = { accepted: true, applied: mutated };
      return mutated ? { workspaces } : state;
    });
    if (result.conflict) {
      reportLiveAgentSessionConflict(result.conflict);
    } else {
      const key = payload === null
        ? null
        : agentSessionIdentityKey(payload.agentKind, payload.agentSessionId, payload.claudeSessionId);
      clearReportedLiveAgentSessionConflicts(sessionId, key);
    }
    return result;
  },
}));
