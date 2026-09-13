import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)), "utf8");
}

describe("cross-review residue removal", () => {
  it("keeps work completion out of notification UI", () => {
    expect(source("src/components/workspace/TerminalPane.tsx"))
      .not.toMatch(/const notificationCount[\s\S]*?workDoneCount/);
  });

  it("keeps the sidebar's session-metadata map wired to the shared tab label", () => {
    // CR-RESIDUE-02 was a session-metadata map the sidebar built and never
    // read. The sidebar reads one now, to name a tab the way its own pane tab
    // bar does, so the guard is that the map has a consumer rather than that
    // the name is absent. (The agent-dot selector guard was dropped on
    // 2026-09-13: the selectors are gone from the whole repository.)
    const tabBar = source("src/components/layout/TabBar.tsx");
    if (tabBar.includes("metadataBySession")) {
      expect(tabBar).toContain("getTabDisplayLabel(tab, isTabActive, metadataBySession");
    }
  });
});
