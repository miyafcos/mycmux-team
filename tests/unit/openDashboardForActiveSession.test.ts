// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../src/types";

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
}

function workspaceWithTab(tabId: string, sessionId: string): Workspace {
  return {
    id: "ws-a",
    name: "Workspace A",
    gridTemplateId: "1x1",
    panes: [{
      id: "pane-a",
      agentId: "codex",
      sessionId,
      activeTabId: tabId,
      tabs: [{ id: tabId, sessionId, agentId: "codex", agentKind: "codex", label: "Target", type: "terminal" }],
    }],
    status: "running",
    createdAt: 1,
    splitColumns: [["pane-a"]],
  };
}

async function loadModules() {
  vi.resetModules();
  const [{ useDashboardViewStore }, { useUiStore }, { useWorkspaceListStore }, { openDashboardForActiveSession }] = await Promise.all([
    import("../../src/stores/dashboardViewStore"),
    import("../../src/stores/uiStore"),
    import("../../src/stores/workspaceListStore"),
    import("../../src/components/layout/openDashboardForTab"),
  ]);
  return { useDashboardViewStore, useUiStore, useWorkspaceListStore, openDashboardForActiveSession };
}

beforeEach(() => {
  window.localStorage.clear();
  setViewportWidth(1200);
});

afterEach(() => {
  window.localStorage.clear();
  vi.resetModules();
});

describe("openDashboardForActiveSession", () => {
  it("opens the matching chat column when the focused session resolves", async () => {
    const { useDashboardViewStore, useUiStore, useWorkspaceListStore, openDashboardForActiveSession } = await loadModules();
    useUiStore.setState({ activePaneId: "sess-a", lastActivePaneId: "sess-a" });
    useWorkspaceListStore.setState({
      workspaces: [workspaceWithTab("tab-a", "sess-a")],
      activeWorkspaceId: "ws-a",
    });
    useDashboardViewStore.getState().setQuery("codex");
    useDashboardViewStore.getState().setStateFilter("needsHuman");

    openDashboardForActiveSession();

    expect(useDashboardViewStore.getState()).toMatchObject({
      open: true,
      query: "",
      stateFilter: null,
      selectedTabId: "tab-a",
    });
    expect(useDashboardViewStore.getState().chatColumnTabIds).toContain("tab-a");
  });

  it("falls back to lastActivePaneId after blur", async () => {
    const { useDashboardViewStore, useUiStore, useWorkspaceListStore, openDashboardForActiveSession } = await loadModules();
    useUiStore.setState({ activePaneId: null, lastActivePaneId: "sess-b" });
    useWorkspaceListStore.setState({
      workspaces: [workspaceWithTab("tab-b", "sess-b")],
      activeWorkspaceId: "ws-a",
    });

    openDashboardForActiveSession();

    expect(useDashboardViewStore.getState()).toMatchObject({
      open: true,
      selectedTabId: "tab-b",
    });
    expect(useDashboardViewStore.getState().chatColumnTabIds).toContain("tab-b");
  });

  it("falls back to a plain openView when the session cannot be resolved", async () => {
    const { useDashboardViewStore, useUiStore, useWorkspaceListStore, openDashboardForActiveSession } = await loadModules();
    useUiStore.setState({ activePaneId: "sess-missing", lastActivePaneId: "sess-missing" });
    useWorkspaceListStore.setState({
      workspaces: [workspaceWithTab("tab-other", "sess-other")],
      activeWorkspaceId: "ws-a",
    });
    useDashboardViewStore.getState().setQuery("keep-me");
    useDashboardViewStore.getState().setSelectedTabId("tab-prior");

    openDashboardForActiveSession();

    expect(useDashboardViewStore.getState()).toMatchObject({
      open: true,
      query: "keep-me",
      selectedTabId: "tab-prior",
    });
    expect(useDashboardViewStore.getState().chatColumnTabIds).not.toContain("tab-missing");
  });

  it("falls back to a plain openView when no session is focused", async () => {
    const { useDashboardViewStore, useUiStore, useWorkspaceListStore, openDashboardForActiveSession } = await loadModules();
    useUiStore.setState({ activePaneId: null, lastActivePaneId: null });
    useWorkspaceListStore.setState({
      workspaces: [workspaceWithTab("tab-a", "sess-a")],
      activeWorkspaceId: "ws-a",
    });
    useDashboardViewStore.getState().setQuery("keep-me");

    openDashboardForActiveSession();

    expect(useDashboardViewStore.getState()).toMatchObject({
      open: true,
      query: "keep-me",
    });
    expect(useDashboardViewStore.getState().chatColumnTabIds).not.toContain("tab-a");
  });
});
