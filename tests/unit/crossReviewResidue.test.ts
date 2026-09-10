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

  it("removes obsolete workspace metadata and agent-dot selectors", () => {
    // CR-RESIDUE-02 was a session-metadata map the sidebar built and never
    // read. The sidebar reads one now, to name a tab the way its own pane tab
    // bar does, so the guard is that the map has a consumer rather than that
    // the name is absent.
    const tabBar = source("src/components/layout/TabBar.tsx");
    if (tabBar.includes("metadataBySession")) {
      expect(tabBar).toContain("getTabDisplayLabel(tab, isTabActive, metadataBySession");
    }
    const css = source("src/global.css");
    expect(css).not.toContain(".workspace-agent-kind-dots");
    expect(css).not.toContain(".workspace-agent-kind-dot");
  });
});
