import { describe, expect, it } from "vitest";
import { collectStartupSessionIds } from "../../src/lib/startupSessionGate";
import type { Workspace } from "../../src/types";

function workspace(
  id: string,
  paneTabs: Array<{ activeTabId: string; sessions: string[] }>,
): Workspace {
  return {
    id,
    name: id,
    gridTemplateId: "1x1",
    status: "running",
    createdAt: 0,
    panes: paneTabs.map(({ activeTabId, sessions }, paneIndex) => ({
      id: `${id}-pane-${paneIndex}`,
      agentId: "shell",
      sessionId: sessions[0] ?? "",
      activeTabId,
      tabs: sessions.map((sessionId, tabIndex) => ({
        id: `${id}-tab-${paneIndex}-${tabIndex}`,
        sessionId,
        agentId: "shell",
      })),
    })),
  };
}

describe("startup session gate selection", () => {
  it("gates only active tabs in the active workspace", () => {
    const inactive = workspace("inactive", [{
      activeTabId: "inactive-tab-0-0",
      sessions: ["inactive-resumable"],
    }]);
    inactive.panes[0].tabs[0].agentKind = "claude";
    inactive.panes[0].tabs[0].agentSessionId = "agent-inactive";
    const active = workspace("active", [
      { activeTabId: "active-tab-0-1", sessions: ["active-bg", "active-visible-1"] },
      { activeTabId: "active-tab-1-0", sessions: ["active-visible-2"] },
    ]);

    expect(collectStartupSessionIds([inactive, active], "active")).toEqual([
      "active-visible-1",
      "active-visible-2",
    ]);
  });

  it("falls back to the first workspace when the active id is absent or stale", () => {
    const first = workspace("first", [{
      activeTabId: "first-tab-0-0",
      sessions: ["first-visible"],
    }]);
    const second = workspace("second", [{
      activeTabId: "second-tab-0-0",
      sessions: ["second-visible"],
    }]);

    expect(collectStartupSessionIds([first, second], null)).toEqual(["first-visible"]);
    expect(collectStartupSessionIds([first, second], "deleted-workspace")).toEqual(["first-visible"]);
  });
});
