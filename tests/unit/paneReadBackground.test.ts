import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleSocketCommand, readPaneTail } from "../../src/components/layout/socketCommands";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Pane, PaneTab, Workspace } from "../../src/types";

const ipcMocks = vi.hoisted(() => ({
  getSessionScrollback: vi.fn(),
}));
const terminalBufferMocks = vi.hoisted(() => ({
  getTerminalBufferLines: vi.fn(),
  hasTerminalBuffer: vi.fn(),
}));
const headlessBufferMocks = vi.hoisted(() => ({
  getHeadlessBufferLines: vi.fn(),
}));

vi.mock("../../src/lib/ipc", () => ipcMocks);
vi.mock("../../src/components/terminal/XTermWrapper", () => terminalBufferMocks);
vi.mock("../../src/components/terminal/headlessBuffer", () => headlessBufferMocks);

const sessionId = "background-session";

function workspace(): Workspace {
  const tab: PaneTab = {
    id: "background-tab",
    sessionId,
    agentId: "shell-starter",
    type: "terminal",
  };
  const pane: Pane = {
    id: "pane",
    agentId: tab.agentId,
    sessionId: "foreground-session",
    tabs: [
      {
        id: "foreground-tab",
        sessionId: "foreground-session",
        agentId: "shell-starter",
        type: "terminal",
      },
      tab,
    ],
    activeTabId: "foreground-tab",
  };
  return {
    id: "workspace",
    name: "Workspace",
    gridTemplateId: "1x1",
    status: "running",
    createdAt: 1,
    panes: [pane],
    splitColumns: [[pane.id]],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  terminalBufferMocks.hasTerminalBuffer.mockReturnValue(false);
  useWorkspaceListStore.setState({
    workspaces: [workspace()],
    activeWorkspaceId: "workspace",
    lastActivePaneByWorkspace: {},
  });
});

describe("pane.read background fallback", () => {
  it("rejects a declared tab before any renderer or PTY read", async () => {
    const state = useWorkspaceListStore.getState();
    const declaredWorkspace = state.workspaces[0];
    declaredWorkspace.panes[0].tabs[1].lifecycle = "declared";
    useWorkspaceListStore.setState({ workspaces: [declaredWorkspace] });

    await expect(handleSocketCommand("pane.read", { sessionId })).rejects.toThrow(
      "pane.read cannot target a declared tab",
    );
    expect(terminalBufferMocks.hasTerminalBuffer).not.toHaveBeenCalled();
    expect(terminalBufferMocks.getTerminalBufferLines).not.toHaveBeenCalled();
    expect(ipcMocks.getSessionScrollback).not.toHaveBeenCalled();
    expect(headlessBufferMocks.getHeadlessBufferLines).not.toHaveBeenCalled();
  });

  it("preserves the existing renderer-buffer path exactly", async () => {
    terminalBufferMocks.hasTerminalBuffer.mockReturnValue(true);
    terminalBufferMocks.getTerminalBufferLines.mockReturnValue(["visible", "unchanged"]);

    await expect(handleSocketCommand("pane.read", { sessionId, lines: 2 })).resolves.toEqual({
      sessionId,
      lines: ["visible", "unchanged"],
    });
    expect(terminalBufferMocks.getTerminalBufferLines).toHaveBeenCalledWith(sessionId, 2);
    expect(ipcMocks.getSessionScrollback).not.toHaveBeenCalled();
    expect(headlessBufferMocks.getHeadlessBufferLines).not.toHaveBeenCalled();
  });

  it("replays PTY scrollback when no renderer buffer exists", async () => {
    const snapshot = {
      data: new Uint8Array([102, 97, 108, 108, 98, 97, 99, 107]),
      startOffset: 10,
      endOffset: 18,
    };
    ipcMocks.getSessionScrollback.mockResolvedValue(snapshot);
    headlessBufferMocks.getHeadlessBufferLines.mockResolvedValue(["fallback"]);

    await expect(handleSocketCommand("pane.read", { session_id: sessionId, lines: 3 })).resolves.toEqual({
      sessionId,
      lines: ["fallback"],
    });
    expect(headlessBufferMocks.getHeadlessBufferLines).toHaveBeenCalledWith(sessionId, snapshot, 3);
    expect(terminalBufferMocks.getTerminalBufferLines).not.toHaveBeenCalled();
  });

  it("can bypass a cached renderer and read current PTY scrollback", async () => {
    const snapshot = {
      data: new Uint8Array([99, 117, 114, 114, 101, 110, 116]),
      startOffset: 20,
      endOffset: 27,
    };
    terminalBufferMocks.hasTerminalBuffer.mockReturnValue(true);
    ipcMocks.getSessionScrollback.mockResolvedValue(snapshot);
    headlessBufferMocks.getHeadlessBufferLines.mockResolvedValue(["current"]);

    await expect(readPaneTail(sessionId, 60, true)).resolves.toEqual(["current"]);
    expect(terminalBufferMocks.getTerminalBufferLines).not.toHaveBeenCalled();
    expect(ipcMocks.getSessionScrollback).toHaveBeenCalledWith(sessionId);
    expect(headlessBufferMocks.getHeadlessBufferLines).toHaveBeenCalledWith(sessionId, snapshot, 60);
  });

  it("keeps the existing error when backend scrollback is empty", async () => {
    ipcMocks.getSessionScrollback.mockResolvedValue({
      data: new Uint8Array(),
      startOffset: 0,
      endOffset: 0,
    });

    await expect(handleSocketCommand("pane.read", { sessionId })).rejects.toThrow(
      "no terminal buffer for session",
    );
    expect(headlessBufferMocks.getHeadlessBufferLines).not.toHaveBeenCalled();
  });

  it("normalizes a missing backend session to the existing error", async () => {
    ipcMocks.getSessionScrollback.mockRejectedValue(new Error("Session not found"));

    await expect(handleSocketCommand("pane.read", { sessionId })).rejects.toThrow(
      "no terminal buffer for session",
    );
  });
});
