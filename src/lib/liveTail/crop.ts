export interface LiveTailTool {
  description: string | null;
  elapsedSec: number | null;
  commandRow: string | null;
  outputLines: number | null;
}

export interface LiveTailCrop {
  readable: boolean;
  state: "working" | "done" | "error" | "unreadable" | "unknown";
  rows: string[];
  marker: string | null;
  elapsedSec: number | null;
  tokens: number | null;
  tool: LiveTailTool | null;
  doneAt: string | null;
  doneDay: string | null;
  shells: number;
  error: string | null;
  reason?: "empty_screen" | "marker_missing" | "malformed_spinner" | "read_failed";
}

const GLYPHS = "\u00b7\u2722\u2733\u2736\u273b\u273d*";
const DURATION = /(?:\d+h\s*)?(?:\d+m\s*)?\d+s/;
const CLAUDE_SPINNER = new RegExp(`^[${GLYPHS}]\\s+[^\\s\u2026]+\u2026(?:\\s+\\((.*)\\))?\\s*$`);
const CLAUDE_DONE = new RegExp(`^[${GLYPHS}]\\s+\\S+ for ((?:\\d+h\\s*)?(?:\\d+m\\s*)?(?:\\d+s)?)\\s+\u00b7\\s+done\\s+(\\d{1,2}:\\d{2})(?:\\s+\\(([^)]*)\\))?(?:\\s+\u00b7\\s+(\\d+)\\s+shells?\\s+still running)?`);
const TOOL_HEAD = /^(?:\u25cf\s+)?(.+?)\s+\u00b7\s+((?:\d+h\s*)?(?:\d+m\s*)?\d+s)\s*$/;
const TOOL_TAIL = /\(((?:\d+h\s*)?(?:\d+m\s*)?\d+s)(?:\s+\u00b7\s+(\d+)\s+lines?)?\)\s*$/;
const COMMAND = /^\u23bf\s+\$\s/;
const CLAUDE_EVENT = /^\u25cf\s+\S/;
const BG_HINT = /^(?:\(ctrl\+b to run in background\)|\u2026 \+\d+ lines.*)\s*$/;
const SEPARATOR = /^[\u2500\u2501]{8,}\s*$/;
const ABOVE_BOX_NOISE = /^(?:\u23bf\s+Tip:|new task\?|\u203b recap:)/;
const CODEX_SPINNER = /^\u2022\s+Working\s+\(([^\u2022)]+?)\s+\u2022\s+esc to interrupt\)(.*)$/;
const CODEX_DONE = /^Worked for (.+?)\s+\u2022\s+(.+?)\s*$/;
const CODEX_EVENT = /^\u2022\s+(?!Working\s\()\S/;
const COLLAPSED = /^\+ (?:\d+ lines? \(ctrl\+t to expand\)|Show details)\s*$/;
const API_ERROR = /API Error: (\d{3})(?:\s+(\w+))?/;
const CODEX_CHROME = [
  /^\d+\s*(?:Ready|Working|Waiting|Thinking|Starting)?\s*$/,
  /^\u203a\s/,
  /^(?:Context \d+% used|\d+% used|GPT-|gpt-)/,
  /^\u2514 Tip:/,
  /^\u2022 You have \d+ usage limit reset/,
  /^\u2022 Hook failed\s*$/,
  /^\u2514 hook timed out/,
];

export function durationSeconds(text: string | null | undefined): number | null {
  if (!text) return null;
  const parts = [...text.matchAll(/(\d+)([hms])/g)];
  return parts.length ? parts.reduce((sum, part) => sum + Number(part[1]) * ({ h: 3600, m: 60, s: 1 }[part[2]] ?? 0), 0) : null;
}

function base(): LiveTailCrop {
  return { readable: true, state: "working", rows: [], marker: null, elapsedSec: null, tokens: null, tool: null, doneAt: null, doneDay: null, shells: 0, error: null };
}

export function unreadableLiveTail(reason: LiveTailCrop["reason"] = "read_failed", rows: string[] = []): LiveTailCrop {
  return { ...base(), readable: false, state: "unreadable", rows: rows.slice(-3), reason };
}

function trimBlankTail(rows: readonly string[]): string[] {
  let end = rows.length;
  while (end && !rows[end - 1].trim()) end -= 1;
  return rows.slice(0, end);
}

function claudeBody(rows: string[]): string[] {
  const separators = rows.flatMap((row, i) => SEPARATOR.test(row.trim()) && i >= rows.length - 12 ? [i] : []);
  const boundary = separators[separators.length >= 2 ? separators.length - 2 : separators.length - 1];
  const body = rows.slice(0, boundary ?? rows.length);
  let end = body.length;
  for (let i = body.length - 1; i >= Math.max(0, body.length - 5); i -= 1) {
    if (ABOVE_BOX_NOISE.test(body[i].trim())) end = i;
  }
  return body.slice(0, end);
}

function codexBody(rows: string[]): string[] {
  let end = rows.length;
  while (end && (!rows[end - 1].trim() || CODEX_CHROME.some((pattern) => pattern.test(rows[end - 1].trim())))) end -= 1;
  return rows.slice(0, end);
}

function errorAbove(rows: string[]): { error: string; row: string } | null {
  for (const row of rows.slice(-4)) {
    const match = API_ERROR.exec(row);
    if (match) return { error: `API Error ${match[1]}${match[2] ? " " + match[2] : ""}`, row };
  }
  return null;
}

function completed(marker: string, above: string[], at: string, day: string | null, shells: number): LiveTailCrop {
  const error = errorAbove(above);
  return { ...base(), state: error ? "error" : "done", marker, doneAt: at, doneDay: day, shells,
    error: error?.error ?? null, rows: [...(error ? [error.row] : above.slice(-1)), marker] };
}

function cropClaude(rows: string[]): LiveTailCrop {
  const body = claudeBody(rows);
  if (!body.length) return unreadableLiveTail("empty_screen");
  // Inspect the newest marker first so an older working row cannot outrank a
  // completed turn on the same screen.
  for (let i = body.length - 1; i >= Math.max(0, body.length - 8); i -= 1) {
    const line = body[i].trim();
    const done = CLAUDE_DONE.exec(line);
    if (done && i >= body.length - 6) {
      return completed(body[i], body.slice(0, i).filter((r) => r.trim()), done[2], done[3] ?? null, Number(done[4] ?? 0));
    }
    const spinner = CLAUDE_SPINNER.exec(line);
    if (!spinner) continue;
    const inner = spinner[1] ?? "";
    const tokens = /\u2193\s*([\d.]+)(k|m)?\s*tokens/.exec(inner);
    const result = { ...base(), marker: body[i], elapsedSec: durationSeconds(DURATION.exec(inner)?.[0]),
      tokens: tokens ? Number(tokens[1]) * (tokens[2] === "k" ? 1_000 : tokens[2] === "m" ? 1_000_000 : 1) : null };
    const above = body.slice(0, i).filter((r) => r.trim() && !BG_HINT.test(r.trim()));
    let head = -1;
    for (let j = above.length - 1; j >= Math.max(0, above.length - 8); j -= 1) {
      if (COMMAND.test(above[j].trim()) && j > 0 && TOOL_HEAD.test(above[j - 1].trim())) { head = j - 1; break; }
    }
    if (head < 0) {
      for (let j = above.length - 1; j >= Math.max(0, above.length - 8); j -= 1) {
        if (CLAUDE_EVENT.test(above[j].trim())) { head = j; break; }
      }
    }
    if (head >= 0) {
      result.rows.push(above[head]);
      const th = TOOL_HEAD.exec(above[head].trim());
      const cmd = above.findIndex((r, j) => j > head && COMMAND.test(r.trim()));
      if (th || cmd >= 0) {
        const tail = above.slice(head).map((r) => TOOL_TAIL.exec(r.trim())).find((m) => m !== null);
        result.tool = { description: th?.[1] ?? null, elapsedSec: durationSeconds(th?.[2] ?? tail?.[1]),
          commandRow: cmd >= 0 ? above[cmd] : null, outputLines: tail?.[2] === undefined ? null : Number(tail[2]) };
        if (cmd >= 0) result.rows.push(above[cmd]);
      } else if (head + 1 < above.length) result.rows.push(above[head + 1]);
    } else result.rows.push(...above.slice(-2));
    result.rows.push(body[i]);
    return result;
  }
  return unreadableLiveTail("marker_missing", body.filter((r) => r.trim()).slice(-2));
}

function cropCodex(rows: string[]): LiveTailCrop {
  const body = codexBody(rows);
  if (!body.length) return unreadableLiveTail("empty_screen");
  for (let i = body.length - 1; i >= Math.max(0, body.length - 6); i -= 1) {
    const line = body[i].trim();
    const done = CODEX_DONE.exec(line);
    if (done) {
      const above = body.slice(0, i).filter((r) => r.trim() && !COLLAPSED.test(r.trim()) && !CODEX_CHROME.some((p) => p.test(r.trim())));
      return completed(body[i], above, done[2], /^(.+?) at \d{1,2}:\d{2}$/.exec(done[2])?.[1] ?? null, 0);
    }
    const spinner = CODEX_SPINNER.exec(line);
    if (!spinner) {
      if (/esc to interrupt\)/.test(line)) return unreadableLiveTail("malformed_spinner", [body[i]]);
      continue;
    }
    const result = { ...base(), marker: body[i], elapsedSec: durationSeconds(spinner[1]),
      shells: Number(/(\d+) background terminals? running/.exec(spinner[2])?.[1] ?? 0) };
    const above = body.slice(0, i).filter((r) => r.trim() && !COLLAPSED.test(r.trim()));
    let event = -1;
    for (let j = above.length - 1; j >= Math.max(0, above.length - 11); j -= 1) {
      if (CODEX_EVENT.test(above[j].trim())) { event = j; break; }
    }
    if (event >= 0) {
      result.rows.push(above[event]);
      if (event + 1 < above.length && /^\u2514\s/.test(above[event + 1].trim())) result.rows.push(above[event + 1]);
    } else result.rows.push(...above.slice(-1));
    result.rows.push(body[i]);
    return result;
  }
  return unreadableLiveTail("marker_missing", body.filter((r) => r.trim()).slice(-2));
}

/** Select existing rows verbatim; only parsed evidence is normalized. */
export function cropLiveTail(rawRows: readonly string[], agentKind: string | null): LiveTailCrop {
  const rows = trimBlankTail(rawRows);
  if (agentKind === "claude" || agentKind === "claude-codex") return cropClaude(rows);
  if (agentKind === "codex") return cropCodex(rows);
  return { ...base(), state: "unknown", readable: rows.length > 0, rows: rows.filter((r) => r.trim()).slice(-3) };
}
