import { invoke } from "@tauri-apps/api/core";

export interface SkillCategory { id: string; name: string; color: string; symbol: string | null }
export interface SkillRow {
  id: string; label: string; description: string; line: string; kind: string; plugin: string | null;
  category: string; symbol: string | null; glyph: string; agents: string[]; aliases: string[];
  duplicateCodex?: boolean; hasWrapper?: boolean;
  curation: string; isNew: boolean; docPath: string | null; calls: Record<string, string>;
  usageCount: number; usage: { claude: number; codex: number }; lastUsedAt: number | null;
  body: string; triggers: string[] | string | null; modifiedAt: number; fileSize: number; codexRecorded: boolean;
}
export interface SkillCatalog { generatedAt: string; categories: SkillCategory[]; skills: SkillRow[]; hiddenSkills?: SkillRow[]; hiddenCount: number; newCount: number }
export interface SkillDocument { frontmatter: Record<string, unknown>; body: string; html: string; toc: { level: number; text: string }[]; lines: number; size: number; modifiedAt: number }
export interface SkillFile { path: string; name: string; depth: number; dir: boolean; size: number; kind?: string; files?: number; reason?: string | null }
export interface SkillFolder { root: string; rootName: string; single: boolean; entries: SkillFile[]; files: SkillFile[]; blocked: { path: string; name: string; reason: string }[]; selected: string[]; size: number; limits: { bytes: number; files: number } }
export interface SkillPreview { kind: string; path: string; content: string | null; html?: string }
export interface SkillLocation { path: string; folder: string; relation: string; modifiedAt: number; lines: number; fileCount: number | null; allowImplicitInvocation: boolean | null; target: string | null; targetExists: boolean | null; descriptionSame: boolean | null; sameContent: boolean | null; description: string; originalDescription: string; hash: string }
export interface SkillLocations { id: string; duplicateCodex: boolean; codexCount: number; items: SkillLocation[] }
export interface SkillDiff { truncated: boolean; lines: { kind: string; left?: number; right?: number; text: string }[] }

let cachedCatalog: SkillCatalog | null = null;
let snapshotVersion = 0;
export const skillsApi = {
  peek: () => cachedCatalog,
  cached: async () => { const version = snapshotVersion; const data = await invoke<SkillCatalog | null>("skills_cached"); if (data && version === snapshotVersion) cachedCatalog = data; return data; },
  refresh: async () => { const data = await invoke<SkillCatalog>("skills_refresh"); snapshotVersion++; cachedCatalog = data; return data; },
  document: (id: string) => invoke<SkillDocument>("skills_document", { id }),
  folder: (id: string) => invoke<SkillFolder>("skills_folder", { id }),
  preview: (id: string, relative: string) => invoke<SkillPreview>("skills_preview", { id, relative }),
  locations: (id: string) => invoke<SkillLocations>("skills_locations", { id }),
  diff: (id: string, left: number, right: number) => invoke<SkillDiff>("skills_diff", { id, left, right }),
  export: (id: string, paths: string[], destination: string) => invoke<string>("skills_export", { id, paths, destination }),
};
