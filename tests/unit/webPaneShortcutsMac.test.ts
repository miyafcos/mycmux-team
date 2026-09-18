// @vitest-environment jsdom

// A web pane only sends back the keys it was told to forward, and the list is
// built from the keybindings — so on macOS it has to be the list of keys the
// user actually presses (Command), not the Windows spelling. The platform is
// read once at import time, so the suite stubs a navigator and imports by hand
// (see keybindingsPlatform.test.ts).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type KeybindingsModule = typeof import("../../src/lib/keybindings");
type ShortcutsModule = typeof import("../../src/components/workspace/webPaneShortcuts");

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

let keybindings: KeybindingsModule;
let shortcuts: ShortcutsModule;

beforeAll(async () => {
  vi.stubGlobal("navigator", { userAgent: MAC_UA });
  vi.resetModules();
  keybindings = await import("../../src/lib/keybindings");
  shortcuts = await import("../../src/components/workspace/webPaneShortcuts");
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("web pane shortcut forwarding on macOS", () => {
  it("forwards the Command keys the user presses, not the Control spelling", () => {
    const forwarded = shortcuts.deriveWebPaneForwardedShortcuts(keybindings.DEFAULT_KEYBINDINGS);

    expect(forwarded).toContain("meta+1");
    expect(forwarded).toContain("meta+9");
    expect(forwarded).toContain("alt+meta+arrowleft");
    expect(forwarded).not.toContain("ctrl+1");
    expect(forwarded).not.toContain("ctrl+alt+arrowleft");
  });

  it("keeps the two Tab bindings on Control, where macOS leaves them", () => {
    const forwarded = shortcuts.deriveWebPaneForwardedShortcuts(keybindings.DEFAULT_KEYBINDINGS);

    expect(forwarded).toContain("ctrl+tab");
    expect(forwarded).toContain("ctrl+shift+tab");
  });

  it("names an Option combination by its physical key, not by the glyph macOS types", () => {
    const shortcut = shortcuts.shortcutFromWebPanePayload({
      tabId: "web-tab",
      // ⌥⌘← arrives with the arrow intact, but ⌥⌘D arrives as "∂".
      key: "∂",
      code: "KeyD",
      location: 0,
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
      metaKey: true,
      repeat: false,
      isComposing: false,
    });

    expect(shortcut).toBe("alt+meta+d");
  });
});
