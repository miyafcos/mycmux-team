import { describe, expect, it } from "vitest";
import { shouldForwardWheelToApplication } from "../../src/components/terminal/terminalMouseInputFilter";

describe("terminal wheel routing", () => {
  it("keeps normal-buffer agent history scroll local", () => {
    expect(shouldForwardWheelToApplication("normal", false, true, false)).toBe(false);
  });

  it("keeps normal-buffer history local even if stale mouse mode was recorded", () => {
    expect(shouldForwardWheelToApplication("normal", true, false, false)).toBe(false);
  });

  it("uses the agent fallback only in the alternate buffer", () => {
    expect(shouldForwardWheelToApplication("alternate", false, true, false)).toBe(true);
  });

  it("forwards explicit mouse mode only from the alternate buffer", () => {
    expect(shouldForwardWheelToApplication("alternate", true, false, false)).toBe(true);
  });

  it("always leaves Shift+wheel available for local history", () => {
    expect(shouldForwardWheelToApplication("alternate", true, true, true)).toBe(false);
  });
});
