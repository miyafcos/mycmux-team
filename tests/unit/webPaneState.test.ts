// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  collectWebPaneTabs,
  webPaneBoundsForHost,
} from "../../src/components/workspace/WebPaneController";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { PaneTab, Workspace } from "../../src/types";

function terminalTab(): PaneTab {
  return {
    id: "terminal-tab",
    sessionId: "terminal-session",
    agentId: "shell-starter",
    type: "terminal",
    cwd: "C:\\work",
    terminalSnapshot: ["keep me"],
  };
}

function workspaceWithTerminal(): Workspace {
  const tab = terminalTab();
  return {
    id: "workspace",
    name: "Workspace",
    gridTemplateId: "1x1",
    status: "running",
    createdAt: 1,
    panes: [{
      id: "pane",
      agentId: tab.agentId,
      sessionId: tab.sessionId,
      tabs: [tab],
      activeTabId: tab.id,
    }],
    splitColumns: [["pane"]],
  };
}

describe("web pane tab state", () => {
  beforeEach(() => {
    const workspace = workspaceWithTerminal();
    useWorkspaceListStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
  });

  it("opens and closes a web tab without changing the existing terminal tab", () => {
    const before = structuredClone(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs[0]);
    const layout = useWorkspaceLayoutStore.getState();

    layout.addWebTabToPane("workspace", "pane", { presetId: "chatgpt", label: "ChatGPT" });
    const openedPane = useWorkspaceListStore.getState().workspaces[0].panes[0];
    const web = openedPane.tabs.find((tab) => tab.type === "web");
    expect(web).toMatchObject({ agentId: "web", type: "web", presetId: "chatgpt", label: "ChatGPT" });
    expect(openedPane.tabs[0]).toEqual(before);
    expect(collectWebPaneTabs(useWorkspaceListStore.getState().workspaces)).toEqual([
      { tabId: web!.id, presetId: "chatgpt" },
    ]);

    layout.removeTabFromPane("workspace", "pane", web!.id);
    const closedPane = useWorkspaceListStore.getState().workspaces[0].panes[0];
    expect(closedPane.tabs).toEqual([before]);
    expect(closedPane.activeTabId).toBe(before.id);
    expect(collectWebPaneTabs(useWorkspaceListStore.getState().workspaces)).toEqual([]);
  });

  it("uses logical DOM bounds and hides zero-sized hosts", () => {
    const host = document.createElement("div");
    host.getBoundingClientRect = () => ({
      x: 10,
      y: 20,
      width: 800,
      height: 600,
      top: 20,
      right: 810,
      bottom: 620,
      left: 10,
      toJSON: () => ({}),
    });
    expect(webPaneBoundsForHost(host)).toEqual({ x: 10, y: 20, width: 800, height: 600 });

    host.getBoundingClientRect = () => ({
      x: 10,
      y: 20,
      width: 0,
      height: 600,
      top: 20,
      right: 10,
      bottom: 620,
      left: 10,
      toJSON: () => ({}),
    });
    expect(webPaneBoundsForHost(host)).toBeNull();
  });
});
