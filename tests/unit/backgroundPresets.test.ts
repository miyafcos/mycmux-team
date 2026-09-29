import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  applyBackgroundPreset,
  CLEAR_PANEL_OPACITY,
  CLEAR_TERMINAL_OPACITY,
  NAMED_BACKGROUND_PRESETS,
  resolveBackgroundPreset,
} from "../../src/lib/theme/backgroundPresets";
import {
  DEFAULT_THEME_BACKGROUND,
  normalizeThemeBackground,
  SURFACE_OPACITY_MIN,
} from "../../src/lib/themeBackgrounds";
import type { ThemeBackgroundSettings } from "../../src/types";

const read = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const frosted: ThemeBackgroundSettings = { ...DEFAULT_THEME_BACKGROUND };
const solid: ThemeBackgroundSettings = { ...DEFAULT_THEME_BACKGROUND, solidSurfaces: true };
const clear: ThemeBackgroundSettings = {
  ...DEFAULT_THEME_BACKGROUND,
  panelOpacity: 0.25,
  terminalOpacity: 0.15,
};
const custom: ThemeBackgroundSettings = {
  ...DEFAULT_THEME_BACKGROUND,
  panelOpacity: 0.4,
  terminalOpacity: 0.33,
};

describe("resolveBackgroundPreset", () => {
  it.each([
    ["solid", solid],
    ["frosted", frosted],
    ["clear", clear],
    ["custom", custom],
  ] as const)("classifies %s", (id, background) => {
    expect(resolveBackgroundPreset(background)).toBe(id);
  });

  it("treats solidSurfaces as solid regardless of opacity", () => {
    expect(resolveBackgroundPreset({ ...custom, solidSurfaces: true })).toBe("solid");
    expect(resolveBackgroundPreset({ ...clear, solidSurfaces: true })).toBe("solid");
  });

  it("accepts opacities within ±0.005 of a named preset", () => {
    expect(
      resolveBackgroundPreset({
        ...frosted,
        panelOpacity: DEFAULT_THEME_BACKGROUND.panelOpacity + 0.005,
        terminalOpacity: DEFAULT_THEME_BACKGROUND.terminalOpacity - 0.005,
      }),
    ).toBe("frosted");
    expect(
      resolveBackgroundPreset({
        ...clear,
        panelOpacity: CLEAR_PANEL_OPACITY - 0.005,
        terminalOpacity: CLEAR_TERMINAL_OPACITY + 0.005,
      }),
    ).toBe("clear");
  });

  it("falls to custom just outside the tolerance", () => {
    expect(
      resolveBackgroundPreset({
        ...frosted,
        panelOpacity: DEFAULT_THEME_BACKGROUND.panelOpacity + 0.006,
      }),
    ).toBe("custom");
    expect(
      resolveBackgroundPreset({
        ...clear,
        terminalOpacity: CLEAR_TERMINAL_OPACITY + 0.006,
      }),
    ).toBe("custom");
  });
});

describe("applyBackgroundPreset", () => {
  it.each(NAMED_BACKGROUND_PRESETS)("round-trips %s through resolve", (id) => {
    const next = { ...DEFAULT_THEME_BACKGROUND, ...applyBackgroundPreset(id) };
    expect(resolveBackgroundPreset(next)).toBe(id);
  });

  it("leaves panel/terminal opacities alone when filling solid", () => {
    expect(applyBackgroundPreset("solid")).toEqual({ solidSurfaces: true });
  });

  it("keeps clear below the old 0.2 floor after normalize", () => {
    const normalized = normalizeThemeBackground({
      ...DEFAULT_THEME_BACKGROUND,
      ...applyBackgroundPreset("clear"),
    });
    expect(normalized.terminalOpacity).toBe(CLEAR_TERMINAL_OPACITY);
    expect(resolveBackgroundPreset(normalized)).toBe("clear");
  });
});

describe("surface opacity floor", () => {
  it("clamps panel and terminal opacities to 0.1", () => {
    const normalized = normalizeThemeBackground({
      ...DEFAULT_THEME_BACKGROUND,
      panelOpacity: 0,
      terminalOpacity: -1,
    });
    expect(SURFACE_OPACITY_MIN).toBe(0.1);
    expect(normalized.panelOpacity).toBe(0.1);
    expect(normalized.terminalOpacity).toBe(0.1);
  });

  it("keeps a stored 0.15 terminal opacity (clear)", () => {
    expect(
      normalizeThemeBackground({ ...DEFAULT_THEME_BACKGROUND, terminalOpacity: 0.15 }).terminalOpacity,
    ).toBe(0.15);
  });
});

describe("shared segment import contract", () => {
  it("ThemePicker and ThemeBackgroundPanel use the same BackgroundPresetSegment", () => {
    const picker = read("src/components/theme/ThemePicker.tsx");
    const panel = read("src/components/theme/ThemeBackgroundPanel.tsx");
    const importLine = 'from "./BackgroundPresetSegment"';
    expect(picker).toContain(importLine);
    expect(panel).toContain(importLine);
    expect(picker).toContain("<BackgroundPresetSegment");
    expect(panel).toContain("<BackgroundPresetSegment");
    expect(picker).not.toContain("solidSurfacesLabel");
    expect(panel).not.toMatch(/type="checkbox"/);
  });
});

describe("preset literals", () => {
  it("pins the spec values independently of the production constants", () => {
    expect(CLEAR_PANEL_OPACITY).toBe(0.25);
    expect(CLEAR_TERMINAL_OPACITY).toBe(0.15);
    expect(DEFAULT_THEME_BACKGROUND.panelOpacity).toBe(0.68);
    expect(DEFAULT_THEME_BACKGROUND.terminalOpacity).toBe(0.62);
  });
});
