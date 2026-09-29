export type AskOptionRole = "option" | "typeSomething" | "chatAbout" | "submit";

export type AskOption = {
  /** Displayed number, or null for rows that carry no number (the bare `Submit` row). */
  index: number | null;
  label: string;
  /** Wrapped continuation lines joined into one string, or undefined when absent. */
  description?: string;
  /** multiSelect only: state of the `[ ]` / `[✔]` box. */
  checked?: boolean;
  /** True for the row the `❯` cursor points at. */
  current: boolean;
  role: AskOptionRole;
};

export type AskTab = {
  label: string;
  /** The tab has been answered (`☒`) rather than pending (`☐`). */
  answered: boolean;
  /** The tab the screen is currently showing. */
  active: boolean;
};

export type AskScreen = {
  kind: "single" | "tabbed" | "review";
  multiSelect: boolean;
  /** Empty for `kind: "single"`. */
  tabs: AskTab[];
  header?: string;
  question: string;
  options: AskOption[];
};

const SEPARATOR_LINE = /^\u2500{4,}\s*$/; // Prompt box rules (U+2500).
const TAB_BAR_LINE = /^\s*(?:\u2190\s+)?(?:[\u2610\u2611\u2612]\s{2,})?.*\u2714\s+Submit\s+(?:\u2192|\u25b6)\s*$/;
const TAB_BAR_CANDIDATE = /^\s*(?:\u2190|[\u2610\u2611\u2612]).*(?:\u2192|\u25b6)\s*$/;
const TAB_BAR_INNER = /^\s*(?:\u2190\s+)?(?:[\u2610\u2611\u2612]\s{2,})?(.*?)\s+(?:\u2192|\u25b6)\s*$/;
const TAB_BAR_TOKEN = /([\u2610\u2611\u2612])\s+(.+?)(?=\s+[\u2610\u2611\u2612]\s+|\s+\u2714\s+Submit|$)|\u2714\s+Submit/g;
const SIMPLE_HEADER = /^\s*\u2610\s+(.+)$/; // Single-question title row, not a tab bar.
const CURSOR_PREFIX = /^\s*\u276F\s+/; // Heavy right-pointing angle (U+276F).
const STRIP_CURSOR = /^\s*(?:\u276F\s+)?/;
const NUMBERED_ROW = /^(\d+)\.\s+(?:(\[(?: |\u2714)\])\s+)?(.+)$/;
const NUMBERLESS_SUBMIT = /^Submit\s*$/;
const FOOTER_START = /Enter to select/;
const FOOTER_NAV_SINGLE = /\u2191\/\u2193 to navigate/;
const FOOTER_NAV_TABBED = /Tab\/Arrow keys to navigate/;
const READY_TO_SUBMIT = /^Ready to submit your answers\?\s*$/;
const REVIEW_TITLE = /^Review your answers\s*$/;
const TYPE_SOMETHING = /^Type something\.?$/i;
const CHAT_ABOUT = /^Chat about this$/i;
const SUBMIT_LABEL = /^Submit(?: answers)?$/i;

type ParsedRow = {
  index: number | null;
  label: string;
  checked?: boolean;
  current: boolean;
};

type RowHit = {
  lineIdx: number;
  row: ParsedRow;
};

/** Parse an AskUserQuestion prompt out of terminal screen lines. Null when the
 *  lines do not contain one, or when the shape cannot be determined. */
export function scanAskQuestion(lines: readonly string[]): AskScreen | null {
  const normalized = lines.map((line) => line.replace(/\r$/, "").trimEnd());
  const footer = findFooter(normalized);
  if (footer && normalized.slice(footer.end).some((line) => line.trim() !== "")) return null;

  const bound = footer?.start ?? normalized.length;
  const hits = collectOptionHits(normalized, bound);
  const cluster = lastOptionCluster(normalized, hits);
  if (!cluster || !cluster.some((hit) => hit.row.index !== null)) return null;

  const firstIdx = cluster[0].lineIdx;
  const openSep = lastSeparatorBefore(normalized, firstIdx);
  const promptRegion = normalized.slice(openSep + 1, firstIdx);
  const readyOffset = findLastIndex(promptRegion, (line) => READY_TO_SUBMIT.test(line));

  let tabs: AskTab[] = [];
  let tabOffset = -1;
  let headerOffset = -1;
  for (let i = 0; i < promptRegion.length; i++) {
    const line = promptRegion[i];
    if (TAB_BAR_LINE.test(line)) {
      const parsed = parseTabBar(line);
      if (!parsed) return null;
      tabs = parsed;
      tabOffset = i;
    } else if (TAB_BAR_CANDIDATE.test(line)) {
      return null;
    } else if (SIMPLE_HEADER.test(line)) {
      headerOffset = i;
    }
  }

  const lastPromptOffset = findLastIndex(promptRegion, (line) => line.trim() !== "");
  const isReview = readyOffset >= Math.max(tabOffset, headerOffset) + 1
    && readyOffset === lastPromptOffset;
  const kind = resolveKind(isReview, tabs.length > 0, footer?.text ?? "");
  if (!kind) return null;

  let question: string;
  if (kind === "review") {
    question = promptRegion[readyOffset];
  } else {
    const contentStart = Math.max(tabOffset, headerOffset) + 1;
    const questionLines = promptRegion
      .slice(contentStart)
      .filter((line) => line.trim() !== "" && !REVIEW_TITLE.test(line));
    if (questionLines.length === 0) return null;
    question = questionLines.join(" ");
    if (tabs.length > 0) tabs = withActiveTab(tabs, question);
  }

  const options = assembleOptions(normalized, cluster, bound);
  if (options.length === 0) return null;

  const header = resolveHeader(kind, tabs, promptRegion);
  const multiSelect = options.some((option) => option.checked !== undefined);
  const screen: AskScreen = {
    kind,
    multiSelect,
    tabs: kind === "single" ? [] : tabs,
    question,
    options,
  };
  if (header !== undefined) screen.header = header;
  return screen;
}

function resolveKind(
  isReview: boolean,
  hasTabs: boolean,
  footerText: string,
): AskScreen["kind"] | null {
  if (isReview) return "review";
  if (hasTabs) return "tabbed";
  if (FOOTER_NAV_TABBED.test(footerText)) return "tabbed";
  if (FOOTER_NAV_SINGLE.test(footerText)) return "single";
  return null;
}

function resolveHeader(
  kind: AskScreen["kind"],
  tabs: AskTab[],
  headerRegion: readonly string[],
): string | undefined {
  if (kind === "review") return undefined;
  if (tabs.length > 0) return tabs.find((tab) => tab.active)?.label;
  for (const line of headerRegion) {
    if (TAB_BAR_LINE.test(line) || REVIEW_TITLE.test(line)) continue;
    const header = SIMPLE_HEADER.exec(line);
    if (header) return header[1].trim();
  }
  return undefined;
}

function findFooter(
  lines: readonly string[],
): { start: number; end: number; text: string } | null {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (FOOTER_START.test(lines[i])) start = i;
  }
  if (start < 0) return null;

  let text = lines[start];
  let end = start + 1;
  const next = lines[start + 1];
  if (
    next !== undefined &&
    !SEPARATOR_LINE.test(next) &&
    !parseOptionRow(next) &&
    !FOOTER_START.test(next) &&
    !/Esc to cancel/.test(text)
  ) {
    text = `${text} ${next}`;
    end += 1;
  }
  return { start, end, text };
}

function collectOptionHits(lines: readonly string[], bound: number): RowHit[] {
  const hits: RowHit[] = [];
  for (let i = 0; i < bound; i++) {
    if (SEPARATOR_LINE.test(lines[i])) continue;
    const row = parseOptionRow(lines[i]);
    if (row) hits.push({ lineIdx: i, row });
  }
  return hits;
}

function lastOptionCluster(lines: readonly string[], hits: RowHit[]): RowHit[] | null {
  if (hits.length === 0) return null;
  let start = hits.length - 1;
  for (let i = hits.length - 2; i >= 0; i--) {
    const leftIndex = hits[i].row.index;
    const rightIndex = hits[i + 1].row.index;
    if (
      !isClusterGap(lines, hits[i].lineIdx, hits[i + 1].lineIdx)
      || (leftIndex !== null && rightIndex !== null && leftIndex >= rightIndex)
    ) {
      break;
    }
    start = i;
  }
  return hits.slice(start);
}

function isClusterGap(lines: readonly string[], from: number, to: number): boolean {
  for (let i = from + 1; i < to; i++) {
    const line = lines[i];
    if (SEPARATOR_LINE.test(line) || line.trim() === "") continue;
    if (TAB_BAR_LINE.test(line) || SIMPLE_HEADER.test(line)) return false;
    if (REVIEW_TITLE.test(line) || READY_TO_SUBMIT.test(line)) return false;
    if (FOOTER_START.test(line)) return false;
  }
  return true;
}

function assembleOptions(
  lines: readonly string[],
  cluster: readonly RowHit[],
  bound: number,
): AskOption[] {
  return cluster.map((hit, i) => {
    const end = i + 1 < cluster.length ? cluster[i + 1].lineIdx : bound;
    const parts: string[] = [];
    for (let j = hit.lineIdx + 1; j < end; j++) {
      if (SEPARATOR_LINE.test(lines[j]) || lines[j].trim() === "") continue;
      parts.push(lines[j]);
    }
    const option: AskOption = {
      index: hit.row.index,
      label: hit.row.label,
      current: hit.row.current,
      role: roleOf(hit.row.label),
    };
    if (parts.length > 0) option.description = parts.join("");
    if (hit.row.checked !== undefined) option.checked = hit.row.checked;
    return option;
  });
}

function parseOptionRow(line: string): ParsedRow | null {
  const current = CURSOR_PREFIX.test(line);
  const rest = line.replace(STRIP_CURSOR, "");
  const numbered = NUMBERED_ROW.exec(rest);
  if (numbered) {
    const row: ParsedRow = {
      index: Number(numbered[1]),
      label: numbered[3].trimEnd(),
      current,
    };
    if (numbered[2]) row.checked = numbered[2].includes("\u2714");
    return row;
  }
  if (NUMBERLESS_SUBMIT.test(rest)) {
    return { index: null, label: "Submit", current };
  }
  return null;
}

function roleOf(label: string): AskOptionRole {
  if (TYPE_SOMETHING.test(label)) return "typeSomething";
  if (CHAT_ABOUT.test(label)) return "chatAbout";
  if (SUBMIT_LABEL.test(label)) return "submit";
  return "option";
}

function parseTabBar(line: string): AskTab[] | null {
  const innerMatch = TAB_BAR_INNER.exec(line);
  if (!innerMatch) return null;
  const inner = innerMatch[1];
  TAB_BAR_TOKEN.lastIndex = 0;
  const matches = [...inner.matchAll(TAB_BAR_TOKEN)];
  TAB_BAR_TOKEN.lastIndex = 0;
  if (inner.replace(TAB_BAR_TOKEN, "").trim() !== "") return null;

  const tabs = matches.flatMap((match): AskTab[] => {
    const marker = match[1];
    const label = match[2]?.trim();
    if (!marker || !label) return [];
    return [{
      label,
      answered: marker === "\u2611" || marker === "\u2612",
      active: false,
    }];
  });
  return tabs.length > 0 ? tabs : null;
}

function withActiveTab(tabs: AskTab[], question: string): AskTab[] {
  // Captures do not mark the current tab visually. Prefer the unique tab
  // whose label appears in the on-screen question; otherwise the first
  // unanswered tab (Claude advances after each answer). Review has neither.
  const lower = question.toLowerCase();
  const hits = tabs.filter((tab) => lower.includes(tab.label.toLowerCase()));
  let activeLabel: string | undefined;
  if (hits.length === 1) activeLabel = hits[0].label;
  else activeLabel = tabs.find((tab) => !tab.answered)?.label;
  return tabs.map((tab) => ({ ...tab, active: tab.label === activeLabel }));
}

function lastSeparatorBefore(lines: readonly string[], before: number): number {
  for (let i = before - 1; i >= 0; i--) {
    if (SEPARATOR_LINE.test(lines[i])) return i;
  }
  return -1;
}

function findLastIndex(
  lines: readonly string[],
  predicate: (line: string) => boolean,
): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (predicate(lines[i])) return i;
  }
  return -1;
}
