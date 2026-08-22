import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RECOMMENDED_THEMES,
  THEMES,
  getTheme,
} from "../../src/components/theme/themeDefinitions";
import { contrastRatio, resolveAccentTextColor } from "../../src/components/theme/colorContrast";

const themeIds = new Set(THEMES.map((theme) => theme.id));

describe("RECOMMENDED_THEMES", () => {
  it("references only existing themes, without duplicates", () => {
    const ids = RECOMMENDED_THEMES.map((entry) => entry.id);
    for (const id of ids) {
      expect(themeIds.has(id), `unknown theme id: ${id}`).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is exactly graphite, kyokuya, geppaku in that order", () => {
    expect(RECOMMENDED_THEMES.map((entry) => entry.id)).toEqual([
      "graphite",
      "kyokuya",
      "geppaku",
    ]);
  });

  it("is two dark themes and one light theme", () => {
    const schemes = RECOMMENDED_THEMES.map((entry) => getTheme(entry.id).colorScheme);
    expect(schemes.filter((scheme) => scheme === "dark")).toHaveLength(2);
    expect(schemes.filter((scheme) => scheme === "light")).toHaveLength(1);
  });

  it("every recommended theme has AA-safe accent text", () => {
    for (const entry of RECOMMENDED_THEMES) {
      const theme = getTheme(entry.id);
      const accentText = resolveAccentTextColor(
        theme.chrome.accent,
        theme.chrome.text,
        theme.chrome.background,
      );
      const ratio = contrastRatio(accentText, theme.chrome.background);
      expect(ratio, `${entry.id}: accent text ${ratio.toFixed(2)} < 4.5`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("theme picker wiring", () => {
  // Regression guard for the original bug: 30 themes existed but the picker
  // UI was deleted, leaving setTheme() with zero callers.
  it("AppearanceTab renders the ThemePicker", () => {
    const source = readFileSync(
      join(__dirname, "../../src/components/settings/tabs/AppearanceTab.tsx"),
      "utf8",
    );
    expect(source).toMatch(/ThemePicker/);
  });

  it("ThemePicker calls setTheme from the store", () => {
    const source = readFileSync(
      join(__dirname, "../../src/components/theme/ThemePicker.tsx"),
      "utf8",
    );
    expect(source).toMatch(/setTheme/);
    expect(source).toMatch(/restoreThemeSnapshot/);
  });

  it("ThemePicker uses the shared background-preset segment and keeps recommended cards on one row", () => {
    const source = readFileSync(
      join(__dirname, "../../src/components/theme/ThemePicker.tsx"),
      "utf8",
    );
    expect(source).toMatch(/BackgroundPresetSegment/);
    expect(source).toMatch(/repeat\(3, minmax\(0, 1fr\)\)/);
  });
});
