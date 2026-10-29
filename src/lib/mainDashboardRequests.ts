import { listen } from "@tauri-apps/api/event";
import { OPEN_DASHBOARD_EVENT, type OpenDashboardTarget } from "./ipc";
import { isDashboardSpecialColumn, useDashboardViewStore } from "../stores/dashboardViewStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";
import { useToastStore } from "../stores/toastStore";
import { dashboardStrings } from "../components/dashboard/dashboardStrings";
import { usePeerWindowTabsStore } from "../components/dashboard/peerWindowTabsStore";
import { canonicalPeerWindowTabs } from "../components/dashboard/peerWindowTabs";

export function validateDashboardTarget(payload: unknown): OpenDashboardTarget {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const target = payload as Record<string, unknown>;
  for (const key of ["tabId", "sessionId"] as const) {
    if (target[key] != null && (typeof target[key] !== "string" || target[key].length > 256)) return {};
  }
  if (target.turn != null && target.turn !== "latest") return {};
  return {
    ...(typeof target.tabId === "string" ? { tabId: target.tabId } : {}),
    ...(typeof target.sessionId === "string" ? { sessionId: target.sessionId } : {}),
    ...(target.turn === "latest" ? { turn: "latest" as const } : {}),
  };
}

/** AppShell owns the connection; component-only tests retain their local behavior. */
export function connectMainDashboardRequests(label: string): () => void {
  if (label !== "main") return () => {};
  let alive = true;
  let unlisten: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const knownTab = (tabId: string) => {
    if (isDashboardSpecialColumn(tabId)) return true;
    const workspaces = useWorkspaceListStore.getState().workspaces;
    return workspaces.some(workspace => workspace.panes.some(pane => pane.tabs.some(tab => tab.id === tabId)))
      || canonicalPeerWindowTabs(usePeerWindowTabsStore.getState().index, workspaces).some(peer => peer.tab.id === tabId);
  };
  useDashboardViewStore.getState().setChatColumnIdFilter(knownTab);
  const reconcile = () => {
    clearTimeout(timer);
    const view = useDashboardViewStore.getState();
    const request = view.pendingDashboardRequest;
    if (!request) return;
    if (!view.open) { view.setPendingDashboardRequest(null); return; }
    const workspaces = useWorkspaceListStore.getState().workspaces;
    const peers = usePeerWindowTabsStore.getState();
    const tabs = [...workspaces.flatMap(workspace => workspace.panes.flatMap(pane => pane.tabs)),
      ...canonicalPeerWindowTabs(peers.index, workspaces).map(peer => peer.tab)];
    const tab = tabs.find(candidate => request.tabId ? candidate.id === request.tabId : candidate.sessionId === request.sessionId);
    if (tab) {
      view.setPendingDashboardRequest(null);
      if (request.turn) view.openTranscriptTurnRequest(tab.id, { kind: request.turn });
      else view.focusChatColumn(tab.id);
      return;
    }
    const elapsed = Date.now() - request.receivedAt;
    const reads = peers.completedReads - (request.refreshCompletedAtReceipt ?? peers.completedReads);
    if (elapsed >= 10_000 || (elapsed >= 5000 && (peers.pollers === 0 || reads >= 2))) {
      view.setPendingDashboardRequest(null);
      useToastStore.getState().pushToast(dashboardStrings.dashboardTabNotFound, "error");
    } else timer = setTimeout(reconcile, (elapsed < 5000 ? 5000 : 10_000) - elapsed);
  };
  const stopView = useDashboardViewStore.subscribe(reconcile);
  const stopWorkspaces = useWorkspaceListStore.subscribe(reconcile);
  const stopPeers = usePeerWindowTabsStore.subscribe(reconcile);
  void listen<unknown>(OPEN_DASHBOARD_EVENT, ({ payload }) => {
    if (!alive) return;
    const receivedAt = Date.now();
    const peers = usePeerWindowTabsStore.getState();
    const target = validateDashboardTarget(payload);
    const view = useDashboardViewStore.getState();
    view.setPendingDashboardRequest(null);
    view.setQuery("");
    view.setStateFilter(null);
    view.setWorkspaceFilter(null);
    view.setAgentFilter(null);
    view.openView();
    if (target.tabId || target.sessionId) view.setPendingDashboardRequest({ ...target, receivedAt,
      refreshCompletedAtReceipt: peers.completedReads + Number(peers.reading) });
    usePeerWindowTabsStore.getState().requestRefresh();
  }, { target: { kind: "Webview", label } }).then(stop => {
    if (alive) unlisten = stop; else stop();
  }).catch(() => {});
  return () => {
    alive = false;
    unlisten?.();
    stopView();
    stopWorkspaces();
    stopPeers();
    clearTimeout(timer);
    const view = useDashboardViewStore.getState();
    if (view.chatColumnIdFilter === knownTab) view.setChatColumnIdFilter(null);
    view.setPendingDashboardRequest(null);
  };
}
