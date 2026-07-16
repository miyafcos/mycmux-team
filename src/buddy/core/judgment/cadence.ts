export type SpeechPressure = "low" | "normal" | "high";

const RECENT_WINDOW_MS = 5 * 60_000;
const MID_WINDOW_MS = 20 * 60_000;
const BURST_WINDOW_MS = 30 * 60_000;
const BURST_COUNT = 3;

export class CadenceController {
  private utteranceTimestampsMs: number[] = [];

  recordUtterance(nowMs: number): void {
    this.utteranceTimestampsMs.push(nowMs);
    this.trim(nowMs);
  }

  effectiveCooldownMs(nowMs: number, baseCooldownMs: number): number {
    this.trim(nowMs);

    const sinceLast = this.sinceLastUtteranceMs(nowMs);
    let multiplier = 0.5;
    if (sinceLast < RECENT_WINDOW_MS) {
      multiplier = 2.5;
    } else if (sinceLast < MID_WINDOW_MS) {
      multiplier = 1.0;
    }

    if (this.recentUtteranceCount(nowMs) >= BURST_COUNT) {
      multiplier *= 1.5;
    }

    return baseCooldownMs * multiplier;
  }

  pressure(nowMs: number): SpeechPressure {
    this.trim(nowMs);

    const sinceLast = this.sinceLastUtteranceMs(nowMs);
    if (this.recentUtteranceCount(nowMs) >= BURST_COUNT || sinceLast < RECENT_WINDOW_MS) {
      return "low";
    }

    if (sinceLast >= MID_WINDOW_MS) {
      return "high";
    }

    return "normal";
  }

  private sinceLastUtteranceMs(nowMs: number): number {
    const latest = this.latestUtteranceMs();
    return latest === null ? Infinity : Math.max(0, nowMs - latest);
  }

  private recentUtteranceCount(nowMs: number): number {
    const threshold = nowMs - BURST_WINDOW_MS;
    return this.utteranceTimestampsMs.filter((timestampMs) => timestampMs >= threshold).length;
  }

  private latestUtteranceMs(): number | null {
    if (this.utteranceTimestampsMs.length === 0) {
      return null;
    }

    return this.utteranceTimestampsMs[this.utteranceTimestampsMs.length - 1] ?? null;
  }

  private trim(nowMs: number): void {
    const latest = this.latestUtteranceMs();
    if (latest === null) {
      return;
    }

    const threshold = nowMs - BURST_WINDOW_MS;
    const recent = this.utteranceTimestampsMs.filter((timestampMs) => timestampMs >= threshold);
    this.utteranceTimestampsMs = recent.length > 0 ? recent : [latest];
  }
}
