import { getSessionOutputSnapshot, type SessionOutputSnapshot } from "./ipc";
import { withTerminalDeadline } from "./terminalDeadline";
import { currentPtyRead, type PtyReadGeneration } from "./ptyReadGeneration";

export const TERMINAL_HEALTH_POLL_MS = 2_000;
export const TERMINAL_STREAM_STALE_MS = 10_000;
export const TERMINAL_RECOVERY_COOLDOWN_MS = 30_000;
export const TERMINAL_RECOVERY_WINDOW_MS = 10 * 60_000;
export const TERMINAL_RECOVERY_LIMIT = 5;

/** Tracks parsing progress, not just delivery/ACKs (a wedged pump still ACKs). */
export class TerminalStreamHealth {
  private visibleSince: number | null = null;
  private lastAppliedAt: number;
  private lastAppliedElapsed: number;
  private lastReceivedElapsed: number;
  private unparsedSince: number | null = null;
  private progress?: { source: PtyReadGeneration; generation: number; receivedEnd: number };
  private parsedPosition?: { source: PtyReadGeneration; generation: number | undefined; end: number };
  private parseCount = 0;
  private paintCount = 0;
  private sampledParse = 0;
  private sampledBackend: number | null = null;
  private backendAdvanceAt: number | null = null;
  private parseAdvanceAt: number | null = null;
  private firstPaintPairAt: number | null = null;
  private lastPaintPairAt: number | null = null;
  private attempts: number[] = [];
  private readonly now: () => number;
  private readonly elapsed: () => number;
  constructor(clock?: () => number) {
    this.now = clock ?? (() => Date.now());
    this.elapsed = clock ?? (() => performance.now());
    this.lastAppliedAt = this.now();
    this.lastAppliedElapsed = this.lastReceivedElapsed = this.elapsed();
  }
  received(unparsed = true): void {
    this.lastReceivedElapsed = this.elapsed();
    if (unparsed) this.unparsedSince ??= this.lastReceivedElapsed;
  }
  applied(): void {
    this.lastAppliedAt = this.now();
    this.lastAppliedElapsed = this.elapsed();
    this.unparsedSince = null;
  }
  observeReceipt(source: PtyReadGeneration, generation: number, end: number): void {
    const sample = this.progress;
    if (sample?.source !== source || sample.generation !== generation) {
      this.progress = { source, generation, receivedEnd: end };
    } else {
      sample.receivedEnd = Math.max(sample.receivedEnd, end);
    }
    this.received(end > (this.matchedParse()?.end ?? -1));
  }
  observeCurrentParse(sessionId: string, source: PtyReadGeneration, generation?: number, end?: number): boolean {
    return currentPtyRead(sessionId, source) && this.observeParse(source, generation, end);
  }
  observeParse(source: PtyReadGeneration, generation?: number, end?: number): boolean {
    const sample = this.progress;
    if (sample?.source === source && generation !== undefined && sample.generation !== generation) return false;
    const previous = this.parsedPosition;
    // A delayed callback for an already covered position cannot account for newer backend output.
    if (end !== undefined && previous?.source === source
      && (generation === previous.generation || generation === undefined || previous.generation === undefined)
      && end <= previous.end) return false;
    this.applied();
    this.parseCount++;
    if (end !== undefined) this.parsedPosition = { source, generation, end };
    return true;
  }
  resetReadProgress(): void {
    this.progress = undefined;
    this.parsedPosition = undefined;
    this.unparsedSince = null;
    this.lastReceivedElapsed = this.lastAppliedElapsed;
  }
  private matchedParse() {
    const sample = this.progress;
    const position = this.parsedPosition;
    // A ring write has a PTY read lifetime and byte position, but no live channel ID.
    if (sample && position?.source === sample.source
      && (position.generation === undefined || position.generation === sample.generation)) return position;
    return undefined;
  }
  diagnosticProgress(source: PtyReadGeneration): Record<string, number> {
    const sample = this.progress;
    if (sample?.source !== source) return {};
    const parsed = this.matchedParse();
    return {
      generation: sample.generation, received_end: sample.receivedEnd,
      ...(parsed ? { parsed_end: parsed.end } : {}),
    };
  }
  get renderCount(): number { return this.paintCount; }
  private resetPaintEvidence(): void {
    this.firstPaintPairAt = this.lastPaintPairAt = this.backendAdvanceAt = this.parseAdvanceAt = null;
    this.sampledParse = this.parseCount;
  }
  resetPaintVisibility(): void {
    this.resetPaintEvidence();
    this.sampledBackend = null;
  }
  rendered(): void {
    this.paintCount++;
    this.resetPaintEvidence();
  }
  inspectPaint(eligible: boolean, backendAt: number | null | undefined): boolean {
    const now = this.elapsed();
    if (!eligible || backendAt == null) {
      this.resetPaintVisibility();
      return false;
    }
    if (this.lastPaintPairAt !== null && now - this.lastPaintPairAt >= TERMINAL_STREAM_STALE_MS) {
      this.firstPaintPairAt = this.lastPaintPairAt = null;
    }
    if (this.backendAdvanceAt !== null && now - this.backendAdvanceAt >= TERMINAL_STREAM_STALE_MS) this.backendAdvanceAt = null;
    if (this.parseAdvanceAt !== null && now - this.parseAdvanceAt >= TERMINAL_STREAM_STALE_MS) this.parseAdvanceAt = null;
    if (this.sampledBackend !== null && backendAt > this.sampledBackend) this.backendAdvanceAt = now;
    if (this.parseCount !== this.sampledParse) this.parseAdvanceAt = now;
    this.sampledParse = this.parseCount;
    this.sampledBackend = backendAt;
    // Delivery and the real parse callback may arrive on opposite sides of a poll.
    if (this.backendAdvanceAt === null || this.parseAdvanceAt === null) return false;
    this.backendAdvanceAt = this.parseAdvanceAt = null;
    this.firstPaintPairAt ??= now;
    this.lastPaintPairAt = now;
    return now - this.firstPaintPairAt >= TERMINAL_STREAM_STALE_MS;
  }
  attached(): void {
    this.applied();
    this.lastReceivedElapsed = this.lastAppliedElapsed;
  }
  inspect(visible: boolean, backendOutputAt: number | null | undefined): "channel-stall" | "write-stall" | null {
    if (!visible) { this.visibleSince = null; return null; }
    const elapsed = this.elapsed();
    this.visibleSince ??= elapsed;
    const stalledSince = Math.max(this.visibleSince, this.lastAppliedElapsed, this.unparsedSince ?? 0);
    if (backendOutputAt == null || backendOutputAt <= this.lastAppliedAt
      || elapsed - stalledSince < TERMINAL_STREAM_STALE_MS) return null;
    this.attempts = this.attempts.filter(at => elapsed - at < TERMINAL_RECOVERY_WINDOW_MS);
    if (this.attempts.length >= TERMINAL_RECOVERY_LIMIT
      || (this.attempts.length > 0 && elapsed - this.attempts[this.attempts.length - 1] < TERMINAL_RECOVERY_COOLDOWN_MS)) return null;
    this.attempts.push(elapsed);
    return elapsed - this.lastReceivedElapsed >= TERMINAL_STREAM_STALE_MS ? "channel-stall" : "write-stall";
  }
}

type Watch = {
  sessionId: string;
  visible: () => boolean;
  health: TerminalStreamHealth;
  paint?: { sized: () => boolean; repair: () => void };
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
      if (!visible && watch.paint) watch.health.inspectPaint(false, null);
      return visible;
    });
    if (active.length === 0) return;
    this.polling = true;
    try {
      const output = await withTerminalDeadline(this.snapshot(), "terminal health snapshot");
      if (this.recovering) return;
      const paintVisibility = new Map<Watch, boolean>();
      for (const watch of active) {
        if (!this.watches.has(watch)) continue;
        const visible = watch.visible();
        if (watch.paint) paintVisibility.set(watch, visible);
        const reason = watch.health.inspect(visible, output[watch.sessionId]);
        if (!reason) continue;
        this.recovering = true;
        void watch.recover(reason).catch(() => {}).finally(() => { this.recovering = false; });
        break;
      }
      if (!this.recovering) {
        for (const [watch, visible] of paintVisibility) {
          if (!watch.paint || !this.watches.has(watch)) continue;
          if (watch.health.inspectPaint(visible && watch.paint.sized(), output[watch.sessionId])) watch.paint.repair();
        }
      }
    } catch {
      // An unavailable snapshot is not proof of a dead PTY. The next poll is
      // still admitted; no per-pane IPC/reconnect storm on a slow backend.
    } finally { this.polling = false; }
  }
}

export const terminalHealthMonitor = new TerminalHealthMonitor();
