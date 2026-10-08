import { useUiStore } from "../stores/uiStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";
import { useWorkspaceLayoutStore } from "../stores/workspaceLayoutStore";
import { focusController } from "./focusController";
import type { PaneTab } from "../types";

export interface PaneTabDestination {
  workspaceId: string;
  paneId: string;
  tab: Pick<PaneTab, "id" | "sessionId" | "type">;
}

/** Shared selection and focus intent; callers own closing their surface. */
export function jumpToPaneTab({ workspaceId, paneId, tab }: PaneTabDestination): void {
  const keepZoom = useUiStore.getState().zoomedPaneId !== null;
  useWorkspaceListStore.getState().setActiveWorkspace(workspaceId);
  useWorkspaceLayoutStore.getState().setActivePaneTab(workspaceId, paneId, tab.id);
  if (keepZoom) useUiStore.getState().setZoomedPaneId(paneId);
  if (tab.type === undefined || tab.type === "terminal") {
    focusController.request("programmatic", { sessionId: tab.sessionId, focus: true });
  } else {
    focusController.request("programmatic", { sessionId: null, focus: false });
  }
}
