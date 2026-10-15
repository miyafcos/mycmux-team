import type { Pane, PaneTab } from "../types";
import { usePaneMetadataStore } from "../stores/paneMetadataStore";
import { invoke } from "@tauri-apps/api/core";
import { scanGroupingContext, type GroupingScan } from "../components/layout/tabGrouping";
import { useLiveBriefStore } from "../stores/liveBriefStore";
import { deriveAutoName } from "./autoNamePolicy";
import { TITLED_AGENT_KINDS, withSessionTitles } from "./sessionTitles";
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
  if (!material) return true;
  const current = buildAutoNameEvidence(tab, material), prior = scan.naming.get(tab.id);
  return current.coreKey !== undefined && prior?.coreKey !== undefined ? current.coreKey === prior.coreKey : current.contentKey === prior?.contentKey;
}
function namingSourceKey(tab: ScanTab): string {
  const brief = useLiveBriefStore.getState().briefsBySession[tab.sessionId];
  const age = brief ? Date.now() - brief.updatedAt : Infinity;
  return brief?.ptySessionId === tab.sessionId && brief.agentSessionId === tab.agentSessionId && brief.agentKind === tab.agentKind
    && brief.telemetryHealth === "live" && age >= 0 && age < NAMING_READ_INTERVAL_MS
    ? JSON.stringify([brief.serviceEpoch, brief.namingSourceEventIds ?? [], namingPlanKey(brief.namingPlan)]) : "";
}
const failedMaterial = (tab: ScanTab): NamingMaterial => ({ tab_id: tab.id, pty_session_id: tab.sessionId,
  agent_session_id: tab.agentSessionId, agent_kind: tab.agentKind, cwd: tab.cwd, events: [], material_status: "unreadable" });
const cache = new Map<string, { at: number; key: string; sourceKey: string; readFailureCount: number; value?: NamingMaterial }>();
const withReadFailures = (tab: ScanTab, material?: NamingMaterial): AutoNameEvidence => {
  const evidence = buildAutoNameEvidence(tab, material), prior = cache.get(tab.id);
  return {...evidence, readFailureCount:prior?.key === evidence.binding ? prior.readFailureCount : 0};
};
export async function readAutoNameScan(): Promise<AutoNameScan> {
  // Session titles name most agent tabs (autoNamePolicy's presented names). Only the
  // session title is taken here: the task title would change the evidence key and drop holds.
  const grouped = await scanGroupingContext();
  const titled = new Map((await withSessionTitles(grouped, TITLED_AGENT_KINDS)).tabs.map(tab => [tab.id, tab.sessionTitle]));
  const raw = { ...grouped, tabs: grouped.tabs.map(tab => titled.get(tab.id) ? { ...tab, sessionTitle: titled.get(tab.id) } : tab) };
  const scan = { ...raw, tabs: raw.tabs.filter(tab => raw.workspaces.find(w => w.id === tab.workspaceId)?.status !== "stopped") };
  const localMaterials = new Map<string, NamingMaterial>();
  const naming = new Map<string, AutoNameEvidence>(), namingSourceKeys = new Map<string, string>(); const requests = [];
  for (const tab of scan.tabs) {
    const sourceKey = namingSourceKey(tab); namingSourceKeys.set(tab.id, sourceKey);
    const material = cachedNamingMaterial(tab);
    if (material) {
      const evidence = withReadFailures(tab, material);
      // Codex has no session title. Native sources supply its spec or first request when rules cannot name the live turn.
      const meaning = deriveAutoName(evidence);
      if (tab.agentKind !== "codex" || meaning.strength !== "unknown" || meaning.instructionDisposition === "rejection") { naming.set(tab.id, evidence); continue; }
      localMaterials.set(tab.id, material);
    }
    const key = namingBinding(tab); const prior = cache.get(tab.id);
    if (!prior || prior.key !== key || Date.now() - prior.at >= NAMING_READ_INTERVAL_MS
      || (sourceKey !== "" && prior.sourceKey !== sourceKey)) {
      // A healthy live source's new references require its current native
      // snapshot. Repeated/failed reads of that source and fallback IO remain
      // throttled; a deferred snapshot must not become an apparent read loss.
      cache.set(tab.id, { at: Date.now(), key, sourceKey, readFailureCount:prior?.key === key ? prior.readFailureCount : 0 });
      requests.push({ tab_id: tab.id, pty_session_id: tab.sessionId, agent_kind: tab.agentKind, agent_session_id: tab.agentSessionId, cwd: tab.cwd });
    } else naming.set(tab.id, withReadFailures(tab, prior.sourceKey === sourceKey ? prior.value : undefined));
  }
  for (let at = 0; at < requests.length; at += 64) {
    const batch = requests.slice(at, at + 64);
    try {
      const values = await invoke<NamingMaterial[]>("auto_name_materials", { requests: batch });
      for (const value of values) {
        const tab = scan.tabs.find(tab => tab.id === value.tab_id); if (!tab) continue;
        if (value.pty_session_id !== tab.sessionId || value.cwd !== tab.cwd || value.agent_kind !== tab.agentKind
          || (value.agent_session_id ?? undefined) !== tab.agentSessionId) continue;
        const readFailureCount = (cache.get(tab.id)?.readFailureCount ?? 0) + Number(value.material_status === "unreadable" || value.material_status === "incomplete");
        cache.set(tab.id, { at: Date.now(), key: namingBinding(tab), sourceKey: namingSourceKeys.get(tab.id) ?? "", value, readFailureCount });
        naming.set(tab.id, withReadFailures(tab, value));
      }
    } catch { /* Never promote old, differently bound transcript material. */ }
    // An omitted result includes deadline expiry; keep its reason through the read throttle.
    for (const request of batch) if (!naming.has(request.tab_id)) {
      const tab = scan.tabs.find(tab => tab.id === request.tab_id)!;
      const value = localMaterials.has(tab.id) ? { ...localMaterials.get(tab.id)!, material_status: "unreadable" as const } : failedMaterial(tab);
      cache.set(tab.id, { at: Date.now(), key: namingBinding(tab), sourceKey: namingSourceKeys.get(tab.id) ?? "", value, readFailureCount:(cache.get(tab.id)?.readFailureCount ?? 0) + 1 });
      naming.set(tab.id, withReadFailures(tab, value));
    }
  }
  const ids = new Set(scan.tabs.map(tab => tab.id)); for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
  for (const tab of scan.tabs) if (!naming.has(tab.id)) naming.set(tab.id, withReadFailures(tab));
  return { ...scan, naming, namingSourceKeys };
}
