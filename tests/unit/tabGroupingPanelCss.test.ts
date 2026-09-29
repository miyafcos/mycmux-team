import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio, mixHex } from "../../src/components/theme/colorContrast";
import { THEMES } from "../../src/components/theme/themeDefinitions";
import { WORKSPACE_COLORS } from "../../src/lib/workspaceColors";
import { resolveSurfaceLadder } from "../../src/lib/theme/resolveTheme";

const css = readFileSync("src/components/layout/TabGroupingPanel.css", "utf8");

describe("TabGroupingPanel CSS contract", () => {
  it("uses semantic colour tokens only", () => {
    expect(css.match(/#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(/g) ?? []).toHaveLength(0);
  });

  it("keeps every raw font size at or above 11px", () => {
    const rawSizes = [...css.matchAll(/font-size:\s*(\d+)px/g)].map((match) => Number(match[1]));
    expect(rawSizes.every((size) => size >= 11)).toBe(true);
  });

  it("keeps reduced motion scoped to the panel", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(".cmux-tab-grouping *");
  });

  it("scopes every animation rule to the panel and defines the two live motions", () => {
    expect(css).toContain("@keyframes cmux-tab-grouping-breathe");
    expect(css).toContain("@keyframes cmux-tab-grouping-flow");
    const animationSelectors = [...css.matchAll(/([^{}]+)\{[^{}]*animation\s*:/g)]
      .map((match) => match[1].trim());
    expect(animationSelectors.length).toBeGreaterThan(0);
    expect(animationSelectors.every((selector) => selector.includes(".cmux-tab-grouping"))).toBe(true);
  });

  it("does not branch on theme selectors", () => {
    expect(css).not.toContain("@media (prefers-color-scheme");
    expect(css).not.toContain("[data-theme");
  });

  it("defines the side-by-side move-line contract", () => {
    for (const selector of [
      ".cmux-tab-grouping-sidebyside",
      ".cmux-tab-grouping-sidebyside.is-stacked",
      ".cmux-tab-grouping-lines",
      ".cmux-tab-grouping-line",
      ".cmux-tab-grouping-line.is-focused",
      ".cmux-tab-grouping-line.is-dimmed",
      ".cmux-tab-grouping-chip.is-line-focused",
      ".cmux-tab-grouping-workspace-color",
      ".cmux-tab-grouping-workspace-head[tabindex]:focus-visible",
      ".cmux-tab-grouping .cmux-tab-grouping-live",
      ".cmux-tab-grouping .cmux-tab-grouping-leadin",
      ".cmux-tab-grouping .cmux-tab-grouping-lineage",
    ]) {
      expect(css).toContain(selector);
    }
    expect(css).not.toContain("@media (max-width");
    expect(css).toMatch(/\.cmux-tab-grouping-lines\s*\{[^}]*pointer-events:\s*none/s);
    expect(css).toMatch(/\.cmux-tab-grouping-line\s*\{[^}]*fill:\s*none/s);
    expect(css).toMatch(/\.cmux-tab-grouping-workspace-color\s*\{[^}]*width:\s*11px[^}]*height:\s*11px/s);
  });

  it("defines pinned lines, halo, move context, and badges without focus-time reflow", () => {
    for (const selector of [
      ".cmux-tab-grouping-line-halo",
      ".cmux-tab-grouping-line.is-pinned",
      ".cmux-tab-grouping-chip.is-line-pinned",
      ".cmux-tab-grouping-movectx",
      ".cmux-tab-grouping-movebadge",
    ]) {
      expect(css).toContain(selector);
    }
    expect(css).toMatch(/\.cmux-tab-grouping-line-halo\s*\{[^}]*stroke:\s*var\(--cmux-popover\)/s);
    expect(css).toMatch(/\.cmux-tab-grouping-movectx\s*\{[^}]*opacity:\s*0[^}]*visibility:\s*hidden/s);
    expect(css).toMatch(/\.cmux-tab-grouping-chip\.is-line-pinned \.cmux-tab-grouping-movectx\s*\{[^}]*opacity:\s*1[^}]*visibility:\s*visible/s);
    const moveContextBlock = css.match(/\.cmux-tab-grouping-movectx\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(moveContextBlock).not.toMatch(/display:\s*none/);

    const reflowProperties = /(?:^|;)\s*(?:display|flex|grid|padding|margin|border-width|font-size|width|height|gap)\s*:/m;
    const focusRules = [...css.matchAll(/([^{}]*(?:is-focused|is-pinned|is-line-focused|is-line-pinned|:hover)[^{}]*)\{([^{}]*)\}/g)];
    expect(focusRules.length).toBeGreaterThan(0);
    for (const [selector, , body] of focusRules) {
      expect(body, selector.trim()).not.toMatch(reflowProperties);
    }

    const dashRules = [...css.matchAll(/([^{}]+)\{[^{}]*stroke-dasharray\s*:/g)].map((match) => match[1].trim());
    expect(dashRules).toHaveLength(1);
    expect(dashRules[0]).toContain(".is-live");
  });

  it("keeps every workspace line at 3:1 against every current popover", () => {
    const paintedColor = "color-mix(in srgb, var(--grouping-line-color) 75%, var(--cmux-text))";
    const lineBlock = css.match(/\.cmux-tab-grouping-line\s*\{([^}]*)\}/s)?.[1] ?? "";
    const leadInBlock = css.match(/\.cmux-tab-grouping \.cmux-tab-grouping-leadin\s*\{([^}]*)\}/s)?.[1] ?? "";
    const markerBlock = css.match(/\.cmux-tab-grouping-line-start,\s*\.cmux-tab-grouping-line-arrow\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(lineBlock).toContain(`stroke: ${paintedColor}`);
    expect(lineBlock).toMatch(/opacity:\s*1/);
    expect(leadInBlock).toContain(`stroke: ${paintedColor}`);
    expect(leadInBlock).toMatch(/opacity:\s*1/);
    expect(markerBlock).toContain(`fill: ${paintedColor}`);
    for (const theme of THEMES) {
      const resolvedPopover = resolveSurfaceLadder(theme).popover;
      const popover = resolvedPopover.startsWith("#")
        ? resolvedPopover
        : mixHex(theme.chrome.surface, "#ffffff", 0.07);
      for (const option of WORKSPACE_COLORS) {
        const painted = mixHex(option.value, theme.chrome.text, 0.25);
        expect(
          contrastRatio(painted, popover),
          `${theme.id}:${option.id}:${painted}/${popover}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("defines the editable-map interaction and fixed-age contracts", () => {
    for (const selector of [
      ".cmux-tab-grouping-editmap",
      ".cmux-tab-grouping-editsummary",
      ".cmux-tab-grouping-tray",
      ".cmux-tab-grouping-choice",
      ".cmux-tab-grouping-choice-item.is-active",
      ".cmux-tab-grouping-state",
      ".cmux-tab-grouping-pane.is-droppable",
      ".cmux-tab-grouping-popover.is-below",
      "button.cmux-tab-grouping-chip",
    ]) {
      expect(css).toContain(selector);
    }
    expect(css).toMatch(/\.cmux-tab-grouping-button\s*\{[^}]*min-height:\s*28px/s);
    expect(css).toMatch(/\.cmux-tab-grouping-choice-item\s*\{[^}]*min-width:\s*72px[^}]*min-height:\s*28px/s);
    const genericChip = css.match(/\.cmux-tab-grouping-chip\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(genericChip).not.toContain("cursor: pointer");
    expect(css).toMatch(/button\.cmux-tab-grouping-chip\s*\{[^}]*cursor:\s*grab/s);
    expect(css).toMatch(/\.cmux-tab-grouping-popover\s*\{[^}]*max-height:\s*min\(320px,\s*40vh\)[^}]*overflow:\s*auto/s);
    expect(css).toMatch(/\.cmux-tab-grouping \.cmux-tab-grouping-live-age\s*\{[^}]*flex:\s*0 0 5em[^}]*inline-size:\s*5em[^}]*font-variant-numeric:\s*tabular-nums/s);
    expect(css).toMatch(/\.cmux-tab-grouping-body\.is-edit\s*>\s*\.cmux-tab-grouping-col:last-child\s*\{[^}]*display:\s*grid[^}]*grid-template-rows:\s*auto auto minmax\(0,\s*1fr\) auto[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.cmux-tab-grouping-body\.is-edit\s*>\s*\.cmux-tab-grouping-col:last-child\s*>\s*\.cmux-tab-grouping-editmap\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*auto/s);
    expect(css).toMatch(/\.cmux-tab-grouping-body\.is-edit\s*>\s*\.cmux-tab-grouping-col:last-child\s*>\s*\.cmux-tab-grouping-selectbar\s*\{[^}]*position:\s*relative[^}]*bottom:\s*auto/s);
  });

  it("defines pointer-drag affordances without changing drop geometry", () => {
    for (const selector of [
      ".cmux-tab-grouping-chip.is-dragging",
      ".cmux-tab-grouping-grip",
      ".cmux-tab-grouping-pane.is-droppable.is-drop-active",
      ".cmux-tab-grouping-tray.is-drop-active",
      ".cmux-tab-grouping-empty-group-drop",
      ".cmux-tab-grouping-empty-group-drop.is-drop-active",
      ".cmux-tab-grouping-ghost",
      ".cmux-tab-grouping-ghost-label",
      ".cmux-tab-grouping-ghost-count",
      ".cmux-tab-grouping-announcer",
    ]) {
      expect(css).toContain(selector);
    }
    expect(css).toMatch(/\.cmux-tab-grouping-empty-group-drop\s*\{[^}]*border:\s*1px dashed var\(--cmux-border\)/s);
    expect(css).toMatch(/\.cmux-tab-grouping-ghost\s*\{[^}]*position:\s*fixed[^}]*pointer-events:\s*none/s);
    const draggingBlock = css.match(/\.cmux-tab-grouping-chip\.is-dragging\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(draggingBlock).toMatch(/cursor:\s*grabbing/);
    expect(draggingBlock).toMatch(/touch-action:\s*none/);
    expect(draggingBlock).toMatch(/user-select:\s*none/);
    expect(draggingBlock).not.toMatch(/(?:^|;)\s*(?:display|width|height|min-width|min-height|max-width|max-height|padding|margin|border(?:-[\w-]+)?|position|inset|flex(?:-[\w-]+)?)\s*:/);
    const restrictedBlocks = [...css.matchAll(/([^{}]+)\{([^{}]*(?:touch-action|user-select)[^{}]*)\}/g)];
    expect(restrictedBlocks.length).toBeGreaterThan(0);
    expect(restrictedBlocks.every((match) => match[1].includes(".cmux-tab-grouping-chip.is-dragging"))).toBe(true);
    const activeBlocks = [...css.matchAll(/([^{}]*\.is-drop-active[^{}]*)\{([^{}]*)\}/g)];
    expect(activeBlocks.length).toBeGreaterThan(0);
    for (const [, , body] of activeBlocks) {
      expect(body).not.toMatch(/(?:^|;)\s*(?:border|border-(?:width|style)|padding|margin)\s*:/);
    }
  });

  it("shields the panel body with exactly the drag-active pointer-event contract", () => {
    expect(css.match(/@media\b/g) ?? []).toHaveLength(1);
    expect(css).toMatch(/\.cmux-tab-grouping\.is-drag-active \.cmux-tab-grouping-body\s*\{[^}]*pointer-events:\s*none[^}]*\}/s);
    expect(css).toMatch(/\.cmux-tab-grouping\.is-drag-active \[data-drop-id\]\s*\{[^}]*pointer-events:\s*auto[^}]*\}/s);
    const activeBlocks = [...css.matchAll(/([^{}]*is-drag-active[^{}]*)\{([^{}]*)\}/g)];
    expect(activeBlocks).toHaveLength(2);
    for (const [, , body] of activeBlocks) {
      expect(body).not.toMatch(/(?:^|;)\s*(?:display|visibility|width|height|margin|padding|border(?:-[\w-]+)?)\s*:/);
    }
  });
});
