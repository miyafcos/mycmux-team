import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleSocketCommand,
  resolveSpawnOrigin,
} from "../../src/components/layout/socketCommands";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Pane, PaneTab, Workspace } from "../../src/types";

const uuidMocks = vi.hoisted(() => ({
  next: 0,
  v4: vi.fn(() => `spawn-origin-${uuidMocks.next++}`),
}));

vi.mock("uuid", () => uuidMocks);

const workspaceId = "workspace-origin";
const paneId = "pane-origin";

function workspace(): Workspace {
  const tab: PaneTab = {
    id: "tab-anchor",
    sessionId: "session-anchor",
    agentId: "shell-starter",
    type: "terminal",
  };
  const pane: Pane = {
    id: paneId,
    agentId: tab.agentId,
    sessionId: tab.sessionId,
    tabs: [tab],
    activeTabId: tab.id,
  };
  return {
    id: workspaceId,
    name: "Origin contract",
    gridTemplateId: "1x1",
    panes: [pane],
    splitColumns: [[pane.id]],
    status: "running",
    createdAt: 1,
  };
}

beforeEach(() => {
  uuidMocks.next = 0;
  uuidMocks.v4.mockClear();
  useWorkspaceListStore.setState({
    workspaces: [workspace()],
    activeWorkspaceId: workspaceId,
    lastActivePaneByWorkspace: {},
  });
});

describe("resolveSpawnOrigin", () => {
  it("preserves the legacy absence when no origin signal exists", () => {
    expect(resolveSpawnOrigin({}, undefined)).toBeUndefined();
  });

  it("uses the anchor as an agent lineage parent by default", () => {
    expect(resolveSpawnOrigin({}, "tab-anchor")).toEqual({
      kind: "agent",
      parentTabId: "tab-anchor",
    });
  });

  it("prefers an explicit parent over the anchor", () => {
    expect(resolveSpawnOrigin({ parentTabId: "tab-explicit" }, "tab-anchor")).toEqual({
      kind: "agent",
      parentTabId: "tab-explicit",
    });
  });

  it("honours an explicit human kind while retaining the anchor", () => {
    expect(resolveSpawnOrigin({ origin: "human" }, "tab-anchor")).toEqual({
      kind: "human",
      parentTabId: "tab-anchor",
    });
  });

  it("omits parentTabId when only an explicit agent kind exists", () => {
    const origin = resolveSpawnOrigin({ origin: "agent" }, undefined);
    expect(origin).toEqual({ kind: "agent" });
    expect(origin && "parentTabId" in origin).toBe(false);
  });

  it("accepts the snake-case explicit parent", () => {
    expect(resolveSpawnOrigin({ parent_tab_id: "tab-snake" }, "tab-anchor")).toEqual({
      kind: "agent",
      parentTabId: "tab-snake",
    });
  });

  it("leaves origin unset and warns for an unknown explicit kind", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(resolveSpawnOrigin({ origin: "bogus" }, "tab-anchor")).toBeUndefined();
      expect(warn).toHaveBeenCalledWith("[pane origin] ignoring unsupported origin: bogus");
    } finally {
      warn.mockRestore();
    }
  });

  it("leaves declared-tab origin unset and warns for an unknown explicit kind", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await handleSocketCommand("pane.declare_tab", {
        paneId,
        label: "Unknown origin",
        origin: "bogus",
      });
      const declared = useWorkspaceListStore.getState().getWorkspace(workspaceId)!.panes[0].tabs[1];
      expect(declared.origin).toBeUndefined();
      expect(warn).toHaveBeenCalledWith("[pane origin] ignoring unsupported origin: bogus");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("workspace spawn origin wiring", () => {
  it.each([
    [{ kind: "agent", parentTabId: "tab-anchor" } as const],
    [undefined],
  ])("passes origin through addTabToPaneWithOptions: %o", (origin) => {
    useWorkspaceLayoutStore.getState().addTabToPaneWithOptions(workspaceId, paneId, {
      commandArgv: ["cmd.exe"],
      activate: false,
      ...(origin ? { origin } : {}),
    });

    const appended = useWorkspaceListStore.getState().getWorkspace(workspaceId)!.panes[0].tabs[1];
    expect(appended.origin).toEqual(origin);
  });

  it.each([
    [{ kind: "human", parentTabId: "tab-anchor" } as const],
    [undefined],
  ])("passes origin through addPaneToWorkspaceWithOptions: %o", (origin) => {
    useWorkspaceLayoutStore.getState().addPaneToWorkspaceWithOptions(
      workspaceId,
      paneId,
      "right",
      {
        commandArgv: ["cmd.exe"],
        activate: false,
        ...(origin ? { origin } : {}),
      },
    );

    const addedPane = useWorkspaceListStore.getState().getWorkspace(workspaceId)!.panes[1];
    expect(addedPane.tabs[0].origin).toEqual(origin);
  });
});
