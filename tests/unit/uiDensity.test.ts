import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  UI_DENSITY_TOKENS,
  normalizeUiDensity,
  useThemeStore,
} from "../../src/stores/themeStore";

describe("normalizeUiDensity", () => {
  it.each([undefined, null, "", "dense", 3, {}])(
    "falls back to standard for invalid value %s",
    (value) => {
      expect(normalizeUiDensity(value)).toBe("standard");
    },
  );

  it.each(["compact", "standard", "relaxed"] as const)("passes through %s", (value) => {
    expect(normalizeUiDensity(value)).toBe(value);
  });
});

describe("UI_DENSITY_TOKENS", () => {
  it("standard is byte-identical to the static tokens in global.css (no visual change on upgrade)", () => {
    const css = readFileSync(join(__dirname, "../../src/global.css"), "utf8");
    const readToken = (name: string): string => {
      const match = css.match(new RegExp(`${name}:\\s*([^;]+);`));
      expect(match, `missing ${name} in global.css`).toBeTruthy();
      return (match as RegExpMatchArray)[1].trim();
    };

    const standard = UI_DENSITY_TOKENS.standard;
    expect(standard.fontXs).toBe(readToken("--cmux-font-size-xs"));
    expect(standard.fontSm).toBe(readToken("--cmux-font-size-sm"));
    expect(standard.fontMd).toBe(readToken("--cmux-font-size-md"));
    expect(standard.lineHeightUi).toBe(readToken("--cmux-line-height-ui"));
    expect(standard.spaceScale).toBe(1);
    // Space tokens at scale 1 must reproduce the static ladder.
    const spaceBases = [2, 4, 6, 8, 10, 12, 16];
    spaceBases.forEach((base, index) => {
      expect(`${Math.round(base * standard.spaceScale)}px`).toBe(
        readToken(`--cmux-space-${index + 1}`),
      );
    });
  });

  it("relaxed keeps the Japanese 11px floor and actually loosens", () => {
    const relaxed = UI_DENSITY_TOKENS.relaxed;
    expect(Number.parseInt(relaxed.fontXs, 10)).toBeGreaterThanOrEqual(11);
    expect(Number.parseFloat(relaxed.lineHeightUi)).toBeGreaterThan(1.5);
    expect(relaxed.spaceScale).toBeGreaterThan(1);
  });

  it("compact keeps the Japanese 11px floor", () => {
    expect(Number.parseInt(UI_DENSITY_TOKENS.compact.fontXs, 10)).toBeGreaterThanOrEqual(11);
  });
});

describe("uiDensity store", () => {
  it("setUiDensity normalizes its input", () => {
    useThemeStore.getState().setUiDensity("relaxed");
    expect(useThemeStore.getState().uiDensity).toBe("relaxed");
    // @ts-expect-error deliberately invalid runtime value
    useThemeStore.getState().setUiDensity("bogus");
    expect(useThemeStore.getState().uiDensity).toBe("standard");
  });

  it("hydrateSettings maps uiDensity", () => {
    useThemeStore.getState().hydrateSettings({ uiDensity: "compact" });
    expect(useThemeStore.getState().uiDensity).toBe("compact");
    useThemeStore.getState().hydrateSettings({});
    expect(useThemeStore.getState().uiDensity).toBe("standard");
  });
});

describe("ui_density persistence wiring", () => {
  // The classic bug is updating only one of the two hydrate sites (main
  // window vs child window). Guard all three touchpoints at source level.
  it("SocketListener saves and hydrates ui_density on both paths", () => {
    const source = readFileSync(
      join(__dirname, "../../src/components/layout/SocketListener.tsx"),
      "utf8",
    );
    expect(source).toMatch(/ui_density:\s*themeState\.uiDensity/);
    const hydrateSites = source.match(/uiDensity:\s*(?:data\.)?settings\.ui_density/g) ?? [];
    expect(hydrateSites.length).toBe(2);
  });

  it("AppShell drives the density tokens", () => {
    const source = readFileSync(
      join(__dirname, "../../src/components/layout/AppShell.tsx"),
      "utf8",
    );
    expect(source).toMatch(/--cmux-line-height-ui/);
    expect(source).toMatch(/UI_DENSITY_TOKENS/);
  });
});
