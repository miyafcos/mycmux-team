import { buildMentionCandidates, type MentionMenuCandidate } from "../../lib/mentionModel";
import { resolveDisplayState, type DashboardCardModel, type DashboardDisplayState } from "./dashboardModel";
import { stateLabels } from "./stateLabels";

export type DashboardMentionCandidate = MentionMenuCandidate & { displayState: DashboardDisplayState };

/** Keep presentation state separate from the words and from dispatch routing. */
export function buildDashboardMentionCandidates(targets: readonly DashboardCardModel[]): DashboardMentionCandidate[] {
  const stateByTab = new Map<string, DashboardDisplayState>();
  const inputs = targets.map((target) => {
    const displayState = resolveDisplayState(target);
    if (!stateByTab.has(target.tab.id)) stateByTab.set(target.tab.id, displayState);
    return {
      logicalSessionId: target.tab.id,
      sessionId: target.tab.sessionId,
      label: target.label,
      workspaceName: target.workspace.name,
      statusLabel: stateLabels(displayState).tooltip,
      isWorking: stateLabels(displayState).activity === "working",
    };
  });
  return buildMentionCandidates(inputs).map((candidate) => ({
    ...candidate,
    displayState: candidate.kind === "working-all" ? "running" : stateByTab.get(candidate.logicalSessionId) ?? "unknown",
  }));
}
