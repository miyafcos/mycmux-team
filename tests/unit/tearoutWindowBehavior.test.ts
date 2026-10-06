import { describe, expect, it } from "vitest";
import { sourceLogicalExtent, windowsNativeBand } from "../../src/lib/tearout/windowBehavior";

describe("Windows-only native window behavior", () => {
  it("keeps Mac, Linux and the OFF route unchanged", () => {
    expect(windowsNativeBand(true, "Win32")).toBe(true);
    for (const platform of ["MacIntel", "Linux x86_64", ""]) expect(windowsNativeBand(true, platform)).toBe(false);
    expect(windowsNativeBand(false, "Win32")).toBe(false);
  });
  it.each(["tab", "pane"] as const)("sizes %s from the whole source pane, not its grip", kind => {
    expect(sourceLogicalExtent(kind, { width: 654, height: 432 }, { width: 1200, height: 800 }))
      .toEqual({ width: 654, height: 432 });
  });
  it("sizes a workspace from its source window", () => {
    expect(sourceLogicalExtent("workspace", { width: 654, height: 432 }, { width: 1200, height: 800 }))
      .toEqual({ width: 1200, height: 800 });
  });
  it("keeps the previous fallback only when the source extent cannot be measured", () => {
    expect(sourceLogicalExtent("tab", null, { width: 1200, height: 800 })).toEqual({ width: 720, height: 520 });
    expect(sourceLogicalExtent("pane", { width: NaN, height: 432 }, { width: 1200, height: 800 }))
      .toEqual({ width: 720, height: 520 });
  });
});
