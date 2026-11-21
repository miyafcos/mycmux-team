import { describe, expect, it } from "vitest";
import { createHanabiScene, sceneryHasWater, sceneryWaterSpan } from "../../src/lib/hanabiScenery";
import { createNightFireworks, createWinterNightScene, nightRaySections, nightSkylineY } from "../../src/lib/hanabiScene";
import { HANABI_SCENES } from "../../src/lib/hanabiScenes";

const layout = {
  sidebarWidth: 328,
  conversationRect: { left: 484, top: 184, right: 1124, bottom: 545 },
  inputRect: { left: 333, top: 745, right: 1272, bottom: 779 },
};
const distance = (x: number, y: number) => Math.hypot(
  x - Math.max(layout.conversationRect.left, Math.min(layout.conversationRect.right, x)),
  y - Math.max(layout.conversationRect.top, Math.min(layout.conversationRect.bottom, y)),
);

describe("round 3 large fireworks and grounded scenery", () => {
  it("attenuates only the ray section inside text, without splitting unrelated strokes", () => {
    const rect = { left: 500, top: 200, right: 700, bottom: 500 };
    expect(nightRaySections(400, 300, 800, 300, rect)).toEqual([
      { from: 0, to: 0.25, alpha: 1 }, { from: 0.25, to: 0.75, alpha: 0.5 }, { from: 0.75, to: 1, alpha: 1 },
    ]);
    expect(nightRaySections(365, 164, 420, 300, rect)).toEqual([{ from: 0, to: 1, alpha: 1 }]);
  });
  it.each(HANABI_SCENES)("keeps a large finale and open-sky cores in $id", ({ id }) => {
    const scene = createHanabiScene(id, 1280, 800, 42, layout);
    const fireworks = createNightFireworks("merge", 1280, 800, 0, 42, scene.layout, id);
    expect(fireworks[4].radius).toBeGreaterThanOrEqual(120);
    expect(fireworks[0].radius).toBeGreaterThanOrEqual(96);
    for (const f of fireworks) {
      expect(f.x - f.radius).toBeGreaterThanOrEqual(layout.sidebarWidth);
      expect(distance(f.x, f.y)).toBeGreaterThan(f.radius * 0.3);
      expect(f.y + f.radius).toBeLessThanOrEqual(nightSkylineY(1280, 800, scene.layout, f.x));
      expect(f.y + f.radius).toBeLessThan(layout.inputRect.top);
    }
    expect(fireworks.some(f => distance(f.x, f.y) < f.radius)).toBe(true);
  });

  it.each(HANABI_SCENES.slice(1))("removes foreground stars and adds a middle-distance row in $id", ({ id }) => {
    const scene = createHanabiScene(id, 1280, 800, 42, layout), art = scene.scenery!;
    for (const star of scene.stars) expect(star.y + Math.max(star.size, star.cross ? 5 : 1))
      .toBeLessThan(nightSkylineY(1280, 800, scene.layout, star.x) + 0.01);
    expect(art.midground.length).toBeGreaterThan(30);
    expect(Math.min(...art.midground.map(m => m.x))).toBeLessThan(1280 * 0.1);
    expect(Math.max(...art.midground.map(m => m.x))).toBeGreaterThan(1280 * 0.9);
  });

  it("preserves winter star and landscape generation", () => {
    expect(createHanabiScene("winter-night", 1280, 800, 42, layout)).toEqual(createWinterNightScene(1280, 800, 42, layout));
  });

  it("grounds summer landmarks on headlands and puts every reflected center over open water", () => {
    const scene = createHanabiScene("summer-seaside", 1280, 800, 42, layout), art = scene.scenery!;
    for (const hero of art.heroes) expect(sceneryHasWater(art, hero.x, hero.y)).toBe(false);
    for (const b of art.buildings) expect(sceneryHasWater(art, b.x + b.width / 2, b.y)).toBe(false);
    for (const wave of art.water) {
      expect(sceneryHasWater(art, wave.x, wave.y)).toBe(true);
      expect(sceneryHasWater(art, wave.x + wave.width, wave.y)).toBe(true);
    }
    for (const f of createNightFireworks("merge", 1280, 800, 0, 42, scene.layout, "summer-seaside"))
      expect(sceneryHasWater(art, f.x, art.horizon)).toBe(true);
    expect(art.companions).toHaveLength(2);
    expect(scene.stars.filter(s => s.size === 2).length).toBeGreaterThan(65);
  });

  it("gives harbor a sloping shore, a town instead of the left pine, and separate boats", () => {
    const scene = createHanabiScene("harbor-night", 1280, 800, 42, layout), art = scene.scenery!;
    expect(art.heroes[0].kind).toBe("town");
    expect(art.companions.every(tree => tree.side === 1)).toBe(true);
    const tower = art.heroes[1];
    expect(tower.kind).toBe("lighthouse");
    expect(sceneryHasWater(art, tower.x, tower.y + 9)).toBe(false);
    expect(sceneryWaterSpan(art, 790)!.left).toBeLessThan(sceneryWaterSpan(art, 650)!.left);
    for (const b of art.buildings) expect(b.x + b.width).toBeLessThan(tower.x - tower.width * 0.1);
    for (const boat of art.boats) {
      expect(sceneryHasWater(art, boat.x, boat.y)).toBe(true);
      expect(sceneryHasWater(art, boat.x + scene.pixel * 9, boat.y)).toBe(true);
      expect(boat.x + scene.pixel * 9).toBeLessThan(tower.x - tower.width * 0.25);
    }
  });

  it("spreads cherry crowns sideways, forks the trunk and lengthens the drooping flowers", () => {
    const scene = createHanabiScene("sakura-night", 1280, 800, 42, layout), art = scene.scenery!;
    expect(art.crowns.every(c => c.rx > c.ry * 1.4)).toBe(true);
    expect(art.branches.filter(b => b.bark).length).toBeGreaterThanOrEqual(6);
    expect(art.branches.some(b => b.dotted && b.points.at(-1)!.y - b.points[0].y >= 800 * 0.25)).toBe(true);
    expect(scene.snow.length).toBe(Math.ceil(createWinterNightScene(1280, 800, 42).snow.length / 2));
  });
});
