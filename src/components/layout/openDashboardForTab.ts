import { useDashboardViewStore } from "../../stores/dashboardViewStore";
import { useUiStore } from "../../stores/uiStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import type { Workspace } from "../../types";
import { isDetachedDashboardHost } from "../../lib/dashboardHost";

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

export interface DashboardTarget {
  tabId?: string;
  sessionId?: string;
  turn?: "latest";
}

/** Resolve the focused session lazily: shell mount must not read this store. */
function activeDashboardTarget(): DashboardTarget {
  const { activePaneId, lastActivePaneId } = useUiStore.getState();
  const sessionId = activePaneId ?? lastActivePaneId;
  const { workspaces, activeWorkspaceId } = useWorkspaceListStore.getState();
  for (const workspace of workspaces) for (const pane of workspace.panes) {
    const tab = pane.tabs.find((candidate) => candidate.sessionId === sessionId);
    if (tab) return { tabId: tab.id, sessionId: tab.sessionId };
  }
  const workspace = workspaces.find((candidate) => candidate.id === activeWorkspaceId) ?? workspaces[0];
  const pane = workspace?.panes.find((candidate) => candidate.tabs.some((tab) => tab.id === candidate.activeTabId)) ?? workspace?.panes[0];
  const tab = pane?.tabs.find((candidate) => candidate.id === pane.activeTabId) ?? pane?.tabs[0];
  return tab ? { tabId: tab.id, sessionId: tab.sessionId } : {};
}

/** Open in the current renderer. Compact shells own a visible, temporary view. */
export function requestDashboard(target?: DashboardTarget): Promise<void> {
  const resolved = isDetachedDashboardHost() ? target ?? activeDashboardTarget() : target;
  if (resolved?.tabId && resolved.turn) {
    const store = useDashboardViewStore.getState();
    store.setQuery("");
    store.setStateFilter(null);
    store.setWorkspaceFilter(null);
    store.setAgentFilter(null);
    store.openTranscriptTurnRequest(resolved.tabId, { kind: resolved.turn });
  } else if (resolved?.tabId) openDashboardForTab(resolved.tabId);
  else openDashboardForActiveSession();
  return Promise.resolve();
}

/** Match the main window's band button and dashboard shortcut. */
export function toggleDetachedDashboard(target?: DashboardTarget): void {
  const view = useDashboardViewStore.getState();
  if (view.open) view.close();
  else void requestDashboard(target);
}
