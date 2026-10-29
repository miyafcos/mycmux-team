import { describe, expect, it } from "vitest";
import { THEMES } from "../../src/components/theme/themeDefinitions";
import { contrastRatio } from "../../src/components/theme/colorContrast";
import { hexToOklch } from "../../src/lib/oklch";
import { compositeOver } from "../../src/lib/theme/oklab";
import { GRASS_DARK, GRASS_LIGHT, grassScale } from "../../src/components/ailog/grassScale";

describe("usage grass ordinal scale", () => {
  it("uses the dark positive palette by default and selects light explicitly", () => {
    expect(grassScale().slice(1)).toEqual(GRASS_DARK);
    expect(grassScale("light").slice(1)).toEqual(GRASS_LIGHT);
  });
  for (const theme of THEMES) {
    it(`keeps contrast, ordered lightness, step separation and one hue on ${theme.id}`, () => {
      const colors = grassScale(theme.colorScheme).slice(1);
      // resolveTheme: dark popover = 93% sRGB surface + 7% white.
      const popover = theme.colorScheme === "light" ? theme.chrome.surface : compositeOver(theme.chrome.surface, 0.93, "#ffffff");
      expect(contrastRatio(colors[0], popover)).toBeGreaterThanOrEqual(2);
      const lch = colors.map(hexToOklch);
      const sign = theme.colorScheme === "light" ? -1 : 1;
      for (let i = 1; i < lch.length; i++) expect((lch[i].L - lch[i - 1].L) * sign).toBeGreaterThanOrEqual(0.06);
      expect(Math.max(...lch.map(c => c.h)) - Math.min(...lch.map(c => c.h))).toBeLessThanOrEqual(10);
    });
  }

  // A foreground wash cannot remove the authored surface chroma on these three
  // themes while keeping the same percentage usable by all other themes.
  // Only the 0.03 chroma ceiling is excepted; both contrast floors still apply.
  const chromaExceptions: Record<string, { ceiling: number; reason: string }> = {
    "yoi-ai": { ceiling: 0.045, reason: "The teal surface remains at C=0.044913 with the common 9.9% wash." },
    "yogiri": { ceiling: 0.044, reason: "The violet surface remains at C=0.043132 with the common 9.9% wash." },
    "synthwave": { ceiling: 0.049, reason: "The purple surface remains at C=0.048508 with the common 9.9% wash." },
  };
  const cases = [
    ...THEMES.map(theme => ({ name: theme.id, theme, scheme: theme.colorScheme as "light" | "dark" | undefined })),
    { name: "default-dark", theme: THEMES.find(theme => theme.id === "mayonaka")!, scheme: undefined },
  ];
  for (const { name, theme, scheme } of cases) {
    it("keeps empty-level contrast and the named chroma limit on " + name, () => {
      const colors = grassScale(scheme);
      const match = /^color-mix\(in srgb, var\(--cmux-text\) ([\d.]+)%, transparent\)$/.exec(colors[0]);
      expect(match).not.toBeNull();
      const alpha = Number(match![1]) / 100;
      expect(alpha).toBeGreaterThan(0);
      expect(alpha).toBeLessThan(1);
      const surface = theme.colorScheme === "light" ? theme.chrome.surface : compositeOver(theme.chrome.surface, 0.93, "#ffffff");
      const empty = compositeOver(theme.chrome.text, alpha, surface);
      const exception = chromaExceptions[name];
      expect(hexToOklch(empty).C, exception?.reason).toBeLessThanOrEqual(exception?.ceiling ?? 0.03);
      expect(contrastRatio(empty, surface)).toBeGreaterThanOrEqual(1.10);
      expect(contrastRatio(empty, colors[1])).toBeGreaterThanOrEqual(1.25);
    });
  }
});
