import { beforeEach, describe, expect, it } from "vitest";
import { getTheme } from "../../src/components/theme/themeDefinitions";
import { contrastRatio } from "../../src/components/theme/colorContrast";
import { DEFAULT_THEME_BACKGROUND, normalizeThemeBackground } from "../../src/lib/themeBackgrounds";
import { EMPTY_WALLPAPER_CACHE, resolveEffectiveMediaActive } from "../../src/lib/wallpaperCache";
import { useThemeStore } from "../../src/stores/themeStore";

beforeEach(() => useThemeStore.getState().hydrateSettings({ themeId: "mayonaka" }));
describe("hanabi settings and compatibility", () => {
  it.each([null, undefined, {}, { mode: "bogus" }, []])("normalizes old or invalid settings %s", input => {
    expect(normalizeThemeBackground(input)).toEqual(DEFAULT_THEME_BACKGROUND);
  });
  it("migrates old wallpaper fields without changing image selection or opacity", () => {
    const background = normalizeThemeBackground({ mode: "image", imagePath: "C:\\wallpaper.png",
      imageDim: 0.3, panelOpacity: 0.4, terminalOpacity: 0.2 });
    expect(background).toMatchObject({ mode: "image", imagePath: "C:\\wallpaper.png", wallpaperTone: -0.3,
      panelOpacity: 0.4, terminalOpacity: 0.2, completionFireworks: true });
  });
  it("round-trips the new scene and disabled celebrations through JSON", () => {
    const normalized = normalizeThemeBackground({ mode: "scene", sceneId: "winter-night", completionFireworks: false });
    expect(normalizeThemeBackground(JSON.parse(JSON.stringify(normalized)))).toEqual(normalized);
    expect(normalized.mode).toBe("scene"); expect(normalized.completionFireworks).toBe(false);
    expect(normalizeThemeBackground({ mode: "scene", sceneId: "unknown" })).toMatchObject({ mode: "scene", sceneId: "winter-night" });
    expect(normalizeThemeBackground({ mode: "scene", completionFireworks: "false" }).completionFireworks).toBe(true);
  });
  it("activates glass immediately without a downloaded wallpaper, respecting solid surfaces", () => {
    const background = normalizeThemeBackground({ mode: "scene" });
    expect(resolveEffectiveMediaActive(background, EMPTY_WALLPAPER_CACHE)).toBe(true);
    expect(resolveEffectiveMediaActive({ ...background, solidSurfaces: true }, EMPTY_WALLPAPER_CACHE)).toBe(false);
    expect(resolveEffectiveMediaActive(normalizeThemeBackground({ mode: "preset", presetId: "winter" }), EMPTY_WALLPAPER_CACHE)).toBe(false);
  });
  it("selects scene and recommended glass only from untouched solid; undo restores it exactly", () => {
    const before = useThemeStore.getState().themeTweaks.background;
    useThemeStore.getState().setTheme("hanabi");
    expect(useThemeStore.getState().themeTweaks.background).toEqual({ ...before, mode: "scene", panelOpacity: 0.55, terminalOpacity: 0.25 });
    useThemeStore.getState().restoreThemeSnapshot();
    expect(useThemeStore.getState().themeTweaks.background).toEqual(before);
  });
  it.each([
    { panelOpacity: 0.31, terminalOpacity: 0.27 },
    { panelOpacity: DEFAULT_THEME_BACKGROUND.panelOpacity },
    { mode: "solid" as const },
    { wallpaperTone: 0 },
  ])("turns an edited solid background into the scene but keeps the user's values: %s", patch => {
    useThemeStore.getState().setThemeBackground(patch);
    const before = useThemeStore.getState().themeTweaks.background;
    expect(before.backgroundCustomized).toBe(true);
    useThemeStore.getState().setTheme("hanabi");
    const after = useThemeStore.getState().themeTweaks.background;
    expect(after).toEqual({ ...before, mode: "scene", sceneId: "winter-night" });
    expect(normalizeThemeBackground(JSON.parse(JSON.stringify(after)))).toEqual(after);
  });
  it("keeps a legacy customized solid's opacity when it becomes the scene, and allows a fireworks-only toggle", () => {
    useThemeStore.getState().hydrateSettings({ themeId: "mayonaka", themeTweaks: { background: { panelOpacity: 0.3 } } });
    const before = useThemeStore.getState().themeTweaks.background;
    useThemeStore.getState().setTheme("hanabi");
    expect(useThemeStore.getState().themeTweaks.background).toEqual({ ...before, mode: "scene", sceneId: "winter-night" });
    useThemeStore.getState().hydrateSettings({ themeId: "mayonaka" });
    useThemeStore.getState().setThemeBackground({ completionFireworks: false });
    useThemeStore.getState().setTheme("hanabi");
    expect(useThemeStore.getState().themeTweaks.background).toMatchObject({
      mode: "scene", panelOpacity: 0.55, terminalOpacity: 0.25, completionFireworks: false,
    });
  });
  it("turns opaque surfaces into the recommended glass so the scene is visible", () => {
    useThemeStore.getState().setThemeBackground({ solidSurfaces: true, panelOpacity: 0.25, terminalOpacity: 0.15 });
    useThemeStore.getState().setTheme("hanabi");
    expect(useThemeStore.getState().themeTweaks.background).toMatchObject({
      mode: "scene", sceneId: "winter-night", solidSurfaces: false, panelOpacity: 0.55, terminalOpacity: 0.25,
    });
  });
  it.each(["image", "preset"] as const)("preserves a chosen %s background and opacity", mode => {
    useThemeStore.getState().setThemeBackground({ mode, imagePath: "C:\\chosen.png", presetId: "winter",
      panelOpacity: 0.34, terminalOpacity: 0.22, solidSurfaces: true, completionFireworks: false });
    const before = useThemeStore.getState().themeTweaks.background;
    useThemeStore.getState().setTheme("hanabi");
    expect(useThemeStore.getState().themeTweaks.background).toEqual(before);
  });
  it("leaves other theme selections on solid", () => {
    useThemeStore.getState().setTheme("kyokuya");
    expect(useThemeStore.getState().themeTweaks.background.mode).toBe("solid");
  });
  it("fills every chrome, terminal, status and notification color with readable hex values", () => {
    const theme = getTheme("hanabi");
    expect(theme.id).toBe("hanabi"); expect(theme.group).toBe("vivid-dark");
    expect(Object.keys(theme.terminal)).toHaveLength(20);
    expect(Object.keys(theme.chrome)).toHaveLength(10);
    expect(Object.keys(theme.status)).toHaveLength(5);
    for (const color of [...Object.values(theme.terminal), ...Object.values(theme.chrome), ...Object.values(theme.status), theme.notification]) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(contrastRatio(theme.terminal.foreground, theme.terminal.background)).toBeGreaterThanOrEqual(7);
    for (const key of ["text", "textMuted", "textDim"] as const) expect(contrastRatio(theme.chrome[key], theme.chrome.background)).toBeGreaterThanOrEqual(4.5);
  });
});
