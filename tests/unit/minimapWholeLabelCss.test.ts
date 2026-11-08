import { readFileSync } from "node:fs";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const css = postcss.parse(readFileSync("src/components/dashboard/MinimapPanel.css", "utf8"));
function declarations(selector: string) {
  const matches: postcss.Rule[] = [];
  css.walkRules(rule => { if (rule.selectors.includes(selector)) matches.push(rule); });
  expect(matches, selector).toHaveLength(1);
  return Object.fromEntries(matches[0].nodes.filter((node): node is postcss.Declaration => node.type === "decl").map(node => [node.prop, node.value]));
}

describe("minimap whole-label CSS contracts", () => {
  it("uses the measured second-line boundary and final complete glyph for the mask", () => {
    const rule = declarations(".cmux-minimap-map.is-expanded .cmux-minimap-chip.is-label-truncated .cmux-minimap-label");
    expect(rule["clip-path"]).toBe("polygon(0 0, 100% 0, 100% var(--minimap-label-line2-top, calc(100% - 1.35em)), var(--minimap-label-cut, calc(100% - 1em)) var(--minimap-label-line2-top, calc(100% - 1.35em)), var(--minimap-label-cut, calc(100% - 1em)) 100%, 0 100%)");
  });
  it("places the ellipsis at the measured left and top coordinates", () => {
    expect(declarations(".cmux-minimap-map.is-expanded .cmux-minimap-chip.is-label-truncated::after")).toMatchObject({
      position: "absolute", left: "var(--minimap-label-ellipsis-left, auto)", top: "var(--minimap-label-ellipsis-top, auto)",
      width: "1em", content: '"\\2026"', "line-height": "1.35", "pointer-events": "none",
    });
  });
  it.each([".cmux-minimap-age.is-age-hidden", ".cmux-minimap-ctx.is-ctx-hidden"])("keeps %s measurable but invisible and out of flow", selector => {
    expect(declarations(selector)).toMatchObject({ position: "absolute", visibility: "hidden", "pointer-events": "none" });
  });
  it("hides complete status text while keeping its width in flow", () => {
    expect(declarations(".cmux-minimap-chip.is-status-text-hidden .cmux-dashboard-status-text")).toEqual({ visibility: "hidden", "pointer-events": "none" });
  });
  it.each([
    ".cmux-minimap-chip:has(.cmux-minimap-age.is-age-hidden) .cmux-dashboard-status-mark.is-noUpdate:not(.cmux-dashboard-sr-only)::before",
    ".cmux-minimap-chip.is-status-text-hidden:not(:has(.cmux-minimap-age)) .cmux-dashboard-status-mark.is-noUpdate:not(.cmux-dashboard-sr-only)::before",
  ])("retains the complete 12px no-update ring shape and measured offset for %s", selector => {
    expect(declarations(selector)).toMatchObject({
      content: '""', position: "relative", left: "var(--minimap-status-offset, 0px)", "box-sizing": "border-box",
      width: "var(--cmux-dash-icon-md)", height: "var(--cmux-dash-icon-md)", flex: "0 0 auto",
      border: "1.75px solid currentColor", "border-radius": "50%",
    });
  });
  it("shifts every status SVG through the same stable padding offset", () => {
    expect(declarations(".cmux-minimap-chip .cmux-dashboard-status-mark svg")).toEqual({ position: "relative", left: "var(--minimap-status-offset, 0px)" });
  });
  it("preserves the metadata row height when elapsed text is hidden", () => {
    expect(declarations(".cmux-minimap-meta:has(.cmux-minimap-age.is-age-hidden)")).toEqual({ "min-height": "var(--cmux-font-size-xs)" });
  });
  it.each([".cmux-minimap-chip .cmux-dashboard-status-text", ".cmux-minimap-age"])("keeps %s on one line", selector => {
    const rules: postcss.Rule[] = [];
    css.walkRules(rule => { if (rule.selector === selector && rule.nodes.some(node => node.type === "decl" && node.prop === "white-space")) rules.push(rule); });
    expect(rules).toHaveLength(1);
    expect(rules[0].nodes.some(node => node.type === "decl" && node.prop === "white-space" && node.value === "nowrap")).toBe(true);
  });
});
