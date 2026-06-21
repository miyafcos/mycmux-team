import { memo, useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { open } from "@tauri-apps/plugin-shell";
import {
  createSession,
  ackFrontendData,
  setFrontendVisible,
  writeToSession,
  resizeSession,
  onPtyExit,
  getTerminalConfig,
} from "../../lib/ipc";
import type { FrontendDataBatch } from "../../lib/ipc";
import { usePaneMetadataStore, useUiStore } from "../../stores/workspaceStore";
import { useKeybindingStore } from "../../stores/keybindingStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { DEFAULT_TERMINAL_FONT_FAMILY, useThemeStore } from "../../stores/themeStore";
import type { ILink, IMarker, ITheme } from "@xterm/xterm";
import { markStartupSessionSettled } from "../../lib/startupSessionGate";

// Notification sound via Web Audio API — short gentle chime
let _audioCtx: AudioContext | null = null;
function playNotificationSound() {
  try {
    if (!_audioCtx) _audioCtx = new AudioContext();
    const ctx = _audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880; // A5
    osc.type = "sine";
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch {
    // Audio not available — silent fallback
  }
}

interface XTermWrapperProps {
  sessionId: string;
  command: string;
  args?: string[];
  agentId?: string;
  agentKind?: "claude" | "codex" | "claude-codex";
  onExit?: () => void;
  theme?: ITheme;
  fontSize?: number;
  fontFamily?: string;
  onZoomToggle?: () => void;
  onUrlClick?: (url: string) => void;
  cwd?: string;
  launchEnv?: Record<string, string>;
  initialReplay?: string[];
}

// Approval-prompt detection patterns. Pattern index is used as the
// notification key so the same approval fires only once per occurrence.
const APPROVAL_PATTERNS: readonly RegExp[] = [
  /allow\s+.*\?\s*\(y\/n\)/i,                // 1: Claude Code tool approval
  /^\s*\d+\.\s+.+\(.*\)/,                    // 2: AskUserQuestion numbered choice
  /\(y\/n\)\s*$/i,                           // 3: generic (y/n)
  /\[y\/N\]/i,                               // 4: shell-style [y/N]
  /type your (answer|response)/i,            // 5: Claude AskUser open prompt
  /press enter to (continue|confirm|submit|send|select)/i, // 6
  /hit enter to /i,                          // 7
  /\bapprove\b.*\?/i,                        // 8: generic approve?
  /do you want to (proceed|continue)/i,      // 9: Claude Code "Do you want to proceed?"
  /❯\s+\d+\.\s+/,                            // 10: Ink-style ❯ 1. Yes selection cursor
  /[❯▶▸»●◉]\s+(?:\d+\.|yes\b|no\b)/i,        // 11: cursor-glyph variants (incl. dot)
  /enter\s+to\s+(?:select|confirm|send|submit|continue)/i, // 12: "Enter to select" hint
  /esc\s+to\s+(?:cancel|exit|quit)/i,        // 13: "Esc to cancel" hint
  /↑\/↓/,                                    // 14: arrow-nav hint (very specific to selection menus)
  /ask user question/i,                      // 15: Claude Code AskUserQuestion box title
  /would you like to (proceed|continue)/i,   // 16: plan-mode "Would you like to proceed?"
  /shift\s*\+\s*tab to approve/i,            // 17: plan approval footer hint
  /ctrl-g to edit/i,                         // 18: plan approval edit hint
  /hook [A-Za-z]+ requires confirmation/i,   // 19: Claude Code Bash hook confirmation
  /would you like to run the following command\?/i, // 20: Codex command approval
  /^\s*(?:[›>]\s*)?\d+\.\s+(?:yes|no)\b/i,   // 21: Codex numbered choices
] as const;

// Scan the last N lines of the terminal buffer for an approval pattern.
// Returns the matched pattern index (1-based) or 0 if nothing matched.
function scanForApproval(lines: string[]): number {
  for (const line of lines) {
    for (let i = 0; i < APPROVAL_PATTERNS.length; i++) {
      if (APPROVAL_PATTERNS[i].test(line)) return i + 1;
    }
  }
  return 0;
}

const ANSI_KEYS: (keyof ITheme)[] = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];

function buildThemeFromConfig(cfg: { background: string; foreground: string; ansi: string[] }): ITheme {
  const theme: ITheme = {
    background: cfg.background,
    foreground: cfg.foreground,
    cursor: cfg.foreground,
    selectionBackground: "#404040",
  };
  for (let i = 0; i < ANSI_KEYS.length && i < cfg.ansi.length; i++) {
    (theme as Record<string, string>)[ANSI_KEYS[i] as string] = cfg.ansi[i];
  }
  return theme;
}

function colorWithOpacity(color: string | undefined, opacity: number): string | undefined {
  if (!color || opacity >= 0.995) {
    return color;
  }

  const shortHex = /^#([0-9a-f]{3})$/i.exec(color);
  const fullHex = /^#([0-9a-f]{6})$/i.exec(color);
  const hex = fullHex?.[1] ?? shortHex?.[1].split("").map((char) => `${char}${char}`).join("");
  if (!hex) {
    return color;
  }

  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
}

function withTerminalOpacity(theme: ITheme, opacity: number, mediaActive: boolean): ITheme {
  return {
    ...theme,
    background: mediaActive ? "rgba(0, 0, 0, 0)" : colorWithOpacity(theme.background, opacity),
  };
}

// xterm's minimumContrastRatio only works against an opaque, known background.
// With a media background the terminal background is transparent (the wallpaper
// is composited in CSS), so it must be disabled — otherwise xterm corrects the
// foreground against a phantom black background and washes out dark text.
const TERMINAL_MIN_CONTRAST = 7;

function minContrastFor(mediaActive: boolean): number {
  return mediaActive ? 1 : TERMINAL_MIN_CONTRAST;
}

// Chunk large pastes to avoid PTY buffer overflow
const PASTE_CHUNK = 1024;

function enqueueSessionWrite(sessionId: string, data: string): void {
  const previous = terminalInputQueues.get(sessionId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => writeToSession(sessionId, data));
  terminalInputQueues.set(sessionId, next);
  next
    .catch(console.error)
    .finally(() => {
      if (terminalInputQueues.get(sessionId) === next) {
        terminalInputQueues.delete(sessionId);
      }
    });
}

function chunkedWrite(sessionId: string, data: string): void {
  if (data.length <= PASTE_CHUNK) {
    enqueueSessionWrite(sessionId, data);
  } else {
    for (let offset = 0; offset < data.length; offset += PASTE_CHUNK) {
      enqueueSessionWrite(sessionId, data.slice(offset, offset + PASTE_CHUNK));
    }
  }
}

// Cache terminal config globally — fetched once, reused across all panes
let cachedConfig: { theme: ITheme; fontSize: number; fontFamily: string } | null = null;
let configPromise: Promise<void> | null = null;

// --- Terminal instance cache ---
// Prevents xterm destruction when Allotment restructuring causes React to
// unmount/remount XTermWrapper. Keyed by sessionId.
interface CachedTerm {
  term: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  xtermElement: HTMLElement;
  unlistenExit: (() => void) | null;
}
const termCache = new Map<string, CachedTerm>();
const liveTerms = new Map<string, Terminal>();
const terminalSizeCache = new Map<string, { cols: number; rows: number }>();
const terminalWriteCounters = new Map<string, number>();
const terminalSelectionCopyListeners = new WeakMap<Terminal, { dispose: () => void }>();
const terminalInputQueues = new Map<string, Promise<void>>();

const TERMINAL_SNAPSHOT_SCAN_MULTIPLIER = 4;
const TERMINAL_SNAPSHOT_MAX_WRAPPED_LINES = 256;
const TERMINAL_SNAPSHOT_MAX_LINE_CHARS = 8192;

const terminalHasLiveOutput = new Set<string>();
const terminalInitialReplayMarkers = new Map<string, IMarker>();

const TERMINAL_PLAIN_INPUT_KEYS = new Set([
  "Backspace",
  "Delete",
  "Enter",
  "Escape",
  "Tab",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Insert",
]);

function isPlainTerminalInputEvent(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  return e.key.length === 1 || TERMINAL_PLAIN_INPUT_KEYS.has(e.key);
}

function focusTerminalSoon(currentTerm: Terminal): void {
  const focusTerminal = () => {
    try {
      currentTerm.focus();
    } catch {
      // Terminal may have been disposed between copy completion and focus restore.
    }
  };

  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(focusTerminal);
    return;
  }

  setTimeout(focusTerminal, 0);
}

function fallbackCopyTextToClipboard(text: string, restoreFocus?: () => void): void {
  if (typeof document === "undefined") {
    restoreFocus?.();
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
  } catch {
    // Clipboard access is best effort; terminal selection must never break input.
  } finally {
    document.body.removeChild(textarea);
    restoreFocus?.();
  }
}

function copyTextToClipboard(text: string, restoreFocus?: () => void): void {
  if (!text) {
    restoreFocus?.();
    return;
  }
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (clipboard?.writeText) {
    clipboard
      .writeText(text)
      .then(() => restoreFocus?.())
      .catch(() => fallbackCopyTextToClipboard(text, restoreFocus));
    return;
  }
  fallbackCopyTextToClipboard(text, restoreFocus);
}

function disposeSelectionCopyListener(currentTerm: Terminal | null | undefined): void {
  if (!currentTerm) return;
  const existing = terminalSelectionCopyListeners.get(currentTerm);
  if (!existing) return;
  existing.dispose();
  terminalSelectionCopyListeners.delete(currentTerm);
}

function stripTerminalMouseInputSequences(data: string): string {
  return data
    // SGR mouse reporting: ESC [ < button ; col ; row M/m
    .replace(/\x1b\[<\d+(?:;\d+){2}[mM]/g, "")
    // urxvt-style mouse reporting: ESC [ button ; col ; row M/m
    .replace(/\x1b\[\d+(?:;\d+){2}[mM]/g, "")
    // X10 / normal tracking: ESC [ M followed by three encoded bytes
    .replace(/\x1b\[M[\s\S]{3}/g, "");
}

const WHEEL_DELTA_LINE = 1;
const WHEEL_DELTA_PAGE = 2;

function wheelDeltaToTerminalLines(event: WheelEvent, rows: number): number {
  const rawDelta = event.deltaY;
  if (rawDelta === 0) return 0;

  const lines = event.deltaMode === WHEEL_DELTA_PAGE
    ? rawDelta * Math.max(1, rows)
    : event.deltaMode === WHEEL_DELTA_LINE
      ? rawDelta
      : rawDelta / 40;
  if (!Number.isFinite(lines) || lines === 0) return 0;

  const direction = Math.sign(lines);
  return direction * Math.max(1, Math.round(Math.abs(lines)));
}

function attachTerminalWheelScroll(currentTerm: Terminal): () => void {
  const handleWheel = (event: WheelEvent): boolean => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey) return true;
    const lines = wheelDeltaToTerminalLines(event, currentTerm.rows);
    if (lines === 0) return true;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    currentTerm.scrollLines(lines);
    return false;
  };

  currentTerm.attachCustomWheelEventHandler(handleWheel);
  return () => {
    currentTerm.attachCustomWheelEventHandler(() => true);
  };
}

function registerTerminalFocusSync(currentTerm: Terminal, sessionId: string): () => void {
  const element = currentTerm.element;
  if (!element) return () => {};

  const syncFocusedTerminal = (): void => {
    const ui = useUiStore.getState();
    if (ui.activePaneId !== sessionId) {
      ui.setActivePaneId(sessionId);
    }
  };

  element.addEventListener("focusin", syncFocusedTerminal);
  return () => element.removeEventListener("focusin", syncFocusedTerminal);
}

function registerSelectionCopyListener(currentTerm: Terminal): void {
  disposeSelectionCopyListener(currentTerm);

  let selectionDirty = false;
  let copyTimer: number | null = null;
  const selectionDisposable = currentTerm.onSelectionChange(() => {
    selectionDirty = true;
  });

  const flushSelectionCopy = (event?: Event) => {
    if (event instanceof MouseEvent && event.button !== 0) {
      selectionDirty = false;
      return;
    }
    if (typeof PointerEvent !== "undefined" && event instanceof PointerEvent && event.button !== 0) {
      selectionDirty = false;
      return;
    }
    if (!selectionDirty) return;
    selectionDirty = false;
    if (copyTimer !== null) {
      window.clearTimeout(copyTimer);
    }
    copyTimer = window.setTimeout(() => {
      copyTimer = null;
      const selectedText = currentTerm.getSelection();
      if (!selectedText) return;
      focusTerminalSoon(currentTerm);
      copyTextToClipboard(selectedText, () => focusTerminalSoon(currentTerm));
    }, 0);
  };

  const win = currentTerm.element?.ownerDocument.defaultView ?? window;
  win.addEventListener("pointerup", flushSelectionCopy, true);
  win.addEventListener("mouseup", flushSelectionCopy, true);
  win.addEventListener("touchend", flushSelectionCopy, true);
  terminalSelectionCopyListeners.set(currentTerm, {
    dispose: () => {
      selectionDisposable.dispose();
      if (copyTimer !== null) {
        window.clearTimeout(copyTimer);
        copyTimer = null;
      }
      win.removeEventListener("pointerup", flushSelectionCopy, true);
      win.removeEventListener("mouseup", flushSelectionCopy, true);
      win.removeEventListener("touchend", flushSelectionCopy, true);
    },
  });
}

// v0.7.1 diag: per-session aggregated write stats flushed every 1 s on console.
type DiagWriteStats = {
  writes: number;
  bytes: number;
  webgl: "on" | "fallback" | "never";
  webglLostAt: number | null;
  replays: number;
  replayLines: number;
};
const diagWriteStats = new Map<string, DiagWriteStats>();

function diagStatsFor(sessionId: string): DiagWriteStats {
  let stats = diagWriteStats.get(sessionId);
  if (!stats) {
    stats = { writes: 0, bytes: 0, webgl: "never", webglLostAt: null, replays: 0, replayLines: 0 };
    diagWriteStats.set(sessionId, stats);
  }
  return stats;
}

// Flush per-session write stats once per second. Idle sessions are skipped.
// Debug builds only — `import.meta.env.DEV` is statically false in production,
// so Vite drops this interval (and its per-second console spam) entirely.
if (typeof window !== "undefined" && import.meta.env.DEV) {
  window.setInterval(() => {
    for (const [sid, s] of diagWriteStats) {
      if (s.writes === 0 && s.replays === 0 && s.webglLostAt === null) continue;
      console.log(
        `[mycmux-diag xterm:${sid}] writes/s=${s.writes} bytes/s=${s.bytes} webgl=${s.webgl} replays=${s.replays} replay_lines=${s.replayLines}`,
      );
      s.writes = 0;
      s.bytes = 0;
      s.replays = 0;
      s.replayLines = 0;
    }
  }, 1000);
}
const DEFAULT_TERMINAL_LINE_HEIGHT = 1.1;

type MarkdownTableAlignment = "left" | "center" | "right" | "default";

function resolveTerminalFontFamily(base: string, isCodex: boolean, explicitFontFamily: boolean): string {
  void isCodex;
  void explicitFontFamily;
  return base;
}

function resolveTerminalFontSize(base: number, isCodex: boolean, explicitFontSize: boolean): number {
  void isCodex;
  void explicitFontSize;
  return base;
}

function resolveTerminalLineHeight(isCodex: boolean): number {
  void isCodex;
  return DEFAULT_TERMINAL_LINE_HEIGHT;
}

function splitMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  let body = trimmed;
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);

  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const char of body) {
    if (escaped) {
      cell += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells.length >= 2 ? cells : null;
}

function parseMarkdownTableDivider(cells: string[]): MarkdownTableAlignment[] | null {
  const alignments: MarkdownTableAlignment[] = [];
  for (const cell of cells) {
    const value = cell.trim();
    if (!/^:?-{3,}:?$/.test(value)) return null;
    if (value.startsWith(":") && value.endsWith(":")) {
      alignments.push("center");
    } else if (value.endsWith(":")) {
      alignments.push("right");
    } else if (value.startsWith(":")) {
      alignments.push("left");
    } else {
      alignments.push("default");
    }
  }
  return alignments;
}

function normalizeMarkdownTableRow(cells: string[], width: number): string[] {
  return Array.from({ length: width }, (_, index) => cells[index]?.trim() ?? "");
}

const DISPLAY_WIDTH_CACHE_LIMIT = 8192;
const DISPLAY_NORMALIZE_CACHE_LIMIT = 4096;
const DISPLAY_CACHE_MAX_TEXT_LENGTH = 512;
const NON_ASCII_RE = /[^\x00-\x7f]/;
const displayWidthCache = new Map<string, number>();
const displayNormalizeCache = new Map<string, string>();
const charWidthCache = new Map<string, number>();

function rememberLimited<T>(
  cache: Map<string, T>,
  key: string,
  value: T,
  limit: number,
): T {
  if (cache.size >= limit) {
    cache.clear();
  }
  cache.set(key, value);
  return value;
}

function normalizeDisplayWidthValue(value: string): string {
  if (!NON_ASCII_RE.test(value)) return value;
  if (value.length > DISPLAY_CACHE_MAX_TEXT_LENGTH) return value.normalize("NFC");

  const cached = displayNormalizeCache.get(value);
  if (cached !== undefined) return cached;

  return rememberLimited(
    displayNormalizeCache,
    value,
    value.normalize("NFC"),
    DISPLAY_NORMALIZE_CACHE_LIMIT,
  );
}

function isZeroWidthCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  );
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  );
}

function displayWidthOfChar(char: string): number {
  const cached = charWidthCache.get(char);
  if (cached !== undefined) return cached;

  const codePoint = char.codePointAt(0);
  let width = 0;
  if (
    codePoint !== undefined &&
    codePoint !== 0 &&
    codePoint >= 0x20 &&
    (codePoint < 0x7f || codePoint >= 0xa0) &&
    !isZeroWidthCodePoint(codePoint)
  ) {
    width = isWideCodePoint(codePoint) ? 2 : 1;
  }

  return rememberLimited(charWidthCache, char, width, DISPLAY_WIDTH_CACHE_LIMIT);
}

function displayWidth(value: string): number {
  if (value.length <= DISPLAY_CACHE_MAX_TEXT_LENGTH) {
    const cached = displayWidthCache.get(value);
    if (cached !== undefined) return cached;
  }

  let width = 0;
  for (const char of normalizeDisplayWidthValue(value)) {
    width += displayWidthOfChar(char);
  }

  if (value.length <= DISPLAY_CACHE_MAX_TEXT_LENGTH) {
    return rememberLimited(displayWidthCache, value, width, DISPLAY_WIDTH_CACHE_LIMIT);
  }
  return width;
}

function clipMarkdownCell(value: string, maxWidth: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (displayWidth(normalized) <= maxWidth) return normalized;

  const suffix = "...";
  const limit = Math.max(1, maxWidth - displayWidth(suffix));
  let clipped = "";
  let width = 0;
  for (const char of normalized) {
    const charWidth = displayWidth(char);
    if (width + charWidth > limit) break;
    clipped += char;
    width += charWidth;
  }
  return `${clipped}${suffix}`;
}

function padMarkdownCell(value: string, width: number, alignment: MarkdownTableAlignment): string {
  const valueWidth = displayWidth(value);
  const left = alignment === "right"
    ? Math.max(0, width - valueWidth)
    : alignment === "center"
      ? Math.floor(Math.max(0, width - valueWidth) / 2)
      : 0;
  const right = Math.max(0, width - valueWidth - left);
  return `${" ".repeat(left)}${value}${" ".repeat(right)}`;
}

function renderMarkdownTableForTerminal(
  header: string[],
  alignments: MarkdownTableAlignment[],
  rows: string[][],
): string[] {
  const width = header.length;
  const clippedHeader = normalizeMarkdownTableRow(header, width).map((cell) => clipMarkdownCell(cell, 36));
  const clippedRows = rows.map((row) => normalizeMarkdownTableRow(row, width).map((cell) => clipMarkdownCell(cell, 44)));
  const columnWidths = clippedHeader.map((cell, index) => {
    const rowWidth = clippedRows.reduce((max, row) => Math.max(max, displayWidth(row[index] ?? "")), 0);
    return Math.max(3, Math.min(44, Math.max(displayWidth(cell), rowWidth)));
  });

  const renderRow = (cells: string[]): string => {
    return `| ${cells.map((cell, index) => padMarkdownCell(cell, columnWidths[index], alignments[index] ?? "left")).join(" | ")} |`;
  };

  const divider = `| ${columnWidths
    .map((cellWidth, index) => {
      const dashes = "-".repeat(cellWidth);
      const alignment = alignments[index] ?? "default";
      if (alignment === "center") return `:${dashes.slice(1, -1) || "-"}:`;
      if (alignment === "right") return `${dashes.slice(0, -1) || "-"}:`;
      if (alignment === "left") return `:${dashes.slice(1) || "-"}`;
      return dashes;
    })
    .join(" | ")} |`;

  return [renderRow(clippedHeader), divider, ...clippedRows.map(renderRow)];
}

function formatMarkdownTablesForTerminal(text: string): string {
  if (!text.includes("|") || /[\x1b\x9b]/.test(text)) return text;

  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const hasTrailingNewline = /(?:\r\n|\n|\r)$/.test(text);
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }

  let changed = false;
  const output: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const header = splitMarkdownTableRow(lines[i]);
    const divider = i + 1 < lines.length ? splitMarkdownTableRow(lines[i + 1]) : null;
    if (!header || !divider || header.length !== divider.length) {
      output.push(lines[i]);
      continue;
    }

    const alignments = parseMarkdownTableDivider(divider);
    if (!alignments) {
      output.push(lines[i]);
      continue;
    }

    const rows: string[][] = [];
    let nextIndex = i + 2;
    for (; nextIndex < lines.length; nextIndex++) {
      const row = splitMarkdownTableRow(lines[nextIndex]);
      if (!row || row.length < 2) break;
      rows.push(normalizeMarkdownTableRow(row, header.length));
    }

    if (rows.length === 0) {
      output.push(lines[i]);
      continue;
    }

    output.push(...renderMarkdownTableForTerminal(header, alignments, rows));
    i = nextIndex - 1;
    changed = true;
  }

  if (!changed) return text;
  return `${output.join(newline)}${hasTrailingNewline ? newline : ""}`;
}

/** Call before killSession to dispose the cached terminal */
export function evictTerminalCache(sessionId: string): void {
  const cached = termCache.get(sessionId);
  if (cached) {
    cached.unlistenExit?.();
    cached.term.dispose();
    termCache.delete(sessionId);
    console.log(`[mycmux-diag xterm:${sessionId}] cache_evict`);
  }
  terminalSizeCache.delete(sessionId);
  terminalWriteCounters.delete(sessionId);
  terminalInputQueues.delete(sessionId);
  diagWriteStats.delete(sessionId);
  terminalHasLiveOutput.delete(sessionId);
  terminalInitialReplayMarkers.get(sessionId)?.dispose();
  terminalInitialReplayMarkers.delete(sessionId);
}

export function getTerminalWriteCounter(sessionId: string): number {
  return terminalWriteCounters.get(sessionId) ?? 0;
}

function bumpTerminalWriteCounter(sessionId: string): void {
  terminalWriteCounters.set(sessionId, (terminalWriteCounters.get(sessionId) ?? 0) + 1);
}

function cleanTerminalSnapshotLine(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\x1b\].*?\x07/g, "")
    .replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, "")
    .trim();
}

function hasHighReplacementCharRatio(text: string): boolean {
  if (text.length === 0) return false;
  const replacements = [...text].filter((char) => char === "\uFFFD").length;
  return replacements / [...text].length > 0.3;
}

type TerminalBufferLineOptions = {
  excludeInitialReplay?: boolean;
};

export function hasTerminalBuffer(sessionId: string): boolean {
  return liveTerms.has(sessionId) || termCache.has(sessionId);
}

/** Read the last N non-empty logical lines of a pane's xterm buffer, ANSI/control-char stripped. */
export function getTerminalBufferLines(
  sessionId: string,
  maxLines: number,
  options: TerminalBufferLineOptions = {},
): string[] {
  const term = liveTerms.get(sessionId) ?? termCache.get(sessionId)?.term;
  if (!term || maxLines <= 0) return [];
  const hasLiveOutput = terminalHasLiveOutput.has(sessionId);
  if (options.excludeInitialReplay && !hasLiveOutput) return [];
  try {
    const buf = term.buffer.active;
    const bottom = buf.length - 1;
    if (bottom < 0) return [];
    const result: string[] = [];
    const replayMarker = options.excludeInitialReplay ? terminalInitialReplayMarkers.get(sessionId) : undefined;
    const replayBoundary = replayMarker && replayMarker.line >= 0 ? replayMarker.line : 0;
    const minLineIndex = Math.max(
      replayBoundary,
      bottom - maxLines * TERMINAL_SNAPSHOT_SCAN_MULTIPLIER,
    );

    let lineIndex = bottom;
    while (lineIndex >= minLineIndex && result.length < maxLines) {
      let firstLineIndex = lineIndex;
      let wrappedRows = 0;
      while (
        firstLineIndex > minLineIndex &&
        wrappedRows < TERMINAL_SNAPSHOT_MAX_WRAPPED_LINES &&
        buf.getLine(firstLineIndex)?.isWrapped
      ) {
        firstLineIndex--;
        wrappedRows++;
      }

      let logicalLine = "";
      for (let i = firstLineIndex; i <= lineIndex; i++) {
        const lineObj = buf.getLine(i);
        if (!lineObj) continue;
        const nextIsWrapped = i < lineIndex && Boolean(buf.getLine(i + 1)?.isWrapped);
        const part = lineObj.translateToString(!nextIsWrapped);
        const remaining = TERMINAL_SNAPSHOT_MAX_LINE_CHARS - logicalLine.length;
        if (remaining > 0) {
          logicalLine += part.slice(0, remaining);
        }
      }

      const text = cleanTerminalSnapshotLine(logicalLine);
      if (text.length > 0 && !hasHighReplacementCharRatio(text)) {
        result.push(text);
      }

      lineIndex = firstLineIndex - 1;
    }
    return result.reverse();
  } catch {
    return [];
  }
}
const HTTP_LINK_REGEX = /https?:\/\/[^\s"'<>+\uFF0B]+[^\s"'<>+\uFF0B.,!?;:)}\]]/i;
const ARTIFACT_EXTENSION_PATTERN = String.raw`html?|markdown|md|docx?|docm|dotx?|dotm|xlsx?|xlsm|xlsb|xltx?|xltm|pptx?|pptm|potx?|potm|ppsx?|ppsm`;
const ARTIFACT_LINK_TERMINATOR_PATTERN = String.raw`(?=$|[\s"'<>+\uFF0B.,!?;:)(}\]（）・。、，、])`;
// MSYS / Git-Bash absolute path form: `/c/Users/...`. The drive is a SINGLE
// letter between slashes, and the leading slash must start a fresh segment
// (lookbehind rejects `.../x/y.md` inside URLs or longer paths) so ordinary
// unix paths like `/home/...` or URL path segments never produce false links.
const MSYS_DRIVE_PREFIX_PATTERN = String.raw`(?<![A-Za-z0-9._\\/:])\/[A-Za-z]\/`;
const ARTIFACT_LINK_REGEX = new RegExp(
  String.raw`(?:file:\/\/\/[^\r\n"'<>+\uFF0B]*?\.(?:${ARTIFACT_EXTENSION_PATTERN})|[A-Za-z]:[\\/](?![\\/])[^\r\n"'<>+\uFF0B]*?\.(?:${ARTIFACT_EXTENSION_PATTERN})|${MSYS_DRIVE_PREFIX_PATTERN}[^\r\n"'<>+\uFF0B]*?\.(?:${ARTIFACT_EXTENSION_PATTERN}))${ARTIFACT_LINK_TERMINATOR_PATTERN}`,
  "gi",
);
const COMPLETE_ARTIFACT_EXTENSION_REGEX = new RegExp(
  String.raw`\.(?:${ARTIFACT_EXTENSION_PATTERN})${ARTIFACT_LINK_TERMINATOR_PATTERN}`,
  "i",
);
const CODING_AGENT_HINT_PATTERN = /\b(?:ctrl|cmd|alt|shift)\+[\w?]+/gi;
const ARTIFACT_LINK_CONTEXT_LINES = 16;
const ARTIFACT_LINK_MAX_WRAPPED_LINES = 64;
const ARTIFACT_LINK_MAX_SEGMENT_CHARS = 8192;
const ARTIFACT_LINK_CANDIDATE_PREFIX_REGEX =
  /(?:file:\/\/\/|[A-Za-z]:[\\/]|(?<![A-Za-z0-9._\\/:])\/[A-Za-z]\/)/i;

type ArtifactLinkPart = {
  text: string;
  lineIndex?: number;
  nextLineIndex?: number;
};

function cellXForStringOffset(line: ReturnType<Terminal["buffer"]["active"]["getLine"]>, offset: number): number {
  if (!line || offset <= 0) return 0;
  let stringOffset = 0;
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    if (stringOffset >= offset) return x;
    stringOffset += cell.getChars().length || 1;
    if (stringOffset > offset) return x;
  }
  return line.length;
}

function mapWrappedStringOffset(
  term: Terminal,
  parts: ArtifactLinkPart[],
  offset: number,
  preferPreviousBoundary: boolean,
): { lineIndex: number; cellX: number } {
  let accumulated = 0;
  let previousLineIndex = 0;
  for (const part of parts) {
    const textLength = part.text.length;
    const boundaryAtEnd = offset === accumulated + textLength;
    if (offset < accumulated + textLength || (preferPreviousBoundary && boundaryAtEnd)) {
      if (part.lineIndex === undefined) {
        const lineIndex = preferPreviousBoundary ? previousLineIndex : (part.nextLineIndex ?? previousLineIndex);
        const line = term.buffer.active.getLine(lineIndex);
        return { lineIndex, cellX: preferPreviousBoundary ? line?.translateToString(true).length ?? 0 : 0 };
      }
      const lineIndex = part.lineIndex;
      const line = term.buffer.active.getLine(lineIndex);
      const localOffset = Math.max(0, Math.min(offset - accumulated, textLength));
      previousLineIndex = lineIndex;
      return { lineIndex, cellX: cellXForStringOffset(line, localOffset) };
    }
    if (part.lineIndex !== undefined) {
      previousLineIndex = part.lineIndex;
    }
    accumulated += textLength;
  }
  return { lineIndex: previousLineIndex, cellX: 0 };
}

function hasOpenArtifactPath(text: string): boolean {
  const startMatches = [...text.matchAll(/(?:file:\/\/\/|[A-Za-z]:[\\/]|(?<![A-Za-z0-9._\\/:])\/[A-Za-z]\/)/gi)];
  const lastStart = startMatches[startMatches.length - 1];
  if (!lastStart || lastStart.index === undefined) return false;
  const tail = text.slice(lastStart.index);
  return !COMPLETE_ARTIFACT_EXTENSION_REGEX.test(tail);
}

function hasArtifactLinkCandidate(text: string): boolean {
  return text.includes("file:///") || ARTIFACT_LINK_CANDIDATE_PREFIX_REGEX.test(text);
}

function looksLikeArtifactContinuation(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.length > 0 && !/^[|>*#●・-]\s/.test(trimmed);
}

function artifactContinuationJoiner(previousText: string, nextText: string): string {
  const previous = previousText.trimEnd();
  const next = nextText.trimStart();
  if (!previous || !next) return "";
  if (next.startsWith("/") || next.startsWith("\\") || previous.endsWith("/") || previous.endsWith("\\")) return "";
  if (/\s$/.test(previousText) || /^\s/.test(nextText)) return "";
  return " ";
}

function normalizeSoftWrappedArtifactLine(text: string, nextText: string): string {
  if (!/\s$/.test(text)) return text;
  const trimmed = text.trimEnd();
  const next = nextText.trimStart();
  if (!trimmed || !next) return trimmed;
  if (next.startsWith("/") || next.startsWith("\\") || trimmed.endsWith("/") || trimmed.endsWith("\\")) {
    return trimmed;
  }
  return `${trimmed} `;
}

function registerArtifactLinkProvider(term: Terminal, onActivate: (uri: string) => void) {
  return term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const buffer = term.buffer.active;
      const targetLineIndex = bufferLineNumber - 1;
      if (targetLineIndex < 0 || targetLineIndex >= buffer.length) {
        callback(undefined);
        return;
      }

      let firstLineIndex = targetLineIndex;
      let wrappedBefore = 0;
      while (
        firstLineIndex > 0 &&
        wrappedBefore < ARTIFACT_LINK_MAX_WRAPPED_LINES &&
        buffer.getLine(firstLineIndex)?.isWrapped
      ) {
        firstLineIndex--;
        wrappedBefore++;
      }
      firstLineIndex = Math.max(0, firstLineIndex - ARTIFACT_LINK_CONTEXT_LINES);
      let lastLineIndex = targetLineIndex;
      let wrappedAfter = 0;
      while (
        lastLineIndex + 1 < buffer.length &&
        wrappedAfter < ARTIFACT_LINK_MAX_WRAPPED_LINES &&
        buffer.getLine(lastLineIndex + 1)?.isWrapped
      ) {
        lastLineIndex++;
        wrappedAfter++;
      }
      lastLineIndex = Math.min(buffer.length - 1, lastLineIndex + ARTIFACT_LINK_CONTEXT_LINES);

      let candidateScanTail = "";
      let hasCandidate = false;
      for (let lineIndex = firstLineIndex; lineIndex <= lastLineIndex; lineIndex++) {
        const scanText = `${candidateScanTail}${buffer.getLine(lineIndex)?.translateToString(true) ?? ""}`;
        if (hasArtifactLinkCandidate(scanText)) {
          hasCandidate = true;
          break;
        }
        candidateScanTail = scanText.slice(-16);
      }
      if (!hasCandidate) {
        callback(undefined);
        return;
      }

      const parts: ArtifactLinkPart[] = [];
      let segmentText = "";
      let previousText = "";
      let segmentJoinBlocked = false;
      for (let lineIndex = firstLineIndex; lineIndex <= lastLineIndex; lineIndex++) {
        const line = buffer.getLine(lineIndex);
        const isCurrentLineWrapped = Boolean(line?.isWrapped);
        if (!isCurrentLineWrapped) {
          segmentJoinBlocked = false;
        }
        const nextIsWrapped = Boolean(buffer.getLine(lineIndex + 1)?.isWrapped);
        const rawLineText = line?.translateToString(false) ?? "";
        const trimmedLineText = line?.translateToString(true) ?? "";
        const nextLineText = buffer.getLine(lineIndex + 1)?.translateToString(true) ?? "";
        const lineText = nextIsWrapped
          ? normalizeSoftWrappedArtifactLine(rawLineText, nextLineText)
          : trimmedLineText;
        if (lineIndex > firstLineIndex) {
          const canJoinSegment = !segmentJoinBlocked;
          const isSoftContinuation = canJoinSegment && isCurrentLineWrapped;
          const isHardArtifactContinuation =
            canJoinSegment && hasOpenArtifactPath(segmentText) && looksLikeArtifactContinuation(lineText);
          const joiner = isSoftContinuation
            ? ""
            : isHardArtifactContinuation
              ? artifactContinuationJoiner(previousText, lineText)
              : "\n";
          parts.push({ text: joiner, nextLineIndex: lineIndex });
          if (joiner === "\n") {
            segmentText = "";
          } else {
            segmentText += joiner;
            if (segmentText.length > ARTIFACT_LINK_MAX_SEGMENT_CHARS) {
              segmentText = "";
              segmentJoinBlocked = true;
            }
          }
        }
        parts.push({ text: lineText, lineIndex });
        if (segmentJoinBlocked || segmentText.length + lineText.length > ARTIFACT_LINK_MAX_SEGMENT_CHARS) {
          segmentText = "";
          previousText = "";
          segmentJoinBlocked = true;
        } else {
          segmentText += lineText;
          previousText = lineText;
        }
      }
      const text = parts.map((part) => part.text).join("");
      const regex = new RegExp(ARTIFACT_LINK_REGEX.source, ARTIFACT_LINK_REGEX.flags);
      const links: ILink[] = [];
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text))) {
        const uri = match[0];
        const start = mapWrappedStringOffset(term, parts, match.index, false);
        const end = mapWrappedStringOffset(term, parts, match.index + uri.length, true);
        const link: ILink = {
          range: {
            start: { x: start.cellX + 1, y: start.lineIndex + 1 },
            end: { x: Math.max(1, end.cellX), y: end.lineIndex + 1 },
          },
          text: uri,
          activate: () => onActivate(uri),
        };
        if (link.range.start.y <= bufferLineNumber && link.range.end.y >= bufferLineNumber) {
          links.push(link);
        }
      }
      callback(links.length > 0 ? links : undefined);
    },
  });
}

function isShortcutHintLine(line: string): boolean {
  const shortcutCount = (line.match(CODING_AGENT_HINT_PATTERN) ?? []).length;
  return (
    shortcutCount >= 2
    || /shift\+enter/i.test(line)
    || /enter\s+(?:to|=)\s*(?:send|submit|continue|confirm)/i.test(line)
    || /esc\s+to\s+(?:interrupt|cancel)/i.test(line)
  );
}

function getShiftEnterSequence(command: string, processTitle?: string): string {
  const commandParts = command.split(/[\\/]/);
  const commandName = commandParts[commandParts.length - 1]
    ?.replace(/\.exe$/i, "")
    .toLowerCase();
  const processParts = processTitle?.split(/[\\/]/);
  const processName = processParts?.[processParts.length - 1]
    ?.replace(/\.exe$/i, "")
    .toLowerCase();
  if (commandName === "codex" || processName === "codex") {
    return "\x1b[13;2u";
  }
  return "\x1b[200~\n\x1b[201~";
}

function getCommandName(command: string): string {
  return command
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.(exe|cmd|bat|com)$/i, "")
    .toLowerCase() ?? "";
}

function startsAsCodex(
  command: string,
  args: string[],
  agentId?: string,
  agentKind?: string,
  launchEnv?: Record<string, string>,
): boolean {
  if (agentId === "codex" || agentKind === "codex" || agentKind === "claude-codex") return true;
  if (
    launchEnv?.MYCMUX_AGENT_KIND === "codex"
    || launchEnv?.MYCMUX_AGENT_KIND === "claude-codex"
    || launchEnv?.MYCMUX_RESUME === "codex"
    || launchEnv?.MYCMUX_RESUME === "claude-codex"
  ) {
    return true;
  }
  if (getCommandName(command) === "codex") return true;
  return args.some((arg) => getCommandName(arg) === "codex");
}

function looksLikeCodexModelStatusLine(line: string): boolean {
  return /\bgpt-5(?:\.\d+)?\b.*[\u00b7\u2022]\s*(?:~|[A-Za-z]:\\|\/)/i.test(line);
}

function looksLikeCodexPromptLine(line: string): boolean {
  return (
    /^\s*[›❯>»▶▸]\s+/.test(line)
    && !/\b(?:working|thinking|running|executing|searching|analyzing)\b/i.test(line)
  ) || looksLikeCodexModelStatusLine(line);
}

function looksLikeCodexOutput(text: string): boolean {
  return (
    /\bOpenAI\s+Codex\b/i.test(text)
    || /\bCodex session starting\b/i.test(text)
    || text.split(/\r?\n/).some((line) => looksLikeCodexPromptLine(line.trim()))
  );
}

function ensureConfigLoaded(): Promise<void> {
  if (cachedConfig) return Promise.resolve();
  if (configPromise) return configPromise;
  configPromise = getTerminalConfig()
    .then((cfg) => {
      // Ghostty/native terminals use physical pixels; xterm.js in a webview uses CSS pixels.
      // Scale up: values below 12 are physical-pixel sizes (e.g. Ghostty font-size = 9)
      // and need to be multiplied to look correct in the webview.
      const rawSize = cfg.font_size;
      const scaled = rawSize < 12 ? Math.round(rawSize * 1.6) : rawSize;
      const fontSize = Math.max(14, scaled);
      cachedConfig = {
        theme: buildThemeFromConfig(cfg),
        fontSize,
        fontFamily: `'${cfg.font_family}', monospace`,
      };
    })
    .catch(() => {
      cachedConfig = null;
      configPromise = null;
    });
  return configPromise;
}

export default memo(function XTermWrapper({
  sessionId,
  command,
  args = [],
  agentId,
  agentKind,
  onExit,
  theme,
  fontSize,
  fontFamily,
  onZoomToggle,
  onUrlClick,
  cwd,
  launchEnv,
  initialReplay,
}: XTermWrapperProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const isAtBottomRef = useRef(true);
  const syncResizeRef = useRef<(force?: boolean) => void>(() => {});

  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const storeTheme = useThemeStore((s) => s.theme);
  const storeFontSize = useThemeStore((s) => s.fontSize);
  const storeFontFamily = useThemeStore((s) => s.fontFamily);
  const storeBackground = useThemeStore((s) => s.themeTweaks.background);
  const mediaBackgroundActive = storeBackground.mode === "preset" || (
    storeBackground.mode === "image" && storeBackground.imagePath.length > 0
  );
  const terminalOpacity = mediaBackgroundActive ? storeBackground.terminalOpacity : 1;

  // Single source of truth: is this tab the currently-focused terminal?
  // Used for scroll-to-bottom-on-activate.
  const isActivePane = useUiStore((s) => s.activePaneId === sessionId);

  // Dynamically update terminal theme and font size
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = withTerminalOpacity(storeTheme.terminal, terminalOpacity, mediaBackgroundActive);
      termRef.current.options.minimumContrastRatio = minContrastFor(mediaBackgroundActive);
      termRef.current.options.fontSize = storeFontSize;
      termRef.current.options.fontFamily = storeFontFamily;
      setTimeout(() => syncResizeRef.current(true), 10);
    }
  }, [storeTheme, storeFontSize, storeFontFamily, terminalOpacity, mediaBackgroundActive]);

  // Scroll to bottom when this tab becomes active only if the user was already at bottom.
  useEffect(() => {
    if (isActivePane && termRef.current) {
      setTimeout(() => {
        syncResizeRef.current(true);
        if (isAtBottomRef.current) {
          termRef.current?.scrollToBottom();
        }
      }, 50);
    }
  }, [isActivePane]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let termDisposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let resizeTimers: ReturnType<typeof setTimeout>[] = [];
    let unlistenExit: (() => void) | null = null;
    let writeParsedDisposable: { dispose: () => void } | null = null;
    let scrollDisposable: { dispose: () => void } | null = null;
    let dataDisposable: { dispose: () => void } | null = null;
    let binaryDisposable: { dispose: () => void } | null = null;
    let titleDisposable: { dispose: () => void } | null = null;
    let term: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let removeCompositionGuard: (() => void) | null = null;
    let removeWheelScrollGuard: (() => void) | null = null;
    let removeFocusSync: (() => void) | null = null;
    let logThrottle: ReturnType<typeof setTimeout> | null = null;
    let idleFlush: ReturnType<typeof setTimeout> | null = null;
    let backgroundScanThrottle: ReturnType<typeof setTimeout> | null = null;
    let startupSettleTimeout: ReturnType<typeof setTimeout> | null = null;
    let startupSettled = false;
    let sessionStarted = false;
    let lastLogLine = "";
    let lastScanSignature = "";
    let isImeComposing = false;
    let resizePendingDuringComposition = false;
    let formatsCodexOutput = startsAsCodex(command, args, agentId, agentKind, launchEnv);
    let codexDetectionBuffer = "";
    const outputDecoder = new TextDecoder();
    const diagStats = diagStatsFor(sessionId);
    const pendingBatches: FrontendDataBatch[] = [];
    let writingBatch = false;
    let frontendVisible: boolean | null = null;
    let visibilityObserver: MutationObserver | null = null;
    let lastObservedWidth = -1;
    let lastObservedHeight = -1;
    const cachedSize = terminalSizeCache.get(sessionId);
    let lastSentCols = cachedSize?.cols ?? -1;
    let lastSentRows = cachedSize?.rows ?? -1;

    const clearResizeTimer = (): void => {
      for (const timer of resizeTimers) {
        clearTimeout(timer);
      }
      resizeTimers = [];
    };

    const clearScanTimers = (): void => {
      if (startupSettleTimeout) {
        clearTimeout(startupSettleTimeout);
        startupSettleTimeout = null;
      }
      if (logThrottle) {
        clearTimeout(logThrottle);
        logThrottle = null;
      }
      if (idleFlush) {
        clearTimeout(idleFlush);
        idleFlush = null;
      }
      if (backgroundScanThrottle) {
        clearTimeout(backgroundScanThrottle);
        backgroundScanThrottle = null;
      }
    };

    const updateCodexOutputDetection = (text: string): boolean => {
      if (!formatsCodexOutput && text.length > 0) {
        codexDetectionBuffer = `${codexDetectionBuffer}${text}`.slice(-4096);
      }
      if (!formatsCodexOutput && looksLikeCodexOutput(codexDetectionBuffer || text)) {
        formatsCodexOutput = true;
      }
      return formatsCodexOutput;
    };

    const settleStartupSession = (): void => {
      if (startupSettled) {
        return;
      }
      startupSettled = true;
      if (startupSettleTimeout) {
        clearTimeout(startupSettleTimeout);
        startupSettleTimeout = null;
      }
      markStartupSessionSettled(sessionId);
    };

    const rememberContainerSize = (): boolean => {
      const rect = container.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (width === lastObservedWidth && height === lastObservedHeight) {
        return false;
      }
      lastObservedWidth = width;
      lastObservedHeight = height;
      return true;
    };

    const refreshVisibleRows = (currentTerm: Terminal): void => {
      if (disposed || termDisposed || currentTerm.rows <= 0) return;
      try {
        currentTerm.clearTextureAtlas();
      } catch {
        // DOM renderer does not need the atlas.
      }
      try {
        currentTerm.refresh(0, Math.max(0, currentTerm.rows - 1));
      } catch {
        // Terminal was disposed between scheduling and refresh.
      }
    };

    const scheduleFullRefresh = (
      currentTerm: Terminal,
      delays: readonly number[] = [0, 48, 160],
    ): void => {
      for (const delay of delays) {
        const timer = setTimeout(() => {
          resizeTimers = resizeTimers.filter((entry) => entry !== timer);
          refreshVisibleRows(currentTerm);
        }, delay);
        resizeTimers.push(timer);
      }
    };

    const fitAndSyncResize = (currentTerm: Terminal, currentFitAddon: FitAddon, force = false): void => {
      if (disposed || termDisposed) return;
      if (isImeComposing) {
        resizePendingDuringComposition = true;
        return;
      }

      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const containerSizeChanged = rememberContainerSize();
      if (!force && !containerSizeChanged) return;

      try {
        currentFitAddon.fit();
      } catch {
        return;
      }

      if (currentTerm.cols <= 0 || currentTerm.rows <= 0) return;
      const terminalSizeChanged = currentTerm.cols !== lastSentCols || currentTerm.rows !== lastSentRows;

      if (!terminalSizeChanged) {
        if (force || containerSizeChanged) {
          scheduleFullRefresh(currentTerm);
        }
        return;
      }

      const nextCols = currentTerm.cols;
      const nextRows = currentTerm.rows;
      lastSentCols = nextCols;
      lastSentRows = nextRows;
      terminalSizeCache.set(sessionId, { cols: nextCols, rows: nextRows });
      if (sessionStarted) {
        resizeSession(sessionId, nextCols, nextRows)
          .then(() => scheduleFullRefresh(currentTerm, [16, 80, 200]))
          .catch((error) => {
            console.error(error);
            scheduleFullRefresh(currentTerm, [16, 120]);
          });
      } else {
        scheduleFullRefresh(currentTerm);
      }
    };

    syncResizeRef.current = (force = false) => {
      if (!term || !fitAddon) return;
      fitAndSyncResize(term, fitAddon, force);
    };

    const scheduleResize = (currentTerm: Terminal, currentFitAddon: FitAddon, delay: number, force = false): void => {
      if (isImeComposing) {
        resizePendingDuringComposition = true;
        return;
      }
      const timer = setTimeout(() => {
        resizeTimers = resizeTimers.filter((entry) => entry !== timer);
        fitAndSyncResize(currentTerm, currentFitAddon, force);
      }, delay);
      resizeTimers.push(timer);
    };

    const scheduleResizeBurst = (currentTerm: Terminal, currentFitAddon: FitAddon): void => {
      clearResizeTimer();
      scheduleResize(currentTerm, currentFitAddon, 24, true);
      scheduleResize(currentTerm, currentFitAddon, 100, true);
      scheduleResize(currentTerm, currentFitAddon, 240, true);
    };

    const registerResizeObserver = (currentTerm: Terminal, currentFitAddon: FitAddon): void => {
      resizeObserver?.disconnect();
      resizeObserver = new ResizeObserver(() => {
        refreshFrontendVisible();
        scheduleResizeBurst(currentTerm, currentFitAddon);
        if (pendingBatches.length > 0 && canWritePendingBatches()) {
          void pumpTerminalWrites();
        }
      });
      resizeObserver.observe(container);
    };

    const registerScrollListener = (currentTerm: Terminal): void => {
      scrollDisposable?.dispose();
      scrollDisposable = currentTerm.onScroll(() => {
        if (termDisposed) return;
        const buf = currentTerm.buffer.active;
        isAtBottomRef.current = buf.viewportY >= buf.baseY;
      });
    };

    const registerCompositionGuard = (currentTerm: Terminal, currentFitAddon: FitAddon): void => {
      removeCompositionGuard?.();
      const textarea = currentTerm.textarea;
      if (!textarea) {
        removeCompositionGuard = null;
        return;
      }

      const handleCompositionStart = (): void => {
        isImeComposing = true;
        resizePendingDuringComposition = false;
        clearResizeTimer();
      };
      const handleCompositionEnd = (): void => {
        isImeComposing = false;
        if (resizePendingDuringComposition) {
          resizePendingDuringComposition = false;
          scheduleResize(currentTerm, currentFitAddon, 80, true);
        }
      };

      textarea.addEventListener("compositionstart", handleCompositionStart);
      textarea.addEventListener("compositionend", handleCompositionEnd);
      removeCompositionGuard = () => {
        textarea.removeEventListener("compositionstart", handleCompositionStart);
        textarea.removeEventListener("compositionend", handleCompositionEnd);
      };
    };

    const attachTerminalKeyHandler = (currentTerm: Terminal): void => {
      currentTerm.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if (e.type !== "keydown") return true;

        if (e.key === "v" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
          return false;
        }

        if (e.isComposing || e.key === "Process" || e.keyCode === 229) {
          return true;
        }

        if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey) {
          const processTitle = usePaneMetadataStore.getState().metadata[sessionId]?.processTitle;
          enqueueSessionWrite(sessionId, getShiftEnterSequence(command, processTitle));
          return false;
        }

        if (isPlainTerminalInputEvent(e)) {
          e.stopPropagation();
          return true;
        }

        const keybindingStore = useKeybindingStore.getState();
        const actions = keybindingStore.getActionsForEvent(e);

        if (actions.length > 0) {
          // Actions handled inline here must NOT also reach AppShell's
          // window-level keydown dispatcher, or they fire twice. For toggle
          // actions (pane.zoom.toggle) the second fire cancels the first,
          // leaving the shortcut dead in terminal panes. Returning false only
          // tells xterm to skip PTY forwarding — it does NOT stop DOM
          // propagation — so we stop it explicitly here. Other matched actions
          // fall through to `return false` below and intentionally keep
          // bubbling to AppShell, which is their sole handler.
          if (actions.includes("terminal.search")) {
            e.preventDefault();
            e.stopPropagation();
            setIsSearchOpen(true);
            setTimeout(() => searchInputRef.current?.focus(), 50);
            return false;
          }

          if (actions.includes("pane.zoom.toggle")) {
            e.preventDefault();
            e.stopPropagation();
            onZoomToggle?.();
            return false;
          }

          return false;
        }

        return true;
      });
    };

    const runScan = (allowDetached = false): void => {
      if (!term || termDisposed || (!allowDetached && disposed)) return;
      let buf;
      try {
        buf = term.buffer.active;
      } catch {
        return;
      }

      const bottom = buf.length - 1;
      const top = Math.max(0, bottom - 15);
      const scanLines: string[] = [];
      let lastNonEmpty = "";
      for (let i = top; i <= bottom; i++) {
        const lineObj = buf.getLine(i);
        if (!lineObj) continue;
        const text = lineObj
          .translateToString(true)
          .replace(/\x1b\[[0-9;]*m/g, "")
          .trim();
        if (text.length > 0) {
          scanLines.push(text);
          lastNonEmpty = text;
        }
      }
      if (scanLines.length === 0) return;

      const signature = scanLines.slice(-3).join("\n");
      const scanChanged = signature !== lastScanSignature;
      lastScanSignature = signature;

      const isNoiseLine =
        /\d+k?\s+tokens/i.test(lastNonEmpty) ||
        /access \d+/i.test(lastNonEmpty) ||
        /past research/i.test(lastNonEmpty) ||
        /http:\/\/localhost/i.test(lastNonEmpty) ||
        isShortcutHintLine(lastNonEmpty) ||
        /^\s*[\u2500-\u257F]+\s*$/.test(lastNonEmpty) ||
        lastNonEmpty.length < 3;
      const logChanged = lastNonEmpty !== lastLogLine;
      if (!isNoiseLine && logChanged) {
        lastLogLine = lastNonEmpty;
        usePaneMetadataStore.getState().setMetadata(sessionId, {
          lastLogLine: lastNonEmpty,
        });
      }

      const approvalPatternId = scanForApproval(scanLines);
      if (approvalPatternId > 0) {
        usePaneMetadataStore.getState().setMetadata(sessionId, {
          agentStatus: "waiting",
        });
        const activePaneId = useUiStore.getState().activePaneId;
        if (activePaneId !== sessionId && useSettingsStore.getState().notificationsEnabled) {
          const didNotify = usePaneMetadataStore.getState().notifyWaiting(sessionId, approvalPatternId);
          if (didNotify && useSettingsStore.getState().notificationSoundEnabled) {
            playNotificationSound();
          }
        }
      } else if (scanChanged) {
        const prevStatus = usePaneMetadataStore.getState().metadata[sessionId]?.agentStatus;
        if (prevStatus === "waiting") {
          usePaneMetadataStore.getState().clearAgentStatus(sessionId);
        }
      }
    };

    const scheduleBackgroundScan = (): void => {
      if (!term || backgroundScanThrottle) return;
      backgroundScanThrottle = setTimeout(() => {
        backgroundScanThrottle = null;
        runScan(true);
      }, 150);
    };

    const batchDataToBytes = (data: FrontendDataBatch["data"]): Uint8Array => {
      if (data instanceof Uint8Array) return data;
      if (data instanceof ArrayBuffer) return new Uint8Array(data);
      return new Uint8Array(data);
    };

    const ackBatch = async (batch: FrontendDataBatch): Promise<void> => {
      try {
        await ackFrontendData(sessionId, batch.generation, batch.seq, batch.bytes);
      } catch (err) {
        if (import.meta.env.DEV) {
          console.warn("[mycmux-diag ipc] failed to ack frontend data:", err);
        }
      }
    };

    const isContainerDisplayed = (): boolean => {
      if (!container.isConnected) return false;
      let current: HTMLElement | null = container;
      while (current) {
        const style = window.getComputedStyle(current);
        if (
          style.display === "none"
          || style.visibility === "hidden"
          || style.visibility === "collapse"
        ) {
          return false;
        }
        current = current.parentElement;
      }
      return true;
    };

    const hasWritableTerminalSize = (): boolean => {
      const rect = container.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const canWritePendingBatches = (): boolean => {
      return Boolean(term && !termDisposed && isContainerDisplayed() && hasWritableTerminalSize());
    };

    const setFrontendVisibleIfChanged = (visible: boolean): void => {
      if (frontendVisible === visible) return;
      frontendVisible = visible;
      void setFrontendVisible(sessionId, visible);
    };

    const refreshFrontendVisible = (): void => {
      setFrontendVisibleIfChanged(Boolean(term && !termDisposed && isContainerDisplayed()));
    };

    const startVisibilityObserver = (): void => {
      visibilityObserver?.disconnect();
      visibilityObserver = new MutationObserver(() => {
        refreshFrontendVisible();
        if (pendingBatches.length > 0) {
          void pumpTerminalWrites();
        }
      });
      let current: HTMLElement | null = container;
      while (current) {
        visibilityObserver.observe(current, {
          attributes: true,
          attributeFilter: ["class", "style", "hidden", "aria-hidden"],
        });
        current = current.parentElement;
      }
      window.addEventListener("focus", refreshFrontendVisible);
      window.addEventListener("blur", refreshFrontendVisible);
      document.addEventListener("visibilitychange", refreshFrontendVisible);
      refreshFrontendVisible();
    };

    const stopVisibilityObserver = (): void => {
      visibilityObserver?.disconnect();
      visibilityObserver = null;
      window.removeEventListener("focus", refreshFrontendVisible);
      window.removeEventListener("blur", refreshFrontendVisible);
      document.removeEventListener("visibilitychange", refreshFrontendVisible);
    };

    const writeTerminalOutput = (output: string | Uint8Array): Promise<void> => {
      return new Promise((resolve) => {
        if (!term || termDisposed) {
          resolve();
          return;
        }
        let settled = false;
        const watchdog = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve();
        }, 30000);
        const finish = (): void => {
          if (settled) return;
          settled = true;
          window.clearTimeout(watchdog);
          resolve();
        };
        try {
          term.write(output, finish);
        } catch {
          finish();
        }
      });
    };

    async function pumpTerminalWrites(): Promise<void> {
      if (writingBatch) return;
      writingBatch = true;
      try {
        while (pendingBatches.length > 0) {
          const batch = pendingBatches.shift()!;
          if (!term || termDisposed) {
            await ackBatch(batch);
            continue;
          }
          if (!canWritePendingBatches()) {
            pendingBatches.unshift(batch);
            break;
          }
          try {
            settleStartupSession();
            const chunk = batchDataToBytes(batch.data);
            if (chunk.byteLength > 0 && !terminalHasLiveOutput.has(sessionId)) {
              terminalHasLiveOutput.add(sessionId);
            }
            const decodedText = outputDecoder.decode(chunk, { stream: true });
            const shouldFormatTables = updateCodexOutputDetection(decodedText);
            const output = shouldFormatTables ? formatMarkdownTablesForTerminal(decodedText) : chunk;
            if (import.meta.env.DEV) {
              diagStats.writes += 1;
              diagStats.bytes += typeof output === "string" ? new Blob([output]).size : output.byteLength;
            }
            bumpTerminalWriteCounter(sessionId);
            await writeTerminalOutput(output);
            if (!disposed && !termDisposed) {
              scheduleBackgroundScan();
            }
          } finally {
            await ackBatch(batch);
          }
        }
      } finally {
        writingBatch = false;
        if (pendingBatches.length > 0 && canWritePendingBatches()) {
          void pumpTerminalWrites();
        }
      }
    }

    const enqueueFrontendBatch = (batch: FrontendDataBatch): void => {
      pendingBatches.push(batch);
      if (canWritePendingBatches()) {
        void pumpTerminalWrites();
      }
    };

    const attachFrontendChannel = async (cols: number, rows: number): Promise<void> => {
      await createSession(
        sessionId,
        command,
        args,
        cols,
        rows,
        enqueueFrontendBatch,
        cwd,
        launchEnv || undefined,
      );
      refreshFrontendVisible();
    };

    const registerScanListener = (currentTerm: Terminal): void => {
      writeParsedDisposable?.dispose();
      writeParsedDisposable = currentTerm.onWriteParsed(() => {
        if (disposed) return;
        if (idleFlush) {
          clearTimeout(idleFlush);
          idleFlush = null;
        }
        idleFlush = setTimeout(() => {
          idleFlush = null;
          runScan();
        }, 200);
        if (logThrottle) return;
        logThrottle = setTimeout(() => {
          logThrottle = null;
          runScan();
        }, 150);
      });
    };

    const registerExitListener = async (): Promise<void> => {
      const nextUnlisten = await onPtyExit(sessionId, () => {
        if (disposed || !sessionStarted) return;
        onExit?.();
      });
      if (disposed) {
        nextUnlisten();
        return;
      }
      unlistenExit?.();
      unlistenExit = nextUnlisten;
    };

    const registerInputListeners = (currentTerm: Terminal): void => {
      dataDisposable?.dispose();
      binaryDisposable?.dispose();
      titleDisposable?.dispose();

      dataDisposable = currentTerm.onData((data) => {
        const inputData = stripTerminalMouseInputSequences(data);
        if (!inputData) return;
        if (useUiStore.getState().activePaneId !== sessionId) {
          useUiStore.getState().setActivePaneId(sessionId);
        }
        usePaneMetadataStore.getState().clearNotification(sessionId);
        chunkedWrite(sessionId, inputData);
        try {
          window.dispatchEvent(
            new CustomEvent("mycmux:keystroke", { detail: { sessionId, data: inputData } }),
          );
        } catch {
          // ignore dispatch failures; buddy is non-critical
        }
      });

      binaryDisposable = currentTerm.onBinary((data) => {
        const inputData = stripTerminalMouseInputSequences(data);
        if (!inputData) return;
        if (useUiStore.getState().activePaneId !== sessionId) {
          useUiStore.getState().setActivePaneId(sessionId);
        }
        usePaneMetadataStore.getState().clearNotification(sessionId);
        enqueueSessionWrite(sessionId, inputData);
      });

      titleDisposable = currentTerm.onTitleChange((title) => {
        if (termDisposed || !title) return;
        usePaneMetadataStore.getState().setMetadata(sessionId, { processTitle: title });
      });
    };

    const cacheCurrentTerminal = (): void => {
      const currentSearchAddon = searchAddonRef.current;
      if (term && term.element && fitAddon && currentSearchAddon) {
        const element = term.element;
        if (element.parentNode === container) {
          container.removeChild(element);
        }
        termCache.set(sessionId, {
          term,
          fitAddon,
          searchAddon: currentSearchAddon,
          xtermElement: element,
          unlistenExit: null,
        });
        return;
      }
      if (term) {
        termDisposed = true;
        term.dispose();
      }
    };

    const cleanup = (): void => {
      clearResizeTimer();
      clearScanTimers();
      stopVisibilityObserver();
      setFrontendVisibleIfChanged(false);
      resizeObserver?.disconnect();
      resizeObserver = null;
      disposed = true;
      writeParsedDisposable?.dispose();
      writeParsedDisposable = null;
      scrollDisposable?.dispose();
      scrollDisposable = null;
      dataDisposable?.dispose();
      dataDisposable = null;
      binaryDisposable?.dispose();
      binaryDisposable = null;
      titleDisposable?.dispose();
      titleDisposable = null;
      removeCompositionGuard?.();
      removeCompositionGuard = null;
      removeWheelScrollGuard?.();
      removeWheelScrollGuard = null;
      removeFocusSync?.();
      removeFocusSync = null;
      disposeSelectionCopyListener(term);
      unlistenExit?.();
      unlistenExit = null;
      cacheCurrentTerminal();
      if (term && liveTerms.get(sessionId) === term) {
        liveTerms.delete(sessionId);
      }
      if (termDisposed) {
        while (pendingBatches.length > 0) {
          const batch = pendingBatches.shift()!;
          void ackBatch(batch);
        }
      }
      searchAddonRef.current = null;
      termRef.current = null;
      fitAddonRef.current = null;
      syncResizeRef.current = () => {};
    };

    const attachCachedTerminal = (cached: CachedTerm): void => {
      cached.unlistenExit?.();
      termCache.delete(sessionId);
      container.appendChild(cached.xtermElement);
      term = cached.term;
      fitAddon = cached.fitAddon;
      sessionStarted = true;
      liveTerms.set(sessionId, cached.term);
      termRef.current = cached.term;
      fitAddonRef.current = cached.fitAddon;
      searchAddonRef.current = cached.searchAddon;
      cached.term.options.theme = withTerminalOpacity(storeTheme.terminal, terminalOpacity, mediaBackgroundActive);
      cached.term.options.minimumContrastRatio = minContrastFor(mediaBackgroundActive);
      cached.term.options.fontSize = storeFontSize;
      cached.term.options.fontFamily = storeFontFamily;
      cached.term.options.altClickMovesCursor = false;
      registerScrollListener(cached.term);
      registerCompositionGuard(cached.term, cached.fitAddon);
      registerSelectionCopyListener(cached.term);
      removeWheelScrollGuard = attachTerminalWheelScroll(cached.term);
      removeFocusSync = registerTerminalFocusSync(cached.term, sessionId);
      const cachedBufferText = getTerminalBufferLines(sessionId, 80).join("\n");
      updateCodexOutputDetection(cachedBufferText);
      attachTerminalKeyHandler(cached.term);
      registerInputListeners(cached.term);
      registerScanListener(cached.term);
      void registerExitListener();
      setTimeout(() => {
        if (disposed || termDisposed) return;
        fitAndSyncResize(cached.term, cached.fitAddon, true);
      }, 30);
      registerResizeObserver(cached.term, cached.fitAddon);
      startVisibilityObserver();
    };

    const cached = termCache.get(sessionId);
    if (cached) {
      console.log(`[mycmux-diag xterm:${sessionId}] cache_hit`);
      attachCachedTerminal(cached);
      void attachFrontendChannel(cached.term.cols, cached.term.rows).catch((err) => {
        console.error("[XTermWrapper] Failed to reattach session:", err);
      });
      return cleanup;
    }
    console.log(`[mycmux-diag xterm:${sessionId}] cache_miss`);

    async function init(): Promise<void> {
      if (disposed) return;
      const cfg = cachedConfig;
      const initTheme = withTerminalOpacity(theme ?? storeTheme.terminal, terminalOpacity, mediaBackgroundActive);
      const baseFontSize = fontSize ?? storeFontSize ?? cfg?.fontSize ?? 14;
      const baseFontFamily = fontFamily ?? storeFontFamily ?? cfg?.fontFamily ?? DEFAULT_TERMINAL_FONT_FAMILY;
      const initFontSize = resolveTerminalFontSize(baseFontSize, formatsCodexOutput, fontSize !== undefined);
      const initFontFamily = resolveTerminalFontFamily(baseFontFamily, formatsCodexOutput, fontFamily !== undefined);

      term = new Terminal({
        cursorBlink: true,
        cursorStyle: "block",
        fontSize: initFontSize,
        fontFamily: initFontFamily,
        fontWeight: 500,
        fontWeightBold: 700,
        letterSpacing: 0,
        lineHeight: resolveTerminalLineHeight(formatsCodexOutput),
        rescaleOverlappingGlyphs: true,
        customGlyphs: true,
        theme: initTheme,
        allowTransparency: true,
        altClickMovesCursor: false,
        macOptionClickForcesSelection: true,
        scrollback: 5000,
        smoothScrollDuration: 0,
        rightClickSelectsWord: true,
        minimumContrastRatio: minContrastFor(mediaBackgroundActive),
      });
      termRef.current = term;

      fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;
      const searchAddon = new SearchAddon();
      searchAddonRef.current = searchAddon;

      term.loadAddon(fitAddon);
      term.loadAddon(searchAddon);
      term.loadAddon(new WebLinksAddon((_e, uri) => {
        if (onUrlClick) {
          onUrlClick(uri);
        } else {
          open(uri).catch(err => console.error("Failed to open URL:", err));
        }
      }, { urlRegex: HTTP_LINK_REGEX }));
      registerArtifactLinkProvider(term, (uri) => {
        if (onUrlClick) {
          onUrlClick(uri);
        } else {
          open(uri).catch(err => console.error("Failed to open local artifact:", err));
        }
      });

      term.open(container!);
      // Keep the DOM renderer for stability; WebGL texture atlases can corrupt
      // text in transparent multi-pane layouts on some Windows/WebView2 setups.
      diagStats.webgl = "never";
      liveTerms.set(sessionId, term);
      if (initialReplay && initialReplay.length > 0) {
        const replayText = initialReplay.join("\r\n");
        const shouldFormatReplay = updateCodexOutputDetection(replayText);
        const displayReplay = shouldFormatReplay ? formatMarkdownTablesForTerminal(replayText) : replayText;
        const replayBytes = new Blob([displayReplay]).size;
        diagStats.replays += 1;
        diagStats.replayLines += initialReplay.length;
        console.log(
          `[mycmux-diag xterm:${sessionId}] initial_replay lines=${initialReplay.length} bytes=${replayBytes} source=initialReplay`,
        );
        const replayTerm = term;
        await new Promise<void>((resolve) => {
          replayTerm.write(`${displayReplay}\r\n`, () => resolve());
        });
        if (disposed || termDisposed || !term) return;
        terminalInitialReplayMarkers.get(sessionId)?.dispose();
        const replayMarker = replayTerm.registerMarker(0);
        if (replayMarker) {
          terminalInitialReplayMarkers.set(sessionId, replayMarker);
        }
      }
      registerScrollListener(term);
      registerCompositionGuard(term, fitAddon);
      registerSelectionCopyListener(term);
      removeWheelScrollGuard = attachTerminalWheelScroll(term);
      removeFocusSync = registerTerminalFocusSync(term, sessionId);
      attachTerminalKeyHandler(term);

      // OSC 9988: mycmux HTML sidetab. Payload = file URL or absolute path.
      // The TerminalPane listener consumes "mycmux:html-out" and opens/reloads
      // a browser tab in the same pane. Returning true suppresses xterm display.
      term.parser.registerOscHandler(9988, (payload) => {
        try {
          window.dispatchEvent(
            new CustomEvent("mycmux:html-out", {
              detail: { paneSessionId: sessionId, payload },
            }),
          );
        } catch {
          // non-critical
        }
        return true;
      });

      registerInputListeners(term);

      registerScanListener(term);
      await registerExitListener();

      if (disposed || !term || !fitAddon) {
        return;
      }

      fitAndSyncResize(term, fitAddon, true);
      const cols = term.cols;
      const rows = term.rows;
      lastSentCols = cols;
      lastSentRows = rows;
      terminalSizeCache.set(sessionId, { cols, rows });

      try {
        startVisibilityObserver();
        await attachFrontendChannel(cols, rows);
        sessionStarted = true;
        startupSettleTimeout = setTimeout(() => {
          settleStartupSession();
        }, 250);
      } catch (err) {
        settleStartupSession();
        console.error("[XTermWrapper] Failed to create session:", err);
        term.writeln(`\r\n\x1b[31mFailed to start: ${err}\x1b[0m`);
      }

      registerResizeObserver(term, fitAddon);

      if (!cfg && !fontSize && !fontFamily) {
        ensureConfigLoaded().then(() => {
          if (disposed || termDisposed || !term || !cachedConfig) return;
          term.options.fontSize = resolveTerminalFontSize(fontSize ?? storeFontSize ?? cachedConfig.fontSize, formatsCodexOutput, fontSize !== undefined);
          term.options.fontFamily = resolveTerminalFontFamily(fontFamily ?? storeFontFamily ?? cachedConfig.fontFamily, formatsCodexOutput, fontFamily !== undefined);
          term.options.lineHeight = resolveTerminalLineHeight(formatsCodexOutput);
          if (fitAddon) {
            fitAndSyncResize(term, fitAddon, true);
          }
        });
      }
    }

    void init();

    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setSearchQuery(val);
    if (val && searchAddonRef.current) {
      searchAddonRef.current.findNext(val, { decorations: { matchBackground: '#404040', matchBorder: '#89b4fa', matchOverviewRuler: '#89b4fa', activeMatchBackground: '#89b4fa', activeMatchBorder: '#89b4fa', activeMatchColorOverviewRuler: '#89b4fa' } });
    } else if (searchAddonRef.current) {
      searchAddonRef.current.clearDecorations();
    }
  }, []);

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      if (e.shiftKey) {
        searchAddonRef.current?.findPrevious(searchQuery);
      } else {
        searchAddonRef.current?.findNext(searchQuery);
      }
    } else if (e.key === "Escape") {
      setIsSearchOpen(false);
      setSearchQuery("");
      searchAddonRef.current?.clearDecorations();
      containerRef.current?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")?.focus();
    }
  }, [searchQuery]);

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchQuery("");
    searchAddonRef.current?.clearDecorations();
    containerRef.current?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")?.focus();
  }, []);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {isSearchOpen && (
        <div style={{
          position: "absolute",
          top: 8,
          right: 16,
          zIndex: 50,
          background: "var(--cmux-surface, var(--cmux-bg, #1a1a1a))",
          border: "1px solid var(--cmux-border, #333)",
          borderRadius: 6,
          padding: "4px 8px",
          display: "flex",
          gap: 8,
          alignItems: "center",
          boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
          color: "var(--cmux-text, #ededed)",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12
        }}>
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={handleSearchChange}
            onKeyDown={handleSearchKeyDown}
            placeholder="Find..."
            style={{
              background: "transparent",
              border: "none",
              color: "inherit",
              outline: "none",
              fontFamily: "inherit",
              fontSize: "inherit",
              width: 150
            }}
          />
          <button onClick={() => searchAddonRef.current?.findPrevious(searchQuery)} style={searchBtnStyle}>↑</button>
          <button onClick={() => searchAddonRef.current?.findNext(searchQuery)} style={searchBtnStyle}>↓</button>
          <button onClick={closeSearch} style={searchBtnStyle}>✕</button>
        </div>
      )}
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "100%",
          overflow: "hidden",
          position: "relative",
          contain: "strict",
          background: "var(--cmux-terminal-bg, var(--cmux-bg, #0a0a0a))",
        }}
      >
      </div>
    </div>
  );
});

const searchBtnStyle = {
  background: "transparent",
  border: "none",
  color: "inherit",
  cursor: "pointer",
  padding: "0 4px",
  opacity: 0.7,
  fontFamily: "inherit"
};
