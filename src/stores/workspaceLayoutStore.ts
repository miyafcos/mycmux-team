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
 * Handles pane CRUD and layout (splitColumns)
 */

function makeTab(
  workspaceId: string,
  paneId: string,
  agentId: string,
  type: PaneTab["type"] = "terminal",
  options?: Partial<Pick<PaneTab, "id" | "label" | "cwd" | "lastProcess" | "claudeSessionId">>,
): PaneTab {
  const tabId = options?.id ?? uuid();
  return {
    id: tabId,
    sessionId: makeSessionId(workspaceId, `${paneId}-${tabId}`),
    agentId,
    label: options?.label,
    type,
    cwd: options?.cwd,
    lastProcess: options?.lastProcess,
    claudeSessionId: options?.claudeSessionId,
  };
}

function normalizeRestoredAgentId(
  agentId: string | null | undefined,
): string {
  if (agentId === "shell-starter") {
    return "shell";
  }
  return agentId || getDefaultAgent().id;
}

interface BuildPanesResult {
  panes: Pane[];
  splitColumns: string[][];
}

function buildPanes(
  workspaceId: string,
  gridTemplateId: GridTemplateId,
  agentAssignments?: Record<number, string>,
): BuildPanesResult {
  const template = getGridTemplate(gridTemplateId);
  const defaultAgentId = getDefaultAgent().id;
  const panes: Pane[] = [];
  const splitColumns: string[][] = [];

  // Column-major fill: iterate columns first, then rows within each column
  let paneIndex = 0;
  for (let c = 0; c < template.cols; c++) {
    const col: string[] = [];
    for (let r = 0; r < template.rows; r++) {
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
        col.push(paneId);
        paneIndex++;
      }
    }
    if (col.length > 0) {
      splitColumns.push(col);
    }
  }

  return { panes, splitColumns };
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
  setTabAgentId: (workspaceId: string, paneId: string, tabId: string, agentId: string) => void;
  
  // Helper to build initial panes for new workspace
  buildInitialPanes: (
    workspaceId: string,
    gridTemplateId: GridTemplateId,
    agentAssignments?: Record<number, string>
  ) => BuildPanesResult;

  restorePanes: (
    workspaceId: string,
    configs: PaneConfig[],
    savedSplitColumns: number[][] | null,
    gridTemplateId: GridTemplateId,
  ) => BuildPanesResult;
}

export const useWorkspaceLayoutStore = create<WorkspaceLayoutState>(() => ({
  buildInitialPanes: (workspaceId, gridTemplateId, agentAssignments) => {
    return buildPanes(workspaceId, gridTemplateId, agentAssignments);
  },

  restorePanes: (workspaceId, configs, savedSplitColumns, gridTemplateId) => {
    const defaultAgentId = getDefaultAgent().id;
    const panes: Pane[] = configs.map((pc) => {
      const paneId = pc.pane_id ?? uuid();
      const tabs = pc.tabs && pc.tabs.length > 0
        ? pc.tabs.map((tabConfig) => {
            const tabAgentId = normalizeRestoredAgentId(
              tabConfig.agent_id || pc.agent_id,
            ) || defaultAgentId;
            return makeTab(
              workspaceId,
              paneId,
              tabAgentId,
              tabConfig.type ?? "terminal",
              {
                id: tabConfig.tab_id ?? undefined,
                label: tabConfig.label ?? undefined,
                cwd: tabConfig.cwd ?? pc.cwd ?? undefined,
                claudeSessionId: tabConfig.claude_session_id ?? undefined,
              },
            );
          })
        : [makeTab(workspaceId, paneId, normalizeRestoredAgentId(pc.agent_id) || defaultAgentId, "terminal", {
            label: pc.label ?? undefined,
            cwd: pc.cwd ?? undefined,
            claudeSessionId: pc.claude_session_id ?? undefined,
          })];
      const activeTab = tabs.find((tab) => tab.id === pc.active_tab_id) ?? tabs[0];
      const agentId = activeTab?.agentId || normalizeRestoredAgentId(pc.agent_id) || defaultAgentId;
      return {
        id: paneId,
        agentId,
        sessionId: activeTab.sessionId,
        tabs,
        activeTabId: activeTab.id,
        label: pc.label ?? undefined,
      };
    });

    let splitColumns: string[][];
    if (savedSplitColumns && savedSplitColumns.length > 0) {
      splitColumns = savedSplitColumns
        .map((col) => col.map((idx) => panes[idx]?.id).filter(Boolean) as string[])
        .filter((col) => col.length > 0);
    } else {
      // Column-major fallback from grid template
      const template = getGridTemplate(gridTemplateId);
      splitColumns = [];
      let idx = 0;
      for (let c = 0; c < template.cols && idx < panes.length; c++) {
        const col: string[] = [];
        for (let r = 0; r < template.rows && idx < panes.length; r++) {
          col.push(panes[idx].id);
          idx++;
        }
        if (col.length > 0) splitColumns.push(col);
      }
      if (idx < panes.length) {
        const lastCol = splitColumns[splitColumns.length - 1] ?? [];
        for (; idx < panes.length; idx++) {
          lastCol.push(panes[idx].id);
        }
        if (splitColumns.length === 0) splitColumns.push(lastCol);
      }
    }

    return { panes, splitColumns };
  },

  removePaneFromWorkspace: (workspaceId, paneId) => {
    const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    if (!workspace) return;
    if (workspace.panes.length <= 1) return; // never remove last pane

    const newPanes = workspace.panes.filter((p) => p.id !== paneId);

    // Update splitColumns if present
    let newSplitColumns = workspace.splitColumns;
    if (newSplitColumns) {
      newSplitColumns = newSplitColumns
        .map((col) => col.filter((id) => id !== paneId))
        .filter((col) => col.length > 0);
    }

    useWorkspaceListStore.getState()._updateWorkspacePanes(workspaceId, newPanes, newSplitColumns, true);
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

    // Initialize splitColumns if not present (single column with all panes)
    const existingColumns: string[][] = workspace.splitColumns ?? [workspace.panes.map((p) => p.id)];

    let newSplitColumns: string[][];
    if (direction === "down") {
      // Insert new pane after afterPaneId in its column (same column, below)
      newSplitColumns = existingColumns.map((col) => {
        const idx = col.indexOf(afterPaneId);
        if (idx === -1) return col;
        const newCol = [...col];
        newCol.splice(idx + 1, 0, paneId);
        return newCol;
      });
    } else {
      // direction === "right": insert new column after the column containing afterPaneId
      newSplitColumns = [];
      for (const col of existingColumns) {
        newSplitColumns.push(col);
        if (col.includes(afterPaneId)) {
          newSplitColumns.push([paneId]);
        }
      }
    }

    useWorkspaceListStore.getState()._updateWorkspacePanes(workspaceId, newPanes, newSplitColumns, true);
  },

  addTabToPane: (workspaceId, paneId, agentId, type = "terminal") => {
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
  },

  removeTabFromPane: (workspaceId, paneId, tabId) => {
    const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    if (!workspace) return;

    let removedPane = false;
    const newPanes = workspace.panes.flatMap((p) => {
      if (p.id !== paneId) return [p];
      const remaining = p.tabs.filter((t) => t.id !== tabId);
      if (remaining.length === 0) {
        if (workspace.panes.length <= 1) {
          return [p];
        }
        removedPane = true;
        return [];
      }
      const newActiveId = p.activeTabId === tabId ? remaining[remaining.length - 1].id : p.activeTabId;
      const activeTab = remaining.find((t) => t.id === newActiveId) ?? remaining[0];
      return [{
        ...p,
        tabs: remaining,
        activeTabId: newActiveId,
        sessionId: activeTab.sessionId,
        cwd: activeTab.cwd ?? p.cwd,
        lastProcess: activeTab.lastProcess ?? p.lastProcess,
        claudeSessionId: activeTab.claudeSessionId ?? p.claudeSessionId,
      }];
    });

    const nextSplitColumns = removedPane && workspace.splitColumns
      ? workspace.splitColumns
          .map((col) => col.filter((id) => id !== paneId))
          .filter((col) => col.length > 0)
      : undefined;

    useWorkspaceListStore.getState()._updateWorkspacePanes(
      workspaceId,
      newPanes,
      nextSplitColumns,
      removedPane,
    );
  },

  setActivePaneTab: (workspaceId, paneId, tabId) => {
    const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    if (!workspace) return;

    const newPanes = workspace.panes.map((p) => {
      if (p.id !== paneId) return p;
      const tab = p.tabs.find((t) => t.id === tabId);
      if (!tab) return p;
      return {
        ...p,
        activeTabId: tabId,
        sessionId: tab.sessionId,
        cwd: tab.cwd ?? p.cwd,
        lastProcess: tab.lastProcess ?? p.lastProcess,
        claudeSessionId: tab.claudeSessionId ?? p.claudeSessionId,
      };
    });

    useWorkspaceListStore.getState()._updateWorkspacePanes(workspaceId, newPanes);
  },

  setTabAgentId: (workspaceId, paneId, tabId, agentId) => {
    const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    if (!workspace) return;

    const newPanes = workspace.panes.map((pane) => {
      if (pane.id !== paneId) return pane;
      const tabs = pane.tabs.map((tab) =>
        tab.id === tabId
          ? { ...tab, agentId }
          : tab,
      );
      const activeTab = tabs.find((tab) => tab.id === pane.activeTabId) ?? tabs[0];
      return {
        ...pane,
        tabs,
        agentId: activeTab.agentId,
      };
    });

    useWorkspaceListStore.getState()._updateWorkspacePanes(workspaceId, newPanes);
  },
}));
