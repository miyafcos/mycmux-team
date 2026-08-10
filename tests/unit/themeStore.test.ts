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

describe("terminal font presets", () => {
  it.each([
    ["udev-gothic", "'UDEV Gothic NF', 'UDEV Gothic', 'BIZ UDGothic', 'MS Gothic', monospace"],
    ["udev-gothic-35", "'UDEV Gothic 35NF', 'UDEV Gothic 35', 'BIZ UDGothic', 'MS Gothic', monospace"],
  ])("includes %s with its fallback stack", (id, value) => {
    expect(TERMINAL_FONT_PRESETS.find((preset) => preset.id === id)?.value).toBe(value);
  });
});
