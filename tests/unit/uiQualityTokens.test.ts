import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const globalCss = read("src/global.css");
const appShell = read("src/components/layout/AppShell.tsx");
const crsmPalette = read("src/components/CommandPalette/CrsmPalette.tsx");
const paneTabBar = read("src/components/workspace/PaneTabBar.tsx");
const chromeIcons = read("src/components/icons/ChromeIcons.tsx");
const unavailableMonoFamilies = new RegExp(
  `${["SF", "Mono"].join(" ")}|${["Geist", "Mono"].join(" ")}`,
);

const boundarySource = [
  globalCss,
  appShell,
  crsmPalette,
  read("src/components/CommandPalette/CrsmPalette.css"),
  paneTabBar,
  read("src/components/layout/TitleBar.tsx"),
  read("src/components/layout/TabBar.tsx"),
  read("src/components/layout/TabItem.tsx"),
  read("src/components/layout/NotificationPanel.tsx"),
  read("src/components/layout/UsagePopover.tsx"),
  read("src/components/layout/PathJumper.tsx"),
].join("\n");

describe("UI quality Phase A contracts", () => {
  it("defines the shared surface, border, and typography tokens", () => {
    for (const token of [
      "--cmux-surface-raised:",
      "--cmux-popover:",
      "--cmux-edge-highlight:",
      "--cmux-border-hairline:",
      "--cmux-font-size-xs: 11px;",
      "--cmux-font-size-sm: 12px;",
      "--cmux-font-size-md: 13px;",
      "--cmux-font-mono:",
    ]) {
      expect(globalCss).toContain(token);
    }

    for (const family of ["UDEV Gothic NF", "UDEV Gothic", "JetBrains Mono", "Consolas"]) {
      expect(globalCss).toContain(family);
    }
    expect(globalCss).toContain(
      '--cmux-font-mono: "UDEV Gothic NF", "UDEV Gothic", "JetBrains Mono", Consolas, monospace;',
    );
  });

  it("derives every dynamic chrome ladder token in AppShell", () => {
    for (const token of [
      '"--cmux-surface-raised"',
      '"--cmux-popover"',
      '"--cmux-edge-highlight"',
      '"--cmux-border-hairline"',
    ]) {
      expect(appShell).toContain(token);
    }
    expect(appShell).toContain("isLightChrome");
    expect(appShell).toContain("currentTheme.chrome.surface} 97%, black");
    expect(appShell).toContain("currentTheme.chrome.surface} 96%, white");
    expect(appShell).toContain("currentTheme.chrome.surface} 95%, black");
    expect(appShell).toContain("currentTheme.chrome.surface} 93%, white");
    expect(globalCss).toContain("--cmux-surface-raised: #1f1f1f;");
    expect(globalCss).toContain("--cmux-popover: #262626;");
    expect(globalCss).toContain("--cmux-shadow-popover: var(--cmux-edge-highlight),");
    expect(globalCss).toContain(".pane-tabbar {");
    expect(globalCss).toContain("box-shadow: var(--cmux-edge-highlight);");
    expect(globalCss).toContain("border-right-color: var(--cmux-border-hairline) !important;");
  });

  it("uses monochrome SVG chrome icons instead of emoji glyphs", () => {
    expect(boundarySource).not.toMatch(/[\u270f\u2610\u{1f4c4}]/u);

    for (const icon of ["PencilIcon", "TaskIcon", "DocumentIcon"]) {
      expect(chromeIcons).toMatch(new RegExp(`export function ${icon}`));
      expect(crsmPalette).toContain(`<${icon}`);
    }
    expect(chromeIcons).toContain('stroke: "currentColor"');
  });

  it("uses the Windows mono token throughout the boundary", () => {
    expect(boundarySource).not.toMatch(unavailableMonoFamilies);
    expect(crsmPalette).toContain('fontFamily: "var(--cmux-font-mono)"');
    expect(paneTabBar).toContain('fontFamily: "var(--cmux-font-mono)"');
    expect(crsmPalette).toContain('fontSize: "var(--cmux-font-size-xs)"');
    expect(paneTabBar).toContain('fontSize: "var(--cmux-font-size-xs)"');
    expect(crsmPalette).toContain("...styles.detailFilePath");
    const detailListWrap = crsmPalette.match(/detailListWrap:\s*\{([\s\S]*?)\n\s*\},/)?.[1] ?? "";
    expect(detailListWrap).not.toContain("fontFamily");
  });
});
