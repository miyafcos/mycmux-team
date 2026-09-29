// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  nonGenericFamilies,
  missingFamilies,
  stackBreaksBoxDrawing,
  stackFallsBackEntirely,
  resetFontAvailabilityCache,
} from "../../src/lib/fontAvailability";

// A stack that resolves to nothing still renders -- as the generic fallback, at
// metrics nobody chose. That is the state the Mac was in: it carried
// `'MS Gothic', 'BIZ UDGothic', monospace` over from the Windows box, drew it in
// Menlo with Hiragino Sans filling in the Japanese, and said nothing about it.
// These tests cover the two halves of noticing that: splitting the stack, and
// deciding whether a named family actually resolves.

/**
 * Stand in for the browser's text measurement.
 *
 * `installed` is the set of families this fake machine has. The probe compares
 * `"<family>", <generic>` against the generic alone, so an absent family has to
 * measure identically to its generic and a present one has to differ.
 */
function mockMeasuredFonts(installed: string[]): void {
  const context = {
    font: "",
    measureText(text: string) {
      const hasInstalled = installed.some((family) => this.font.includes(`"${family}"`));
      return { width: hasInstalled ? text.length * 12 : text.length * 10 };
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  resetFontAvailabilityCache();
}

afterEach(() => {
  vi.restoreAllMocks();
  resetFontAvailabilityCache();
});

describe("nonGenericFamilies", () => {
  it("keeps real family names and drops the generic keyword", () => {
    expect(nonGenericFamilies("'MS Gothic', 'BIZ UDGothic', monospace")).toEqual([
      "MS Gothic",
      "BIZ UDGothic",
    ]);
  });

  it("strips both quote styles", () => {
    expect(nonGenericFamilies("\"UDEV Gothic NF\", 'JetBrains Mono'")).toEqual([
      "UDEV Gothic NF",
      "JetBrains Mono",
    ]);
  });

  it("treats the ui-* and system keywords as generics", () => {
    // macOS exposes SF Mono only through `ui-monospace`; the literal family name
    // 'SF Mono' does not resolve, which is why the old macOS preset was dead.
    expect(nonGenericFamilies("ui-monospace, system-ui, -apple-system, monospace")).toEqual([]);
  });

  it("is case-insensitive about generics", () => {
    expect(nonGenericFamilies("Menlo, MONOSPACE, BlinkMacSystemFont")).toEqual(["Menlo"]);
  });

  it("ignores empty segments and stray whitespace", () => {
    expect(nonGenericFamilies("  Menlo ,, , 'Hiragino Sans' ,serif")).toEqual([
      "Menlo",
      "Hiragino Sans",
    ]);
  });

  it("returns nothing for an empty stack", () => {
    expect(nonGenericFamilies("")).toEqual([]);
  });
});

describe("stackFallsBackEntirely", () => {
  it("is true when a Windows stack lands on a machine that has none of it", () => {
    mockMeasuredFonts(["Menlo", "Hiragino Sans"]);
    expect(stackFallsBackEntirely("'MS Gothic', 'BIZ UDGothic', monospace")).toBe(true);
  });

  it("is false when one named family resolves", () => {
    mockMeasuredFonts(["BIZ UDGothic"]);
    expect(stackFallsBackEntirely("'MS Gothic', 'BIZ UDGothic', monospace")).toBe(false);
  });

  it("is false for a stack of generics, which always resolve", () => {
    mockMeasuredFonts([]);
    expect(stackFallsBackEntirely("ui-monospace, monospace")).toBe(false);
  });

  it("reports exactly which families are missing", () => {
    mockMeasuredFonts(["Menlo"]);
    expect(missingFamilies("'MS Gothic', Menlo, 'BIZ UDGothic', monospace")).toEqual([
      "MS Gothic",
      "BIZ UDGothic",
    ]);
  });

  it("ignores document.fonts.check, which says yes to anything", () => {
    // Measured on the Mac on 2026-09-10: check() returned true for every family
    // asked, including one invented for the test. It reports whether the fonts
    // needed to render the text have finished loading, and a stack that will
    // fall back to a generic has nothing left to load. Trusting it is what kept
    // the repair from firing on a stack resolving to none of its named families.
    mockMeasuredFonts([]);
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts?.check) {
      vi.spyOn(fonts, "check").mockReturnValue(true);
    }
    expect(stackFallsBackEntirely("'MS Gothic', 'BIZ UDGothic', monospace")).toBe(true);
  });

  it("claims availability when there is no canvas to measure with", () => {
    // Better to leave a working font unlabelled than to mark it missing: the
    // label drives a repair that would otherwise fire against a healthy setting.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    resetFontAvailabilityCache();
    expect(stackFallsBackEntirely("'MS Gothic', monospace")).toBe(false);
  });
});

describe("stackBreaksBoxDrawing", () => {
  /**
   * Measure like a font that draws box glyphs at a given em width against a
   * 0.5em Latin advance -- the shape every Japanese monospace face has, with
   * only the rules differing.
   */
  function mockBoxWidth(emPerRule: number): void {
    const context = {
      font: "",
      measureText(text: string) {
        const size = 72;
        let width = 0;
        for (const ch of text) {
          const code = ch.codePointAt(0) ?? 0;
          const isRule = code >= 0x2500 && code <= 0x257f;
          width += size * (isRule ? emPerRule : 0.5);
        }
        return { width };
      },
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    resetFontAvailabilityCache();
  }

  it("flags a face that draws rules at full width", () => {
    // BIZ UDGothic and MS Gothic both do this. The terminal gives each rule one
    // cell, so they land in the next one and tables come apart.
    mockBoxWidth(1.0);
    expect(stackBreaksBoxDrawing("'BIZ UDGothic', monospace")).toBe(true);
  });

  it("passes a face that draws rules at half width", () => {
    // UDEV Gothic, the bundled face.
    mockBoxWidth(0.5);
    expect(stackBreaksBoxDrawing("'UDEV Gothic NF', monospace")).toBe(false);
  });

  it("claims nothing when there is no canvas to measure with", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    resetFontAvailabilityCache();
    expect(stackBreaksBoxDrawing("'BIZ UDGothic', monospace")).toBe(false);
  });
});
