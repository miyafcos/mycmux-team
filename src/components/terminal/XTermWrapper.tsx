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
  suppressNotifications?: boolean;
  onZoomToggle?: () => void;
  onUrlClick?: (url: string) => void;
  cwd?: string;
  launchEnv?: Record<string, string>;
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
  suppressNotifications = false,
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

  // Dynamically update terminal theme and font size
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = storeTheme.terminal;
      termRef.current.options.fontSize = storeFontSize;
      setTimeout(() => fitAddonRef.current?.fit(), 10);
    }
  }, [storeTheme, storeFontSize]);

  // Scroll to bottom when pane becomes visible — only if user was at bottom before switching
  useEffect(() => {
    if (suppressNotifications && termRef.current) {
      setTimeout(() => {
        fitAddonRef.current?.fit();
        if (isAtBottomRef.current) {
          termRef.current?.scrollToBottom();
        }
      }, 50);
    }
  }, [suppressNotifications]);

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

      let _lastParsedOut = "";
      term.onWriteParsed(() => {
        if (!term || disposed) return;
        // Throttle to 500ms — prevents hammering Zustand on every keystroke
        if (logThrottle) return;
        logThrottle = setTimeout(() => {
          logThrottle = null;
          if (!term || disposed) return;
          const buf = term.buffer.active;
          const y = buf.baseY + buf.cursorY;
          let lastLine = "";

          // Find the most recent non-empty line (current cursor position)
          for (let i = y; i >= Math.max(0, y - 3); i--) {
            const lineObj = buf.getLine(i);
            if (lineObj) {
              const text = lineObj.translateToString(true).trim();
              if (text.length > 0) {
                if (!lastLine) lastLine = text;
                break;
              }
            }
          }
          if (lastLine.length > 0 && lastLine !== _lastParsedOut) {
            _lastParsedOut = lastLine;

            // Detect Claude Code agent status from output patterns
            // Scan the recent block (multiple lines) for accurate detection
            let agentStatus: AgentStatus | undefined;
            const stripped = lastLine.replace(/\x1b\[[0-9;]*m/g, "").trim();
            // Detect agent status — patterns tuned for Claude Code CLI.
            // Only checks the current line (stripped) to avoid false positives.
            // Spinner: only the specific Braille chars used by Claude Code / Ink spinners
            // (not the full U+2800-28FF range which includes box-drawing used by tree/ls)
            const isSpinner = /[\u25CF\u25CB\u25D0-\u25D3\u2737\u2731\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F]/.test(stripped) && stripped.length < 80;
            const isWorking = isSpinner || /working\.\.\.|thinking\.\.\.|analyzing|executing|applying/i.test(stripped);
            // "esc to interrupt" or hotkey legends alone on the status bar are not work signals.
            const isStatusBar = (isShortcutHintLine(stripped) || /esc to interrupt/i.test(stripped)) && !isSpinner;

            if (isWorking && !isStatusBar) {
              agentStatus = "working";
            } else if (
              // Claude Code tool approval: "Allow X? (y/n)" on the CURRENT line
              /allow\s+.*\?\s*\(y\/n\)/i.test(stripped) ||
              // AskUserQuestion: numbered choices on current line
              /^\s*\d+\.\s+.+\(.*\)/.test(stripped) ||
              // Direct yes/no on current line only
              /\(y\/n\)\s*$/i.test(stripped) ||
              /\[y\/N\]/i.test(stripped) ||
              // "Type your answer/response" prompt (Claude Code AskUser)
              /type your (answer|response)/i.test(stripped) ||
              /press enter to (continue|confirm|submit)/i.test(stripped) ||
              /hit enter to /i.test(stripped) ||
              /\bapprove\b.*\?/i.test(stripped)
            ) {
              agentStatus = "waiting";
            } else if (
              /\u2713\s*(done|complete|finished)/i.test(stripped) ||
              /^>\s*$/.test(stripped) ||
              /\$\s*$/.test(stripped)
            ) {
              agentStatus = "done";
            }

            // Filter out terminal chrome / status bar noise before storing as log line.
            // These patterns match Claude Code's bottom status bar (token cost, session info)
            // and other terminal UI lines that aren't meaningful agent output.
            const isNoiseLine =
              /\d+k?\s+tokens/i.test(stripped) ||
              /access \d+/i.test(stripped) ||
              /past research/i.test(stripped) ||
              /http:\/\/localhost/i.test(stripped) ||
              isShortcutHintLine(stripped) ||
              /^\s*[\u2500-\u257F]+\s*$/.test(stripped) || // box-drawing chars only
              stripped.length < 3;

            // When agent returns to shell prompt (done/idle), clear the log line.
            // For noise lines, omit the key entirely so the previous meaningful value is preserved.
            const isShellPrompt = /^>\s*$/.test(stripped) || /\$\s*$/.test(stripped);
            const logLineUpdate = isShellPrompt
              ? { lastLogLine: undefined }          // clear on shell prompt
              : isNoiseLine
                ? {}                               // preserve previous value for noise
                : { lastLogLine: lastLine };       // update with meaningful line

            usePaneMetadataStore.getState().setMetadata(sessionId, {
              ...logLineUpdate,
              agentStatus, // always write — clears stale status when no pattern matches
            });
            // Trigger notification ONLY when agent needs user approval (waiting status)
            if (!suppressNotifications && agentStatus === "waiting") {
              const activePaneId = useUiStore.getState().activePaneId;
              if (activePaneId !== sessionId) {
                const didNotify = usePaneMetadataStore.getState().notifyWaiting(sessionId, stripped);
                if (didNotify) {
                  playNotificationSound();
                }
              }
            }
          }
        }, 500);
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
      disposed = true;
      clearTimeout(resizeTimeout);
      if (startupSettleTimeout) {
        clearTimeout(startupSettleTimeout);
      }
      if (logThrottle) { clearTimeout(logThrottle); logThrottle = null; }
      resizeObserver?.disconnect();
      // Cache terminal for potential remount instead of disposing.
      // Allotment may remount surviving panes on sibling removal.
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
