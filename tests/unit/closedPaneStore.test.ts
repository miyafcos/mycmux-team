import { beforeEach, describe, expect, it } from "vitest";
import {
  CLOSED_WORKSPACE_BULK_LIMIT,
  peekClosedPane,
  popClosedPane,
  pushClosedPane,
  pushClosedTab,
  pushClosedWorkspace,
  selectClosedWorkspaceTabs,
} from "../../src/stores/closedPaneStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Pane, PaneTab, Workspace } from "../../src/types";

function drainClosedPanes(): void {
  while (popClosedPane()) {
    // Drain the module-level bounded history between tests.
  }
}

function makeTab(overrides: Partial<PaneTab> = {}): PaneTab {
  return {
    id: "tab-active",
    sessionId: "session-active",
    agentId: "shell-starter",
    type: "terminal",
    ...overrides,
  };
}

function makePane(tabs: PaneTab[], overrides: Partial<Pane> = {}): Pane {
  return {
    id: "pane-1",
    agentId: "shell-starter",
    sessionId: tabs[0]?.sessionId ?? "",
    tabs,
    activeTabId: tabs[0]?.id ?? "",
    ...overrides,
  };
}

function makeWorkspace(panes: Pane[], overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "workspace-1",
    name: "Workspace 1",
    gridTemplateId: "1x1",
    panes,
    status: "running",
    createdAt: 1,
    ...overrides,
  };
}

/** Pane whose tabs are `${paneId}-tab-N`, each with its own session id. */
function makePaneWithTabs(paneId: string, tabCount: number, activeIndex = 0): Pane {
  const tabs = Array.from({ length: tabCount }, (_, index) =>
    makeTab({ id: `${paneId}-tab-${index}`, sessionId: `${paneId}-session-${index}` }),
  );
  return makePane(tabs, { id: paneId, activeTabId: tabs[activeIndex].id, sessionId: tabs[activeIndex].sessionId });
}

beforeEach(() => {
  drainClosedPanes();
  usePaneMetadataStore.setState({ metadata: {}, lastLog: {} });
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
});

describe("closed tab restore identity", () => {
  it("stores the closed tab's live Codex identity for Ctrl+Shift+T resume", () => {
    const tab = makeTab();
    const pane = makePane([tab]);
    usePaneMetadataStore.getState().setMetadata(tab.sessionId, {
      agentKind: "codex",
      agentSessionId: "codex-session",
      cwd: "C:\\work\\project",
    });

    pushClosedTab(pane, tab);

    expect(popClosedPane()).toEqual({
      cwd: "C:\\work\\project",
      label: null,
      agentKind: "codex",
      agentSessionId: "codex-session",
    });
  });

  it("uses saved tab identity when live metadata is unavailable", () => {
    const tab = makeTab({ agentKind: "claude-codex", agentSessionId: "hybrid-session" });
    pushClosedTab(makePane([tab]), tab);
    expect(popClosedPane()).toMatchObject({
      agentKind: "claude-codex",
      agentSessionId: "hybrid-session",
    });
  });

  it("maps a legacy Claude session id only to Claude", () => {
    const tab = makeTab({ claudeSessionId: "claude-session" });
    pushClosedTab(makePane([tab]), tab);
    expect(popClosedPane()).toMatchObject({
      agentKind: "claude",
      agentSessionId: "claude-session",
    });
  });

  it("does not copy the active pane identity into a different closed tab", () => {
    const active = makeTab({ agentKind: "claude", agentSessionId: "active-session" });
    const background = makeTab({ id: "tab-background", sessionId: "session-background" });
    const pane = makePane([active, background], {
      agentKind: "claude",
      agentSessionId: "active-session",
    });

    pushClosedTab(pane, background);

    expect(popClosedPane()).toMatchObject({ agentKind: null, agentSessionId: null });
  });

  it("uses the same resolver when an active pane is closed", () => {
    const tab = makeTab();
    const pane = makePane([tab]);
    usePaneMetadataStore.getState().setMetadata(tab.sessionId, {
      agentKind: "claude",
      agentSessionId: "shared-session",
    });

    pushClosedPane(pane);

    expect(popClosedPane()).toMatchObject({
      agentKind: "claude",
      agentSessionId: "shared-session",
    });
  });
});

describe("closed entry origin workspace", () => {
  it("resolves the owning workspace from the live store when no origin is passed", () => {
    const tab = makeTab();
    const pane = makePane([tab]);
    useWorkspaceListStore.setState({
      workspaces: [makeWorkspace([pane], { id: "ws-home", name: "Home" })],
      activeWorkspaceId: "ws-home",
    });

    pushClosedTab(pane, tab);
    pushClosedPane(pane);

    expect(popClosedPane()).toMatchObject({ workspaceId: "ws-home", workspaceName: "Home" });
    expect(popClosedPane()).toMatchObject({ workspaceId: "ws-home", workspaceName: "Home" });
  });

  it("keeps an explicit origin for a workspace that is already being torn down", () => {
    const tab = makeTab();
    const pane = makePane([tab]);

    pushClosedTab(pane, tab, { workspaceId: "ws-gone", workspaceName: "Gone" });

    expect(popClosedPane()).toMatchObject({ workspaceId: "ws-gone", workspaceName: "Gone" });
  });

  it("omits the origin when the pane belongs to no known workspace", () => {
    const tab = makeTab();
    pushClosedTab(makePane([tab]), tab);
    const entry = popClosedPane();
    expect(entry?.workspaceId).toBeUndefined();
    expect(entry?.workspaceName).toBeUndefined();
  });

  it("peek leaves the entry on the stack", () => {
    const tab = makeTab();
    pushClosedTab(makePane([tab]), tab);
    expect(peekClosedPane()).not.toBeNull();
    expect(peekClosedPane()).toEqual(popClosedPane());
    expect(peekClosedPane()).toBeNull();
  });
});

describe("workspace close bulk push selection", () => {
  it("ranks the focused tab last in push order so it is restored first", () => {
    const paneA = makePaneWithTabs("pane-a", 2);
    const paneB = makePaneWithTabs("pane-b", 2, 1);
    const workspace = makeWorkspace([paneA, paneB]);

    const selection = selectClosedWorkspaceTabs(workspace, "pane-b-session-1");

    // Push order = reverse of MRU rank, so the last element lands on top of the
    // LIFO stack: focused pane's focused tab, then each pane's active tab, then
    // background tabs.
    expect(selection.map((entry) => entry.tab.id)).toEqual([
      "pane-a-tab-1",
      "pane-b-tab-0",
      "pane-a-tab-0",
      "pane-b-tab-1",
    ]);
    expect(selection.map((entry) => entry.pane.id)).toEqual([
      "pane-a",
      "pane-b",
      "pane-a",
      "pane-b",
    ]);
  });

  it("falls back to layout order when no session is focused", () => {
    const workspace = makeWorkspace([makePaneWithTabs("pane-a", 1), makePaneWithTabs("pane-b", 1)]);
    expect(selectClosedWorkspaceTabs(workspace, null).map((entry) => entry.tab.id)).toEqual([
      "pane-b-tab-0",
      "pane-a-tab-0",
    ]);
  });

  it("skips browser and online tabs because reopen relaunches a terminal", () => {
    const terminal = makeTab({ id: "tab-terminal", sessionId: "session-terminal" });
    const browser = makeTab({ id: "tab-browser", sessionId: "session-browser", type: "browser" });
    const online = makeTab({ id: "tab-online", sessionId: "session-online", type: "online" });
    const pane = makePane([terminal, browser, online]);

    expect(
      selectClosedWorkspaceTabs(makeWorkspace([pane]), null).map((entry) => entry.tab.id),
    ).toEqual(["tab-terminal"]);
  });

  it("caps one workspace close at half the history", () => {
    const workspace = makeWorkspace([makePaneWithTabs("pane-a", 8)]);
    expect(CLOSED_WORKSPACE_BULK_LIMIT).toBe(5);
    expect(selectClosedWorkspaceTabs(workspace, null)).toHaveLength(CLOSED_WORKSPACE_BULK_LIMIT);
  });

  it("leaves earlier single closes reachable after a bulk workspace close", () => {
    for (let index = 0; index < 8; index += 1) {
      const tab = makeTab({ id: `solo-tab-${index}`, sessionId: `solo-session-${index}` });
      pushClosedTab(makePane([tab], { id: `solo-pane-${index}` }), tab);
    }

    const workspace = makeWorkspace([makePaneWithTabs("pane-a", 6)], {
      id: "ws-bulk",
      name: "Bulk",
    });
    expect(pushClosedWorkspace(workspace, "pane-a-session-3")).toBe(CLOSED_WORKSPACE_BULK_LIMIT);

    const popped: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const entry = popClosedPane();
      if (!entry) break;
      popped.push(entry.label ?? entry.agentSessionId ?? entry.workspaceId ?? "?");
    }

    // 8 solo entries + 5 workspace entries, capped at 10: the workspace's
    // focused tab restores first and the 5 newest solo closes survive.
    expect(popped).toHaveLength(10);
    expect(popped.slice(0, 5)).toEqual(["ws-bulk", "ws-bulk", "ws-bulk", "ws-bulk", "ws-bulk"]);
    expect(popClosedPane()).toBeNull();
  });

  it("records the workspace origin and per-tab identity for every bulk entry", () => {
    const pane = makePaneWithTabs("pane-a", 2);
    usePaneMetadataStore.getState().setMetadata("pane-a-session-1", {
      agentKind: "codex",
      agentSessionId: "codex-bulk",
      cwd: "C:\\work\\bulk",
    });

    pushClosedWorkspace(makeWorkspace([pane], { id: "ws-bulk", name: "Bulk" }), "pane-a-session-1");

    expect(popClosedPane()).toMatchObject({
      workspaceId: "ws-bulk",
      workspaceName: "Bulk",
      agentKind: "codex",
      agentSessionId: "codex-bulk",
      cwd: "C:\\work\\bulk",
    });
    expect(popClosedPane()).toMatchObject({ workspaceId: "ws-bulk", agentSessionId: null });
  });
});
