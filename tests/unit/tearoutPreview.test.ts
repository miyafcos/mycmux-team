import { describe, expect, it, vi } from "vitest";
import { TearoutPreview } from "../../src/lib/tearout/preview";
import type { DockTarget } from "../../src/stores/detachedDockStore";

function setup() {
  const callbacks: (() => void)[] = [];
  const effects = { frame: vi.fn(), afterPaint: (cb: () => void) => callbacks.push(cb),
    approve: vi.fn(async () => true), alpha: vi.fn(async () => {}) };
  return { effects, callbacks, preview: new TearoutPreview(effects) };
}
const center: DockTarget = { kind: "pane-zone", workspaceId: "w", paneId: "p", zone: "center" };
const left: DockTarget = { ...center, zone: "left" };
describe("native drop approval", () => {
  it("keeps a constant target mounted and changes opacity only on entry and exit", async () => {
    const { preview, effects, callbacks } = setup();
    for (let i = 0; i < 18; i++) preview.sample({ ...center }, 1000 + i * 8);
    callbacks[0]();
    await Promise.resolve(); await Promise.resolve();
    const token = effects.approve.mock.calls.at(-1)![0];
    for (let i = 18; i < 360; i++) preview.sample({ ...center }, 1000 + i * 8);
    expect(effects.frame.mock.calls).toEqual([[center]]);
    expect(effects.alpha.mock.calls).toEqual([[128]]);
    expect(preview.accepts(token!, center)).toBe(true);
    preview.sample(null, 4000);
    preview.clear();
    expect(effects.frame.mock.calls).toEqual([[center], [null]]);
    expect(effects.alpha.mock.calls).toEqual([[128], [255]]);
  });
  it("requires 120 continuous ms and a painted frame before alpha 128", async () => {
    const { preview, effects, callbacks } = setup();
    preview.sample(center, 1000);
    preview.sample(center, 1119);
    expect(effects.frame).not.toHaveBeenCalledWith(center);
    preview.sample(center, 1120);
    expect(effects.frame).toHaveBeenLastCalledWith(center);
    expect(effects.alpha).not.toHaveBeenCalledWith(128);
    callbacks[0]();
    await Promise.resolve(); await Promise.resolve();
    expect(effects.alpha).toHaveBeenLastCalledWith(128);
    const token = effects.approve.mock.calls.at(-1)![0];
    expect(preview.accepts(token!, center)).toBe(true);
    preview.clear();
    expect(effects.alpha).toHaveBeenLastCalledWith(255);
    expect(effects.frame).toHaveBeenLastCalledWith(null);
    expect(preview.accepts(token!, center)).toBe(false);
  });
  it("does not paint when passing through or approve a stale paint callback", async () => {
    const { preview, effects, callbacks } = setup();
    preview.sample(center, 1000);
    preview.sample(left, 1110);
    preview.sample(left, 1229);
    expect(effects.frame).not.toHaveBeenCalledWith(left);
    preview.sample(left, 1230);
    preview.sample(null, 1231);
    callbacks[0]();
    await Promise.resolve();
    expect(effects.alpha).not.toHaveBeenCalledWith(128);
  });
});
