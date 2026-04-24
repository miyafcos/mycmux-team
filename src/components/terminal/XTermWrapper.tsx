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
import { useKeybindingStore } from "../../stores/keybindingStore";
import { useSettingsStore } from "../../stores/settingsStore";
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

/** Read the last N non-empty lines of a pane's xterm buffer, ANSI/control-char stripped. */
export function getTerminalBufferLines(sessionId: string, maxLines: number): string[] {
  const cached = termCache.get(sessionId);
  if (!cached || maxLines <= 0) return [];
  try {
    const buf = cached.term.buffer.active;
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
  // Used for scroll-to-bottom-on-activate.
  const isActivePane = useUiStore((s) => s.activePaneId === sessionId);

  // Dynamically update terminal theme and font size
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = storeTheme.terminal;
      termRef.current.options.fontSize = storeFontSize;
      setTimeout(() => fitAddonRef.current?.fit(), 10);
    }
  }, [storeTheme, storeFontSize]);

  // Scroll to bottom when this tab becomes active only if the user was already at bottom.
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
    let termDisposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    let unlistenExit: (() => void) | null = null;
    let writeParsedDisposable: { dispose: () => void } | null = null;
    let scrollDisposable: { dispose: () => void } | null = null;
    let term: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let logThrottle: ReturnType<typeof setTimeout> | null = null;
    let idleFlush: ReturnType<typeof setTimeout> | null = null;
    let backgroundScanThrottle: ReturnType<typeof setTimeout> | null = null;
    let startupSettleTimeout: ReturnType<typeof setTimeout> | null = null;
    let startupSettled = false;
    let sessionStarted = false;
    let lastLogLine = "";
    let lastScanSignature = "";

    const clearResizeTimer = (): void => {
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
        resizeTimeout = null;
      }
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

    const scheduleResize = (currentTerm: Terminal, currentFitAddon: FitAddon, delay: number): void => {
      clearResizeTimer();
      resizeTimeout = setTimeout(() => {
        resizeTimeout = null;
        if (disposed || termDisposed) return;
        currentFitAddon.fit();
        resizeSession(sessionId, currentTerm.cols, currentTerm.rows).catch(console.error);
      }, delay);
    };

    const registerResizeObserver = (currentTerm: Terminal, currentFitAddon: FitAddon): void => {
      resizeObserver?.disconnect();
      resizeObserver = new ResizeObserver(() => {
        scheduleResize(currentTerm, currentFitAddon, 50);
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
      unlistenExit?.();
      unlistenExit = null;
      cacheCurrentTerminal();
      searchAddonRef.current = null;
      termRef.current = null;
      fitAddonRef.current = null;
    };

    const attachCachedTerminal = (cached: CachedTerm): void => {
      cached.unlistenExit?.();
      termCache.delete(sessionId);
      container.appendChild(cached.xtermElement);
      term = cached.term;
      fitAddon = cached.fitAddon;
      sessionStarted = true;
      termRef.current = cached.term;
      fitAddonRef.current = cached.fitAddon;
      searchAddonRef.current = cached.searchAddon;
      registerScrollListener(cached.term);
      attachTerminalKeyHandler(cached.term);
      registerScanListener(cached.term);
      void registerExitListener();
      setTimeout(() => {
        if (disposed || termDisposed) return;
        cached.fitAddon.fit();
        resizeSession(sessionId, cached.term.cols, cached.term.rows).catch(console.error);
      }, 30);
      registerResizeObserver(cached.term, cached.fitAddon);
    };

    const cached = termCache.get(sessionId);
    if (cached) {
      attachCachedTerminal(cached);
      return cleanup;
    }

    async function init(): Promise<void> {
      if (disposed) return;
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
      registerScrollListener(term);
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

      fitAddon.fit();
      const cols = term.cols;
      const rows = term.rows;
      const sessionEnv = launchEnv || undefined;

      try {
        await createSession(sessionId, command, args, cols, rows, (rawData: ArrayBuffer) => {
          if (termDisposed || !term) return;
          settleStartupSession();
          try {
            term.write(new Uint8Array(rawData), () => {
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
          term.options.fontSize = cachedConfig.fontSize;
          term.options.fontFamily = cachedConfig.fontFamily;
          fitAddon?.fit();
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
