import { useDashboardViewStore } from "../../stores/dashboardViewStore";

/** Open the dashboard on a pane tab, clearing filters first so the card stays visible. */
export function openDashboardForTab(tabId: string): void {
  const store = useDashboardViewStore.getState();
  store.setQuery("");
  store.setStateFilter(null);
  store.setWorkspaceFilter(null);
  store.setAgentFilter(null);
  store.setSelectedTabId(tabId);
  store.openView();
}
