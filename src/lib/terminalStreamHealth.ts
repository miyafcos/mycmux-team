import { getSessionOutputSnapshot, type SessionOutputSnapshot } from "./ipc";
import { withTerminalDeadline } from "./terminalDeadline";

export const TERMINAL_HEALTH_POLL_MS = 2_000;
export const TERMINAL_STREAM_STALE_MS = 10_000;
export const TERMINAL_RECOVERY_COOLDOWN_MS = 30_000;
export const TERMINAL_RECOVERY_WINDOW_MS = 10 * 60_000;
export const TERMINAL_RECOVERY_LIMIT = 5;

/** Tracks parsing progress, not just delivery/ACKs (a wedged pump still ACKs). */
export class TerminalStreamHealth {
  private visibleSince: number | null = null;
  private lastAppliedAt: number;
  private lastReceivedAt: number;
  private attempts: number[] = [];
  constructor(private readonly now: () => number = () => Date.now()) {
    this.lastAppliedAt = this.lastReceivedAt = now();
  }
  received(): void { this.lastReceivedAt = this.now(); }
  applied(): void { this.lastAppliedAt = this.now(); }
  attached(): void { this.lastAppliedAt = this.lastReceivedAt = this.now(); }
  inspect(visible: boolean, backendOutputAt: number | null | undefined): "channel-stall" | "write-stall" | null {
    const now = this.now();
    if (!visible) { this.visibleSince = null; return null; }
    this.visibleSince ??= now;
    if (backendOutputAt == null || backendOutputAt <= this.lastAppliedAt
      || now - Math.max(this.visibleSince, this.lastAppliedAt) < TERMINAL_STREAM_STALE_MS) return null;
    this.attempts = this.attempts.filter(at => now - at < TERMINAL_RECOVERY_WINDOW_MS);
    if (this.attempts.length >= TERMINAL_RECOVERY_LIMIT
      || (this.attempts.length > 0 && now - this.attempts[this.attempts.length - 1] < TERMINAL_RECOVERY_COOLDOWN_MS)) return null;
    this.attempts.push(now);
    return now - this.lastReceivedAt >= TERMINAL_STREAM_STALE_MS ? "channel-stall" : "write-stall";
  }
}

type Watch = {
  sessionId: string;
  visible: () => boolean;
  health: TerminalStreamHealth;
  recover: (reason: "channel-stall" | "write-stall") => Promise<void>;
};

/** One snapshot IPC per window/poll, only when at least one pane is writable. */
export class TerminalHealthMonitor {
  private watches = new Set<Watch>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private recovering = false;
  constructor(private readonly snapshot: () => Promise<SessionOutputSnapshot> = getSessionOutputSnapshot) {}
  watch(watch: Watch): () => void {
    this.watches.add(watch);
    if (this.timer === null) this.timer = setInterval(() => { void this.poll(); }, TERMINAL_HEALTH_POLL_MS);
    return () => {
      this.watches.delete(watch);
      if (this.watches.size === 0 && this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    };
  }
  async poll(): Promise<void> {
    if (this.polling) return;
    const active = [...this.watches].filter(watch => {
      const visible = watch.visible();
      if (!visible) watch.health.inspect(false, null);
      return visible;
    });
    if (active.length === 0) return;
    this.polling = true;
    try {
      const output = await withTerminalDeadline(this.snapshot(), "terminal health snapshot");
      if (this.recovering) return;
      for (const watch of active) {
        if (!this.watches.has(watch)) continue;
        const reason = watch.health.inspect(watch.visible(), output[watch.sessionId]);
        if (!reason) continue;
        this.recovering = true;
        void watch.recover(reason).catch(() => {}).finally(() => { this.recovering = false; });
        break;
      }
    } catch {
      // An unavailable snapshot is not proof of a dead PTY. The next poll is
      // still admitted; no per-pane IPC/reconnect storm on a slow backend.
    } finally { this.polling = false; }
  }
}

export const terminalHealthMonitor = new TerminalHealthMonitor();
