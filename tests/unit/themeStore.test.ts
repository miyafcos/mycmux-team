import { describe, expect, it } from "vitest";
import { TERMINAL_FONT_PRESETS, normalizeLineHeight } from "../../src/stores/themeStore";

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
