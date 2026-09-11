import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane, PaneTab, Workspace } from "../../src/types";
import { handleSocketCommand } from "../../src/components/layout/socketCommands";
import { liveTerms } from "../../src/components/terminal/terminalCache";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useSavepointDragStore } from "../../src/stores/savepointDragStore";

const ipc = vi.hoisted(() => ({
  createSession: vi.fn<(...args: unknown[]) => Promise<void>>(),
  killSession: vi.fn<(...args: unknown[]) => Promise<void>>(),
  ackFrontendData: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../src/lib/ipc", () => ipc);

function workspace(id: string): Workspace {
  const tab: PaneTab = {
    id: `${id}-tab`, sessionId: `${id}-session`, agentId: "shell-starter", type: "terminal",
  };
  const pane: Pane = {
    id: `${id}-pane`, sessionId: tab.sessionId, agentId: tab.agentId,
    tabs: [tab], activeTabId: tab.id,
  };
  return {
    id, name: id, gridTemplateId: "1x1", status: "running", createdAt: 1,
    panes: [pane], splitColumns: [[pane.id]],
  };
}

interface NewWorkspaceResult {
  workspaceId: string;
  name: string;
  gridTemplateId: string;
  cwd: string;
  panes: { paneId: string; sessionId: string }[];
  activeWorkspaceId: string | null;
  foregroundChanged: boolean;
}

const create = (args: Record<string, unknown> = {}, command = "workspace.new") =>
  handleSocketCommand(command, { name: "lane", ...args }) as Promise<NewWorkspaceResult>;

beforeEach(() => {
  vi.clearAllMocks();
  ipc.createSession.mockResolvedValue(undefined);
  ipc.killSession.mockResolvedValue(undefined);
  useWorkspaceListStore.setState({
    workspaces: [workspace("foreground"), workspace("background")],
    activeWorkspaceId: "foreground", lastActivePaneByWorkspace: {},
  });
  useUiStore.setState({ activePaneId: "foreground-session", focusRevision: 0 });
  useSavepointDragStore.setState({ item: null });
  liveTerms.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  liveTerms.clear();
  useSavepointDragStore.setState({ item: null });
});

describe("workspace.new", () => {
  it.each(["workspace.new", "new_workspace"])("creates in the background through %s", async (command) => {
    const result = await create({}, command);
    const state = useWorkspaceListStore.getState();
    expect(state.workspaces).toHaveLength(3);
    expect(state.activeWorkspaceId).toBe("foreground");
    expect(result).toMatchObject({
      workspaceId: expect.any(String), name: "lane", gridTemplateId: "1x1",
      cwd: "", activeWorkspaceId: "foreground", foregroundChanged: false,
    });
    const created = state.getWorkspace(result.workspaceId)!;
    expect(created.panes).toHaveLength(1);
    expect(result.panes).toEqual(created.panes.map((pane) => ({
      paneId: pane.id, sessionId: pane.sessionId,
    })));
    expect(useUiStore.getState().activePaneId).toBe("foreground-session");
    expect(ipc.createSession).not.toHaveBeenCalled();
  });

  it("activates the first workspace when there is no foreground", async () => {
    useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
    const result = await create();
    expect(useWorkspaceListStore.getState().workspaces).toHaveLength(1);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe(result.workspaceId);
    expect(result.activeWorkspaceId).toBe(result.workspaceId);
    expect(result.foregroundChanged).toBe(true);
    expect(ipc.createSession).not.toHaveBeenCalled();
  });

  it.each([{}, { name: "" }, { name: "   " }])("requires a nonblank name: %j", async (args) => {
    await expect(handleSocketCommand("workspace.new", args)).rejects.toThrow(/requires name/);
    expect(useWorkspaceListStore.getState().workspaces).toHaveLength(2);
  });

  it.each(["gridTemplateId", "grid_template_id", "grid"])("accepts a grid through %s", async (key) => {
    const result = await create({ [key]: "2x2" });
    expect(result.gridTemplateId).toBe("2x2");
    expect(result.panes).toHaveLength(4);
    expect(useWorkspaceListStore.getState().getWorkspace(result.workspaceId)!.panes).toHaveLength(4);
  });

  it.each(["9x9", "toString", "__proto__"])("rejects an unsupported grid: %s", async (gridTemplateId) => {
    await expect(create({ gridTemplateId })).rejects.toThrow(/unsupported/);
    expect(useWorkspaceListStore.getState().workspaces).toHaveLength(2);
  });

  it("stamps the normalized cwd onto every pane and tab and returns it", async () => {
    const result = await create({ cwd: "C:/work/lane/", gridTemplateId: "2x2" });
    expect(result.cwd).toBe("C:/work/lane");
    const created = useWorkspaceListStore.getState().getWorkspace(result.workspaceId)!;
    for (const pane of created.panes) {
      expect(pane.cwd).toBe("C:/work/lane");
      expect(pane.tabs.length).toBeGreaterThan(0);
      for (const tab of pane.tabs) expect(tab.cwd).toBe("C:/work/lane");
    }
  });

  it.each(["codex", "claude"])("spawns %s into the returned workspace without moving the foreground", async (target) => {
    const created = await create({ cwd: "C:/work/lane/" });
    const result = await handleSocketCommand("pane.spawn", {
      workspaceId: created.workspaceId, target, activate: false,
    }) as { workspaceId: string; sessionId: string };
    expect(result.workspaceId).toBe(created.workspaceId);
    expect(useWorkspaceListStore.getState().getWorkspace(created.workspaceId)!.panes).toHaveLength(2);
    expect(ipc.createSession).toHaveBeenCalledOnce();
    expect(ipc.createSession.mock.calls[0][0]).toBe(result.sessionId);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("foreground");
    expect(useUiStore.getState().activePaneId).toBe("foreground-session");
  });
});
