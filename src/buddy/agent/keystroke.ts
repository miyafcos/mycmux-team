import type { BuddyMood } from "./types";

export interface KeystrokeReaction {
  mood: BuddyMood;
  durationMs: number;
  fromBuffer: string;
  isDangerous: boolean;
  isSensitive: boolean;
}

interface KeystrokeEventDetail {
  sessionId: string;
  data: string;
}

const MAX_BUFFER_LEN = 256;
const IDLE_MS = 400;
const SENSITIVE_TAIL_MS = 8_000;

const DANGER_PATTERNS: RegExp[] = [
  /\brm\s+-rf\b/,
  /\bgit\s+push\s+(-[a-z]*f|--force)\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bdd\s+if=/,
  /\bmkfs\./,
  /:>\s*\/dev\/sd/,
  /\bdrop\s+(table|database)\b/i,
  /\bshutdown\s+/i,
  /\btruncate\s+table\b/i,
];

const SENSITIVE_STARTERS: RegExp[] = [
  /^\s*ssh\b/,
  /^\s*scp\b/,
  /^\s*sudo\b/,
  /^\s*su\b/,
  /^\s*gpg\b/,
  /^\s*mysql\b.*-p/,
  /^\s*psql\b.*-W/,
];

export class KeystrokeTracker {
  private buffer = "";
  private sensitiveUntilMs = 0;
  private idleTimerId: number | null = null;
  private onIdle: ((reaction: KeystrokeReaction) => void) | null = null;
  private onFastReact: ((reaction: KeystrokeReaction) => void) | null = null;
  private backspaceStreak = 0;

  start(hooks: {
    onFastReact: (reaction: KeystrokeReaction) => void;
    onIdle: (reaction: KeystrokeReaction) => void;
  }): void {
    this.onFastReact = hooks.onFastReact;
    this.onIdle = hooks.onIdle;
    window.addEventListener("mycmux:keystroke", this.handleEvent as EventListener);
  }

  stop(): void {
    window.removeEventListener("mycmux:keystroke", this.handleEvent as EventListener);
    this.clearIdleTimer();
    this.buffer = "";
    this.onFastReact = null;
    this.onIdle = null;
  }

  getBuffer(): string {
    return this.buffer;
  }

  isSensitiveNow(now = Date.now()): boolean {
    return this.sensitiveUntilMs > now;
  }

  private handleEvent = (event: Event): void => {
    const custom = event as CustomEvent<KeystrokeEventDetail>;
    const data = custom.detail?.data;
    if (typeof data !== "string" || data.length === 0) return;

    // Enter / Return → commit + reset (line sent to shell)
    if (data === "\r" || data === "\n" || data === "\r\n") {
      const committed = this.buffer.trim();
      if (committed.length > 0 && SENSITIVE_STARTERS.some((r) => r.test(committed))) {
        this.sensitiveUntilMs = Date.now() + SENSITIVE_TAIL_MS;
      }
      this.buffer = "";
      this.backspaceStreak = 0;
      this.clearIdleTimer();
      return;
    }

    // Backspace / DEL
    if (data === "\x7f" || data === "\b") {
      this.buffer = this.buffer.slice(0, -1);
      this.backspaceStreak += 1;
      if (this.backspaceStreak === 5) {
        this.fire("fast", "amused", 2400);
      }
      this.scheduleIdle();
      return;
    }

    // Ctrl+C / Ctrl+U / other control that resets line
    if (data === "\x03" || data === "\x15" || data === "\x1b") {
      this.buffer = "";
      this.backspaceStreak = 0;
      this.clearIdleTimer();
      return;
    }

    // Filter other control sequences (arrows, etc.) but keep tab-less visible chars
    if (data.charCodeAt(0) < 0x20 && data !== "\t") {
      return;
    }

    // Printable input — append
    this.backspaceStreak = 0;
    this.buffer = (this.buffer + data).slice(-MAX_BUFFER_LEN);

    // Danger pattern match (on current buffer)
    if (DANGER_PATTERNS.some((r) => r.test(this.buffer))) {
      this.fire("fast", "alert", 3200);
    }

    this.scheduleIdle();
  };

  private scheduleIdle(): void {
    this.clearIdleTimer();
    this.idleTimerId = window.setTimeout(() => {
      this.idleTimerId = null;
      this.fire("idle", this.classifyIdle(), 2000);
    }, IDLE_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimerId !== null) {
      window.clearTimeout(this.idleTimerId);
      this.idleTimerId = null;
    }
  }

  private classifyIdle(): BuddyMood {
    const buf = this.buffer.trim();
    if (buf.length === 0) return "idle";
    if (/\?$/.test(buf) || /^(why|how|what|なぜ|どう|何)/.test(buf)) return "curious";
    if (/^(claude|codex|git|npm|yarn|pnpm|cargo|python|node|bun)\s/.test(buf)) return "listening";
    return "listening";
  }

  private fire(kind: "fast" | "idle", mood: BuddyMood, durationMs: number): void {
    const sensitive = this.isSensitiveNow() || SENSITIVE_STARTERS.some((r) => r.test(this.buffer));
    const reaction: KeystrokeReaction = {
      mood,
      durationMs,
      fromBuffer: sensitive ? "" : this.buffer,
      isDangerous: mood === "alert",
      isSensitive: sensitive,
    };
    if (kind === "fast") {
      this.onFastReact?.(reaction);
    } else {
      this.onIdle?.(reaction);
    }
  }
}
