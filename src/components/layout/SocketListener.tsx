import { useEffect, useRef } from "react";
import {
  useWorkspaceListStore,
  useWorkspaceLayoutStore,
  useUiStore,
} from "../../stores/workspaceStore";
import {
  loadPersistentData,
  saveWorkspaces,
  claimLeader,
  saveSettings,
  type WorkspaceConfig,
} from "../../lib/ipc";
import type { Workspace } from "../../types";
import { useThemeStore } from "../../stores/themeStore";
import { useKeybindingStore } from "../../stores/keybindingStore";

function toConfig(ws: Workspace): WorkspaceConfig {
  const paneIdToIndex = new Map(ws.panes.map((p, i) => [p.id, i]));
  const split_columns = ws.splitColumns
    ?.map((col) => col.map((id) => paneIdToIndex.get(id)).filter((i): i is number => i !== undefined))
    .filter((col) => col.length > 0) ?? null;

  return {
    id: ws.id,
    name: ws.name,
    grid_template_id: ws.gridTemplateId,
    panes: ws.panes.map((p) => {
      const activeTab = p.tabs.find((tab) => tab.id === p.activeTabId) ?? p.tabs[0];
      return {
        pane_id: p.id,
        agent_id: activeTab?.agentId ?? p.agentId,
        label: p.label ?? null,
        cwd: null,
        last_process: null,
        claude_session_id: null,
        active_tab_id: p.activeTabId,
        tabs: p.tabs.map((tab) => ({
          tab_id: tab.id,
          agent_id: tab.agentId,
          label: tab.label ?? null,
          type: tab.type ?? "terminal",
          cwd: null,
          last_process: null,
          claude_session_id: null,
        })),
      };
    }),
    created_at: ws.createdAt,
    color: ws.color ?? null,
    split_columns,
    column_widths: ws.columnWidths ?? null,
    row_heights_per_col: ws.rowHeightsPerCol ?? null,
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
                // Use split_columns if available; old split_rows data is ignored (layout rebuilds from template)
                const { panes, splitColumns } = layoutStore.restorePanes(
                  cfg.id,
                  cfg.panes,
                  cfg.split_columns ?? null,
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
                    color: cfg.color ?? undefined,
                    columnWidths: cfg.column_widths ?? undefined,
                    rowHeightsPerCol: cfg.row_heights_per_col ?? undefined,
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
    const sync = async () => {
      if (!isLeader.current) return;
      try {
        const state = useWorkspaceListStore.getState();
        const uiState = useUiStore.getState();

        const configs = state.workspaces.map((ws) => toConfig(ws));
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
      } catch (err) {
        console.warn("[persist] Failed to save:", err);
      }
    };

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedSync = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(sync, 500);
    };

    const unsub = useWorkspaceListStore.subscribe(() => {
      debouncedSync();
    });
    const unsubUi = useUiStore.subscribe((state, prevState) => {
      if (state.activePaneId !== prevState.activePaneId) {
        debouncedSync();
      }
    });

    const interval = setInterval(sync, 10000);

    return () => {
      unsub();
      unsubUi();
      clearInterval(interval);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, []);
}

export default function SocketListener() {
  return null;
}
