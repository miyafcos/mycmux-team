import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  TERMINAL_FONT_PRESETS,
  normalizeFontSize,
  normalizeLineHeight,
  useThemeStore,
} from "../../src/stores/themeStore";

beforeEach(() => {
  useThemeStore.setState({ fontSize: 14 });
});

describe("normalizeFontSize", () => {
  it.each([undefined, null, "14", Number.NaN, Number.POSITIVE_INFINITY])(
    "uses the default for invalid value %s",
    (value) => {
      expect(normalizeFontSize(value)).toBe(14);
    },
  );

  it("rounds and clamps values to the supported range", () => {
    expect(normalizeFontSize(13.4)).toBe(13);
    expect(normalizeFontSize(13.5)).toBe(14);
    expect(normalizeFontSize(FONT_SIZE_MIN - 1)).toBe(FONT_SIZE_MIN);
    expect(normalizeFontSize(FONT_SIZE_MAX + 1)).toBe(FONT_SIZE_MAX);
  });
});

describe("adjustFontSize", () => {
  it("adjusts the current size in one-point steps", () => {
    useThemeStore.getState().adjustFontSize(1);
    expect(useThemeStore.getState().fontSize).toBe(15);
    useThemeStore.getState().adjustFontSize(-1);
    expect(useThemeStore.getState().fontSize).toBe(14);
  });

  it("saturates at both bounds", () => {
    useThemeStore.setState({ fontSize: FONT_SIZE_MAX });
    useThemeStore.getState().adjustFontSize(1);
    expect(useThemeStore.getState().fontSize).toBe(FONT_SIZE_MAX);

    useThemeStore.setState({ fontSize: FONT_SIZE_MIN });
    useThemeStore.getState().adjustFontSize(-1);
    expect(useThemeStore.getState().fontSize).toBe(FONT_SIZE_MIN);
  });

  it("does not publish a store update when already saturated", () => {
    useThemeStore.setState({ fontSize: FONT_SIZE_MAX });
    const subscriber = vi.fn();
    const unsubscribe = useThemeStore.subscribe(subscriber);

    useThemeStore.getState().adjustFontSize(1);

    expect(subscriber).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("normalizeLineHeight", () => {
  it.each([undefined, null, "1.35", Number.NaN, Number.POSITIVE_INFINITY])(
    "uses the default for invalid value %s",
    (value) => {
      expect(normalizeLineHeight(value)).toBe(1.35);
    },
  );

  it("clamps values to the persisted range", () => {
    expect(normalizeLineHeight(0.8)).toBe(1);
    expect(normalizeLineHeight(2.2)).toBe(2);
  });

  it("passes through and rounds valid values", () => {
    expect(normalizeLineHeight(1.35)).toBe(1.35);
    expect(normalizeLineHeight(1.346)).toBe(1.35);
  });
});

describe("setTheme / restoreThemeSnapshot", () => {
  const cleanState = () => {
    useThemeStore.getState().hydrateSettings({ themeId: "mayonaka", themeTweaks: undefined });
    useThemeStore.setState({ previousThemeSnapshot: null });
  };

  it("switches cleanly: drops color tweaks, keeps background tweaks", () => {
    cleanState();
    useThemeStore.getState().setThemeTweakColor("chrome.accent", "#ff0000");
    useThemeStore.getState().setThemeBackground({ panelOpacity: 0.5 });

    useThemeStore.getState().setTheme("kyokuya");

    const state = useThemeStore.getState();
    expect(state.themeId).toBe("kyokuya");
    expect(state.themeTweaks.colors).toEqual({});
    expect(state.themeTweaks.background.panelOpacity).toBe(0.5);
  });

  it("keeps solidSurfaces across a theme switch and hydrates missing values as glass", () => {
    cleanState();
    expect(useThemeStore.getState().themeTweaks.background.solidSurfaces).toBe(false);
    useThemeStore.getState().setThemeBackground({ solidSurfaces: true });
    useThemeStore.getState().setTheme("geppaku");
    expect(useThemeStore.getState().themeTweaks.background.solidSurfaces).toBe(true);
  });

  it("round-trips the pre-switch theme and tweaks via the snapshot", () => {
    cleanState();
    useThemeStore.getState().setThemeTweakColor("chrome.accent", "#ff0000");

    useThemeStore.getState().setTheme("asanagi");
    expect(useThemeStore.getState().previousThemeSnapshot?.themeId).toBe("mayonaka");

    useThemeStore.getState().restoreThemeSnapshot();

    const state = useThemeStore.getState();
    expect(state.themeId).toBe("mayonaka");
    expect(state.themeTweaks.colors["chrome.accent"]).toBe("#ff0000");
    expect(state.theme.chrome.accent).toBe("#ff0000");
    expect(state.previousThemeSnapshot).toBeNull();
  });

  it("restore without a snapshot is a no-op", () => {
    cleanState();
    const before = useThemeStore.getState().themeId;
    useThemeStore.getState().restoreThemeSnapshot();
    expect(useThemeStore.getState().themeId).toBe(before);
  });

  it("falls back to the default theme for unknown ids", () => {
    cleanState();
    useThemeStore.getState().setTheme("no-such-theme");
    expect(useThemeStore.getState().themeId).toBe("mayonaka");
  });
});

// solidSurfaces was added to a settings object that installs already have on
// disk. The two failures worth pinning are opposite: a stored background from
// before the field existed must not read as "fill with theme colour", and a
// user who ticked the box must still find it ticked after a restart.
describe("solidSurfaces survives the load -> edit -> save -> load round trip", () => {
  /** A background written by a build that had never heard of solidSurfaces. */
  const LEGACY_BACKGROUND = {
    mode: "preset",
    presetId: "catppuccin_black_hole",
    imagePath: "",
    imageOpacity: 0.9,
    imageBlur: 4,
    wallpaperTone: -0.3,
    panelOpacity: 0.5,
    terminalOpacity: 0.45,
  };

  /** What SocketListener persists: `theme_tweaks: themeState.themeTweaks`. */
  const saveAndReload = () => {
    const saved = JSON.parse(
      JSON.stringify({
        themeId: useThemeStore.getState().themeId,
        themeTweaks: useThemeStore.getState().themeTweaks,
      }),
    );
    useThemeStore.getState().hydrateSettings({ themeId: "mayonaka", themeTweaks: undefined });
    useThemeStore.getState().hydrateSettings(saved);
  };

  it("reads a legacy background as glass rather than as a solid fill", () => {
    useThemeStore.getState().hydrateSettings({
      themeId: "mayonaka",
      themeTweaks: { enabled: true, colors: {}, background: LEGACY_BACKGROUND },
    });
    const background = useThemeStore.getState().themeTweaks.background;
    expect(background.solidSurfaces).toBe(false);
    // The rest of the legacy object is preserved, not reset by the new field.
    expect(background.terminalOpacity).toBe(0.45);
    expect(background.panelOpacity).toBe(0.5);
  });

  it("keeps a ticked box ticked across save and reload", () => {
    useThemeStore.getState().hydrateSettings({
      themeId: "mayonaka",
      themeTweaks: { enabled: true, colors: {}, background: LEGACY_BACKGROUND },
    });
    useThemeStore.getState().setThemeBackground({ solidSurfaces: true });

    saveAndReload();

    expect(useThemeStore.getState().themeTweaks.background.solidSurfaces).toBe(true);
    expect(useThemeStore.getState().themeTweaks.background.terminalOpacity).toBe(0.45);
  });

  it("keeps an unticked box unticked across save and reload", () => {
    useThemeStore.getState().hydrateSettings({
      themeId: "mayonaka",
      themeTweaks: { enabled: true, colors: {}, background: { ...LEGACY_BACKGROUND, solidSurfaces: true } },
    });
    expect(useThemeStore.getState().themeTweaks.background.solidSurfaces).toBe(true);

    useThemeStore.getState().setThemeBackground({ solidSurfaces: false });
    saveAndReload();

    expect(useThemeStore.getState().themeTweaks.background.solidSurfaces).toBe(false);
  });
});

describe("terminal font presets", () => {
  it("keeps only the approved nine presets", () => {
    expect(TERMINAL_FONT_PRESETS).toHaveLength(9);
    expect(TERMINAL_FONT_PRESETS.map((preset) => preset.id)).not.toContain(["mac", "style"].join("-"));
    expect(TERMINAL_FONT_PRESETS.map((preset) => preset.id)).not.toContain(["hg", "gothic", "m"].join("-"));
  });

  it.each([
    ["udev-gothic", "'UDEV Gothic NF', 'UDEV Gothic', 'BIZ UDGothic', 'MS Gothic', monospace"],
    ["udev-gothic-35", "'UDEV Gothic 35NF', 'UDEV Gothic 35', 'BIZ UDGothic', 'MS Gothic', monospace"],
  ])("includes %s with its fallback stack", (id, value) => {
    expect(TERMINAL_FONT_PRESETS.find((preset) => preset.id === id)?.value).toBe(value);
  });

  it("migrates removed font families during hydration", () => {
    const jetbrains = TERMINAL_FONT_PRESETS.find((preset) => preset.id === "jetbrains-ja")?.value;
    const bizReadable = TERMINAL_FONT_PRESETS.find((preset) => preset.id === "biz-readable")?.value;

    useThemeStore.getState().hydrateSettings({
      fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'BIZ UDGothic', 'Yu Gothic UI', monospace",
    });
    expect(useThemeStore.getState().fontFamily).toBe(jetbrains);

    useThemeStore.getState().hydrateSettings({
      fontFamily: "'HG\uFF7A\uFF9E\uFF7C\uFF6F\uFF78M', 'HGP\uFF7A\uFF9E\uFF7C\uFF6F\uFF78M', 'BIZ UDGothic', 'MS Gothic', monospace",
    });
    expect(useThemeStore.getState().fontFamily).toBe(bizReadable);
  });
});

describe("quick size presets", () => {
  it.each([
    ["small", 12, 0.95, "compact"],
    ["medium", 14, 1, "standard"],
    ["large", 16, 1.15, "relaxed"],
  ] as const)("applies the %s tuple atomically", (size, fontSize, uiFontScale, uiDensity) => {
    useThemeStore.setState({ fontSize: 19, uiFontScale: 1.35, uiDensity: "relaxed" });

    useThemeStore.getState().applyQuickSize(size);

    expect(useThemeStore.getState()).toMatchObject({ fontSize, uiFontScale, uiDensity });
  });
});
