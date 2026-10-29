import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import postcss from "postcss";

const surface = readFileSync(new URL("../../src/components/dashboard/DashboardChatSurface.css", import.meta.url), "utf8");

describe("dashboard chat surface boundary", () => {
  it("P-8 redeclares only theme-derived aliases on the dashboard root", () => {
    const root = postcss.parse(surface).nodes.find(node => node.type === "rule" && node.selector === ".cmux-dashboard-view");
    expect(root?.type).toBe("rule");
    if(root?.type !== "rule") return;
    expect(root.nodes.filter(node => node.type === "decl").map(node => node.type === "decl" ? node.prop : "")).toEqual([
      "--cmux-chat-meta-size", "--cmux-chat-code-size", "--cmux-chat-lane", "--cmux-chat-column-color",
    ]);
    expect(surface).toContain("calc(42 * var(--cmux-read-font-size))");
    expect(surface).not.toContain("--cmux-chat-space-9");
    const globals = readFileSync("src/global.css", "utf8");
    expect(globals).toContain("--cmux-chat-tool-indent: 18px");
    expect(globals).toContain("--cmux-chat-status-height: 18px");
  });

  it("scopes every visual rule to the dashboard", () => {
    const selectors: string[] = [];
    postcss.parse(surface).walkRules((rule) => { selectors.push(...rule.selectors); });
    expect(selectors.length).toBeGreaterThan(20);
    expect(selectors.filter((selector) => selector !== ".cmux-dashboard-view" && !selector.startsWith(".cmux-dashboard-view "))).toEqual([]);
  });

  it("keeps archive positioning immediate and disables replayed message entrances", () => {
    expect(surface).not.toMatch(/scroll-behavior\s*:\s*smooth/);
    const message = postcss.parse(surface).nodes.find((node) => node.type === "rule" && node.selector === ".cmux-dashboard-view .cmux-dashboard-msg");
    expect(message?.toString()).toContain("animation: none");
    expect(surface).toContain("prefers-reduced-motion: reduce");
  });

  it("keeps the local typography and geometry tokens free of self references", () => {
    postcss.parse(surface).walkDecls((declaration) => {
      if (!declaration.prop.startsWith("--")) return;
      expect(declaration.value, declaration.prop).not.toMatch(new RegExp(`var\\(\\s*${declaration.prop}\\s*[,)]`));
    });
  });
});
