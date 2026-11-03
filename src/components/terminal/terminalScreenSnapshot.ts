/// <reference lib="es2022.intl" />
import type { IBufferCell, ITheme, Terminal } from "@xterm/xterm";
import { ANSI_KEYS } from "./terminalThemeColors";

export type ScreenColor = number | string | null;
export type ScreenRun = [col: number, width: 1 | 2, text: string, fg: ScreenColor, bg: ScreenColor, flags: number];
export interface ScreenTheme {
  foreground: string;
  background: string;
  cursor: string;
  palette: string[];
}
export interface TerminalScreenSnapshot {
  cols: number;
  rows: number;
  cursor: { col: number; row: number; visible: boolean } | null;
  atBottom: boolean;
  alternateScreen: boolean;
  scrollbackLines: number;
  theme: ScreenTheme;
  lines: ScreenRun[][];
}

// xterm 6's default palette; normally all entries come from the applied ITheme.
const DEFAULT_PALETTE = [
  "#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
];

/** The wire format has RGB only. Preserve the RGB reference of glass themes. */
export function screenRgb(color: string | undefined, fallback: string): string {
  if (!color) return fallback;
  if (/^#[\da-f]{6}([\da-f]{2})?$/i.test(color)) return color.slice(0, 7).toLowerCase();
  if (/^#[\da-f]{3,4}$/i.test(color)) return "#" + [...color.slice(1, 4)].map(c => c + c).join("").toLowerCase();
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,[^)]+)?\s*\)$/i.exec(color);
  if (rgb && rgb.slice(1, 4).every(c => Number(c) <= 255)) {
    return "#" + rgb.slice(1, 4).map(c => Number(c).toString(16).padStart(2, "0")).join("");
  }
  return fallback;
}

export function terminalScreenTheme(theme: ITheme = {}): ScreenTheme {
  return {
    foreground: screenRgb(theme.foreground, "#ffffff"),
    background: screenRgb(theme.background, "#000000"),
    cursor: screenRgb(theme.cursor, "#ffffff"),
    palette: ANSI_KEYS.map((key, i) => screenRgb(theme[key] as string | undefined, DEFAULT_PALETTE[i])),
  };
}

export function clampScreenScrollback(value: unknown): number {
  return typeof value === "number" && !Number.isNaN(value) ? Math.max(0, Math.min(500, Math.trunc(value))) : 0;
}

function cellColor(cell: IBufferCell, foreground: boolean, overrides?: ReadonlyMap<number, string>): ScreenColor {
  if (foreground ? cell.isFgDefault() : cell.isBgDefault()) return null;
  const value = foreground ? cell.getFgColor() : cell.getBgColor();
  if (foreground ? cell.isFgRGB() : cell.isBgRGB()) return "#" + value.toString(16).padStart(6, "0");
  // The contract carries only the first 16 theme colors. Materialize an OSC
  // override of an extended index as RGB so it remains visually reproducible.
  return value >= 16 ? overrides?.get(value) ?? value : value;
}

let graphemeSegmenter: Intl.Segmenter | undefined;
const graphemeBoundaries = new Map<number | string, boolean>();

/** These code units always have a grapheme boundary when adjacent to each other.
 * Combining kana marks, halfwidth voicing marks, ZWJ and surrogates stay slow.
 */
function isSimpleGraphemeCodeUnit(value: number): boolean {
  return (value >= 0x20 && value <= 0x2ff) || (value >= 0x2500 && value <= 0x259f)
    || (value >= 0x3000 && value <= 0x3098) || (value >= 0x309b && value <= 0x30ff)
    || (value >= 0x3400 && value <= 0x4dbf) || (value >= 0x4e00 && value <= 0x9fff)
    || (value >= 0xac00 && value <= 0xd7a3);
}

/** Each appended cell must remain a separate grapheme at its xterm column. */
function canJoinCells(previous: string, current: string): boolean {
  // Older supported WebViews must preserve columns without Intl.Segmenter.
  if (typeof Intl.Segmenter !== "function") return false;
  if (isSimpleGraphemeCodeUnit(previous.charCodeAt(previous.length - 1))
    && isSimpleGraphemeCodeUnit(current.charCodeAt(0))) return true;
  graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const key = previous.length === 1 && current.length === 1
    ? previous.charCodeAt(0) * 65536 + current.charCodeAt(0) : previous + "\0" + current;
  const cached = graphemeBoundaries.get(key);
  if (cached !== undefined) return cached;
  const boundary = graphemeSegmenter.segment(previous + current).containing(previous.length)?.index === previous.length;
  if (graphemeBoundaries.size >= 256) graphemeBoundaries.clear();
  graphemeBoundaries.set(key, boundary);
  return boundary;
}

/** Pure, synchronous buffer-API reader shared by browser and headless xterm.
 * No trimming, logical-line joining, scrolling, writes, or private xterm state.
 * Cursor visibility is supplied by the public parser observer installed at init.
 */
export function snapshotTerminalScreen(
  terminal: Pick<Terminal, "cols" | "rows" | "buffer">,
  theme: ScreenTheme,
  options: { scrollback?: unknown; cursorVisible?: boolean; viewportY?: number; paletteOverrides?: ReadonlyMap<number, string> } = {},
): TerminalScreenSnapshot {
  const { cols, rows } = terminal;
  const buffer = terminal.buffer.active;
  const viewportY = Math.max(0, Math.min(buffer.baseY, options.viewportY ?? buffer.viewportY));
  const scrollbackLines = Math.min(viewportY, clampScreenScrollback(options.scrollback));
  const lines: ScreenRun[][] = [];
  const cell = buffer.getNullCell();
  for (let y = viewportY - scrollbackLines; y < viewportY + rows; y++) {
    const runs: ScreenRun[] = [];
    const line = buffer.getLine(y);
    let previousEnd = -1;
    let previousText = "";
    for (let col = 0; line && col < cols; col++) {
      const current = line.getCell(col, cell);
      if (!current || current.getWidth() === 0) continue; // Wide-cell continuation.
      let width = current.getWidth() === 2 ? 2 as const : 1 as const;
      let text = current.getChars() || " ";
      // xterm attaches these zero-width controls to a cell, but Intl segments
      // them separately. Retain joiners and variation selectors in the glyph.
      if (text.length > 1) text = text.replace(/[\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g, "") || " ";
      // Concealed text is not painted by xterm and must not leak to the reader.
      if (current.isInvisible()) { text = " ".repeat(width); width = 1; }
      const fg = cellColor(current, true, options.paletteOverrides), bg = cellColor(current, false, options.paletteOverrides);
      const flags = (current.isBold() ? 1 : 0) | (current.isItalic() ? 2 : 0)
        | (current.isUnderline() ? 4 : 0) | (current.isDim() ? 8 : 0)
        | (current.isInverse() ? 16 : 0) | (current.isStrikethrough() ? 32 : 0);
      if (text.trim() === "" && fg === null && bg === null && flags === 0) continue;
      const previous = runs[runs.length - 1];
      if (previous && previousEnd === col && previous[1] === width && previous[3] === fg && previous[4] === bg && previous[5] === flags
        && canJoinCells(previousText, text)) {
        previous[2] += text;
      } else {
        runs.push([col, width, text, fg, bg, flags]);
      }
      previousEnd = col + current.getWidth();
      previousText = text;
    }
    lines.push(runs);
  }
  const cursorRow = buffer.baseY + buffer.cursorY - viewportY;
  return {
    cols, rows,
    cursor: cursorRow >= 0 && cursorRow < rows
      ? { col: Math.min(cols - 1, buffer.cursorX), row: cursorRow, visible: options.cursorVisible ?? true } : null,
    atBottom: viewportY === buffer.baseY,
    alternateScreen: buffer.type === "alternate",
    scrollbackLines,
    theme,
    lines,
  };
}
