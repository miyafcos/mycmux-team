/** Shared bounded text interpretation for extraction and cache keys. */
export const NAMING_ACTION_WORDS = ["制作", "修正", "校正", "調整", "調査", "比較", "編集", "確認", "集計", "送付", "見積"] as const;
const actions: [RegExp, string][] = [
  [/(?:作って(?:いる|います)?|作りません|作ら(?:ない|なく|ず)|作り|作る|制作|作成)(?:して(?:いる|います)?|する|中)?/g, "制作"],
  [/(?:直して(?:いる|います)?|直しません|直さ(?:ない|なく|ず)|直す|直し|修正|改善)(?:して(?:いる|います)?|する|中)?/g, "修正"],
  [/(?:校正|推敲)(?:して(?:いる|います)?|する|中)?/g, "校正"],
  [/(?:調整|配置)(?:して(?:いる|います)?|する|中)?/g, "調整"],
  [/(?:調べ(?:て(?:いる|います)?|る|ない|なく|ず|ません)|調査)(?:して(?:いる|います)?|する|中)?/g, "調査"],
  [/(?:比較)(?:して(?:いる|います)?|する|中)?/g, "比較"],
  [/(?:編集)(?:して(?:いる|います)?|する|中)?/g, "編集"],
  [/(?:確認|検査|照合)(?:して(?:いる|います)?|する|中)?/g, "確認"],
  [/(?:集計|計算)(?:して(?:いる|います)?|する|中)?/g, "集計"],
  [/(?:アップロード|送付|納品)(?:して(?:いる|います)?|する|中)?/g, "送付"],
  [/(?:見積もり|見積り|見積)(?:して(?:いる|います)?|する|中)?/g, "見積"],
];
export interface NamingAction { index: number; end: number; action: string; rejected: boolean; affirmative: boolean }
export function namingActions(text: string): NamingAction[] {
  const result: NamingAction[] = [];
  for (const [pattern, action] of actions) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0, end = index + match[0].length;
      const suffix = text.slice(end);
      const rejected = /(?:ない|ません|なく|ず)$/.test(match[0])
        || /^な(?:$|[!！。\s])/.test(suffix)
        || /^\s*(?:(?:は|を)\s*)?(?:し(?:ない|ません|なく|たくない)|せず|するな|ないで|な(?:い|く)|ません|ず(?:に)?|不要|やめ)/.test(suffix);
      // A lexical verb match is not a predicate. Prove the entire remaining
      // phrase closes as a supported assertion/activity/request. Any unconsumed
      // modality (including an unfamiliar prohibition) is nonpositive.
      const affirmative = !rejected && /^(?:ください)?$/.test(suffix.trim());
      result.push({ index, end, action, rejected, affirmative });
    }
  }
  return result.sort((a, b) => a.index - b.index);
}
const ack = /^(?:了解(?:です|しました)?|承知(?:しました)?|ありがとう(?:ございます)?|はい|ok|okay)[！! .]*$/i;
export const isNamingCancellation = (text: string): boolean => !/[?？]/.test(text) && namingClauses(text).some(clause =>
  /^(?:(?:その|この)?(?:作業|依頼|タスク)(?:は|を)?\s*)?(?:中止|取り?消し|取消|取りやめ|やめ)(?:して|にして|て|する|です)?(?:ください|お願いします)?$/.test(clause.replace(/^追記[:：]\s*/, "")));
// An explicit context marker is control evidence independently of whether the
// following request uses a work verb that the naming parser understands.
const englishTaskPrefix = /^(?:(?:new|next|another|different)\s+(?:task|job|request)\s*[:\-]\s*|for\s+(?:the\s+)?(?:new|next)\s+(?:task|job|request)\s*[:,]\s*)/i;
export const isNamingNewContext = (text: string): boolean => namingClauses(text).some(clause =>
  englishTaskPrefix.test(clause) ||
  /^(?:次は|次に|今は|今回は|次の(?:仕事|作業|依頼)は|追加の仕事|(?:その|この)案件は別の仕事に切り替え)/.test(clause.replace(/^追記[:：]\s*/, "")));
export const isNamingCorrection = (text: string): boolean => clauses(text).corrected;
export const isNamingAck = (text: string): boolean => ack.test(text);
const correction = /(?:ではなく(?:て)?|じゃなく(?:て)?|でなく(?:て)?)/;
interface NamingClause { text: string; question: boolean }
function clauses(text: string): { clauses: NamingClause[]; corrected: boolean } {
  const data = text.normalize("NFKC")
    .replace(/^(?:\u88dc\u8db3|\u6761\u4ef6|\u8ffd\u52a0\u6761\u4ef6)\s*[:\uFF1A]\s*/gm, "")
    .replace(/<(?:system|developer|environment_context|instructions)>[\s\S]*?<\/(?:system|developer|environment_context|instructions)>/gi, "")
    .replace(/\x60\x60\x60[\s\S]*?\x60\x60\x60/g, "")
    .replace(/(?:引用|前回の指示|前の依頼|以前の依頼|旧題)\s*[:：]?\s*[「『][^」』]*[」』][^。\n]*[。\n]?/g, "");
  const corrected = correction.test(data);
  const tail = data.split(correction).pop() ?? "";
  // Keep the delimiter's modality; NFKC has already made !/? ASCII.
  const pieces = tail.split(/([。!?\n、；;])/);
  const result: NamingClause[] = [];
  for (let index = 0; index < pieces.length; index += 2) {
    const value = pieces[index].trim();
    if (value && !/^(?:>|#|\[|<)/.test(value) && !ack.test(value)) {
      result.push({ text: value, question: pieces[index + 1] === "?" || /か$/.test(value) });
    }
  }
  return { clauses: result, corrected };
}
export function namingClauses(text: string): string[] { return clauses(text).clauses.map(clause => clause.text); }
// Keep complete raw inputs for invalidation even when clause extraction skips
// Markdown/quotes. Parsing a name and replacing old work are separate decisions.
export function substantiveInstruction(text: string): string { return text.trim() ? text : ""; }
export const isNamingContinuation = (text: string): boolean => namingContextException(text) === "continuation";

export interface NamingTask { target: string; action: string }
export interface NamingTextMeaning {
  chosen?: NamingTask; rejected: NamingTask[]; ambiguous: boolean;
  disposition: "none" | "status" | "continuation" | "rejection" | "replacement";
}
function objectPhrase(text: string): string {
  return text.replace(/^.*?(?:による|における)\s*/, "").replace(/^\s*(?:依頼書|作業依頼|追加の依頼|追加依頼|お願い|まず|続いて|今回は|いまは|今は|次は|次に|それでは)(?:\s*\([^)]*\))?\s*[:：]?\s*/, "")
    .replace(/^[「『](.*)[」』]$/, "$1").replace(/(?:を|について|に対して|が|は|に|の)\s*$/, "")
    .replace(/\s+/g, " ").trim();
}
/** The same semantic representation governs extraction and cache equivalence. */
function interpretText(text: string): NamingTextMeaning {
  const exception = namingContextException(text);
  if (exception) return { rejected: [], ambiguous: false, disposition: exception === "status" ? "status" : "continuation" };
  const parsed = clauses(text);
  const result: NamingTextMeaning = { rejected: [], ambiguous: false, disposition: parsed.clauses.length ? "replacement" : "none" };
  for (const clause of parsed.clauses) {
    const matches = namingActions(clause.text), last = matches[matches.length - 1];
    if (!last) { result.ambiguous = true; continue; }
    let start = 0;
    const priorPredicates = matches.filter(match => match !== last && /(?:を|は|について|に対して)\s*$/.test(clause.text.slice(0, match.index)));
    if (priorPredicates.some(match => !match.rejected)) { result.ambiguous = true; continue; }
    const negatives = matches.filter(match => match.rejected && match !== last
      && /(?:を|は|について|に対して|の)\s*$/.test(clause.text.slice(0, match.index)));
    let unresolved = false;
    for (const negative of negatives) {
      const target = objectPhrase(clause.text.slice(start, negative.index));
      if (target) result.rejected.push({ target, action: negative.action });
      // Retain the previously supported explicit negative connective. Verb-like
      // substrings in object nouns never enter this branch.
      const bridge = clause.text.slice(negative.end).match(/^\s*(?:(?:は|を)\s*)?(?:し(?:ない|ません|なく|たくない)|せず|な(?:い|く)?|ません|ず)?(?:に|で|て(?:よい|いい)?|が)?\s*/)?.[0] ?? "";
      if (!/(?:に|で|て|が)$/.test(bridge.trim())) { unresolved = true; break; }
      start = negative.end + bridge.length;
    }
    if (unresolved) { result.ambiguous = true; continue; }
    let target = objectPhrase(clause.text.slice(start, last.index)), action = last.action;
    // An inline negative connective has no sentence delimiter to prove where
    // its modality stops. Accept only an entirely nominal remainder; never
    // treat leftover grammatical endings as part of the next object.
    if (negatives.length && !/^[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9ー ]+$/u.test(target)) { result.ambiguous = true; continue; }
    if (action === "制作" && /の見積(?:もり|り)?$/.test(target)) { target = target.replace(/の見積(?:もり|り)?$/, ""); action = "見積"; }
    if (!target || /^(?:作業|資料|実行|テスト|src|進捗|追加の依頼|段\s*[A-Z])$/.test(target)) { result.ambiguous = true; continue; }
    if (clause.question || !last.affirmative) { result.rejected.push({ target, action }); continue; }
    if (result.chosen && (result.chosen.action !== action || result.chosen.target !== target) && !target.includes(result.chosen.target)) result.ambiguous = true;
    result.chosen = { target, action };
  }
  if (result.chosen && result.rejected.some(task => task.action === result.chosen!.action && task.target === result.chosen!.target)) result.ambiguous = true;
  if (!result.chosen && result.rejected.length) result.disposition = "rejection";
  return result;
}
const interpretationCache = new Map<string, NamingTextMeaning>();
const copyMeaning = (meaning: NamingTextMeaning): NamingTextMeaning => ({ ...meaning,
  chosen: meaning.chosen && { ...meaning.chosen }, rejected: meaning.rejected.map(task => ({ ...task })) });
export function interpretNamingText(text: string): NamingTextMeaning {
  const cached = interpretationCache.get(text);
  if (cached) return copyMeaning(cached);
  const meaning = interpretText(text);
  if (text.length <= 256) {
    if (interpretationCache.size >= 2048) interpretationCache.clear();
    interpretationCache.set(text, copyMeaning(meaning));
  }
  return meaning;
}
export function namingTextKey(text: string): string { return JSON.stringify(interpretNamingText(text)); }

/** Inspect raw text before clause/quote filtering: links, brackets and Japanese
 * suffixes must not hide a new Markdown task file behind a continuation. */
function hasMarkdownTaskDirective(text: string): boolean {
  return /\.md(?=$|[^A-Za-z0-9_-])/i.test(text)
    && /\b(?:read|follow|use|load|pass|implement|execute|see)\b|\u8aad\u3080|\u8aad\u3093\u3067|\u6e21\u3059|\u6e21\u3057\u3066|\u4f7f\u3063\u3066|\u5b9f\u88c5|\u5b9f\u884c|\u5f93\u3063\u3066/i.test(text);
}

export type NamingContextException = "continuation" | "status" | "supplement" | "output" | "attribute";

/** The closed list: match a whole input, never an arbitrary tail. Attribute
 * subjects and values are intentionally narrow; unknown objects/work verbs
 * do not qualify. Keep positive/negative fixtures for every exception type. */
const contextExceptionRules = {
  continuation: [
    /^(?:続けて(?:ください)?|続き(?:を)?(?:お願い(?:します)?|進めて(?:ください)?)|そのまま続けて(?:ください)?|引き続きお願い(?:します)?|作業を続けて(?:ください)?|この依頼を継続してください)$/u,
    /^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:continue(?:\s+(?:the\s+)?(?:work|task))?(?:\s+with\s+the\s+same\s+task)?|keep\s+going|go\s+on|carry\s+on|proceed)$/i,
  ],
  status: [
    /^(?:(?:進捗|状況)(?:は)?(?:どう(?:ですか)?|いかがですか)?|(?:進捗|状況)を教えて(?:ください)?|いつ終わり(?:そうですか|ますか)|どうですか)$/u,
    /^(?:what(?:'s| is)\s+the\s+(?:current\s+)?status|(?:can|could)\s+you\s+(?:tell|show)\s+me\s+the\s+(?:current\s+)?status)$/i,
  ],
  attribute: [
    /^(?:(?:(?:修正)?対象|対象環境|OS)(?:は|:)\s*(?:Windows(?:\s*(?:10|11))?|macOS|Linux)\s*(?:です)?|(?:the\s+)?target\s+is\s+(?:Windows(?:\s*(?:10|11))?|macOS|Linux))$/i,
    /^(?:(?:日付の形式|日付形式)(?:は|:)\s*(?:YYYY\/MM\/DD|YYYY-MM-DD|ISO 8601)\s*(?:です)?|日付の形式はこれで(?:いい|よい)ですか)$/i,
  ],
  output: [
    /^(?:(?:日本語|英語|Markdown|JSON|CSV|箇条書き|テキスト)(?:だけ)?でお願い(?:します)?|(?:日本語|英語)でも構いません)$/i,
    /^(?:(?:can|could)\s+you\s+)?(?:please\s+)?(?:use|respond\s+in|reply\s+in|answer\s+in)\s+(?:Japanese|English|Markdown|JSON|CSV)$/i,
    /^(?:(?:please\s+)?use\s+(?:YYYY\/MM\/DD|YYYY-MM-DD|ISO 8601)\s+for\s+dates|(?:YYYY\/MM\/DD|YYYY-MM-DD|ISO 8601)\s*で統一してください|日付の形式を\s*(?:YYYY\/MM\/DD|YYYY-MM-DD|ISO 8601)\s*にしてください)$/i,
  ],
  supplement: /^(?:補足|追記|Note|FYI)\s*:\s*(.+)$/i,
  supplementValue: /^(?:(?:Windows(?:\s*(?:10|11))?|macOS|Linux)(?:\s+only|のみ)?|offline only|オフラインのみ)$/i,
  continuationAck: /^(?:了解(?:です|しました)?|承知しました|thanks|ok|okay)[,、。.!]\s*/i,
} as const;

export function namingContextException(text: string): NamingContextException | undefined {
  const raw = text.normalize("NFKC").replace(/\s+/g, " ").trim();
  // Raw Markdown directives win before any exception or clause/quote filtering.
  if (hasMarkdownTaskDirective(raw)) return undefined;
  const value = raw.replace(/[.!?。]+$/, "").trim();
  const matches = (kind: "continuation" | "status" | "attribute" | "output", input: string) => contextExceptionRules[kind].some(pattern => pattern.test(input));
  if (matches("continuation", value.replace(contextExceptionRules.continuationAck, ""))) return "continuation";
  if (matches("status", value)) return "status";
  const supplement = value.match(contextExceptionRules.supplement);
  if (supplement) {
    const body = supplement[1];
    return matches("attribute", body) || matches("output", body) || contextExceptionRules.supplementValue.test(body) ? "supplement" : undefined;
  }
  if (matches("output", value)) return "output";
  if (matches("attribute", value)) return "attribute";
  return undefined;
}

/** As in v0.88.1/c2dc, every complete non-answer input replaces older work by
 * default, even when no name can be parsed. Only the closed exceptions retain it. */
export function isNamingTaskDirective(text: string): boolean {
  return !!text.trim() && !isNamingAck(text) && namingContextException(text) === undefined;
}

/** Unresolved task predicates and non-status questions cannot affirm old work. */
export function isNamingUncertainTask(text: string): boolean {
  const parsed = interpretNamingText(text);
  if (parsed.disposition === "continuation" || parsed.disposition === "status") return false;
  if (parsed.chosen && !parsed.ambiguous && !parsed.rejected.length) return false;
  return clauses(text).clauses.some(clause => clause.question || namingActions(clause.text).some(action =>
    action.rejected || /(?:\u3092|\u306f|\u306b\u3064\u3044\u3066|\u306b\u5bfe\u3057\u3066)\s*$/.test(clause.text.slice(0, action.index))));
}
