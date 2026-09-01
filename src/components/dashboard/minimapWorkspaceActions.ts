import type { PaneDragItem } from "../../stores/paneDragStore";
import { useWorkspaceLayoutStore } from "../../stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";

export function moveMinimapItemToNewWorkspace(item: PaneDragItem): boolean {
  const layoutStore = useWorkspaceLayoutStore.getState();
  const listStore = useWorkspaceListStore.getState();
  const workspaceId = crypto.randomUUID();
  const workspaceName = `Workspace ${listStore.workspaces.length + 1}`;

  if (item.kind === "tab") {
    return layoutStore.moveTabToNewWorkspace(
        item.workspaceId,
        item.paneId,
        item.tabId,
        workspaceId,
        workspaceName,
        { activate: false },
      );
  }
  if (item.kind === "tab-bundle") {
    return layoutStore.moveTabsToNewWorkspace(
      item.workspaceId,
      item.paneId,
      item.tabIds,
      item.anchorTabId,
      workspaceId,
      workspaceName,
      { activate: false },
    );
  }
  return layoutStore.movePaneToNewWorkspace(
    item.workspaceId,
    item.paneId,
    workspaceId,
    workspaceName,
    { activate: false },
  );
}
