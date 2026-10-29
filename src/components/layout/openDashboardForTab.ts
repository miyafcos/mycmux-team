import { useDashboardViewStore } from "../../stores/dashboardViewStore";
import { useUiStore } from "../../stores/uiStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import type { Workspace } from "../../types";
import { isDetachedDashboardHost } from "../../lib/dashboardHost";
import { openMainDashboard } from "../../lib/ipc";
import { useToastStore } from "../../stores/toastStore";
import { tearoutStrings } from "./tearoutStrings";

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

export function requestDashboard(target?: DashboardTarget): Promise<void> {
  if (!isDetachedDashboardHost()) {
    // Current callers (XTermWrapper and dormantCompletion) check the host marker,
    // so turn cannot reach an unmarked window. If that changes, match XTermWrapper's
    // local route: keep filters and use the resolveTranscriptTurnAction payload.
    if (target?.tabId && target.turn) {
      const store = useDashboardViewStore.getState();
      store.setQuery("");
      store.setStateFilter(null);
      store.setWorkspaceFilter(null);
      store.setAgentFilter(null);
      store.openTranscriptTurnRequest(target.tabId, { kind: target.turn });
    } else if (target?.tabId) openDashboardForTab(target.tabId);
    else openDashboardForActiveSession();
    return Promise.resolve();
  }
  return (async () => {
    try {
      if (!await openMainDashboard(target ?? activeDashboardTarget())) {
        useToastStore.getState().pushToast(tearoutStrings.dashboardMainUnavailable, "error");
      }
    } catch {
      useToastStore.getState().pushToast(tearoutStrings.failed, "error");
    }
  })();
}
