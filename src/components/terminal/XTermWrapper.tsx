import { memo, useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { open } from "@tauri-apps/plugin-shell";
import {
  createSession,
  writeToSession,
  resizeSession,
  onPtyExit,
  getTerminalConfig,
} from "../../lib/ipc";
import { usePaneMetadataStore, useUiStore } from "../../stores/workspaceStore";
import { useKeybindingStore } from "../../stores/keybindingStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { DEFAULT_TERMINAL_FONT_FAMILY, useThemeStore } from "../../stores/themeStore";
import type { ITheme } from "@xterm/xterm";
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

// Chunk large pastes to avoid PTY buffer overflow
const PASTE_CHUNK = 1024;

function chunkedWrite(sessionId: string, data: string): void {
  if (data.length <= PASTE_CHUNK) {
    writeToSession(sessionId, data).catch(console.error);
  } else {
    let offset = 0;
    const sendNext = () => {
      if (offset >= data.length) return;
      const chunk = data.slice(offset, offset + PASTE_CHUNK);
      offset += PASTE_CHUNK;
      writeToSession(sessionId, chunk).then(sendNext).catch(console.error);
    };
    sendNext();
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
const DEFAULT_TERMINAL_LINE_HEIGHT = 1.0;

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
if (typeof window !== "undefined") {
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

function displayWidth(value: string): number {
  let width = 0;
  for (const char of value.normalize("NFC")) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || codePoint === 0) continue;
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) continue;
    if (isZeroWidthCodePoint(codePoint)) continue;
    width += isWideCodePoint(codePoint) ? 2 : 1;
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
  diagWriteStats.delete(sessionId);
}

/** Read the last N non-empty lines of a pane's xterm buffer, ANSI/control-char stripped. */
export function getTerminalBufferLines(sessionId: string, maxLines: number): string[] {
  const term = liveTerms.get(sessionId) ?? termCache.get(sessionId)?.term;
  if (!term || maxLines <= 0) return [];
  try {
    const buf = term.buffer.active;
    const bottom = buf.length - 1;
    if (bottom < 0) return [];
    const top = Math.max(0, bottom - maxLines * 2);
    const result: string[] = [];
    for (let i = bottom; i >= top; i--) {
      const lineObj = buf.getLine(i);
      if (!lineObj) continue;
      const text = lineObj
        .translateToString(true)
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
        .replace(/\x1b\].*?\x07/g, "")
        .replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, "")
        .trim();
      if (text.length > 0) {
        result.push(text);
        if (result.length >= maxLines) break;
      }
    }
    return result.reverse();
  } catch {
    return [];
  }
}
const CODING_AGENT_HINT_PATTERN = /\b(?:ctrl|cmd|alt|shift)\+[\w?]+/gi;

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
    let term: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let removeCompositionGuard: (() => void) | null = null;
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
      if (currentTerm.cols === lastSentCols && currentTerm.rows === lastSentRows) return;

      lastSentCols = currentTerm.cols;
      lastSentRows = currentTerm.rows;
      terminalSizeCache.set(sessionId, { cols: currentTerm.cols, rows: currentTerm.rows });
      if (sessionStarted) {
        resizeSession(sessionId, currentTerm.cols, currentTerm.rows).catch(console.error);
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
      scheduleResize(currentTerm, currentFitAddon, 30);
      scheduleResize(currentTerm, currentFitAddon, 90);
      scheduleResize(currentTerm, currentFitAddon, 180);
    };

    const registerResizeObserver = (currentTerm: Terminal, currentFitAddon: FitAddon): void => {
      resizeObserver?.disconnect();
      resizeObserver = new ResizeObserver(() => {
        scheduleResizeBurst(currentTerm, currentFitAddon);
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

        const keybindingStore = useKeybindingStore.getState();
        const actions = keybindingStore.getActionsForEvent(e);

        if (actions.length > 0) {
          if (actions.includes("terminal.search")) {
            setIsSearchOpen(true);
            setTimeout(() => searchInputRef.current?.focus(), 50);
            return false;
          }

          if (actions.includes("pane.zoom.toggle")) {
            onZoomToggle?.();
            return false;
          }

          return false;
        }

        if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey) {
          const processTitle = usePaneMetadataStore.getState().metadata[sessionId]?.processTitle;
          writeToSession(sessionId, getShiftEnterSequence(command, processTitle)).catch(console.error);
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
      resizeObserver?.disconnect();
      resizeObserver = null;
      disposed = true;
      writeParsedDisposable?.dispose();
      writeParsedDisposable = null;
      scrollDisposable?.dispose();
      scrollDisposable = null;
      removeCompositionGuard?.();
      removeCompositionGuard = null;
      unlistenExit?.();
      unlistenExit = null;
      cacheCurrentTerminal();
      if (term && liveTerms.get(sessionId) === term) {
        liveTerms.delete(sessionId);
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
      cached.term.options.theme = storeTheme.terminal;
      cached.term.options.fontSize = storeFontSize;
      cached.term.options.fontFamily = storeFontFamily;
      registerScrollListener(cached.term);
      registerCompositionGuard(cached.term, cached.fitAddon);
      const cachedBufferText = getTerminalBufferLines(sessionId, 80).join("\n");
      updateCodexOutputDetection(cachedBufferText);
      attachTerminalKeyHandler(cached.term);
      registerScanListener(cached.term);
      void registerExitListener();
      setTimeout(() => {
        if (disposed || termDisposed) return;
        fitAndSyncResize(cached.term, cached.fitAddon, true);
      }, 30);
      registerResizeObserver(cached.term, cached.fitAddon);
    };

    const cached = termCache.get(sessionId);
    if (cached) {
      console.log(`[mycmux-diag xterm:${sessionId}] cache_hit`);
      attachCachedTerminal(cached);
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
        scrollback: 5000,
        smoothScrollDuration: 0,
        rightClickSelectsWord: true,
        minimumContrastRatio: 7,
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
      }));

      term.open(container!);
      // GPU renderer (WebGL). Must load AFTER open() since it needs the canvas.
      // Falls back silently to the default DOM renderer on context loss / failure.
      const diagStats = diagStatsFor(sessionId);
      if (useSettingsStore.getState().useWebglRenderer) {
        try {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => {
            const ts = Date.now();
            diagStats.webgl = "fallback";
            diagStats.webglLostAt = ts;
            const writesSoFar = diagStats.writes;
            console.log(
              `[mycmux-diag xterm:${sessionId}] WEBGL_LOST at=${ts} writes_in_window=${writesSoFar}`,
            );
            webgl.dispose();
          });
          term.loadAddon(webgl);
          diagStats.webgl = "on";
        } catch (err) {
          diagStats.webgl = "fallback";
          console.warn("[xterm] WebGL renderer unavailable, using DOM fallback:", err);
        }
      }
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
        term.write(`${displayReplay}\r\n`);
      }
      registerScrollListener(term);
      registerCompositionGuard(term, fitAddon);
      attachTerminalKeyHandler(term);

      term.onSelectionChange(() => {
        if (termDisposed || !term) return;
        const selection = term.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).catch(() => {});
        }
      });

      term.onData((data) => {
        chunkedWrite(sessionId, data);
      });

      term.onBinary((data) => {
        writeToSession(sessionId, data).catch(console.error);
      });

      term.onTitleChange((title) => {
        if (termDisposed || !title) return;
        usePaneMetadataStore.getState().setMetadata(sessionId, { processTitle: title });
      });

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
      const sessionEnv = launchEnv || undefined;

      try {
        await createSession(sessionId, command, args, cols, rows, (rawData: ArrayBuffer) => {
          if (termDisposed || !term) return;
          settleStartupSession();
          const chunk = new Uint8Array(rawData);
          const decodedText = outputDecoder.decode(chunk, { stream: true });
          const shouldFormatTables = updateCodexOutputDetection(decodedText);
          const output = shouldFormatTables ? formatMarkdownTablesForTerminal(decodedText) : chunk;
          // v0.7.1 diag: count live writes (per-second flush via diagWriteStats interval).
          diagStats.writes += 1;
          diagStats.bytes += typeof output === "string" ? new Blob([output]).size : output.byteLength;
          try {
            term.write(output, () => {
              if (disposed) {
                scheduleBackgroundScan();
              }
            });
          } catch {
            // term disposed between check and write
          }
        }, cwd, sessionEnv);
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
      containerRef.current?.querySelector("textarea")?.focus();
    }
  }, [searchQuery]);

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchQuery("");
    searchAddonRef.current?.clearDecorations();
    containerRef.current?.querySelector("textarea")?.focus();
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
