import { create } from "zustand";
import { v4 as uuid } from "uuid";
import type { ArtifactSourceKind, Pane, PaneTab, GridTemplateId, Workspace } from "../types";
import type { PaneConfig } from "../lib/ipc";
import { getGridTemplate } from "../lib/gridTemplates";
import { getDefaultAgent } from "../lib/agents";
import { makeSessionId } from "../lib/constants";
import { normalizeReadableSplitColumns, reconcileSplitColumnsForPanes } from "../lib/layoutColumns";
import { useWorkspaceListStore } from "./workspaceListStore";
import { useUiStore } from "./uiStore";

/**
 * Workspace Layout Store - Manages panes within workspaces
 * Handles pane CRUD and layout (splitColumns)
 */

function makeTab(
  workspaceId: string,
  paneId: string,
  agentId: string,
  type: PaneTab["type"] = "terminal",
  options?: Partial<Pick<PaneTab, "id" | "label" | "cwd" | "lastProcess" | "claudeSessionId" | "agentKind" | "agentSessionId" | "launchEnv" | "terminalSnapshot" | "htmlPath" | "sourcePath" | "sourceKind" | "previewPath" | "isDirty" | "reloadCounter">>,
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
    agentKind: options?.agentKind,
    agentSessionId: options?.agentSessionId,
    launchEnv: options?.launchEnv,
    terminalSnapshot: options?.terminalSnapshot,
    htmlPath: options?.htmlPath,
    sourcePath: options?.sourcePath,
    sourceKind: options?.sourceKind,
    previewPath: options?.previewPath,
    isDirty: options?.isDirty,
    reloadCounter: options?.reloadCounter,
  };
}

function normalizeRestoredAgentId(
  agentId: string | null | undefined,
): string {
  return agentId || getDefaultAgent().id;
}

interface BuildPanesResult {
  panes: Pane[];
  splitColumns: string[][];
}

type SplitInsertDirection = "left" | "right" | "up" | "down";

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

function cloneSplitColumns(workspace: Workspace): string[][] {
  const columns = workspace.splitColumns && workspace.splitColumns.length > 0
    ? workspace.splitColumns
    : [workspace.panes.map((pane) => pane.id)];
  return reconcileSplitColumnsForPanes(
    normalizeWorkspaceSplitColumns(columns.map((col) => [...col])),
    workspace.panes.map((pane) => pane.id),
  );
}

function normalizeWorkspaceSplitColumns(columns: string[][]): string[][] {
  return normalizeReadableSplitColumns(columns);
}

function removePaneIdFromColumns(columns: string[][], paneId: string): string[][] {
  return columns
    .map((col) => col.filter((id) => id !== paneId))
    .filter((col) => col.length > 0);
}

function insertPaneIdIntoColumns(
  columns: string[][],
  targetPaneId: string,
  insertedPaneId: string,
  direction: SplitInsertDirection,
): string[][] | null {
  const next = columns.map((col) => [...col]);
  const colIdx = next.findIndex((col) => col.includes(targetPaneId));
  if (colIdx === -1) return null;

  if (direction === "left" || direction === "right") {
    next.splice(direction === "left" ? colIdx : colIdx + 1, 0, [insertedPaneId]);
    return next;
  }

  const rowIdx = next[colIdx].indexOf(targetPaneId);
  if (rowIdx === -1) return null;
  next[colIdx].splice(direction === "up" ? rowIdx : rowIdx + 1, 0, insertedPaneId);
  return next;
}

function makePaneFromTab(paneId: string, tab: PaneTab): Pane {
  return {
    id: paneId,
    agentId: tab.agentId,
    sessionId: tab.sessionId,
    tabs: [tab],
    activeTabId: tab.id,
    cwd: tab.cwd,
    lastProcess: tab.lastProcess,
    claudeSessionId: tab.claudeSessionId,
    agentKind: tab.agentKind,
    agentSessionId: tab.agentSessionId,
    launchEnv: tab.launchEnv,
  };
}

function applyActiveTabFields(pane: Pane, activeTab: PaneTab): Pane {
  return {
    ...pane,
    agentId: activeTab.agentId,
    activeTabId: activeTab.id,
    sessionId: activeTab.sessionId,
    cwd: activeTab.cwd ?? pane.cwd,
    lastProcess: activeTab.lastProcess ?? pane.lastProcess,
    claudeSessionId: activeTab.claudeSessionId ?? pane.claudeSessionId,
    agentKind: activeTab.agentKind ?? pane.agentKind,
    agentSessionId: activeTab.agentSessionId ?? pane.agentSessionId,
    launchEnv: activeTab.launchEnv ?? pane.launchEnv,
  };
}

function removeTabFromPane(pane: Pane, tabId: string): Pane | null {
  const remaining = pane.tabs.filter((tab) => tab.id !== tabId);
  if (remaining.length === 0) return null;
  const preferredActiveId = pane.activeTabId === tabId
    ? remaining[remaining.length - 1].id
    : pane.activeTabId;
  const activeTab = remaining.find((tab) => tab.id === preferredActiveId) ?? remaining[0];
  return applyActiveTabFields({ ...pane, tabs: remaining }, activeTab);
}

function appendTabsToPane(pane: Pane, tabs: PaneTab[], activeTabId: string): Pane {
  const nextTabs = [...pane.tabs, ...tabs];
  const activeTab = nextTabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? nextTabs[0];
  return applyActiveTabFields({ ...pane, tabs: nextTabs }, activeTab);
}

function isBrowserOnlyPane(pane: Pane): boolean {
  return pane.tabs.length > 0 && pane.tabs.every((tab) => tab.type === "browser");
}

interface BrowserPreviewInfo {
  previewPath: string;
  sourcePath?: string;
  sourceKind?: ArtifactSourceKind;
}

function normalizeBrowserPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function sourceKindFromPath(path: string): ArtifactSourceKind {
  if (/\.(?:md|markdown)$/i.test(path)) return "markdown";
  if (/\.(?:docx?|docm|dotx?|dotm|xlsx?|xlsm|xlsb|xltx?|xltm|pptx?|pptm|potx?|potm|ppsx?|ppsm)$/i.test(path)) {
    return "office";
  }
  return "html";
}

function sourceKindLabel(kind: ArtifactSourceKind): string {
  if (kind === "markdown") return "MD";
  if (kind === "office") return "OFFICE";
  return "HTML";
}

function normalizeBrowserPreviewInfo(info: string | BrowserPreviewInfo): Required<BrowserPreviewInfo> {
  if (typeof info === "string") {
    const path = normalizeBrowserPath(info);
    return {
      previewPath: path,
      sourcePath: path,
      sourceKind: sourceKindFromPath(path),
    };
  }
  const previewPath = normalizeBrowserPath(info.previewPath);
  const sourcePath = normalizeBrowserPath(info.sourcePath ?? info.previewPath);
  return {
    previewPath,
    sourcePath,
    sourceKind: info.sourceKind ?? sourceKindFromPath(sourcePath),
  };
}

function browserTabKey(tab: PaneTab): string | undefined {
  return tab.sourcePath ?? tab.previewPath ?? tab.htmlPath;
}

function confirmDiscardBrowserChanges(tab: PaneTab): boolean {
  if (!tab.isDirty) return true;
  const label = tab.label ?? tab.sourcePath ?? tab.htmlPath ?? "artifact";
  return window.confirm(`${label} has unsaved edits. Discard them and reload?`);
}

function makeBrowserTab(
  workspaceId: string,
  paneId: string,
  agentId: string,
  info: Required<BrowserPreviewInfo>,
): PaneTab {
  const fileLeaf = info.sourcePath.split(/[\\/]/).pop() || "artifact";
  const labelPrefix = sourceKindLabel(info.sourceKind);
  return makeTab(workspaceId, paneId, agentId, "browser", {
    htmlPath: info.previewPath,
    sourcePath: info.sourcePath,
    sourceKind: info.sourceKind,
    previewPath: info.previewPath,
    isDirty: false,
    reloadCounter: 0,
    label: `${labelPrefix} ${fileLeaf}`,
  });
}

function bumpBrowserTabReloadCounter(tab: PaneTab, info?: Required<BrowserPreviewInfo>): PaneTab {
  return {
    ...tab,
    htmlPath: info?.previewPath ?? tab.htmlPath,
    sourcePath: info?.sourcePath ?? tab.sourcePath,
    sourceKind: info?.sourceKind ?? tab.sourceKind,
    previewPath: info?.previewPath ?? tab.previewPath,
    isDirty: false,
    reloadCounter: (tab.reloadCounter ?? 0) + 1,
  };
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
  addPaneToWorkspaceWithOptions: (
    workspaceId: string,
    afterPaneId: string,
    direction: "right" | "down",
    options: {
      agentId?: string;
      label?: string;
      cwd?: string;
      agentKind?: PaneTab["agentKind"];
      agentSessionId?: string;
      launchEnv?: Record<string, string>;
    },
  ) => void;
  
  // Tab operations
  addTabToPane: (workspaceId: string, paneId: string, agentId?: string, type?: PaneTab["type"]) => void;
  /**
   * Open a browser tab rendering the given local HTML file in a right-side
   * preview pane. Reuse the workspace preview pane and reload existing tabs.
   */
  openOrReloadHtmlPreviewPane: (workspaceId: string, sourcePaneId: string, info: string | BrowserPreviewInfo) => void;
  setBrowserTabDirty: (workspaceId: string, paneId: string, tabId: string, isDirty: boolean) => void;
  refreshBrowserTabPreview: (workspaceId: string, paneId: string, tabId: string, info: BrowserPreviewInfo) => void;
  removeTabFromPane: (workspaceId: string, paneId: string, tabId: string) => void;
  setActivePaneTab: (workspaceId: string, paneId: string, tabId: string) => void;
  setTabLabel: (workspaceId: string, paneId: string, tabId: string, label: string | undefined) => void;
  setTabAgentId: (workspaceId: string, paneId: string, tabId: string, agentId: string) => void;
  moveTabToPane: (
    sourceWorkspaceId: string,
    sourcePaneId: string,
    tabId: string,
    targetWorkspaceId: string,
    targetPaneId: string,
  ) => void;
  moveTabToSplit: (
    sourceWorkspaceId: string,
    sourcePaneId: string,
    tabId: string,
    targetWorkspaceId: string,
    targetPaneId: string,
    direction: SplitInsertDirection,
  ) => void;
  movePaneToPane: (
    sourceWorkspaceId: string,
    sourcePaneId: string,
    targetWorkspaceId: string,
    targetPaneId: string,
  ) => void;
  movePaneToSplit: (
    sourceWorkspaceId: string,
    sourcePaneId: string,
    targetWorkspaceId: string,
    targetPaneId: string,
    direction: SplitInsertDirection,
  ) => void;
  moveTabToNewWorkspace: (
    sourceWorkspaceId: string,
    sourcePaneId: string,
    tabId: string,
    targetWorkspaceId: string,
    workspaceName: string,
  ) => boolean;
  movePaneToNewWorkspace: (
    sourceWorkspaceId: string,
    sourcePaneId: string,
    targetWorkspaceId: string,
    workspaceName: string,
  ) => boolean;
  
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
                agentKind: tabConfig.agent_kind ?? (tabConfig.claude_session_id ? "claude" : undefined),
                agentSessionId: tabConfig.agent_session_id ?? tabConfig.claude_session_id ?? undefined,
                launchEnv: tabConfig.launch_env ?? pc.launch_env ?? undefined,
                terminalSnapshot: tabConfig.terminal_snapshot ?? undefined,
              },
            );
          })
        : [makeTab(workspaceId, paneId, normalizeRestoredAgentId(pc.agent_id) || defaultAgentId, "terminal", {
            label: pc.label ?? undefined,
            cwd: pc.cwd ?? undefined,
            claudeSessionId: pc.claude_session_id ?? undefined,
            agentKind: pc.agent_kind ?? (pc.claude_session_id ? "claude" : undefined),
            agentSessionId: pc.agent_session_id ?? pc.claude_session_id ?? undefined,
            launchEnv: pc.launch_env ?? undefined,
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
        cwd: activeTab.cwd ?? pc.cwd ?? undefined,
        claudeSessionId: activeTab.claudeSessionId ?? pc.claude_session_id ?? undefined,
        agentKind: activeTab.agentKind ?? pc.agent_kind ?? undefined,
        agentSessionId: activeTab.agentSessionId ?? pc.agent_session_id ?? undefined,
        launchEnv: activeTab.launchEnv ?? pc.launch_env ?? undefined,
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

    return {
      panes,
      splitColumns: normalizeReadableSplitColumns(splitColumns),
    };
  },

  removePaneFromWorkspace: (workspaceId, paneId) => {
    const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    if (!workspace) return;
    if (workspace.panes.length <= 1) return; // never remove last pane

    const uiState = useUiStore.getState();
    if (uiState.zoomedPaneId === paneId) {
      uiState.setZoomedPaneId(null);
    }

    const newPanes = workspace.panes.filter((p) => p.id !== paneId);

    // Update splitColumns if present
    let newSplitColumns = workspace.splitColumns;
    if (newSplitColumns) {
      newSplitColumns = newSplitColumns
        .map((col) => col.filter((id) => id !== paneId))
        .filter((col) => col.length > 0);
    }

    useWorkspaceListStore.getState()._updateWorkspacePanes(
      workspaceId,
      newPanes,
      newSplitColumns ? normalizeWorkspaceSplitColumns(newSplitColumns) : newSplitColumns,
      true,
    );
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
    const existingColumns = cloneSplitColumns(workspace);

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

    useWorkspaceListStore.getState()._updateWorkspacePanes(
      workspaceId,
      newPanes,
      normalizeWorkspaceSplitColumns(newSplitColumns),
      true,
    );
    useUiStore.getState().setActivePaneId(newPane.sessionId);
  },

  addPaneToWorkspaceWithOptions: (workspaceId, afterPaneId, direction, options) => {
    const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    if (!workspace) return;

    const agId = options.agentId ?? getDefaultAgent().id;
    const paneId = uuid();
    const tab = makeTab(workspaceId, paneId, agId, "terminal", {
      label: options.label,
      cwd: options.cwd,
      agentKind: options.agentKind,
      agentSessionId: options.agentSessionId,
      launchEnv: options.launchEnv,
    });
    const newPane: Pane = {
      id: paneId,
      agentId: agId,
      sessionId: tab.sessionId,
      label: options.label,
      cwd: options.cwd,
      agentKind: options.agentKind,
      agentSessionId: options.agentSessionId,
      launchEnv: options.launchEnv,
      tabs: [tab],
      activeTabId: tab.id,
    };
    const newPanes = [...workspace.panes, newPane];
    const existingColumns = cloneSplitColumns(workspace);

    let newSplitColumns: string[][];
    if (direction === "down") {
      newSplitColumns = existingColumns.map((col) => {
        const idx = col.indexOf(afterPaneId);
        if (idx === -1) return col;
        const newCol = [...col];
        newCol.splice(idx + 1, 0, paneId);
        return newCol;
      });
    } else {
      newSplitColumns = [];
      for (const col of existingColumns) {
        newSplitColumns.push(col);
        if (col.includes(afterPaneId)) {
          newSplitColumns.push([paneId]);
        }
      }
    }

    useWorkspaceListStore.getState()._updateWorkspacePanes(
      workspaceId,
      newPanes,
      normalizeWorkspaceSplitColumns(newSplitColumns),
      true,
    );
    useUiStore.getState().setActivePaneId(newPane.sessionId);
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

  openOrReloadHtmlPreviewPane: (workspaceId, sourcePaneId, previewInfo) => {
    const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    if (!workspace) return;

    const info = normalizeBrowserPreviewInfo(previewInfo);
    const key = info.sourcePath;
    const sourcePane = workspace.panes.find((p) => p.id === sourcePaneId) ?? workspace.panes[0];
    if (!sourcePane) return;

    const previewPane = workspace.panes.find(isBrowserOnlyPane);
    const existingPreviewTab = previewPane?.tabs.find(
      (tab) => tab.type === "browser" && browserTabKey(tab) === key,
    );

    if (previewPane && existingPreviewTab) {
      if (!confirmDiscardBrowserChanges(existingPreviewTab)) return;
      const updatedTab = bumpBrowserTabReloadCounter(existingPreviewTab, info);
      const newPanes = workspace.panes.map((pane) => {
        if (pane.id !== previewPane.id) return pane;
        return applyActiveTabFields({
          ...pane,
          tabs: pane.tabs.map((tab) => tab.id === updatedTab.id ? updatedTab : tab),
        }, updatedTab);
      });
      useWorkspaceListStore.getState()._updateWorkspacePanes(workspaceId, newPanes);
      useUiStore.getState().setZoomedPaneId(null);
      return;
    }

    const existingMixedPane = workspace.panes.find(
      (pane) => !isBrowserOnlyPane(pane)
        && pane.tabs.some((tab) => tab.type === "browser" && browserTabKey(tab) === key),
    );
    const existingMixedTab = existingMixedPane?.tabs.find(
      (tab) => tab.type === "browser" && browserTabKey(tab) === key,
    );
    if (existingMixedTab && !confirmDiscardBrowserChanges(existingMixedTab)) return;
    const tabToOpen = existingMixedTab ? bumpBrowserTabReloadCounter(existingMixedTab, info) : null;

    if (previewPane) {
      const openedTab = tabToOpen
        ?? makeBrowserTab(workspaceId, previewPane.id, previewPane.agentId, info);
      const newPanes = workspace.panes.flatMap((pane) => {
        if (existingMixedPane && existingMixedTab && pane.id === existingMixedPane.id) {
          const nextPane = removeTabFromPane(pane, existingMixedTab.id);
          return nextPane ? [nextPane] : [];
        }
        if (pane.id !== previewPane.id) return [pane];
        return [appendTabsToPane(pane, [openedTab], openedTab.id)];
      });
      useWorkspaceListStore.getState()._updateWorkspacePanes(workspaceId, newPanes);
      useUiStore.getState().setZoomedPaneId(null);
      return;
    }

    const paneId = uuid();
    const openedTab = tabToOpen
      ?? makeBrowserTab(workspaceId, paneId, sourcePane.agentId, info);
    const newPreviewPane: Pane = {
      id: paneId,
      agentId: openedTab.agentId,
      sessionId: openedTab.sessionId,
      tabs: [openedTab],
      activeTabId: openedTab.id,
    };
    const newPanes = workspace.panes.flatMap((pane) => {
      if (existingMixedPane && existingMixedTab && pane.id === existingMixedPane.id) {
        const nextPane = removeTabFromPane(pane, existingMixedTab.id);
        return nextPane ? [nextPane] : [];
      }
      return [pane];
    }).concat(newPreviewPane);
    const baseColumns = cloneSplitColumns(workspace);
    const nextSplitColumns =
      insertPaneIdIntoColumns(baseColumns, sourcePane.id, newPreviewPane.id, "right")
      ?? [...baseColumns, [newPreviewPane.id]];

    useWorkspaceListStore.getState()._updateWorkspacePanes(
      workspaceId,
      newPanes,
      normalizeWorkspaceSplitColumns(nextSplitColumns),
      true,
    );
    useUiStore.getState().setZoomedPaneId(null);
  },
  setBrowserTabDirty: (workspaceId, paneId, tabId, isDirty) => {
    const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    if (!workspace) return;
    const currentTab = workspace.panes
      .find((pane) => pane.id === paneId)
      ?.tabs.find((tab) => tab.id === tabId);
    if (currentTab?.isDirty === isDirty) return;

    const newPanes = workspace.panes.map((pane) => {
      if (pane.id !== paneId) return pane;
      return {
        ...pane,
        tabs: pane.tabs.map((tab) =>
          tab.id === tabId && tab.type === "browser" ? { ...tab, isDirty } : tab
        ),
      };
    });
    useWorkspaceListStore.getState()._updateWorkspacePanes(workspaceId, newPanes);
  },
  refreshBrowserTabPreview: (workspaceId, paneId, tabId, previewInfo) => {
    const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    if (!workspace) return;

    const info = normalizeBrowserPreviewInfo(previewInfo);
    const newPanes = workspace.panes.map((pane) => {
      if (pane.id !== paneId) return pane;
      const nextTabs = pane.tabs.map((tab) =>
        tab.id === tabId && tab.type === "browser"
          ? bumpBrowserTabReloadCounter(tab, info)
          : tab
      );
      const activeTab = nextTabs.find((tab) => tab.id === pane.activeTabId) ?? nextTabs[0];
      return activeTab ? applyActiveTabFields({ ...pane, tabs: nextTabs }, activeTab) : pane;
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
        agentKind: activeTab.agentKind ?? p.agentKind,
        agentSessionId: activeTab.agentSessionId ?? p.agentSessionId,
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
      nextSplitColumns ? normalizeWorkspaceSplitColumns(nextSplitColumns) : nextSplitColumns,
      removedPane,
    );
  },

  moveTabToPane: (sourceWorkspaceId, sourcePaneId, tabId, targetWorkspaceId, targetPaneId) => {
    const listStore = useWorkspaceListStore.getState();
    const sourceWorkspace = listStore.getWorkspace(sourceWorkspaceId);
    const targetWorkspace = listStore.getWorkspace(targetWorkspaceId);
    if (!sourceWorkspace || !targetWorkspace) return;

    const sourcePane = sourceWorkspace.panes.find((pane) => pane.id === sourcePaneId);
    const targetPane = targetWorkspace.panes.find((pane) => pane.id === targetPaneId);
    const tab = sourcePane?.tabs.find((candidate) => candidate.id === tabId);
    if (!sourcePane || !targetPane || !tab) return;

    if (sourceWorkspaceId === targetWorkspaceId && sourcePaneId === targetPaneId) {
      const newPanes = sourceWorkspace.panes.map((pane) =>
        pane.id === sourcePaneId ? applyActiveTabFields(pane, tab) : pane,
      );
      listStore._updateWorkspacePanes(sourceWorkspaceId, newPanes);
      return;
    }

    if (sourceWorkspaceId === targetWorkspaceId) {
      let removedSourcePane = false;
      const newPanes = sourceWorkspace.panes.flatMap((pane) => {
        if (pane.id === sourcePaneId) {
          const updated = removeTabFromPane(pane, tabId);
          if (!updated) {
            removedSourcePane = true;
            return [];
          }
          return [updated];
        }
        if (pane.id === targetPaneId) {
          return [appendTabsToPane(pane, [tab], tab.id)];
        }
        return [pane];
      });
      const nextSplitColumns = removedSourcePane
        ? removePaneIdFromColumns(cloneSplitColumns(sourceWorkspace), sourcePaneId)
        : undefined;
      listStore._updateWorkspacePanes(
        sourceWorkspaceId,
        newPanes,
        nextSplitColumns ? normalizeWorkspaceSplitColumns(nextSplitColumns) : nextSplitColumns,
        removedSourcePane,
      );
      return;
    }

    let removedSourcePane = false;
    const sourcePanes = sourceWorkspace.panes.flatMap((pane) => {
      if (pane.id !== sourcePaneId) return [pane];
      const updated = removeTabFromPane(pane, tabId);
      if (!updated) {
        removedSourcePane = true;
        return [];
      }
      return [updated];
    });
    const targetPanes = targetWorkspace.panes.map((pane) =>
      pane.id === targetPaneId ? appendTabsToPane(pane, [tab], tab.id) : pane,
    );

    const sourceSplitColumns = removedSourcePane
      ? removePaneIdFromColumns(cloneSplitColumns(sourceWorkspace), sourcePaneId)
      : undefined;
    listStore._updateWorkspacePanes(
      sourceWorkspaceId,
      sourcePanes,
      sourceSplitColumns ? normalizeWorkspaceSplitColumns(sourceSplitColumns) : sourceSplitColumns,
      removedSourcePane,
    );
    listStore._updateWorkspacePanes(targetWorkspaceId, targetPanes);
    if (sourcePanes.length === 0) {
      listStore.removeWorkspace(sourceWorkspaceId);
    }
  },

  moveTabToSplit: (sourceWorkspaceId, sourcePaneId, tabId, targetWorkspaceId, targetPaneId, direction) => {
    const listStore = useWorkspaceListStore.getState();
    const sourceWorkspace = listStore.getWorkspace(sourceWorkspaceId);
    const targetWorkspace = listStore.getWorkspace(targetWorkspaceId);
    if (!sourceWorkspace || !targetWorkspace) return;

    const sourcePane = sourceWorkspace.panes.find((pane) => pane.id === sourcePaneId);
    const targetPane = targetWorkspace.panes.find((pane) => pane.id === targetPaneId);
    const tab = sourcePane?.tabs.find((candidate) => candidate.id === tabId);
    if (!sourcePane || !targetPane || !tab) return;
    if (sourceWorkspaceId === targetWorkspaceId && sourcePaneId === targetPaneId && sourcePane.tabs.length <= 1) return;

    const newPane = makePaneFromTab(uuid(), tab);

    if (sourceWorkspaceId === targetWorkspaceId) {
      let removedSourcePane = false;
      const panesAfterSource = sourceWorkspace.panes.flatMap((pane) => {
        if (pane.id !== sourcePaneId) return [pane];
        const updated = removeTabFromPane(pane, tabId);
        if (!updated) {
          removedSourcePane = true;
          return [];
        }
        return [updated];
      });
      if (!panesAfterSource.some((pane) => pane.id === targetPaneId)) return;
      const baseColumns = removedSourcePane
        ? removePaneIdFromColumns(cloneSplitColumns(sourceWorkspace), sourcePaneId)
        : cloneSplitColumns(sourceWorkspace);
      const nextSplitColumns = insertPaneIdIntoColumns(baseColumns, targetPaneId, newPane.id, direction);
      if (!nextSplitColumns) return;
      listStore._updateWorkspacePanes(
        sourceWorkspaceId,
        [...panesAfterSource, newPane],
        normalizeWorkspaceSplitColumns(nextSplitColumns),
        true,
      );
      return;
    }

    let removedSourcePane = false;
    const sourcePanes = sourceWorkspace.panes.flatMap((pane) => {
      if (pane.id !== sourcePaneId) return [pane];
      const updated = removeTabFromPane(pane, tabId);
      if (!updated) {
        removedSourcePane = true;
        return [];
      }
      return [updated];
    });
    const targetColumns = insertPaneIdIntoColumns(
      cloneSplitColumns(targetWorkspace),
      targetPaneId,
      newPane.id,
      direction,
    );
    if (!targetColumns) return;

    const sourceSplitColumns = removedSourcePane
      ? removePaneIdFromColumns(cloneSplitColumns(sourceWorkspace), sourcePaneId)
      : undefined;
    listStore._updateWorkspacePanes(
      sourceWorkspaceId,
      sourcePanes,
      sourceSplitColumns ? normalizeWorkspaceSplitColumns(sourceSplitColumns) : sourceSplitColumns,
      removedSourcePane,
    );
    listStore._updateWorkspacePanes(
      targetWorkspaceId,
      [...targetWorkspace.panes, newPane],
      normalizeWorkspaceSplitColumns(targetColumns),
      true,
    );
    if (sourcePanes.length === 0) {
      listStore.removeWorkspace(sourceWorkspaceId);
    }
  },

  movePaneToPane: (sourceWorkspaceId, sourcePaneId, targetWorkspaceId, targetPaneId) => {
    const listStore = useWorkspaceListStore.getState();
    const sourceWorkspace = listStore.getWorkspace(sourceWorkspaceId);
    const targetWorkspace = listStore.getWorkspace(targetWorkspaceId);
    if (!sourceWorkspace || !targetWorkspace) return;

    const sourcePane = sourceWorkspace.panes.find((pane) => pane.id === sourcePaneId);
    const targetPane = targetWorkspace.panes.find((pane) => pane.id === targetPaneId);
    if (!sourcePane || !targetPane) return;
    if (sourceWorkspaceId === targetWorkspaceId && sourcePaneId === targetPaneId) return;

    if (sourceWorkspaceId === targetWorkspaceId) {
      const newPanes = sourceWorkspace.panes.flatMap((pane) => {
        if (pane.id === sourcePaneId) return [];
        if (pane.id === targetPaneId) {
          return [appendTabsToPane(pane, sourcePane.tabs, sourcePane.activeTabId)];
        }
        return [pane];
      });
      const nextSplitColumns = removePaneIdFromColumns(cloneSplitColumns(sourceWorkspace), sourcePaneId);
      listStore._updateWorkspacePanes(
        sourceWorkspaceId,
        newPanes,
        normalizeWorkspaceSplitColumns(nextSplitColumns),
        true,
      );
      return;
    }

    const sourcePanes = sourceWorkspace.panes.filter((pane) => pane.id !== sourcePaneId);
    const sourceSplitColumns = removePaneIdFromColumns(cloneSplitColumns(sourceWorkspace), sourcePaneId);
    const targetPanes = targetWorkspace.panes.map((pane) =>
      pane.id === targetPaneId
        ? appendTabsToPane(pane, sourcePane.tabs, sourcePane.activeTabId)
        : pane,
    );
    listStore._updateWorkspacePanes(
      sourceWorkspaceId,
      sourcePanes,
      normalizeWorkspaceSplitColumns(sourceSplitColumns),
      true,
    );
    listStore._updateWorkspacePanes(targetWorkspaceId, targetPanes);
    if (sourcePanes.length === 0) {
      listStore.removeWorkspace(sourceWorkspaceId);
    }
  },

  movePaneToSplit: (sourceWorkspaceId, sourcePaneId, targetWorkspaceId, targetPaneId, direction) => {
    const listStore = useWorkspaceListStore.getState();
    const sourceWorkspace = listStore.getWorkspace(sourceWorkspaceId);
    const targetWorkspace = listStore.getWorkspace(targetWorkspaceId);
    if (!sourceWorkspace || !targetWorkspace) return;

    const sourcePane = sourceWorkspace.panes.find((pane) => pane.id === sourcePaneId);
    const targetPane = targetWorkspace.panes.find((pane) => pane.id === targetPaneId);
    if (!sourcePane || !targetPane) return;
    if (sourceWorkspaceId === targetWorkspaceId && sourcePaneId === targetPaneId) return;

    if (sourceWorkspaceId === targetWorkspaceId) {
      const baseColumns = removePaneIdFromColumns(cloneSplitColumns(sourceWorkspace), sourcePaneId);
      const nextSplitColumns = insertPaneIdIntoColumns(baseColumns, targetPaneId, sourcePaneId, direction);
      if (!nextSplitColumns) return;
      listStore._updateWorkspacePanes(
        sourceWorkspaceId,
        sourceWorkspace.panes,
        normalizeWorkspaceSplitColumns(nextSplitColumns),
        true,
      );
      return;
    }

    const sourcePanes = sourceWorkspace.panes.filter((pane) => pane.id !== sourcePaneId);
    const sourceSplitColumns = removePaneIdFromColumns(cloneSplitColumns(sourceWorkspace), sourcePaneId);
    const targetColumns = insertPaneIdIntoColumns(
      cloneSplitColumns(targetWorkspace),
      targetPaneId,
      sourcePaneId,
      direction,
    );
    if (!targetColumns) return;

    listStore._updateWorkspacePanes(
      sourceWorkspaceId,
      sourcePanes,
      normalizeWorkspaceSplitColumns(sourceSplitColumns),
      true,
    );
    listStore._updateWorkspacePanes(
      targetWorkspaceId,
      [...targetWorkspace.panes, sourcePane],
      normalizeWorkspaceSplitColumns(targetColumns),
      true,
    );
    if (sourcePanes.length === 0) {
      listStore.removeWorkspace(sourceWorkspaceId);
    }
  },

  moveTabToNewWorkspace: (sourceWorkspaceId, sourcePaneId, tabId, targetWorkspaceId, workspaceName) => {
    const listStore = useWorkspaceListStore.getState();
    const sourceWorkspace = listStore.getWorkspace(sourceWorkspaceId);
    if (!sourceWorkspace) return false;

    const sourcePane = sourceWorkspace.panes.find((pane) => pane.id === sourcePaneId);
    const tab = sourcePane?.tabs.find((candidate) => candidate.id === tabId);
    if (!sourcePane || !tab) return false;

    let removedSourcePane = false;
    const sourcePanes = sourceWorkspace.panes.flatMap((pane) => {
      if (pane.id !== sourcePaneId) return [pane];
      const updated = removeTabFromPane(pane, tabId);
      if (!updated) {
        removedSourcePane = true;
        return [];
      }
      return [updated];
    });
    const sourceSplitColumns = removedSourcePane
      ? removePaneIdFromColumns(cloneSplitColumns(sourceWorkspace), sourcePaneId)
      : undefined;
    const newPane = makePaneFromTab(uuid(), tab);

    listStore._updateWorkspacePanes(
      sourceWorkspaceId,
      sourcePanes,
      sourceSplitColumns ? normalizeWorkspaceSplitColumns(sourceSplitColumns) : sourceSplitColumns,
      removedSourcePane,
    );
    listStore.createWorkspace(
      workspaceName,
      "1x1",
      [newPane],
      [[newPane.id]],
      { id: targetWorkspaceId },
    );
    if (sourcePanes.length === 0) {
      listStore.removeWorkspace(sourceWorkspaceId);
    }
    return true;
  },

  movePaneToNewWorkspace: (sourceWorkspaceId, sourcePaneId, targetWorkspaceId, workspaceName) => {
    const listStore = useWorkspaceListStore.getState();
    const sourceWorkspace = listStore.getWorkspace(sourceWorkspaceId);
    if (!sourceWorkspace) return false;

    const sourcePane = sourceWorkspace.panes.find((pane) => pane.id === sourcePaneId);
    if (!sourcePane) return false;

    const sourcePanes = sourceWorkspace.panes.filter((pane) => pane.id !== sourcePaneId);
    const sourceSplitColumns = removePaneIdFromColumns(cloneSplitColumns(sourceWorkspace), sourcePaneId);

    listStore._updateWorkspacePanes(
      sourceWorkspaceId,
      sourcePanes,
      normalizeWorkspaceSplitColumns(sourceSplitColumns),
      true,
    );
    listStore.createWorkspace(
      workspaceName,
      "1x1",
      [sourcePane],
      [[sourcePane.id]],
      { id: targetWorkspaceId },
    );
    if (sourcePanes.length === 0) {
      listStore.removeWorkspace(sourceWorkspaceId);
    }
    return true;
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
        agentKind: tab.agentKind ?? p.agentKind,
        agentSessionId: tab.agentSessionId ?? p.agentSessionId,
      };
    });

    useWorkspaceListStore.getState()._updateWorkspacePanes(workspaceId, newPanes);
  },

  setTabLabel: (workspaceId, paneId, tabId, label) => {
    const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    if (!workspace) return;

    const normalizedLabel = label?.trim() === "" || label === undefined ? undefined : label.trim();
    let didChange = false;
    const newPanes = workspace.panes.map((pane) => {
      if (pane.id !== paneId) return pane;
      const tabs = pane.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        if (tab.label === normalizedLabel) return tab;
        didChange = true;
        return {
          ...tab,
          label: normalizedLabel,
        };
      });
      return {
        ...pane,
        tabs,
      };
    });

    if (!didChange) return;
    useWorkspaceListStore.getState()._updateWorkspacePanes(workspaceId, newPanes);
  },

  setTabAgentId: (workspaceId, paneId, tabId, agentId) => {
    const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    if (!workspace) return;

    const newPanes = workspace.panes.map((pane) => {
      if (pane.id !== paneId) return pane;
      const tabs = pane.tabs.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              agentId,
              claudeSessionId: undefined,
              agentKind: undefined,
              agentSessionId: undefined,
            }
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
