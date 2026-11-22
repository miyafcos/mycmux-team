import { describe, expect, it } from "vitest";
import { createNightFireworks, createWinterNightScene, doneFireworkPlacement, fireworkEnd, nightCanvasScale, nightFireworkFrame, nightMeteor, nightParticle, snowPosition, starOpacity } from "../../src/lib/hanabiScene";

describe("winter night deterministic scene", () => {
  it.each([[1280, 800], [1920, 1080], [900, 1400]])("reproduces the complete scene at %sx%s", (w, h) => {
    expect(createWinterNightScene(w, h, 42)).toEqual(createWinterNightScene(w, h, 42));
  });
  it("changes the forest and stars with the seed", () => {
    expect(createWinterNightScene(1280, 800, 1)).not.toEqual(createWinterNightScene(1280, 800, 2));
  });
  it("uses a single integer pixel grid for every tree", () => {
    for (const [w, h, pixel] of [[1280, 800, 3], [1920, 1080, 4], [2560, 1600, 6], [900, 1400, 3]]) {
      const scene = createWinterNightScene(w, h);
      expect(scene.pixel).toBe(pixel);
      for (const tree of scene.trees) for (const value of [tree.x, tree.y, tree.width, tree.height]) expect(value % scene.pixel).toBe(0);
      expect(new Set(scene.trees.map(tree => tree.layer))).toEqual(new Set(["far", "near"]));
    }
  });
  it("has three star sizes and independent twinkle phases and periods", () => {
    const scene = createWinterNightScene(1920, 1080);
    expect(new Set(scene.stars.map(star => star.size)).size).toBe(3);
    expect(scene.stars.some(star => star.cross)).toBe(true);
    expect(new Set(scene.stars.map(star => star.speed)).size).toBe(scene.stars.length);
    expect(new Set(scene.stars.map(star => star.phase)).size).toBe(scene.stars.length);
    expect(starOpacity(scene.stars[0], 0)).not.toBe(starOpacity(scene.stars[0], 1000));
    expect(scene.stars.length).toBeLessThanOrEqual(150);
  });
  it("keeps three sparse snow depths moving inside the viewport", () => {
    const scene = createWinterNightScene(1280, 800);
    expect(new Set(scene.snow.map(snow => snow.layer)).size).toBe(3);
    expect(scene.snow.length).toBeLessThanOrEqual(60);
    for (const flake of scene.snow) {
      const point = snowPosition(flake, scene, 987654);
      expect(point.x).toBeGreaterThanOrEqual(0); expect(point.x).toBeLessThan(scene.width);
      expect(point.y).toBeGreaterThanOrEqual(0); expect(point.y).toBeLessThan(scene.height);
    }
  });
  it("shows a rare seeded meteor instead of a continuous streak", () => {
    const scene = createWinterNightScene(1280, 800);
    expect(nightMeteor(scene, 23000)).toBeNull();
    expect(nightMeteor(scene, 24400)).toEqual(nightMeteor(scene, 24400));
    expect(nightMeteor(scene, 24400)?.alpha).toBeGreaterThan(0);
    expect(nightMeteor(scene, 25000)).toBeNull();
  });
  it("bounds invalid sizes and device pixel ratios", () => {
    expect(createWinterNightScene(NaN, -1).width).toBe(1);
    expect(createWinterNightScene(NaN, -1).height).toBe(1);
    expect([0.5, 1, 1.5, 2, 3, NaN].map(nightCanvasScale)).toEqual([1, 1, 1.5, 2, 2, 1]);
  });
});

describe("firework choreography", () => {
  it("uses one small burst and five staggered merge bursts, ending largest", () => {
    expect(createNightFireworks("done", 1280, 800, 0, 0)).toHaveLength(1);
    const bursts = createNightFireworks("merge", 1280, 800, 1000, 42);
    expect(bursts).toHaveLength(5);
    expect(new Set(bursts.map(burst => burst.style))).toEqual(new Set(["chrysanthemum", "willow", "ring"]));
    for (let i = 1; i < bursts.length; i++) expect(bursts[i].startedAt).toBeGreaterThan(bursts[i - 1].startedAt);
    expect(bursts[4].radius).toBeGreaterThan(Math.max(...bursts.slice(0, 4).map(burst => burst.radius)));
    expect(bursts).toEqual(createNightFireworks("merge", 1280, 800, 1000, 42));
  });
  it("opens only after launch and expires after its tail fades", () => {
    const burst = createNightFireworks("done", 1280, 800, 1000, 0)[0];
    expect(nightFireworkFrame(burst, 1400)).toBeNull();
    expect(nightFireworkFrame(burst, 1900)?.flash).toBeGreaterThan(0);
    expect(nightFireworkFrame(burst, fireworkEnd(burst))).toBeNull();
  });
  it("lets gravity pull the willow farther down than a ring", () => {
    const burst = createNightFireworks("done", 1280, 800, 0, 0)[0];
    const ray = { angle: 0, length: 1, phase: 0 };
    expect(nightParticle({ ...burst, style: "willow" }, ray, 0.8).y)
      .toBeGreaterThan(nightParticle({ ...burst, style: "ring" }, ray, 0.8).y);
  });
});
