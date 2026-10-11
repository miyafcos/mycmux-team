import { dashboardStrings } from "./dashboardStrings";
import { resolveDisplayState, type DashboardCardModel } from "./dashboardModel";

/** Keep list and conversation headers on the same description. */
export function dashboardActivity(card: DashboardCardModel): string | null {
  const state = resolveDisplayState(card);
  if (state === "delegated" && card.delegationParent) {
    return dashboardStrings.delegatedTo(card.delegationParent.label);
  }
  if (state === "delegationUnknown") return dashboardStrings.stateDelegationUnknown;
  if (state !== "running" || card.telemetryHealth !== "live") return null;
  const autonomy = card.brief?.autonomy;
  if ((autonomy?.openToolCount ?? 0) > 0) return card.activityText || dashboardStrings.stateRunning;
  if ((autonomy?.armedBackgroundCount ?? 0) > 0) {
    return dashboardStrings.backgroundWork(autonomy!.armedBackgroundCount);
  }
  if (autonomy?.turnState === "unknown" || autonomy?.backgroundState === "unknown") return dashboardStrings.turnStateUnknown;
  if ((autonomy?.pendingNotificationCount ?? 0) > 0) return dashboardStrings.modelResponseWait;
  return autonomy ? dashboardStrings.modelResponseWait : card.activityText || dashboardStrings.stateRunning;
}
