import type { Scheduler } from "../../adapters/scheduler";
import type { ReactionsConfig } from "../config";
import type { BuddySignal } from "../perception/perception";
import {
  classifyReaction,
  errorSignature,
  isErrorSignal,
  type ReactionClassificationContext,
} from "./reaction-rules";
import type { BuddyReaction, ReactionCategoryMeta, ReactionKind, ReactionStrength } from "./reaction-types";

interface QueuedReaction {
  signal: BuddySignal;
  kind: ReactionKind;
  deadline: number;
  isIdle: boolean;
  isUserActive: boolean;
}

const ERROR_WINDOW_MS = 60_000;
const RECENT_FIRE_WINDOW_MS = 5 * 60_000;
const DEBOUNCE_MS = 2_000;
const STRONG_MIN_INTERVAL_MS = 20_000;
const USER_ACTIVE_MIN_INTERVAL_MS = 12_000;
const IDLE_MIN_INTERVAL_MS = 4_000;
const SLEEPY_AFTER_SECONDS = 5 * 60;

const PRIORITY: Record<ReactionKind, number> = {
  alarmed: 7,
  concerned: 6,
  exasperated: 5,
  impressed: 4,
  focus: 3,
  notice: 2,
  drowsy: 1,
  watch: 0,
};

const META_BY_KIND: Record<ReactionKind, ReactionCategoryMeta> = {
  notice: makeMeta("notice", "subtle", [600, 1000], 150, 250, false),
  watch: makeMeta("watch", "subtle", [600, 1000], 150, 250, false),
  focus: makeMeta("focus", "mid", [1200, 2000], 150, 300, false),
  impressed: makeMeta("impressed", "mid", [1200, 2000], 150, 300, false),
  exasperated: makeMeta("exasperated", "mid", [1200, 2000], 150, 300, false),
  concerned: makeMeta("concerned", "mid", [1200, 2000], 150, 300, false),
  alarmed: makeMeta("alarmed", "strong", [2400, 3200], 100, 400, true),
  drowsy: makeMeta("drowsy", "subtle", [600, 1000], 150, 250, false),
};

export class ReactionEngine {
  private lastFireAt = Number.NEGATIVE_INFINITY;
  private lastStrength: ReactionStrength | null = null;
  private windowQueue: QueuedReaction[] = [];
  private recentFires: number[] = [];
  private errorBucket = new Map<string, number[]>();
  private nextSerial = 1;
  private flushTimerId: number | null = null;
  private nextIdleSelfActionAt = 0;

  constructor(
    private readonly deps: {
      scheduler: Scheduler;
      config: () => ReactionsConfig;
      isSilent: () => boolean;
      onReaction: (reaction: BuddyReaction) => void;
    },
  ) {}

  onSignal(signal: BuddySignal): void {
    const cfg = this.deps.config();
    if (!cfg.enabled) {
      return;
    }

    const context = this.makeClassificationContext(signal);
    const kind = classifyReaction(signal, context);
    if (!kind) {
      return;
    }

    if (this.deps.isSilent() && kind !== "alarmed") {
      return;
    }

    if (!this.isAllowedByConfig(kind, cfg)) {
      return;
    }

    if (this.shouldDropQuietSignal(kind, cfg)) {
      return;
    }

    this.enqueue(signal, kind, {
      isIdle: false,
      isUserActive: signal.kind === "userTypingEvent" || signal.kind === "windowFocusEvent",
    });
  }

  onIdleTick(idleEvent: { idleSeconds: number }): void {
    const cfg = this.deps.config();
    if (!cfg.enabled || !cfg.idleSelfActions || this.deps.isSilent()) {
      return;
    }

    const now = Date.now();
    if (now < this.nextIdleSelfActionAt) {
      return;
    }

    const idleSeconds = idleEvent.idleSeconds;
    let kind: ReactionKind | null = null;
    let nextRange: [number, number] = [60_000, 120_000];

    if (idleSeconds >= 15 * 60) {
      kind = "drowsy";
      nextRange = [60_000, 120_000];
    } else if (idleSeconds >= SLEEPY_AFTER_SECONDS) {
      kind = Math.random() < 0.6 ? "focus" : "drowsy";
      nextRange = [90_000, 180_000];
    } else if (idleSeconds >= 2 * 60) {
      if (Math.random() < 0.5) {
        kind = "notice";
      }
      nextRange = [60_000, 120_000];
    }

    this.nextIdleSelfActionAt = now + randomBetween(nextRange[0], nextRange[1]);
    if (!kind || !this.isAllowedByConfig(kind, cfg)) {
      return;
    }

    const signal: BuddySignal = {
      kind: "idleEvent",
      timestamp_ms: now,
      idle_seconds: idleSeconds,
    };
    this.enqueue(signal, kind, { isIdle: true, isUserActive: false });
  }

  stop(): void {
    if (this.flushTimerId !== null) {
      this.deps.scheduler.clearTimeout(this.flushTimerId);
      this.flushTimerId = null;
    }
    this.windowQueue = [];
    this.errorBucket.clear();
    this.recentFires = [];
  }

  private makeClassificationContext(signal: BuddySignal): ReactionClassificationContext {
    if (!isErrorSignal(signal)) {
      return {};
    }

    const now = Date.now();
    const key = errorSignature(signal);
    const recent = (this.errorBucket.get(key) ?? []).filter((ts) => now - ts <= ERROR_WINDOW_MS);
    recent.push(now);
    this.errorBucket.set(key, recent);
    return { repeatedErrorCount: recent.length };
  }

  private enqueue(
    signal: BuddySignal,
    kind: ReactionKind,
    options: { isIdle: boolean; isUserActive: boolean },
  ): void {
    const now = Date.now();
    this.windowQueue.push({
      signal,
      kind,
      deadline: now + DEBOUNCE_MS,
      isIdle: options.isIdle,
      isUserActive: options.isUserActive,
    });

    if (this.flushTimerId !== null) {
      return;
    }

    this.flushTimerId = this.deps.scheduler.setTimeout(() => {
      this.flushTimerId = null;
      this.flush();
    }, DEBOUNCE_MS);
  }

  private flush(): void {
    const now = Date.now();
    const ready = this.windowQueue.filter((item) => item.deadline <= now);
    this.windowQueue = this.windowQueue.filter((item) => item.deadline > now);

    const selected = ready.sort((a, b) => PRIORITY[b.kind] - PRIORITY[a.kind])[0];
    if (selected && this.canFire(selected, now)) {
      this.fire(selected.kind, now);
    }

    if (this.windowQueue.length > 0 && this.flushTimerId === null) {
      const nextDeadline = Math.min(...this.windowQueue.map((item) => item.deadline));
      this.flushTimerId = this.deps.scheduler.setTimeout(() => {
        this.flushTimerId = null;
        this.flush();
      }, Math.max(1, nextDeadline - Date.now()));
    }
  }

  private canFire(item: QueuedReaction, now: number): boolean {
    const meta = this.getMeta(item.kind);
    const minIntervalMs = this.minIntervalMs(meta.strength, item, this.deps.config());
    if (now - this.lastFireAt < minIntervalMs) {
      return false;
    }

    this.recentFires = this.recentFires.filter((ts) => now - ts <= RECENT_FIRE_WINDOW_MS);
    if (meta.strength === "subtle") {
      const recentCount = this.recentFires.length;
      const chance = recentCount <= 3 ? 1 : recentCount <= 6 ? 0.6 : 0.3;
      const adjustedChance = this.deps.config().intensity === "calm" ? chance * 0.6 : chance;
      if (Math.random() > adjustedChance) {
        return false;
      }
    }

    return true;
  }

  private fire(kind: ReactionKind, now: number): void {
    const meta = this.getMeta(kind);
    const reaction: BuddyReaction = {
      id: this.nextSerial,
      kind,
      strength: meta.strength,
      durationMs: Math.round(randomBetween(meta.durationRange[0], meta.durationRange[1])),
      bodyKick: meta.bodyKick,
    };
    this.nextSerial += 1;
    this.lastFireAt = now;
    this.lastStrength = reaction.strength;
    this.recentFires.push(now);
    this.deps.onReaction(reaction);
  }

  private getMeta(kind: ReactionKind): ReactionCategoryMeta {
    const cfg = this.deps.config();
    if (kind === "alarmed" && (!cfg.allowStrong || cfg.intensity === "minimal")) {
      return { ...META_BY_KIND.alarmed, strength: "mid", durationRange: [1200, 2000], bodyKick: false };
    }
    return META_BY_KIND[kind];
  }

  private minIntervalMs(strength: ReactionStrength, item: QueuedReaction, cfg: ReactionsConfig): number {
    if (strength === "strong" || this.lastStrength === "strong") {
      return STRONG_MIN_INTERVAL_MS;
    }
    if (item.isUserActive) {
      return USER_ACTIVE_MIN_INTERVAL_MS;
    }
    if (item.isIdle) {
      return IDLE_MIN_INTERVAL_MS;
    }
    const multiplier = cfg.intensity === "calm" ? 1.5 : cfg.intensity === "minimal" ? 2 : 1;
    return cfg.minIntervalSeconds * 1000 * multiplier;
  }

  private isAllowedByConfig(kind: ReactionKind, cfg: ReactionsConfig): boolean {
    if (cfg.intensity === "minimal" && kind !== "alarmed" && kind !== "impressed") {
      return false;
    }
    if (!cfg.allowStrong && kind === "alarmed") {
      return true;
    }
    return true;
  }

  private shouldDropQuietSignal(kind: ReactionKind, cfg: ReactionsConfig): boolean {
    if (kind === "alarmed" || kind === "impressed" || kind === "exasperated" || kind === "concerned") {
      return false;
    }

    const chance = cfg.intensity === "calm" ? 0.35 * 0.6 : cfg.intensity === "minimal" ? 0 : 0.35;
    return Math.random() >= chance;
  }
}

function makeMeta(
  kind: ReactionKind,
  strength: ReactionStrength,
  durationRange: [number, number],
  fadeIn: number,
  fadeOut: number,
  bodyKick: boolean,
): ReactionCategoryMeta {
  return { kind, strength, durationRange, fadeIn, fadeOut, bodyKick };
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
