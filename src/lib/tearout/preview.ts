import type { DockTarget } from "../../stores/detachedDockStore";

export function sameDockTarget(a: DockTarget | null, b: DockTarget | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind === "workspace" || b.kind === "workspace") return a.kind === b.kind;
  return a.kind === b.kind && a.workspaceId === b.workspaceId && a.paneId === b.paneId
    && (a.kind === "tab-index" && b.kind === "tab-index" ? a.index === b.index
      : a.kind === "pane-zone" && b.kind === "pane-zone" && a.zone === b.zone);
}

interface PreviewEffects {
  frame: (target: DockTarget | null) => void;
  afterPaint: (callback: () => void) => void;
  approve: (token: string | null, target: DockTarget | null) => Promise<boolean>;
  alpha: (value: 128 | 255) => Promise<void>;
  highlighted?: (at: number, token: string, target: DockTarget, hoverAt: number) => void;
}

/** No timer can approve a stale target: a fresh native sample drives dwell. */
export class TearoutPreview {
  private target: DockTarget | null = null;
  private since = 0;
  private generation = 0;
  private painting = false;
  private painted: { token: string; target: DockTarget } | null = null;
  constructor(private effects: PreviewEffects) {}

  sample(target: DockTarget | null, at: number): void {
    if (!sameDockTarget(this.target, target)) {
      this.clear();
      this.target = target;
      this.since = at;
    }
    if (!target || this.painting || this.painted || at - this.since < 120) return;
    const generation = this.generation;
    const token = crypto.randomUUID();
    this.painting = true;
    this.effects.frame(target);
    this.effects.afterPaint(() => {
      if (generation !== this.generation) return;
      const paintedAt = Date.now();
      this.painted = { token, target };
      void this.effects.approve(token, target).then(async (accepted) => {
        if (generation !== this.generation) return;
        if (!accepted) { this.clear(); return; }
        await this.effects.alpha(128);
        if (generation === this.generation) this.effects.highlighted?.(paintedAt, token, target, this.since);
      }).catch(() => { if (generation === this.generation) this.clear(); });
    });
  }

  accepts(token: string, target: DockTarget): boolean {
    return this.painted?.token === token && sameDockTarget(this.painted.target, target);
  }

  clear(): void {
    const visible = this.painting || this.painted !== null;
    this.generation++;
    this.target = null;
    this.painting = false;
    this.painted = null;
    if (!visible) return;
    this.effects.frame(null);
    void this.effects.approve(null, null).catch(() => {});
    void this.effects.alpha(255).catch(() => {});
  }
}
