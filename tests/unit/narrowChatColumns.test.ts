import { readFileSync } from "node:fs";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(`src/components/dashboard/${name}`, "utf8");
const css = postcss.parse(read("DashboardA.css"));
const narrow = css.nodes.find(node => node.type === "atrule" && node.name === "container"
  && node.params === "dashboard-chat (max-width: 179px)");
const rules = () => {
  expect(narrow, "the content-box override must stop at 179px, leaving outer widths above 180px unchanged").toBeDefined();
  return (narrow as postcss.AtRule).nodes.filter((node): node is postcss.Rule => node.type === "rule");
};
const declarations = (rule: postcss.Rule) => Object.fromEntries(rule.nodes
  .filter((node): node is postcss.Declaration => node.type === "decl")
  .map(node => [node.prop, node.value]));

describe("N19 narrow conversation columns", () => {
  it("uses a column container without changing the number or width of columns", () => {
    rules();
    expect(read("DashboardChatSurface.css")).toContain("container: dashboard-chat / inline-size");
    (narrow as postcss.AtRule).walkDecls(declaration => {
      expect(["flex-basis", "min-width", "font-size", "width"]).not.toContain(declaration.prop);
    });
  });
  it("accounts for the non-last column border at the external 180px boundary", () => {
    expect(read("DashboardA.css")).toContain("non-last column a 1px right border: 179px inside means 180px outside");
    expect(read("DashboardView.css")).toMatch(/border-right: 1px/);
    expect(read("DashboardView.css")).toMatch(/last-child[^}]*border-right: 0/);
    const cutoff = Number((narrow as postcss.AtRule).params.match(/max-width: ([\d.]+)px/)![1]);
    expect([180, 180.5, 181, 182].map(width => width - 1 <= cutoff)).toEqual([true, false, false, false]);
  });
  it("gives both live and archive transcripts token-based 8px side padding", () => {
    const rule = rules().find(rule => rule.selector.includes(".cmux-archive-log"))!;
    expect(rule.selector).toContain(".cmux-dashboard-chat-column .cmux-dashboard-chat");
    expect(declarations(rule)["padding-inline"]).toBe("var(--cmux-space-4)");
  });
  it("reserves only the right scrollbar gutter in narrow transcripts", () => {
    const rule = rules().find(rule => rule.selector.includes(".cmux-archive-log"))!;
    expect(declarations(rule)["scrollbar-gutter"]).toBe("stable");
    expect(read("DashboardChatSurface.css")).toContain("scrollbar-gutter: stable both-edges");
  });
  it("reduces ordinary and nested list indentation while preserving checklists", () => {
    const rule = rules().find(rule => rule.selector.includes(".cmux-dashboard-markdown-list"))!;
    expect(rule.selector).toContain(":not(.is-checklist)");
    expect(declarations(rule)).toEqual({ "padding-left": "1.25em", "padding-inline-start": "1.25em" });
    expect(read("DashboardChatSurface.css")).toContain(".cmux-dashboard-markdown-list.is-checklist { padding-inline-start: 0; }");
  });
  it("retains wide reading insets and the effective 1.5em list indentation", () => {
    rules();
    const wide = css.nodes.filter((node): node is postcss.Rule => node.type === "rule")
      .find(rule => rule.selector.includes(".cmux-archive-log"))!;
    expect(declarations(wide)["padding-inline"]).toBe("var(--cmux-dashboard-reading-inset)");
    expect(read("DashboardChatSurface.css")).toMatch(/\.cmux-dashboard-view \.cmux-dashboard-markdown-list\s*\{\s*padding-left: 1\.5em;\s*padding-inline-start: 1\.5em;/);
  });
});
