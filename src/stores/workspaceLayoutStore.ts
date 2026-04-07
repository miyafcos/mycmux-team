import { create } from "zustand";
import { v4 as uuid } from "uuid";
import type { Pane, PaneTab, GridTemplateId } from "../types";
import type { PaneConfig } from "../lib/ipc";
import { getGridTemplate } from "../lib/gridTemplates";
import { getDefaultAgent } from "../lib/agents";
import { makeSessionId } from "../lib/constants";
import { useWorkspaceListStore } from "./workspaceListStore";

/**
 * Workspace Layout Store - Manages panes within workspaces
 * Handles pane CRUD and layout (splitRows)
 */

function makeTab(workspaceId: string, paneId: string, agentId: string, type: PaneTab["type"] = "terminal"): PaneTab {
  const tabId = uuid();
  return {
    id: tabId,
    sessionId: makeSessionId(workspaceId, `${paneId}-${tabId}`),
    agentId,
    type,
  };
}

interface BuildPanesResult {
  panes: Pane[];
  splitRows: string[][];
}

function buildPanes(
  workspaceId: string,
  gridTemplateId: GridTemplateId,
  agentAssignments?: Record<number, string>,
): BuildPanesResult {
  const template = getGridTemplate(gridTemplateId);
  const defaultAgentId = getDefaultAgent().id;
  const panes: Pane[] = [];
  const splitRows: string[][] = [];

  let paneIndex = 0;
  for (let r = 0; r < template.rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < template.cols; c++) {
      if (paneIndex < template.paneCount) {
        const paneId = uuid();
        const agentId = agentAssignments?.[paneIndex] ?? defaultAgentId;
        const tab = makeTab(workspaceId, paneId, agentId);
        panes.push({
          id: paneId,
          agentId,
          sessionId: tab.sessionId,
          tabs: [tab],
          activeTabId: tab.id,
        });
        row.push(paneId);
        paneIndex++;
      }
    }
    if (row.length > 0) {
      splitRows.push(row);
    }
  }

  return { panes, splitRows };
}

interface WorkspaceLayoutState {
  // Pane operations
  removePaneFromWorkspace: (workspaceId: string, paneId: string) => void;
  addPaneToWorkspace: (
    workspaceId: string,
    afterPaneId: string,
    direction: "right" | "down",
    agentId?: string
  ) => void;
  
  // Tab operations
  addTabToPane: (workspaceId: string, paneId: string, agentId?: string, type?: PaneTab["type"]) => void;
  removeTabFromPane: (workspaceId: string, paneId: string, tabId: string) => void;
  setActivePaneTab: (workspaceId: string, paneId: string, tabId: string) => void;
  
  // Helper to build initial panes for new workspace
  buildInitialPanes: (
    workspaceId: string,
    gridTemplateId: GridTemplateId,
    agentAssignments?: Record<number, string>
  ) => BuildPanesResult;

  restorePanes: (
    workspaceId: string,
    configs: PaneConfig[],
    savedSplitRows: number[][] | null,
    gridTemplateId: GridTemplateId,
  ) => BuildPanesResult;
}

export const useWorkspaceLayoutStore = create<WorkspaceLayoutState>(() => ({
  buildInitialPanes: (workspaceId, gridTemplateId, agentAssignments) => {
    return buildPanes(workspaceId, gridTemplateId, agentAssignments);
  },

  restorePanes: (workspaceId, configs, savedSplitRows, gridTemplateId) => {
    const defaultAgentId = getDefaultAgent().id;
    const panes: Pane[] = configs.map((pc) => {
      const paneId = uuid();
      const agentId = pc.agent_id || defaultAgentId;
      const tab = makeTab(workspaceId, paneId, agentId);
      return {
        id: paneId,
        agentId,
        sessionId: tab.sessionId,
        tabs: [tab],
        activeTabId: tab.id,
        cwd: pc.cwd ?? undefined,
        label: pc.label ?? undefined,
        lastProcess: pc.last_process ?? undefined,
        claudeSessionId: pc.claude_session_id ?? undefined,
      };
    });

    let splitRows: string[][];
    if (savedSplitRows && savedSplitRows.length > 0) {
      splitRows = savedSplitRows
        .map((row) => row.map((idx) => panes[idx]?.id).filter(Boolean) as string[])
        .filter((row) => row.length > 0);
    } else {
      const template = getGridTemplate(gridTemplateId);
      splitRows = [];
      let idx = 0;
      for (let r = 0; r < template.rows && idx < panes.length; r++) {
        const row: string[] = [];
        for (let c = 0; c < template.cols && idx < panes.length; c++) {
          row.push(panes[idx].id);
          idx++;
        }
        if (row.length > 0) splitRows.push(row);
      }
      if (idx < panes.length) {
        const lastRow = splitRows[splitRows.length - 1] ?? [];
        for (; idx < panes.length; idx++) {
          lastRow.push(panes[idx].id);
        }
        if (splitRows.length === 0) splitRows.push(lastRow);
      }
    }

    return { panes, splitRows };
  },

  removePaneFromWorkspace: (workspaceId, paneId) => {
    const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    if (!workspace) return;
    if (workspace.panes.length <= 1) return; // never remove last pane

    const newPanes = workspace.panes.filter((p) => p.id !== paneId);
    
    // Update splitRows if present
    let newSplitRows = workspace.splitRows;
    if (newSplitRows) {
      newSplitRows = newSplitRows
        .map((row) => row.filter((id) => id !== paneId))
        .filter((row) => row.length > 0);
    }

    useWorkspaceListStore.getState()._updateWorkspacePanes(workspaceId, newPanes, newSplitRows);
  },

  addPaneToWorkspace: (workspaceId, afterPaneId, direction, agentId) => {
    const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    if (!workspace) return;

    // Always use default agent for new split panes (unless explicitly specified)
    const agId = agentId ?? getDefaultAgent().id;
    const paneId = uuid();
    const tab = makeTab(workspaceId, paneId, agId);
    const newPane: Pane = {
      id: paneId,
      agentId: agId,
      sessionId: tab.sessionId,
      tabs: [tab],
      activeTabId: tab.id,
    };
    const newPanes = [...workspace.panes, newPane];

    // Initialize splitRows if not present
    const existingRows: string[][] = workspace.splitRows ?? [workspace.panes.map((p) => p.id)];

    let newSplitRows: string[][];
    if (direction === "right") {
      // Insert new pane ID after afterPaneId in its row
      newSplitRows = existingRows.map((row) => {
        const idx = row.indexOf(afterPaneId);
        if (idx === -1) return row;
        const newRow = [...row];
        newRow.splice(idx + 1, 0, paneId);
        return newRow;
      });
    } else {
      // direction === "down": insert new row after the row containing afterPaneId
      newSplitRows = [];
      for (const row of existingRows) {
        newSplitRows.push(row);
        if (row.includes(afterPaneId)) {
          newSplitRows.push([paneId]);
        }
      }
    }

    useWorkspaceListStore.getState()._updateWorkspacePanes(workspaceId, newPanes, newSplitRows);
  },

  addTabToPane: (workspaceId, paneId, agentId, type = "terminal") => {
    const start = performance.now();
    const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    if (!workspace) return;

    const newPanes = workspace.panes.map((p) => {
      if (p.id !== paneId) return p;
      const agId = agentId ?? p.agentId;
      const tab = makeTab(workspaceId, paneId, agId, type);
      return {
        ...p,
        tabs: [...p.tabs, tab],
        activeTabId: tab.id,
        sessionId: tab.sessionId,
      };
    });

    useWorkspaceListStore.getState()._updateWorkspacePanes(workspaceId, newPanes);
    console.log(`[PERF] Tab create (layout store): ${(performance.now() - start).toFixed(2)}ms`);
  },

  removeTabFromPane: (workspaceId, paneId, tabId) => {
    const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    if (!workspace) return;

    const newPanes = workspace.panes.flatMap((p) => {
      if (p.id !== paneId) return [p];
      const remaining = p.tabs.filter((t) => t.id !== tabId);
      if (remaining.length === 0) return []; // remove pane if no tabs left
      const newActiveId = p.activeTabId === tabId ? remaining[remaining.length - 1].id : p.activeTabId;
      const activeTab = remaining.find((t) => t.id === newActiveId) ?? remaining[0];
      return [{ ...p, tabs: remaining, activeTabId: newActiveId, sessionId: activeTab.sessionId }];
    });

    useWorkspaceListStore.getState()._updateWorkspacePanes(workspaceId, newPanes);
  },

  setActivePaneTab: (workspaceId, paneId, tabId) => {
    const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    if (!workspace) return;

    const newPanes = workspace.panes.map((p) => {
      if (p.id !== paneId) return p;
      const tab = p.tabs.find((t) => t.id === tabId);
      if (!tab) return p;
      return { ...p, activeTabId: tabId, sessionId: tab.sessionId };
    });

    useWorkspaceListStore.getState()._updateWorkspacePanes(workspaceId, newPanes);
  },
}));
