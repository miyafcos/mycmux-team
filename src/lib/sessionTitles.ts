import { invoke } from "@tauri-apps/api/core";
import type { GroupingScan } from "../components/layout/tabGrouping";
// Session titles for grouping (paneEvidence) and automatic naming (autoNameEvidence). Kept
// apart from paneEvidence so the naming reader does not pull in the launcher and identity stores.
export interface AgentTitleRequest { tab_id: string; agent_kind: string; agent_session_id?: string; cwd: string }
export type SessionHistoryStatus = "available" | "unavailable" | "missing_identity" | "unsupported";
export interface AgentSessionTitles { tab_id: string; session_title: string | null; task_title: string | null; history_status?: SessionHistoryStatus }
export function sessionHistoryStatusLabel(status?: SessionHistoryStatus): string {
  return status === "available" ? "会話を確認済み" : status === "unsupported" ? "会話読取は未対応"
    : status === "missing_identity" ? "会話IDを未取得" : "会話を未取得";
}
function fallbackHistoryStatus(tab: GroupingScan["tabs"][number]): SessionHistoryStatus {
  if (!["claude", "claude-codex", "codex"].includes(tab.agentKind)) return "unsupported";
  return tab.agentSessionId ? "unavailable" : "missing_identity";
}
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
    return cached?.key === keyFor(titleRequest(tab)) ? { ...tab, sessionTitle: cached.value.session_title, taskTitle: cached.value.task_title,
      historyStatus: cached.value.history_status ?? (cached.value.session_title ? "available" : fallbackHistoryStatus(tab)) }
      : { ...tab, historyStatus: tab.historyStatus ?? fallbackHistoryStatus(tab) };
  }) };
}
/** A Claude tab names its session after the first turn; look again sooner until the title exists. */
export const TITLE_RETRY_MS = 60_000;
/** Give up the quick retry after this long without a title (a shell-only or idle session). */
export const TITLE_RETRY_WINDOW_MS = 10 * 60_000;
export const TITLED_AGENT_KINDS: readonly string[] = ["claude", "claude-codex"];
/** The longest a caller waits on title reads before going on with what is cached. */
export const TITLE_WAIT_MS = 10_000;
const untitledSince = new Map<string, number>();
const inFlight = new Map<string, { read: Promise<void>; since: number }>();
/** How many times a key was read again past a lost read; each retry waits twice as long. */
const lostReads = new Map<string, number>();
/** Test-only: forget cached titles and reads in progress. */
export function resetSessionTitlesForTest(): void { cache.clear(); untitledSince.clear(); inFlight.clear(); lostReads.clear(); }
/**
 * Attach each tab's session title (Claude's custom or AI title) and task title,
 * reading only stale entries. `kinds` limits which tabs are read now; the
 * automatic namer only needs agents that keep a title.
 */
export async function withSessionTitles(scan: GroupingScan, kinds?: readonly string[]): Promise<GroupingScan> {
  const now = Date.now();
  // A read already under way for the same tab is awaited instead of repeated.
  const pending = new Set<Promise<void>>();
  const requests = scan.tabs.map(titleRequest).filter(request => {
    if (kinds && !kinds.includes(request.agent_kind)) return false;
    const key = keyFor(request);
    const running = inFlight.get(key);
    if (running) {
      const age = now - running.since;
      if (age < TITLE_WAIT_MS) { pending.add(running.read); return false; }
      // Past the cap the read is presumed lost: never wait on it, and read again only
      // after a doubling back-off (10s, 20s, 40s…) so a stuck disk does not pile up reads.
      const lost = lostReads.get(key) ?? 0;
      if (age < TITLE_WAIT_MS * 2 ** lost) return false;
      lostReads.set(key, lost + 1);
      return true;
    }
    const cached = cache.get(request.tab_id);
    if (!cached || cached.key !== key) return true;
    const waiting = !cached.value.session_title && TITLED_AGENT_KINDS.includes(request.agent_kind)
      && now - (untitledSince.get(key) ?? now) < TITLE_RETRY_WINDOW_MS;
    return now - cached.at >= (waiting ? TITLE_RETRY_MS : TITLE_REFRESH_MS);
  });
  // Titled agents are read apart from the rest, so a namer waiting on a Claude title
  // never waits on a Codex session scan started by the grouping reader.
  const titled = requests.filter(request => TITLED_AGENT_KINDS.includes(request.agent_kind));
  const rest = requests.filter(request => !TITLED_AGENT_KINDS.includes(request.agent_kind));
  for (const group of [titled, rest]) {
    if (!group.length) continue;
    const keys = new Map(group.map(request => [request.tab_id, keyFor(request)]));
    const entry = { read: Promise.resolve(), since: now };
    entry.read = (async () => {
      try {
        const titles = await agentSessionTitles(group);
        for (const value of titles) {
          const key = keys.get(value.tab_id);
          // A read that was given up and replaced must not overwrite the newer result.
          if (!key || inFlight.get(key) !== entry) continue;
          lostReads.delete(key);
          cache.set(value.tab_id, { key, at: Date.now(), value });
          if (value.session_title) untitledSince.delete(key);
          else if (!untitledSince.has(key)) untitledSince.set(key, now);
        }
      } catch { /* Missing evidence keeps existing labels and the locally available plan. */ }
      finally { for (const key of keys.values()) if (inFlight.get(key) === entry) inFlight.delete(key); }
    })();
    for (const key of keys.values()) inFlight.set(key, entry);
    pending.add(entry.read);
  }
  // A read that never returns must not stall the caller; it fills the cache when it ends.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all(pending), new Promise<void>(resolve => { timer = setTimeout(resolve, TITLE_WAIT_MS); })]);
  clearTimeout(timer);
  const live = new Set(scan.tabs.map(tab => tab.id));
  for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
  const liveKeys = new Set(scan.tabs.map(tab => keyFor(titleRequest(tab))));
  for (const key of untitledSince.keys()) if (!liveKeys.has(key)) untitledSince.delete(key);
  return cachedEvidenceScan(scan);
}
