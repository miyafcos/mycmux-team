import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../src/types";
import { handleSocketCommand, socketCommandWindowsForRequest } from "../../src/components/layout/socketCommands";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import { terminalScreenTheme } from "../../src/components/terminal/terminalScreenSnapshot";
import { invalidatePtyReads } from "../../src/lib/ptyReadGeneration";

const mocks = vi.hoisted(() => ({ screen: vi.fn(), parsed: vi.fn(), scrollback: vi.fn(), fragments: vi.fn(), capture: vi.fn(),
  create: vi.fn(), write: vi.fn(), kill: vi.fn() }));
vi.mock("../../src/lib/ipc", async original => ({ ...await original<typeof import("../../src/lib/ipc")>(),
  getSessionScrollback: mocks.scrollback, getWindowFragments: mocks.fragments,
  createSession: mocks.create, writeToSession: mocks.write, killSession: mocks.kill,
}));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({
  getTerminalBufferScreen: mocks.screen, isTerminalParsingCurrentOutput: mocks.parsed,
}));
vi.mock("../../src/components/terminal/terminalCapture", () => ({ captureTerminalScreen: mocks.capture }));
function workspace(): Workspace {
  return { id: "sample", name: "Sample", status: "running", createdAt: 1, gridTemplateId: "1x1", splitColumns: [["pane"]],
    panes: [{ id: "pane", sessionId: "pty", agentId: "shell", activeTabId: "tab", tabs: [
      { id: "tab", sessionId: "pty", agentId: "shell", type: "terminal" },
    ] }] };
}
const screen = { cols: 20, rows: 5, cursor: { col: 2, row: 1, visible: true }, atBottom: true,
  alternateScreen: false, scrollbackLines: 0, theme: terminalScreenTheme(), lines: [[], [], [], [], []] };
beforeEach(() => {
  vi.resetAllMocks(); useWorkspaceListStore.setState({ workspaces: [workspace()], activeWorkspaceId: "sample" });
  useUiStore.setState({ activePaneId: "pty", focusRevision: 1 });
  mocks.parsed.mockReturnValue(true); mocks.screen.mockReturnValue(screen); mocks.fragments.mockResolvedValue([]);
  mocks.capture.mockImplementation(async (read, _scale, current) => {
    const snapshot = await read(); if (!current()) throw new Error("pane read lifetime changed");
    return { sessionId: snapshot.sessionId, screen: snapshot, image: { type: "image/png", scale: 1, width: 160, height: 80, data: "fake" },
      renderer: "webgl", elapsedMs: 1 };
  });
});
afterEach(() => vi.restoreAllMocks());
describe("read-only pane.capture socket integration", () => {
  it("returns exactly the pane.screen scrollback=0 shape inside screen and accepts the alias", async () => {
    const before = useWorkspaceListStore.getState(), ui = useUiStore.getState();
    const result = await handleSocketCommand("pane.capture", { session_id: "pty", scale: 2 });
    expect(result).toMatchObject({ sessionId: "pty", screen: { sessionId: "pty", ...screen }, renderer: "webgl" });
    expect(mocks.screen).toHaveBeenCalledExactlyOnceWith("pty", 0);
    expect(mocks.capture).toHaveBeenCalledWith(expect.any(Function), 2, expect.any(Function));
    expect(mocks.scrollback).not.toHaveBeenCalled();
    expect(useWorkspaceListStore.getState()).toBe(before); expect(useUiStore.getState()).toBe(ui);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.kill).not.toHaveBeenCalled();
  });
  it.each([[undefined, "pane.screen requires sessionId"], ["", "pane.screen requires sessionId"],
    ["missing", "pane.screen session is not a known pane"]])("preserves pane.screen validation for %s", async (sessionId, error) => {
    await expect(handleSocketCommand("pane.capture", { sessionId })).rejects.toThrow(error);
  });
  it("does not start a declared tab", async () => {
    const ws = workspace(); ws.panes[0].tabs[0].lifecycle = "declared";
    useWorkspaceListStore.setState({ workspaces: [ws] });
    await expect(handleSocketCommand("pane.capture", { sessionId: "pty" })).rejects.toThrow("pane.screen cannot target a declared tab");
    expect(mocks.screen).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(["closed", "replaced", "generation"])("checks lifetime again after capture when %s", async change => {
    mocks.capture.mockImplementationOnce(async (read, _scale, current) => {
      await read();
      if (change === "closed") useWorkspaceListStore.setState({ workspaces: [] });
      else if (change === "generation") invalidatePtyReads("pty", true);
      else { const ws = workspace(); ws.panes[0].tabs[0].id = "replacement"; useWorkspaceListStore.setState({ workspaces: [ws] }); }
      if (!current()) throw new Error("pane read lifetime changed");
      throw new Error("lifetime check failed");
    });
    await expect(handleSocketCommand("pane.capture", { sessionId: "pty" })).rejects.toThrow(/^pane read lifetime changed$/);
  });
  it("routes to the owning peer window just like pane.screen", () => {
    const fragments = [{ window_label: "other", workspaces: [{ id: "remote", name: "Sample", created_at: 1,
      grid_template_id: "1x1", panes: [{ pane_id: "remote-pane", session_id: "remote-pty", agent_id: "shell", tabs: [] }] }] }];
    const args = { sessionId: "remote-pty" };
    expect([...socketCommandWindowsForRequest("pane.capture", args, [workspace()], fragments, "main").keys()]).toEqual(["other"]);
    expect([...socketCommandWindowsForRequest("pane.screen", args, [workspace()], fragments, "main").keys()]).toEqual(["other"]);
  });
});
