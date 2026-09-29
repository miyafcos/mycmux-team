// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_TERMINAL_FONT_FAMILY, useThemeStore } from "../../src/stores/themeStore";
import { resetFontAvailabilityCache } from "../../src/lib/fontAvailability";

// Hydration repairs a terminal font stack this machine cannot render and leaves
// a mark saying so. Whoever owns persistence reads that mark, saves once, and
// clears it -- and that hand-off is where this went wrong on the Mac. Hydration
// runs from an async effect that resolves *after* the effect installing the
// autosave subscription, so a one-time read at setup always found the mark
// empty: the repair lived in memory, data.json kept the unusable stack, and it
// was redone silently on every launch.
//
// These tests pin the mark itself. The listener side reads it on every store
// change rather than once, which is what makes the ordering stop mattering.

const BROKEN_STACK = "'MS Gothic', 'BIZ UDGothic', monospace";

/**
 * Stand in for text measurement on a machine that has none of the named
 * families: everything falls through to the generic and measures like it.
 */
function mockMachineWithout(installed: string[]): void {
  const context = {
    font: "",
    measureText(text: string) {
      const present = installed.some((family) => this.font.includes(`"${family}"`));
      return { width: text.length * (present ? 12 : 10) };
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  resetFontAvailabilityCache();
}

beforeEach(() => {
  useThemeStore.setState({ fontFamilyRepairedFrom: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetFontAvailabilityCache();
});

describe("terminal font repair on hydration", () => {
  it("replaces a stack the machine cannot render and records what it was", () => {
    mockMachineWithout([]);
    useThemeStore.getState().hydrateSettings({ fontFamily: BROKEN_STACK });

    const state = useThemeStore.getState();
    expect(state.fontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(state.fontFamilyRepairedFrom).toBe(BROKEN_STACK);
  });

  it("leaves a working stack alone and marks nothing", () => {
    mockMachineWithout(["MS Gothic"]);
    useThemeStore.getState().hydrateSettings({ fontFamily: BROKEN_STACK });

    const state = useThemeStore.getState();
    expect(state.fontFamily).toBe(BROKEN_STACK);
    expect(state.fontFamilyRepairedFrom).toBeNull();
  });

  it("keeps the mark until it is cleared, so a late reader still sees it", () => {
    // The failing case in one line: nothing consumed the mark at setup time,
    // and it has to survive until something does.
    mockMachineWithout([]);
    useThemeStore.getState().hydrateSettings({ fontFamily: BROKEN_STACK });
    expect(useThemeStore.getState().fontFamilyRepairedFrom).toBe(BROKEN_STACK);

    useThemeStore.getState().clearFontFamilyRepair();
    expect(useThemeStore.getState().fontFamilyRepairedFrom).toBeNull();
  });

  it("drops the mark when the operator picks a font themselves", () => {
    // A deliberate choice is not a repair to announce.
    mockMachineWithout([]);
    useThemeStore.getState().hydrateSettings({ fontFamily: BROKEN_STACK });

    mockMachineWithout(["Menlo"]);
    useThemeStore.getState().setFontFamily("Menlo, monospace");

    expect(useThemeStore.getState().fontFamilyRepairedFrom).toBeNull();
  });

  it("notifies a subscriber, which is how the mark actually gets consumed", () => {
    // The listener subscribes before hydration happens, so the store change is
    // its only signal that a repair landed.
    mockMachineWithout([]);
    const seen: Array<string | null> = [];
    const unsubscribe = useThemeStore.subscribe((state) => {
      seen.push(state.fontFamilyRepairedFrom);
    });

    useThemeStore.getState().hydrateSettings({ fontFamily: BROKEN_STACK });
    unsubscribe();

    expect(seen).toContain(BROKEN_STACK);
  });
});
