/** Pure evidence-based identities; no IPC, randomness, or clock. */
export interface ProjectRegistration { section: string; label: string; path: string }
export interface IdentityWorkspace { id: string; name: string }
export interface PaneEvidence {
  id: string; workspaceId: string; label?: string | null; labelSource?: string | null;
  cwd: string; agentKind?: string; parentTabId?: string;
  sessionTitle?: string | null; taskTitle?: string | null;
}
export type ProjectReason = "folder_registry" | "folder_words" | "task_title" | "session_title" | "lineage" | "alias" | "workspace_name" | null;
export type SubjectReason = "user_label" | "readable_label" | "folder_child" | "task_title" | "session_title" | "folder_remainder" | "tool_label" | null;
export interface PaneProject { key: string; display: string; short: string }
interface Entry extends PaneProject { paths: string[]; tokens: string[]; identity: string[]; facets: string[] }
export interface PaneIdentity {
  project: PaneProject | null; projectReason: ProjectReason;
  subject: string | null; subjectReason: SubjectReason; displayName: string | null;
}
export interface PaneIdentityInput { registry: readonly ProjectRegistration[]; workspaces: readonly IdentityWorkspace[]; tabs: readonly PaneEvidence[] }
export interface PaneIdentityResult { tabs: Map<string, PaneIdentity>; homes: Map<string, string>; homeScores: Map<string, number> }
const normPath = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const segments = (s: string) => s.replace(/\\/g, "/").split("/").filter(Boolean);
const stripNumber = (s: string) => s.replace(/^\d{1,3}_/, "");
export const normalizeIdentityText = (s: string) => s.normalize("NFKC").replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60)).toLowerCase();
export function clipIdentityName(text: string, limit = 20): string {
  const cleaned = text.replace(/\s*[（(][^)）]*[)）]?\s*$/, "").trim() || text;
  const chars = [...cleaned];
  return chars.length <= limit ? cleaned : chars.slice(0, limit - 1).join("") + "…";
}
export const isToolIdentifier = (tab: Pick<PaneEvidence, "label" | "labelSource">) =>
  tab.labelSource !== "user" && /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+$/.test(tab.label ?? "");
const meaningfulIdentityToken = (token: string) => !/^\d+$/.test(normalizeIdentityText(token));
const stop = new Set("make send gate fix review bokan dev test wt master main sol astra luna claude codex site hero the and".split(" "));
const UNNAMED_SEGMENTS = new Set(["資料", "標準版"]);
const kana = Object.fromEntries(
  ["アイウエオ", "カキクケコ", "サシスセソ", "タチツテト", "ナニヌネノ", "ハヒフヘホ",
    "マミムメモ", "ヤユヨ", "ラリルレロ", "ワヲン", "ガギグゲゴ", "ザジズゼゾ",
    "ダヂヅデド", "バビブベボ", "パピプペポ", "ヴ"].flatMap((row, i) =>
    [...row].map((c, j) => [c, [
      "a i u e o", "ka ki ku ke ko", "sa shi su se so", "ta chi tsu te to", "na ni nu ne no",
      "ha hi fu he ho", "ma mi mu me mo", "ya yu yo", "ra ri ru re ro", "wa o n",
      "ga gi gu ge go", "za ji zu ze zo", "da ji zu de do", "ba bi bu be bo", "pa pi pu pe po", "vu",
    ][i].split(" ")[j]])),
);
const small: Record<string, string> = { ャ: "ya", ュ: "yu", ョ: "yo", ァ: "a", ィ: "i", ゥ: "u", ェ: "e", ォ: "o" };
export function identityRomaji(token: string): string | null {
  const k = normalizeIdentityText(token);
  if (!k || !/^[ァ-ー]+$/.test(k)) return null;
  let out = "";
  [...k].forEach((c, i) => {
    if (c === "ー") return;
    if (c === "ッ") { out += (kana[k[i + 1]] ?? "").slice(0, 1); return; }
    if (small[c] && out) {
      if (out.endsWith("i")) out = out.slice(0, -1);
      out += /(?:sh|ch|j)$/.test(out) && small[c].startsWith("y") ? small[c].slice(1) : small[c];
      return;
    }
    out += kana[c] ?? "";
  });
  out = out.replace(/u/g, "");
  return out.length >= 5 ? out : null;
}
function registryEntries(registry: readonly ProjectRegistration[]): Entry[] {
  const merged = new Map<string, Entry>();
  for (const item of registry) {
    const label = item.label.replace(/\s*\(.*?\)\s*$/, "").trim();
    const parts = label.split("/").map(s => stripNumber(s.trim())).filter(Boolean);
    // ponytail: 資料 names storage and 標準版 a default edition, neither a client nor a product;
    // they stay in the registry shape (facets, weights) but never name the 案件.
    const meaningful = parts.filter(s => !UNNAMED_SEGMENTS.has(s));
    if (!meaningful.length) continue;
    const display = meaningful.slice(-2).join(" ");
    const found = merged.get(display);
    if (found) { if (!found.paths.includes(normPath(item.path))) found.paths.push(normPath(item.path)); continue; }
    merged.set(display, { key: label, display, short: "", paths: [normPath(item.path)], tokens: parts, identity: [], facets: [] });
  }
  const entries = [...merged.values()];
  const children = new Map<string, Set<string>>();
  const parents = new Map<string, Set<string>>();
  for (const e of entries) {
    if (e.tokens.length < 2) continue;
    const parent = e.tokens.slice(0, -1).join("/");
    const leaf = e.tokens[e.tokens.length - 1];
    children.set(parent, new Set([...(children.get(parent) ?? []), leaf]));
    const key = normalizeIdentityText(leaf);
    parents.set(key, new Set([...(parents.get(key) ?? []), parent]));
  }
  for (const e of entries) {
    const leaf = e.tokens[e.tokens.length - 1];
    const facet = e.tokens.length > 1 && ((children.get(e.tokens.slice(0, -1).join("/"))?.size ?? 0) >= 2 || (parents.get(normalizeIdentityText(leaf))?.size ?? 0) >= 2);
    e.facets = facet ? [leaf] : [];
    e.identity = e.tokens.filter(t => !e.facets.includes(t) && t !== "資料");
    // The short prefix follows the display name: "つばさ模試/標準版" is shown as "つばさ模試",
    // so its prefix must not be "標準版".
    e.short = [...e.identity].reverse().find(t => !UNNAMED_SEGMENTS.has(t)) ?? e.display;
  }
  return entries;
}
export function displayNameForWorkspace(identity: PaneIdentity, workspaceId: string, homes: ReadonlyMap<string, string>): string | null {
  if (identity.subject === null) return null;
  if (identity.subjectReason === "user_label" || identity.subjectReason === "readable_label") return identity.subject;
  const p = identity.project;
  const homed = [...homes].filter(([, id]) => id === workspaceId).map(([key]) => key);
  return clipIdentityName(p && !(homed.length === 1 && homed[0] === p.key) ? p.short + " " + identity.subject : identity.subject);
}
export function resolvePaneIdentities(input: PaneIdentityInput): PaneIdentityResult {
  const entries = registryEntries(input.registry);
  const df = new Map<string, number>();
  for (const e of entries) for (const t of new Set(e.tokens.map(normalizeIdentityText))) df.set(t, (df.get(t) ?? 0) + 1);
  const weights = new Map([...df].map(([t, n]) => [t, Math.log((entries.length + 1) / (n + 0.5))]));
  const weight = (t: string) => weights.get(normalizeIdentityText(t)) ?? 0;
  const romaji = new Map(entries.flatMap(e => e.identity).map(t => [t, identityRomaji(t)]));
  const score = (text: string, e: Entry) => {
    const normalized = normalizeIdentityText(text);
    const ascii = text.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/u/g, "");
    const ident = e.identity.reduce((n, t) => n + ((t.length >= 2 && meaningfulIdentityToken(t) && normalized.includes(normalizeIdentityText(t))) || (romaji.get(t) && ascii.includes(romaji.get(t)!)) ? weight(t) : 0), 0);
    return ident <= 0 ? 0 : ident + 0.5 * e.facets.reduce((n, t) => n + (meaningfulIdentityToken(t) && normalized.includes(normalizeIdentityText(t)) ? weight(t) : 0), 0);
  };
  const best = (text: string) => {
    const ranked = entries.map(e => ({ e, s: score(text, e) })).sort((a, b) => b.s - a.s);
    return ranked[0]?.s >= 2 && (!ranked[1] || Math.abs(ranked[0].s - ranked[1].s) >= 1e-9) ? ranked[0].e : null;
  };
  const homes = new Map<string, string>(); const homeScores = new Map<string, number>();
  for (const e of entries) {
    const ranked = input.workspaces.map(w => {
      const name = normalizeIdentityText(w.name);
      const part = (tokens: string[]) => tokens.reduce((sum, t) => {
        if (!meaningfulIdentityToken(t)) return sum;
        const k = normalizeIdentityText(t);
        for (let n = k.length; n >= 2; n--) if (name.includes(k.slice(0, n))) return sum + weight(t) * n / k.length;
        return sum;
      }, 0);
      const ident = part(e.identity);
      return { id: w.id, s: ident > 0 ? ident + 0.5 * part(e.facets) : 0 };
    }).sort((a, b) => b.s - a.s);
    if (ranked[0]?.s >= 1.5 && (!ranked[1] || ranked[0].s > ranked[1].s)) {
      homes.set(e.key, ranked[0].id); homeScores.set(e.key, ranked[0].s);
    }
  }
  const resolved = new Map<string, { e: Entry | null; reason: ProjectReason; path?: string }>();
  for (const tab of input.tabs) {
    const cwd = normPath(tab.cwd); let hit: Entry | null = null; let path = "";
    for (const e of entries) for (const p of e.paths) if (p && (cwd === p || cwd.startsWith(p + "/")) && p.length > path.length) { hit = e; path = p; }
    let reason: ProjectReason = hit ? "folder_registry" : null;
    if (!hit) {
      const parts = segments(tab.cwd); const users = parts.findIndex(s => s.toLowerCase() === "users");
      const folderText = parts.filter((s, i) => !/^[a-z]:$/i.test(s) && s.toLowerCase() !== "users" && !(users >= 0 && i === users + 1)).join(" ");
      for (const [text, why] of [[folderText, "folder_words"], [tab.taskTitle, "task_title"], [tab.sessionTitle, "session_title"]] as const) {
        if (text && (hit = best(text))) { reason = why; break; }
      }
    }
    resolved.set(tab.id, { e: hit, reason, path: path || undefined });
  }
  // Cyclic edges cannot create evidence; updates use snapshots to avoid traversal-order decisions.
  const byId = new Map(input.tabs.map(t => [t.id, t]));
  const validParent = (tab: PaneEvidence) => {
    const visited = new Set([tab.id]); let id = tab.parentTabId;
    while (id && byId.has(id)) { if (visited.has(id)) return undefined; visited.add(id); id = byId.get(id)?.parentTabId; }
    return tab.parentTabId && byId.has(tab.parentTabId) ? tab.parentTabId : undefined;
  };
  const parents = new Map(input.tabs.map(t => [t.id, validParent(t)]));
  const children = new Map<string, string[]>();
  for (const [id, parent] of parents) if (parent) children.set(parent, [...(children.get(parent) ?? []), id]);
  for (let round = 0; round < input.tabs.length; round++) {
    const updates: Array<[string, Entry]> = [];
    for (const tab of input.tabs) {
      if (resolved.get(tab.id)!.e) continue;
      const parent = resolved.get(parents.get(tab.id) ?? "")?.e;
      const childEntries = (children.get(tab.id) ?? []).map(id => resolved.get(id)!.e);
      const known = childEntries.filter((e): e is Entry => !!e);
      const inherited = parent ?? (known.length > 0 && known.length === childEntries.length && new Set(known.map(e => e.key)).size === 1 ? known[0] : null);
      if (inherited) updates.push([tab.id, inherited]);
    }
    if (!updates.length) break;
    for (const [id, e] of updates) resolved.set(id, { e, reason: "lineage" });
  }
  const aliasCounts = new Map<string, Map<string, number>>();
  for (const tab of input.tabs) {
    const e = resolved.get(tab.id)!.e;
    if (!e || !isToolIdentifier(tab)) continue;
    for (const token of new Set((tab.label ?? "").toLowerCase().split(/[-_]/))) {
      if (!/^[a-z]{4,}$/.test(token) || stop.has(token)) continue;
      const counts = aliasCounts.get(token) ?? new Map<string, number>();
      counts.set(e.key, (counts.get(e.key) ?? 0) + 1); aliasCounts.set(token, counts);
    }
  }
  const aliases = new Map([...aliasCounts].flatMap(([t, counts]) => counts.size === 1 && [...counts.values()][0] >= 3 ? [[t, [...counts.keys()][0]]] : []));
  for (const tab of input.tabs) {
    if (resolved.get(tab.id)!.e) continue;
    const keys = [...new Set(normalizeIdentityText((tab.label ?? "") + " " + (tab.sessionTitle ?? "")).split(/[-_\s]/).flatMap(t => aliases.has(t) ? [aliases.get(t)!] : []))];
    if (keys.length === 1) resolved.set(tab.id, { e: entries.find(e => e.key === keys[0])!, reason: "alias" });
  }
  for (const tab of input.tabs) {
    if (resolved.get(tab.id)!.e) continue;
    const homed = entries.filter(e => homes.get(e.key) === tab.workspaceId);
    const text = normalizeIdentityText((tab.sessionTitle ?? "") + " " + (tab.taskTitle ?? ""));
    if (homed.length === 1 && homed[0].tokens.some(t => t.length >= 2 && meaningfulIdentityToken(t) && text.includes(normalizeIdentityText(t)))) resolved.set(tab.id, { e: homed[0], reason: "workspace_name" });
  }
  const stripTokens = (text: string, e: Entry | null) => {
    let out = text;
    if (e) for (const token of [...e.tokens].sort((a, b) => b.length - a.length)) out = out.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
    return out.replace(/\s+[—\-–]\s+/g, " ").trim()
      .replace(/^[のをとでに、・]+/, "").replace(/\s+/g, " ").trim();
  };
  type Candidate = { text: string; reason: SubjectReason };
  const candidates = new Map<string, Candidate[]>(); const firsts = new Map<string, Map<string, number>>();
  const group = (tab: PaneEvidence) => resolved.get(tab.id)!.e?.key ?? "ws:" + tab.workspaceId;
  for (const tab of input.tabs) {
    const { e, reason, path } = resolved.get(tab.id)!; const list: Candidate[] = [];
    const add = (text: string | null | undefined, why: SubjectReason) => { if (text) list.push({ text: clipIdentityName(text), reason: why }); };
    if (tab.label && tab.labelSource === "user") add(tab.label, "user_label");
    else if (tab.label && tab.labelSource !== "ai" && !isToolIdentifier(tab)) add(tab.label, "readable_label");
    else {
      let remainder: string | null = null; let deeper = false;
      if (e) {
        const parts = segments(tab.cwd); const hidden = parts.findIndex(s => s.startsWith("_") || s.startsWith("."));
        const cut = hidden < 0 ? parts.length : hidden; let rest: string[] = [];
        if (reason === "folder_registry" && path) { rest = parts.slice(segments(path).length, cut); deeper = true; }
        else {
          const idx = parts.findIndex(s => score(s, e) > 0);
          if (idx >= 0) {
            rest = parts.slice(idx + 1, cut); deeper = true;
            if (!rest.length) { rest = [stripTokens(parts[idx], e)]; deeper = false; }
          }
        }
        remainder = rest.flatMap(s => stripNumber(s).split(/[_\s]+/)).filter(w => w && !/^(?:\d{6}|\d{8}|\d{4}-\d{2}-\d{2})$/.test(w)).join(" ") || null;
      }
      if (deeper) add(remainder, "folder_child");
      if (tab.taskTitle) add(stripTokens(tab.taskTitle, e) || tab.taskTitle, "task_title");
      if (tab.sessionTitle) add(reason === "workspace_name" ? tab.sessionTitle : stripTokens(tab.sessionTitle, e) || tab.sessionTitle, "session_title");
      if (!deeper) add(remainder, "folder_remainder");
      if (isToolIdentifier(tab)) add(tab.label, "tool_label");
    }
    candidates.set(tab.id, list);
    if (list[0]) {
      const counts = firsts.get(group(tab)) ?? new Map<string, number>();
      counts.set(list[0].text, (counts.get(list[0].text) ?? 0) + 1); firsts.set(group(tab), counts);
    }
  }
  const tabs = new Map<string, PaneIdentity>();
  for (const tab of input.tabs) {
    const { e, reason } = resolved.get(tab.id)!; const list = candidates.get(tab.id)!; const first = list[0];
    const counts = firsts.get(group(tab));
    const chosen = first?.reason === "user_label" || first?.reason === "readable_label" ? first : list.find(c => (counts?.get(c.text) ?? 0) - Number(first?.text === c.text) === 0) ?? first;
    const identity: PaneIdentity = { project: e ? { key: e.key, display: e.display, short: e.short } : null, projectReason: reason,
      subject: chosen?.text ?? null, subjectReason: chosen?.reason ?? null, displayName: null };
    identity.displayName = displayNameForWorkspace(identity, tab.workspaceId, homes); tabs.set(tab.id, identity);
  }
  return { tabs, homes, homeScores };
}
