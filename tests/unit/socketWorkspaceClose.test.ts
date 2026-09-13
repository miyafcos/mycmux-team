import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane, PaneTab, Workspace } from "../../src/types";
import { handleSocketCommand } from "../../src/components/layout/socketCommands";
import { closeWorkspaceAfterConfirmation } from "../../src/lib/workspaceClose";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { getClosedPaneCount, peekClosedPane, popClosedPane } from "../../src/stores/closedPaneStore";

const ipc = vi.hoisted(() => ({
  killSession: vi.fn<(...args: unknown[]) => Promise<void>>(),
  removeWorkspaceScrollback: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));
const cache = vi.hoisted(() => ({ evictTerminalCache: vi.fn() }));
vi.mock("../../src/lib/ipc", () => ipc);
vi.mock("../../src/components/terminal/XTermWrapper", () => cache);

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

interface CloseResult {
  workspaceId: string;
  name: string | null;
  closedPanes: number;
  closedTabs: number;
  killedSessions: number;
  undoRecorded: number;
  activeWorkspaceId: string | null;
  foregroundChanged: boolean;
}

const close = (args: Record<string, unknown> = { workspaceId: "background" }, command = "workspace.close") =>
  handleSocketCommand(command, args) as Promise<CloseResult>;

beforeEach(() => {
  vi.clearAllMocks();
  ipc.killSession.mockResolvedValue(undefined);
  ipc.removeWorkspaceScrollback.mockResolvedValue(undefined);
  while (popClosedPane()) { /* Clear the bounded undo history. */ }
  useWorkspaceListStore.setState({
    workspaces: [workspace("foreground"), workspace("background")],
    activeWorkspaceId: "foreground", lastActivePaneByWorkspace: {},
  });
  useUiStore.setState({ activePaneId: "foreground-session", focusRevision: 0 });
  usePaneMetadataStore.setState({ metadata: {} });
});

afterEach(() => {
  expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("foreground");
  expect(useUiStore.getState().activePaneId).toBe("foreground-session");
  vi.restoreAllMocks();
  while (popClosedPane()) { /* Do not leak undo entries into other cases. */ }
});

describe("workspace.close", () => {
  it("closes all panes and tabs, evicts PTYs, and removes scrollback", async () => {
    const background = workspace("background");
    background.panes[0].tabs.push({ id: "extra-tab", sessionId: "extra-session", agentId: "shell-starter", type: "terminal" });
    background.panes.push(workspace("second").panes[0]);
    useWorkspaceListStore.setState({ workspaces: [workspace("foreground"), background] });
    usePaneMetadataStore.getState().setMetadata("background-session", { cwd: "C:/work" });
    const result = await close();
    expect(useWorkspaceListStore.getState().getWorkspace("background")).toBeUndefined();
    expect(useWorkspaceListStore.getState().workspaces).toHaveLength(1);
    const ids = ["background-session", "extra-session", "second-session"];
    expect(ipc.killSession.mock.calls).toEqual(ids.map((id) => [id]));
    expect(cache.evictTerminalCache.mock.calls).toEqual(ids.map((id) => [id]));
    expect(usePaneMetadataStore.getState().metadata["background-session"]).toBeUndefined();
    expect(ipc.removeWorkspaceScrollback).toHaveBeenCalledExactlyOnceWith("background", ids);
    expect(result).toEqual({
      workspaceId: "background", name: "background", closedPanes: 2, closedTabs: 3,
      killedSessions: 3, undoRecorded: 3, activeWorkspaceId: "foreground", foregroundChanged: false,
    });
  });

  it("refuses the active workspace without side effects", async () => {
    await expect(close({ workspaceId: "foreground" })).rejects.toThrow(/refuses the active workspace/);
    expect(useWorkspaceListStore.getState().workspaces).toHaveLength(2);
    expect(ipc.killSession).not.toHaveBeenCalled();
    expect(ipc.removeWorkspaceScrollback).not.toHaveBeenCalled();
    expect(cache.evictTerminalCache).not.toHaveBeenCalled();
    expect(getClosedPaneCount()).toBe(0);
  });

  it("rejects unknown workspaces", async () => {
    await expect(close({ workspaceId: "missing" })).rejects.toThrow(/workspace not found/);
    expect(ipc.killSession).not.toHaveBeenCalled();
  });

  it("requires workspaceId", async () => {
    await expect(close({})).rejects.toThrow(/requires workspaceId/);
    expect(ipc.killSession).not.toHaveBeenCalled();
  });

  it("records tabs for Ctrl+Shift+T", async () => {
    const result = await close();
    expect(result.undoRecorded).toBeGreaterThanOrEqual(1);
    expect(getClosedPaneCount()).toBe(result.undoRecorded);
    expect(peekClosedPane()).toMatchObject({ workspaceId: "background", workspaceName: "background" });
  });

  it("accepts the snake_case command alias", async () => {
    expect(await close({ workspaceId: "background" }, "close_workspace")).toMatchObject({
      workspaceId: "background", closedPanes: 1, closedTabs: 1, killedSessions: 1,
      undoRecorded: 1, foregroundChanged: false,
    });
    expect(useWorkspaceListStore.getState().getWorkspace("background")).toBeUndefined();
  });

  it.each(["workspace_id", "id"])("accepts the %s argument alias", async (key) => {
    expect(await close({ [key]: "background" })).toMatchObject({ workspaceId: "background" });
  });

  it("removes a launcher-only workspace without killing a PTY", async () => {
    const background = workspace("background");
    background.panes[0].tabs[0].type = "launcher";
    useWorkspaceListStore.setState({ workspaces: [workspace("foreground"), background] });
    expect(await close()).toMatchObject({ closedPanes: 1, closedTabs: 1, killedSessions: 0, undoRecorded: 0 });
    expect(ipc.killSession).not.toHaveBeenCalled();
    expect(cache.evictTerminalCache).not.toHaveBeenCalled();
    expect(ipc.removeWorkspaceScrollback).toHaveBeenCalledExactlyOnceWith("background", []);
    expect(useWorkspaceListStore.getState().getWorkspace("background")).toBeUndefined();
  });

  it("returns an empty result if the shared helper finds no workspace", async () => {
    expect(await closeWorkspaceAfterConfirmation("missing")).toEqual({
      closed: false, name: null, paneCount: 0, tabCount: 0, killedSessionIds: [], undoRecorded: 0,
    });
    expect(ipc.killSession).not.toHaveBeenCalled();
    expect(ipc.removeWorkspaceScrollback).not.toHaveBeenCalled();
  });
});
