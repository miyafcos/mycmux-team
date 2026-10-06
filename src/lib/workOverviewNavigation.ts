import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useWorkspaceListStore, useWorkspaceLayoutStore, useUiStore } from "../stores/workspaceStore";
import { useDashboardViewStore } from "../stores/dashboardViewStore";
import { focusController } from "./focusController";
import { windowLabel } from "./windowContext";
import { boundedGroupingWait } from "./groupingWaits";
import type { OverviewCard } from "./workOverview";
const OPEN_EVENT = "mycmux://overview-open";
const RESULT_EVENT = "mycmux://overview-open-result";
type Target = Pick<OverviewCard, "workspaceId" | "paneId" | "tab">;
interface Request { requestId: string; replyWindow: string; targetWindow: string; workspaceId: string; paneId: string; tabId: string; sessionId: string }
export function selectOverviewTarget(target: Target): boolean {
  const tab = useWorkspaceListStore.getState().workspaces.find(workspace => workspace.id === target.workspaceId)
    ?.panes.find(pane => pane.id === target.paneId)?.tabs.find(tab => tab.id === target.tab.id && tab.sessionId === target.tab.sessionId);
  if (!tab) return false;
  useWorkspaceListStore.getState().setActiveWorkspace(target.workspaceId);
  useWorkspaceLayoutStore.getState().setActivePaneTab(target.workspaceId, target.paneId, tab.id);
  if (useUiStore.getState().zoomedPaneId) useUiStore.getState().setZoomedPaneId(target.paneId);
  useDashboardViewStore.getState().close();
  focusController.request("programmatic", { sessionId: (!tab.type || tab.type === "terminal") ? tab.sessionId : null, focus: true });
  return true;
}
export async function navigateOverviewCard(card: OverviewCard): Promise<void> {
  if (card.windowLabel === windowLabel() && !card.peer) {
    if (!selectOverviewTarget(card)) throw new Error("stale");
    return;
  }
  const requestId = crypto.randomUUID();
  let done!: (result: { ok: boolean }) => void;
  const response = new Promise<{ ok: boolean }>(resolve => { done = resolve; });
  const unlisten = await boundedGroupingWait(listen<{ requestId: string; windowLabel: string; ok: boolean }>(RESULT_EVENT, event => {
    if (event.payload.requestId === requestId && event.payload.windowLabel === card.windowLabel) done(event.payload);
  }, { target: { kind: "Window", label: windowLabel() } }), 3_000);
  try {
    const request: Request = { requestId, replyWindow: windowLabel(), targetWindow: card.windowLabel, workspaceId: card.workspaceId,
      paneId: card.paneId, tabId: card.tab.id, sessionId: card.tab.sessionId };
    const result = await boundedGroupingWait(Promise.all([emitTo(card.windowLabel, OPEN_EVENT, request), response]), 3_000);
    if (!result[1].ok) throw new Error("stale");
  } finally { unlisten(); }
}
export function listenForOverviewNavigation() {
  return listen<Request>(OPEN_EVENT, async ({ payload }) => {
    if (payload.targetWindow !== windowLabel() || !payload.requestId || !payload.replyWindow || !payload.sessionId) return;
    const ok = selectOverviewTarget({ workspaceId: payload.workspaceId, paneId: payload.paneId,
      tab: { id: payload.tabId, sessionId: payload.sessionId, agentId: "" } });
    if (ok) {
      try { const target = getCurrentWindow(); await target.unminimize(); await target.show(); await target.setFocus(); }
      catch { /* Selection is already valid; native focus is best effort. */ }
    }
    await emitTo(payload.replyWindow, RESULT_EVENT, { requestId: payload.requestId, windowLabel: windowLabel(), ok });
  }, { target: { kind: "Window", label: windowLabel() } });
}
