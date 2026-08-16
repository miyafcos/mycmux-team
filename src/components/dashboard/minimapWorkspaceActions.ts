import type { PaneDragItem } from "../../stores/paneDragStore";
import { useWorkspaceLayoutStore } from "../../stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";

export function moveMinimapItemToNewWorkspace(item: PaneDragItem): boolean {
  if (item.kind === "tab-bundle") return false;
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
  return layoutStore.movePaneToNewWorkspace(
    item.workspaceId,
    item.paneId,
    workspaceId,
    workspaceName,
    { activate: false },
  );
}
