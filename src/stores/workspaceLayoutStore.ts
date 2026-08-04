import { create } from "zustand";
import { v4 as uuid } from "uuid";
import type { ArtifactSourceKind, Pane, PaneTab, GridTemplateId, SuppressedAgentSession, Workspace } from "../types";
import type { PaneConfig } from "../lib/ipc";
import { getGridTemplate } from "../lib/gridTemplates";
import { getDefaultAgent } from "../lib/agents";
import { makeSessionId } from "../lib/constants";
import { normalizeReadableSplitColumns, reconcileSplitColumnsForPanes } from "../lib/layoutColumns";
import { useWorkspaceListStore } from "./workspaceListStore";
import { usePaneMetadataStore } from "./paneMetadataStore";
import { useUiStore } from "./uiStore";
import { rewriteTabAgentSession, type TabAgentSessionRewrite } from "../lib/tabAgentSessionRewrite";
import { applyStructuralActivation } from "../lib/focusController";
import { onlineStrings } from "../components/online/onlineStrings";
import { bump as bumpPaintStat } from "../lib/paintStats";

/**
 * Workspace Layout Store - Manages panes within workspaces
 * Handles pane CRUD and layout (splitColumns)
 */

function makeTab(
  workspaceId: string,
  paneId: string,
  agentId: string,
  type: PaneTab["type"] = "terminal",
  options?: Partial<Pick<PaneTab, "id" | "label" | "cwd" | "lastProcess" | "claudeSessionId" | "agentKind" | "agentSessionId" | "suppressedAgentSessions" | "launchEnv" | "initialPrompt" | "commandArgv" | "terminalSnapshot" | "htmlPath" | "sourcePath" | "sourceKind" | "previewPath" | "isDirty" | "reloadCounter">>,
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
    suppressedAgentSessions: options?.suppressedAgentSessions,
    launchEnv: options?.launchEnv,
    initialPrompt: options?.initialPrompt,
    commandArgv: options?.commandArgv,
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

function restoreSuppressedAgentSessions(
  values: PaneConfig["suppressed_agent_sessions"],
): SuppressedAgentSession[] | undefined {
  if (!values || values.length === 0) return undefined;
  return values.map((value) => ({
    agentKind: value.agent_kind,
    agentSessionId: value.agent_session_id,
    claudeSessionId: value.claude_session_id ?? undefined,
  }));
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
    suppressedAgentSessions: tab.suppressedAgentSessions,
    launchEnv: tab.launchEnv,
  };
}

function activeSessionIdForPane(pane: Pane | undefined): string | null {
  if (!pane) return null;
  const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0];
  return activeTab?.sessionId ?? pane.sessionId ?? null;
}

function applyActiveTabFields(pane: Pane, activeTab: PaneTab): Pane {
  return {
    ...pane,
    agentId: activeTab.agentId,
    activeTabId: activeTab.id,
    sessionId: activeTab.sessionId,
    cwd: activeTab.cwd ?? pane.cwd,
    lastProcess: activeTab.lastProcess ?? pane.lastProcess,
    claudeSessionId: activeTab.claudeSessionId,
    agentKind: activeTab.agentKind,
    agentSessionId: activeTab.agentSessionId,
    suppressedAgentSessions: activeTab.suppressedAgentSessions,
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

interface TerminalLaunchOptions {
  agentId?: string;
  label?: string;
  cwd?: string;
  agentKind?: PaneTab["agentKind"];
  agentSessionId?: string;
  launchEnv?: Record<string, string>;
  initialPrompt?: string;
  commandArgv?: string[];
  activate?: boolean;
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
    options: TerminalLaunchOptions,
  ) => void;
  
  // Tab operations
  addTabToPane: (workspaceId: string, paneId: string, agentId?: string, type?: PaneTab["type"]) => void;
  addTabToPaneWithOptions: (
    workspaceId: string,
    paneId: string,
    options: TerminalLaunchOptions,
  ) => void;
  /**
   * Open a browser tab rendering the given local HTML file in a right-side
   * preview pane. Reuse the workspace preview pane and reload existing tabs.
   */
  openOrReloadHtmlPreviewPane: (workspaceId: string, sourcePaneId: string, info: string | BrowserPreviewInfo) => void;
  openOnlinePanel: (workspaceId: string, sourcePaneId: string) => void;
  setBrowserTabDirty: (workspaceId: string, paneId: string, tabId: string, isDirty: boolean) => void;
  refreshBrowserTabPreview: (workspaceId: string, paneId: string, tabId: string, info: BrowserPreviewInfo) => void;
  removeTabFromPane: (workspaceId: string, paneId: string, tabId: string) => void;
  setActivePaneTab: (workspaceId: string, paneId: string, tabId: string) => void;
  setTabLabel: (workspaceId: string, paneId: string, tabId: string, label: string | undefined) => void;
  setTabAgentId: (workspaceId: string, paneId: string, tabId: string, agentId: string) => void;
  /**
   * Self-healing clear for a downgraded restore: find the tab whose
   * `sessionId` matches the terminal session that just downgraded (across
   * all workspaces/panes, since the caller only has the PTY session_id) and
   * drop its stale claudeSessionId / agentKind / agentSessionId so the same
   * "agent-restore-downgraded" warning cannot recur on the next launch.
   * No-ops while the pane reports agentStatus === "waiting" (live-session
   * safety valve — see the v0.13.4 しおり消失 postmortem). Returns false only
   * when that guard skipped the clear.
   */
  clearTabAgentSessionBySessionId: (terminalSessionId: string) => boolean;
  /**
   * Fallback-downgrade companion to the clear above: the restore resumed a
   * different (recovered) conversation id, so rewrite the tab's persisted
   * markers to that id instead of leaving them on the dead original.
   */
  repointTabAgentSessionBySessionId: (
    terminalSessionId: string,
    kind: string,
    fallbackSessionId: string,
  ) => void;
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
  movePaneToPosition: (
    workspaceId: string,
    paneId: string,
    toColumn: number,
    toRow: number,
  ) => string[][] | null;
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
      const activeTabConfigId = pc.active_tab_id ?? pc.tabs?.[0]?.tab_id ?? null;
      const tabs = pc.tabs && pc.tabs.length > 0
          ? pc.tabs.map((tabConfig) => {
            const restoredTabType = tabConfig.type as PaneTab["type"] | null | undefined;
            const isActiveRestoredTab = tabConfig.tab_id === activeTabConfigId;
            const tabClaudeSessionId =
              tabConfig.claude_session_id
              ?? (isActiveRestoredTab ? pc.claude_session_id ?? undefined : undefined);
            const tabAgentKind =
              tabConfig.agent_kind
              ?? (tabClaudeSessionId ? "claude" : undefined)
              ?? (isActiveRestoredTab ? pc.agent_kind ?? undefined : undefined);
            const tabAgentSessionId =
              tabConfig.agent_session_id
              ?? tabClaudeSessionId
              ?? (isActiveRestoredTab ? pc.agent_session_id ?? pc.claude_session_id ?? undefined : undefined);
            const tabAgentId = normalizeRestoredAgentId(
              tabConfig.agent_id || pc.agent_id,
            ) || defaultAgentId;
            return makeTab(
              workspaceId,
              paneId,
              tabAgentId,
              restoredTabType ?? "terminal",
              {
                id: tabConfig.tab_id ?? undefined,
                label: restoredTabType === "online"
                  ? onlineStrings.panelTitle
                  : tabConfig.label ?? undefined,
                cwd: tabConfig.cwd ?? pc.cwd ?? undefined,
                claudeSessionId: tabClaudeSessionId,
                agentKind: tabAgentKind,
                agentSessionId: tabAgentSessionId,
                suppressedAgentSessions: restoreSuppressedAgentSessions(tabConfig.suppressed_agent_sessions)
                  ?? (isActiveRestoredTab
                    ? restoreSuppressedAgentSessions(pc.suppressed_agent_sessions)
                    : undefined),
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
            suppressedAgentSessions: restoreSuppressedAgentSessions(pc.suppressed_agent_sessions),
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
        suppressedAgentSessions: activeTab.suppressedAgentSessions
          ?? restoreSuppressedAgentSessions(pc.suppressed_agent_sessions),
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
    applyStructuralActivation(newPane.sessionId);
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
      initialPrompt: options.initialPrompt,
      commandArgv: options.commandArgv,
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
    applyStructuralActivation(newPane.sessionId);
  },

  openOnlinePanel: (workspaceId, sourcePaneId) => {
    const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    if (!workspace) return;
    const sourcePane = workspace.panes.find((pane) => pane.id === sourcePaneId) ?? workspace.panes[0];
    if (!sourcePane) return;

    const existingPane = workspace.panes.find((pane) =>
      pane.tabs.some((tab) => tab.type === "online"),
    );
    const existingTab = existingPane?.tabs.find((tab) => tab.type === "online");
    if (existingPane && existingTab) {
      const normalizedTab = { ...existingTab, label: onlineStrings.panelTitle };
      const newPanes = workspace.panes.map((pane) =>
        pane.id === existingPane.id
          ? applyActiveTabFields(
              { ...pane, tabs: pane.tabs.map((tab) => tab.id === existingTab.id ? normalizedTab : tab) },
              normalizedTab,
            )
          : pane,
      );
      useWorkspaceListStore.getState()._updateWorkspacePanes(workspaceId, newPanes);
      applyStructuralActivation(existingTab.sessionId);
      useUiStore.getState().setZoomedPaneId(null);
      return;
    }

    const paneId = uuid();
    const onlineTab = makeTab(workspaceId, paneId, sourcePane.agentId, "online", {
      label: onlineStrings.panelTitle,
    });
    const onlinePane: Pane = {
      id: paneId,
      agentId: onlineTab.agentId,
      sessionId: onlineTab.sessionId,
      tabs: [onlineTab],
      activeTabId: onlineTab.id,
    };
    const baseColumns = cloneSplitColumns(workspace);
    const nextSplitColumns =
      insertPaneIdIntoColumns(baseColumns, sourcePane.id, onlinePane.id, "right")
      ?? [...baseColumns, [onlinePane.id]];
    useWorkspaceListStore.getState()._updateWorkspacePanes(
      workspaceId,
      [...workspace.panes, onlinePane],
      normalizeWorkspaceSplitColumns(nextSplitColumns),
      true,
    );
    applyStructuralActivation(onlineTab.sessionId);
    useUiStore.getState().setZoomedPaneId(null);
  },

  addTabToPane: (workspaceId, paneId, agentId, type = "terminal") => {
    const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    if (!workspace) return;

    const newPanes = workspace.panes.map((p) => {
      if (p.id !== paneId) return p;
      const agId = agentId ?? p.agentId;
      const tab = makeTab(workspaceId, paneId, agId, type);
      applyStructuralActivation(tab.sessionId);
      return {
        ...p,
        tabs: [...p.tabs, tab],
        activeTabId: tab.id,
        sessionId: tab.sessionId,
      };
    });

    useWorkspaceListStore.getState()._updateWorkspacePanes(workspaceId, newPanes);
  },

  addTabToPaneWithOptions: (workspaceId, paneId, options) => {
    const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    if (!workspace) return;

    const targetPane = workspace.panes.find((pane) => pane.id === paneId);
    if (!targetPane) return;

    const agentId = options.agentId ?? targetPane.agentId;
    const tab = makeTab(workspaceId, paneId, agentId, "terminal", {
      label: options.label,
      cwd: options.cwd,
      agentKind: options.agentKind,
      agentSessionId: options.agentSessionId,
      launchEnv: options.launchEnv,
      initialPrompt: options.initialPrompt,
      commandArgv: options.commandArgv,
    });
    const newPanes = workspace.panes.map((pane) => {
      if (pane.id !== paneId) return pane;
      const nextPane = appendTabsToPane(
        pane,
        [tab],
        options.activate === false ? pane.activeTabId : tab.id,
      );
      // The handoff environment and cwd belong to the new tab only. Keeping
      // the pane fallback unchanged prevents an older sibling tab from
      // inheriting one-shot handoff variables when the user switches back.
      return {
        ...nextPane,
        cwd: pane.cwd,
        lastProcess: pane.lastProcess,
        launchEnv: pane.launchEnv,
      };
    });

    useWorkspaceListStore.getState()._updateWorkspacePanes(workspaceId, newPanes);
    if (options.activate !== false) {
      applyStructuralActivation(tab.sessionId);
    }
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
      applyStructuralActivation(updatedTab.sessionId);
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
      applyStructuralActivation(openedTab.sessionId);
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
    applyStructuralActivation(openedTab.sessionId);
    useUiStore.getState().setZoomedPaneId(null);
  },
  setBrowserTabDirty: (workspaceId, paneId, tabId, isDirty) => {
    const workspace = useWorkspaceListStore.getState().getWorkspace(workspaceId);
    if (!workspace) return;
    const currentTab = workspace.panes
      .find((pane) => pane.id === paneId)
      ?.tabs.find((tab) => tab.id === tabId);
    if (!currentTab || currentTab.type !== "browser" || (currentTab.isDirty ?? false) === isDirty) {
      return;
    }

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
    let nextActivePaneId: string | null | undefined;
    const currentActivePaneId = useUiStore.getState().activePaneId;
    const sourcePaneIndex = workspace.panes.findIndex((pane) => pane.id === paneId);
    const newPanes = workspace.panes.flatMap((p) => {
      if (p.id !== paneId) return [p];
      const removedTab = p.tabs.find((t) => t.id === tabId);
      const removedActiveTarget = Boolean(
        currentActivePaneId
        && removedTab
        && (removedTab.sessionId === currentActivePaneId || p.sessionId === currentActivePaneId),
      );
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
      if (removedActiveTarget) {
        nextActivePaneId = activeTab.sessionId;
      }
      return [applyActiveTabFields({ ...p, tabs: remaining }, activeTab)];
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
    if (nextActivePaneId === undefined && removedPane) {
      const removedSourcePaneWasActive = Boolean(
        currentActivePaneId
        && workspace.panes[sourcePaneIndex]
        && (
          workspace.panes[sourcePaneIndex].sessionId === currentActivePaneId
          || workspace.panes[sourcePaneIndex].tabs.some((tab) => tab.sessionId === currentActivePaneId)
        ),
      );
      if (removedSourcePaneWasActive) {
        const fallbackPane = newPanes[Math.min(Math.max(sourcePaneIndex, 0), newPanes.length - 1)] ?? newPanes[0];
        nextActivePaneId = activeSessionIdForPane(fallbackPane);
      }
    }
    if (nextActivePaneId !== undefined) {
      applyStructuralActivation(nextActivePaneId);
    }
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

  movePaneToPosition: (workspaceId, paneId, toColumn, toRow) => {
    const listStore = useWorkspaceListStore.getState();
    const workspace = listStore.getWorkspace(workspaceId);
    if (!workspace || !workspace.panes.some((pane) => pane.id === paneId)) return null;

    const nextSplitColumns = removePaneIdFromColumns(cloneSplitColumns(workspace), paneId);
    const columnIndex = Number.isInteger(toColumn)
      && toColumn >= 0
      && toColumn < nextSplitColumns.length
      ? toColumn
      : nextSplitColumns.length;

    if (columnIndex === nextSplitColumns.length) {
      nextSplitColumns.push([paneId]);
    } else {
      const targetColumn = nextSplitColumns[columnIndex];
      const rowIndex = Number.isInteger(toRow) && toRow >= 0 && toRow <= targetColumn.length
        ? toRow
        : targetColumn.length;
      targetColumn.splice(rowIndex, 0, paneId);
    }

    const normalizedSplitColumns = reconcileSplitColumnsForPanes(
      normalizeWorkspaceSplitColumns(nextSplitColumns),
      workspace.panes.map((pane) => pane.id),
    );
    listStore._updateWorkspacePanes(
      workspaceId,
      workspace.panes,
      normalizedSplitColumns,
    );
    return normalizedSplitColumns;
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
    const pane = workspace.panes.find((candidate) => candidate.id === paneId);
    const activeSessionId = useUiStore.getState().activePaneId;
    const shouldBumpFocusRevision = Boolean(
      pane
      && pane.activeTabId !== tabId
      && pane.tabs.some((tab) => tab.id === tabId)
      && useWorkspaceListStore.getState().activeWorkspaceId === workspaceId
      && (
        activeSessionId === null
        || pane.sessionId === activeSessionId
        || pane.tabs.some((tab) => tab.sessionId === activeSessionId)
      ),
    );
    if (pane && pane.activeTabId !== tabId && pane.tabs.some((tab) => tab.id === tabId)) {
      bumpPaintStat("tab-switch");
    }

    const newPanes = workspace.panes.map((p) => {
      if (p.id !== paneId) return p;
      const tab = p.tabs.find((t) => t.id === tabId);
      if (!tab) return p;
      return applyActiveTabFields(p, tab);
    });

    useWorkspaceListStore.getState()._updateWorkspacePanes(workspaceId, newPanes);
    if (shouldBumpFocusRevision) {
      useUiStore.getState().bumpFocusRevision();
    }
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

  clearTabAgentSessionBySessionId: (terminalSessionId) => {
    // Safety valve (v0.13.4 しおり消失 lesson): "waiting" is proof the agent
    // is alive, so never destroy markers while the pane reports it — a stale
    // validation failure must not outrank a live-session signal. Worst case
    // of skipping is one more downgrade warning on the next launch.
    const agentStatus =
      usePaneMetadataStore.getState().metadata[terminalSessionId]?.agentStatus;
    if (agentStatus === "waiting") return false;
    applyTabAgentSessionRewrite(terminalSessionId, { type: "clear" });
    return true;
  },

  repointTabAgentSessionBySessionId: (terminalSessionId, kind, fallbackSessionId) => {
    applyTabAgentSessionRewrite(terminalSessionId, {
      type: "repoint",
      kind,
      fallbackSessionId,
    });
  },
}));

function applyTabAgentSessionRewrite(
  terminalSessionId: string,
  rewrite: TabAgentSessionRewrite,
): void {
  const listStore = useWorkspaceListStore.getState();
  for (const workspace of listStore.workspaces) {
    const { panes, didChange } = rewriteTabAgentSession(
      workspace.panes,
      terminalSessionId,
      rewrite,
    );
    if (didChange) {
      listStore._updateWorkspacePanes(workspace.id, panes);
    }
  }
}
