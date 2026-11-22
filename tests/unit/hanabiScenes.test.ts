import { describe, expect, it } from "vitest";
import { createHanabiScene, scenerySkyColor } from "../../src/lib/hanabiScenery";
import { HANABI_SCENES } from "../../src/lib/hanabiScenes";
import { createNightFireworks, createWinterNightScene } from "../../src/lib/hanabiScene";
import { DEFAULT_THEME_BACKGROUND, normalizeThemeBackground } from "../../src/lib/themeBackgrounds";
import { contrastRatio } from "../../src/components/theme/colorContrast";
import { getTheme } from "../../src/components/theme/themeDefinitions";

describe("five seeded Hanabi scenes", () => {
  it.each(HANABI_SCENES)("reproduces $id for the same seed and viewport", ({ id }) => {
    for (const [w, h] of [[1280,800], [900,1400], [240,150]]) {
      const a = createHanabiScene(id, w, h, 42);
      expect(a).toEqual(createHanabiScene(id, w, h, 42));
      expect(a).not.toEqual(createHanabiScene(id, w, h, 43));
      expect(JSON.stringify(a)).not.toMatch(/NaN|Infinity/);
    }
  });
  it("keeps the existing winter layout byte-for-byte equivalent", () => {
    const layout = { sidebarWidth: 176, inputRect: { left: 400, top: 700, right: 1040, bottom: 760 } };
    expect(createHanabiScene("winter-night", 1280,800,123,layout)).toEqual(createWinterNightScene(1280,800,123,layout));
    expect(createHanabiScene("future-scene",1280,800)).toEqual(createWinterNightScene(1280,800));
  });
  it("gives all four additions distinct deterministic landmark geometry", () => {
    const scenes = HANABI_SCENES.slice(1).map(({id}) => createHanabiScene(id,1280,800));
    expect(new Set(scenes.map(s => JSON.stringify(s.scenery))).size).toBe(4);
    const sakura = scenes[1].scenery!;
    expect(sakura.branches.length).toBeGreaterThan(20);
    expect(sakura.marks.some(m=>m.color === "#f4bad0")).toBe(true);
    expect(scenes[2].scenery!.buildings.length).toBeGreaterThan(20);
    expect(scenes[3].scenery!.crowns.length).toBe(8);
    for(const scene of scenes) {
      expect(scene.trees).toHaveLength(0);
      expect(scene.scenery!.skyline.every(point=>point.y>=scene.height*0.6)).toBe(true);
      expect(scene.scenery!.marks.every(mark=>mark.x<=scene.width*0.3 || mark.x>=scene.width*0.7)).toBe(true);
    }
  });
  it.each(HANABI_SCENES.slice(1))("keeps the reading sky dark in $id", ({id}) => {
    const theme = getTheme("hanabi");
    for(const t of [0,0.2,0.4,0.6]) {
      const hex = "#"+scenerySkyColor(id,t).map(n=>Math.round(n).toString(16).padStart(2,"0")).join("");
      expect(contrastRatio(theme.chrome.text,hex)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(theme.chrome.textMuted,hex)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it.each(HANABI_SCENES)("retains the common done/merge timing and styles in $id", ({id}) => {
    const done = createNightFireworks("done",1280,800,0,42,{},id);
    const merge = createNightFireworks("merge",1280,800,0,42,{},id);
    expect(done).toHaveLength(1); expect(done[0].style).toBe("chrysanthemum");
    expect(merge).toHaveLength(5); expect(merge.map(f=>f.startedAt)).toEqual([0,530,1060,1590,2500]);
    expect(merge[4].radius).toBeGreaterThan(Math.max(...merge.slice(0,4).map(f=>f.radius)));
    expect(merge[4].color).toBe("#F08A6C");
  });
});

describe("scene settings compatibility", () => {
  it.each(HANABI_SCENES)("round-trips only the sceneId value for $id", ({id}) => {
    const input = {...DEFAULT_THEME_BACKGROUND,mode:"scene",sceneId:id,terminalOpacity:0.25,panelOpacity:0.55,completionFireworks:false};
    expect(normalizeThemeBackground(JSON.parse(JSON.stringify(input)))).toEqual(input);
    expect(Object.keys(normalizeThemeBackground(input))).toEqual(Object.keys(DEFAULT_THEME_BACKGROUND));
  });
  it.each([undefined,null,"unknown","",123,{},["summer-seaside"]])("reads invalid sceneId %j as winter without discarding glass", value => {
    expect(normalizeThemeBackground({...DEFAULT_THEME_BACKGROUND,mode:"scene",sceneId:value,terminalOpacity:0.25,panelOpacity:0.55,completionFireworks:false}))
      .toMatchObject({mode:"scene",sceneId:"winter-night",terminalOpacity:0.25,panelOpacity:0.55,completionFireworks:false});
  });
});
