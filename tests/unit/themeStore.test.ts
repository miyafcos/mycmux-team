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

describe("terminal font presets", () => {
  it.each([
    ["udev-gothic", "'UDEV Gothic NF', 'UDEV Gothic', 'BIZ UDGothic', 'MS Gothic', monospace"],
    ["udev-gothic-35", "'UDEV Gothic 35NF', 'UDEV Gothic 35', 'BIZ UDGothic', 'MS Gothic', monospace"],
  ])("includes %s with its fallback stack", (id, value) => {
    expect(TERMINAL_FONT_PRESETS.find((preset) => preset.id === id)?.value).toBe(value);
  });
});
