import { memo, useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
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
import type { AgentStatus } from "../../stores/paneMetadataStoreCompat";
import { useKeybindingStore } from "../../stores/keybindingStore";
import { useThemeStore } from "../../stores/themeStore";
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
  onExit?: () => void;
  theme?: ITheme;
  fontSize?: number;
  fontFamily?: string;
  onZoomToggle?: () => void;
  onUrlClick?: (url: string) => void;
  cwd?: string;
  launchEnv?: Record<string, string>;
}

// Approval-prompt detection patterns. Pattern index is used as the
// notification key so the same approval fires only once per occurrence.
const APPROVAL_PATTERNS: readonly RegExp[] = [
  /allow\s+.*\?\s*\(y\/n\)/i,               // 1: Claude Code tool approval
  /^\s*\d+\.\s+.+\(.*\)/,                    // 2: AskUserQuestion numbered choice
  /\(y\/n\)\s*$/i,                           // 3: generic (y/n)
  /\[y\/N\]/i,                               // 4: shell-style [y/N]
  /type your (answer|response)/i,            // 5: Claude AskUser open prompt
  /press enter to (continue|confirm|submit)/i, // 6
  /hit enter to /i,                          // 7
  /\bapprove\b.*\?/i,                        // 8: generic approve?
  /do you want to (proceed|continue)/i,      // 9: Claude Code "Do you want to proceed?"
  /❯\s+\d+\.\s+/,                            // 10: Ink-style ❯ 1. Yes selection cursor
] as const;

const WORKING_PATTERN = /working\.\.\.|thinking\.\.\.|analyzing|executing|applying/i;
const SPINNER_CHARS = /[\u25CF\u25CB\u25D0-\u25D3\u2737\u2731\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F]/;
const DONE_PATTERNS = [
  /\u2713\s*(done|complete|finished)/i,
  /^>\s*$/,
  /\$\s*$/,
];

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

/** Call before killSession to dispose the cached terminal */
export function evictTerminalCache(sessionId: string): void {
  const cached = termCache.get(sessionId);
  if (cached) {
    cached.unlistenExit?.();
    cached.term.dispose();
    termCache.delete(sessionId);
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
  onExit,
  theme,
  fontSize,
  fontFamily,
  onZoomToggle,
  onUrlClick,
  cwd,
  launchEnv,
}: XTermWrapperProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const isAtBottomRef = useRef(true);

  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const storeTheme = useThemeStore((s) => s.theme);
  const storeFontSize = useThemeStore((s) => s.fontSize);

  // Single source of truth: is this tab the currently-focused terminal?
  // Used for both scroll-to-bottom-on-activate and notification suppression.
  const isActivePane = useUiStore((s) => s.activePaneId === sessionId);

  // Dynamically update terminal theme and font size
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = storeTheme.terminal;
      termRef.current.options.fontSize = storeFontSize;
      setTimeout(() => fitAddonRef.current?.fit(), 10);
    }
  }, [storeTheme, storeFontSize]);

  // Scroll to bottom when this tab becomes active — only if user was at bottom before switching
  useEffect(() => {
    if (isActivePane && termRef.current) {
      setTimeout(() => {
        fitAddonRef.current?.fit();
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
    let resizeObserver: ResizeObserver | null = null;
    let resizeTimeout: ReturnType<typeof setTimeout>;

    // --- Reattach cached terminal (survived Allotment restructuring) ---
    const cached = termCache.get(sessionId);
    if (cached) {
      termCache.delete(sessionId);
      container.appendChild(cached.xtermElement);
      termRef.current = cached.term;
      fitAddonRef.current = cached.fitAddon;
      searchAddonRef.current = cached.searchAddon;

      // Re-fit after reattach
      setTimeout(() => {
        if (disposed) return;
        cached.fitAddon.fit();
        resizeSession(sessionId, cached.term.cols, cached.term.rows).catch(console.error);
      }, 30);

      resizeObserver = new ResizeObserver(() => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
          if (disposed) return;
          cached.fitAddon.fit();
          resizeSession(sessionId, cached.term.cols, cached.term.rows).catch(console.error);
        }, 50);
      });
      resizeObserver.observe(container);

      return () => {
        disposed = true;
        clearTimeout(resizeTimeout);
        resizeObserver?.disconnect();
        // Cache again for potential future remount
        const el = cached.xtermElement;
        if (el.parentNode === container) container.removeChild(el);
        termCache.set(sessionId, cached);
      };
    }

    // --- First mount: create new terminal + PTY session ---
    let unlistenExit: (() => void) | null = null;
    let term: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let logThrottle: ReturnType<typeof setTimeout> | null = null;
    let idleFlush: ReturnType<typeof setTimeout> | null = null;
    let startupSettleTimeout: ReturnType<typeof setTimeout> | null = null;
    let startupSettled = false;

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

    async function init() {
      if (disposed) return;
      // Use cached config if available (instant), otherwise use defaults
      const cfg = cachedConfig;
      const initTheme = theme ?? storeTheme.terminal;
      const initFontSize = fontSize ?? cfg?.fontSize ?? 14;
      const initFontFamily = fontFamily ?? cfg?.fontFamily ?? "'JetBrainsMono Nerd Font Mono', 'JetBrains Mono', 'Geist Mono', 'SF Mono', 'BIZ UDGothic', 'MS Gothic', monospace";

      term = new Terminal({
        cursorBlink: true,
        cursorStyle: "block",
        fontSize: initFontSize,
        fontFamily: initFontFamily,
        fontWeight: 400,
        fontWeightBold: 600,
        letterSpacing: -1,
        lineHeight: 1.0,
        rescaleOverlappingGlyphs: true,
        customGlyphs: true,
        theme: initTheme,
        allowTransparency: false,
        scrollback: 5000,
        smoothScrollDuration: 0,
        rightClickSelectsWord: true,
        minimumContrastRatio: 4.5,
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

      // Track whether viewport is scrolled to the bottom
      term.onScroll(() => {
        if (!term) return;
        const buf = term.buffer.active;
        isAtBottomRef.current = buf.viewportY >= buf.baseY;
      });

      // Forward modifier+key combos that xterm intercepts before the PTY sees them
      term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if (e.type !== "keydown") return true;

        // Ctrl+V: paste from clipboard instead of sending raw \x16
        if (e.key === "v" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
          navigator.clipboard.readText().then((text) => {
            if (text && !disposed) chunkedWrite(sessionId, text);
          }).catch(() => {});
          return false;
        }

        const keybindingStore = useKeybindingStore.getState();
        
        // Check if this event matches ANY app shortcut
        const actions = keybindingStore.getActionsForEvent(e);
        
        // If it matches an app shortcut, let it bubble to AppShell's window listener
        // by returning false (tells xterm to NOT handle it)
        if (actions.length > 0) {
          // Handle terminal-specific shortcuts here before bubbling
          if (actions.includes("terminal.search")) {
            setIsSearchOpen(true);
            setTimeout(() => searchInputRef.current?.focus(), 50);
            return false;
          }
          
          if (actions.includes("pane.zoom.toggle")) {
            onZoomToggle?.();
            return false;
          }
          
          // For all other shortcuts (pane split, workspace nav, etc.),
          // return false to let the event bubble to AppShell
          return false;
        }
        
        // Shift+Enter is used for multiline prompts by coding agents.
        if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey) {
          const processTitle = usePaneMetadataStore.getState().metadata[sessionId]?.processTitle;
          writeToSession(sessionId, getShiftEnterSequence(command, processTitle)).catch(console.error);
          return false;
        }
        
        // No app shortcut match → let xterm handle it normally (typing, Ctrl+C, etc.)
        return true;
      });

      // Auto-copy selection to clipboard (WezTerm-style)
      term.onSelectionChange(() => {
        if (disposed || !term) return;
        const selection = term.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).catch(() => {});
        }
      });

      // Send user keystrokes to PTY
      term.onData((data) => {
        chunkedWrite(sessionId, data);
      });

      term.onBinary((data) => {
        writeToSession(sessionId, data).catch(console.error);
      });

      // Track terminal title changes (set via escape sequences by shells/apps)
      term.onTitleChange((title) => {
        if (disposed || !title) return;
        usePaneMetadataStore.getState().setMetadata(sessionId, { processTitle: title });
      });

      let _lastLogLine = "";

      const runScan = () => {
        if (!term || disposed) return;
        let buf;
        try {
          // If term was disposed externally (evictTerminalCache), buffer access
          // may throw. Guard to avoid crashing the notification pipeline.
          buf = term.buffer.active;
        } catch {
          return;
        }
        // Scan the bottom 8 visible rows (not the cursor row alone).
        // Claude Code approval prompts are multi-line boxes and the
        // decisive "(y/n)" or "❯ 1. Yes" line may not be at the cursor.
        const rows = term.rows;
        const start = buf.baseY + Math.max(0, rows - 8);
        const end = buf.baseY + rows - 1;
        const scanLines: string[] = [];
        let lastNonEmpty = "";
        for (let i = start; i <= end; i++) {
          const lineObj = buf.getLine(i);
          if (!lineObj) continue;
          const text = lineObj.translateToString(true).replace(/\x1b\[[0-9;]*m/g, "").trim();
          if (text.length > 0) {
            scanLines.push(text);
            lastNonEmpty = text;
          }
        }
        if (scanLines.length === 0) return;

        // 1. Agent status detection — check any of the scanned lines.
        let agentStatus: AgentStatus | undefined;
        const approvalPatternId = scanForApproval(scanLines);
        const isSpinner = scanLines.some((l) => SPINNER_CHARS.test(l) && l.length < 80);
        const isWorking = isSpinner || scanLines.some((l) => WORKING_PATTERN.test(l));
        const isStatusBarOnly =
          !isSpinner &&
          scanLines.every((l) => isShortcutHintLine(l) || /esc to interrupt/i.test(l));

        if (approvalPatternId > 0) {
          agentStatus = "waiting";
        } else if (isWorking && !isStatusBarOnly) {
          agentStatus = "working";
        } else if (DONE_PATTERNS.some((re) => re.test(lastNonEmpty))) {
          agentStatus = "done";
        }

        // 2. Log line extraction — same noise filter as before, based on last non-empty line.
        const isNoiseLine =
          /\d+k?\s+tokens/i.test(lastNonEmpty) ||
          /access \d+/i.test(lastNonEmpty) ||
          /past research/i.test(lastNonEmpty) ||
          /http:\/\/localhost/i.test(lastNonEmpty) ||
          isShortcutHintLine(lastNonEmpty) ||
          /^\s*[\u2500-\u257F]+\s*$/.test(lastNonEmpty) ||
          lastNonEmpty.length < 3;
        const isShellPrompt = /^>\s*$/.test(lastNonEmpty) || /\$\s*$/.test(lastNonEmpty);
        const logChanged = lastNonEmpty !== _lastLogLine;

        const logLineUpdate = isShellPrompt
          ? { lastLogLine: undefined }
          : isNoiseLine
            ? {}
            : logChanged ? { lastLogLine: lastNonEmpty } : {};
        if (!isNoiseLine) _lastLogLine = lastNonEmpty;

        usePaneMetadataStore.getState().setMetadata(sessionId, {
          ...logLineUpdate,
          agentStatus,
        });

        // 3. Notification firing — single authoritative activePaneId read.
        if (agentStatus === "waiting" && approvalPatternId > 0) {
          const activePaneId = useUiStore.getState().activePaneId;
          if (activePaneId !== sessionId) {
            const didNotify = usePaneMetadataStore
              .getState()
              .notifyWaiting(sessionId, approvalPatternId);
            if (didNotify) {
              playNotificationSound();
            }
          }
        }
      };

      term.onWriteParsed(() => {
        if (!term || disposed) return;
        // Leading scan via throttle (150ms) + trailing idle flush (200ms after
        // last write). The combination catches both mid-stream approval lines
        // and the "final frame" that fell into a throttle gap.
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

      // Register exit listener before spawning PTY to avoid race
      let sessionStarted = false;
      unlistenExit = await onPtyExit(sessionId, () => {
        if (disposed || !sessionStarted) return;
        onExit?.();
      });

      if (disposed) {
        unlistenExit?.();
        return;
      }

      fitAddon.fit();
      const cols = term.cols;
      const rows = term.rows;
      const sessionEnv = launchEnv || undefined;

      try {
        await createSession(sessionId, command, args, cols, rows, (rawData: ArrayBuffer) => {
          if (disposed || !term) return;
          settleStartupSession();
          try { term.write(new Uint8Array(rawData)); } catch { /* disposed between check and write */ }
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

      // Resize observer — 50ms debounce (was 100ms)
      resizeObserver = new ResizeObserver(() => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
          if (disposed || !fitAddon || !term) return;
          fitAddon.fit();
          resizeSession(sessionId, term.cols, term.rows).catch(console.error);
        }, 50);
      });
      resizeObserver.observe(container!);

      // If config wasn't cached yet, apply font settings once loaded (theme comes from store)
      if (!cfg && !fontSize && !fontFamily) {
        ensureConfigLoaded().then(() => {
          if (disposed || !term || !cachedConfig) return;
          term.options.fontSize = cachedConfig.fontSize;
          term.options.fontFamily = cachedConfig.fontFamily;
          fitAddon?.fit();
        });
      }
    }

    init();

    return () => {
      clearTimeout(resizeTimeout);
      if (startupSettleTimeout) {
        clearTimeout(startupSettleTimeout);
      }
      if (logThrottle) { clearTimeout(logThrottle); logThrottle = null; }
      if (idleFlush) { clearTimeout(idleFlush); idleFlush = null; }
      resizeObserver?.disconnect();
      // Cache terminal for potential remount instead of disposing.
      // Allotment may remount surviving panes on sibling removal.
      // Intentionally do NOT flip `disposed` when caching — the onWriteParsed
      // handler captured by this closure remains registered on the cached
      // Terminal and must keep updating the metadata store after remount.
      if (term && term.element) {
        const el = term.element;
        if (el.parentNode === container) container.removeChild(el);
        termCache.set(sessionId, {
          term,
          fitAddon: fitAddon!,
          searchAddon: searchAddonRef.current!,
          xtermElement: el,
          unlistenExit,
        });
      } else {
        disposed = true;
        unlistenExit?.();
        term?.dispose();
      }
      searchAddonRef.current = null;
    };
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
          background: "var(--cmux-bg, #1a1a1a)",
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
          background: "var(--cmux-bg, #0a0a0a)",
        }}
      />
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
