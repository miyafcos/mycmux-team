import { scanGroupingContext, type GroupingScan } from "../components/layout/tabGrouping";
import { useLauncherDirsStore } from "../stores/launcherDirsStore";
import { resolvePaneIdentities, type PaneIdentityResult, type ProjectRegistration } from "./paneIdentity";
import { withSessionTitles } from "./sessionTitles";
export { agentSessionTitles, cachedEvidenceScan, TITLE_REFRESH_MS, TITLE_RETRY_MS, withSessionTitles, type AgentSessionTitles, type AgentTitleRequest } from "./sessionTitles";
export function paneRegistry(): ProjectRegistration[] { return useLauncherDirsStore.getState().view?.doc?.entries ?? []; }
export function identitiesForScan(scan: GroupingScan, registry = paneRegistry()): PaneIdentityResult {
  return resolvePaneIdentities({ registry, allowLabelProjects: true, workspaces: scan.workspaces, tabs: scan.tabs.map(tab => ({
    ...tab, parentTabId: tab.origin?.parentTabId,
  })) });
}
export async function readEvidenceScan(): Promise<GroupingScan> {
  if (!useLauncherDirsStore.getState().view) await useLauncherDirsStore.getState().load();
  return withSessionTitles(await scanGroupingContext());
}
