import type { PaneDragItem } from "../../stores/paneDragStore";
import { useWorkspaceLayoutStore } from "../../stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";

export function moveMinimapItemToNewWorkspace(item: PaneDragItem): boolean {
  const layoutStore = useWorkspaceLayoutStore.getState();
  const listStore = useWorkspaceListStore.getState();
  const workspaceId = crypto.randomUUID();
  const workspaceName = `Workspace ${listStore.workspaces.length + 1}`;

  return item.kind === "tab"
    ? layoutStore.moveTabToNewWorkspace(
        item.workspaceId,
        item.paneId,
        item.tabId,
        workspaceId,
        workspaceName,
        { activate: false },
      )
    : layoutStore.movePaneToNewWorkspace(
        item.workspaceId,
        item.paneId,
        workspaceId,
        workspaceName,
        { activate: false },
      );
}
