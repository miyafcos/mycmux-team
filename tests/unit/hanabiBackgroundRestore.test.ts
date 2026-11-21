import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_THEME_BACKGROUND } from "../../src/lib/themeBackgrounds";
import { applyBackgroundPreset } from "../../src/lib/theme/backgroundPresets";
import { useThemeStore } from "../../src/stores/themeStore";
import type { ThemeBackgroundSettings } from "../../src/types";

beforeEach(() => useThemeStore.getState().hydrateSettings({ themeId: "mayonaka" }));
const background = () => useThemeStore.getState().themeTweaks.background;
const memo = () => useThemeStore.getState().themeTweaks.hanabiBackgroundRestore;
const save = () => JSON.parse(JSON.stringify({
  themeId: useThemeStore.getState().themeId,
  themeTweaks: useThemeStore.getState().themeTweaks,
}));
async function freshStore(saved: ReturnType<typeof save>) {
  vi.resetModules();
  const fresh = (await import("../../src/stores/themeStore")).useThemeStore;
  fresh.getState().hydrateSettings(saved);
  return fresh;
}

describe("Hanabi automatic background restoration", () => {
  it.each([
    ["default", null],
    ["opaque with saved glass values", { solidSurfaces: true, panelOpacity: 0.31, terminalOpacity: 0.19 }],
    ["custom glass solid", { panelOpacity: 0.37, terminalOpacity: 0.22 }],
  ] as const)("restores the complete %s background on a normal theme exit", (_name, patch) => {
    if (patch) useThemeStore.getState().setThemeBackground(patch);
    const before = background();
    useThemeStore.getState().setTheme("hanabi");
    expect(background().mode).toBe("scene");
    expect(memo()).toEqual(before);
    useThemeStore.getState().setTheme("kyokuya");
    expect(background()).toEqual(before);
    expect(memo()).toBeUndefined();
  });

  it.each(["preset", "image", "scene"] as const)("does not create a memo or change a manually chosen %s", mode => {
    useThemeStore.getState().setThemeBackground({ mode, presetId: "winter", imagePath: "/chosen.png",
      sceneId: "harbor-night", panelOpacity: 0.31, terminalOpacity: 0.19, solidSurfaces: true });
    const before = background();
    useThemeStore.getState().setTheme("hanabi");
    expect(background()).toEqual(before);
    expect(memo()).toBeUndefined();
    useThemeStore.getState().setTheme("mayonaka");
    expect(background()).toEqual(before);
  });

  const edits: Array<[string, Partial<ThemeBackgroundSettings>]> = [
    ["solid mode", { mode: "solid" }],
    ["scene mode", { mode: "scene" }],
    ["wallpaper mode", { mode: "preset" }],
    ["image mode", { mode: "image", imagePath: "/chosen.png" }],
    ["scene only", { sceneId: "summer-seaside" }],
    ["wallpaper only", { presetId: "winter" }],
    ["image path only", { imagePath: "/another.png" }],
    ["panel opacity", { panelOpacity: 0.38 }],
    ["terminal opacity", { terminalOpacity: 0.32 }],
    ["solid surfaces", applyBackgroundPreset("solid")],
    ["frosted surfaces", applyBackgroundPreset("frosted")],
    ["clear surfaces", applyBackgroundPreset("clear")],
    ["image opacity", { imageOpacity: 0.6 }],
    ["image blur", { imageBlur: 4 }],
    ["brightness", { wallpaperTone: 0.2 }],
    ["background reset", DEFAULT_THEME_BACKGROUND],
  ];
  it.each(edits)("gives ownership to the user on %s, even if the value is unchanged", (_name, patch) => {
    useThemeStore.getState().setTheme("hanabi");
    expect(memo()).toBeDefined();
    useThemeStore.getState().setThemeBackground(patch);
    const edited = background();
    expect(memo()).toBeUndefined();
    useThemeStore.getState().setTheme("mayonaka");
    expect(background()).toEqual(edited);
  });

  it("restores the background but retains a fireworks-only toggle", () => {
    const before = background();
    useThemeStore.getState().setTheme("hanabi");
    useThemeStore.getState().setThemeBackground({ completionFireworks: false });
    expect(memo()).toEqual(before);
    useThemeStore.getState().setTheme("mayonaka");
    expect(background()).toEqual({ ...before, completionFireworks: false });
    expect(memo()).toBeUndefined();
  });

  it("keeps the original memo when Hanabi is selected twice", () => {
    const before = background();
    useThemeStore.getState().setTheme("hanabi");
    const automatic = background();
    useThemeStore.getState().setTheme("hanabi");
    expect(memo()).toEqual(before);
    expect(background()).toEqual(automatic);
    useThemeStore.getState().setTheme("mayonaka");
    expect(background()).toEqual(before);
  });

  it("undoes entry and exit with the background and memo from the same snapshot", () => {
    const before = background();
    useThemeStore.getState().setTheme("hanabi");
    useThemeStore.getState().restoreThemeSnapshot();
    expect(useThemeStore.getState().themeId).toBe("mayonaka");
    expect(background()).toEqual(before);
    expect(memo()).toBeUndefined();
    useThemeStore.getState().setTheme("hanabi");
    const automaticTweaks = useThemeStore.getState().themeTweaks;
    useThemeStore.getState().setTheme("kyokuya");
    expect(memo()).toBeUndefined();
    useThemeStore.getState().restoreThemeSnapshot();
    expect(useThemeStore.getState().themeId).toBe("hanabi");
    expect(useThemeStore.getState().themeTweaks).toEqual(automaticTweaks);
    useThemeStore.getState().setTheme("mayonaka");
    expect(background()).toEqual(before);
  });

  it("preserves the memo through every color-only setter", () => {
    const before = background();
    useThemeStore.getState().setTheme("hanabi");
    useThemeStore.getState().setThemeTweakEnabled(true);
    expect(memo()).toEqual(before);
    useThemeStore.getState().setThemeTweakColor("chrome.accent", "#ff0000");
    expect(memo()).toEqual(before);
    useThemeStore.getState().applyThemeTweakPreset({ "chrome.accent": "#00ff00" });
    expect(memo()).toEqual(before);
    useThemeStore.getState().clearThemeTweakColor("chrome.accent");
    expect(memo()).toEqual(before);
    useThemeStore.getState().setTheme("mayonaka");
    expect(background()).toEqual(before);
  });

  it("clears the memo on a full tweak reset", () => {
    useThemeStore.getState().setTheme("hanabi");
    useThemeStore.getState().resetThemeTweaks();
    expect(memo()).toBeUndefined();
    useThemeStore.getState().setTheme("mayonaka");
    expect(background()).toEqual(DEFAULT_THEME_BACKGROUND);
  });
});

describe("saved background and memo hydrate together into a fresh store", () => {
  it("restores a saved automatic scene after restart or later window startup", async () => {
    useThemeStore.getState().setThemeBackground({ solidSurfaces: true, panelOpacity: 0.31, terminalOpacity: 0.19 });
    const before = background();
    useThemeStore.getState().setTheme("hanabi");
    const saved = save();
    expect(saved.themeTweaks.hanabiBackgroundRestore).toEqual(before);
    const fresh = await freshStore(saved);
    expect(fresh.getState().themeTweaks.background).toEqual(saved.themeTweaks.background);
    expect(fresh.getState().themeTweaks.hanabiBackgroundRestore).toEqual(saved.themeTweaks.hanabiBackgroundRestore);
    fresh.getState().setTheme("mayonaka");
    expect(fresh.getState().themeTweaks.background).toEqual(before);
    expect(fresh.getState().themeTweaks.hanabiBackgroundRestore).toBeUndefined();
  });

  it("does not resurrect the old memo after a manual edit is saved and hydrated", async () => {
    useThemeStore.getState().setTheme("hanabi");
    const oldSaved = save();
    useThemeStore.getState().setThemeBackground({ sceneId: "harbor-night", panelOpacity: 0.38 });
    const editedSaved = save();
    expect(editedSaved.themeTweaks).not.toHaveProperty("hanabiBackgroundRestore");
    const fresh = await freshStore(oldSaved);
    expect(fresh.getState().themeTweaks.hanabiBackgroundRestore).toBeDefined();
    fresh.getState().setTheme("kyokuya");
    fresh.getState().hydrateSettings(editedSaved);
    expect(fresh.getState().previousThemeSnapshot).toBeNull();
    expect(fresh.getState().themeTweaks.hanabiBackgroundRestore).toBeUndefined();
    fresh.getState().setTheme("mayonaka");
    expect(fresh.getState().themeTweaks.background).toEqual(editedSaved.themeTweaks.background);
  });

  it("leaves an old saved scene without a memo in user ownership", async () => {
    const saved = { themeId: "hanabi", themeTweaks: { background: { ...DEFAULT_THEME_BACKGROUND, mode: "scene" } } };
    const fresh = await freshStore(saved);
    const before = fresh.getState().themeTweaks.background;
    expect(fresh.getState().themeTweaks.hanabiBackgroundRestore).toBeUndefined();
    fresh.getState().setTheme("mayonaka");
    expect(fresh.getState().themeTweaks.background).toEqual(before);
  });

  it.each([
    null, 42, "broken", [], {},
    { ...DEFAULT_THEME_BACKGROUND, mode: "preset" },
    { ...DEFAULT_THEME_BACKGROUND, panelOpacity: "0.4" },
    { ...DEFAULT_THEME_BACKGROUND, terminalOpacity: -1 },
    { ...DEFAULT_THEME_BACKGROUND, sceneId: "unknown" },
    { ...DEFAULT_THEME_BACKGROUND, imagePath: null },
    { ...DEFAULT_THEME_BACKGROUND, completionFireworks: "false" },
    { ...DEFAULT_THEME_BACKGROUND, backgroundCustomized: false },
    { mode: "solid" },
  ])("discards a damaged saved memo without changing the scene: %s", async invalid => {
    const saved = JSON.parse(JSON.stringify({ themeId: "hanabi", themeTweaks: {
      background: { ...DEFAULT_THEME_BACKGROUND, mode: "scene" }, hanabiBackgroundRestore: invalid,
    } }));
    const fresh = await freshStore(saved);
    expect(fresh.getState().themeTweaks.hanabiBackgroundRestore).toBeUndefined();
    const before = fresh.getState().themeTweaks.background;
    fresh.getState().setTheme("mayonaka");
    expect(fresh.getState().themeTweaks.background).toEqual(before);
  });

  it.each([
    ["mayonaka", "scene"], ["hanabi", "solid"],
  ])("rejects a memo attached to an unrelated %s theme / %s background", async (themeId, mode) => {
    const fresh = await freshStore({ themeId, themeTweaks: {
      background: { ...DEFAULT_THEME_BACKGROUND, mode }, hanabiBackgroundRestore: DEFAULT_THEME_BACKGROUND,
    } });
    expect(fresh.getState().themeTweaks.hanabiBackgroundRestore).toBeUndefined();
  });
});
