import { useDashboardViewStore } from "../../stores/dashboardViewStore";
import { useUiStore } from "../../stores/uiStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import type { Workspace } from "../../types";

/** Open the dashboard on a pane tab, clearing filters first so the card stays visible. */
export function openDashboardForTab(tabId: string): void {
  const store = useDashboardViewStore.getState();
  store.setQuery("");
  store.setStateFilter(null);
  store.setWorkspaceFilter(null);
  store.setAgentFilter(null);
  store.focusChatColumn(tabId);
  store.openView();
}

/** Mirrors socketCommands.findTabBySessionId (unexported) — tab.sessionId → tab.id. */
function findTabIdBySessionId(workspaces: Workspace[], sessionId: string): string | null {
  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      const tab = pane.tabs.find((candidate) => candidate.sessionId === sessionId);
      if (tab) return tab.id;
    }
  }
  return null;
}

/** Open the dashboard focused on the currently (or last) focused session's chat column. */
export function openDashboardForActiveSession(): void {
  const store = useDashboardViewStore.getState();
  const { activePaneId, lastActivePaneId } = useUiStore.getState();
  const sessionId = activePaneId ?? lastActivePaneId;
  if (!sessionId) {
    store.openView();
    return;
  }
  const tabId = findTabIdBySessionId(useWorkspaceListStore.getState().workspaces, sessionId);
  if (tabId) {
    openDashboardForTab(tabId);
    return;
  }
  store.openView();
}
