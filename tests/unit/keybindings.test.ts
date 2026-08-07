import { describe, expect, it } from "vitest";
import {
  getActionDefinition,
  KEYBINDING_DEFINITIONS,
  normalizeShortcut,
} from "../../src/lib/keybindings";

describe("tab sweep keybinding", () => {
  it("registers a non-conflicting global command", () => {
    const definition = getActionDefinition("tab.sweep");
    expect(definition).toMatchObject({
      title: "タブ掃除を開く",
      category: "Global",
      defaultShortcut: "ctrl+shift+k",
    });

    const shortcuts = KEYBINDING_DEFINITIONS.map((item) => normalizeShortcut(item.defaultShortcut));
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });
});
