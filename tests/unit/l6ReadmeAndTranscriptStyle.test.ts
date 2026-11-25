import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEMES } from "../../src/components/theme/themeDefinitions";

describe("L6 theme documentation and transcript readability", () => {
  it("documents the actual theme count and the button that expands the picker", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("テーマ " + THEMES.length + " 本");
    expect(readme).toContain("すべてのテーマを表示（" + THEMES.length + "）");
    expect(readme).toMatch(/^テーマ \d+ 本は .*花火.*です。$/m);
  });

  it("does not dim the closed tool row or its summary text", () => {
    const css = readFileSync("src/components/terminal/AgentTabConversation.css", "utf8");
    const summary = css.match(/\.terminal-transcript-panel--tab \.cmux-dashboard-toolfold summary \{([^}]+)\}/)?.[1];
    const row = css.match(/\.terminal-transcript-panel--tab \.cmux-dashboard-toolfold \{([^}]+)\}/)?.[1];
    expect(row).toBeDefined();
    expect(row).not.toMatch(/\bopacity\s*:/);
    expect(summary).toContain("color: var(--cmux-text)");
  });
});
