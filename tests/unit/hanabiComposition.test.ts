import { describe, expect, it } from "vitest";
import { createNightFireworks, createWinterNightScene, doneFireworkPlacement, nightParticle } from "../../src/lib/hanabiScene";

describe("Hanabi reference composition", () => {
  it("uses separated broad firs, a 4px FHD grid and a visible cabin above/right of input", () => {
    const layout = { sidebarWidth: 176, inputRect: { left: 348, right: 1108, top: 700, bottom: 752 } };
    const plain = createWinterNightScene(1280, 800);
    const scene = createWinterNightScene(1280, 800, undefined, layout);
    const near = scene.trees.filter(t => t.layer === "near");
    expect(near.length).toBeLessThanOrEqual(8);
    expect(near.filter(tree => tree.side === "left")).toHaveLength(4);
    expect(near.filter(tree => tree.side === "right").length).toBeGreaterThan(0);
    for (const tree of near) {
      expect(tree.width / tree.height).toBeGreaterThan(0.5);
      expect(tree.width / tree.height).toBeLessThan(0.64);
    }
    expect(Math.min(...near.map(t => t.x))).toBeGreaterThan(176);
    expect(Math.min(...plain.trees.filter(t => t.layer === "near").map(t => t.x))).toBeLessThan(176);
    expect(scene.house.x).toBeGreaterThan(layout.inputRect.right);
    expect(scene.house.y).toBeLessThan(layout.inputRect.top);
    expect(createWinterNightScene(1920, 1080).pixel).toBe(4);
  });
  it("keeps the whole done burst clear of the message union in landscape and portrait", () => {
    for (const [w, h, right, bottom, inputTop] of [[1280, 800, 1108, 540, 700], [900, 1400, 800, 568, 1300]]) {
      const layout = { sidebarWidth: 176, conversationRect: { left: 260, top: 160, right, bottom },
        inputRect: { left: 260, right, top: inputTop, bottom: inputTop + 50 } };
      const b = doneFireworkPlacement(w, h, layout);
      expect(b.x + b.radius).toBeLessThanOrEqual(w);
      expect(b.x - b.radius >= right || b.y - b.radius >= bottom).toBe(true);
      expect(b.y + b.radius).toBeLessThan(inputTop);
    }
  });
  it("keeps a burst on the right when only its safety margin reaches a message corner", () => {
    const placement = doneFireworkPlacement(1280, 800, {
      conversationRect: { left: 400, right: 1180, top: 160, bottom: 311 },
      inputRect: { left: 400, right: 1048, top: 700, bottom: 753 },
    });
    expect(placement.x).toBeGreaterThan(1100);
    expect(placement.x + placement.radius).toBeLessThanOrEqual(1280);
    expect(placement.y - placement.radius).toBeGreaterThan(311);
  });
  it("always uses 24 warm coral rays with a pale core for done and final, never a ring", () => {
    for (const seed of [0, 1, 2, 42, 999]) {
      const done = createNightFireworks("done", 1280, 800, 0, seed)[0];
      const final = createNightFireworks("merge", 1280, 800, 0, seed)[4];
      for (const b of [done, final]) {
        expect(b.style).toBe("chrysanthemum"); expect(b.color).toBe("#F08A6C"); expect(b.core).toBe("#F7C6A8");
        expect(b.rays).toHaveLength(24);
        b.rays.forEach((ray,index) => {
          expect(ray.length).toBeGreaterThanOrEqual(index % 2 ? 0.95 : 0.6);
          expect(ray.length).toBeLessThanOrEqual(index % 2 ? 1 : 0.75);
        });
      }
    }
  });
  it("separates willow launch positions and loosens the intermediate ring", () => {
    const bursts = createNightFireworks("merge", 1280, 800, 0, 12);
    const willow = bursts.find(b => b.style === "willow")!;
    const ring = bursts.find(b => b.style === "ring")!;
    expect(bursts.filter(b => b.style === "chrysanthemum").every(b => Math.abs(b.x - willow.x) > 60)).toBe(true);
    expect(ring.rays.every(ray => ray.length >= 0.9 && ray.length <= 1.05)).toBe(true);
    expect(Math.max(...ring.rays.map(r => r.length)) - Math.min(...ring.rays.map(r => r.length))).toBeGreaterThan(0.1);
    const p = nightParticle(willow, { angle: 0, length: 1, phase: 0 }, 1);
    expect(p.y - willow.y).toBeCloseTo(willow.radius * 0.6);
  });
});
