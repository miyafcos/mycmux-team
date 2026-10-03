import { invoke } from "@tauri-apps/api/core";
import { windowLabel } from "../windowContext";

declare global { interface Window { __MYCMUX_TEAROUT_PERF__?: boolean } }

/** Fixed memory, upper-bound quarter-ms percentiles, exact maxima/counts. */
export class FrameHistogram {
  private bins = new Uint32Array(513);
  private count = 0;
  private max = 0;
  private over20 = 0;
  private over33 = 0;
  add(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.bins[Math.min(512, Math.ceil(ms * 4))]++;
    this.count++; this.max = Math.max(this.max, ms);
    if (ms > 20) this.over20++;
    if (ms > 33) this.over33++;
  }
  summary() {
    const quantile = (fraction: number) => {
      if (!this.count) return null;
      const wanted = Math.ceil(this.count * fraction); let count = 0;
      for (let i = 0; i < this.bins.length; i++) {
        count += this.bins[i];
        if (count >= wanted) return i === 512 ? this.max : i / 4;
      }
      return this.max;
    };
    return { count: this.count, median: quantile(.5), p95: quantile(.95), max: this.count ? this.max : null,
      over20: this.over20, over33: this.over33 };
  }
}

const active = new Map<string, { frames: FrameHistogram; last: number | null; started: number }>();
let frame = 0;
const enabled = () => typeof window !== "undefined" && window.__MYCMUX_TEAROUT_PERF__ !== false;

function tick(at: number): void {
  frame = 0;
  for (const [id, record] of active) {
    if (at - record.started > 300_000) { finishTearoutFrames(id); continue; }
    if (record.last !== null) record.frames.add(at - record.last);
    record.last = at;
  }
  if (active.size) frame = window.requestAnimationFrame(tick);
}

export function startTearoutFrames(id: string): void {
  if (!enabled() || active.has(id) || active.size >= 4) return;
  active.set(id, { frames: new FrameHistogram(), last: null, started: performance.now() });
  if (!frame) frame = window.requestAnimationFrame(tick);
}

export function finishTearoutFrames(id: string): void {
  const record = active.get(id);
  if (!record) return;
  active.delete(id);
  if (!active.size && frame) { window.cancelAnimationFrame(frame); frame = 0; }
  // One bounded IPC/write after movement, never a write in the animation loop.
  void invoke("tearout_log_record", { record: { kind: "tearout_performance", drag_id: id,
    window_label: windowLabel(), frames: record.frames.summary(), native: null } })
    .catch((error) => console.warn("[tearout] frame summary write failed", error));
}

export function disposeTearoutFrames(): void {
  for (const id of [...active.keys()]) finishTearoutFrames(id);
}
