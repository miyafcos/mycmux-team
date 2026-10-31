import { beginEphemeralDashboardSession, isDashboardSpecialColumn, useDashboardViewStore } from "../stores/dashboardViewStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";
import { usePeerWindowTabsStore } from "../components/dashboard/peerWindowTabsStore";
import { canonicalPeerWindowTabs } from "../components/dashboard/peerWindowTabs";

let detachedHosts = 0;
let restoreSession: (() => void) | undefined;

export function isDetachedDashboardHost(): boolean {
  return detachedHosts > 0;
}

/** Both compact shells host the same dashboard with renderer-local preferences. */
export function mountDetachedDashboardHost(): () => void {
  if (detachedHosts++ === 0) {
    restoreSession = beginEphemeralDashboardSession();
    useDashboardViewStore.getState().setChatColumnIdFilter((tabId) => {
      if (isDashboardSpecialColumn(tabId)) return true;
      const workspaces = useWorkspaceListStore.getState().workspaces;
      return workspaces.some(workspace => workspace.panes.some(pane => pane.tabs.some(tab => tab.id === tabId)))
        || canonicalPeerWindowTabs(usePeerWindowTabsStore.getState().index, workspaces).some(peer => peer.tab.id === tabId);
    });
  }
  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    if (--detachedHosts === 0) {
      restoreSession?.();
      restoreSession = undefined;
    }
  };
}
