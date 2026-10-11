import type { Pane, PaneTab } from "../types";
import { usePaneMetadataStore } from "../stores/paneMetadataStore";
import { invoke } from "@tauri-apps/api/core";
import { scanGroupingContext, type GroupingScan } from "../components/layout/tabGrouping";
import { useLiveBriefStore } from "../stores/liveBriefStore";
import { deriveAutoName } from "./autoNamePolicy";
import { buildAutoNameEvidence, namingBinding, plannedNamingMaterial, namingPlanKey, type NamingMaterial, type AutoNameEvidence, type AutoNameScan } from "./autoNameMaterial";
export { buildAutoNameEvidence, namingBinding } from "./autoNameMaterial";
export type { NamingMaterial, AutoNameEvidence, AutoNameScan } from "./autoNameMaterial";
/** Re-check the live metadata overlay that the scan used, without another IPC read. */
export function liveNamingBinding(tab: PaneTab, pane?: Pane): string {
  const metadata = usePaneMetadataStore.getState().metadata[tab.sessionId];
  return namingBinding({ ...tab, cwd: metadata?.cwd ?? tab.cwd ?? pane?.cwd ?? "",
    agentKind: metadata?.agentKind ?? tab.agentKind ?? pane?.agentKind ?? "",
    agentSessionId: metadata?.agentSessionId ?? tab.agentSessionId ?? metadata?.claudeSessionId ?? tab.claudeSessionId });
}
export const NAMING_READ_INTERVAL_MS = 60_000;
type LiveState = ReturnType<typeof useLiveBriefStore.getState>;
type ScanTab = GroupingScan["tabs"][number];
export function cachedNamingMaterial(tab: ScanTab, state: LiveState = useLiveBriefStore.getState()): NamingMaterial | undefined {
  const brief = state.briefsBySession[tab.sessionId]; const age = brief ? Date.now() - brief.updatedAt : Infinity;
  if (!brief || brief.ptySessionId !== tab.sessionId || brief.agentSessionId !== tab.agentSessionId || brief.agentKind !== tab.agentKind
    || brief.telemetryHealth !== "live" || age < 0 || age >= NAMING_READ_INTERVAL_MS) return undefined;
  const events = [...new Map([...(state.eventsBySession[tab.sessionId] ?? []), ...(state.listEventsBySession[tab.sessionId] ?? [])]
    .map(event => [event.eventId, event])).values()];
  return plannedNamingMaterial(tab, brief.namingPlan, events);
}
/** Heartbeats, sequence numbers and focus do not restart an in-flight naming scan. */
export function liveNamingMaterialSignature(state: LiveState): string {
  return JSON.stringify(Object.values(state.briefsBySession).sort((a,b) => a.ptySessionId.localeCompare(b.ptySessionId)).map(brief => {
    const tab: ScanTab = { id: brief.ptySessionId, sessionId: brief.ptySessionId, agentKind: brief.agentKind, agentSessionId: brief.agentSessionId,
      cwd: "", label: "", workspaceId: "", workspaceName: "", paneId: "", column: 1, lastOutputAt: null, tail: [] };
    const material = cachedNamingMaterial(tab, state); const evidence = buildAutoNameEvidence(tab, material);
    return [brief.ptySessionId, brief.agentSessionId, brief.agentKind, brief.telemetryHealth, evidence.contentKey, deriveAutoName(evidence).meaningKey,
      material ? null : [brief.namingSourceEventIds, namingPlanKey(brief.namingPlan)]];
  }));
}
export function namingScanStillCurrent(scan: AutoNameScan, tab: ScanTab): boolean {
  if (scan.namingSourceKeys?.get(tab.id) !== undefined && scan.namingSourceKeys.get(tab.id) !== namingSourceKey(tab)) return false;
  const material = cachedNamingMaterial(tab);
  return !material || buildAutoNameEvidence(tab, material).contentKey === scan.naming.get(tab.id)?.contentKey;
}
function namingSourceKey(tab: ScanTab): string {
  const brief = useLiveBriefStore.getState().briefsBySession[tab.sessionId];
  const age = brief ? Date.now() - brief.updatedAt : Infinity;
  return brief?.ptySessionId === tab.sessionId && brief.agentSessionId === tab.agentSessionId && brief.agentKind === tab.agentKind
    && brief.telemetryHealth === "live" && age >= 0 && age < NAMING_READ_INTERVAL_MS
    ? JSON.stringify([brief.serviceEpoch, brief.namingSourceEventIds ?? [], namingPlanKey(brief.namingPlan)]) : "";
}
const cache = new Map<string, { at: number; key: string; sourceKey: string; value?: NamingMaterial }>();
export async function readAutoNameScan(): Promise<AutoNameScan> {
  const raw = await scanGroupingContext();
  const scan = { ...raw, tabs: raw.tabs.filter(tab => raw.workspaces.find(w => w.id === tab.workspaceId)?.status !== "stopped") };
  const naming = new Map<string, AutoNameEvidence>(), namingSourceKeys = new Map<string, string>(); const requests = [];
  for (const tab of scan.tabs) {
    const sourceKey = namingSourceKey(tab); namingSourceKeys.set(tab.id, sourceKey);
    const material = cachedNamingMaterial(tab);
    if (material) { naming.set(tab.id, buildAutoNameEvidence(tab, material)); continue; }
    const key = namingBinding(tab); const prior = cache.get(tab.id);
    if (!prior || prior.key !== key || Date.now() - prior.at >= NAMING_READ_INTERVAL_MS
      || (sourceKey !== "" && prior.sourceKey !== sourceKey)) {
      // A healthy live source's new references require its current native
      // snapshot. Repeated/failed reads of that source and fallback IO remain
      // throttled; a deferred snapshot must not become an apparent read loss.
      cache.set(tab.id, { at: Date.now(), key, sourceKey });
      requests.push({ tab_id: tab.id, pty_session_id: tab.sessionId, agent_kind: tab.agentKind, agent_session_id: tab.agentSessionId, cwd: tab.cwd });
    } else naming.set(tab.id, buildAutoNameEvidence(tab, prior.sourceKey === sourceKey ? prior.value : undefined));
  }
  for (let at = 0; at < requests.length; at += 64) {
    const batch = requests.slice(at, at + 64);
    try {
      const values = await invoke<NamingMaterial[]>("auto_name_materials", { requests: batch });
      for (const value of values) {
        const tab = scan.tabs.find(tab => tab.id === value.tab_id); if (!tab) continue;
        if (value.pty_session_id !== tab.sessionId || value.cwd !== tab.cwd || value.agent_kind !== tab.agentKind
          || (value.agent_session_id ?? undefined) !== tab.agentSessionId) continue;
        cache.set(tab.id, { at: Date.now(), key: namingBinding(tab), sourceKey: namingSourceKeys.get(tab.id) ?? "", value }); naming.set(tab.id, buildAutoNameEvidence(tab, value));
      }
    } catch { /* A read failure does not promote an old, differently bound transcript. */ }
  }
  const ids = new Set(scan.tabs.map(tab => tab.id)); for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
  for (const tab of scan.tabs) if (!naming.has(tab.id)) naming.set(tab.id, buildAutoNameEvidence(tab));
  return { ...scan, naming, namingSourceKeys };
}
