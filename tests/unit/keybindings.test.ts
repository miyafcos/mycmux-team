import { describe, expect, it } from "vitest";
import {
  getActionDefinition,
  KEYBINDING_DEFINITIONS,
  normalizeShortcut,
} from "../../src/lib/keybindings";

describe("global keybindings", () => {
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

  it("registers the dashboard command without a shortcut conflict", () => {
    expect(getActionDefinition("dashboard.open")).toMatchObject({
      title: "Open dashboard",
      category: "Global",
      defaultShortcut: "ctrl+shift+g",
    });
  });

  it("registers dashboard column commands without a shortcut conflict", () => {
    expect(getActionDefinition("dashboard.column.prev").defaultShortcut).toBe("ctrl+shift+arrowleft");
    expect(getActionDefinition("dashboard.column.next").defaultShortcut).toBe("ctrl+shift+arrowright");
    expect(getActionDefinition("dashboard.column.close").defaultShortcut).toBe("ctrl+shift+backspace");
    expect(getActionDefinition("dashboard.column.pin").defaultShortcut).toBe("ctrl+shift+p");
    const shortcuts = KEYBINDING_DEFINITIONS.map((item) => normalizeShortcut(item.defaultShortcut));
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });
});
