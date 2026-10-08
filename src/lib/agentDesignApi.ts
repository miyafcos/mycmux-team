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
  closedEntries?: { id: string; reason: string; closedAt: string; workFolder: string }[];
}
export interface DocumentMask { index: number; start: number; end: number; line: number; label: string }
export interface DocumentFile { id: string; name: string; directory: boolean; bytes: number | null; private: boolean; reason: string | null }
export interface DesignDocument {
  id: string; body: string | null; fields: DesignField[]; size: DesignSize; status: string;
  /** Present only on the on-open response, never in the portable catalogue. */
  html?: string; frontmatter?: Record<string, unknown>; toc?: { level: number; text: string }[];
  masks?: DocumentMask[]; files?: DocumentFile[]; fileCount?: number; fileOffset?: number;
  nextOffset?: number | null; relative?: string | null; parent?: string | null; folder?: string;
  path?: string | null; revision?: string; reason?: string | null; truncated?: boolean;
}
export interface DesignScene { itemIds: string[]; chars: number | null; evidence: string }
export interface DesignAmountChange { key: string; before: number | null; after: number | null }
export interface DesignHistoryChange {
  id: string; itemId: string | null; service: AgentServiceId; layer: number; displayName: string; path: string | null;
  kind: string; badge: string; source: string; at: string; beforeBytes: number | null; afterBytes: number | null;
  amountChanges: DesignAmountChange[]; hash: string | null; subject: string | null; author: string | null;
  linesAdded: number | null; linesDeleted: number | null;
}
export interface DesignHistory {
  schemaVersion: number; snapshotCount: number; capturedAt: string | null; writing: boolean; warnings: string[];
  changes: DesignHistoryChange[];
  snapshots?: { id: string; capturedAt: string; catalogGeneratedAt: string; itemCount: number; services?: { service: string; state: string; itemCount: number }[] }[];
}
export interface DesignGitHistory { status: string; changes: DesignHistoryChange[] }
export interface DesignHistoryDiff { mode: string; status: string; beforeBytes: number | null; afterBytes: number | null; truncated: boolean; lines: { kind: string; oldLine: number | null; newLine: number | null; text: string }[] }
export interface AgentDesignApi {
  peek: (cwd?: string | null) => AgentDesignCatalog | null;
  cached: (cwd?: string | null) => Promise<AgentDesignCatalog | null>;
  refresh: (cwd?: string | null) => Promise<AgentDesignCatalog>;
  document: (id: string, cwd?: string | null, relative?: string | null, offset?: number) => Promise<DesignDocument>;
  reveal?: (id: string, cwd: string | null, relative: string | null, mask: number, revision: string) => Promise<string>;
  close: (id: string, reason: string, cwd?: string | null) => Promise<AgentDesignCatalog>;
  scene: (touchedPath: string, cwd?: string | null) => Promise<DesignScene>;
  setHermesHome: (path: string) => Promise<void>;
  history?: (cwd?: string | null) => Promise<DesignHistory>;
  historyPair?: (before: string, after: string, cwd?: string | null) => Promise<DesignHistoryChange[]>;
  historyGit?: (id: string, cwd?: string | null) => Promise<DesignGitHistory>;
  historyDiff?: (id: string, hash: string, cwd?: string | null) => Promise<DesignHistoryDiff>;
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
  document: (id, cwd, relative, offset) => invoke("agent_design_document", { id, cwd: cwd ?? null,
    ...(relative !== undefined ? { relative } : {}), ...(offset !== undefined ? { offset } : {}) }),
  reveal: (id, cwd, relative, mask, revision) => invoke("agent_design_reveal", { id, cwd, relative, mask, revision }),
  close: async (id, reason, cwd) => {
    const data = await invoke<AgentDesignCatalog>("agent_design_close", { id, reason, cwd: cwd ?? null });
    keep(data, cwd); return data;
  },
  scene: (touchedPath, cwd) => invoke("agent_design_scene", { touchedPath, cwd: cwd ?? null }),
  setHermesHome: path => invoke("agent_design_set_hermes_home", { path }),
  history: cwd => invoke("agent_design_history", { cwd: cwd ?? null }),
  historyPair: (before, after, cwd) => invoke("agent_design_history_pair", { before, after, cwd: cwd ?? null }),
  historyGit: (id, cwd) => invoke("agent_design_history_git", { id, cwd: cwd ?? null }),
  historyDiff: (id, hash, cwd) => invoke("agent_design_history_diff", { id, hash, cwd: cwd ?? null }),
};

export interface AgentExportOptions { services: string[]; layers: number[]; documents: { id: string; sections: string[] | null }[] }
export interface ExportDocument {
  id: string; service: string; layer: number; label: string; path: string; sectioned: boolean; available: boolean; reason?: string | null;
  sections: { id: string; label: string; chars: number }[];
}
export interface AgentExportPreview {
  fingerprint: string; omissions: { kind: string; label: string; reason: string; count: number; path?: string }[];
  hits: { kind: string; term: string; line: number }[]; documentCount: number; bytes: number;
}
export interface AgentDesignExportApi {
  documents: (cwd?: string | null) => Promise<ExportDocument[]>;
  recheck?: (id: string, cwd?: string | null) => Promise<ExportDocument>;
  preview: (options: AgentExportOptions, cwd?: string | null) => Promise<AgentExportPreview>;
  save: (options: AgentExportOptions, fingerprint: string, path: string, cwd?: string | null) => Promise<{ saved: boolean; path: string | null; preview: AgentExportPreview }>;
  names: () => Promise<{ path: string; content: string }>;
  saveNames: (content: string) => Promise<void>;
}
export const agentDesignExportApi: AgentDesignExportApi = {
  documents: cwd => invoke("agent_design_export_documents", { cwd: cwd ?? null }),
  recheck: (id, cwd) => invoke("agent_design_export_recheck", { id, cwd: cwd ?? null }),
  preview: (options, cwd) => invoke("agent_design_export_preview", { options, cwd: cwd ?? null }),
  save: (options, fingerprint, path, cwd) => invoke("agent_design_export_save", { options, fingerprint, path, cwd: cwd ?? null }),
  names: () => invoke("agent_design_export_names"),
  saveNames: content => invoke("agent_design_export_save_names", { content }),
};
