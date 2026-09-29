// @vitest-environment jsdom

// The keybinding store reads the platform once, at import time, so each suite
// stubs a navigator and then imports the modules by hand. The suites run in
// order, so the Windows one re-imports over the macOS one rather than
// alongside it. Everything platform-independent belongs in keybindings.test.ts.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type KeybindingsModule = typeof import("../../src/lib/keybindings");
type StoreModule = typeof import("../../src/stores/keybindingStore");

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)";

let keybindings: KeybindingsModule;
let useKeybindingStore: StoreModule["useKeybindingStore"];

async function loadFor(userAgent: string): Promise<void> {
  vi.stubGlobal("navigator", { userAgent });
  vi.resetModules();
  keybindings = await import("../../src/lib/keybindings");
  ({ useKeybindingStore } = await import("../../src/stores/keybindingStore"));
}

afterAll(() => {
  vi.unstubAllGlobals();
});

interface KeyProps {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

const press = (props: KeyProps) =>
  useKeybindingStore.getState().getActionsForEvent(new KeyboardEvent("keydown", props));

describe("macOS keyboard shortcuts", () => {
  beforeAll(() => loadFor(MAC_UA));

  it("is set up against a macOS navigator", () => {
    expect(keybindings.IS_MAC).toBe(true);
  });

  it("fires a binding from Command, with one modifier and with several", () => {
    // ⌘P was the reported symptom: the palette only opened on physical ⌃P,
    // while the app told the user to press ⌘P.
    expect(press({ key: "p", code: "KeyP", metaKey: true })).toEqual(["crsm.palette"]);
    expect(press({ key: "T", code: "KeyT", metaKey: true, shiftKey: true })).toEqual(["pane.reopen"]);
    expect(press({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true, altKey: true }))
      .toEqual(["pane.focus.left"]);
    expect(press({ key: "N", code: "KeyN", metaKey: true, shiftKey: true })).toEqual(["workspace.new"]);
    expect(press({ key: "1", code: "Digit1", metaKey: true })).toEqual(["workspace.jump.1"]);
    expect(press({ key: "G", code: "KeyG", metaKey: true, shiftKey: true })).toEqual(["dashboard.open"]);
  });

  it("leaves the physical Control key to the shell", () => {
    // Everything here is a key the terminal needs: ⌃P is history, ⌃W deletes a
    // word, ⌃B moves back a character, ⌃K kills to end of line.
    expect(press({ key: "p", code: "KeyP", ctrlKey: true })).toEqual([]);
    expect(press({ key: "b", code: "KeyB", ctrlKey: true })).toEqual([]);
    expect(press({ key: "w", code: "KeyW", ctrlKey: true, altKey: true })).toEqual([]);
    expect(press({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true })).toEqual([]);
    expect(press({ key: "ArrowLeft", code: "ArrowLeft", ctrlKey: true, altKey: true })).toEqual([]);
  });

  it("keeps the two Tab bindings on Control, since ⌘⇥ switches applications", () => {
    expect(press({ key: "Tab", code: "Tab", ctrlKey: true })).toEqual(["workspace.next"]);
    expect(press({ key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true })).toEqual(["workspace.prev"]);
    expect(press({ key: "Tab", code: "Tab", metaKey: true })).toEqual([]);
  });

  it("reads an Option binding from the physical key, not from the glyph macOS types", () => {
    // With Option down macOS replaces `key`: ⌥I is a dead key, ⌥A is "å",
    // ⌥W is "∑", ⌥P is "π". Only `code` still says which key was pressed.
    expect(press({ key: "Dead", code: "KeyI", metaKey: true, altKey: true })).toEqual(["composer.focus"]);
    expect(press({ key: "å", code: "KeyA", metaKey: true, altKey: true })).toEqual(["pane.attention.next"]);
    expect(press({ key: "∑", code: "KeyW", metaKey: true, altKey: true })).toEqual(["pane.close"]);
    expect(press({ key: "π", code: "KeyP", metaKey: true, altKey: true })).toEqual(["pane.tab.pin.toggle"]);
  });

  it("splits on ⌘D and ⇧⌘D, leaving ⌥⌘D to the Dock", () => {
    expect(press({ key: "d", code: "KeyD", metaKey: true })).toEqual(["pane.split.right"]);
    expect(press({ key: "D", code: "KeyD", metaKey: true, shiftKey: true })).toEqual(["pane.split.down"]);
    expect(press({ key: "∂", code: "KeyD", metaKey: true, altKey: true })).toEqual([]);
  });

  it("applies the same trade to an override, and honours one written as meta", () => {
    const store = useKeybindingStore.getState();
    store.setOverride("terminal.search", "ctrl+shift+e");
    expect(press({ key: "E", code: "KeyE", metaKey: true, shiftKey: true })).toEqual(["terminal.search"]);
    expect(press({ key: "E", code: "KeyE", ctrlKey: true, shiftKey: true })).toEqual([]);

    store.setOverride("terminal.search", "meta+shift+e");
    expect(press({ key: "E", code: "KeyE", metaKey: true, shiftKey: true })).toEqual(["terminal.search"]);

    store.resetAll();
    expect(press({ key: "F", code: "KeyF", metaKey: true, shiftKey: true })).toEqual(["terminal.search"]);
  });

  it("ships the macOS split defaults in the effective map", () => {
    expect(keybindings.DEFAULT_KEYBINDINGS["pane.split.right"]).toBe("meta+d");
    expect(keybindings.DEFAULT_KEYBINDINGS["pane.split.down"]).toBe("shift+meta+d");
    expect(keybindings.DEFAULT_KEYBINDINGS["workspace.next"]).toBe("ctrl+tab");
  });

  it("labels every default with the key that actually fires it", () => {
    const label = (action: Parameters<typeof keybindings.getActionDefinition>[0]) =>
      keybindings.formatShortcutLabel(keybindings.DEFAULT_KEYBINDINGS[action]);
    expect(label("crsm.palette")).toBe("⌘P");
    expect(label("pane.reopen")).toBe("⇧⌘T");
    expect(label("workspace.next")).toBe("⌃⇥");
    expect(label("workspace.prev")).toBe("⌃⇧⇥");
    expect(label("pane.split.right")).toBe("⌘D");
  });
});

describe("Windows keyboard shortcuts", () => {
  beforeAll(() => loadFor(WINDOWS_UA));

  it("is set up against a Windows navigator", () => {
    expect(keybindings.IS_MAC).toBe(false);
  });

  it("still fires every binding from Control, exactly as before", () => {
    expect(press({ key: "p", code: "KeyP", ctrlKey: true })).toEqual(["crsm.palette"]);
    expect(press({ key: "T", code: "KeyT", ctrlKey: true, shiftKey: true })).toEqual(["pane.reopen"]);
    expect(press({ key: "Tab", code: "Tab", ctrlKey: true })).toEqual(["workspace.next"]);
    expect(press({ key: "d", code: "KeyD", ctrlKey: true, altKey: true })).toEqual(["pane.split.right"]);
    expect(press({ key: "ArrowLeft", code: "ArrowLeft", ctrlKey: true, altKey: true }))
      .toEqual(["pane.focus.left"]);
  });

  it("does not let the Windows key stand in for Control", () => {
    expect(press({ key: "p", code: "KeyP", metaKey: true })).toEqual([]);
    expect(press({ key: "T", code: "KeyT", metaKey: true, shiftKey: true })).toEqual([]);
    expect(press({ key: "d", code: "KeyD", metaKey: true })).toEqual([]);
  });

  it("keeps the Windows split defaults and writes labels the Windows way", () => {
    expect(keybindings.DEFAULT_KEYBINDINGS["pane.split.right"]).toBe("ctrl+alt+d");
    expect(keybindings.DEFAULT_KEYBINDINGS["pane.split.down"]).toBe("ctrl+alt+shift+d");
    expect(keybindings.formatShortcutLabel("ctrl+shift+t")).toBe("Ctrl+Shift+T");
  });
});
