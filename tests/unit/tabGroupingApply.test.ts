import { describe, expect, it } from "vitest";
import type { Workspace } from "../../src/types";
import { classifyStale, type AnalysisBaselineEntry } from "../../src/components/layout/tabGrouping";

// This file now covers classifyStale only; G3-L1 removed legacy compile/commit/undo.

const NOW = 1_800_000_000_000;

function tab(id: string, workspaceHint = "a") {
  return {
    id,
    sessionId: `session-${id}`,
    agentId: "shell-starter",
    type: "terminal" as const,
    label: `ラベル${id}`,
    cwd: `C:/work/${workspaceHint}/${id}`,
  };
}

function workspace(id: string, name: string, paneId: string, tabIds: string[]): Workspace {
  const tabs = tabIds.map((tabId) => tab(tabId, id));
  return {
    id,
    name,
    gridTemplateId: "1x1",
    status: "running",
    createdAt: NOW,
    panes: [{
      id: paneId,
      agentId: "shell-starter",
      sessionId: tabs[0]?.sessionId ?? `${paneId}-empty`,
      activeTabId: tabs[0]?.id ?? "",
      tabs,
    }],
    splitColumns: [[paneId]],
  };
}

function baselineOf(workspaces: Workspace[]): AnalysisBaselineEntry[] {
  return workspaces.flatMap((item) => item.panes.flatMap((pane) => pane.tabs.map((tabItem) => ({
    tabId: tabItem.id,
    workspaceId: item.id,
    paneId: pane.id,
    sessionId: tabItem.sessionId,
  }))));
}

describe("stale classification", () => {
  it("blocks closed, session-mismatched, moved target tabs and missing destinations", () => {
    const baseline = baselineOf([workspace("ws-a", "母艦", "pane-a", ["t1", "t2"])]);
    const current = [
      workspace("ws-a", "母艦", "pane-a", ["t2"]),
      workspace("ws-b", "別机", "pane-b", ["t1"]),
    ];
    current[1].panes[0].tabs[0].sessionId = "session-t1-replaced";
    const issues = classifyStale(
      baseline,
      current,
      new Set(["t1"]),
      new Set(["missing-ws"]),
    );
    expect(issues.map((issue) => issue.code).sort()).toEqual([
      "session_mismatch",
      "tab_moved",
      "workspace_missing",
    ]);
  });

  it("skips non-target tab movement", () => {
    const before = [workspace("ws-a", "母艦", "pane-a", ["t1", "t2"])];
    const after = [
      workspace("ws-a", "母艦", "pane-a", ["t1"]),
      workspace("ws-b", "別机", "pane-b", ["t2"]),
    ];
    expect(classifyStale(baselineOf(before), after, new Set(["t1"]), new Set())).toEqual([]);
  });
});
