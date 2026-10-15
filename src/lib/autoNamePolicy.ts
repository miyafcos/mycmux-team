import type { PaneTab } from "../types";
import { NAMING_ACTION_WORDS, interpretNamingText, isNamingAck, isNamingContinuation, isNamingCancellation, isNamingNewContext, isNamingCorrection, isNamingTaskDirective, isNamingUncertainTask, type NamingTask } from "./autoNameLanguage";
import type { GroupingScan } from "../components/layout/tabGrouping";
import type { PaneIdentityResult, ProjectRegistration } from "./paneIdentity";
import { isAutomaticNameTarget, preferredTabName } from "./autoNameOwnership";
export { isAutomaticNameTarget } from "./autoNameOwnership";
import { buildAutoNameEvidence, namingBinding, type NamingInputSource, type AutoNameEvidence, type AutoNameScan } from "./autoNameMaterial";

import type { AutoNameReason } from "./autoNameStatus";
import { sha256Hex } from "./persistentLayoutProjection";

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
/** A complete stop remains a stop when followed by a separate reference or note. */
function cancelsPreviousTask(text: string): boolean {
  if (isNamingCancellation(text)) return true;
  if (/[?\uFF1F]/u.test(text)) return false;
  for (const boundary of text.matchAll(/\s+/gu)) {
    if (boundary.index > 80) break;
    if (isNamingCancellation(text.slice(0, boundary.index))) return true;
  }
  return false;
}
const prefixCache = new Map<string, string>();
export const namePrefix = (text: string) => {
  const key = normalize(text); const found = prefixCache.get(key); if (found !== undefined) return found;
  const prefix = nameGraphemes(key).slice(0, 4).join("");
  if (key.length <= 256) { if (prefixCache.size >= 2048) prefixCache.clear(); prefixCache.set(key, prefix); }
  return prefix;
};
const unsafe = /[\x00-\x1f\x7f\ufffd\ud800-\udfff]|・\s*・|…|(?:claude|codex)-\d+|\b\d{6,8}[-_]/u;
export interface AutoNameMeaning {
  invalidatesPrevious?: boolean;
  unknownReason?: AutoNameReason; staleSince?: number; recordOwner?: string;
  target: string; qualifier?: string; projectIdentity?: string; projectTitle?: string; action: string; topic: string; fullName: string; shortCandidates: string[];
  evidenceRefs: string[]; strength: "strong" | "weak" | "unknown"; binding: string;
  contentKey: string; meaningKey: string; fresh: boolean;
  /** "title" and "label" are shown as written: the agent's own session title, or the launch label. */
  source?: "instruction" | "activity" | "file" | "heading" | "none" | "title" | "label" | "prompt";
  instructionDisposition?: "none" | "status" | "followup" | "continuation" | "rejection" | "replacement";
  rejectedTasks?: Array<{ target: string; action: string }>;
  instructionContext?: "direct" | "control";
  instructionIndex?: number; instructionPosition?: number; instructionSource?: NamingInputSource; instructionKey?: string;
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
    unknownReason: "no-record", recordOwner: evidence.recordOwner,
    source: "none", instructionDisposition: "followup", rejectedTasks: [], instructionContext: evidence.replyOnly ? "control" : undefined };
  let chosen: NamingTask | undefined; let source: AutoNameMeaning["source"] = "none";
  const latest = evidence.instructions[0];
  const mark = evidence.latestInput;
  if (latest && evidence.instructionCompleteness?.[0] !== false && (cancelsPreviousTask(latest) || isNamingNewContext(latest) || isNamingCorrection(latest)))
    unknown.invalidatesPrevious = true;
  const fail = (reason: AutoNameReason) => ({ ...unknown, unknownReason: reason });
  if (evidence.materialStatus === "unreadable") return fail("read-failed");
  if (evidence.materialStatus === "incomplete") return fail("history-incomplete");
  if (evidence.materialStatus === "unverified") return fail("record-unverified");
  if (evidence.materialStatus === "contended") return fail("record-contended");
  if (evidence.materialStatus === "waiting" && !latest && !evidence.activity[0]) return fail("waiting");
  if ((latest && (isNamingAck(latest) || isNamingContinuation(latest))) || evidence.replyOnly || (mark && (mark.kind === "answer" || mark.kind === "ack" || mark.choice))) {
    // An explicit rejection inside a reply invalidates a retained name too.
    const reply = latest && interpretNamingText(latest);
    if (reply && (reply.disposition === "rejection" || reply.disposition === "replacement")) unknown.instructionDisposition = reply.disposition;
    unknown.instructionContext = "control";
    return fail("reply");
  }
  if (latest && evidence.instructionCompleteness?.[0] !== false) {
    const parsed = interpretNamingText(latest);
    if (parsed.disposition === "rejection" || parsed.rejected.length) {
      unknown.instructionDisposition = parsed.disposition; unknown.rejectedTasks = parsed.rejected;
    }
  }
  if (mark && !mark.complete) return fail("instruction-truncated");
  if (evidence.instructionHistoryComplete === false && evidence.materialStatus !== "missing")
    return fail(evidence.instructionLoss ? "instruction-truncated" : "history-incomplete");
  if (latest) {
    if (evidence.instructionCompleteness?.[0] === false) return fail("instruction-truncated");
    const first = interpretNamingText(latest);
    unknown.instructionContext = evidence.replyOnly || first.disposition === "continuation" || first.disposition === "status" ? "control" : "direct";
    unknown.rejectedTasks = first.rejected;
    unknown.instructionDisposition = first.disposition;
    if (first.ambiguous) return fail(first.disposition === "continuation" || first.disposition === "status" ? "reply" : "instruction-unclear");
    if (first.chosen) { chosen = first.chosen; source = "instruction"; }
    else return fail(first.disposition === "continuation" || first.disposition === "status" ? "reply" : "instruction-unclear");
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
  if (unsafe.test(target) || !balancedPhrase(target) || !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(target)) return fail("unsafe-name");
  const fullTarget = completeTarget(target, 44 - length(action)); if (!fullTarget) return fail("name-too-long");
  const fullName = fullTarget + action;
  const parts = targetParts(target);
  const variants = [fullName];
  if (parts.length > 1) variants.push(parts[parts.length - 1] + action + "・" + parts.slice(0, -1).join("の"));
  variants.push(parts[parts.length - 1] + action);
  variants.push(action + "・" + target);
  const shortCandidates = [...new Set(variants.map(name => shortAutomaticName(name)))].filter(n => !unsafe.test(n) && length(n) <= 20).slice(0, 4);
  if (!shortCandidates.length || shortCandidates[0] === UNKNOWN_AUTO_NAME) return fail("name-too-long");
  return { target, qualifier, projectIdentity: nearest?.identity, projectTitle: nearest?.title, action, topic: topicFor(target, action), fullName, shortCandidates, evidenceRefs: evidence.evidenceRefs,
    recordOwner: evidence.recordOwner, strength: source === "instruction" ? "strong" : "weak", source, instructionDisposition: unknown.instructionDisposition, rejectedTasks: unknown.rejectedTasks, binding: evidence.binding, contentKey: evidence.contentKey,
    instructionContext: unknown.instructionContext, instructionIndex: unknown.instructionIndex,
    meaningKey: normalize(target + "|" + action + "|" + (nearest?.identity ?? "")), fresh: unknown.instructionContext !== "control" && !evidence.replyOnly };
}
// Presented names (2026-10-14). The rules above only name a direct, single
// clause instruction, and real requests (long, colloquial, pasted mail,
// English hand-offs, "進捗の確認") almost never are one, so most tabs fell to
// UNKNOWN_AUTO_NAME. A tab now takes, in order: the agent's session title
// (Claude's custom or AI title), the rule-derived name, its launch label, and
// only then the unknown name. A raw launch label stays behind a rule name
// because labels like "bokan clockshift 3009" read as abstract (2026-10-09).
// The displayed name is cut to 20 graphemes by shortAutomaticName, which turns
// anything without a task suffix into UNKNOWN_AUTO_NAME, so a presented name is
// built to fit, a sibling number included.
export const PRESENTED_NAME_CAP = 20;
const presentationUnsafe = /[\x00-\x1f\x7f\ufffd\ud800-\udfff]/u;
const presentedNumbered = (base: string, number: number) => fitPresentedName(base, PRESENTED_NAME_CAP - nameGraphemes("・" + number).length) + "・" + number;
export const isPresentedMeaning = (meaning: AutoNameMeaning): boolean => meaning.source === "title" || meaning.source === "label" || meaning.source === "heading";
/** Shorten at a space, ・ or word boundary in the latter half; never append an ellipsis. */
export function fitPresentedName(text: string, cap: number): string {
  const graphemes = nameGraphemes(text);
  if (graphemes.length <= cap) return text;
  const floor = Math.ceil(cap / 2);
  let end = -1;
  for (let index = cap; index >= floor; index--) if (/^[\s・、,|｜/／]$/u.test(graphemes[index] ?? "")) { end = index; break; }
  if (end < 0 && wordSegmenter) {
    // Prefer the last cut after a particle ("…スライドの修正と|再提出") so the name ends on a
    // whole phrase; the trailing particle is dropped below.
    let at = 0, afterParticle = -1;
    for (const { segment } of wordSegmenter.segment(text)) {
      const next = at + nameGraphemes(segment).length;
      if (next > cap) break;
      at = next;
      if (at >= floor && /^[のとをがにでへや]$/u.test(segment)) afterParticle = at;
    }
    if (afterParticle >= floor) end = afterParticle;
    else if (at >= floor) end = at;
  }
  let cut = graphemes.slice(0, end < 0 ? cap : end).join("");
  // A cut must not leave a bracket open ("例題② (10") or end on a joiner ("hikarist-video-").
  const opener = Math.max(cut.lastIndexOf("("), cut.lastIndexOf("（"), cut.lastIndexOf("「"), cut.lastIndexOf("["));
  if (opener > 0 && !/[)）」\]]/u.test(cut.slice(opener))) cut = cut.slice(0, opener);
  cut = cut.replace(/[\s・、,|｜/／\-_–—:：のをがにとはでへや]+$/u, "").trim();
  return cut || graphemes.slice(0, cap).join("");
}
/** Drop a leading copy of a hand-given workspace name ("ひかりスタ 数学" + "ひかりスタ数学 定積分…"). */
export function stripWorkspacePrefix(name: string, workspaceName: string | undefined): string {
  const head = (workspaceName ?? "").normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase();
  if (nameGraphemes(head).length < 2) return name;
  let matched = 0, cut = -1, offset = 0;
  for (const grapheme of nameGraphemes(name)) {
    offset += grapheme.length;
    if (/^\s+$/u.test(grapheme)) continue;
    const piece = grapheme.normalize("NFKC").toLocaleLowerCase();
    if (!head.startsWith(piece, matched)) return name;
    matched += piece.length;
    if (matched >= head.length) { cut = offset; break; }
  }
  if (cut < 0) return name;
  // Only at a word edge: a space or separator, or katakana / Latin running into kanji or
  // kana ("ひかりスタ数学"). Never inside a word ("ひかりスタンド", "北斗学院", "2027年度", "v2.1").
  const kind = (grapheme: string) => /\p{Script=Han}/u.test(grapheme) ? "han" : /\p{Script=Hiragana}/u.test(grapheme) ? "hira"
    : /[\p{Script=Katakana}ー]/u.test(grapheme) ? "kata" : /[A-Za-z]/.test(grapheme) ? "latin" : "other";
  const last = nameGraphemes(name.slice(0, cut)).pop() ?? "", next = nameGraphemes(name.slice(cut))[0] ?? "";
  const separated = /^[\s・:：\-–—|｜/／、,]$/u.test(next);
  const shifted = (kind(last) === "kata" || kind(last) === "latin") && (kind(next) === "han" || kind(next) === "hira");
  if (!separated && !shifted) return name;
  const rest = name.slice(cut).replace(/^[\s・:：\-–—|｜/／、,]+/u, "");
  return nameGraphemes(rest).length >= 4 && !/^[のをがにとはでへもや]/u.test(rest) && !/^[\p{P}\p{S}]/u.test(rest) ? rest : name;
}
export interface PresentedNameTab {
  sessionTitle?: string | null; label?: string; labelSource?: PaneTab["labelSource"];
}
export function presentedAutoName(tab: PresentedNameTab, workspace: { name: string; nameSource?: "auto" } | undefined,
  evidence: Pick<AutoNameEvidence, "binding" | "contentKey" | "evidenceRefs">, ruleNamed = false): AutoNameMeaning | undefined {
  const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
  const title = clean(tab.sessionTitle);
  // A spawn date prefix ("261014-…") says nothing about the job. A label that
  // carries an internal ID (an agent counter, a hash, a UUID) is not a launch name.
  const dated = clean(tab.label).replace(/^\d{6,8}[-_]+/, "");
  const label = /^(?:claude|codex|grok|claude-codex|shell|agent)[-_]?\d+$/i.test(dated)
    || /(?:^|[^A-Za-z])(?:claude|codex|grok|shell|agent)[-_]?\d{3,}|\b[0-9a-f]{8,}\b|\b\d{6,8}[-_]/i.test(dated) ? "" : dated;
  const labelUsable = !ruleNamed && !!label && isAutomaticNameTarget({ label, labelSource: tab.labelSource });
  const [source, raw] = title && !presentationUnsafe.test(title) ? ["title", title] as const
    : labelUsable && !presentationUnsafe.test(label) ? ["label", label] as const : [undefined, ""] as const;
  if (!source) return undefined;
  const stripped = workspace && workspace.nameSource !== "auto" ? stripWorkspacePrefix(raw, workspace.name) : raw;
  const fullName = fitPresentedName(stripped, PRESENTED_NAME_CAP);
  if (!fullName || fullName.startsWith(UNKNOWN_AUTO_NAME)) return undefined;
  return { target: fullName, action: "", topic: fitPresentedName(fullName, 20), fullName, shortCandidates: [fullName],
    evidenceRefs: evidence.evidenceRefs, strength: "strong", source, binding: evidence.binding, contentKey: evidence.contentKey,
    meaningKey: normalize(source + "|" + fullName), fresh: true };
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
  // Titles and launch labels are shown as written. Only an exact repeat is
  // numbered; the four-grapheme prefix rule below is for generated task names
  // (titles often share a project word and would otherwise fall to unknown).
  const presented = automatic.filter(row => isPresentedMeaning(row.meaning));
  const presentedCounts = new Map<string, number>();
  for (const { meaning } of presented) presentedCounts.set(normalize(meaning.fullName), (presentedCounts.get(normalize(meaning.fullName)) ?? 0) + 1);
  const previousPresented = (row: NamingRow) => {
    const name = row.tab.displayName, number = name?.match(/・([1-9]\d*)$/)?.[1];
    return row.tab.displayNameSource === "auto" && number && name === presentedNumbered(row.meaning.fullName, Number(number)) ? Number(number) : undefined;
  };
  for (const row of [...presented].sort((a, b) => Number(previousPresented(b) !== undefined) - Number(previousPresented(a) !== undefined) || a.id.localeCompare(b.id))) {
    const base = row.meaning.fullName;
    let name = base;
    if ((presentedCounts.get(normalize(base)) ?? 0) > 1 || used.has(normalize(base))) {
      let number = previousPresented(row) ?? 1;
      if (used.has(normalize(presentedNumbered(base, number)))) number = 1;
      while (used.has(normalize(presentedNumbered(base, number)))) number++;
      name = presentedNumbered(base, number);
    }
    result.set(row.id, name); used.add(normalize(name));
  }
  const ruled = automatic.filter(row => !isPresentedMeaning(row.meaning));
  // Reserve this presentation family before arranging known jobs. Its counters
  // are an explicit unknown-display exception, not a claimed semantic match.
  if (ruled.length) {
    const prefix = namePrefix(UNKNOWN_AUTO_NAME), owners = prefixes.get(prefix) ?? new Set<string>();
    owners.add("unknown"); prefixes.set(prefix, owners);
  }
  const counts = new Map<string, number>(), contexts = new Map<string, Set<string>>();
  const qualifierContexts = new Map<string, Set<string>>(), titleContexts = new Map<string, Set<string>>();
  const baseKey = (meaning: AutoNameMeaning) => normalize(meaning.target + "|" + meaning.action);
  for (const { meaning } of ruled) {
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
  const unknownRows = ruled.filter(row => row.meaning.strength === "unknown");
  const ordered = ruled.filter(row => row.meaning.strength !== "unknown")
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
  for (const row of unknownRows) result.set(row.id, UNKNOWN_AUTO_NAME);
  return result;
}

export const LAST_CONCRETE_NAME_MS = 30 * 60_000;

/** Clock-driven stability is independent of how often output/polls wake the scheduler. */
export function createAutoNamePolicy(now: () => number = Date.now, projectNames: () => readonly NamingProject[] = () => [], hold?: (tab: PaneTab, meaning: AutoNameMeaning) => boolean, presentation?: (tab: PaneTab) => string) {
  const accepted = new Map<string, AutoNameMeaning>();
  const concrete = new Map<string, { meaning: AutoNameMeaning; at: number }>();
  // One scalar input watermark per owner; prior concrete names are bounded below.
  const inputWatermarks = new Map<string, NonNullable<AutoNameEvidence["latestInput"]>>();
  const invalidations = new Map<string, {source:NamingInputSource; blocksFallback:boolean}>();
  // Material clocks outlive display changes to a launch label or unknown name.
  type SourceClock = { at: number; staleSince?: number; source?: NamingInputSource };
  const sourceClocks = new Map<string, Map<string, SourceClock>>();
  const sourceAt = (evidence: AutoNameEvidence, index: number): NamingInputSource | undefined => evidence.instructionSources?.[index]
    ?? (evidence.instructionPositions?.[index] === undefined ? undefined : {event_id:evidence.evidenceRefs[index] ?? "input-" + evidence.instructionPositions[index],
      source_revision:0, source_byte_start:evidence.instructionPositions[index]!});
  const sameSource = (a: NamingInputSource, b: NamingInputSource) => a.source_byte_start === b.source_byte_start
    && a.event_id === b.event_id && a.source_revision === b.source_revision;
  const instructionKey = (evidence: AutoNameEvidence, source: NamingInputSource | undefined) => {
    const index = source && evidence.instructionSources?.findIndex(value => value?.event_id === source.event_id
      && value.source_byte_start === source.source_byte_start);
    const text = index !== undefined && index >= 0 ? evidence.instructions[index] : evidence.initialInstruction ?? "";
    return sha256Hex(normalize(text));
  };
  const confirmationKey = (meaning: AutoNameMeaning) => JSON.stringify([meaning.binding, meaning.recordOwner,
    meaning.instructionSource ? [meaning.instructionSource.event_id, meaning.instructionSource.source_byte_start, meaning.instructionKey]
      : [meaning.source, meaning.meaningKey, meaning.instructionPosition]]);
  const pending = new Map<string, { key: string; meaning: AutoNameMeaning; since: number; observed: number; count: number; readyAt: number }>();
  const committedAt = new Map<string, number>();
  const derived = new Map<string, { key: string; meaning: AutoNameMeaning }>();
  const identify = (scan: GroupingScan): PaneIdentityResult => {
    const inputs = (scan as Partial<AutoNameScan>).naming;
    const alive = new Set(scan.tabs.map(t => t.id));
    const present = new Set(scan.workspaces.flatMap(w => w.panes.flatMap(p => p.tabs.map(t => t.id))));
    for (const id of pending.keys()) if (!alive.has(id)) pending.delete(id);
    for (const [id, meaning] of accepted) if (!alive.has(id)) accepted.set(id, { ...meaning, fresh: false });
    for (const id of accepted.keys()) if (!present.has(id)) { accepted.delete(id); inputWatermarks.delete(id); pending.delete(id); committedAt.delete(id); derived.delete(id); concrete.delete(id); invalidations.delete(id); sourceClocks.delete(id); }
    const projects = projectNames();
    const projectKey = JSON.stringify(projects);
    for (const tab of scan.tabs) {
      const candidate = inputs?.get(tab.id);
      const evidence = candidate?.binding === namingBinding(tab) ? candidate : buildAutoNameEvidence(tab);
      const deriveKey = evidence.contentKey + projectKey;
      const cached = derived.get(tab.id);
      let next = cached?.key === deriveKey ? { ...cached.meaning, evidenceRefs: evidence.evidenceRefs } : deriveAutoName(evidence, projects);
      if (cached?.key !== deriveKey) derived.set(tab.id, { key: deriveKey, meaning: next });
      const inputSource = sourceAt(evidence, next.instructionIndex ?? 0);
      next = { ...next, instructionPosition: inputSource?.source_byte_start, instructionSource:inputSource, instructionKey:instructionKey(evidence, inputSource) };
      const prior = accepted.get(tab.id);
      if (prior?.binding !== next.binding || (prior?.recordOwner && next.recordOwner && prior.recordOwner !== next.recordOwner)) { accepted.delete(tab.id); inputWatermarks.delete(tab.id); pending.delete(tab.id); committedAt.delete(tab.id); concrete.delete(tab.id); invalidations.delete(tab.id); sourceClocks.delete(tab.id); }
      const current = accepted.get(tab.id);
      const mark = evidence.latestInput, watermark = inputWatermarks.get(tab.id);
      const older = mark && watermark && (mark.sourceByteStart < watermark.sourceByteStart
        || (mark.sourceByteStart === watermark.sourceByteStart && (mark.order < watermark.order || mark.eventId !== watermark.eventId)));
      if ((older && next.strength === "strong") || (!mark && watermark && next.strength === "weak")) {
        next = deriveAutoName({ ...evidence, instructionHistoryComplete: false }, projects);
      }
      if (mark && !older) inputWatermarks.set(tab.id, { ...mark });
      const workspace = scan.workspaces.find(w => w.id === tab.workspaceId);
      // A bounded history still carries stops/changes even when its newest input is a reply.
      for (let index = 0; index < evidence.instructions.length; index++) {
        if (evidence.instructionCompleteness?.[index] === false) continue;
        const text = evidence.instructions[index], parsed = interpretNamingText(text), source = sourceAt(evidence, index);
        const control = cancelsPreviousTask(text) || isNamingNewContext(text) || isNamingCorrection(text)
          || parsed.disposition === "rejection" || parsed.rejected.length > 0 || isNamingUncertainTask(text);
        const directive = evidence.instructionKinds?.[index] !== "answer" && evidence.instructionKinds?.[index] !== "ack"
          && isNamingTaskDirective(text);
        if (!source || (!control && !directive)) continue;
        const prior = invalidations.get(tab.id);
        if (!prior || source.source_byte_start >= prior.source.source_byte_start)
          invalidations.set(tab.id, {source, blocksFallback:control});
      }
      const barrier = invalidations.get(tab.id);
      // Earlier sources are already barred. Keep the same event's clock across
      // transcript revision changes; revision alone is not a new user input.
      if (barrier) for (const [key, clock] of sourceClocks.get(tab.id) ?? []) {
        if (clock.source && (clock.source.source_byte_start < barrier.source.source_byte_start
          || clock.source.source_byte_start === barrier.source.source_byte_start && clock.source.event_id !== barrier.source.event_id))
          sourceClocks.get(tab.id)!.delete(key);
      }
      const applies = (source: NamingInputSource | undefined) => !!source && (!barrier
        || source.source_byte_start > barrier.source.source_byte_start || sameSource(source, barrier.source));
      const allowsInitial = (source: NamingInputSource | undefined) => applies(source)
        && !(barrier?.blocksFallback && sameSource(source!, barrier.source));
      const last = concrete.get(tab.id);
      const interveningChange = !!last?.meaning.instructionSource && !applies(last.meaning.instructionSource);
      const contextLost = next.unknownReason && (["reply", "read-failed", "history-incomplete", "instruction-truncated", "waiting", "no-record"].includes(next.unknownReason)
        || next.unknownReason === "instruction-unclear" && !isNamingTaskDirective(evidence.instructions[0] ?? "")
          && !isNamingUncertainTask(evidence.instructions[0] ?? ""));
      const invalidated = next.invalidatesPrevious || interveningChange || next.instructionDisposition === "rejection"
        || (next.instructionDisposition === "replacement" && !!next.rejectedTasks?.length);
      if (invalidated || (next.strength !== "unknown" && current && next.meaningKey !== current.meaningKey)
        || (next.strength === "unknown" && !contextLost)) concrete.delete(tab.id);
      // Keep the v0.88.1 title priority, followed by a current directive and the launch label.
      const presentedName = presentedAutoName(tab, workspace, evidence, next.strength !== "unknown");
      if (presentedName?.source === "title") next = presentedName;
      else if (next.strength === "unknown" && last && (last.meaning.source !== "label" || !presentedName)
        && contextLost && !invalidated && now() - last.at < LAST_CONCRETE_NAME_MS) {
        next = { ...last.meaning, contentKey:next.contentKey, evidenceRefs:next.evidenceRefs, fresh:false,
          unknownReason:next.unknownReason,
          staleSince:sourceClocks.get(tab.id)?.get(confirmationKey(last.meaning))?.staleSince ?? current?.staleSince ?? now(),
          instructionDisposition:next.instructionDisposition };
      } else if (next.strength === "unknown") {
        const unknown = next;
        const decorate = (meaning: AutoNameMeaning, source: NamingInputSource): AutoNameMeaning | undefined => {
          const previousInput = (!mark && !!watermark) || !!mark && (mark.sourceByteStart > source.source_byte_start
            || mark.sourceByteStart === source.source_byte_start && mark.eventId !== source.event_id);
          const value = { ...meaning, instructionPosition:source.source_byte_start, instructionSource:source,
            instructionKey:instructionKey(evidence, source), recordOwner:evidence.recordOwner };
          const clock = sourceClocks.get(tab.id)?.get(confirmationKey(value));
          if (previousInput && clock && now() - clock.at >= LAST_CONCRETE_NAME_MS) return undefined;
          return previousInput ? {...value, fresh:false, unknownReason:unknown.unknownReason,
            staleSince:clock?.staleSince ?? current?.staleSince ?? now()} : value;
        };
        // Later controls do not affirm a newly observed task. Drop an invalidated source
        // and let a future direct request or the launch label establish its replacement.
        const latestText = normalize(evidence.instructions[0] ?? ""), initialText = normalize(evidence.initialInstruction ?? "");
        const initialMatches = !!latestText && !!initialText && (initialText.startsWith(latestText) || latestText.startsWith(initialText));
        const verified = evidence.materialStatus === "ready" && !!evidence.recordOwner && !older;
        const knownContext = evidence.contextHistoryComplete || (initialMatches && mark?.complete !== false);
        const heading = verified && knownContext && evidence.taskTitleExplicit && allowsInitial(evidence.taskTitleInput)
          && evidence.taskTitleSource === "spec" && evidence.taskTitleComplete !== false
          ? presentedAutoName({sessionTitle:evidence.taskTitle}, workspace, evidence) : undefined;
        const initial = verified && knownContext && allowsInitial(evidence.initialInstructionSource) && evidence.initialInstructionComplete && evidence.initialInstruction
          ? deriveAutoName({...evidence, instructions:[evidence.initialInstruction], instructionCompleteness:[true],
            latestInput:undefined, replyOnly:false, instructionHistoryComplete:true}, projects) : undefined;
        if (heading) next = decorate({...heading, source:"heading"}, evidence.taskTitleInput!) ?? unknown;
        else if (initial && initial.strength !== "unknown") next = decorate({...initial, source:"prompt"}, evidence.initialInstructionSource!) ?? unknown;
        if (next.strength === "unknown" && presentedName) next = presentedName;
        else if (next.strength === "unknown" && tab.labelSource === "launch" && tab.label && next.unknownReason === "no-record")
          next = {...next, unknownReason:"launch-label-unusable"};
      }
      next = { ...next, recordOwner: evidence.recordOwner ?? next.recordOwner };
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
      if (next.strength !== "unknown" && next !== current) {
        const key = confirmationKey(next), clocks = sourceClocks.get(tab.id) ?? new Map<string, SourceClock>();
        // Keep only the current clock for names without a material reference.
        // Referenced source clocks remain until an input barrier invalidates them.
        if (!next.instructionSource) for (const [priorKey, clock] of clocks)
          if (!clock.source && priorKey !== key) clocks.delete(priorKey);
        const clock: SourceClock = clocks.get(key) ?? {at:now(), source:next.instructionSource};
        if (next.staleSince !== undefined) clock.staleSince ??= next.staleSince;
        clocks.set(key, clock); sourceClocks.set(tab.id, clocks);
        // Re-reading an unchanged source never extends its confirmation time.
        if (next.staleSince === undefined) concrete.set(tab.id, {meaning:next, at:clock.at});
      }
    }
    const tabs: PaneIdentityResult["tabs"] = new Map();
    for (const workspace of scan.workspaces) {
      const rows: NamingRow[] = workspace.panes.flatMap(p => p.tabs).map(tab => ({ id: tab.id, tab, presentation: presentation?.(tab), meaning: accepted.get(tab.id) ?? {
        target: "", action: "", topic: "", fullName: UNKNOWN_AUTO_NAME, shortCandidates: [], evidenceRefs: [],
        strength: "unknown", binding: "", contentKey: "", meaningKey: "unknown", fresh: false,
      } }));
      const names = resolveNameSiblings(rows.map(row => hold?.(row.tab, row.meaning) ? { ...row, tab: { ...row.tab, label: row.tab.displayName ?? row.tab.label, labelSource: "user" as const } } : row));
      for (const row of rows) if (names.get(row.id) === UNKNOWN_AUTO_NAME && row.meaning.strength !== "unknown") {
        accepted.set(row.id, { ...row.meaning, strength: "unknown", unknownReason: "name-conflict", fresh: false, staleSince: undefined });
        concrete.delete(row.id);
      }
      for (const row of rows) if (alive.has(row.id)) tabs.set(row.id, { project: null, projectReason: null,
        subject: row.meaning.target || null, displayName: names.get(row.id) ?? null,
        subjectReason: row.meaning.strength === "unknown" ? null : row.meaning.source === "title" ? "session_title" : row.meaning.source === "label" ? "readable_label" : "task_title" });
    }
    return { tabs, homes: new Map(), homeScores: new Map() };
  };
  return { identify, meanings: () => accepted,
    reset(ids: readonly string[]) {
      for (const id of ids) { accepted.delete(id); inputWatermarks.delete(id); pending.delete(id); committedAt.delete(id); derived.delete(id); concrete.delete(id); invalidations.delete(id); sourceClocks.delete(id); }
    },
    nextCheckMs: () => {
      const deadlines = [...pending.values()].map(p => p.readyAt);
      for (const [id, meaning] of accepted) if (meaning.staleSince !== undefined) {
        const at = sourceClocks.get(id)?.get(confirmationKey(meaning))?.at ?? concrete.get(id)?.at;
        if (at !== undefined && at + LAST_CONCRETE_NAME_MS > now()) deadlines.push(at + LAST_CONCRETE_NAME_MS);
      }
      return deadlines.length ? Math.max(1, Math.min(...deadlines) - now()) : undefined;
    } };
}
