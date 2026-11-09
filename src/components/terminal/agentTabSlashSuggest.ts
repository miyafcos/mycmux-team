import { skillsApi, type SkillCatalog } from "../../lib/skillsApi";
import { claudeSlashCommands, type ClaudeSlashCommand } from "./claudeSlashCommands";

export interface AgentTabSlashSuggestion {
  name: string;
  kind: ClaudeSlashCommand["kind"] | "skill";
  description: string;
  argumentHint: string;
  aliases: readonly string[];
  lastUsedAt?: number | null;
}

let slashSkillsLoad: Promise<SkillCatalog | null> | null = null;

/** Share one lazy scan across composers, retaining failures until the next app start. */
export function loadAgentTabSlashSkills(cached?: Promise<SkillCatalog | null>): Promise<SkillCatalog | null> {
  const catalog = skillsApi.peek();
  if (catalog) return Promise.resolve(catalog);
  if (!slashSkillsLoad) {
    slashSkillsLoad = (async () => {
      const snapshot = await (cached ?? skillsApi.cached());
      return skillsApi.peek() ?? snapshot ?? await skillsApi.refresh();
    })().catch(() => null);
  }
  return slashSkillsLoad;
}

export function resetAgentTabSlashSkillsForTest(): void {
  slashSkillsLoad = null;
}

export function buildAgentTabSlashCandidates(catalog: SkillCatalog | null): AgentTabSlashSuggestion[] {
  const candidates: AgentTabSlashSuggestion[] = [...claudeSlashCommands];
  const names = new Set(candidates.flatMap(command => [command.name, ...command.aliases].map(name => name.toLowerCase())));
  for (const skill of catalog?.skills ?? []) {
    const call = skill.calls.claude;
    if (skill.listedIn?.claude === false || !call || !/^\/[^\s/]+$/.test(call)) continue;
    const name = call.slice(1);
    if (names.has(name.toLowerCase())) continue;
    names.add(name.toLowerCase());
    candidates.push({ name, kind: "skill", description: skill.line, argumentHint: "", aliases: [], lastUsedAt: skill.lastUsedAt });
  }
  return candidates;
}

/** The caret must be in the first token; argument editing never opens a menu. */
export function agentTabSlashQuery(text: string, cursor: number): string | null {
  if (!text.startsWith("/") || /[\r\n\u2028\u2029]/.test(text)) return null;
  const space = text.search(/\s/);
  const end = space < 0 ? text.length : space;
  return cursor >= 1 && cursor <= end ? text.slice(1, end) : null;
}

export function findAgentTabSlashCandidate(name: string, candidates: readonly AgentTabSlashSuggestion[]): AgentTabSlashSuggestion | undefined {
  const query = name.toLowerCase();
  return candidates.find(candidate => [candidate.name, ...candidate.aliases].some(name => name.toLowerCase() === query));
}

function subsequence(text: string, query: string): boolean {
  let index = 0;
  for (const character of text) if (character === query[index]) index++;
  return index === query.length;
}

/** Rank match quality first, then Composer recency, skill use, and name. */
export function filterAgentTabSlashCandidates(
  candidates: readonly AgentTabSlashSuggestion[], query: string, recent: readonly string[],
): AgentTabSlashSuggestion[] {
  const lower = query.toLowerCase();
  const recency = (name: string) => {
    const index = recent.indexOf(name);
    return index < 0 ? Number.POSITIVE_INFINITY : index;
  };
  const byName = (a: AgentTabSlashSuggestion, b: AgentTabSlashSuggestion) => a.name.localeCompare(b.name, "en");
  if (!lower) {
    const top = recent.slice(0, 5).flatMap(name => {
      const command = candidates.find(candidate => candidate.name === name);
      return command ? [command] : [];
    });
    const used = new Set(top);
    return [...top, ...candidates.filter(candidate => !used.has(candidate)).sort(byName)];
  }
  return candidates.flatMap(candidate => {
    const name = candidate.name.toLowerCase();
    const names = [name, ...candidate.aliases.map(alias => alias.toLowerCase())];
    const rank = names.some(name => name.startsWith(lower)) ? 0 : name.includes(lower) ? 1
      : names.some(name => subsequence(name, lower)) ? 2 : -1;
    return rank < 0 ? [] : [{ candidate, rank }];
  }).sort((a, b) => a.rank - b.rank
    || recency(a.candidate.name) - recency(b.candidate.name)
    || (b.candidate.lastUsedAt ?? 0) - (a.candidate.lastUsedAt ?? 0)
    || byName(a.candidate, b.candidate)).map(match => match.candidate);
}

export function completeAgentTabSlashCommand(text: string, candidate: AgentTabSlashSuggestion): string {
  const space = text.search(/\s/);
  // Editing a name must not discard arguments already written after it.
  const suffix = space < 0 ? candidate.argumentHint ? " " : "" : text.slice(space);
  return "/" + candidate.name + suffix;
}

export function agentTabSlashEnterAction(text: string, candidate: AgentTabSlashSuggestion): { text: string; send: boolean } {
  const name = text.split(/\s/, 1)[0].slice(1);
  if ([candidate.name, ...candidate.aliases].includes(name)) return { text, send: true };
  return { text: completeAgentTabSlashCommand(text, candidate), send: !candidate.argumentHint.startsWith("<") || /^<optional/i.test(candidate.argumentHint) };
}

export const AGENT_TAB_SLASH_RECENT_KEY = "mycmux:agent-tab-slash-recent";
const validName = (value: unknown): value is string => typeof value === "string" && /^[^\s/]+$/.test(value) && value.length <= 256;
const boundedNames = (values: readonly unknown[]) => [...new Set(values.filter(validName))].slice(0, 20);

export function readAgentTabSlashRecent(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(AGENT_TAB_SLASH_RECENT_KEY) ?? "null");
    return Array.isArray(value) ? boundedNames(value) : [];
  } catch { return []; }
}

export function rememberAgentTabSlashCommand(
  text: string, candidates: readonly AgentTabSlashSuggestion[], recent: readonly string[],
): string[] {
  const token = text.trim().split(/\s/, 1)[0];
  if (!/^\/[a-z]/i.test(token) || /[\r\n\u2028\u2029]/.test(text)) return [...recent];
  const name = findAgentTabSlashCandidate(token.slice(1), candidates)?.name ?? token.slice(1);
  const next = boundedNames([name, ...recent]);
  try { localStorage.setItem(AGENT_TAB_SLASH_RECENT_KEY, JSON.stringify(next)); } catch { /* Storage is optional. */ }
  return next;
}
