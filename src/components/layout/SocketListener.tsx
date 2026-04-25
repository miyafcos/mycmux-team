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
  quitApp,
  type WorkspaceConfig,
} from "../../lib/ipc";
import type { Workspace } from "../../types";
import { useThemeStore } from "../../stores/themeStore";
import { useKeybindingStore } from "../../stores/keybindingStore";
import { deriveEffectiveStatus } from "../../lib/notificationStatus";

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

function toConfig(ws: Workspace): WorkspaceConfig {
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
      const paneCwd = paneMeta?.cwd ?? activeTab?.cwd ?? p.cwd ?? null;
      const paneClaudeSessionId =
        paneMeta?.claudeSessionId ?? activeTab?.claudeSessionId ?? p.claudeSessionId ?? null;
      return {
        pane_id: p.id,
        agent_id: activeTab?.agentId ?? p.agentId,
        label: p.label ?? null,
        cwd: paneCwd,
        last_process: null,
        claude_session_id: paneClaudeSessionId,
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
            claude_session_id: tabMeta?.claudeSessionId ?? tab.claudeSessionId ?? null,
          };
        }),
      };
    }),
    created_at: ws.createdAt,
    color: ws.color ?? null,
    split_columns,
    column_widths: normalizeColumnWidths(ws, splitColumns),
    row_heights_per_col: normalizeRowHeightsPerCol(ws, splitColumns),
  };
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

let _resolveLoaded: () => void;
export const persistLoaded = new Promise<void>((resolve) => {
  _resolveLoaded = resolve;
});

export function useWorkspacePersist() {
  const loaded = useRef(false);
  const isLeader = useRef(false);
  const lastActivePaneSessionId = useRef<string | null>(null);

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
                    color: cfg.color ?? undefined,
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

    const buildSnapshot = () => {
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

      return {
        schema_version: 1,
        workspaces: state.workspaces.map((ws) => toConfig(ws)),
        settings: {
          theme_id: themeState.themeId,
          font_size: themeState.fontSize,
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
      dirty = false;
      const run = savePersistentData(buildSnapshot());
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

    const debouncedSync = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(sync, 500);
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
      if (!dirty && !syncInFlight && busyCount === 0) return;
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
