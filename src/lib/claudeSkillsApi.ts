import { invoke } from "@tauri-apps/api/core";

export type SkillState = "not-installed" | "latest" | "outdated" | "locally-modified";
export interface Prerequisite { found: boolean; detail: string }
export interface ClaudeSkillsStatus {
  pack_version: string;
  skills: { name: string; state: SkillState; installed_version: string | null }[];
  cli: { state: Exclude<SkillState, "locally-modified"> };
  prereq: { claude: Prerequisite; python: Prerequisite };
  home: string;
}
export interface ClaudeSkillsInstallResult {
  installed: string[];
  skipped: string[];
  backups: string[];
  errors: string[];
}
export const claudeSkillsStatus = () => invoke<ClaudeSkillsStatus>("claude_skills_status");
export const claudeSkillsInstall = (names: string[], force: boolean) =>
  invoke<ClaudeSkillsInstallResult>("claude_skills_install", { names, force });
