import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import postcss from "postcss";

const surface = readFileSync(new URL("../../src/components/dashboard/DashboardChatSurface.css", import.meta.url), "utf8");

describe("dashboard chat surface boundary", () => {
  it("scopes every visual rule to the dashboard", () => {
    const selectors: string[] = [];
    postcss.parse(surface).walkRules((rule) => { selectors.push(...rule.selectors); });
    expect(selectors.length).toBeGreaterThan(20);
    expect(selectors.filter((selector) => !selector.startsWith(".cmux-dashboard-view "))).toEqual([]);
  });

  it("keeps archive positioning immediate and disables replayed message entrances", () => {
    expect(surface).not.toMatch(/scroll-behavior\s*:\s*smooth/);
    const message = postcss.parse(surface).nodes.find((node) => node.type === "rule" && node.selector === ".cmux-dashboard-view .cmux-dashboard-msg");
    expect(message?.toString()).toContain("animation: none");
    expect(surface).toContain("prefers-reduced-motion: reduce");
  });
});
