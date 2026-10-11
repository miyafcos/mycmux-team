import type { TearoutMode } from "./mode";
import type { DockTarget } from "../../stores/detachedDockStore";
import { sameDockTarget } from "./preview";

export interface ReleasePoint { x: number; y: number; at: number; method: "native_up" | "native_exit" | "poll_fallback" | "synthetic" }
export interface ReleaseFrame {
  id: string; readonly mode: TearoutMode; label: string; source: string; receiver: string; receiver_epoch: number; region_count: number;
  client_x: number; client_y: number; point: ReleasePoint; token: string;
}
export interface ReleaseApproval {
  receiver: string; token: string; target: DockTarget; release_id?: string; layout_revision?: string;
}
interface Decision { id: string; epoch: number; token: string | null; target: DockTarget | null; layoutRevision: string | null; error: string | null }
interface Effects {
  receiver: string;
  begin: (id: string, epoch: number) => Promise<ReleaseFrame>;
  decide: (decision: Decision) => Promise<boolean>;
  consume: (approval: ReleaseApproval) => Promise<boolean>;
  freeze: (id: string) => void;
  target: (frame: ReleaseFrame) => DockTarget | null;
  revision: () => string;
  frame: (target: DockTarget | null, frame: ReleaseFrame) => void;
  isFrameCurrent: (target: DockTarget, frame: ReleaseFrame) => boolean;
  afterPaint: (callback: () => void) => () => void;
}
interface Approved { frame: ReleaseFrame; target: DockTarget; revision: string; ready: Promise<boolean>; timer: number }

/** Final requests are addressed once. Hover approvals and timer fallbacks have
 * no authority here: adoption needs a fresh target, two paint frames and a
 * receiver-authenticated, one-use backend token. */
export class TearoutReleaseReceiver {
  private seen = new Set<string>();
  private approved = new Map<string, Approved>();
  private cancellations = new Set<() => void>();
  private disposed = false;
  constructor(private effects: Effects) {}

  async resolve(request: { id: string; epoch: number }): Promise<void> {
    if (this.disposed || this.seen.has(request.id)) return;
    this.seen.add(request.id);
    if (this.seen.size > 64) this.seen.delete(this.seen.values().next().value!);
    let frame: ReleaseFrame | null = null;
    let live = true;
    let cancelPaint = () => {};
    let ready = (_accepted: boolean) => {};
    let rejectWait = (_error: Error) => {};
    const deadline = new Promise<never>((_, reject) => { rejectWait = reject; });
    const timer = window.setTimeout(() => rejectWait(new Error("tearout_release_paint_timeout")), 250);
    const cancel = () => rejectWait(new Error("tearout_release_disposed"));
    this.cancellations.add(cancel);
    const current = () => { if (!live || this.disposed) throw new Error("tearout_release_expired"); };
    const work = (async () => {
      const frozen = await this.effects.begin(request.id, request.epoch);
      current();
      if (!frozen || frozen.mode !== "dock" || frozen.id !== request.id || frozen.receiver_epoch !== request.epoch || frozen.receiver !== this.effects.receiver
        || !frozen.token || !Number.isFinite(frozen.client_x) || !Number.isFinite(frozen.client_y)) throw new Error("tearout_release_identity_changed");
      frame = Object.freeze({ ...frozen, point: Object.freeze({ ...frozen.point }) });
      this.effects.freeze(frame.id);
      const target = this.effects.target(frame);
      if (!target) {
        await this.effects.decide({ id: frame.id, epoch: frame.receiver_epoch, token: null, target: null, layoutRevision: null, error: null });
        return;
      }
      const revision = this.effects.revision();
      const exactTarget: DockTarget = JSON.parse(JSON.stringify(target));
      this.effects.frame(exactTarget, frame);
      await new Promise<void>(resolve => { cancelPaint = this.effects.afterPaint(resolve); });
      current();
      if (!this.effects.isFrameCurrent(exactTarget, frame) || revision !== this.effects.revision()
        || !sameDockTarget(exactTarget, this.effects.target(frame))) throw new Error("tearout_drop_target_changed");
      const acknowledged = new Promise<boolean>(resolve => { ready = resolve; });
      const expiry = window.setTimeout(() => this.approved.delete(frame!.token), 6000);
      this.approved.set(frame.token, { frame, target: exactTarget, revision, ready: acknowledged, timer: expiry });
      // Delivery can race the command reply. It waits on this exact decision.
      const accepted = await this.effects.decide({ id: frame.id, epoch: frame.receiver_epoch, token: frame.token,
        target: exactTarget, layoutRevision: revision, error: null });
      current(); ready(accepted);
      if (!accepted) throw new Error("tearout_release_expired");
    })();
    try { await Promise.race([work, deadline]); }
    catch (error) {
      live = false; ready(false);
      const failedFrame = frame as ReleaseFrame | null;
      if (failedFrame) {
        const entry = this.approved.get(failedFrame.token);
        if (entry) window.clearTimeout(entry.timer);
        this.approved.delete(failedFrame.token);
        void this.effects.decide({ id: failedFrame.id, epoch: failedFrame.receiver_epoch, token: null, target: null, layoutRevision: null,
          error: error instanceof Error ? error.message : "tearout_release_failed" }).catch(() => {});
      }
    } finally {
      live = false; window.clearTimeout(timer); cancelPaint(); this.cancellations.delete(cancel);
      if (frame) this.effects.frame(null, frame);
    }
  }

  async consume(approval: ReleaseApproval, sender?: string): Promise<boolean> {
    const entry = this.approved.get(approval.token);
    if (!entry || !await entry.ready || this.disposed || this.approved.get(approval.token) !== entry) return false;
    // Delete before awaiting IPC: parallel deliveries cannot claim the token.
    this.approved.delete(approval.token); window.clearTimeout(entry.timer);
    if (approval.receiver !== this.effects.receiver || approval.release_id !== entry.frame.id || approval.layout_revision !== entry.revision
      || !sameDockTarget(entry.target, approval.target) || entry.revision !== this.effects.revision()
      || sender !== undefined && sender !== entry.frame.label && sender !== entry.frame.source) return false;
    return this.effects.consume(approval);
  }
  dispose(): void {
    this.disposed = true;
    for (const cancel of this.cancellations) cancel();
    for (const entry of this.approved.values()) window.clearTimeout(entry.timer);
    this.approved.clear(); this.seen.clear();
  }
}

/** Deliberately excludes the Mac occlusion timer used for hover batching. */
export function afterReleasePaint(callback: () => void): () => void {
  let frame = window.requestAnimationFrame(() => { frame = window.requestAnimationFrame(callback); });
  return () => window.cancelAnimationFrame(frame);
}
