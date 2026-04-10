import { useEffect, useRef } from "react";
import { 
  useWorkspaceListStore, 
  useWorkspaceLayoutStore,
  usePaneMetadataStore,
  useUiStore,
} from "../../stores/workspaceStore";
import {
  loadPersistentData,
  saveWorkspaces,
  getAllCwds,
  claimLeader,
  saveSettings,
  writeRestoreManifest,
  readPaneSessionMappings,
  type WorkspaceConfig,
} from "../../lib/ipc";
import type { Workspace } from "../../types";
import { useThemeStore } from "../../stores/themeStore";
import { useKeybindingStore } from "../../stores/keybindingStore";

function toConfig(
  ws: Workspace,
  cwds: Record<string, string>,
  toolSessionIds: Record<string, string>,
): WorkspaceConfig {
  const metaState = usePaneMetadataStore.getState().metadata;
  const paneIdToIndex = new Map(ws.panes.map((p, i) => [p.id, i]));
  const split_rows = ws.splitRows
    ?.map((row) => row.map((id) => paneIdToIndex.get(id)).filter((i): i is number => i !== undefined))
    .filter((row) => row.length > 0) ?? null;

  return {
    id: ws.id,
    name: ws.name,
    grid_template_id: ws.gridTemplateId,
    panes: ws.panes.map((p) => {
      const activeTab = p.tabs.find((tab) => tab.id === p.activeTabId) ?? p.tabs[0];
      const activeMeta = activeTab ? metaState[activeTab.sessionId] : undefined;
      const activeCwd = activeTab
        ? cwds[activeTab.sessionId] ?? activeMeta?.cwd ?? activeTab.cwd ?? p.cwd ?? null
        : p.cwd ?? null;
      const activeLastProcess = activeMeta?.processTitle ?? activeTab?.lastProcess ?? p.lastProcess ?? null;
      const activeToolSessionId = activeTab
        ? toolSessionIds[activeTab.sessionId] ?? activeTab.claudeSessionId ?? p.claudeSessionId ?? null
        : p.claudeSessionId ?? null;

      return {
        pane_id: p.id,
        agent_id: activeTab?.agentId ?? p.agentId,
        label: p.label ?? null,
        cwd: activeCwd,
        last_process: activeLastProcess,
        claude_session_id: activeToolSessionId,
        active_tab_id: p.activeTabId,
        tabs: p.tabs.map((tab) => {
          const tabMeta = metaState[tab.sessionId];
          return {
            tab_id: tab.id,
            agent_id: tab.agentId,
            label: tab.label ?? null,
            type: tab.type ?? "terminal",
            cwd: cwds[tab.sessionId] ?? tabMeta?.cwd ?? tab.cwd ?? null,
            last_process: tabMeta?.processTitle ?? tab.lastProcess ?? null,
            claude_session_id: toolSessionIds[tab.sessionId] ?? tab.claudeSessionId ?? null,
          };
        }),
      };
    }),
    created_at: ws.createdAt,
    color: ws.color ?? null,
    split_rows,
    row_sizes: ws.rowSizes ?? null,
    column_sizes: ws.columnSizes ?? null,
  };
}

let _resolveLoaded: () => void;
export const persistLoaded = new Promise<void>((resolve) => {
  _resolveLoaded = resolve;
});

export function useWorkspacePersist() {
  const loaded = useRef(false);
  const isLeader = useRef(false);

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
        return loadPersistentData().then((data) => {
          useThemeStore.getState().hydrateSettings({
            themeId: data.settings.theme_id,
            fontSize: data.settings.font_size,
          });
          useKeybindingStore.getState().hydrateOverrides(data.settings.keybindings ?? {});

          if (data.workspaces.length > 0) {
            const listStore = useWorkspaceListStore.getState();
            const layoutStore = useWorkspaceLayoutStore.getState();
            let restoredActivePaneSessionId: string | null = null;

            if (listStore.workspaces.length <= 1) {
              for (const cfg of data.workspaces) {
                const { panes, splitRows } = layoutStore.restorePanes(
                  cfg.id,
                  cfg.panes,
                  cfg.split_rows ?? null,
                  cfg.grid_template_id as Workspace["gridTemplateId"],
                );

                listStore.createWorkspace(
                  cfg.name,
                  cfg.grid_template_id as Workspace["gridTemplateId"],
                  panes,
                  splitRows,
                  {
                    id: cfg.id,
                    createdAt: cfg.created_at,
                    color: cfg.color ?? undefined,
                    rowSizes: cfg.row_sizes ?? undefined,
                    columnSizes: cfg.column_sizes ?? undefined,
                    activate: false,
                  },
                );

                if (cfg.id === data.active_workspace_id && data.active_pane_id) {
                  const activePane = panes.find((pane) => pane.id === data.active_pane_id);
                  restoredActivePaneSessionId = activePane?.sessionId ?? null;
                }
              }
              const bootstrapWs = listStore.workspaces[0];
              if (bootstrapWs && data.workspaces.length > 0) {
                listStore.removeWorkspace(bootstrapWs.id);
              }

              const fallbackWorkspaceId = data.workspaces[data.workspaces.length - 1]?.id ?? null;
              const nextActiveWorkspaceId =
                data.active_workspace_id ?? fallbackWorkspaceId ?? data.workspaces[0]?.id ?? null;

              if (nextActiveWorkspaceId) {
                useWorkspaceListStore.getState().setActiveWorkspace(nextActiveWorkspaceId);
              }
              if (!restoredActivePaneSessionId && nextActiveWorkspaceId) {
                restoredActivePaneSessionId =
                  useWorkspaceListStore.getState().getWorkspace(nextActiveWorkspaceId)?.panes[0]?.sessionId ?? null;
              }
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

  // Auto-save — only leader saves
  useEffect(() => {
    let lastCwds: Record<string, string> = {};

    const sync = async () => {
      if (!isLeader.current) return; // Only leader saves
      try {
        lastCwds = await getAllCwds();
        const state = useWorkspaceListStore.getState();
        const uiState = useUiStore.getState();
        const metaState = usePaneMetadataStore.getState().metadata;

        // Read pane → tool-session-id mappings written by launcher.sh
        let toolSessionIds: Record<string, string> = {};
        try {
          toolSessionIds = await readPaneSessionMappings();
        } catch { /* ignore */ }

        const configs = state.workspaces.map((ws) => toConfig(ws, lastCwds, toolSessionIds));
        const activeWorkspaceId = state.activeWorkspaceId ?? null;
        const activePaneKey = activeWorkspaceId
          ? state.workspaces
              .find((ws) => ws.id === activeWorkspaceId)
              ?.panes.find((pane) => pane.sessionId === uiState.activePaneId)?.id ?? null
          : null;
        await saveWorkspaces(configs, activeWorkspaceId, activePaneKey);

        const themeState = useThemeStore.getState();
        const keybindingState = useKeybindingStore.getState();
        await saveSettings({
          theme_id: themeState.themeId,
          font_size: themeState.fontSize,
          keybindings: keybindingState.overrides,
        });

        // Write restore manifest for auto-resume on restart
        const restoreEntries: [string, string][] = [];
        for (const ws of state.workspaces) {
          for (const pane of ws.panes) {
            const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId);
            const activeSessionId = activeTab?.sessionId ?? pane.sessionId;
            const cwd = lastCwds[activeSessionId] ?? metaState[activeSessionId]?.cwd ?? activeTab?.cwd ?? pane.cwd;
            const proc = metaState[activeSessionId]?.processTitle
              ?? metaState[activeSessionId]?.lastLogLine
              ?? "";
            if (cwd) {
              restoreEntries.push([cwd, proc]);
            }
          }
        }
        if (restoreEntries.length > 0) {
          writeRestoreManifest(restoreEntries).catch(() => {});
        }
      } catch (err) {
        console.warn("[persist] Failed to save with CWD:", err);
      }
    };

    const unsub = useWorkspaceListStore.subscribe(() => {
      sync();
    });
    const unsubUi = useUiStore.subscribe((state, prevState) => {
      if (state.activePaneId !== prevState.activePaneId) {
        sync();
      }
    });

    const interval = setInterval(sync, 10000);

    return () => {
      unsub();
      unsubUi();
      clearInterval(interval);
    };
  }, []);
}

export default function SocketListener() {
  return null;
}
