import type { LiveReadObservation, LiveSessionBrief } from "../../lib/livebrief";
import type { SessionStatusSignals } from "../../lib/sessionStatusSignals";
import { presentSessionState } from "../../lib/sessionStatePresentation";
import type { SessionAttention } from "../../stores/sessionAttentionStore";
import { resolveAttentionTabs } from "../../stores/sessionAttentionStore";
import { useDashboardViewStore } from "../../stores/dashboardViewStore";
import { useToastStore } from "../../stores/toastStore";
import type { PaneTab, Workspace } from "../../types";

/** A view over existing question sources; read/unread and turn-ended are separate. */
export function yourTurnTargets(workspaces: readonly Workspace[], attention: Record<string, SessionAttention | undefined>,
  briefs: Record<string, LiveSessionBrief | undefined>, signals: Record<string, SessionStatusSignals | undefined>,
  observations: Record<string, LiveReadObservation | undefined> = {}, now = Date.now()): PaneTab[] {
  const tabs = workspaces.flatMap((workspace) => workspace.panes.flatMap((pane) => pane.tabs))
    .filter((tab) => tab.lifecycle !== "declared" && (tab.type ?? "terminal") === "terminal");
  const currentCanonical = (id: string) => {
    const state = attention[id];
    return state?.sessionEpoch != null && (!briefs[id] || state.sessionEpoch >= briefs[id]!.ptyGeneration)
      ? presentSessionState({ attention: state, signals: signals[id], now }) : null;
  };
  const canonical = resolveAttentionTabs(tabs, attention, new Map()).filter((item) => item.category === "waiting")
    .filter((item) => currentCanonical(item.tab.sessionId) === "needsHuman")
    .map((item) => item.tab);
  const ids = new Set(canonical.map((tab) => tab.sessionId));
  for (const tab of tabs) {
    const brief = briefs[tab.sessionId];
    const state = currentCanonical(tab.sessionId);
    // A fresh canonical non-question supersedes stale transcript/screens. Screen
    // scans already publish into canonical attention; no second source of counts.
    const pending = (state === null || state === "unknown")
      && (!attention[tab.sessionId] || attention[tab.sessionId]?.sessionEpoch === brief?.ptyGeneration)
      && presentSessionState({ brief, observation: observations[tab.sessionId], now }) === "needsHuman"
      && Boolean(brief?.promptEventId && brief.promptHash);
    if (pending && !ids.has(tab.sessionId)) { canonical.push(tab); ids.add(tab.sessionId); }
  }
  return canonical;
}

export function openYourTurn(target: PaneTab | undefined): void {
  const view = useDashboardViewStore.getState();
  useDashboardViewStore.setState({ yourTurnTabId: null });
  view.setQuery(""); view.setWorkspaceFilter(null); view.setAgentFilter(null); view.setStateFilter(null);
  view.openView();
  if (target) {
    view.setSelectedTabId(target.id);
    if (useDashboardViewStore.getState().selectedTabId !== target.id) {
      useDashboardViewStore.setState({ yourTurnTabId: target.id });
    }
  }
  else useToastStore.getState().pushToast("いま回答が必要な質問・承認はありません。", "info");
}
