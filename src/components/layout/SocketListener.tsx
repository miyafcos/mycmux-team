import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  useWorkspaceListStore,
  useWorkspaceLayoutStore,
  useUiStore
} from "../../stores/workspaceStore";
import { sendSocketResponse } from "../../lib/ipc";
import { useThemeStore } from "../../stores/themeStore";
import { useBrowserStore } from "../../stores/browserStore";

interface SocketRequest {
  id: number;
  cmd: string;
  args: any;
}

export default function SocketListener() {
  useEffect(() => {
    const unlisten = listen<SocketRequest>("socket-request", async (event) => {
      const { id, cmd, args } = event.payload;
      let result = null;
      let error = null;

      try {
        const listStore = useWorkspaceListStore.getState();
        const layoutStore = useWorkspaceLayoutStore.getState();
        const uiStore = useUiStore.getState();
        
        switch (cmd) {
          case "workspace.list":
            result = listStore.workspaces.map(w => ({
              id: w.id,
              name: w.name,
              status: w.status,
              active: listStore.activeWorkspaceId === w.id,
            }));
            break;
            
          case "workspace.new":
            const workspaceId = crypto.randomUUID();
            const template = args?.template || "1x1";
            const { panes, splitRows } = layoutStore.buildInitialPanes(workspaceId, template);
            const ws = listStore.createWorkspace(
              args?.name || `Workspace ${listStore.workspaces.length + 1}`,
              template,
              panes,
              splitRows
            );
            result = { id: ws.id, name: ws.name };
            break;
            
          case "workspace.select":
            if (args?.id) {
              listStore.setActiveWorkspace(args.id);
              result = { success: true };
            } else {
              error = "Missing id argument";
            }
            break;
            
          case "workspace.close":
            if (args?.id) {
              listStore.removeWorkspace(args.id);
              result = { success: true };
            } else {
              error = "Missing id argument";
            }
            break;

          case "pane.split-right":
            if (listStore.activeWorkspaceId && uiStore.activePaneId) {
              layoutStore.addPaneToWorkspace(listStore.activeWorkspaceId, uiStore.activePaneId, "right");
              result = { success: true };
            } else {
              error = "No active pane to split";
            }
            break;

          case "pane.split-down":
            if (listStore.activeWorkspaceId && uiStore.activePaneId) {
              layoutStore.addPaneToWorkspace(listStore.activeWorkspaceId, uiStore.activePaneId, "down");
              result = { success: true };
            } else {
              error = "No active pane to split";
            }
            break;

          case "pane.close": {
            const wsId = listStore.activeWorkspaceId;
            const paneId = uiStore.activePaneId;
            if (wsId && paneId) {
              const ws = listStore.workspaces.find((w) => w.id === wsId);
              const pane = ws?.panes.find((p) => p.sessionId === paneId);
              layoutStore.removePaneFromWorkspace(wsId, paneId);
              // Focus a remaining pane
              if (ws && pane) {
                const remaining = ws.panes.filter((p) => p.id !== pane.id);
                if (remaining.length > 0) {
                  uiStore.setActivePaneId(remaining[0].sessionId);
                } else {
                  uiStore.setActivePaneId(null);
                }
              }
              result = { success: true };
            } else {
              error = "No active pane to close";
            }
            break;
          }

          case "browser.navigate":
          case "browser.back":
          case "browser.forward":
          case "browser.reload":
          case "browser.eval":
          case "browser.snapshot":
          case "browser.screenshot":
          case "browser.status": {
            // Find the target browser pane session ID
            const targetPaneId = (() => {
              if (args?.pane_id) return args.pane_id as string;
              // Default to first browser tab in active workspace
              const activeWs = listStore.workspaces.find(
                (w) => w.id === listStore.activeWorkspaceId
              );
              if (!activeWs) return null;
              for (const pane of activeWs.panes) {
                const browserTab = pane.tabs.find((t) => t.type === "browser");
                if (browserTab) return browserTab.sessionId;
              }
              return null;
            })();

            if (!targetPaneId) {
              error = "No browser pane found";
              break;
            }

            const cmdType = cmd.replace("browser.", "") as any;
            result = await useBrowserStore.getState().dispatch(targetPaneId, {
              type: cmdType,
              url: args?.url,
              script: args?.script,
            });
            break;
          }

          case "theme.set":
            if (args?.id) {
              useThemeStore.getState().setTheme(args.id);
              result = { success: true };
            } else {
              error = "Missing id argument";
            }
            break;

          default:
            error = `Unknown command: ${cmd}`;
        }
      } catch (err: any) {
        error = err.toString();
      }

      await sendSocketResponse(id, result, error);
    });

    return () => {
      unlisten.then(f => f());
    };
  }, []);

  return null;
}
