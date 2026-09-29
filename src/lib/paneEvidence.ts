import { invoke } from "@tauri-apps/api/core";
import { scanGroupingContext, type GroupingScan } from "../components/layout/tabGrouping";
import { useLauncherDirsStore } from "../stores/launcherDirsStore";
import { resolvePaneIdentities, type PaneIdentityResult, type ProjectRegistration } from "./paneIdentity";
export interface AgentTitleRequest { tab_id: string; agent_kind: string; agent_session_id?: string; cwd: string }
export interface AgentSessionTitles { tab_id: string; session_title: string | null; task_title: string | null }
export const TITLE_REFRESH_MS = 5 * 60_000;
const cache = new Map<string, { key: string; at: number; value: AgentSessionTitles }>();
export async function agentSessionTitles(requests: AgentTitleRequest[]): Promise<AgentSessionTitles[]> {
  const results: AgentSessionTitles[] = [];
  // Sequential batches also bound concurrent IPC invocations.
  for (let i = 0; i < requests.length; i += 64) results.push(...await invoke<AgentSessionTitles[]>("agent_session_titles", { requests: requests.slice(i, i + 64) }));
  return results;
}
const titleRequest = (tab: GroupingScan["tabs"][number]): AgentTitleRequest => ({
  tab_id: tab.id, agent_kind: tab.agentKind, agent_session_id: tab.agentSessionId, cwd: tab.cwd,
});
const keyFor = (request: AgentTitleRequest) => JSON.stringify(request);
export function cachedEvidenceScan(scan: GroupingScan): GroupingScan {
  return { ...scan, tabs: scan.tabs.map(tab => {
    const cached = cache.get(tab.id);
    return cached?.key === keyFor(titleRequest(tab)) ? { ...tab, sessionTitle: cached.value.session_title, taskTitle: cached.value.task_title } : tab;
  }) };
}
export function paneRegistry(): ProjectRegistration[] { return useLauncherDirsStore.getState().view?.doc?.entries ?? []; }
export function identitiesForScan(scan: GroupingScan, registry = paneRegistry()): PaneIdentityResult {
  return resolvePaneIdentities({ registry, workspaces: scan.workspaces, tabs: scan.tabs.map(tab => ({
    ...tab, parentTabId: tab.origin?.parentTabId,
  })) });
}
export async function readEvidenceScan(): Promise<GroupingScan> {
  if (!useLauncherDirsStore.getState().view) await useLauncherDirsStore.getState().load();
  const scan = await scanGroupingContext();
  const requests = scan.tabs.map(titleRequest).filter(request => {
    const cached = cache.get(request.tab_id);
    return !cached || cached.key !== keyFor(request) || Date.now() - cached.at >= TITLE_REFRESH_MS;
  });
  if (requests.length) {
    try {
      const titles = await agentSessionTitles(requests);
      const keys = new Map(requests.map(request => [request.tab_id, keyFor(request)]));
      for (const value of titles) if (keys.has(value.tab_id)) cache.set(value.tab_id, { key: keys.get(value.tab_id)!, at: Date.now(), value });
    } catch { /* Missing evidence keeps existing labels and the locally available plan. */ }
  }
  const live = new Set(scan.tabs.map(tab => tab.id));
  for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
  return cachedEvidenceScan(scan);
}
