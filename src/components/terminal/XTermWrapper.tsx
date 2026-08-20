import { memo, useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { open } from "@tauri-apps/plugin-shell";
import { emit } from "@tauri-apps/api/event";
import {
  createSession,
  ackFrontendData,
  getSessionScrollback,
  hasPersistedScrollback,
  isSessionAlive,
  setFrontendVisible,
  resizeSession,
  onPtyExit,
  getTerminalConfig,
} from "../../lib/ipc";
import type { FrontendDataBatch } from "../../lib/ipc";
import {
  TERMINAL_SNAPSHOT_MAX_WRAPPED_LINES,
  TERMINAL_SNAPSHOT_SCAN_MULTIPLIER,
} from "./terminalBufferConstants";
import { usePaneMetadataStore, useUiStore } from "../../stores/workspaceStore";
import { useKeybindingStore } from "../../stores/keybindingStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { LightDarkColorAdaptController, shouldAdaptLightColorsForPane } from "../../lib/lightDarkColorAdapt";
import { resolveEffectiveTerminalRenderer } from "../../stores/settingsMigration";
import { DEFAULT_TERMINAL_FONT_FAMILY, useThemeStore } from "../../stores/themeStore";
import { useToastStore } from "../../stores/toastStore";
import { observeSessionInput } from "../../lib/inputLineDraft";
import { TerminalTurnChip } from "./TerminalTurnChip";
import {
  getTurnMarkData,
  noteRestoreBoundaryTurn,
  noteTurnInput,
  reanchorTurnMarks,
  seedTurnMarkSnapshots,
  snapshotTurnMarksForReset,
  TURN_MARKS_EVENT,
} from "./terminalTurnMarkers";
import { findTurnIndexForViewport, pickJumpTarget } from "./terminalTurnModel";
import type { IDisposable, ITheme } from "@xterm/xterm";
import type { ThemeBackgroundSettings } from "../../types";
import { markStartupSessionSettled } from "../../lib/startupSessionGate";
import {
  TERMINAL_BATCH_RETAINED_MAX_BYTES,
  trimOldestBatchesToByteCap,
} from "../../lib/terminalBatchQueue";
import {
  type CachedTerm,
  type PendingFrontendBatch,
  bumpTerminalWriteCounter,
  cacheOrDisposeOnUnmount,
  chunkedWrite,
  enqueueSessionWrite,
  getTerminalOutputDecoder,
  liveTerms,
  planTerminalScrollbackRecovery,
  registerTerminalCacheEvictionCleanup,
  rememberTerminalRawTail,
  replaceTerminalRawTail,
  resetTerminalOutputDecoder,
  sliceBatchAfterScrollbackOffset,
  stashDeferredTerminalBatches,
  takeDeferredTerminalBatches,
  termCache,
  terminalInitialReplayMarkers,
  terminalRawTailBySession,
  terminalScrollbackResyncNeeded,
  terminalSizeCache,
} from "./terminalCache";
import {
  resolveScrollbackRestorePolicy,
  shouldFinalizePersistedInitialReplay,
} from "./scrollbackRestorePolicy";
import {
  clearActiveTerminalNotification,
  focusTerminalIfNeeded,
  hasTerminalLiveOutput,
  isPlainTerminalInputEvent,
  markTerminalHasLiveOutput,
  registerTerminalFocusSync,
  registerTerminalWheelFocusGuard,
  shouldAcceptTerminalInput,
} from "./terminalFocusHelpers";
import { disposeSelectionCopyListener, registerSelectionCopyListener } from "./terminalSelectionCopy";
import {
  attachTerminalWheelScroll,
  createTerminalMouseModeControlFilter,
  filterTerminalMouseInputSequences,
  filterWheelFocusInputSequences,
  stripTerminalMouseModeControlSequences,
  stripTerminalMouseModeControlSequencesForSession,
} from "./terminalMouseInputFilter";
import { HTTP_LINK_REGEX, registerArtifactLinkProvider } from "./terminalLinkProvider";
import { ANSI_KEYS, withAnsiContrastFloor } from "./terminalThemeColors";
import { buildLaunchRequest, type TerminalLaunchParams } from "./terminalLaunchParams";
import { TerminalAckCoalescer } from "../../lib/terminalAckCoalescer";
import {
  findApprovalPromptDetail,
  resolveWaitingTransition,
  scanForApproval,
} from "../../lib/approvalScan";
import { scanRateLimit } from "../../lib/rateLimitScan";
import { observeTerminalVisibility } from "../../lib/terminalVisibilityTracker";
import {
  bump as bumpPaintStat,
  recordApprovalScan,
  recordCursorBlink,
  recordPtyBatch,
  recordRender,
  recordRenderer,
  recordResync,
  recordTerminalWriteCallback,
  recordTerminalWriteStart,
  recordWebglContextLoss,
  recordWriteParsed,
  recordXtermFocus,
  recordXtermMounted,
  recordXtermUnmounted,
  terminalWriteByteLength,
} from "../../lib/paintStats";
import {
  recordPtyBatchForRecording,
  registerPtyReplayTarget,
} from "../../lib/ptyReplay";

export { evictTerminalCache, getTerminalWriteCounter } from "./terminalCache";
export { allowInactiveTerminalPointerFocus } from "./terminalFocusHelpers";

export const WORKING_INDICATOR_PATTERNS: readonly RegExp[] = [
  /esc to interrupt/i,
];

// TUI input echo counts as output, so typing may keep the indicator active briefly.
const ACTIVITY_WINDOW_MS = 7000;

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
  workspaceId: string;
  sessionId: string;
  command: string;
  args?: string[];
  agentId?: string;
  agentKind?: "claude" | "codex" | "claude-codex" | "grok";
  onExit?: () => void;
  theme?: ITheme;
  fontSize?: number;
  fontFamily?: string;
  onZoomToggle?: () => void;
  onUrlClick?: (url: string) => void;
  onArtifactLinkClick?: (uri: string, screenPos: { x: number; y: number }) => void;
  cwd?: string;
  launchEnv?: Record<string, string>;
  restoreFallbackSessionIds?: string[];
  initialReplay?: string[];
}

const terminalVisibilityUpdates = new Map<string, Promise<void>>();

function queueTerminalVisibilityUpdate(sessionId: string, visible: boolean): void {
  const previous = terminalVisibilityUpdates.get(sessionId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => setFrontendVisible(sessionId, visible));
  terminalVisibilityUpdates.set(sessionId, next);
  void next
    .catch((error) => {
      console.warn(`[XTermWrapper] Failed to update frontend visibility for ${sessionId}:`, error);
    })
    .finally(() => {
      if (terminalVisibilityUpdates.get(sessionId) === next) {
        terminalVisibilityUpdates.delete(sessionId);
      }
    });
}

function buildThemeFromConfig(
  cfg: { background: string; foreground: string; ansi: string[] },
  selectionBackground: string | undefined,
): ITheme {
  const theme: ITheme = {
    background: cfg.background,
    foreground: cfg.foreground,
    cursor: cfg.foreground,
    selectionBackground,
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

// The single place an ITheme is prepared for xterm. Every path that assigns
// options.theme goes through here so the wallpaper-mode ANSI floor (which the
// disabled minimumContrastRatio no longer provides) can never be skipped.
function resolveTerminalTheme(theme: ITheme, opacity: number, mediaActive: boolean): ITheme {
  return withTerminalOpacity(withAnsiContrastFloor(theme, mediaActive), opacity, mediaActive);
}

// xterm's minimumContrastRatio only works against an opaque, known background.
// With a media background the terminal background is transparent (the wallpaper
// is composited in CSS), so it must be disabled — otherwise xterm corrects the
// foreground against a phantom black background and washes out dark text.
const TERMINAL_MIN_CONTRAST = 7;

function minContrastFor(mediaActive: boolean): number {
  return mediaActive ? 1 : TERMINAL_MIN_CONTRAST;
}

function resolveTerminalBackgroundState(background: ThemeBackgroundSettings): {
  mediaBackgroundActive: boolean;
  terminalOpacity: number;
} {
  const mediaBackgroundActive = background.mode === "preset" || (
    background.mode === "image" && background.imagePath.length > 0
  );
  return {
    mediaBackgroundActive,
    terminalOpacity: mediaBackgroundActive ? background.terminalOpacity : 1,
  };
}

function resolveEffectiveTerminalRendererFromStores(): "webgl" | "dom" {
  const setting = useSettingsStore.getState().terminalRenderer;
  const background = useThemeStore.getState().themeTweaks.background;
  const { mediaBackgroundActive, terminalOpacity } = resolveTerminalBackgroundState(background);
  return resolveEffectiveTerminalRenderer(setting, mediaBackgroundActive, terminalOpacity);
}

// Cache terminal config globally - fetched once, reused across all panes
let cachedConfig: { theme: ITheme; fontSize: number; fontFamily: string; windowsBuildNumber: number | null } | null = null;
let configPromise: Promise<void> | null = null;

const TERMINAL_SNAPSHOT_MAX_LINE_CHARS = 8192;
const CODING_AGENT_HINT_PATTERN = /\b(?:ctrl|cmd|alt|shift)\+[\w?]+/gi;

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
registerTerminalCacheEvictionCleanup((sessionId) => {
  diagWriteStats.delete(sessionId);
});

function diagStatsFor(sessionId: string): DiagWriteStats {
  let stats = diagWriteStats.get(sessionId);
  if (!stats) {
    stats = { writes: 0, bytes: 0, webgl: "never", webglLostAt: null, replays: 0, replayLines: 0 };
    diagWriteStats.set(sessionId, stats);
  }
  return stats;
}

type WebglRendererState = {
  addon: WebglAddon;
  contextLossDisposable: IDisposable;
};

const webglRendererStates = new WeakMap<Terminal, WebglRendererState>();
const webglRendererFailures = new WeakSet<Terminal>();

function disposeWebglRenderer(
  sessionId: string,
  term: Terminal,
  fallback: boolean,
  contextLost = false,
): void {
  const rendererState = webglRendererStates.get(term);
  if (rendererState) {
    webglRendererStates.delete(term);
    try {
      rendererState.contextLossDisposable.dispose();
    } catch {
      // Continue disposing the addon so the DOM fallback still takes effect.
    }
    try {
      rendererState.addon.dispose();
    } catch (error) {
      console.warn(`[XTermWrapper] Failed to dispose WebGL renderer for ${sessionId}:`, error);
    }
  }

  const stats = diagStatsFor(sessionId);
  stats.webgl = fallback ? "fallback" : "never";
  recordRenderer(sessionId, "dom");
  if (contextLost) {
    webglRendererFailures.add(term);
    stats.webglLostAt = Date.now();
    recordWebglContextLoss(sessionId);
  }
}

function enableWebglRenderer(sessionId: string, term: Terminal): void {
  if (webglRendererFailures.has(term)) {
    diagStatsFor(sessionId).webgl = "fallback";
    recordRenderer(sessionId, "dom");
    return;
  }
  if (webglRendererStates.has(term)) {
    diagStatsFor(sessionId).webgl = "on";
    return;
  }

  let addon: WebglAddon | null = null;
  let contextLossDisposable: IDisposable | null = null;
  try {
    addon = new WebglAddon();
    contextLossDisposable = addon.onContextLoss(() => {
      if (webglRendererStates.get(term)?.addon !== addon) return;
      disposeWebglRenderer(sessionId, term, true, true);
    });
    webglRendererStates.set(term, { addon, contextLossDisposable });
    term.loadAddon(addon);
    if (webglRendererStates.get(term)?.addon === addon) {
      diagStatsFor(sessionId).webgl = "on";
      recordRenderer(sessionId, "webgl");
    }
  } catch (error) {
    if (webglRendererStates.get(term)?.addon === addon) {
      webglRendererStates.delete(term);
    }
    try {
      contextLossDisposable?.dispose();
    } catch {
      // Continue with addon disposal and the DOM fallback.
    }
    try {
      addon?.dispose();
    } catch {
      // The DOM fallback below remains usable even if partial addon cleanup fails.
    }
    webglRendererFailures.add(term);
    diagStatsFor(sessionId).webgl = "fallback";
    recordRenderer(sessionId, "dom");
    console.warn(`[XTermWrapper] WebGL unavailable for ${sessionId}; using DOM renderer:`, error);
  }
}

function applyTerminalRenderer(
  sessionId: string,
  term: Terminal,
  renderer: "webgl" | "dom",
): void {
  if (renderer === "webgl") {
    enableWebglRenderer(sessionId, term);
  } else {
    webglRendererFailures.delete(term);
    disposeWebglRenderer(sessionId, term, false);
  }
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
const DEFAULT_TERMINAL_LINE_HEIGHT = 1.35;

function resolveTerminalLineHeight(): number {
  return useThemeStore.getState().lineHeight ?? DEFAULT_TERMINAL_LINE_HEIGHT;
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
  const hasLiveOutput = hasTerminalLiveOutput(sessionId);
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

function startsAsAgentTui(
  command: string,
  args: string[],
  agentId?: string,
  agentKind?: string,
  launchEnv?: Record<string, string>,
): boolean {
  if (agentKind === "claude" || agentKind === "codex" || agentKind === "claude-codex") return true;
  if (agentId === "claude" || agentId === "codex" || agentId === "claude-codex") return true;
  if (
    launchEnv?.MYCMUX_AGENT_KIND === "claude"
    || launchEnv?.MYCMUX_AGENT_KIND === "codex"
    || launchEnv?.MYCMUX_AGENT_KIND === "claude-codex"
    || launchEnv?.MYCMUX_RESUME === "claude"
    || launchEnv?.MYCMUX_RESUME === "codex"
    || launchEnv?.MYCMUX_RESUME === "claude-codex"
  ) {
    return true;
  }
  const commandName = getCommandName(command);
  if (commandName === "claude" || commandName === "codex") return true;
  return args.some((arg) => {
    const argName = getCommandName(arg);
    return argName === "claude" || argName === "codex";
  });
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
        theme: buildThemeFromConfig(
          cfg,
          useThemeStore.getState().theme.terminal.selectionBackground,
        ),
        fontSize,
        fontFamily: `'${cfg.font_family}', monospace`,
        windowsBuildNumber: cfg.windows_build_number,
      };
    })
    .catch(() => {
      cachedConfig = null;
      configPromise = null;
    });
  return configPromise;
}

export default memo(function XTermWrapper({
  workspaceId,
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
  onArtifactLinkClick,
  cwd,
  launchEnv,
  restoreFallbackSessionIds,
  initialReplay,
}: XTermWrapperProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const isAtBottomRef = useRef(true);
  const syncResizeRef = useRef<(force?: boolean) => void>(() => {});
  const settingsResizeTimerRef = useRef<number | null>(null);
  // Latest-value mirror of the PTY launch parameters. The terminal effect below
  // is keyed on [sessionId] alone (adding these would respawn the terminal on
  // every metadata update), so anything it reads *after* its first synchronous
  // pass — above all the async attach — must go through this ref instead of the
  // frozen closure. See terminalLaunchParams.ts for the failure it prevents.
  //
  // Refreshed during render rather than in an effect on purpose: the attach path
  // can resume from an in-flight promise between a commit and the passive-effect
  // flush, and that gap is exactly the race this ref exists to close. Safe here
  // because the values are derived from store state that never rolls back, and
  // this component is rendered without Suspense/transitions.
  const launchParamsRef = useRef<TerminalLaunchParams>({
    command,
    args,
    cwd,
    launchEnv,
    restoreFallbackSessionIds,
  });
  launchParamsRef.current = { command, args, cwd, launchEnv, restoreFallbackSessionIds };

  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [turnChip, setTurnChip] = useState<{
    index: number;
    total: number;
    label: string;
  } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const turnChipRafRef = useRef<number | null>(null);
  const lastTurnChipRef = useRef<typeof turnChip>(null);
  const refreshTurnChipRef = useRef<() => void>(() => {});

  const refreshTurnChip = useCallback(() => {
    if (turnChipRafRef.current != null) return;
    turnChipRafRef.current = requestAnimationFrame(() => {
      turnChipRafRef.current = null;
      const currentTerm = termRef.current;
      if (!currentTerm) {
        if (lastTurnChipRef.current !== null) {
          lastTurnChipRef.current = null;
          setTurnChip(null);
        }
        return;
      }
      const buf = currentTerm.buffer.active;
      const marks = getTurnMarkData(sessionId);
      const visible =
        !isAtBottomRef.current &&
        marks.length > 0 &&
        buf.type === "normal";
      if (!visible) {
        if (lastTurnChipRef.current !== null) {
          lastTurnChipRef.current = null;
          setTurnChip(null);
        }
        return;
      }
      const index = findTurnIndexForViewport(marks, buf.viewportY);
      if (index < 0) {
        if (lastTurnChipRef.current !== null) {
          lastTurnChipRef.current = null;
          setTurnChip(null);
        }
        return;
      }
      const next = {
        index,
        total: marks.length,
        label: marks[index]?.label ?? "",
      };
      const prev = lastTurnChipRef.current;
      if (
        prev &&
        prev.index === next.index &&
        prev.total === next.total &&
        prev.label === next.label
      ) {
        return;
      }
      lastTurnChipRef.current = next;
      setTurnChip(next);
    });
  }, [sessionId]);
  refreshTurnChipRef.current = refreshTurnChip;

  const jumpTurn = useCallback((direction: -1 | 1) => {
    const currentTerm = termRef.current;
    if (!currentTerm) return;
    const marks = getTurnMarkData(sessionId);
    const currentIndex = lastTurnChipRef.current?.index
      ?? findTurnIndexForViewport(marks, currentTerm.buffer.active.viewportY);
    const target = pickJumpTarget(marks, currentIndex, direction);
    if (!target) {
      // Past the last turn there is no next mark; down means back to the live tail.
      if (direction === 1) currentTerm.scrollToBottom();
      refreshTurnChip();
      return;
    }
    currentTerm.scrollToLine(target.line);
    refreshTurnChip();
  }, [refreshTurnChip, sessionId]);

  useEffect(() => {
    const onTurnMarks = (event: Event): void => {
      const markedSession = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (markedSession && markedSession !== sessionId) return;
      refreshTurnChipRef.current();
    };
    window.addEventListener(TURN_MARKS_EVENT, onTurnMarks);
    return () => {
      window.removeEventListener(TURN_MARKS_EVENT, onTurnMarks);
      if (turnChipRafRef.current != null) {
        cancelAnimationFrame(turnChipRafRef.current);
        turnChipRafRef.current = null;
      }
    };
  }, [sessionId]);

  const storeTheme = useThemeStore((s) => s.theme);
  const storeFontSize = useThemeStore((s) => s.fontSize);
  const storeFontFamily = useThemeStore((s) => s.fontFamily);
  const storeLineHeight = useThemeStore((s) => s.lineHeight);
  const storeBackground = useThemeStore((s) => s.themeTweaks.background);
  const terminalRenderer = useSettingsStore((s) => s.terminalRenderer);
  const colorAdaptCommands = useSettingsStore((s) => s.colorAdaptCommands);
  const colorAdaptCommandsRef = useRef(colorAdaptCommands);
  colorAdaptCommandsRef.current = colorAdaptCommands;
  const processTitle = usePaneMetadataStore((s) => s.volatileMetadata[sessionId]?.processTitle);
  const processTitleRef = useRef(processTitle);
  processTitleRef.current = processTitle;
  const colorAdapterRef = useRef(new LightDarkColorAdaptController());
  const previousTerminalRendererRef = useRef(terminalRenderer);
  const { mediaBackgroundActive, terminalOpacity } = resolveTerminalBackgroundState(storeBackground);
  // Single source of truth: is this tab the currently-focused terminal?
  // Used for scroll-to-bottom-on-activate.
  const isActivePane = useUiStore((s) => s.activePaneId === sessionId);
  const previousIsActivePaneRef = useRef(isActivePane);

  // Dynamically update terminal theme and font size
  useEffect(() => {
    if (!termRef.current) return;
    bumpPaintStat("settings", sessionId);
    termRef.current.options.theme = resolveTerminalTheme(storeTheme.terminal, terminalOpacity, mediaBackgroundActive);
    termRef.current.options.minimumContrastRatio = minContrastFor(mediaBackgroundActive);
    termRef.current.options.fontSize = storeFontSize;
    termRef.current.options.fontFamily = storeFontFamily;
    termRef.current.options.lineHeight = storeLineHeight;
    if (settingsResizeTimerRef.current !== null) {
      window.clearTimeout(settingsResizeTimerRef.current);
    }
    settingsResizeTimerRef.current = window.setTimeout(() => {
      settingsResizeTimerRef.current = null;
      syncResizeRef.current(true);
    }, 60);
    return () => {
      if (settingsResizeTimerRef.current !== null) {
        window.clearTimeout(settingsResizeTimerRef.current);
        settingsResizeTimerRef.current = null;
      }
    };
  }, [storeTheme, storeFontSize, storeFontFamily, storeLineHeight, terminalOpacity, mediaBackgroundActive]);

  // Scroll to bottom when this tab becomes active only if the user was already at bottom.
  useEffect(() => {
    if (previousIsActivePaneRef.current !== isActivePane) {
      bumpPaintStat("focus-change", sessionId);
      previousIsActivePaneRef.current = isActivePane;
    }
    const currentTerm = termRef.current;
    if (currentTerm) {
      // Keep inactive panes from continuously dirtying their renderer layer.
      currentTerm.options.cursorBlink = isActivePane;
      recordCursorBlink(sessionId, isActivePane);
    }
    if (isActivePane && currentTerm) {
      setTimeout(() => {
        syncResizeRef.current(true);
        if (isAtBottomRef.current) {
          termRef.current?.scrollToBottom();
        }
      }, 50);
    }
  }, [isActivePane]);

  useEffect(() => {
    const rendererSettingChanged = previousTerminalRendererRef.current !== terminalRenderer;
    previousTerminalRendererRef.current = terminalRenderer;
    if (termRef.current) {
      if (rendererSettingChanged) {
        bumpPaintStat("settings", sessionId);
      }
      applyTerminalRenderer(
        sessionId,
        termRef.current,
        resolveEffectiveTerminalRenderer(
          terminalRenderer,
          mediaBackgroundActive,
          terminalOpacity,
        ),
      );
    }
  }, [sessionId, terminalRenderer, mediaBackgroundActive, terminalOpacity]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const wheelScrollContainer: HTMLElement = container;

    let disposed = false;
    let termDisposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let resizeTimers: ReturnType<typeof setTimeout>[] = [];
    let refreshTimers: ReturnType<typeof setTimeout>[] = [];
    let unlistenExit: (() => void) | null = null;
    let writeParsedDisposable: { dispose: () => void } | null = null;
    let renderDisposable: { dispose: () => void } | null = null;
    let scrollDisposable: { dispose: () => void } | null = null;
    let dataDisposable: { dispose: () => void } | null = null;
    let binaryDisposable: { dispose: () => void } | null = null;
    let titleDisposable: { dispose: () => void } | null = null;
    let artifactLinkProviderDisposable: { dispose: () => void } | null = null;
    let term: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let removeCompositionGuard: (() => void) | null = null;
    let removePaintFocusListeners: (() => void) | null = null;
    let removeFocusSync: (() => void) | null = null;
    let removeWheelFocusGuard: (() => void) | null = null;
    let removeWheelScrollGuard: (() => void) | null = null;
    let removePtyReplayTarget: (() => void) | null = null;
    let idleFlush: ReturnType<typeof setTimeout> | null = null;
    let backgroundScanThrottle: ReturnType<typeof setTimeout> | null = null;
    let outputActivityTimer: ReturnType<typeof setTimeout> | null = null;
    let backgroundScanResync = false;
    let startupSettleTimeout: ReturnType<typeof setTimeout> | null = null;
    let startupSettled = false;
    let sessionStarted = false;
    let coldPersistedRestore = false;
    let lastLogLine = "";
    let approvalAbsentStreak = 0;
    let rateLimitAbsentStreak = 0;
    let rateLimitVisible = false;
    let lastScanSignature: string | null = null;
    let isImeComposing = false;
    let resizePendingDuringComposition = false;
    const forceWheelMouseReport = startsAsAgentTui(command, args, agentId, agentKind, launchEnv);
    let outputDecoder = getTerminalOutputDecoder(sessionId);
    let replayOutputDecoder = new TextDecoder();
    let replayMouseModeFilter = createTerminalMouseModeControlFilter();
    const diagStats = diagStatsFor(sessionId);
    const pendingBatches: PendingFrontendBatch[] = takeDeferredTerminalBatches(sessionId);
    let writingBatch = false;
    let currentPendingBatch: PendingFrontendBatch | null = null;
    let frontendChannelReady = false;
    let replayActive = false;
    let scrollbackSyncInFlight: Promise<boolean> | null = null;
    let lastSynchronizedScrollbackEnd = 0;
    let recoveryRedrawTimer: ReturnType<typeof setTimeout> | null = null;
    let recoveryRedrawDelayResolve: (() => void) | null = null;
    let recoveryRedrawInFlight: Promise<boolean> | null = null;
    let pendingDrainTimer: ReturnType<typeof setTimeout> | null = null;
    let frontendVisible: boolean | null = null;
    let terminalPaintedVisible: boolean | null = null;
    const ackCoalescer = new TerminalAckCoalescer(({ generation, seq, bytes }) => (
      ackFrontendData(sessionId, generation, seq, bytes)
    ));
    let stopVisibilityTracking: (() => void) | null = null;
    let containerVisibilityMemo:
      | { sampledAt: number; displayed: boolean; painted: boolean; writableSize: boolean }
      | null = null;
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

    const clearRefreshTimers = (): void => {
      for (const timer of refreshTimers) {
        clearTimeout(timer);
      }
      refreshTimers = [];
    };

    const clearPendingDrainTimer = (): void => {
      if (!pendingDrainTimer) return;
      clearTimeout(pendingDrainTimer);
      pendingDrainTimer = null;
    };

    const clearScanTimers = (): void => {
      if (startupSettleTimeout) {
        clearTimeout(startupSettleTimeout);
        startupSettleTimeout = null;
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

    const setOutputActive = (active: boolean): void => {
      const current = usePaneMetadataStore.getState().volatileMetadata[sessionId]?.outputActive === true;
      if (current === active) return;
      usePaneMetadataStore.getState().setVolatileMetadata(sessionId, { outputActive: active });
    };

    const noteOutputActivity = (): void => {
      setOutputActive(true);
      if (outputActivityTimer) clearTimeout(outputActivityTimer);
      outputActivityTimer = setTimeout(() => {
        outputActivityTimer = null;
        setOutputActive(false);
      }, ACTIVITY_WINDOW_MS);
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
      if (disposed || termDisposed || currentTerm.rows <= 0 || !isContainerWritable()) return;
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
      clearRefreshTimers();
      for (const delay of delays) {
        const timer = setTimeout(() => {
          refreshTimers = refreshTimers.filter((entry) => entry !== timer);
          refreshVisibleRows(currentTerm);
        }, delay);
        refreshTimers.push(timer);
      }
    };

    const fitAndSyncResize = (currentTerm: Terminal, currentFitAddon: FitAddon, force = false): void => {
      if (disposed || termDisposed || !isContainerWritable()) return;
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
        bumpPaintStat("resize", sessionId);
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
        invalidateContainerVisibilityMemo();
        refreshFrontendVisible();
        refreshTerminalPaintedVisible();
        if (isContainerWritable()) {
          scheduleResizeBurst(currentTerm, currentFitAddon);
          if (
            (pendingBatches.length > 0 || terminalScrollbackResyncNeeded.has(sessionId))
            && canWritePendingBatches()
          ) {
            void pumpTerminalWrites();
          }
        } else {
          clearResizeTimer();
          clearRefreshTimers();
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
        refreshTurnChipRef.current();
      });
    };

    const registerPaintFocusListeners = (currentTerm: Terminal): void => {
      removePaintFocusListeners?.();
      const textarea = currentTerm.textarea;
      if (!textarea) {
        removePaintFocusListeners = null;
        return;
      }
      const handleFocusChange = (): void => {
        bumpPaintStat("focus-change", sessionId);
        recordXtermFocus(sessionId, textarea === document.activeElement);
      };
      textarea.addEventListener("focus", handleFocusChange);
      textarea.addEventListener("blur", handleFocusChange);
      recordXtermFocus(sessionId, textarea === document.activeElement);
      removePaintFocusListeners = () => {
        textarea.removeEventListener("focus", handleFocusChange);
        textarea.removeEventListener("blur", handleFocusChange);
      };
    };

    const registerRenderListener = (currentTerm: Terminal): void => {
      renderDisposable?.dispose();
      if (!import.meta.env.DEV) {
        renderDisposable = null;
        return;
      }
      renderDisposable = currentTerm.onRender(({ start, end }) => {
        recordRender(start, end, currentTerm.rows, sessionId);
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
          if (!shouldAcceptTerminalInput(sessionId)) return false;
          const processTitle = usePaneMetadataStore.getState().volatileMetadata[sessionId]?.processTitle;
          enqueueSessionWrite(
            sessionId,
            getShiftEnterSequence(launchParamsRef.current.command, processTitle),
          );
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

    const publishScreenScanEvidence = (
      attention: "approval" | "rate_limited" | "none",
      detail: string | null,
      attentionId: string | null,
      resync: boolean,
    ): void => {
      void emit("mycmux:session-state-evidence", {
        session_id: sessionId,
        attention,
        attention_id: attentionId,
        detail,
        observed_at: Date.now(),
        confidence: 0.7,
        stale_after: 30_000,
        complete: true,
        resync,
      }).catch((error) => {
        if (import.meta.env.DEV) {
          console.warn("[mycmux-diag] failed to publish screen scan evidence", error);
        }
      });
    };

    const runScan = (allowDetached = false, resync = false): void => {
      if (!term || termDisposed || (!allowDetached && disposed)) return;
      const scanStartedAt = import.meta.env.DEV ? performance.now() : null;
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
      const scanSignature = scanLines.join("\n");
      if (scanSignature === lastScanSignature && approvalAbsentStreak === 0 && rateLimitAbsentStreak === 0) return;
      lastScanSignature = scanSignature;
      const workingPatternVisible = scanLines.some((line) => (
        WORKING_INDICATOR_PATTERNS.some((pattern) => pattern.test(line))
      ));
      const previousWorkingPatternVisible =
        usePaneMetadataStore.getState().volatileMetadata[sessionId]?.workingPatternVisible === true;
      if (workingPatternVisible !== previousWorkingPatternVisible) {
        usePaneMetadataStore.getState().setVolatileMetadata(sessionId, { workingPatternVisible });
      }
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

      bumpPaintStat("scan", sessionId);
      const rateLimit = scanRateLimit(scanLines.join("\n"));
      const approvalPatternId = scanForApproval(scanLines);
      const prevStatus = usePaneMetadataStore.getState().metadata[sessionId]?.agentStatus;
      if (rateLimit.kind === "limit-reached") {
        const newlyVisible = !rateLimitVisible;
        rateLimitVisible = true;
        rateLimitAbsentStreak = 0;
        if (newlyVisible) {
          publishScreenScanEvidence(
            "rate_limited",
            rateLimit.evidence,
            `rate-limit:${sessionId}:${rateLimit.evidence}`,
            resync,
          );
        }
      } else if (rateLimitVisible) {
        rateLimitAbsentStreak += 1;
        if (rateLimitAbsentStreak >= 2) {
          rateLimitVisible = false;
          rateLimitAbsentStreak = 0;
          publishScreenScanEvidence("none", null, null, resync);
        }
      }
      if (rateLimit.kind === "limit-reached") {
        if (scanStartedAt !== null) recordApprovalScan(performance.now() - scanStartedAt, sessionId);
        return;
      }
      const transition = resolveWaitingTransition(
        { waiting: prevStatus === "waiting", absentStreak: approvalAbsentStreak },
        approvalPatternId,
      );
      approvalAbsentStreak = transition.absentStreak;
      if (approvalPatternId > 0) {
        if (prevStatus !== "waiting") {
          const observedAt = Date.now();
          publishScreenScanEvidence(
            "approval",
            findApprovalPromptDetail(scanLines, approvalPatternId),
            `screen:${sessionId}:${approvalPatternId}:${observedAt}`,
            resync,
          );
        }
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
      } else if (transition.clear) {
        if (prevStatus === "waiting") {
          publishScreenScanEvidence("none", null, null, resync);
          usePaneMetadataStore.getState().clearAgentStatus(sessionId);
        }
      }
      if (scanStartedAt !== null) recordApprovalScan(performance.now() - scanStartedAt, sessionId);
    };

    const scheduleBackgroundScan = (resync = false): void => {
      if (!term) return;
      backgroundScanResync ||= resync;
      if (!backgroundScanThrottle) {
        backgroundScanThrottle = setTimeout(() => {
          backgroundScanThrottle = null;
          const scanWasResync = backgroundScanResync;
          backgroundScanResync = false;
          runScan(true, scanWasResync);
        }, 300);
      }
      if (idleFlush) clearTimeout(idleFlush);
      idleFlush = setTimeout(() => {
        idleFlush = null;
        runScan(true, backgroundScanResync);
      }, 200);
    };

    const batchDataToBytes = (data: FrontendDataBatch["data"]): Uint8Array => {
      if (data instanceof Uint8Array) return data;
      if (data instanceof ArrayBuffer) return new Uint8Array(data);
      return new Uint8Array(data);
    };

    const ackBatch = (batch: FrontendDataBatch): void => {
      ackCoalescer.enqueue({
        generation: batch.generation,
        seq: batch.seq,
        bytes: batch.bytes,
      });
    };

    const ackPendingBatch = (pending: PendingFrontendBatch): void => {
      if (pending.acked) return;
      pending.acked = true;
      ackBatch(pending.batch);
    };

    const enforcePendingBatchCap = (): void => {
      const trimmed = trimOldestBatchesToByteCap(
        pendingBatches,
        TERMINAL_BATCH_RETAINED_MAX_BYTES,
      );
      if (!trimmed.needsScrollbackResync) return;
      pendingBatches.splice(0, pendingBatches.length, ...trimmed.retained);
      terminalScrollbackResyncNeeded.add(sessionId);
      for (const pending of trimmed.dropped) {
        ackPendingBatch(pending);
      }
    };

    const invalidateContainerVisibilityMemo = (): void => {
      containerVisibilityMemo = null;
    };

    const readContainerVisibilitySnapshot = (): { displayed: boolean; painted: boolean; writableSize: boolean } => {
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (containerVisibilityMemo && now - containerVisibilityMemo.sampledAt < 16) {
        return containerVisibilityMemo;
      }
      let displayed = container.isConnected;
      let painted = displayed && document.visibilityState !== "hidden";
      let current: HTMLElement | null = container;
      while (current && (displayed || painted)) {
        const style = window.getComputedStyle(current);
        if (style.display === "none") {
          displayed = false;
          painted = false;
          break;
        }
        if (style.visibility === "hidden" || style.visibility === "collapse") {
          painted = false;
        }
        current = current.parentElement;
      }
      const rect = container.getBoundingClientRect();
      const snapshot = {
        displayed,
        painted,
        writableSize: rect.width > 0 && rect.height > 0,
      };
      containerVisibilityMemo = { sampledAt: now, ...snapshot };
      return snapshot;
    };

    const isContainerPainted = (): boolean => {
      return readContainerVisibilitySnapshot().painted;
    };

    const hasWritableTerminalSize = (): boolean => {
      return readContainerVisibilitySnapshot().writableSize;
    };

    const isContainerWritable = (): boolean => {
      return isContainerPainted() && hasWritableTerminalSize();
    };

    const canWritePendingBatches = (): boolean => {
      return Boolean(
        frontendChannelReady
        && term
        && !termDisposed
        && isContainerWritable()
      );
    };

    const schedulePendingWriteDrain = (delay = 80): void => {
      if (disposed || termDisposed || pendingDrainTimer) return;
      pendingDrainTimer = setTimeout(() => {
        pendingDrainTimer = null;
        refreshFrontendVisible();
        refreshTerminalPaintedVisible();
        if (term && fitAddon && isContainerWritable()) {
          fitAndSyncResize(term, fitAddon, true);
        }
        if (pendingBatches.length === 0 && !terminalScrollbackResyncNeeded.has(sessionId)) return;
        if (canWritePendingBatches()) {
          void pumpTerminalWrites();
        } else if (isContainerWritable()) {
          schedulePendingWriteDrain(120);
        }
      }, delay);
    };

    const scheduleFrontendResync = (): void => {
      if (disposed || termDisposed || !term || !fitAddon) return;
      refreshFrontendVisible();
      refreshTerminalPaintedVisible();
      if (!isContainerWritable()) {
        clearResizeTimer();
        clearRefreshTimers();
        return;
      }
      scheduleResizeBurst(term, fitAddon);
      scheduleFullRefresh(term, [0, 48, 160]);
      if (pendingBatches.length > 0 || terminalScrollbackResyncNeeded.has(sessionId)) {
        if (canWritePendingBatches()) {
          void pumpTerminalWrites();
        } else if (isContainerWritable()) {
          schedulePendingWriteDrain();
        }
      }
    };

    const setFrontendVisibleIfChanged = (visible: boolean): boolean => {
      if (frontendVisible === visible) return false;
      frontendVisible = visible;
      queueTerminalVisibilityUpdate(sessionId, visible);
      return true;
    };

    const refreshFrontendVisible = (): boolean => {
      return setFrontendVisibleIfChanged(Boolean(term && !termDisposed && isContainerWritable()));
    };

    const refreshTerminalPaintedVisible = (): boolean => {
      const visible = Boolean(term && !termDisposed && isContainerWritable());
      if (terminalPaintedVisible === visible) return false;
      terminalPaintedVisible = visible;
      return true;
    };

    const handleFrontendVisibilitySignal = (): void => {
      invalidateContainerVisibilityMemo();
      const frontendChanged = refreshFrontendVisible();
      const paintChanged = refreshTerminalPaintedVisible();
      if (frontendChanged && !frontendVisible) {
        terminalScrollbackResyncNeeded.add(sessionId);
        clearResizeTimer();
        clearRefreshTimers();
      }
      const shouldResync =
        (frontendVisible && (frontendChanged || pendingBatches.length > 0))
        || (terminalPaintedVisible && paintChanged);
      if (shouldResync) {
        scheduleFrontendResync();
      }
    };

    const handleTerminalLayoutSignal = (event: Event): void => {
      const detail = (event as CustomEvent<{ workspaceId?: string }>).detail;
      if (detail?.workspaceId && detail.workspaceId !== workspaceId) return;
      invalidateContainerVisibilityMemo();
      refreshFrontendVisible();
      refreshTerminalPaintedVisible();
      scheduleFrontendResync();
    };

    const startVisibilityObserver = (): void => {
      stopVisibilityTracking?.();
      stopVisibilityTracking = observeTerminalVisibility(
        container,
        workspaceId,
        handleFrontendVisibilitySignal,
        () => handleTerminalLayoutSignal(new CustomEvent("mycmux:terminal-layout-change", { detail: { workspaceId } })),
      );
    };

    const stopVisibilityObserver = (): void => {
      stopVisibilityTracking?.();
      stopVisibilityTracking = null;
    };

    const writeTerminalOutput = (
      output: string | Uint8Array,
      watchdogMs = 2000,
    ): Promise<void> => {
      return new Promise((resolve) => {
        if (!term || termDisposed) {
          resolve();
          return;
        }
        const measuredBytes = terminalWriteByteLength(output);
        const writeMeasurement = recordTerminalWriteStart(sessionId, measuredBytes);
        let callbackObserved = false;
        let settled = false;
        const watchdog = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve();
          // xterm has already accepted the bytes when write() returns. Resolve
          // before the backend's 5s ACK timeout so a busy renderer cannot force
          // an otherwise lossless stream into AutoConsume/resync mode.
        }, watchdogMs);
        const finish = (): void => {
          if (!callbackObserved) {
            callbackObserved = true;
            recordTerminalWriteCallback(writeMeasurement);
          }
          if (settled) return;
          settled = true;
          window.clearTimeout(watchdog);
          resolve();
        };
        try {
          const colorAdaptEnabled = shouldAdaptLightColorsForPane(
            launchParamsRef.current.command,
            processTitleRef.current,
            colorAdaptCommandsRef.current,
          );
          const displayOutput = typeof output === "string"
            ? colorAdapterRef.current.transform(output, colorAdaptEnabled)
            : output;
          term.write(displayOutput, finish);
        } catch {
          finish();
        }
      });
    };

    const scheduleTuiRecoveryRedraw = (): Promise<boolean> => {
      if (recoveryRedrawInFlight) return recoveryRedrawInFlight;
      const request = (async (): Promise<boolean> => {
        if (!forceWheelMouseReport || !term || termDisposed) return false;
        await new Promise<void>((resolve) => {
          recoveryRedrawDelayResolve = resolve;
          recoveryRedrawTimer = setTimeout(() => {
            recoveryRedrawTimer = null;
            recoveryRedrawDelayResolve = null;
            resolve();
          }, 16);
        });
        if (disposed || termDisposed || !term) return false;
        const cols = term.cols;
        const rows = term.rows;
        if (cols <= 0 || rows <= 0) return false;
        const temporaryRows = rows > 2 ? rows - 1 : rows + 1;
        try {
          await resizeSession(sessionId, cols, temporaryRows);
          await resizeSession(sessionId, cols, rows);
          return true;
        } catch (error) {
          if (import.meta.env.DEV) {
            console.warn("[mycmux-diag xterm] failed to request TUI redraw", error);
          }
          return false;
        }
      })().finally(() => {
        if (recoveryRedrawInFlight === request) {
          recoveryRedrawInFlight = null;
        }
      });
      recoveryRedrawInFlight = request;
      return request;
    };

    const hasMeaningfulTerminalScreen = (): boolean => {
      if (!term || termDisposed) return false;
      try {
        const buffer = term.buffer.active;
        const bottom = buffer.length - 1;
        const top = Math.max(0, bottom - Math.max(1, term.rows));
        for (let index = bottom; index >= top; index -= 1) {
          if (buffer.getLine(index)?.translateToString(true).trim()) return true;
        }
      } catch {
        return false;
      }
      return false;
    };

    const replayTruncatedTailIntoEmptyTerminal = async (scrollback: Uint8Array): Promise<void> => {
      if (!term || termDisposed || hasMeaningfulTerminalScreen()) return;
      const terminalElement = term.element;
      const previousOpacity = terminalElement?.style.opacity ?? "";
      if (terminalElement) terminalElement.style.opacity = "0";
      try {
        colorAdapterRef.current.reset();
        const replayTerm = term;
        snapshotTurnMarksForReset(sessionId, replayTerm);
        term.reset();
        outputDecoder = resetTerminalOutputDecoder(sessionId);
        const replayText = outputDecoder.decode(scrollback, { stream: true });
        bumpPaintStat("resync", sessionId);
        const resyncStartedAt = import.meta.env.DEV ? performance.now() : null;
        backgroundScanResync = true;
        await writeTerminalOutput(stripTerminalMouseModeControlSequences(replayText), 8000);
        reanchorTurnMarks(sessionId, replayTerm);
        if (resyncStartedAt !== null) {
          recordResync(scrollback.byteLength, performance.now() - resyncStartedAt, sessionId);
        }
      } finally {
        if (terminalElement) terminalElement.style.opacity = previousOpacity;
      }
    };

    const performBackendScrollbackSync = async (): Promise<boolean> => {
      if (!canWritePendingBatches()) return false;
      const knownTail = terminalRawTailBySession.get(sessionId);
      let scrollbackSnapshot: Awaited<ReturnType<typeof getSessionScrollback>>;
      try {
        scrollbackSnapshot = await getSessionScrollback(sessionId);
      } catch {
        return false;
      }
      // Visibility can change while the IPC request is in flight. Never reset
      // or write into a terminal that became hidden in that interval.
      invalidateContainerVisibilityMemo();
      if (disposed || termDisposed || !term || !canWritePendingBatches()) return false;
      const scrollback = new Uint8Array(scrollbackSnapshot.data);
      if (scrollback.byteLength === 0) {
        replaceTerminalRawTail(sessionId, scrollback);
        lastSynchronizedScrollbackEnd = scrollbackSnapshot.endOffset;
        return true;
      }
      const recoveryPlan = planTerminalScrollbackRecovery(
        scrollback,
        scrollbackSnapshot.startOffset,
        scrollbackSnapshot.endOffset,
        lastSynchronizedScrollbackEnd,
        knownTail,
      );
      const replay = recoveryPlan.data;
      if (replay.byteLength === 0) {
        if (recoveryPlan.action === "skip-truncated") {
          // This ring no longer contains the VT state that produced the
          // current xterm buffer. Preserve the last coherent screen and ask
          // Codex to repaint instead of replaying an arbitrary byte suffix.
          outputDecoder = resetTerminalOutputDecoder(sessionId);
          const redrawn = await scheduleTuiRecoveryRedraw();
          await replayTruncatedTailIntoEmptyTerminal(scrollback);
          if (!redrawn) {
            // A truncated raw VT ring cannot reconstruct the old screen. Do
            // not wedge the live stream by retrying the same 256 KB snapshot
            // every 160 ms; advance to its end and resume new output.
            if (import.meta.env.DEV) {
              console.warn(`[mycmux-diag xterm:${sessionId}] truncated recovery redraw unavailable; resuming live output`);
            }
          }
        }
        replaceTerminalRawTail(sessionId, scrollback);
        lastSynchronizedScrollbackEnd = scrollbackSnapshot.endOffset;
        return true;
      }
      if (!canWritePendingBatches()) return false;
      const terminalElement = term.element;
      const previousOpacity = terminalElement?.style.opacity ?? "";
      const replacesVisibleBuffer = recoveryPlan.action === "replace"
        || recoveryPlan.action === "initial-replay";
      if (replacesVisibleBuffer) {
        if (terminalElement) terminalElement.style.opacity = "0";
        colorAdapterRef.current.reset();
        snapshotTurnMarksForReset(sessionId, term);
        term.reset();
        outputDecoder = resetTerminalOutputDecoder(sessionId);
      }
      const replayTerm = term;
      const replayText = outputDecoder.decode(replay, { stream: true });
      try {
        bumpPaintStat("resync", sessionId);
        const resyncStartedAt = import.meta.env.DEV ? performance.now() : null;
        backgroundScanResync = true;
        await writeTerminalOutput(
          stripTerminalMouseModeControlSequences(replayText),
          replacesVisibleBuffer ? 8000 : 2000,
        );
        const finalizePersistedReplay = shouldFinalizePersistedInitialReplay(
          coldPersistedRestore,
          recoveryPlan.action,
        );
        if (finalizePersistedReplay) {
          if (replayTerm.buffer.active.type === "alternate") {
            await writeTerminalOutput("\x1b[?1049l\x1b[?25h\x1b[0m\r\n", 2000);
          }
          terminalInitialReplayMarkers.get(sessionId)?.dispose();
          const replayMarker = replayTerm.registerMarker(0);
          if (replayMarker) {
            terminalInitialReplayMarkers.set(sessionId, replayMarker);
          }
        }
        reanchorTurnMarks(sessionId, replayTerm);
        if (finalizePersistedReplay && getTurnMarkData(sessionId).length === 0) {
          noteRestoreBoundaryTurn(sessionId);
        }
        if (resyncStartedAt !== null) {
          recordResync(replay.byteLength, performance.now() - resyncStartedAt, sessionId);
        }
      } finally {
        if (terminalElement && replacesVisibleBuffer) {
          terminalElement.style.opacity = previousOpacity;
        }
      }
      replaceTerminalRawTail(sessionId, scrollback);
      lastSynchronizedScrollbackEnd = scrollbackSnapshot.endOffset;
      if (disposed || termDisposed || !term) return false;
      if (!canWritePendingBatches()) return false;
      markTerminalHasLiveOutput(sessionId);
      bumpTerminalWriteCounter(sessionId);
      scheduleFullRefresh(term, [0, 48, 160]);
      return true;
    };

    const syncBackendScrollbackToTerminal = (): Promise<boolean> => {
      if (scrollbackSyncInFlight) return scrollbackSyncInFlight;
      const request = performBackendScrollbackSync().finally(() => {
        if (scrollbackSyncInFlight === request) {
          scrollbackSyncInFlight = null;
        }
      });
      scrollbackSyncInFlight = request;
      return request;
    };

    const syncDroppedBatchScrollbackIfNeeded = async (): Promise<void> => {
      if (!terminalScrollbackResyncNeeded.has(sessionId)) return;
      if (!canWritePendingBatches()) return;
      terminalScrollbackResyncNeeded.delete(sessionId);
      const synchronized = await syncBackendScrollbackToTerminal();
      if (!synchronized) {
        terminalScrollbackResyncNeeded.add(sessionId);
      }
    };

    async function pumpTerminalWrites(): Promise<void> {
      if (writingBatch) return;
      writingBatch = true;
      try {
        await syncDroppedBatchScrollbackIfNeeded();
        if (terminalScrollbackResyncNeeded.has(sessionId)) {
          schedulePendingWriteDrain(160);
          return;
        }
        while (pendingBatches.length > 0) {
          const pending = pendingBatches.shift()!;
          const { batch } = pending;
          if (!term || termDisposed) {
            ackPendingBatch(pending);
            continue;
          }
          if (terminalScrollbackResyncNeeded.has(sessionId)) {
            ackPendingBatch(pending);
            continue;
          }
          if (!canWritePendingBatches()) {
            if (!isContainerWritable()) {
              terminalScrollbackResyncNeeded.add(sessionId);
              ackPendingBatch(pending);
              continue;
            }
            ackPendingBatch(pending);
            pendingBatches.unshift(pending);
            if (isContainerWritable()) {
              schedulePendingWriteDrain();
            }
            break;
          }
          try {
            currentPendingBatch = pending;
            clearPendingDrainTimer();
            settleStartupSession();
            if (batch.scrollbackStart > lastSynchronizedScrollbackEnd) {
              terminalScrollbackResyncNeeded.add(sessionId);
              continue;
            }
            const fullChunk = batchDataToBytes(batch.data);
            const chunk = sliceBatchAfterScrollbackOffset(
              batch,
              fullChunk,
              lastSynchronizedScrollbackEnd,
            );
            if (chunk.byteLength === 0) {
              continue;
            }
            if (chunk.byteLength > 0 && !hasTerminalLiveOutput(sessionId)) {
              markTerminalHasLiveOutput(sessionId);
            }
            const decodedText = outputDecoder.decode(chunk, { stream: true });
            const displayText = stripTerminalMouseModeControlSequencesForSession(sessionId, decodedText);
            // PTY output is a stateful byte stream. Do not rewrite its text or
            // cursor sequences: they were emitted against the original widths.
            // The write helper only changes non-printing SGR color parameters
            // for configured commands immediately before xterm rendering.
            const output = displayText;
            if (import.meta.env.DEV) {
              diagStats.writes += 1;
              diagStats.bytes += new Blob([output]).size;
            }
            bumpTerminalWriteCounter(sessionId);
            bumpPaintStat("pty-batch", sessionId);
            await writeTerminalOutput(output);
            rememberTerminalRawTail(sessionId, chunk);
            lastSynchronizedScrollbackEnd = Math.max(
              lastSynchronizedScrollbackEnd,
              batch.scrollbackEnd,
            );
          } finally {
            ackPendingBatch(pending);
            if (currentPendingBatch === pending) currentPendingBatch = null;
          }
        }
      } finally {
        writingBatch = false;
        if (
          pendingBatches.length > 0
          && !terminalScrollbackResyncNeeded.has(sessionId)
          && canWritePendingBatches()
        ) {
          void pumpTerminalWrites();
        } else if (
          (pendingBatches.length > 0 || terminalScrollbackResyncNeeded.has(sessionId))
          && isContainerWritable()
        ) {
          schedulePendingWriteDrain(160);
        }
      }
    }

    removePtyReplayTarget = registerPtyReplayTarget(sessionId, {
      begin: () => {
        if (!term || termDisposed || disposed) {
          throw new Error(`PTY replay target ${sessionId} is not ready`);
        }
        if (
          replayActive
          || writingBatch
          || currentPendingBatch
          || pendingBatches.length > 0
          || scrollbackSyncInFlight
          || terminalScrollbackResyncNeeded.has(sessionId)
        ) {
          throw new Error(`PTY replay target ${sessionId} is not quiescent`);
        }
        replayOutputDecoder = new TextDecoder();
        replayMouseModeFilter = createTerminalMouseModeControlFilter();
        colorAdapterRef.current.reset();
        term.reset();
        replayActive = true;
      },
      write: async (data) => {
        if (!replayActive) throw new Error(`PTY replay target ${sessionId} stopped`);
        recordPtyBatch(data.byteLength, sessionId);
        bumpPaintStat("pty-batch", sessionId);
        const decodedText = replayOutputDecoder.decode(data, { stream: true });
        await writeTerminalOutput(replayMouseModeFilter(decodedText));
      },
      end: async () => {
        replayActive = false;
        terminalScrollbackResyncNeeded.add(sessionId);
        if (canWritePendingBatches()) {
          await pumpTerminalWrites();
        }
      },
    });

    const enqueueFrontendBatch = (batch: FrontendDataBatch): void => {
      if (replayActive) {
        terminalScrollbackResyncNeeded.add(sessionId);
        ackBatch(batch);
        return;
      }
      // Replayed scrollback is historical output — only live batches count as
      // agent activity for the working indicator.
      noteOutputActivity();
      recordPtyBatch(batch.bytes, sessionId);
      recordPtyBatchForRecording(sessionId, {
        generation: batch.generation,
        seq: batch.seq,
        resync: batch.resync,
        scrollbackStart: batch.scrollbackStart,
        scrollbackEnd: batch.scrollbackEnd,
        data: batchDataToBytes(batch.data),
      });
      if (batch.resync) {
        terminalScrollbackResyncNeeded.add(sessionId);
      }
      if (!isContainerWritable()) {
        terminalScrollbackResyncNeeded.add(sessionId);
        ackBatch(batch);
        return;
      }
      const pending: PendingFrontendBatch = { batch, acked: false };
      pendingBatches.push(pending);
      enforcePendingBatchCap();
      if (scrollbackSyncInFlight) {
        ackPendingBatch(pending);
        return;
      }
      if (canWritePendingBatches()) {
        void pumpTerminalWrites();
      } else {
        ackPendingBatch(pending);
        if (isContainerWritable()) {
          schedulePendingWriteDrain();
        }
      }
    };

    const attachFrontendChannel = async (cols: number, rows: number): Promise<void> => {
      // Read the launch parameters at attach time, not at effect-setup time:
      // the resume env (MYCMUX_AGENT_KIND / MYCMUX_SESSION_ID / MYCMUX_RESUME)
      // can land between this effect's first pass and the actual spawn.
      const launch = buildLaunchRequest(launchParamsRef.current);
      await createSession(
        sessionId,
        launch.command,
        launch.args,
        cols,
        rows,
        enqueueFrontendBatch,
        launch.cwd,
        launch.env,
        launch.restoreFallbackSessionIds,
      );
      frontendChannelReady = true;
      if (cols > 0 && rows > 0) {
        lastSentCols = cols;
        lastSentRows = rows;
        terminalSizeCache.set(sessionId, { cols, rows });
        void resizeSession(sessionId, cols, rows).catch((error) => {
          console.error("[XTermWrapper] Failed to sync backend size after attach:", error);
        });
      }
      // createSession replaces the backend channel and resets visibility to
      // true. Force the actual CSS visibility back into the backend after the
      // attach, even when the local boolean was already false before it.
      frontendVisible = null;
      refreshFrontendVisible();
      terminalScrollbackResyncNeeded.add(sessionId);
      await syncDroppedBatchScrollbackIfNeeded();
      scheduleFrontendResync();
    };

    const registerScanListener = (currentTerm: Terminal): void => {
      writeParsedDisposable?.dispose();
      writeParsedDisposable = currentTerm.onWriteParsed(() => {
        if (disposed) return;
        recordWriteParsed(sessionId);
        scheduleBackgroundScan();
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
        const { data: inputData, hasNonWheelInput } = filterWheelFocusInputSequences(
          sessionId,
          filterTerminalMouseInputSequences(data),
        );
        if (!inputData) return;
        if (!shouldAcceptTerminalInput(sessionId)) return;
        if (hasNonWheelInput) {
          clearActiveTerminalNotification(sessionId);
          focusTerminalIfNeeded(currentTerm, sessionId);
        }
        noteTurnInput(sessionId, inputData, lastSynchronizedScrollbackEnd);
        observeSessionInput(sessionId, inputData);
        chunkedWrite(sessionId, inputData);
        if (hasNonWheelInput) {
          try {
            window.dispatchEvent(
              new CustomEvent("mycmux:keystroke", { detail: { sessionId, data: inputData } }),
            );
          } catch {
            // Ignore dispatch failures; the input-probe event is non-critical.
          }
        }
      });

      binaryDisposable = currentTerm.onBinary((data) => {
        const { data: inputData, hasNonWheelInput } = filterWheelFocusInputSequences(
          sessionId,
          filterTerminalMouseInputSequences(data),
        );
        if (!inputData) return;
        if (!shouldAcceptTerminalInput(sessionId)) return;
        if (hasNonWheelInput) {
          clearActiveTerminalNotification(sessionId);
          focusTerminalIfNeeded(currentTerm, sessionId);
        }
        noteTurnInput(sessionId, inputData, lastSynchronizedScrollbackEnd);
        enqueueSessionWrite(sessionId, inputData);
      });

      titleDisposable = currentTerm.onTitleChange((title) => {
        if (termDisposed || !title) return;
        usePaneMetadataStore.getState().setVolatileMetadata(sessionId, { processTitle: title });
      });
    };

    const cacheCurrentTerminal = (): void => {
      const currentSearchAddon = searchAddonRef.current;
      if (term && term.element && fitAddon && currentSearchAddon) {
        // A detached terminal keeps its parsed buffer, but a live WebGL addon
        // would also retain a GPU context. Recreate the renderer on reattach.
        disposeWebglRenderer(sessionId, term, false);
        const element = term.element;
        if (element.parentNode === container) {
          container.removeChild(element);
        }
        // Route through cacheOrDisposeOnUnmount so an active-tab close (which
        // evicted the cache slot while this Terminal was still mounted) disposes
        // the Terminal instead of leaking it into termCache forever (FE-N1).
        const outcome = cacheOrDisposeOnUnmount(sessionId, {
          term,
          fitAddon,
          searchAddon: currentSearchAddon,
          xtermElement: element,
          unlistenExit: null,
          scrollbackEnd: lastSynchronizedScrollbackEnd,
        });
        if (outcome === "disposed") {
          termDisposed = true;
        }
        return;
      }
      if (term) {
        termDisposed = true;
        term.dispose();
      }
    };

    const registerArtifactLinks = (currentTerm: Terminal): void => {
      artifactLinkProviderDisposable?.dispose();
      artifactLinkProviderDisposable = registerArtifactLinkProvider(currentTerm, sessionId, (uri, event) => {
        if (onArtifactLinkClick) {
          onArtifactLinkClick(uri, { x: event.clientX, y: event.clientY });
        } else if (onUrlClick) {
          onUrlClick(uri);
        } else {
          open(uri).catch(err => console.error("Failed to open local artifact:", err));
        }
      }, () => usePaneMetadataStore.getState().metadata[sessionId]?.cwd ?? launchParamsRef.current.cwd);
    };

    const cleanup = (): void => {
      colorAdapterRef.current.reset();
      invalidateContainerVisibilityMemo();
      clearResizeTimer();
      clearRefreshTimers();
      clearPendingDrainTimer();
      if (recoveryRedrawTimer) {
        clearTimeout(recoveryRedrawTimer);
        recoveryRedrawTimer = null;
      }
      recoveryRedrawDelayResolve?.();
      recoveryRedrawDelayResolve = null;
      clearScanTimers();
      if (outputActivityTimer) {
        clearTimeout(outputActivityTimer);
        outputActivityTimer = null;
      }
      setOutputActive(false);
      stopVisibilityObserver();
      frontendChannelReady = false;
      setFrontendVisibleIfChanged(false);
      resizeObserver?.disconnect();
      resizeObserver = null;
      disposed = true;
      writeParsedDisposable?.dispose();
      writeParsedDisposable = null;
      renderDisposable?.dispose();
      renderDisposable = null;
      scrollDisposable?.dispose();
      scrollDisposable = null;
      dataDisposable?.dispose();
      dataDisposable = null;
      binaryDisposable?.dispose();
      binaryDisposable = null;
      titleDisposable?.dispose();
      titleDisposable = null;
      artifactLinkProviderDisposable?.dispose();
      artifactLinkProviderDisposable = null;
      removeCompositionGuard?.();
      removeCompositionGuard = null;
      removePaintFocusListeners?.();
      removePaintFocusListeners = null;
      removeFocusSync?.();
      removeFocusSync = null;
      removeWheelFocusGuard?.();
      removeWheelFocusGuard = null;
      removeWheelScrollGuard?.();
      removeWheelScrollGuard = null;
      removePtyReplayTarget?.();
      removePtyReplayTarget = null;
      disposeSelectionCopyListener(term);
      unlistenExit?.();
      unlistenExit = null;
      cacheCurrentTerminal();
      if (term && liveTerms.get(sessionId) === term) {
        liveTerms.delete(sessionId);
      }
      recordXtermUnmounted(sessionId);
      if (pendingBatches.length > 0) {
        const carry = pendingBatches.splice(0, pendingBatches.length);
        if (termDisposed) {
          for (const pending of carry) {
            ackPendingBatch(pending);
          }
        } else {
          stashDeferredTerminalBatches(sessionId, carry, (pending) => {
            ackPendingBatch(pending);
          });
        }
      }
      if (currentPendingBatch) ackPendingBatch(currentPendingBatch);
      ackCoalescer.flushAndDispose();
      if (sessionStarted && !termDisposed && !terminalRawTailBySession.has(sessionId)) {
        terminalRawTailBySession.set(sessionId, new Uint8Array());
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
      registerRenderListener(cached.term);
      invalidateContainerVisibilityMemo();
      term = cached.term;
      fitAddon = cached.fitAddon;
      sessionStarted = true;
      liveTerms.set(sessionId, cached.term);
      recordXtermMounted(sessionId);
      applyTerminalRenderer(sessionId, cached.term, resolveEffectiveTerminalRendererFromStores());
      termRef.current = cached.term;
      fitAddonRef.current = cached.fitAddon;
      searchAddonRef.current = cached.searchAddon;
      lastSynchronizedScrollbackEnd = cached.scrollbackEnd ?? 0;
      cached.term.options.theme = resolveTerminalTheme(storeTheme.terminal, terminalOpacity, mediaBackgroundActive);
      cached.term.options.minimumContrastRatio = minContrastFor(mediaBackgroundActive);
      cached.term.options.fontSize = storeFontSize;
      cached.term.options.fontFamily = storeFontFamily;
      cached.term.options.lineHeight = storeLineHeight;
      cached.term.options.cursorBlink = useUiStore.getState().activePaneId === sessionId;
      recordCursorBlink(sessionId, cached.term.options.cursorBlink === true);
      cached.term.options.altClickMovesCursor = false;
      registerScrollListener(cached.term);
      registerCompositionGuard(cached.term, cached.fitAddon);
      registerPaintFocusListeners(cached.term);
      registerSelectionCopyListener(cached.term, sessionId);
      removeWheelScrollGuard = attachTerminalWheelScroll(wheelScrollContainer, cached.term, sessionId, forceWheelMouseReport);
      removeWheelFocusGuard = registerTerminalWheelFocusGuard(cached.term, sessionId);
      removeFocusSync = registerTerminalFocusSync(cached.term, sessionId);
      attachTerminalKeyHandler(cached.term);
      registerInputListeners(cached.term);
      registerScanListener(cached.term);
      registerArtifactLinks(cached.term);
      void registerExitListener();
      setTimeout(() => {
        if (disposed || termDisposed) return;
        fitAndSyncResize(cached.term, cached.fitAddon, true);
        scheduleFrontendResync();
      }, 30);
      registerResizeObserver(cached.term, cached.fitAddon);
      startVisibilityObserver();
      scheduleFrontendResync();
    };

    const cached = termCache.get(sessionId);
    if (cached) {
      if (import.meta.env.DEV) {
        console.log(`[mycmux-diag xterm:${sessionId}] cache_hit`);
      }
      attachCachedTerminal(cached);
      void attachFrontendChannel(cached.term.cols, cached.term.rows).catch((err) => {
        console.error("[XTermWrapper] Failed to reattach session:", err);
        useToastStore.getState().pushToast("Terminal reattach failed", "error");
      });
      return cleanup;
    }
    if (import.meta.env.DEV) {
      console.log(`[mycmux-diag xterm:${sessionId}] cache_miss`);
    }

    async function init(): Promise<void> {
      if (disposed) return;
      let sessionAlive = true;
      let persistedScrollback = false;
      try {
        sessionAlive = await isSessionAlive(sessionId);
        if (!sessionAlive) {
          persistedScrollback = await hasPersistedScrollback(sessionId);
        }
      } catch {
        persistedScrollback = false;
      }
      const restorePolicy = resolveScrollbackRestorePolicy({
        isSessionAlive: sessionAlive,
        hasPersistedScrollback: persistedScrollback,
        isAgentTab: agentKind !== undefined,
        initialReplay,
      });
      coldPersistedRestore = restorePolicy.usePersistedScrollback;
      if (!restorePolicy.usePersistedScrollback) {
        // Persist snapshots are bottom-relative to the raw ring. The 160-line
        // fallback and a fresh PTY cannot place them, so drop the seed rather
        // than reanchor against the wrong buffer later.
        seedTurnMarkSnapshots(sessionId, []);
      }
      const cfg = cachedConfig;
      const initTheme = resolveTerminalTheme(theme ?? storeTheme.terminal, terminalOpacity, mediaBackgroundActive);
      const baseFontSize = fontSize ?? storeFontSize ?? cfg?.fontSize ?? 14;
      const baseFontFamily = fontFamily ?? storeFontFamily ?? cfg?.fontFamily ?? DEFAULT_TERMINAL_FONT_FAMILY;
      const initFontSize = baseFontSize;
      const initFontFamily = baseFontFamily;

      const windowsBuildNumber = cfg?.windowsBuildNumber ?? undefined;

      term = new Terminal({
        cursorBlink: useUiStore.getState().activePaneId === sessionId,
        cursorStyle: "block",
        fontSize: initFontSize,
        fontFamily: initFontFamily,
        fontWeight: 500,
        fontWeightBold: 700,
        letterSpacing: 0,
        lineHeight: resolveTerminalLineHeight(),
        rescaleOverlappingGlyphs: true,
        customGlyphs: true,
        theme: initTheme,
        allowTransparency: true,
        allowProposedApi: true,
        altClickMovesCursor: false,
        macOptionClickForcesSelection: true,
        scrollback: 5000,
        smoothScrollDuration: 0,
        rightClickSelectsWord: true,
        minimumContrastRatio: minContrastFor(mediaBackgroundActive),
        ...(windowsBuildNumber !== undefined
          ? { windowsPty: { backend: "conpty", buildNumber: windowsBuildNumber } }
          : {}),
      });
      termRef.current = term;

      fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;
      const searchAddon = new SearchAddon();
      searchAddonRef.current = searchAddon;
      const unicode11Addon = new Unicode11Addon();

      term.loadAddon(fitAddon);
      term.loadAddon(searchAddon);
      term.loadAddon(unicode11Addon);
      term.unicode.activeVersion = "11";
      term.loadAddon(new WebLinksAddon((_e, uri) => {
        if (onUrlClick) {
          onUrlClick(uri);
        } else {
          open(uri).catch(err => console.error("Failed to open URL:", err));
        }
      }, { urlRegex: HTTP_LINK_REGEX }));
      registerArtifactLinks(term);

      registerRenderListener(term);
      term.open(container!);
      invalidateContainerVisibilityMemo();
      liveTerms.set(sessionId, term);
      recordXtermMounted(sessionId);
      recordCursorBlink(sessionId, term.options.cursorBlink === true);
      applyTerminalRenderer(sessionId, term, resolveEffectiveTerminalRendererFromStores());
      if (restorePolicy.initialReplay && restorePolicy.initialReplay.length > 0) {
        const replayText = restorePolicy.initialReplay.join("\r\n");
        const displayReplay = replayText;
        const replayBytes = new Blob([displayReplay]).size;
        diagStats.replays += 1;
        diagStats.replayLines += restorePolicy.initialReplay.length;
        if (import.meta.env.DEV) {
          console.log(
            `[mycmux-diag xterm:${sessionId}] initial_replay lines=${restorePolicy.initialReplay.length} bytes=${replayBytes} source=initialReplay`,
          );
        }
        const replayTerm = term;
        await new Promise<void>((resolve) => {
          const output = `${stripTerminalMouseModeControlSequences(displayReplay)}\r\n`;
          const measuredBytes = terminalWriteByteLength(output);
          const writeMeasurement = recordTerminalWriteStart(sessionId, measuredBytes);
          const colorAdaptEnabled = shouldAdaptLightColorsForPane(
            launchParamsRef.current.command,
            processTitleRef.current,
            colorAdaptCommandsRef.current,
          );
          const adaptedOutput = colorAdapterRef.current.transform(output, colorAdaptEnabled);
          replayTerm.write(adaptedOutput, () => {
            recordTerminalWriteCallback(writeMeasurement);
            resolve();
          });
        });
        bumpTerminalWriteCounter(sessionId);
        scheduleFullRefresh(replayTerm, [0, 48, 160]);
        if (disposed || termDisposed || !term) return;
        terminalInitialReplayMarkers.get(sessionId)?.dispose();
        const replayMarker = replayTerm.registerMarker(0);
        if (replayMarker) {
          terminalInitialReplayMarkers.set(sessionId, replayMarker);
        }
        noteRestoreBoundaryTurn(sessionId);
      }
      registerScrollListener(term);
      registerCompositionGuard(term, fitAddon);
      registerPaintFocusListeners(term);
      registerSelectionCopyListener(term, sessionId);
      removeWheelScrollGuard = attachTerminalWheelScroll(wheelScrollContainer, term, sessionId, forceWheelMouseReport);
      removeWheelFocusGuard = registerTerminalWheelFocusGuard(term, sessionId);
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
        registerResizeObserver(term, fitAddon);
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

      if (!cfg && !fontSize && !fontFamily) {
        ensureConfigLoaded().then(() => {
          if (disposed || termDisposed || !term || !cachedConfig) return;
          term.options.fontSize = fontSize ?? storeFontSize ?? cachedConfig.fontSize;
          term.options.fontFamily = fontFamily ?? storeFontFamily ?? cachedConfig.fontFamily;
          term.options.lineHeight = resolveTerminalLineHeight();
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

  const searchDecorations = useMemo(() => {
    const match = storeTheme.terminal.selectionBackground;
    const active = storeTheme.chrome.accent;
    return {
      matchBackground: match,
      matchBorder: active,
      matchOverviewRuler: active,
      activeMatchBackground: active,
      activeMatchBorder: active,
      activeMatchColorOverviewRuler: active,
    };
  }, [storeTheme]);

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setSearchQuery(val);
    if (val && searchAddonRef.current) {
      searchAddonRef.current.findNext(val, { decorations: searchDecorations });
    } else if (searchAddonRef.current) {
      searchAddonRef.current.clearDecorations();
    }
  }, [searchDecorations]);

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
      {turnChip && (
        <TerminalTurnChip
          index={turnChip.index}
          total={turnChip.total}
          label={turnChip.label}
          canPrev={turnChip.index > 0}
          canNext

          onPrev={() => jumpTurn(-1)}
          onNext={() => jumpTurn(1)}
        />
      )}
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
          <button onClick={() => searchAddonRef.current?.findPrevious(searchQuery)} style={searchBtnStyle}>^</button>
          <button onClick={() => searchAddonRef.current?.findNext(searchQuery)} style={searchBtnStyle}>v</button>
          <button onClick={closeSearch} style={searchBtnStyle}>x</button>
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
