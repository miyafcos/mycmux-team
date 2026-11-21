import { describe, expect, it } from "vitest";
import { createHanabiScene, sceneryPlacement } from "../../src/lib/hanabiScenery";
import { HANABI_SCENES } from "../../src/lib/hanabiScenes";
import { createNightFireworks, createWinterNightScene, type NightRect } from "../../src/lib/hanabiScene";

const layout = {
  sidebarWidth: 328,
  conversationRect: { left: 484, top: 184, right: 1124, bottom: 545 },
  inputRect: { left: 333, top: 745, right: 1272, bottom: 779 },
};
const distance = (x: number, y: number, r: NightRect) =>
  Math.hypot(x - Math.max(r.left, Math.min(r.right, x)), y - Math.max(r.top, Math.min(r.bottom, y)));

describe("round 2 scenery in visible work-area gutters", () => {
  it.each(HANABI_SCENES.slice(1))("anchors both $id landmarks above a full-width composer", ({ id }) => {
    const scene = createHanabiScene(id, 1280, 800, 42, layout);
    const art = scene.scenery!;
    expect(art.heroes).toHaveLength(2);
    for (const [index, hero] of art.heroes.entries()) {
      expect(hero.x).toBeGreaterThanOrEqual(art.lanes[index].left);
      expect(hero.x).toBeLessThanOrEqual(art.lanes[index].right);
      expect(hero.x).toBeGreaterThan(layout.sidebarWidth + 16);
      expect(hero.y).toBeLessThan(layout.inputRect.top - 8);
      expect(hero.height).toBeGreaterThanOrEqual(800 * 0.3 - scene.pixel);
      expect(hero.height).toBeLessThanOrEqual(800 * 0.45 + scene.pixel);
    }
    expect(scene).toEqual(createHanabiScene(id, 1280, 800, 42, layout));
  });
  it("uses the input gutters when available and finite proportional gutters otherwise", () => {
    const gutters = sceneryPlacement(1280, 800, { sidebarWidth: 328, inputRect: { left: 530, right: 1060, top: 740, bottom: 780 } }, 3);
    expect(gutters.lanes[0]).toEqual({ left: 344, right: 514 });
    expect(gutters.lanes[1]).toEqual({ left: 1076, right: 1264 });
    for (const [w, h] of [[320, 600], [900, 1400], [1920, 1080]]) for (const { id } of HANABI_SCENES.slice(1)) {
      const scene = createHanabiScene(id, w, h, 42);
      expect(JSON.stringify(scene)).not.toMatch(/NaN|Infinity/);
      for (const lane of scene.scenery!.lanes) expect(lane.right).toBeGreaterThan(lane.left);
    }
  });
  it("preserves the large right winter fir when the composer has no right gutter", () => {
    const scene = createWinterNightScene(1280, 800, undefined, layout);
    expect(scene.trees.some(tree => tree.side === "right" && tree.layer === "near" && tree.height >= 800 * 0.44)).toBe(true);
    expect(scene.house.y).toBeLessThan(layout.inputRect.top);
    expect(scene.house.x).toBeLessThan(layout.inputRect.right - scene.house.width);
  });
  it("separates star seeds, adds a summer band and reduces harbor stars", () => {
    const scenes = HANABI_SCENES.map(({ id }) => createHanabiScene(id, 1280, 800, 42));
    expect(new Set(scenes.map(scene => JSON.stringify(scene.stars))).size).toBe(5);
    expect(scenes[1].stars.length).toBeGreaterThan(scenes[0].stars.length);
    expect(scenes[3].stars.length).toBeLessThanOrEqual(Math.ceil(scenes[0].stars.length * 0.6));
  });
  it("uses flower clusters and three shaded autumn canopies with opaque lit faces", () => {
    const sakura = createHanabiScene("sakura-night", 1280, 800, 42, layout).scenery!;
    expect(sakura.heroes[0].height).toBeGreaterThan(sakura.heroes[1].height);
    expect(sakura.branches.some(branch => branch.bark && branch.width === 18)).toBe(true);
    expect(sakura.branches.some(branch => branch.dotted)).toBe(true);
    expect(sakura.marks.length).toBeGreaterThan(200);
    expect(new Set(sakura.marks.map(mark => mark.color))).toEqual(new Set(["#f4bad0", "#ffd9e6", "#c98bb0"]));
    const autumn = createHanabiScene("onsen-autumn", 1280, 800, 42, layout).scenery!;
    expect(new Set(autumn.crowns.map(crown => crown.color))).toEqual(new Set(["#7a3b3b", "#9a5a2e", "#8a7a3a"]));
    expect(autumn.marks.every(mark => mark.alpha >= 0.9)).toBe(true);
    expect(autumn.moon.x).toBeCloseTo(1137, -1);
    expect(autumn.moon.y).toBeCloseTo(104, -1);
  });
  it("keeps broad light pools centered on the moved inn windows and lighthouse lantern", () => {
    const autumn = createHanabiScene("onsen-autumn", 1280, 800, 42, layout).scenery!;
    for (const side of [0, 1]) {
      const group = autumn.buildings.slice(side * 2, side * 2 + 2);
      expect(autumn.glows[side].x).toBeCloseTo(group.reduce((sum, b) => sum + b.x + b.width / 2, 0) / group.length);
      expect(autumn.glows[side].y).toBeCloseTo(group.reduce((sum, b) => sum + b.y - b.height / 2, 0) / group.length);
    }
    const harbor = createHanabiScene("harbor-night", 1280, 800, 42, layout);
    const tower = harbor.scenery!.heroes.find(hero => hero.kind === "lighthouse")!;
    expect(harbor.scenery!.glows[1]).toEqual({ x: tower.x, y: tower.y - tower.height + harbor.pixel * 3 });
  });
  it("raises summer water and keeps harbor houses above water and boats outside input", () => {
    const summer = createHanabiScene("summer-seaside", 1280, 800, 42, layout).scenery!;
    expect(summer.horizon).toBeCloseTo(560, -1);
    const harbor = createHanabiScene("harbor-night", 1280, 800, 42, layout).scenery!;
    expect(harbor.buildings.every(building => building.y < harbor.horizon)).toBe(true);
    expect(harbor.boats).toHaveLength(3);
    expect(harbor.boats.every(boat => boat.y >= 800 * 0.83 - 3 && boat.y <= 800 * 0.86 + 3 && boat.y < layout.inputRect.top)).toBe(true);
  });
});

describe("merge clearance for every burst", () => {
  it.each(HANABI_SCENES)("avoids the sidebar and input, and keeps the core outside messages in $id", ({ id }) => {
    for (const current of [layout, { sidebarWidth: 176, conversationRect: { left: 260, top: 160, right: 800, bottom: 568 },
      inputRect: { left: 260, top: 1300, right: 800, bottom: 1350 } }]) {
      const [w, h] = current === layout ? [1280, 800] : [900, 1400];
      const fireworks = createNightFireworks("merge", w, h, 0, 42, current, id);
      for (const firework of fireworks) {
        expect(firework.radius).toBeGreaterThan(10);
        expect(firework.x - firework.radius).toBeGreaterThanOrEqual(current.sidebarWidth);
        expect(firework.x + firework.radius).toBeLessThanOrEqual(w);
        expect(firework.y + firework.radius).toBeLessThan(current.inputRect.top);
        expect(distance(firework.x, firework.y, current.conversationRect)).toBeGreaterThan(firework.radius * 0.3);
      }
      expect(fireworks[4].radius).toBeGreaterThan(Math.max(...fireworks.slice(0, 4).map(firework => firework.radius)));
    }
  });
  it("scales summer merge radii by 1.25 and cycles five intermediate colors across celebrations", () => {
    const winter = createNightFireworks("merge", 1280, 800, 0, 42);
    const summer = createNightFireworks("merge", 1280, 800, 0, 42, {}, "summer-seaside");
    summer.forEach((firework, i) => expect(firework.radius).toBeCloseTo(winter[i].radius * 1.25));
    const colors = new Set([0, 1].flatMap(seed => createNightFireworks("merge", 1280, 800, 0, seed, {}, "summer-seaside").slice(0, 4).map(f => f.color)));
    expect(colors.size).toBe(5);
  });
});
