import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../src/types";
import type { WindowFragment, ScrollbackSnapshot } from "../../src/lib/ipc";
import { handleSocketCommand } from "../../src/components/layout/socketCommands";
import { __resetHeadlessBufferCacheForTests, __headlessBufferStateForTests } from "../../src/components/terminal/headlessBuffer";
import { terminalSizeCache, liveTerms, termCache } from "../../src/components/terminal/terminalCache";
import { terminalScreenTheme } from "../../src/components/terminal/terminalScreenSnapshot";
import { webPaneCommandContext } from "../../src/components/workspace/webPaneCommandQueue";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useThemeStore } from "../../src/stores/themeStore";
import { useSettingsStore } from "../../src/stores/settingsStore";

const mocks = vi.hoisted(() => ({
  parsed: vi.fn(), screen: vi.fn(), lines: vi.fn(), scrollback: vi.fn(), fragments: vi.fn(),
  create: vi.fn(), write: vi.fn(), kill: vi.fn(),
}));
vi.mock("../../src/lib/ipc", async original => ({
  ...await original<typeof import("../../src/lib/ipc")>(),
  getSessionScrollback: mocks.scrollback, getWindowFragments: mocks.fragments,
  createSession: mocks.create, writeToSession: mocks.write, killSession: mocks.kill,
  getPtyMetadataSnapshot: async () => ({}), getSessionOutputSnapshot: async () => ({}),
}));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({
  isTerminalParsingCurrentOutput: mocks.parsed, getTerminalBufferScreen: mocks.screen,
  getTerminalBufferLines: mocks.lines,
}));
const encoder = new TextEncoder();
function snapshot(text = "  screen\r\n\r\nlast"): ScrollbackSnapshot {
  const data = encoder.encode(text);
  return { data, startOffset: 0, endOffset: data.length, sessionEpoch: 1, sizeRevision: 1, cols: 20, rows: 5 };
}
function workspace(id = "workspace"): Workspace {
  return { id, name: "Sample workspace", createdAt: 1, status: "running", gridTemplateId: "1x1",
    panes: [{ id: `pane-${id}`, sessionId: `pty-${id}`, agentId: "shell", activeTabId: `tab-${id}`,
      tabs: [{ id: `tab-${id}`, sessionId: `pty-${id}`, agentId: "shell", type: "terminal" }] }],
    splitColumns: [[`pane-${id}`]],
  };
}
beforeEach(() => {
  vi.resetAllMocks(); __resetHeadlessBufferCacheForTests(); terminalSizeCache.clear(); liveTerms.clear(); termCache.clear();
  useWorkspaceListStore.setState({ workspaces: [workspace()], activeWorkspaceId: "workspace" });
  useUiStore.setState({ activePaneId: "pty-workspace", zoomedPaneId: null, focusRevision: 1 });
  useThemeStore.getState().hydrateSettings({ themeId: "mayonaka", themeTweaks: undefined });
  useSettingsStore.setState({ colorAdaptCommands: [] });
  mocks.fragments.mockResolvedValue([]); mocks.scrollback.mockResolvedValue(snapshot()); mocks.parsed.mockReturnValue(false);
});
afterEach(() => { __resetHeadlessBufferCacheForTests(); vi.restoreAllMocks(); });
const read = (scrollback?: unknown) => handleSocketCommand("pane.screen", { sessionId: "pty-workspace", scrollback });

describe("pane.screen socket command", () => {
  it("uses a current live parser and leaves foreground, focus and input untouched", async () => {
    mocks.parsed.mockReturnValue(true);
    const expected = { cols: 20, rows: 5, cursor: null, atBottom: true, alternateScreen: false, scrollbackLines: 0,
      theme: terminalScreenTheme(useThemeStore.getState().theme.terminal), lines: [[], [], [], [], []] };
    mocks.screen.mockReturnValue(expected);
    const workspaces = useWorkspaceListStore.getState(), ui = useUiStore.getState();
    expect(await read(0)).toEqual({ sessionId: "pty-workspace", ...expected });
    expect(mocks.screen).toHaveBeenCalledExactlyOnceWith("pty-workspace", 0);
    expect(mocks.scrollback).not.toHaveBeenCalled();
    expect(useWorkspaceListStore.getState()).toBe(workspaces); expect(useUiStore.getState()).toBe(ui);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.kill).not.toHaveBeenCalled();
  });

  it("replays a cold buffer at backend dimensions and preserves physical blank rows", async () => {
    expect(await read()).toMatchObject({ sessionId: "pty-workspace", cols: 20, rows: 5, scrollbackLines: 0,
      lines: [[[2, 1, "screen", null, null, 0]], [], [[0, 1, "last", null, null, 0]], [], []] });
    expect(mocks.scrollback).toHaveBeenCalledExactlyOnceWith("pty-workspace");
    expect(mocks.screen).not.toHaveBeenCalled();
  });

  it("reuses its own parser for unchanged deltas without changing pane.read's result", async () => {
    expect(await handleSocketCommand("pane.read", { sessionId: "pty-workspace" }))
      .toEqual({ sessionId: "pty-workspace", lines: ["screen", "last"] });
    const full = snapshot();
    mocks.scrollback.mockImplementation(async (_sessionId: string, cursor?: unknown) => cursor === undefined
      ? full : { ...full, data: new Uint8Array(), startOffset: full.endOffset, isDelta: true });
    const first = await read(); expect(await read()).toEqual(first);
    expect(mocks.scrollback).toHaveBeenLastCalledWith("pty-workspace", { endOffset: full.endOffset, sessionEpoch: 1, sizeRevision: 1 });
    expect(await handleSocketCommand("pane.read", { sessionId: "pty-workspace" }))
      .toEqual({ sessionId: "pty-workspace", lines: ["screen", "last"] });
  });

  it.each([
    [undefined, "pane.screen requires sessionId"],
    ["", "pane.screen requires sessionId"],
    ["unknown", "pane.screen session is not a known pane"],
  ])("returns the specified validation error for %s", async (sessionId, message) => {
    await expect(handleSocketCommand("pane.screen", { sessionId })).rejects.toThrow(message);
    expect(mocks.scrollback).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects declared tabs without starting them", async () => {
    const ws = workspace(); ws.panes[0].tabs[0].lifecycle = "declared";
    useWorkspaceListStore.setState({ workspaces: [ws] });
    await expect(read()).rejects.toThrow("pane.screen cannot target a declared tab");
    expect(mocks.scrollback).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each(["missing", "empty"])("returns the specified no-buffer error for %s PTY", async kind => {
    if (kind === "missing") mocks.scrollback.mockRejectedValue(new Error("absent"));
    else mocks.scrollback.mockResolvedValue(snapshot(""));
    await expect(read()).rejects.toThrow("no terminal buffer for session");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("uses headless for an inactive owner tab even with a retained live parser", async () => {
    useWorkspaceListStore.setState({ workspaces: [workspace(), workspace("other")], activeWorkspaceId: "other" });
    mocks.parsed.mockReturnValue(true);
    expect(await handleSocketCommand("pane.screen", { session_id: "pty-workspace" }, {
      context: webPaneCommandContext("pane.screen"), expiresAt: Date.now() + 5000,
    })).toMatchObject({ sessionId: "pty-workspace", cols: 20 });
    expect(mocks.screen).not.toHaveBeenCalled(); expect(mocks.scrollback).toHaveBeenCalledOnce();
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("other");
  });

  it("does not queue an interactive read behind a screen poll's slow IPC or rewind its newer parser", async () => {
    await read();
    const old = snapshot(); let release!: (value: ScrollbackSnapshot) => void;
    mocks.scrollback.mockImplementationOnce(() => new Promise<ScrollbackSnapshot>(resolve => { release = resolve; }));
    const screenPoll = read(); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(__headlessBufferStateForTests().queued).toEqual([]);
    mocks.scrollback.mockResolvedValue(snapshot("  screen\r\n\r\nlast\r\nNEW"));
    const before = performance.now();
    expect(await handleSocketCommand("pane.read", { sessionId: "pty-workspace" }))
      .toEqual({ sessionId: "pty-workspace", lines: ["screen", "last", "NEW"] });
    expect(performance.now() - before).toBeLessThan(250);
    await read();
    release(old);
    expect((await screenPoll as { lines: unknown }).lines).toEqual((await read() as { lines: unknown }).lines);
    expect(await handleSocketCommand("pane.read", { sessionId: "pty-workspace" }))
      .toEqual({ sessionId: "pty-workspace", lines: ["screen", "last", "NEW"] });
  });

  it("rejects a response whose tab lifetime ended during acquisition", async () => {
    let release!: (value: ScrollbackSnapshot) => void;
    mocks.scrollback.mockImplementationOnce(() => new Promise<ScrollbackSnapshot>(resolve => { release = resolve; }));
    const pending = expect(read()).rejects.toThrow(/changed/);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    useWorkspaceListStore.setState({ workspaces: [] }); release(snapshot()); await pending;
    expect(__headlessBufferStateForTests().entries).toEqual([]);
  });

  it("reports zoomedPaneId for its containing workspace and null for other windows", async () => {
    const remote: WindowFragment = { window_label: "peer-window", workspaces: [{
      id: "remote", name: "Sample remote", created_at: 1, grid_template_id: "1x1", panes: [],
    }] };
    mocks.fragments.mockResolvedValue([remote]);
    useWorkspaceListStore.setState({ workspaces: [workspace(), workspace("other")] });
    useUiStore.setState({ zoomedPaneId: "pane-workspace" });
    const result = await handleSocketCommand("pane.list_all", {}) as { workspaces: Array<{ workspaceId: string; zoomedPaneId: string | null }> };
    expect(result.workspaces.map(ws => [ws.workspaceId, ws.zoomedPaneId]))
      .toEqual([["workspace", "pane-workspace"], ["other", null], ["remote", null]]);
  });
});
