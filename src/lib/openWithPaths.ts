import { createWorkspaceAtCwd, workspaceNameFromCwd } from "./workspaceBootstrap";
import { previewArtifactUriForSessionV2 } from "./ipc";
import { isMainWindow } from "./windowContext";
import { useDashboardViewStore } from "../stores/dashboardViewStore";
import { useToastStore } from "../stores/toastStore";
import { useUiStore } from "../stores/uiStore";
import { useWorkspaceLayoutStore } from "../stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";

export const OPEN_PATHS_EVENT = "mycmux://open-paths";

type OpenPane = {
  id: string;
  sessionId: string;
  activeTabId: string;
  tabs: Array<{ id: string; sessionId: string }>;
};
type OpenWorkspace = { id: string; panes: OpenPane[] };
type WorkspaceSelection = { workspaces: OpenWorkspace[]; activeWorkspaceId: string | null };

export function selectOpenTarget(selection: WorkspaceSelection, activeSessionId: string | null) {
  const workspace = selection.workspaces.find((item) => item.id === selection.activeWorkspaceId)
    ?? selection.workspaces[0];
  if (!workspace) return null;
  const pane = workspace.panes.find((item) => item.sessionId === activeSessionId
    || item.tabs.some((tab) => tab.sessionId === activeSessionId)) ?? workspace.panes[0];
  if (!pane) return null;
  const tab = pane.tabs.find((item) => item.id === pane.activeTabId) ?? pane.tabs[0];
  return { workspaceId: workspace.id, paneId: pane.id, sessionId: tab?.sessionId ?? pane.sessionId };
}

export interface OpenPathsDependencies {
  main: () => boolean;
  selection: () => WorkspaceSelection;
  activeSessionId: () => string | null;
  createWorkspace: (path: string) => void;
  preview: typeof previewArtifactUriForSessionV2;
  openPreview: (workspaceId: string, paneId: string, info: Awaited<ReturnType<typeof previewArtifactUriForSessionV2>>) => void;
  showWorkspace: () => void;
  reportError: (message: string) => void;
}

const liveDependencies: OpenPathsDependencies = {
  main: isMainWindow,
  selection: () => useWorkspaceListStore.getState(),
  activeSessionId: () => useUiStore.getState().activePaneId,
  createWorkspace: (path) => {
    const lastSeparator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const cwd = lastSeparator < 0 ? "" : path.slice(0, lastSeparator + 1);
    createWorkspaceAtCwd(cwd, { name: workspaceNameFromCwd(cwd) });
  },
  preview: previewArtifactUriForSessionV2,
  openPreview: (workspaceId, paneId, info) => useWorkspaceLayoutStore.getState()
    .openOrReloadHtmlPreviewPane(workspaceId, paneId, info),
  showWorkspace: () => useDashboardViewStore.getState().close(),
  reportError: (message) => useToastStore.getState().pushToast(message, "error"),
};

/** Keep the source pane fixed while opening a batch; previews may take focus. */
export async function openPathsInMainWindow(paths: string[], deps = liveDependencies): Promise<void> {
  if (!deps.main() || paths.length === 0) return;
  try {
    if (!deps.selection().workspaces.length) deps.createWorkspace(paths[0]);
  } catch (error) {
    deps.reportError(`Failed to open ${paths[0]}: ${String(error)}`);
    return;
  }
  const target = selectOpenTarget(deps.selection(), deps.activeSessionId());
  for (const path of paths) {
    try {
      if (!target) throw new Error("No workspace pane is available");
      const info = await deps.preview(target.sessionId, path);
      deps.openPreview(target.workspaceId, target.paneId, info);
      deps.showWorkspace();
    } catch (error) {
      deps.reportError(`Failed to open ${path}: ${String(error)}`);
    }
  }
}
