import { invoke } from "@tauri-apps/api/core";
export type AgentServiceId = "claude" | "codex" | "hermes";
export interface DesignField { key: string; value: string }
export interface DesignSize { chars: number | null; lines: number | null; bytes: number | null }
export interface DesignItem {
  id: string; service: AgentServiceId; layer: number; displayName: string; path: string | null;
  kind: string; status: string; size: DesignSize; readTiming: string; evidence: string;
  modifiedAt: number | null; fields: DesignField[]; conditions: string[]; documentAllowed: boolean; active: boolean;
}
export interface DesignLink {
  id: string; from: string; to: string; sourceService: AgentServiceId; targetService: AgentServiceId;
  relation: string; evidence: string; line: number | null; targetPath: string | null; exists: boolean | null;
}
export interface ListedSkill {
  name: string; chars: number; kind: string; plugin: string | null; path: string | null; usageRecorded: boolean | null;
}
export interface SkillListing {
  count: number | null; chars: number | null; entries: ListedSkill[];
  groups: { kind: string; count: number; chars: number }[];
  pluginCounts: Record<string, number>; disabledCounts: Record<string, number>; disabledChars: number | null;
}
export interface DesignSession {
  file: string | null; startedAt?: string | null; linesRead: number; bytesConsumed: number; stoppedAt: string; listing: SkillListing;
  startupHooks: DesignField[]; startupChars: number | null; sections: { kind: string; chars: number }[];
}
export interface DesignService {
  id: AgentServiceId; displayName: string; root: string; state: string; version: string | null; settings: DesignField[];
  stats: Record<string, number | null>; hooks: { event: string; matcher: string; script: string; source: string; line: number | null }[];
  session: DesignSession; context: { instructions: number | null; memory: number | null; listing: number | null; startup: number | null; product: number | null; total: number | null; knownTotal: number };
}
export interface DesignEvidence { path: string | null; line: number | null; record: string | null; rule: string; fields: DesignField[] }
export interface DesignFinding {
  id: string; kind: string; service: AgentServiceId; layer: number; severity: string; count: number; chars: number | null;
  evidence: DesignEvidence[]; unknowns: string[]; proposal: string; itemIds: string[]; names: string[];
}
export interface AgentDesignCatalog {
  schemaVersion: number; generatedAt: string; generator: string; home: string; workFolder: string; cwd: string; refreshMs: number; services: DesignService[];
  items: DesignItem[]; links: DesignLink[]; findings: DesignFinding[]; closedCount: number; warnings: string[];
  layers: { id: number; role: string; itemIds: string[] }[];
  readingFlows: { service: AgentServiceId; steps: { id: string; stage: number; timing: string; chars: number | null; evidence: string; itemIds: string[]; hookScripts: string[] }[] }[];
  compareRows: { id: string; tag: string; cells: { service: AgentServiceId; state: string; itemIds: string[]; values: Record<string, number | null>; fields: DesignField[] }[] }[];
  documents: Record<string, DesignDocument>; closedRevision: number;
}
export interface DesignDocument { id: string; body: string | null; fields: DesignField[]; size: DesignSize; status: string }
export interface DesignScene { itemIds: string[]; chars: number | null; evidence: string }
export interface AgentDesignApi {
  peek: (cwd?: string | null) => AgentDesignCatalog | null;
  cached: (cwd?: string | null) => Promise<AgentDesignCatalog | null>;
  refresh: (cwd?: string | null) => Promise<AgentDesignCatalog>;
  document: (id: string, cwd?: string | null) => Promise<DesignDocument>;
  close: (id: string, reason: string, cwd?: string | null) => Promise<AgentDesignCatalog>;
  scene: (touchedPath: string, cwd?: string | null) => Promise<DesignScene>;
  setHermesHome: (path: string) => Promise<void>;
}
const snapshots = new Map<string, AgentDesignCatalog>();
const versions = new Map<string, number>();
const inFlight = new Map<string, Promise<AgentDesignCatalog>>();
const key = (cwd?: string | null) => { const path = (cwd ?? "").replace(/\\/g, "/"); return /^[a-z]:\//i.test(path) || path.startsWith("//") ? path.toLowerCase() : path; };
function keep(data: AgentDesignCatalog, cwd?: string | null) {
  const folders = new Set([key(cwd), key(data.cwd)]);
  if (key(data.cwd) === key(data.home)) folders.add(key(null));
  for (const folder of folders) {
    snapshots.set(folder, data);
    versions.set(folder, (versions.get(folder) ?? 0) + 1);
  }
}
export const agentDesignApi: AgentDesignApi = {
  peek: cwd => snapshots.get(key(cwd)) ?? null,
  cached: async cwd => {
    const before = versions.get(key(cwd));
    const data = await invoke<AgentDesignCatalog | null>("agent_design_cached", { cwd: cwd ?? null });
    if (data && versions.get(key(cwd)) === before) keep(data, cwd);
    return data;
  },
  refresh: cwd => {
    const pending = inFlight.get(key(cwd)); if (pending) return pending;
    const promise = invoke<AgentDesignCatalog>("agent_design_refresh", { cwd: cwd ?? null }).then(data => { keep(data, cwd); return data; });
    inFlight.set(key(cwd), promise);
    void promise.finally(() => { if (inFlight.get(key(cwd)) === promise) inFlight.delete(key(cwd)); }).catch(() => {});
    return promise;
  },
  document: (id, cwd) => invoke("agent_design_document", { id, cwd: cwd ?? null }),
  close: async (id, reason, cwd) => {
    const data = await invoke<AgentDesignCatalog>("agent_design_close", { id, reason, cwd: cwd ?? null });
    keep(data, cwd); return data;
  },
  scene: (touchedPath, cwd) => invoke("agent_design_scene", { touchedPath, cwd: cwd ?? null }),
  setHermesHome: path => invoke("agent_design_set_hermes_home", { path }),
};
