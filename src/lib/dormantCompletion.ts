import type { PaneTab } from "../types";
import { useSessionAttentionStore } from "../stores/sessionAttentionStore";
import { useDashboardViewStore } from "../stores/dashboardViewStore";
import { resolveDormantResumeIdentity } from "./agentDormancy";

/** Returns whether the notification was handled, including a full-column refusal. */
export function openDormantCompletionRecord(tab: PaneTab, dormant: boolean): boolean {
  const receipt = useSessionAttentionStore.getState().dormantCompletionsBySession[tab.sessionId]?.receipt;
  const identity = resolveDormantResumeIdentity(tab);
  if (!dormant || !receipt || identity?.agentKind !== receipt.agentKind || identity.resumeSessionId !== receipt.agentSessionId) return false;
  const store = useDashboardViewStore.getState();
  store.setQuery("");
  store.setStateFilter(null);
  store.setWorkspaceFilter(null);
  store.setAgentFilter(null);
  store.openTranscriptTurnRequest(tab.id, { kind: "latest" });
  return true;
}
