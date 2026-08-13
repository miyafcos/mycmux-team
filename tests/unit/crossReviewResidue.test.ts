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
    expect(source("src/components/layout/NotificationPanel.tsx")).not.toContain("workDoneCount");
  });

  it("removes obsolete workspace metadata and agent-dot selectors", () => {
    expect(source("src/components/layout/TabBar.tsx")).not.toContain("metadataBySession");
    const css = source("src/global.css");
    expect(css).not.toContain(".workspace-agent-kind-dots");
    expect(css).not.toContain(".workspace-agent-kind-dot");
  });
});
