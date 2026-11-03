import type { Pane, PaneTab } from "../types/workspace";

export function applyActiveTabFields(pane: Pane, activeTab: PaneTab): Pane {
  return {
    ...pane,
    agentId: activeTab.agentId,
    activeTabId: activeTab.id,
    sessionId: activeTab.sessionId,
    cwd: activeTab.cwd ?? pane.cwd,
    lastProcess: activeTab.lastProcess ?? pane.lastProcess,
    claudeSessionId: activeTab.claudeSessionId,
    agentKind: activeTab.agentKind,
    agentSessionId: activeTab.agentSessionId,
    suppressedAgentSessions: activeTab.suppressedAgentSessions,
    launchEnv: activeTab.launchEnv ?? pane.launchEnv,
  };
}

/** Self-heal: a pin never survives its tab leaving the pane. */
export function clearPinIfMissing(pane: Pane): Pane {
  if (!pane.pinnedTabId) return pane;
  if (pane.tabs.some((tab) => tab.id === pane.pinnedTabId)) return pane;
  return { ...pane, pinnedTabId: undefined };
}

/** Keep the pinned tab first without changing the active tab. */
export function withPinnedTabFirst(pane: Pane): Pane {
  if (!pane.pinnedTabId) return pane;
  const index = pane.tabs.findIndex((tab) => tab.id === pane.pinnedTabId);
  if (index <= 0) return pane;
  const pinnedTab = pane.tabs[index];
  return {
    ...pane,
    tabs: [pinnedTab, ...pane.tabs.filter((tab) => tab.id !== pinnedTab.id)],
  };
}
