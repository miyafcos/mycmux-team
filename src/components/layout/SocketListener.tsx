import { useEffect, useRef } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useWorkspaceListStore,
  useWorkspaceLayoutStore,
  useUiStore,
  usePaneMetadataStore,
} from "../../stores/workspaceStore";
import {
  loadPersistentData,
  claimLeader,
  savePersistentData,
  readAgentSessionMappings,
  quitApp,
  type AgentSessionMapping,
  type PaneConfig,
  type PaneTabConfig,
  type WorkspaceConfig,
} from "../../lib/ipc";
import type { AgentSessionKind, Workspace } from "../../types";
import { useThemeStore } from "../../stores/themeStore";
import { useKeybindingStore } from "../../stores/keybindingStore";
import { deriveEffectiveStatus } from "../../lib/notificationStatus";
import { makeSessionId } from "../../lib/constants";
import { getTerminalBufferLines } from "../terminal/XTermWrapper";

/** Transpose row-major split indices to column-major for legacy data migration */
function transposeSplitRowsToCols(splitRows: number[][]): number[][] {
  if (!splitRows.length) return [];
  const maxCols = Math.max(...splitRows.map((r) => r.length));
  const cols: number[][] = [];
  for (let c = 0; c < maxCols; c++) {
    const col: number[] = [];
    for (const row of splitRows) {
      if (c < row.length) col.push(row[c]);
    }
    if (col.length > 0) cols.push(col);
  }
  return cols;
}

function normalizeSplitColumns(ws: Workspace): string[][] | null {
  const columns = ws.splitColumns
    ?.map((col) => col.filter((id) => ws.panes.some((pane) => pane.id === id)))
    .filter((col) => col.length > 0);
  return columns && columns.length > 0 ? columns : null;
}

function normalizeColumnWidths(ws: Workspace, splitColumns: string[][] | null): number[] | null {
  if (!splitColumns || !ws.columnWidths || ws.columnWidths.length !== splitColumns.length) {
    return null;
  }
  return ws.columnWidths;
}

function normalizeRowHeightsPerCol(ws: Workspace, splitColumns: string[][] | null): number[][] | null {
  if (!splitColumns || !ws.rowHeightsPerCol) {
    return null;
  }
  const rows = splitColumns.map((col, idx) => {
    const saved = ws.rowHeightsPerCol?.[idx];
    return saved && saved.length === col.length ? saved : [];
  });
  return rows.some((row) => row.length > 0) ? rows : null;
}

function inferAgentKindFromAgentId(agentId?: string | null): AgentSessionKind | null {
  if (agentId === "claude-code") return "claude";
  if (agentId === "codex") return "codex";
  if (agentId === "claude-codex") return "claude-codex";
  return null;
}

function getTerminalSnapshot(sessionId: string): string[] | null {
  const lines = getTerminalBufferLines(sessionId, 160);
  return lines.length > 0 ? lines : null;
}

const STARTUP_RESTORE_AUTOSAVE_BASE_HOLD_MS = 1400;
const STARTUP_RESTORE_AUTOSAVE_PER_WORKSPACE_MS = 700;
const STARTUP_RESTORE_AUTOSAVE_PER_PANE_MS = 500;
const STARTUP_RESTORE_AUTOSAVE_MAX_HOLD_MS = 30000;

function getMappingKind(
  mapping: AgentSessionMapping | undefined,
  existingKind: AgentSessionKind | null,
): AgentSessionKind | null {
  if (!mapping?.session_id) return null;
  return mapping.agent_kind ?? existingKind ?? "claude";
}

function getTabConfigKind(
  tabConfig: PaneTabConfig,
  fallbackAgentId?: string | null,
): AgentSessionKind | null {
  return tabConfig.agent_kind
    ?? (tabConfig.claude_session_id ? "claude" : null)
    ?? inferAgentKindFromAgentId(tabConfig.agent_id || fallbackAgentId);
}

function getTabConfigSessionId(tabConfig: PaneTabConfig): string | null {
  return tabConfig.agent_session_id ?? tabConfig.claude_session_id ?? null;
}

function getPaneConfigKind(paneConfig: PaneConfig): AgentSessionKind | null {
  return paneConfig.agent_kind
    ?? (paneConfig.claude_session_id ? "claude" : null)
    ?? inferAgentKindFromAgentId(paneConfig.agent_id);
}

function getPaneConfigSessionId(paneConfig: PaneConfig): string | null {
  return paneConfig.agent_session_id ?? paneConfig.claude_session_id ?? null;
}

function applyMappingToTabConfig(
  tabConfig: PaneTabConfig,
  mapping: AgentSessionMapping | undefined,
  fallbackAgentId?: string | null,
): PaneTabConfig {
  const existingKind = getTabConfigKind(tabConfig, fallbackAgentId);
  const existingSessionId = getTabConfigSessionId(tabConfig);
  const mappingKind = getMappingKind(mapping, existingKind);
  if (!mapping?.session_id || !mappingKind) return tabConfig;
  if (existingSessionId && existingSessionId !== mapping.session_id) return tabConfig;
  if (existingKind && existingKind !== mappingKind) return tabConfig;

  return {
    ...tabConfig,
    agent_kind: tabConfig.agent_kind ?? mappingKind,
    agent_session_id: tabConfig.agent_session_id ?? mapping.session_id,
    claude_session_id: mappingKind === "claude"
      ? tabConfig.claude_session_id ?? mapping.session_id
      : tabConfig.claude_session_id,
  };
}

function applyMappingToPaneConfig(
  paneConfig: PaneConfig,
  mapping: AgentSessionMapping | undefined,
): PaneConfig {
  const existingKind = getPaneConfigKind(paneConfig);
  const existingSessionId = getPaneConfigSessionId(paneConfig);
  const mappingKind = getMappingKind(mapping, existingKind);
  if (!mapping?.session_id || !mappingKind) return paneConfig;
  if (existingSessionId && existingSessionId !== mapping.session_id) return paneConfig;
  if (existingKind && existingKind !== mappingKind) return paneConfig;

  return {
    ...paneConfig,
    agent_kind: paneConfig.agent_kind ?? mappingKind,
    agent_session_id: paneConfig.agent_session_id ?? mapping.session_id,
    claude_session_id: mappingKind === "claude"
      ? paneConfig.claude_session_id ?? mapping.session_id
      : paneConfig.claude_session_id,
  };
}

function applyMappingsToConfig(
  cfg: WorkspaceConfig,
  agentMappings: Record<string, AgentSessionMapping>,
): WorkspaceConfig {
  return {
    ...cfg,
    panes: cfg.panes.map((paneConfig) => {
      const paneId = paneConfig.pane_id;
      if (!paneId) return paneConfig;

      const paneSessionId = makeSessionId(cfg.id, paneId);
      const paneMapping = agentMappings[paneSessionId];
      const tabs = paneConfig.tabs?.map((tabConfig, index) => {
        const tabId = tabConfig.tab_id;
        if (!tabId) return tabConfig;
        const tabSessionId = makeSessionId(cfg.id, `${paneId}-${tabId}`);
        const tabMapping = agentMappings[tabSessionId];
        const isActiveTab = paneConfig.active_tab_id
          ? tabId === paneConfig.active_tab_id
          : index === 0;
        return applyMappingToTabConfig(
          tabConfig,
          tabMapping ?? (isActiveTab ? paneMapping : undefined),
          paneConfig.agent_id,
        );
      });

      const mappedPane = applyMappingToPaneConfig(paneConfig, paneMapping);
      return tabs ? { ...mappedPane, tabs } : mappedPane;
    }),
  };
}

function tabConfigHasRestorableAgentSession(tab: PaneTabConfig): boolean {
  return Boolean((tab.agent_kind && tab.agent_session_id) || tab.claude_session_id);
}

function paneConfigHasRestorableAgentSession(pane: PaneConfig): boolean {
  return Boolean(
    (pane.agent_kind && pane.agent_session_id)
    || pane.claude_session_id
    || pane.tabs?.some(tabConfigHasRestorableAgentSession),
  );
}

function workspaceConfigHasRestorableAgentSession(cfg: WorkspaceConfig): boolean {
  return cfg.panes.some(paneConfigHasRestorableAgentSession);
}

function paneConfigRestorableAgentSessionCount(pane: PaneConfig): number {
  const tabCount = pane.tabs?.filter(tabConfigHasRestorableAgentSession).length ?? 0;
  if (tabCount > 0) return tabCount;
  return paneConfigHasRestorableAgentSession(pane) ? 1 : 0;
}

function workspaceConfigRestorableAgentSessionCount(cfg: WorkspaceConfig): number {
  return cfg.panes.reduce(
    (count, pane) => count + paneConfigRestorableAgentSessionCount(pane),
    0,
  );
}

function getConfigAgentSessionKey(
  kind: AgentSessionKind | null | undefined,
  sessionId: string | null | undefined,
): string | null {
  if (!kind || !sessionId) return null;
  return `${kind}:${sessionId}`;
}

function getTabAgentSessionKey(tab: PaneTabConfig): string | null {
  const kind = tab.agent_kind ?? (tab.claude_session_id ? "claude" : null);
  const sessionId = tab.agent_session_id ?? tab.claude_session_id ?? null;
  return getConfigAgentSessionKey(kind, sessionId);
}

function clearTabAgentSession(tab: PaneTabConfig): PaneTabConfig {
  return {
    ...tab,
    claude_session_id: null,
    agent_kind: null,
    agent_session_id: null,
  };
}

function clearAgentTerminalSnapshot(tab: PaneTabConfig): PaneTabConfig {
  return {
    ...tab,
    terminal_snapshot: null,
  };
}

function agentIdForSessionKind(kind: AgentSessionKind | null | undefined): string | null {
  if (kind === "claude") return "claude-code";
  if (kind === "codex") return "codex";
  if (kind === "claude-codex") return "shell-starter";
  return null;
}

function normalizeAgentSessionTab(tab: PaneTabConfig): PaneTabConfig {
  const kind = tab.agent_kind ?? (tab.claude_session_id ? "claude" : null);
  const agentId = agentIdForSessionKind(kind);
  return {
    ...clearAgentTerminalSnapshot(tab),
    agent_id: agentId ?? tab.agent_id,
  };
}

function syncPaneAgentSessionFromActiveTab(pane: PaneConfig, tabs: PaneTabConfig[] | null | undefined): PaneConfig {
  if (!tabs || tabs.length === 0) {
    return pane;
  }
  const activeTab = tabs.find((tab) => tab.tab_id === pane.active_tab_id) ?? tabs[0];
  const kind = activeTab.agent_kind ?? (activeTab.claude_session_id ? "claude" : null);
  const sessionId = activeTab.agent_session_id ?? activeTab.claude_session_id ?? null;
  return {
    ...pane,
    tabs,
    agent_id: activeTab.agent_id ?? pane.agent_id,
    claude_session_id: kind === "claude" ? sessionId : null,
    agent_kind: sessionId ? kind : null,
    agent_session_id: sessionId,
  };
}

function dedupeAgentSessionsInConfigs(
  configs: WorkspaceConfig[],
  activeWorkspaceId: string | null | undefined,
  activePaneId: string | null | undefined,
  activeTabId: string | null | undefined,
): WorkspaceConfig[] {
  const winningCandidateIds = new Set<string>();
  const claimedKeys = new Set<string>();
  const candidates: Array<{
    candidateId: string;
    key: string;
    isActive: boolean;
    order: number;
  }> = [];
  let order = 0;

  configs.forEach((cfg, workspaceIndex) => {
    const isActiveWorkspace = cfg.id === activeWorkspaceId;
    cfg.panes.forEach((pane, paneIndex) => {
      const tabs = pane.tabs ?? [];
      tabs.forEach((tab, tabIndex) => {
        const key = getTabAgentSessionKey(tab);
        if (!key) return;
        const isActivePane = isActiveWorkspace && pane.pane_id === activePaneId;
        const isActiveTab = isActiveWorkspace && tab.tab_id === activeTabId;
        const isPaneActiveTab = isActivePane && tab.tab_id === pane.active_tab_id;
        candidates.push({
          candidateId: `${workspaceIndex}:${paneIndex}:${tabIndex}`,
          key,
          isActive: isActiveTab || isPaneActiveTab,
          order: order++,
        });
      });
    });
  });

  candidates
    .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.order - b.order)
    .forEach((candidate) => {
      if (claimedKeys.has(candidate.key)) return;
      claimedKeys.add(candidate.key);
      winningCandidateIds.add(candidate.candidateId);
    });

  return configs.map((cfg, workspaceIndex) => ({
    ...cfg,
    panes: cfg.panes.map((pane, paneIndex) => {
      if (!pane.tabs || pane.tabs.length === 0) return pane;
      const tabs = pane.tabs.map((tab, tabIndex) => {
        const key = getTabAgentSessionKey(tab);
        if (!key) return tab;
        const candidateId = `${workspaceIndex}:${paneIndex}:${tabIndex}`;
        return winningCandidateIds.has(candidateId)
          ? normalizeAgentSessionTab(tab)
          : clearTabAgentSession(tab);
      });
      return syncPaneAgentSessionFromActiveTab(pane, tabs);
    }),
  }));
}

// Must stay in sync with the remove_var() list in src-tauri/src/lib.rs::run().
// Anything that lib.rs strips at startup must also be stripped before persistence,
// otherwise saved launch_env can re-inject MYCMUX_* into a freshly spawned pane on
// next launch (env-pollution → unintended agent auto-resume).
const EPHEMERAL_LAUNCH_ENV_KEYS = new Set([
  "MYCMUX_RESUME",
  "MYCMUX_SESSION_ID",
  "MYCMUX_AGENT_KIND",
  "MYCMUX_HANDOFF",
  "MYCMUX_HANDOFF_FROM",
  "MYCMUX_HANDOFF_PROMPT_FILE",
  "MYCMUX_HANDOFF_FROM_SESSION",
  "MYCMUX_PANE_SESSION_ID",
  "MYCMUX_TAB_ID",
  "__CMUX_LAUNCHER_DONE",
]);

function stripEphemeralLaunchEnv(
  env: Record<string, string> | null | undefined,
): Record<string, string> | null {
  if (!env) return null;
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!EPHEMERAL_LAUNCH_ENV_KEYS.has(k)) {
      filtered[k] = v;
    }
  }
  return Object.keys(filtered).length > 0 ? filtered : null;
}

function toConfig(ws: Workspace, _agentMappings: Record<string, AgentSessionMapping> = {}): WorkspaceConfig {
  const paneIdToIndex = new Map(ws.panes.map((p, i) => [p.id, i]));
  const splitColumns = normalizeSplitColumns(ws);
  const split_columns = splitColumns
    ?.map((col) => col.map((id) => paneIdToIndex.get(id)).filter((i): i is number => i !== undefined))
    .filter((col) => col.length > 0) ?? null;

  const metaState = usePaneMetadataStore.getState().metadata;

  return {
    id: ws.id,
    name: ws.name,
    grid_template_id: ws.gridTemplateId,
    panes: ws.panes.map((p) => {
      const activeTab = p.tabs.find((tab) => tab.id === p.activeTabId) ?? p.tabs[0];
      const paneMeta = metaState[p.sessionId];
      const activeTabMeta = activeTab ? metaState[activeTab.sessionId] : undefined;
      const paneCwd = paneMeta?.cwd ?? activeTab?.cwd ?? p.cwd ?? null;
      // 4-level fallback so live agent session metadata never disappears even
      // if the workspaceListStore mirror lags one event behind:
      //   1. Pane.{claudeSessionId,agentKind,agentSessionId}
      //   2. activeTab.{...}
      //   3. paneMetadataStore[pane.sessionId]
      //   4. paneMetadataStore[activeTab.sessionId]
      const liveClaudeId =
        p.claudeSessionId
        ?? activeTab?.claudeSessionId
        ?? paneMeta?.claudeSessionId
        ?? activeTabMeta?.claudeSessionId
        ?? null;
      const liveKind =
        p.agentKind
        ?? activeTab?.agentKind
        ?? paneMeta?.agentKind
        ?? activeTabMeta?.agentKind
        ?? null;
      const liveAgentId =
        p.agentSessionId
        ?? activeTab?.agentSessionId
        ?? paneMeta?.agentSessionId
        ?? activeTabMeta?.agentSessionId
        ?? null;
      return {
        pane_id: p.id,
        agent_id: activeTab?.agentId ?? p.agentId,
        label: p.label ?? null,
        cwd: paneCwd,
        last_process: null,
        claude_session_id: liveClaudeId,
        agent_kind: liveKind,
        agent_session_id: liveAgentId,
        launch_env: stripEphemeralLaunchEnv(p.launchEnv ?? activeTab?.launchEnv),
        active_tab_id: p.activeTabId,
        tabs: p.tabs.map((tab) => {
          const tabMeta = metaState[tab.sessionId];
          return {
            tab_id: tab.id,
            agent_id: tab.agentId,
            label: tab.label ?? null,
            type: tab.type ?? "terminal",
            cwd: tabMeta?.cwd ?? tab.cwd ?? paneCwd,
            last_process: null,
            claude_session_id: tab.claudeSessionId ?? tabMeta?.claudeSessionId ?? null,
            agent_kind: tab.agentKind ?? tabMeta?.agentKind ?? null,
            agent_session_id: tab.agentSessionId ?? tabMeta?.agentSessionId ?? null,
            launch_env: stripEphemeralLaunchEnv(tab.launchEnv),
            terminal_snapshot: getTerminalSnapshot(tab.sessionId) ?? tab.terminalSnapshot ?? null,
          };
        }),
      };
    }),
    created_at: ws.createdAt,
    split_columns,
    column_widths: normalizeColumnWidths(ws, splitColumns),
    row_heights_per_col: normalizeRowHeightsPerCol(ws, splitColumns),
  };
}

let _resolveLoaded: () => void;
export const persistLoaded = new Promise<void>((resolve) => {
  _resolveLoaded = resolve;
});

export function useWorkspacePersist() {
  const loaded = useRef(false);
  const isLeader = useRef(false);
  const lastActivePaneSessionId = useRef<string | null>(null);
  const startupAutosaveHoldUntil = useRef(0);

  // Load on mount — only leader bootstraps
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;

    claimLeader()
      .then((gotLeadership) => {
        isLeader.current = gotLeadership;
        if (!gotLeadership) {
          _resolveLoaded();
          return;
        }
        // Leader: load persisted data
        return loadPersistentData().then(async (data) => {
          let startupAgentMappings: Record<string, AgentSessionMapping> = {};
          try {
            startupAgentMappings = await readAgentSessionMappings();
          } catch (err) {
            console.warn("[persist] Failed to read startup agent session mappings:", err);
          }
          useThemeStore.getState().hydrateSettings({
            themeId: data.settings.theme_id,
            fontSize: data.settings.font_size,
            fontFamily: data.settings.font_family,
          });
          useKeybindingStore.getState().hydrateOverrides(data.settings.keybindings ?? {});

          if (data.workspaces.length > 0) {
            const listStore = useWorkspaceListStore.getState();
            const layoutStore = useWorkspaceLayoutStore.getState();
            let restoredActivePaneSessionId: string | null = null;
            const bootstrapWorkspaceIds = new Set(listStore.workspaces.map((ws) => ws.id));
            const restoredConfigs = dedupeAgentSessionsInConfigs(
              data.workspaces.map((cfg) => applyMappingsToConfig(cfg, startupAgentMappings)),
              data.active_workspace_id,
              data.active_pane_id,
              data.active_tab_id,
            );
            const startupRestoreTargetWorkspaceCount = restoredConfigs.filter(workspaceConfigHasRestorableAgentSession).length;
            const startupRestoreTargetPaneCount = restoredConfigs.reduce(
              (count, cfg) => count + workspaceConfigRestorableAgentSessionCount(cfg),
              0,
            );
            startupAutosaveHoldUntil.current = startupRestoreTargetPaneCount > 0
              ? Date.now() + Math.min(
                  STARTUP_RESTORE_AUTOSAVE_MAX_HOLD_MS,
                  STARTUP_RESTORE_AUTOSAVE_BASE_HOLD_MS
                    + startupRestoreTargetWorkspaceCount * STARTUP_RESTORE_AUTOSAVE_PER_WORKSPACE_MS
                    + startupRestoreTargetPaneCount * STARTUP_RESTORE_AUTOSAVE_PER_PANE_MS,
                )
              : 0;

            if (listStore.workspaces.length <= 1) {
              for (const cfg of restoredConfigs) {
                // Use split_columns if available; fall back to transposed split_rows for old data
                const splitData = cfg.split_columns
                  ?? (cfg.split_rows ? transposeSplitRowsToCols(cfg.split_rows) : null);
                const { panes, splitColumns } = layoutStore.restorePanes(
                  cfg.id,
                  cfg.panes,
                  splitData,
                  cfg.grid_template_id as Workspace["gridTemplateId"],
                );

                listStore.createWorkspace(
                  cfg.name,
                  cfg.grid_template_id as Workspace["gridTemplateId"],
                  panes,
                  splitColumns,
                  {
                    id: cfg.id,
                    createdAt: cfg.created_at,
                    columnWidths: cfg.column_widths ?? undefined,
                    rowHeightsPerCol: cfg.row_heights_per_col ?? undefined,
                    activate: false,
                  },
                );

                if (cfg.id === data.active_workspace_id) {
                  const activePane = data.active_pane_id
                    ? panes.find((pane) => pane.id === data.active_pane_id)
                    : panes.find((pane) => pane.tabs.some((tab) => tab.id === data.active_tab_id));
                  const activeTab = activePane?.tabs.find((tab) => tab.id === data.active_tab_id);
                  restoredActivePaneSessionId = activeTab?.sessionId ?? activePane?.sessionId ?? null;
                }
              }
              const restoredWorkspaceIds = new Set(restoredConfigs.map((cfg) => cfg.id));
              for (const bootstrapId of bootstrapWorkspaceIds) {
                if (!restoredWorkspaceIds.has(bootstrapId)) {
                  listStore.removeWorkspace(bootstrapId);
                }
              }

              const fallbackWorkspaceId = restoredConfigs[restoredConfigs.length - 1]?.id ?? null;
              const nextActiveWorkspaceId =
                data.active_workspace_id && restoredWorkspaceIds.has(data.active_workspace_id)
                  ? data.active_workspace_id
                  : fallbackWorkspaceId ?? restoredConfigs[0]?.id ?? null;

              if (nextActiveWorkspaceId) {
                useWorkspaceListStore.getState().setActiveWorkspace(nextActiveWorkspaceId);
              }
              if (!restoredActivePaneSessionId && nextActiveWorkspaceId) {
                restoredActivePaneSessionId =
                  useWorkspaceListStore.getState().getWorkspace(nextActiveWorkspaceId)?.panes[0]?.sessionId ?? null;
              }
              lastActivePaneSessionId.current = restoredActivePaneSessionId;
              useUiStore.getState().setActivePaneId(restoredActivePaneSessionId);
            }
          }
          _resolveLoaded();
        });
      })
      .catch((err) => {
        console.warn("[persist] Failed to load:", err);
        _resolveLoaded();
      });
  }, []);

  // Auto-save — only leader saves. Dirty-flag + debounce (interval retired).
  useEffect(() => {
    let dirty = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let syncInFlight: Promise<void> | null = null;
    let closing = false;
    let closePromptOpen = false;

    const buildSnapshot = (agentMappings: Record<string, AgentSessionMapping> = {}) => {
      const state = useWorkspaceListStore.getState();
      const uiState = useUiStore.getState();
      const activeWorkspaceId = state.activeWorkspaceId ?? null;
      const activeWorkspace = activeWorkspaceId
        ? state.workspaces.find((ws) => ws.id === activeWorkspaceId)
        : null;
      const activeSessionId = uiState.activePaneId ?? lastActivePaneSessionId.current;
      const activePane = activeWorkspace?.panes.find((pane) =>
        pane.sessionId === activeSessionId || pane.tabs.some((tab) => tab.sessionId === activeSessionId),
      ) ?? activeWorkspace?.panes[0] ?? null;
      const activeTab = activePane?.tabs.find((tab) => tab.sessionId === activeSessionId)
        ?? activePane?.tabs.find((tab) => tab.id === activePane.activeTabId)
        ?? activePane?.tabs[0]
        ?? null;
      const themeState = useThemeStore.getState();
      const keybindingState = useKeybindingStore.getState();

      const workspaces = dedupeAgentSessionsInConfigs(
        state.workspaces.map((ws) => toConfig(ws, agentMappings)),
        activeWorkspaceId,
        activePane?.id ?? null,
        activeTab?.id ?? null,
      );

      return {
        schema_version: 1,
        workspaces,
        settings: {
          theme_id: themeState.themeId,
          font_size: themeState.fontSize,
          font_family: themeState.fontFamily,
          keybindings: keybindingState.overrides,
        },
        active_workspace_id: activeWorkspaceId,
        active_pane_id: activePane?.id ?? null,
        active_tab_id: activeTab?.id ?? null,
      };
    };

    const sync = async (force = false) => {
      if (!isLeader.current) return;
      if (syncInFlight) {
        await syncInFlight.catch(() => {});
      }
      if (!dirty && !force) return;
      const startupHoldRemainingMs = startupAutosaveHoldUntil.current - Date.now();
      if (!force && startupHoldRemainingMs > 0) {
        dirty = true;
        scheduleSync(startupHoldRemainingMs + 100);
        return;
      }
      let agentMappings: Record<string, AgentSessionMapping> = {};
      try {
        agentMappings = await readAgentSessionMappings();
      } catch (err) {
        console.warn("[persist] Failed to read agent session mappings:", err);
      }
      dirty = false;
      const run = savePersistentData(buildSnapshot(agentMappings));
      syncInFlight = run;
      try {
        await run;
      } catch (err) {
        dirty = true; // allow next trigger to retry
        console.warn("[persist] Failed to save:", err);
      } finally {
        if (syncInFlight === run) {
          syncInFlight = null;
        }
      }
    };

    function scheduleSync(delayMs = 500): void {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void sync();
      }, delayMs);
    }

    const debouncedSync = () => {
      scheduleSync(500);
    };

    const markDirty = () => {
      dirty = true;
      debouncedSync();
    };

    const countBusySessions = () => {
      const { workspaces } = useWorkspaceListStore.getState();
      const { metadata } = usePaneMetadataStore.getState();
      const sessionIds = new Set<string>();

      for (const workspace of workspaces) {
        for (const pane of workspace.panes) {
          if (pane.tabs.length === 0) {
            sessionIds.add(pane.sessionId);
            continue;
          }
          for (const tab of pane.tabs) {
            sessionIds.add(tab.sessionId);
          }
        }
      }

      let busyCount = 0;
      for (const sessionId of sessionIds) {
        const status = deriveEffectiveStatus(metadata[sessionId]);
        if (status === "working" || status === "waiting") {
          busyCount += 1;
        }
      }
      return busyCount;
    };

    const unsubList = useWorkspaceListStore.subscribe(markDirty);
    const unsubLayout = useWorkspaceLayoutStore.subscribe(markDirty);
    const unsubMeta = usePaneMetadataStore.subscribe(markDirty);
    const unsubTheme = useThemeStore.subscribe(markDirty);
    const unsubKeys = useKeybindingStore.subscribe(markDirty);
    const unsubUi = useUiStore.subscribe((state, prevState) => {
      if (state.activePaneId) {
        lastActivePaneSessionId.current = state.activePaneId;
      }
      if (state.activePaneId !== prevState.activePaneId) markDirty();
    });

    const handleBeforeUnload = () => {
      if (dirty) {
        // Flush synchronously on unload — debounce timer won't fire in time.
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        void sync(true);
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    const unlistenCloseRequested = getCurrentWindow().onCloseRequested(async (event) => {
      if (closing || closePromptOpen) {
        event.preventDefault();
        return;
      }
      const busyCount = countBusySessions();
      event.preventDefault();

      if (busyCount > 0) {
        closePromptOpen = true;
        let shouldQuit = false;
        try {
          shouldQuit = await confirm(
            `実行中または入力待ちのセッションが ${busyCount} 件あります。終了するとすべての端末を閉じます。終了しますか？`,
            {
              title: "mycmux を終了",
              kind: "warning",
              okLabel: "終了",
              cancelLabel: "キャンセル",
            },
          );
        } catch (err) {
          console.warn("[persist] Failed to show quit confirmation:", err);
          return;
        } finally {
          closePromptOpen = false;
        }
        if (!shouldQuit) return;
      }

      closing = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      try {
        await sync(true);
      } finally {
        await quitApp();
      }
    });

    return () => {
      unsubList();
      unsubLayout();
      unsubMeta();
      unsubTheme();
      unsubKeys();
      unsubUi();
      if (debounceTimer) clearTimeout(debounceTimer);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      unlistenCloseRequested.then((f) => f()).catch(() => {});
    };
  }, []);

}

export default function SocketListener() {
  return null;
}
