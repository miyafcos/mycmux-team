import type { LauncherDirCandidate, LauncherDirsLastScan } from "./ipc";
import type { launcherTabStrings } from "../components/settings/tabs/launcherTabStrings";
import { middleEllipsis } from "../components/workspace/launcherModel";

type Strings = typeof launcherTabStrings;
export const RULE_TYPES = ["git-parents", "folder-root", "session-cwd", "session-mentions"] as const;
export type RuleType = typeof RULE_TYPES[number];
export type RuleMode = "suggest" | "auto";
export interface LauncherRule {
  id: string;
  section: string;
  type: RuleType;
  mode: RuleMode;
  enabled: boolean;
  window_days: number;
  max: number;
  parents?: string[];
  root?: string | null;
  depth?: number;
  depth_overrides?: Array<{ prefix: string; depth: number }>;
  max_depth?: number;
  min_sessions?: number;
  min_mentions?: number;
  exclude?: { prefixes: string[]; names: string[]; substrings: string[] };
  top_level_exclude?: string[];
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0xffffffff;
const words = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const daysFor = (type: RuleType) => type === "folder-root" ? 21 : type === "session-mentions" ? 14 : 30;

export function ruleId(value: unknown): string | null {
  return object(value) && typeof value.id === "string" ? value.id : null;
}

export function readRule(value: unknown): LauncherRule | null {
  if (!object(value) || typeof value.id !== "string" || typeof value.section !== "string" || !["dev", "anken"].includes(value.section) ||
    !RULE_TYPES.includes(value.type as RuleType) || typeof value.mode !== "string" || !["suggest", "auto"].includes(value.mode) || typeof value.enabled !== "boolean") return null;
  const type = value.type as RuleType;
  const window_days = value.window_days === undefined ? daysFor(type) : value.window_days;
  const max = value.max === undefined ? type === "git-parents" ? 10 : 20 : value.max;
  if (!positive(window_days) || !positive(max)) return null;
  const rule: LauncherRule = { id: value.id, section: value.section as string, type, mode: value.mode as RuleMode, enabled: value.enabled, window_days, max };
  if (type === "git-parents") {
    if (!words(value.parents) || !value.parents.length || value.parents.some((path) => !path.trim())) return null;
    rule.parents = [...value.parents];
  } else if (type === "session-cwd") {
    if (value.root !== undefined && value.root !== null && !nonempty(value.root)) return null;
    rule.root = (value.root as string | null | undefined) ?? null;
    const min = value.min_sessions === undefined ? 1 : value.min_sessions;
    if (!positive(min)) return null;
    rule.min_sessions = min;
  } else {
    if (!nonempty(value.root)) return null;
    rule.root = value.root;
    const depth = value.depth === undefined ? 2 : value.depth;
    const overrides = value.depth_overrides === undefined ? [] : value.depth_overrides;
    if (!positive(depth) || !Array.isArray(overrides) || !overrides.every((item) => object(item) && nonempty(item.prefix) && positive(item.depth))) return null;
    rule.depth = depth;
    rule.depth_overrides = overrides.map((item) => ({ prefix: item.prefix as string, depth: item.depth as number }));
    if (type === "folder-root") {
      const maxDepth = value.max_depth === undefined ? 6 : value.max_depth;
      if (!positive(maxDepth)) return null;
      rule.max_depth = maxDepth;
      const top = value.top_level_exclude === undefined ? [] : value.top_level_exclude;
      if (!words(top)) return null;
      rule.top_level_exclude = [...top];
    } else {
      const min = value.min_mentions === undefined ? 3 : value.min_mentions;
      if (!positive(min)) return null;
      rule.min_mentions = min;
    }
  }
  if (type === "git-parents" || type === "folder-root") {
    const exclude = value.exclude === undefined ? {} : value.exclude;
    if (!object(exclude)) return null;
    rule.exclude = { prefixes: [], names: [], substrings: [] };
    for (const key of ["prefixes", "names", "substrings"] as const) {
      const list = exclude[key] === undefined ? [] : exclude[key];
      if (!words(list)) return null;
      rule.exclude[key] = [...list];
    }
  }
  return rule;
}

export function ruleTypeLabel(type: RuleType, T: Strings): string {
  return { "git-parents": T.ruleTypeGit, "folder-root": T.ruleTypeFolder, "session-cwd": T.ruleTypeSessionCwd, "session-mentions": T.ruleTypeMentions }[type];
}

export function ruleTypeNote(type: RuleType, T: Strings): string {
  return { "git-parents": T.ruleTypeGitNote, "folder-root": T.ruleTypeFolderNote, "session-cwd": T.ruleTypeSessionCwdNote, "session-mentions": T.ruleTypeMentionsNote }[type];
}

function homeRelative(path: string, home: string): string {
  const clean = (value: string) => value.replace(/\\/g, "/").replace(/\/$/, "");
  const full = clean(path), base = clean(home);
  const fold = /^[a-z]:/i.test(base) ? (value: string) => value.toLowerCase() : (value: string) => value;
  if (base && fold(full) === fold(base)) return "~";
  return base && fold(full).startsWith(`${fold(base)}/`) ? `~${full.slice(base.length)}` : full;
}

function shortRoot(path: string): string {
  const parts = path.replace(/\\/g, "/").replace(/\/$/, "").split("/");
  return parts.length > 2 ? `\u2026/${parts.slice(-2).join("/")}` : parts.join("/");
}

export function ruleSummary(value: unknown, homePath: string, T: Strings): string {
  const rule = readRule(value);
  if (!rule) return T.ruleTypeUnknown;
  const days = T.summaryDays(rule.window_days), max = T.summaryMax(rule.max);
  const depth = T.summaryDepth(rule.depth ?? 2, (rule.depth_overrides ?? []).map((item) => `${item.prefix} ${item.depth}`).join(", "));
  switch (rule.type) {
    case "git-parents": return [T.summaryUnder(rule.parents!.map((path) => homeRelative(path, homePath)).join(" ")), days, max].join(" \u00b7 ");
    case "folder-root": return [shortRoot(rule.root!), depth, days, max,
      T.summaryExcludes(Object.values(rule.exclude!).reduce((sum, list) => sum + list.length, 0) + rule.top_level_exclude!.length)].join(" \u00b7 ");
    case "session-cwd": return [rule.root ? shortRoot(rule.root) : T.summaryAllSessions, days, max, T.summaryMinSessions(rule.min_sessions!)].join(" \u00b7 ");
    case "session-mentions": return [shortRoot(rule.root!), depth, days, T.summaryMinMentions(rule.min_mentions!), max].join(" \u00b7 ");
  }
}

export interface RuleForm {
  id: string;
  section: string;
  type: RuleType;
  mode: RuleMode;
  enabled: boolean;
  parents: string;
  root: string;
  window_days: string;
  max: string;
  depth: string;
  depth_overrides: string;
  max_depth: string;
  min_sessions: string;
  min_mentions: string;
  exclude_prefixes: string;
  exclude_names: string;
  exclude_substrings: string;
  top_level_exclude: string;
}

export const DEFAULT_GIT_EXCLUDE_PREFIXES = ["_", ".", "~$"];
export const DEFAULT_GIT_EXCLUDE_NAMES = ["AppData", "Dropbox", "OneDrive"];
export const DEFAULT_GIT_EXCLUDE_SUBSTRINGS = ["backup"];

export function ruleForm(type: RuleType, section = "dev", rule?: LauncherRule): RuleForm {
  const gitDefaults = !rule && type === "git-parents";
  return {
    id: rule?.id ?? "", type, section: rule?.section ?? section, mode: rule?.mode ?? "suggest", enabled: rule?.enabled ?? true,
    parents: rule?.parents?.join("\n") ?? "", root: rule?.root ?? "",
    window_days: String(rule?.window_days ?? daysFor(type)), max: String(rule?.max ?? (type === "git-parents" ? 10 : 20)),
    depth: String(rule?.depth ?? 2), depth_overrides: rule?.depth_overrides?.map((item) => `${item.prefix}=${item.depth}`).join("\n") ?? "",
    max_depth: String(rule?.max_depth ?? 6), min_sessions: String(rule?.min_sessions ?? 1), min_mentions: String(rule?.min_mentions ?? 3),
    exclude_prefixes: rule?.exclude?.prefixes.join("\n") ?? (gitDefaults ? DEFAULT_GIT_EXCLUDE_PREFIXES.join("\n") : ""),
    exclude_names: rule?.exclude?.names.join("\n") ?? (gitDefaults ? DEFAULT_GIT_EXCLUDE_NAMES.join("\n") : ""),
    exclude_substrings: rule?.exclude?.substrings.join("\n") ?? (gitDefaults ? DEFAULT_GIT_EXCLUDE_SUBSTRINGS.join("\n") : ""),
    top_level_exclude: rule?.top_level_exclude?.join("\n") ?? "",
  };
}

export function validateRuleForm(form: RuleForm, T: Strings): { rule: LauncherRule | null; error: string | null } {
  const lines = (value: string) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const fail = (error: string) => ({ rule: null, error });
  if (form.type === "git-parents" && !lines(form.parents).length) return fail(T.validationParentsRequired);
  if (["folder-root", "session-mentions"].includes(form.type) && !form.root.trim()) return fail(T.validationRootRequired);
  const fields: Array<[keyof RuleForm, string]> = [["window_days", T.fieldWindowDays], ["max", T.fieldMax]];
  if (["folder-root", "session-mentions"].includes(form.type)) fields.push(["depth", T.fieldDepth]);
  if (form.type === "folder-root") fields.push(["max_depth", T.fieldMaxDepth]);
  if (form.type === "session-cwd") fields.push(["min_sessions", T.fieldMinSessions]);
  if (form.type === "session-mentions") fields.push(["min_mentions", T.fieldMinMentions]);
  for (const [key, label] of fields) if (!positive(Number(form[key]))) return fail(T.validationPositiveInteger(label));
  const value: Record<string, unknown> = { id: form.id, section: form.section, type: form.type, mode: form.mode, enabled: form.enabled };
  for (const [key] of fields) value[key] = Number(form[key]);
  if (form.type === "git-parents") value.parents = lines(form.parents);
  else value.root = form.root.trim() || null;
  if (form.type === "folder-root" || form.type === "session-mentions") {
    const overrides = [];
    for (const line of lines(form.depth_overrides)) {
      const split = line.lastIndexOf("="), prefix = line.slice(0, split).trim(), depth = Number(line.slice(split + 1));
      if (split < 1 || !prefix || !positive(depth)) return fail(T.validationPositiveInteger(T.fieldDepthOverrides));
      overrides.push({ prefix, depth });
    }
    value.depth_overrides = overrides;
  }
  if (form.type === "git-parents" || form.type === "folder-root") value.exclude = {
    prefixes: lines(form.exclude_prefixes), names: lines(form.exclude_names), substrings: lines(form.exclude_substrings),
  };
  if (form.type === "folder-root") value.top_level_exclude = lines(form.top_level_exclude);
  const rule = readRule(value);
  return rule ? { rule, error: null } : fail(T.ruleTypeUnknown);
}

export function readLastScan(value: unknown): LauncherDirsLastScan | null {
  if (!object(value) || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at)) || !Array.isArray(value.candidates) || !object(value.results)) return null;
  const candidates = value.candidates.filter((item): item is LauncherDirCandidate => object(item) &&
    nonempty(item.path) && nonempty(item.label) && typeof item.section === "string" &&
    typeof item.signal === "string" && ["git", "folder", "session", "mention"].includes(item.signal) && typeof item.source === "string" && ["rule", "mru"].includes(item.source) &&
    (item.seen_at === null || typeof item.seen_at === "string") && (item.rule_id === null || typeof item.rule_id === "string"));
  const results: LauncherDirsLastScan["results"] = {};
  for (const [id, result] of Object.entries(value.results)) {
    if (object(result) && typeof result.count === "number" && typeof result.truncated === "boolean" && (result.error === null || typeof result.error === "string")) {
      results[id] = { count: result.count, truncated: result.truncated, error: result.error };
    }
  }
  return { at: value.at, duration_ms: typeof value.duration_ms === "number" ? value.duration_ms : 0, candidates, results,
    more: typeof value.more === "number" && Number.isInteger(value.more) && value.more > 0 ? value.more : 0 };
}

export function formatCandidate(candidate: LauncherDirCandidate, T: Strings) {
  const date = candidate.seen_at?.match(/^\d{4}-(\d{2})-(\d{2})$/);
  const stamp = date ? `${date[1]}/${date[2]}` : "";
  const descriptions = { git: T.signalGit, folder: T.signalFolder, session: T.signalSession, mention: T.signalMention };
  return { path: middleEllipsis(candidate.path, 48), title: candidate.path,
    mark: ["session", "mention"].includes(candidate.signal) ? "\u25cf" : "",
    signal: candidate.source === "mru" ? T.signalMru : descriptions[candidate.signal](stamp) };
}
