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
  read("src/components/layout/AccountsButton.tsx"),
  read("src/components/layout/AccountsPanel.tsx"),
  read("src/components/settings/tabs/UsageTab.tsx"),
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

  // Regression: Phase A moved the pane tab bar from --cmux-surface (which went
  // through colorWithOpacity) to --cmux-surface-raised, which was opaque. Over
  // a media background the bar rendered as a solid dark slab.
  it("keeps the raised surface translucent under a media background", () => {
    expect(appShell).toContain('"--cmux-surface-raised": withPanelOpacity(');
    expect(appShell).toContain("const withPanelOpacity = (color: string) =>");
    expect(appShell).toContain("panelOpacity >= 0.995");
    expect(appShell).toContain("%, transparent)`");
  });

  it("elevates the all-tabs dropdown above the pane borders it overlaps", () => {
    expect(paneTabBar).toContain('boxShadow: "var(--cmux-shadow-dropdown)"');
    expect(paneTabBar).toContain('className="cmux-popover-panel pane-tab-menu"');
    expect(globalCss).toContain(".pane-tab-menu {");
    expect(globalCss).toContain("scrollbar-width: thin;");
    expect(globalCss).toContain(".pane-tab-menu-row:hover,");
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

  it("keeps the account surfaces on design tokens rather than bare numbers", () => {
    const accountSources = [
      "src/components/layout/AccountsButton.tsx",
      "src/components/layout/AccountsPanel.tsx",
      "src/components/settings/tabs/UsageTab.tsx",
    ].map((path) => [path, read(path)] as const);

    for (const [path, source] of accountSources) {
      // A bare fontSize was how 10px crept in, which is unreadable on Windows.
      expect(source, path).not.toMatch(/fontSize:\s*\d/);
      expect(source, path).toContain("var(--cmux-font-size-");
      expect(source, path).toContain("var(--cmux-space-");
    }
  });
});
