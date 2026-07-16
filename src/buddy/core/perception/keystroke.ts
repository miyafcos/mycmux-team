import type { BuddyDomEvents, KeystrokeEventDetail } from "../../adapters/dom-events";
import type { Scheduler } from "../../adapters/scheduler";
import type { BuddyMood } from "../types";

export interface KeystrokeReaction {
  mood: BuddyMood;
  durationMs: number;
  fromBuffer: string;
  isDangerous: boolean;
  isSensitive: boolean;
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
  private unsubscribeKeystroke: (() => void) | null = null;
  private onIdle: ((reaction: KeystrokeReaction) => void) | null = null;
  private onFastReact: ((reaction: KeystrokeReaction) => void) | null = null;
  private backspaceStreak = 0;

  constructor(
    private readonly scheduler: Scheduler,
    private readonly domEvents: BuddyDomEvents,
  ) {}

  start(hooks: {
    onFastReact: (reaction: KeystrokeReaction) => void;
    onIdle: (reaction: KeystrokeReaction) => void;
  }): void {
    this.onFastReact = hooks.onFastReact;
    this.onIdle = hooks.onIdle;
    this.unsubscribeKeystroke = this.domEvents.subscribeKeystroke(this.handleEvent);
  }

  stop(): void {
    this.unsubscribeKeystroke?.();
    this.unsubscribeKeystroke = null;
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

  private handleEvent = (detail: KeystrokeEventDetail): void => {
    const data = detail?.data;
    if (typeof data !== "string" || data.length === 0) return;

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

    if (data === "\x7f" || data === "\b") {
      this.buffer = this.buffer.slice(0, -1);
      this.backspaceStreak += 1;
      if (this.backspaceStreak === 5) {
        this.fire("fast", "applaud", 2400, false);
      }
      this.scheduleIdle();
      return;
    }

    if (data === "\x03" || data === "\x15" || data === "\x1b") {
      this.buffer = "";
      this.backspaceStreak = 0;
      this.clearIdleTimer();
      return;
    }

    if (data.charCodeAt(0) < 0x20 && data !== "\t") {
      return;
    }

    this.backspaceStreak = 0;
    this.buffer = (this.buffer + data).slice(-MAX_BUFFER_LEN);

    if (DANGER_PATTERNS.some((r) => r.test(this.buffer))) {
      this.fire("fast", "tsukkomi", 3200, true);
    }

    this.scheduleIdle();
  };

  private scheduleIdle(): void {
    this.clearIdleTimer();
    this.idleTimerId = this.scheduler.setTimeout(() => {
      this.idleTimerId = null;
      this.fire("idle", this.classifyIdle(), 2000, false);
    }, IDLE_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimerId !== null) {
      this.scheduler.clearTimeout(this.idleTimerId);
      this.idleTimerId = null;
    }
  }

  private classifyIdle(): BuddyMood {
    const buf = this.buffer.trim();
    if (buf.length === 0) return "idle";
    if (/\?$/.test(buf) || /^(why|how|what|なぜ|どう|何)/.test(buf)) return "thinking";
    return "idle";
  }

  private fire(
    kind: "fast" | "idle",
    mood: BuddyMood,
    durationMs: number,
    isDangerous: boolean,
  ): void {
    const sensitive = this.isSensitiveNow() || SENSITIVE_STARTERS.some((r) => r.test(this.buffer));
    const reaction: KeystrokeReaction = {
      mood,
      durationMs,
      fromBuffer: sensitive ? "" : this.buffer,
      isDangerous,
      isSensitive: sensitive,
    };
    if (kind === "fast") {
      this.onFastReact?.(reaction);
    } else {
      this.onIdle?.(reaction);
    }
  }
}
