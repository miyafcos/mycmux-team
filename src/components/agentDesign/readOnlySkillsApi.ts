import { invoke } from "@tauri-apps/api/core";
import type { skillsApi, SkillCatalog, SkillDocument, SkillFolder, SkillPreview, SkillLocations, SkillDiff } from "../../lib/skillsApi";
/** Embedding stage 1 never refreshes/writes its cache or starts a product. */
export function createReadOnlySkillsApi(cwd: () => string | null = () => null): typeof skillsApi {
  const snapshots = new Map<string, SkillCatalog>();
  const key = (folder: string | null) => { const path = (folder ?? "").replace(/\\/g, "/"); return /^[a-z]:\//i.test(path) ? path.toLowerCase() : path; };
  const peek = () => snapshots.get(key(cwd())) ?? null;
  const refresh = async () => {
    const folder = cwd();
    const data = await invoke<SkillCatalog>("agent_design_skills", { cwd: folder });
    snapshots.set(key(folder), data);
    return data;
  };
  const read = <T,>(action: string, id: string, extra: Record<string, unknown> = {}) => invoke<T>("agent_design_skill_read", { cwd: cwd(), action, id, relative: null, left: null, right: null, ...extra });
  return {
    peek, cached: async () => peek(), refresh,
    document: id => read<SkillDocument>("document", id),
    folder: id => read<SkillFolder>("folder", id),
    preview: (id, relative) => read<SkillPreview>("preview", id, { relative }),
    locations: id => read<SkillLocations>("locations", id),
    diff: (id, left, right) => read<SkillDiff>("diff", id, { left, right }),
    export: async () => { throw new Error("readOnly"); },
  };
}
