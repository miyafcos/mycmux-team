import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const globalCss = read("src/global.css");
const appShell = read("src/components/layout/AppShell.tsx");
// The chrome ladder is derived in the pure theme resolver now, not inline in
// AppShell. The contract is about the formulas, not about which file holds
// them, so the assertions read both.
const themeResolver = read("src/lib/theme/resolveTheme.ts");
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
  read("src/components/layout/TabSweepButton.tsx"),
  read("src/components/ailog/AiLogButton.tsx"),
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

  it("derives every dynamic chrome ladder token in the theme resolver", () => {
    for (const token of [
      '"--cmux-surface-raised"',
      '"--cmux-popover"',
      '"--cmux-edge-highlight"',
      '"--cmux-border-hairline"',
    ]) {
      expect(themeResolver).toContain(token);
    }
    expect(themeResolver).toContain("isLightChrome");
    // Dark keeps the two lighten-toward-white steps it has always had.
    expect(themeResolver).toContain("${paper} 96%, white");
    expect(themeResolver).toContain("${paper} 93%, white");
    // Light no longer darkens as it rises: stage 2 puts raised and popover
    // on the paper anchor and lets the hairline and shadows carry the step
    // (design memo section 3). The matching "97%, black" / "95%, black"
    // expressions are gone on purpose.
    expect(themeResolver).not.toContain("97%, black");
    expect(themeResolver).not.toContain("95%, black");
    expect(themeResolver).toContain("surfaceRaised: paper");
    expect(themeResolver).toContain("popover: paper");
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
  // Stage 2 splits this by scheme. Dark keeps the translucent raised surface
  // verbatim; light makes raised opaque on purpose (the memo puts the pane
  // tab strip on surface-low via --pane-tabbar-bg instead, so nothing turns
  // into a solid slab over the wallpaper).
  it("keeps the raised surface translucent under a media background on dark", () => {
    expect(themeResolver).toContain("const surfaceRaised = withPanelOpacity(surfaces.surfaceRaised);");
    expect(themeResolver).toContain("const withPanelOpacity = (color: string) =>");
    expect(themeResolver).toContain("panelOpacity >= 0.995");
    expect(themeResolver).toContain("%, transparent)`");
    expect(themeResolver).toContain("paneTabBarBg: colorWithOpacity(surfaces.surfaceLow, chromeAlpha)");
  });

  it("elevates the all-tabs dropdown above the pane borders it overlaps", () => {
    expect(paneTabBar).toContain('boxShadow: "var(--cmux-shadow-dropdown)"');
    expect(paneTabBar).toContain('className="cmux-popover-panel pane-tab-menu"');
    expect(globalCss).toContain(".pane-tab-menu {");
    expect(globalCss).toContain("scrollbar-width: thin;");
    expect(globalCss).toContain(".pane-tab-menu-row:hover,");
  });

  it("uses monochrome SVG chrome icons instead of emoji glyphs", () => {
    expect(boundarySource).not.toMatch(/[\u270f\u2610\u{1f4c4}\u{1f9f9}\u{1f4ca}]/u);

    for (const icon of ["PencilIcon", "TaskIcon", "DocumentIcon", "SweepIcon", "AiLogIcon"]) {
      expect(chromeIcons).toMatch(new RegExp(`export function ${icon}`));
    }
    expect(crsmPalette).toContain("<PencilIcon");
    expect(crsmPalette).toContain("<TaskIcon");
    expect(crsmPalette).toContain("<DocumentIcon");
    expect(read("src/components/layout/TabSweepButton.tsx")).toContain("<SweepIcon");
    expect(read("src/components/ailog/AiLogButton.tsx")).toContain("<AiLogIcon");
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

  // Chrome font floor: text that can carry Japanese must sit on
  // --cmux-font-size-xs (11px) because Windows Japanese glyphs fall apart
  // below it. Tags and badges whose content is only Latin letters, digits, or
  // symbols (agent kind pills, kbd chips, "Aa" theme swatches, counters) may
  // stay at 10. A bare 9 is banned outright, in either the numeric or the
  // "9px" string form.
  it("keeps every swept chrome surface at or above the 10px floor", () => {
    const sweptFiles = [
      "src/global.css",
      "src/components/CommandPalette/CrsmPalette.tsx",
      "src/components/CommandPalette/CrsmPalette.css",
      "src/components/layout/NotificationPanel.tsx",
      "src/components/layout/TabItem.tsx",
      "src/components/layout/TabSweepPanel.tsx",
      "src/components/online/OnlinePanel.tsx",
      "src/components/settings/CliAccountsPanel.tsx",
      "src/components/setup/GridPreview.tsx",
      "src/components/theme/ThemeBackgroundPanel.tsx",
      "src/components/theme/ThemeTweakPanel.tsx",
      "src/components/theme/ThemePicker.tsx",
      "src/components/theme/BackgroundPresetSegment.tsx",
      "src/components/theme/ThemeFontSettings.tsx",
      "src/components/workspace/ArtifactEditorToolbar.tsx",
      "src/components/workspace/PaneTabBar.tsx",
      "src/components/ailog/ui.tsx",
      "src/components/ailog/RangeBar.tsx",
      "src/components/ailog/SessionDetailView.tsx",
      "src/components/ailog/SessionTable.tsx",
      "src/components/ailog/SummaryCards.tsx",
      "src/components/dashboard/DashboardCardRow.tsx",
      "src/components/dashboard/MinimapPanel.css",
      "src/components/dashboard/DashboardSessionList.tsx",
      "src/components/dashboard/DashboardSessionDetail.tsx",
      "src/components/dashboard/DashboardTerminalTab.tsx",
      "src/components/dashboard/DashboardView.tsx",
      "src/components/dashboard/QuestionCard.tsx",
      "src/components/dashboard/ReplyComposer.tsx",
    ];

    for (const path of sweptFiles) {
      const source = read(path);
      expect(source, path).not.toMatch(/fontSize:\s*"?9"?/);
      expect(source, path).not.toMatch(/font-size:\s*9px/);
    }
  });

  // The panels below render dynamic Japanese (workspace names, sweep verdicts,
  // account status), so they must reach for the token instead of a raw number.
  it("puts the Japanese-bearing panels on the xs typography token", () => {
    for (const path of [
      "src/components/layout/TabSweepPanel.tsx",
      "src/components/settings/CliAccountsPanel.tsx",
      "src/components/workspace/PaneTabBar.tsx",
    ]) {
      expect(read(path), path).toContain('fontSize: "var(--cmux-font-size-xs)"');
    }
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
