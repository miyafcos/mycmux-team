import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  WORKSPACE_COLORS,
  WORKSPACE_COLOR_NONE_LABEL,
  normalizeWorkspaceColor,
  resolveWorkspaceColor,
  workspaceColorTint,
  workspaceRowBackground,
} from "../../src/lib/workspaceColors";

describe("workspace color palette", () => {
  it("ships exactly eight preset colors", () => {
    expect(WORKSPACE_COLORS).toHaveLength(8);
  });

  it("uses valid 6-digit hex values with unique ids, labels and values", () => {
    for (const option of WORKSPACE_COLORS) {
      expect(option.value, option.id).toMatch(/^#[0-9A-F]{6}$/);
      expect(option.label.length, option.id).toBeGreaterThan(0);
    }
    expect(new Set(WORKSPACE_COLORS.map((o) => o.id)).size).toBe(WORKSPACE_COLORS.length);
    expect(new Set(WORKSPACE_COLORS.map((o) => o.value)).size).toBe(WORKSPACE_COLORS.length);
    expect(new Set(WORKSPACE_COLORS.map((o) => o.label)).size).toBe(WORKSPACE_COLORS.length);
  });

  it("names the clear-color choice", () => {
    expect(WORKSPACE_COLOR_NONE_LABEL).toBe("なし");
  });

  it("resolves palette values case-insensitively and rejects everything else", () => {
    const blue = WORKSPACE_COLORS[0];
    expect(resolveWorkspaceColor(blue.value)).toEqual(blue);
    expect(resolveWorkspaceColor(blue.value.toLowerCase())).toEqual(blue);
    expect(resolveWorkspaceColor("#123456")).toBeUndefined();
    expect(resolveWorkspaceColor("red")).toBeUndefined();
    expect(resolveWorkspaceColor("")).toBeUndefined();
    expect(resolveWorkspaceColor(null)).toBeUndefined();
    expect(resolveWorkspaceColor(undefined)).toBeUndefined();
  });

  it("normalizes to the palette's own casing and drops unknown values", () => {
    const green = WORKSPACE_COLORS[2];
    expect(normalizeWorkspaceColor(green.value.toLowerCase())).toBe(green.value);
    // Guards the chrome against a hand-edited data.json injecting an arbitrary
    // (possibly unreadable) color.
    expect(normalizeWorkspaceColor("#000000")).toBeUndefined();
    expect(normalizeWorkspaceColor(undefined)).toBeUndefined();
  });

  it("derives backgrounds through color-mix so theme contrast survives", () => {
    expect(workspaceColorTint("#4C8DF6", 12)).toBe("color-mix(in srgb, #4C8DF6 12%, transparent)");
    expect(workspaceRowBackground(undefined, false, "transparent")).toBe("transparent");
    expect(workspaceRowBackground(undefined, true, "var(--cmux-selected)")).toBe("var(--cmux-selected)");
    expect(workspaceRowBackground("#4C8DF6", false, "transparent")).toBe(
      "color-mix(in srgb, #4C8DF6 9%, transparent)",
    );
    // Active + colored keeps the selected surface underneath the group tint so
    // the two signals stay distinguishable.
    expect(workspaceRowBackground("#4C8DF6", true, "var(--cmux-selected)")).toBe(
      "color-mix(in srgb, #4C8DF6 16%, var(--cmux-selected))",
    );
  });
});

// Workspace.color spent months persisted-but-never-rendered. These pins keep
// every consumer of the field attached: drop one and the field goes dead again.
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("workspace color render surfaces stay wired", () => {
  it("paints the sidebar row bar and tint from the workspace color", () => {
    const tabItem = read("src/components/layout/TabItem.tsx");
    expect(tabItem).toContain("resolveWorkspaceColor");
    expect(tabItem).toContain("workspaceRowBackground(");
    expect(tabItem).toContain("`3px solid ${workspaceColor}`");
  });

  it("feeds the workspace color and the color picker through the sidebar", () => {
    const tabBar = read("src/components/layout/TabBar.tsx");
    expect(tabBar).toContain("color={ws.color}");
    expect(tabBar).toContain("s.setWorkspaceColor");
    expect(tabBar).toContain("onContextMenu={(e) => onContextMenu(e, ws.id)}");
    expect(tabBar).toContain("WorkspaceColorSwatches");
    expect(tabBar).toContain("useDismissOnOutside(Boolean(contextMenu)");
  });

  it("marks the active workspace with a color dot in the title bar", () => {
    const titleBar = read("src/components/layout/TitleBar.tsx");
    expect(titleBar).toContain("resolveWorkspaceColor(activeWorkspace?.color)");
    expect(titleBar).toContain('className="workspace-color-dot"');
  });

  it("round-trips the color through the persisted workspace config", () => {
    const socketListener = read("src/components/layout/SocketListener.tsx");
    expect(socketListener).toContain("color: ws.color ?? null,");
    // The read side lives in the shared restore helper, which the startup
    // restore and the multi-window adoption paths both go through.
    expect(read("src/lib/workspaceRestore.ts")).toContain("color: cfg.color ?? undefined,");
    expect(read("src/lib/ipc.ts")).toContain("color?: string | null;");
    expect(read("src-tauri/src/db/storage.rs")).toContain("pub color: Option<String>,");
  });

  it("styles the picker and the dot from the shared stylesheet", () => {
    const css = read("src/global.css");
    for (const selector of [
      ".workspace-color-swatches {",
      ".workspace-color-swatch {",
      ".workspace-color-swatch--none {",
      ".workspace-color-dot {",
    ]) {
      expect(css).toContain(selector);
    }
  });
});
