/**
 * What the launcher pane lists, and how a query narrows it.
 *
 * Kept apart from the component so the two things that actually decide whether
 * the pane is usable — the display name a 240px column can hold, and what a
 * typed query matches — are testable without a DOM.
 *
 * The launch rows come from `AGENT_CATALOG`; this file adds only what the
 * catalog has no reason to carry: a short chip label and which mark to draw.
 */
import Fuse from "fuse.js";
import type { IFuseOptions } from "fuse.js";
import { AGENT_CATALOG, type AgentCatalogEntry } from "../../lib/agentCatalog";
import type { LauncherDirEntry, LauncherDirsView } from "../../lib/ipc";

export interface LauncherLaunchItem {
  kind: "agent" | "web";
  /** `MYCMUX_LAUNCH_TARGET` for agents; the web preset id for web rows. */
  target: string;
  /** The catalog's own row label. Queries match this, and it is the tooltip. */
  label: string;
  /** What the chip shows at 240px, where the full label does not fit. */
  short: string;
  /** The `kind` AgentKindIcon dispatches on. */
  iconKind: string;
}

export interface LauncherDirItem extends LauncherDirEntry {
  kind: "dir";
  mark?: string;
  exists: boolean;
}

/**
 * A session Ctrl+P could reopen, shown here as a shortcut to the few most
 * recent ones. The fields are flattened out of `CrsmSessionEntry` so search and
 * rendering treat every row the same way.
 */
export interface LauncherResumeItem {
  kind: "resume";
  /** CRSM session id, handed to the launcher as MYCMUX_SESSION_ID. */
  id: string;
  /** Which CLI to resume with — MYCMUX_RESUME. */
  agentKind: "claude" | "codex" | "claude-codex" | "grok";
  /** CRSM's own one-line name for the session. */
  label: string;
  /** First words of the conversation; the second line of the row. */
  preview: string;
  /** Working directory the session was in, restored on resume. */
  path: string;
  when: string;
  iconKind: string;
}

export type LauncherItem = LauncherLaunchItem | LauncherDirItem | LauncherResumeItem;

export type SpecRow = "model" | "effort" | "launch";

export function specRowsFor(entry: { models: readonly unknown[]; efforts: readonly string[] }): SpecRow[] {
  // Model is always present, either as chips or as a free-text input.
  return entry.efforts.length > 0 ? ["model", "effort", "launch"] : ["model", "launch"];
}

export function moveSpecRow(rows: readonly SpecRow[], current: SpecRow, step: 1 | -1): SpecRow {
  const index = Math.max(0, rows.indexOf(current));
  return rows[Math.max(0, Math.min(rows.length - 1, index + step))] ?? current;
}

export function cycleChoice(current: string, choices: readonly string[], step: 1 | -1): string {
  const values = ["", ...choices];
  const index = Math.max(0, values.indexOf(current));
  return values[(index + step + values.length) % values.length];
}

/**
 * Chip labels for the rows whose catalog name overflows 240px. Everything else
 * falls back to the catalog label with a trailing " (Web)" removed — the Web
 * section heading already says it.
 */
const SHORT_LABELS: Record<string, string> = {
  "claude-codex": "claude-codex",
  "claude-codex-open": "cc (Open)",
  agy: "agy",
  grok: "Grok",
};

/**
 * Which mark a row gets. The web rows borrow the CLI marks where the vendor is
 * the same; Antigravity keeps its own, so `web-gemini` gets the Gemini spark
 * rather than the arch.
 */
const ICON_KINDS: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  "claude-codex": "claude-codex",
  "claude-codex-open": "claude-codex",
  grok: "grok",
  agy: "antigravity",
  "web-chatgpt": "codex",
  "web-gemini": "gemini",
  "web-grok": "grok",
  "web-claude": "claude",
  "web-notebooklm": "notebooklm",
  "web-browser": "browser",
};

export function shortLabel(entry: AgentCatalogEntry): string {
  return SHORT_LABELS[entry.target] ?? entry.label.replace(/\s*\(Web\)$/, "");
}

export function launchItems(): LauncherLaunchItem[] {
  return AGENT_CATALOG.map((entry) => ({
    kind: entry.kind,
    target: entry.target,
    label: entry.label,
    short: shortLabel(entry),
    iconKind: ICON_KINDS[entry.target] ?? entry.agentKind ?? "",
  }));
}

export function dirMark(item: Pick<LauncherDirEntry, "source" | "signal" | "seen_at">): string | undefined {
  if (item.source === "manual" || !item.signal || !item.seen_at || !/^\d{4}-\d{2}-\d{2}$/.test(item.seen_at)) return undefined;
  const date = item.seen_at.slice(5).replace("-", "/");
  const dot = item.signal === "mention" || item.signal === "session" ? "\u25cf" : "";
  return `${dot}${date}`;
}

export function dirCandidateCount(view: LauncherDirsView | null): number {
  const scan = view?.doc.last_scan;
  if (!scan || typeof scan !== "object" || !("candidates" in scan)) return 0;
  return Array.isArray(scan.candidates) ? scan.candidates.length : 0;
}

export function dirSections(
  view: LauncherDirsView | null,
  hiddenIds: readonly string[] = [],
): Array<{ id: string; label: string; items: LauncherDirItem[] }> {
  if (!view) return [];
  const hidden = new Set(hiddenIds);
  const exists = new Map(view.entries_exist);
  return view.doc.sections.filter((section) => !hidden.has(section.id)).map((section) => {
    const entries = view.doc.entries.filter((entry) => entry.section === section.id);
    const manual = entries.filter((entry) => entry.source === "manual");
    const auto = entries.filter((entry) => entry.source === "auto").sort((a, b) =>
      (b.seen_at ?? "").localeCompare(a.seen_at ?? "") || b.added_at.localeCompare(a.added_at));
    return {
      id: section.id,
      label: section.label,
      items: [...manual, ...auto].map((entry) => ({
        ...entry, kind: "dir" as const, mark: dirMark(entry), exists: exists.get(entry.id) ?? true,
      })),
    };
  });
}

/**
 * Fuse with CrsmPalette's own options (threshold 0.35, ignoreLocation), so a
 * query that finds a thing in Ctrl+P finds it here too. Fuzzy is not
 * transliteration: `モモ` matches モモスタ, `momo` does not — the palette has
 * the same limit, which is the point of sharing the options.
 *
 * `label` is weighted above the chip label because S10 makes the catalog name
 * the thing a query is aimed at; the short label is searchable only so that
 * `cc` finds the row that shows `cc (Open)`.
 */
function fuseOptions<T>(): IFuseOptions<T> {
  return {
    threshold: 0.35,
    ignoreLocation: true,
    keys: [
      { name: "label", weight: 2 },
      { name: "short", weight: 1 },
      { name: "path", weight: 1 },
      // What a session is actually remembered by is its opening words, not the
      // generated label, so this carries real weight for resume rows.
      { name: "preview", weight: 1.5 },
    ],
  };
}

export function searchItems<T extends LauncherItem>(items: readonly T[], query: string): T[] {
  const trimmed = query.trim();
  if (!trimmed) return [...items];
  const fuse = new Fuse([...items], fuseOptions<T>());
  return fuse.search(trimmed).map((result) => result.item);
}

/**
 * The last couple of path segments — "モモスタ/数学" out of a Dropbox path
 * nobody reads in full. Used to name a resume row: CRSM's own `label` is the
 * opening prompt again, so putting it on both lines said the same thing twice.
 */
/**
 * Trim a CRSM preview down to something a 240px line can say.
 *
 * The raw value is the whole opening turn: a "user:" prefix on every row, the
 * harness's own `<local-command-caveat>` block when the session began with a
 * slash command, and hundreds of characters of spec after that. None of it
 * helps someone recognise the session, and Fuse scans every character of it.
 */
export function previewLine(raw: string, max = 120): string {
  return raw
    .replace(/^\s*(user|assistant)\s*:\s*/i, "")
    .replace(/<\/?[a-z][a-z0-9-]{0,40}>/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function tailPath(path: string, segments = 2): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-segments).join("/");
}

/**
 * Middle ellipsis: `駿台/モモスタ/数学` is identified by its tail, so cutting
 * the end would make two rows indistinguishable (S6).
 */
export function middleEllipsis(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  if (max <= 1) return "\u2026";
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${chars.slice(0, head).join("")}\u2026${tail > 0 ? chars.slice(chars.length - tail).join("") : ""}`;
}
