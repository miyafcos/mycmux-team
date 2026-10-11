import type { PaneTab } from "../types";
import { NAMING_ACTION_WORDS, interpretNamingText, type NamingTask } from "./autoNameLanguage";
import type { GroupingScan } from "../components/layout/tabGrouping";
import type { PaneIdentityResult, ProjectRegistration } from "./paneIdentity";
import { isAutomaticNameTarget, preferredTabName } from "./autoNameOwnership";
export { isAutomaticNameTarget } from "./autoNameOwnership";
import { buildAutoNameEvidence, namingBinding, type AutoNameEvidence, type AutoNameScan } from "./autoNameMaterial";

export const UNKNOWN_AUTO_NAME = "作業内容未取得";
type Segmenter = new (locale: string, options: { granularity: "grapheme" | "word" }) => { segment(text: string): Iterable<{ segment: string }> };
const SegmenterClass = (Intl as unknown as { Segmenter?: Segmenter }).Segmenter;
const graphemeSegmenter = SegmenterClass ? new SegmenterClass("ja", { granularity: "grapheme" }) : undefined;
const wordSegmenter = SegmenterClass ? new SegmenterClass("ja", { granularity: "word" }) : undefined;
export const nameGraphemes = (text: string): string[] => graphemeSegmenter ? [...graphemeSegmenter.segment(text)].map(s => s.segment) : Array.from(text);
const lengthCache = new Map<string, number>();
const length = (text: string) => {
  const found = lengthCache.get(text); if (found !== undefined) return found;
  const size = nameGraphemes(text).length;
  if (text.length <= 256) { if (lengthCache.size >= 2048) lengthCache.clear(); lengthCache.set(text, size); }
  return size;
};
const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
const prefixCache = new Map<string, string>();
export const namePrefix = (text: string) => {
  const key = normalize(text); const found = prefixCache.get(key); if (found !== undefined) return found;
  const prefix = nameGraphemes(key).slice(0, 4).join("");
  if (key.length <= 256) { if (prefixCache.size >= 2048) prefixCache.clear(); prefixCache.set(key, prefix); }
  return prefix;
};
const unsafe = /[\x00-\x1f\x7f\ufffd\ud800-\udfff]|・\s*・|…|(?:claude|codex)-\d+|\b\d{6,8}[-_]/u;
export interface AutoNameMeaning {
  target: string; qualifier?: string; projectIdentity?: string; projectTitle?: string; action: string; topic: string; fullName: string; shortCandidates: string[];
  evidenceRefs: string[]; strength: "strong" | "weak" | "unknown"; binding: string;
  contentKey: string; meaningKey: string; fresh: boolean;
  source?: "instruction" | "activity" | "file" | "heading" | "none";
  instructionDisposition?: "none" | "status" | "followup" | "continuation" | "rejection" | "replacement";
  rejectedTasks?: Array<{ target: string; action: string }>;
  instructionContext?: "direct" | "control";
  instructionIndex?: number; instructionPosition?: number;
}
const actionSuffix = /(?:制作|修正|校正|調整|調査|比較|編集|確認|集計|送付|見積)$/;
function balancedPhrase(text: string): boolean {
  const stack: string[] = []; const pairs: Record<string, string> = { "（": "）", "(": ")", "「": "」", "『": "』", "[": "]", "【": "】" };
  const closings = new Set(Object.values(pairs));
  for (const character of text) {
    if (pairs[character]) stack.push(pairs[character]);
    else if (closings.has(character) && stack.pop() !== character) return false;
  }
  return stack.length === 0;
}
/** Conservative phrase boundaries. A hiragana noun is indivisible even if
 * Intl emits small pieces; a literal の inside it is never a cutting point. */
function segmentTargetParts(target: string): string[] {
  if (!wordSegmenter) return [target];
  const words = [...wordSegmenter.segment(target)];
  const boundaries: Array<{ start: number; end: number }> = [];
  let at = 0;
  for (let index = 0; index < words.length; index++) {
    const word = words[index].segment;
    const before = words[index - 1]?.segment ?? "";
    const after = words[index + 1]?.segment ?? "";
    const particle = word === "の" && length(before) >= 2 && /^[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9ー]+$/u.test(before);
    if ((particle || word === "・" || word === "、") && before.trim() && after.trim()) boundaries.push({ start: at, end: at + word.length });
    at += word.length;
  }
  const parts: string[] = []; let start = 0;
  for (const boundary of boundaries) { parts.push(target.slice(start, boundary.start).trim()); start = boundary.end; }
  parts.push(target.slice(start).trim());
  return parts.every(part => part && balancedPhrase(part)) ? parts : [target];
}
const targetPartsCache = new Map<string, readonly string[]>();
function targetParts(target: string): readonly string[] {
  const cached = targetPartsCache.get(target); if (cached) return cached;
  const parts = segmentTargetParts(target);
  if (target.length <= 256) {
    if (targetPartsCache.size >= 2048) targetPartsCache.clear();
    targetPartsCache.set(target, parts);
  }
  return parts;
}
function completeTarget(target: string, cap: number): string | null {
  if (cap < 2) return null;
  if (length(target) <= cap) return target;
  const parts = targetParts(target);
  const head = parts[parts.length - 1];
  if (length(head) > cap || !balancedPhrase(head)) return null;
  // Keep the entire head phrase and complete outer phrases that fit. Never
  // splice word fragments, synthesize conjunctions or guess a suffix noun.
  const modifiers: string[] = [];
  for (const part of parts.slice(0, -1)) {
    if (length([...modifiers, part, head].join("の")) <= cap) modifiers.push(part);
  }
  const compact = [...modifiers, head].join("の");
  return compact && !/[のをがにと・ /]$/.test(compact) ? compact : null;
}
export function shortAutomaticName(fullName: string, cap = 20): string {
  if (length(fullName) <= cap) return fullName;
  const number = fullName.match(/・[1-9]\d*$/)?.[0] ?? "";
  const base = number ? fullName.slice(0, -number.length) : fullName;
  const pieces = base.split("・");
  if (NAMING_ACTION_WORDS.some(action => pieces[0] === action) && pieces.length === 2) {
    const target = completeTarget(pieces[1], cap - length(pieces[0] + "・" + number));
    return target ? pieces[0] + "・" + target + number : UNKNOWN_AUTO_NAME + number;
  }
  const action = pieces[0].match(actionSuffix)?.[0] ?? "";
  if (!action) return UNKNOWN_AUTO_NAME + number;
  const qualifier = pieces.slice(1).join("・");
  const suffix = qualifier ? "・" + qualifier : "";
  const target = completeTarget(pieces[0].slice(0, -action.length), cap - length(action + suffix + number));
  return target ? target + action + suffix + number : UNKNOWN_AUTO_NAME + number;
}
export type NamingProject = string | ProjectRegistration;
function matchedProjects(evidence: AutoNameEvidence, projects: readonly NamingProject[]): Array<{ label: string; identity: string; title: string }> {
  let cwd = evidence.cwd;
  try { const value: unknown = JSON.parse(evidence.binding); if (Array.isArray(value) && typeof value[4] === "string") cwd = value[4]; } catch { /* standalone evidence */ }
  const path = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").normalize("NFKC").toLocaleLowerCase();
  const current = path(cwd), segments = current.split("/").filter(Boolean);
  const matches = projects.flatMap(project => {
    if (typeof project === "string") {
      const index = segments.lastIndexOf(path(project));
      return index >= 0 ? [{ label: project, identity: (current.startsWith("/") ? "/" : "") + segments.slice(0, index + 1).join("/"), title: project, depth: index + 1, part: 0 }] : [];
    }
    const root = path(project.path);
    if (!root || !(current === root || current.startsWith(root + "/"))) return [];
    const depth = root.split("/").filter(Boolean).length;
    const labels = project.label.split("/").map(value => value.trim()).filter(Boolean);
    return labels.map((label, part) => ({ label, identity: root, title: labels.join("の"), depth, part }));
  });
  // Prefer the nearest registered folder and its leaf label. A long shared
  // parent must not erase the only distinguishing subject (e.g. mathematics).
  matches.sort((a, b) => b.depth - a.depth || b.part - a.part || b.label.length - a.label.length);
  const seen = new Set<string>();
  return matches.filter(match => {
    if (seen.has(match.label)) return false;
    seen.add(match.label); return true;
  });
}
function topicFor(target: string, action: string): string {
  return shortAutomaticName(target + action);
}
export function deriveAutoName(evidence: AutoNameEvidence, projectNames: readonly NamingProject[] = []): AutoNameMeaning {
  const unknown: AutoNameMeaning = { target: "", action: "", topic: "", fullName: UNKNOWN_AUTO_NAME,
    shortCandidates: [UNKNOWN_AUTO_NAME], evidenceRefs: evidence.evidenceRefs, strength: "unknown",
    binding: evidence.binding, contentKey: evidence.contentKey, meaningKey: "unknown", fresh: false,
    source: "none", instructionDisposition: "followup", rejectedTasks: [], instructionContext: evidence.replyOnly ? "control" : undefined };
  let chosen: NamingTask | undefined; let source: AutoNameMeaning["source"] = "none";
  if (evidence.instructionHistoryComplete === false) { unknown.instructionDisposition = "replacement"; return unknown; }
  const latest = evidence.instructions[0];
  const mark = evidence.latestInput;
  if (evidence.replyOnly || (mark && (!mark.complete || mark.kind === "answer" || mark.kind === "ack" || mark.choice || !latest))) return unknown;
  if (latest) {
    if (evidence.instructionCompleteness?.[0] === false) { unknown.instructionDisposition = "replacement"; return unknown; }
    const first = interpretNamingText(latest);
    unknown.instructionContext = evidence.replyOnly || first.disposition === "continuation" || first.disposition === "status" ? "control" : "direct";
    unknown.rejectedTasks = first.rejected;
    unknown.instructionDisposition = first.disposition;
    if (first.ambiguous) return unknown;
    if (first.chosen) { chosen = first.chosen; source = "instruction"; }
    else return unknown;
  }
  if (!chosen && !mark && evidence.activity[0] && evidence.activityCompleteness?.[0] !== false) {
    const activity = interpretNamingText(evidence.activity[0]);
    if (activity.chosen && !activity.ambiguous && !activity.rejected.length) { chosen = activity.chosen; source = "activity"; }
  }
  if (!chosen) return unknown;
  let { target, action } = chosen;
  const projects = matchedProjects(evidence, projectNames);
  const nearest = projects[0], qualifier = nearest?.label;
  for (const { label: project } of projects) {
    if (target.startsWith(project + " ") || target.startsWith(project + "の")) {
      target = target.slice(project.length).replace(/^[ の]+/, ""); break;
    }
  }
  if (unsafe.test(target) || !balancedPhrase(target) || !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(target)) return unknown;
  const fullTarget = completeTarget(target, 44 - length(action)); if (!fullTarget) return unknown;
  const fullName = fullTarget + action;
  const parts = targetParts(target);
  const variants = [fullName];
  if (parts.length > 1) variants.push(parts[parts.length - 1] + action + "・" + parts.slice(0, -1).join("の"));
  variants.push(parts[parts.length - 1] + action);
  variants.push(action + "・" + target);
  const shortCandidates = [...new Set(variants.map(name => shortAutomaticName(name)))].filter(n => !unsafe.test(n) && length(n) <= 20).slice(0, 4);
  if (!shortCandidates.length || shortCandidates[0] === UNKNOWN_AUTO_NAME) return unknown;
  return { target, qualifier, projectIdentity: nearest?.identity, projectTitle: nearest?.title, action, topic: topicFor(target, action), fullName, shortCandidates, evidenceRefs: evidence.evidenceRefs,
    strength: source === "instruction" ? "strong" : "weak", source, instructionDisposition: unknown.instructionDisposition, rejectedTasks: unknown.rejectedTasks, binding: evidence.binding, contentKey: evidence.contentKey,
    instructionContext: unknown.instructionContext, instructionIndex: unknown.instructionIndex,
    meaningKey: normalize(target + "|" + action + "|" + (nearest?.identity ?? "")), fresh: unknown.instructionContext !== "control" && !evidence.replyOnly };
}
function numberedName(meaning: AutoNameMeaning, value: number, base = meaning.fullName): string {
  const suffix = "・" + value;
  return shortAutomaticName(base, 48 - length(suffix)) + suffix;
}
export interface NamingRow { id: string; meaning: AutoNameMeaning; tab: PaneTab; presentation?: string }
export function resolveNameSiblings(rows: NamingRow[]): Map<string, string> {
  const result = new Map<string, string>(), used = new Set<string>();
  const prefixes = new Map<string, Set<string>>();
  const reserve = (name: string, owner: string) => {
    used.add(normalize(name));
    const prefix = namePrefix(name), owners = prefixes.get(prefix) ?? new Set<string>();
    owners.add(owner); prefixes.set(prefix, owners);
  };
  const automatic = rows.filter(row => isAutomaticNameTarget(row.tab));
  for (const row of rows.filter(row => !isAutomaticNameTarget(row.tab))) {
    reserve(row.presentation ?? preferredTabName(row.tab) ?? "", "protected:" + row.id);
  }
  // Reserve this presentation family before arranging known jobs. Its counters
  // are an explicit unknown-display exception, not a claimed semantic match.
  if (automatic.length) {
    const prefix = namePrefix(UNKNOWN_AUTO_NAME), owners = prefixes.get(prefix) ?? new Set<string>();
    owners.add("unknown"); prefixes.set(prefix, owners);
  }
  const counts = new Map<string, number>(), contexts = new Map<string, Set<string>>();
  const qualifierContexts = new Map<string, Set<string>>(), titleContexts = new Map<string, Set<string>>();
  const baseKey = (meaning: AutoNameMeaning) => normalize(meaning.target + "|" + meaning.action);
  for (const { meaning } of automatic) {
    if (meaning.strength !== "unknown") counts.set(meaning.meaningKey, (counts.get(meaning.meaningKey) ?? 0) + 1);
    const qualifiers = contexts.get(baseKey(meaning)) ?? new Set<string>();
    const identity = meaning.projectIdentity ?? meaning.qualifier ?? "";
    qualifiers.add(identity); contexts.set(baseKey(meaning), qualifiers);
    for (const [map, title] of [[qualifierContexts, meaning.qualifier], [titleContexts, meaning.projectTitle ?? meaning.qualifier]] as const) {
      const key = baseKey(meaning) + "|" + (title ?? ""), identities = map.get(key) ?? new Set<string>();
      identities.add(identity); map.set(key, identities);
    }
  }
  const grounded = (row: NamingRow): string[] => {
    const m = row.meaning;
    const needsContext = (contexts.get(baseKey(m))?.size ?? 0) > 1;
    const repeatedLeaf = (qualifierContexts.get(baseKey(m) + "|" + (m.qualifier ?? ""))?.size ?? 0) > 1;
    const q = repeatedLeaf ? m.projectTitle : m.qualifier;
    // If registered presentation labels are also identical, no label proves
    // which project this job belongs to. Use the explicit unknown fallback.
    if (needsContext && (!q || (titleContexts.get(baseKey(m) + "|" + q)?.size ?? 0) > 1)) return [];
    const qualified = q ? [m.fullName + "・" + q, m.action + "・" + q + "の" + m.target] : [];
    return [...new Set([...(needsContext ? qualified : []), ...(!needsContext || !q ? [m.fullName, ...m.shortCandidates] : []),
      ...qualified, ...(!needsContext ? [m.action + "・" + m.target] : [])])]
      .filter(name => length(name) <= 48 && !unsafe.test(name) && shortAutomaticName(name) !== UNKNOWN_AUTO_NAME);
  };
  const validPrevious = (row: NamingRow) => {
    const name = row.tab.displayName; if (!name || row.tab.displayNameSource !== "auto") return false;
    const number = name.match(/・([1-9]\d*)$/)?.[1];
    return grounded(row).some(base => name === base || (!!number && name === numberedName(row.meaning, Number(number), base)));
  };
  const available = (name: string, meaning: AutoNameMeaning, identical: boolean) => {
    const visible = shortAutomaticName(name), owners = prefixes.get(namePrefix(visible));
    return !used.has(normalize(visible)) && (!owners || (identical && [...owners].every(owner => owner === meaning.meaningKey)));
  };
  const unknownRows = automatic.filter(row => row.meaning.strength === "unknown");
  const ordered = automatic.filter(row => row.meaning.strength !== "unknown")
    .sort((a, b) => Number(validPrevious(b)) - Number(validPrevious(a)) || a.id.localeCompare(b.id));
  for (const row of ordered) {
    const m = row.meaning;
    const previous = validPrevious(row) ? row.tab.displayName : undefined;
    const previousNumber = previous?.match(/・([1-9]\d*)$/)?.[1];
    const identical = (counts.get(m.meaningKey) ?? 0) > 1 || !!previousNumber;
    const bases = grounded(row);
    let name: string | undefined;
    if (identical) {
      if (previousNumber && previous && available(previous, m, true)) name = previous;
      for (const base of bases) {
        if (name) break;
        let number = previousNumber ? Number(previousNumber) : 1;
        while (used.has(normalize(shortAutomaticName(numberedName(m, number, base))))) number++;
        const candidate = numberedName(m, number, base);
        if (available(candidate, m, true)) name = candidate;
      }
    } else name = [...(previous ? [previous] : []), ...bases].find(candidate => available(candidate, m, false));
    if (!name) { unknownRows.push(row); continue; }
    result.set(row.id, name); reserve(shortAutomaticName(name), m.meaningKey);
  }
  const previousUnknown = (row: NamingRow) => row.tab.displayNameSource === "auto"
    && new RegExp("^" + UNKNOWN_AUTO_NAME + "(?:・[1-9]\\d*)?$").test(row.tab.displayName ?? "") ? row.tab.displayName : undefined;
  // Existing reservations precede newly added IDs, including when a known
  // task has exhausted its arrangements and needs an unknown presentation.
  unknownRows.sort((a, b) => Number(!!previousUnknown(b)) - Number(!!previousUnknown(a)) || a.id.localeCompare(b.id));
  for (const row of unknownRows) {
    const previous = previousUnknown(row);
    let name = previous && !used.has(normalize(previous)) ? previous : undefined;
    if (!name && automatic.length === 1 && !used.has(normalize(UNKNOWN_AUTO_NAME))) name = UNKNOWN_AUTO_NAME;
    if (!name) {
      let number = 1;
      while (used.has(normalize(UNKNOWN_AUTO_NAME + "・" + number))) number++;
      name = UNKNOWN_AUTO_NAME + "・" + number;
    }
    result.set(row.id, name); reserve(name, "unknown");
  }
  return result;
}

/** Clock-driven stability is independent of how often output/polls wake the scheduler. */
export function createAutoNamePolicy(now: () => number = Date.now, projectNames: () => readonly NamingProject[] = () => [], hold?: (tab: PaneTab, meaning: AutoNameMeaning) => boolean, presentation?: (tab: PaneTab) => string) {
  const accepted = new Map<string, AutoNameMeaning>();
  // One scalar input watermark per owner; no task body or prior positive meaning.
  const inputWatermarks = new Map<string, NonNullable<AutoNameEvidence["latestInput"]>>();
  const pending = new Map<string, { key: string; meaning: AutoNameMeaning; since: number; observed: number; count: number; readyAt: number }>();
  const committedAt = new Map<string, number>();
  const derived = new Map<string, { key: string; meaning: AutoNameMeaning }>();
  const identify = (scan: GroupingScan): PaneIdentityResult => {
    const inputs = (scan as Partial<AutoNameScan>).naming;
    const alive = new Set(scan.tabs.map(t => t.id));
    const present = new Set(scan.workspaces.flatMap(w => w.panes.flatMap(p => p.tabs.map(t => t.id))));
    for (const id of pending.keys()) if (!alive.has(id)) pending.delete(id);
    for (const [id, meaning] of accepted) if (!alive.has(id)) accepted.set(id, { ...meaning, fresh: false });
    for (const id of accepted.keys()) if (!present.has(id)) { accepted.delete(id); inputWatermarks.delete(id); pending.delete(id); committedAt.delete(id); derived.delete(id); }
    const projects = projectNames();
    const projectKey = JSON.stringify(projects);
    for (const tab of scan.tabs) {
      const candidate = inputs?.get(tab.id);
      const evidence = candidate?.binding === namingBinding(tab) ? candidate : buildAutoNameEvidence(tab);
      const deriveKey = evidence.contentKey + projectKey;
      const cached = derived.get(tab.id);
      let next = cached?.key === deriveKey ? { ...cached.meaning, evidenceRefs: evidence.evidenceRefs } : deriveAutoName(evidence, projects);
      if (cached?.key !== deriveKey) derived.set(tab.id, { key: deriveKey, meaning: next });
      next = { ...next, instructionPosition: evidence.instructionPositions?.[next.instructionIndex ?? 0] };
      const prior = accepted.get(tab.id);
      if (prior?.binding !== next.binding) { accepted.delete(tab.id); inputWatermarks.delete(tab.id); pending.delete(tab.id); committedAt.delete(tab.id); }
      const current = accepted.get(tab.id);
      const mark = evidence.latestInput, watermark = inputWatermarks.get(tab.id);
      const older = mark && watermark && (mark.sourceByteStart < watermark.sourceByteStart
        || (mark.sourceByteStart === watermark.sourceByteStart && (mark.order < watermark.order || mark.eventId !== watermark.eventId)));
      if ((older && next.strength === "strong") || (!mark && watermark && next.strength === "weak")) {
        next = deriveAutoName({ ...evidence, instructionHistoryComplete: false }, projects);
      }
      if (mark && !older) inputWatermarks.set(tab.id, { ...mark });
      if (current && current.meaningKey !== next.meaningKey) {
        const stamp = now(); const p = pending.get(tab.id);
        const wait = next.strength === "strong" || next.strength === "unknown" ? 10_000 : 60_000;
        if (!p || p.key !== next.meaningKey) pending.set(tab.id, { key: next.meaningKey, meaning: next, since: stamp, observed: stamp, count: 1,
          readyAt: Math.max(stamp + wait, wait < 60_000 ? 0 : (committedAt.get(tab.id) ?? 0) + 120_000) });
        const candidate = pending.get(tab.id)!;
        if (stamp - candidate.observed >= 30_000) { candidate.count++; candidate.observed = stamp; }
        const ready = stamp - candidate.since >= wait && (wait < 60_000 || candidate.count >= 2)
          && (next.strength === "strong" || next.strength === "unknown" || stamp - (committedAt.get(tab.id) ?? 0) >= 120_000);
        if (!ready) next = current;
        else { pending.delete(tab.id); committedAt.set(tab.id, stamp); }
      } else {
        pending.delete(tab.id);
        if (!current) committedAt.set(tab.id, now());
      }
      accepted.set(tab.id, next);
    }
    const tabs: PaneIdentityResult["tabs"] = new Map();
    for (const workspace of scan.workspaces) {
      const rows: NamingRow[] = workspace.panes.flatMap(p => p.tabs).map(tab => ({ id: tab.id, tab, presentation: presentation?.(tab), meaning: accepted.get(tab.id) ?? {
        target: "", action: "", topic: "", fullName: UNKNOWN_AUTO_NAME, shortCandidates: [], evidenceRefs: [],
        strength: "unknown", binding: "", contentKey: "", meaningKey: "unknown", fresh: false,
      } }));
      const names = resolveNameSiblings(rows.map(row => hold?.(row.tab, row.meaning) ? { ...row, tab: { ...row.tab, label: row.tab.displayName ?? row.tab.label, labelSource: "user" as const } } : row));
      for (const row of rows) if (alive.has(row.id)) tabs.set(row.id, { project: null, projectReason: null,
        subject: row.meaning.target || null, subjectReason: row.meaning.strength === "unknown" ? null : "task_title", displayName: names.get(row.id) ?? null });
    }
    return { tabs, homes: new Map(), homeScores: new Map() };
  };
  return { identify, meanings: () => accepted,
    reset(ids: readonly string[]) {
      for (const id of ids) { accepted.delete(id); inputWatermarks.delete(id); pending.delete(id); committedAt.delete(id); derived.delete(id); }
    },
    nextCheckMs: () => pending.size ? Math.max(1, Math.min(...[...pending.values()].map(p => p.readyAt)) - now()) : undefined };
}
