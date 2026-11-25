import { emitTo, listen } from "@tauri-apps/api/event";
import {
  type SwitchableCliProvider, layoutPublicationId, OPEN_DASHBOARD_EVENT, publishWindowAccountManagementReady,
  readWindowAccountManagementDocument, WINDOW_PUBLISHER_REPLACED_ERROR, type OpenDashboardTarget,
} from "./ipc";
import { isDashboardSpecialColumn, useDashboardViewStore } from "../stores/dashboardViewStore";
import { useWorkspaceListStore } from "../stores/workspaceListStore";
import { useToastStore } from "../stores/toastStore";
import { dashboardStrings } from "../components/dashboard/dashboardStrings";
import { usePeerWindowTabsStore } from "../components/dashboard/peerWindowTabsStore";
import { canonicalPeerWindowTabs } from "../components/dashboard/peerWindowTabs";
import { useUiStore } from "../stores/uiStore";
import { isLaunchAccountTarget } from "./agentCatalog";
import { MAIN_WINDOW_LABEL, windowLabel } from "./windowContext";
import { isPreparingLayoutQuit } from "./layoutQuit";

export const ACCOUNT_MANAGEMENT_RESULT_EVENT = "mycmux://account-management-result";
export const ACCOUNT_MANAGEMENT_TIMEOUT_MS = 3_000;

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

type ManagementRequest = {
  provider: SwitchableCliProvider;
  sourceWindow: string;
  expiresAt: number;
  settled: boolean;
};

type ManagementListener = {
  label: string;
  requests: Map<string, ManagementRequest>;
  publicationId: string | undefined;
  subscriptionId?: string;
  retry?: () => void;
};

type ReadinessPublication = {
  publicationId: string | undefined;
  document?: Promise<number>;
  sequence: number;
  retry: boolean;
};

let managementListener: ManagementListener | undefined;
let settingsMount: { label: string } | undefined;
let closingWindow: string | undefined;
let desiredSubscription: string | undefined;
let readiness: ReadinessPublication | undefined;

export function isAccountManagementBlocked(label = windowLabel()): boolean {
  return closingWindow === label || isPreparingLayoutQuit();
}

export function canOpenAccountManagementHere(label = windowLabel()): boolean {
  return settingsMount?.label === label && !isAccountManagementBlocked(label);
}

function publishManagementReadiness() {
  const publicationId = layoutPublicationId();
  if (!readiness || readiness.publicationId !== publicationId) {
    readiness = { publicationId, sequence: 0, retry: false };
  }
  const publication = readiness;
  const sequence = ++publication.sequence;
  const subscription = desiredSubscription;
  publication.retry = false;
  const current = () => readiness === publication && publication.sequence === sequence
    && layoutPublicationId() === publicationId;
  const rememberFailure = (error: unknown) => {
    if (current() && error !== WINDOW_PUBLISHER_REPLACED_ERROR) publication.retry = true;
  };
  // Only the document lookup is shared. An unanswered write cannot delay a withdrawal.
  const document = publication.document ??= readWindowAccountManagementDocument(publicationId);
  void document.then(epoch => {
    if (current()) {
      void publishWindowAccountManagementReady(publicationId, epoch, sequence, subscription).catch(rememberFailure);
    }
  }, error => {
    if (publication.document === document) publication.document = undefined;
    rememberFailure(error);
  });
}

function syncManagementReadiness() {
  const listener = managementListener;
  const next = listener && settingsMount?.label === listener.label && !isAccountManagementBlocked(listener.label)
    ? listener.subscriptionId : undefined;
  if (next === desiredSubscription) return;
  desiredSubscription = next;
  publishManagementReadiness();
}

export function registerAccountManagementSettings(): () => void {
  const mount = { label: windowLabel() };
  settingsMount = mount;
  syncManagementReadiness();
  return () => {
    if (settingsMount !== mount) return;
    settingsMount = undefined;
    syncManagementReadiness();
  };
}

export function setAppShellClosing(closing: boolean) {
  closingWindow = closing ? windowLabel() : undefined;
  syncManagementReadiness();
}

/** Layout publication is also an opportunity to recover a failed listener or readiness update. */
export function retryAccountManagementRegistration() {
  if (managementListener && managementListener.publicationId === layoutPublicationId()) {
    managementListener.retry?.();
  }
  if (readiness?.retry && readiness.publicationId === layoutPublicationId()) {
    publishManagementReadiness();
  }
}

function replyToAccountManagement(sourceWindow: string, label: string, requestId: string, reason: "opened" | "refused") {
  void emitTo({ kind: "Webview", label: sourceWindow }, ACCOUNT_MANAGEMENT_RESULT_EVENT, {
    requestId, fromWindow: label, reason,
  }).catch(() => undefined);
}

function finishAccountManagementRequest(requestId: string, reason: "opened" | "refused") {
  const listener = managementListener;
  const request = listener?.requests.get(requestId);
  if (!listener || !request || request.settled) return;
  request.settled = true;
  if (Date.now() < request.expiresAt) {
    replyToAccountManagement(request.sourceWindow, listener.label, requestId, reason);
  }
}

export function accountManagementSectionRendered(provider: SwitchableCliProvider) {
  const listener = managementListener;
  if (!listener) return;
  for (const [requestId, request] of listener.requests) {
    if (request.provider === provider) finishAccountManagementRequest(requestId, "opened");
  }
}

export function refusePendingAccountManagementRequests() {
  const listener = managementListener;
  if (!listener) return;
  const ui = useUiStore.getState();
  const pendingId = ui.requestedAccountManagementId;
  if (pendingId && listener.requests.get(pendingId)?.settled === false) ui.clearRequestedSettingsTab();
  for (const requestId of listener.requests.keys()) finishAccountManagementRequest(requestId, "refused");
}

function handleAccountManagementRequest(request: Record<string, unknown>, listener: ManagementListener) {
  if (managementListener !== listener || !listener.subscriptionId) return;
  const { label, publicationId, subscriptionId } = listener;
  const { accountProvider, sourceWindow, requestId, expiresAt } = request;
  if (request.targetWindow !== label || typeof sourceWindow !== "string" || !sourceWindow
    || sourceWindow === label || typeof requestId !== "string" || !requestId) return;
  const now = Date.now();
  for (const [id, prior] of listener.requests) {
    if (prior.expiresAt <= now) listener.requests.delete(id);
  }
  if (listener.requests.has(requestId)) return;

  if (request.subscriptionId === subscriptionId
    && request.publicationId === (publicationId ?? "") && publicationId === layoutPublicationId()
    && typeof expiresAt === "number" && Number.isSafeInteger(expiresAt)
    && now < expiresAt && expiresAt <= now + ACCOUNT_MANAGEMENT_TIMEOUT_MS
    && !isAccountManagementBlocked(label) && settingsMount?.label === label
    && isLaunchAccountTarget(accountProvider)) {
    listener.requests.set(requestId, { provider: accountProvider, sourceWindow, expiresAt, settled: false });
    useUiStore.getState().requestSettingsTab("usage", accountProvider, undefined, requestId);
  } else {
    replyToAccountManagement(sourceWindow, label, requestId, "refused");
  }
}

function listenForAppShellRequests(label: string, receiveDashboard?: (payload: unknown) => void): () => void {
  const listener: ManagementListener = { label, publicationId: layoutPublicationId(), requests: new Map() };
  managementListener = listener;
  syncManagementReadiness();
  let alive = true;
  let unlisten: (() => void) | undefined;
  const register = () => {
    listener.retry = undefined;
    void listen<unknown>(OPEN_DASHBOARD_EVENT, ({ payload }) => {
      if (payload && typeof payload === "object" && "accountProvider" in payload) {
        handleAccountManagementRequest(payload as Record<string, unknown>, listener);
      } else if (alive) {
        receiveDashboard?.(payload);
      }
    }, { target: { kind: "Webview", label } }).then(stop => {
      if (!alive || managementListener !== listener || listener.publicationId !== layoutPublicationId()) {
        stop();
        return;
      }
      unlisten = stop;
      listener.subscriptionId = crypto.randomUUID();
      syncManagementReadiness();
    }).catch(() => {
      if (alive && managementListener === listener) listener.retry = register;
    });
  };
  register();
  return () => {
    alive = false;
    if (managementListener === listener) {
      managementListener = undefined;
      syncManagementReadiness();
    }
    unlisten?.();
  };
}

/** Every AppShell can show settings. Dashboard requests still belong to main. */
export function connectAppShellRequests(label: string): () => void {
  return label === MAIN_WINDOW_LABEL ? connectMainDashboardRequests(label)
    : listenForAppShellRequests(label);
}

export function connectMainDashboardRequests(label: string): () => void {
  if (label !== MAIN_WINDOW_LABEL) return () => {};
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
  const stopRequests = listenForAppShellRequests(label, payload => {
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
  });
  return () => {
    stopRequests();
    stopView();
    stopWorkspaces();
    stopPeers();
    clearTimeout(timer);
    const view = useDashboardViewStore.getState();
    if (view.chatColumnIdFilter === knownTab) view.setChatColumnIdFilter(null);
    view.setPendingDashboardRequest(null);
  };
}
