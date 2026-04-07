import { useEffect, useRef } from "react";
import { 
  useWorkspaceListStore, 
  useWorkspaceLayoutStore,
  usePaneMetadataStore 
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
  claudeSessionIds: Record<string, string>,
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
    panes: ws.panes.map((p) => ({
      agent_id: p.agentId,
      label: p.label ?? null,
      cwd: cwds[p.sessionId] ?? metaState[p.sessionId]?.cwd ?? p.cwd ?? null,
      last_process: metaState[p.sessionId]?.processTitle ?? null,
      claude_session_id: claudeSessionIds[p.sessionId] ?? null,
    })),
    created_at: ws.createdAt,
    split_rows,
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

            if (listStore.workspaces.length <= 1) {
              for (const cfg of data.workspaces) {
                const workspaceId = crypto.randomUUID();
                const { panes, splitRows } = layoutStore.restorePanes(
                  workspaceId,
                  cfg.panes,
                  cfg.split_rows ?? null,
                  cfg.grid_template_id as Workspace["gridTemplateId"],
                );

                listStore.createWorkspace(
                  cfg.name,
                  cfg.grid_template_id as Workspace["gridTemplateId"],
                  panes,
                  splitRows,
                );
              }
              const bootstrapWs = listStore.workspaces[0];
              if (bootstrapWs && data.workspaces.length > 0) {
                listStore.removeWorkspace(bootstrapWs.id);
              }
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
        const metaState = usePaneMetadataStore.getState().metadata;

        // Read pane → claude-session-id mappings written by launcher.sh
        let claudeSessionIds: Record<string, string> = {};
        try {
          claudeSessionIds = await readPaneSessionMappings();
        } catch { /* ignore */ }

        const configs = state.workspaces.map((ws) => toConfig(ws, lastCwds, claudeSessionIds));
        await saveWorkspaces(configs);

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
            const cwd = lastCwds[pane.sessionId] ?? metaState[pane.sessionId]?.cwd ?? pane.cwd;
            const proc = metaState[pane.sessionId]?.processTitle
              ?? metaState[pane.sessionId]?.lastLogLine
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

    const interval = setInterval(sync, 10000);

    return () => {
      unsub();
      clearInterval(interval);
    };
  }, []);
}

export default function SocketListener() {
  return null;
}
