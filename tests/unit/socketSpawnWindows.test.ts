import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSocketCommand, listenForPeerSpawns, requestPeerSpawn, spawnWindowForRequest } from "../../src/components/layout/socketCommands";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import { beginSessionAttach } from "../../src/lib/attachEpoch";
import type { WindowFragment } from "../../src/lib/ipc";
import type { Workspace } from "../../src/types";

const mocks = vi.hoisted(() => ({ label: "main", listeners: new Map<string, { fn: (event: any) => any; options: any }>(),
  listen: vi.fn(), emitTo: vi.fn(), unlisten: vi.fn(), getWindowFragments: vi.fn(), createSession: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen, emitTo: mocks.emitTo }));
vi.mock("../../src/lib/windowContext", () => ({ windowLabel: () => mocks.label, isMainWindow: () => mocks.label === "main" }));
vi.mock("../../src/lib/ipc", async (original) => ({ ...await original<typeof import("../../src/lib/ipc")>(),
  getWindowFragments: mocks.getWindowFragments, createSession: mocks.createSession }));

const REQUEST = "mycmux://socket-spawn", RESULT = "mycmux://socket-spawn-result";
function own(): Workspace {
  return { id: "child-workspace", name: "Child", createdAt: 1, status: "running", gridTemplateId: "1x1", panes: [{
    id: "child-pane", agentId: "shell-starter", sessionId: "pty-caller", activeTabId: "caller-tab", tabs: [
      { id: "caller-tab", agentId: "shell-starter", sessionId: "pty-caller", type: "terminal" },
    ],
  }], splitColumns: [["child-pane"]] };
}
function peer(label = "mycmux-w2"): WindowFragment {
  return { window_label: label, workspaces: [{ id: "child-workspace", name: "Child", created_at: 1, grid_template_id: "1x1", panes: [
    { pane_id: "child-pane", agent_id: "shell-starter", label: null, tabs: [{ tab_id: "caller-tab", session_id: "pty-caller", agent_id: "shell-starter" }] },
  ] }] };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.listeners.clear(); mocks.label = "main";
  mocks.listen.mockImplementation(async (name, fn, options) => { mocks.listeners.set(name, { fn, options }); return mocks.unlisten; });
  mocks.getWindowFragments.mockResolvedValue([peer()]);
  mocks.emitTo.mockResolvedValue(undefined);
  mocks.createSession.mockImplementation(async (id: string) => { beginSessionAttach(id, { deliver: () => {}, ackStale: () => {} }).commit(); });
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null, lastActivePaneByWorkspace: {} });
  useUiStore.setState({ activePaneId: null });
});
afterEach(() => vi.useRealTimers());

describe("caller-window spawn dispatch", () => {
  it.each(["anchorSessionId", "anchor_session_id"])("routes %s to the child's owner", (key) => {
    expect(spawnWindowForRequest("pane.spawn_tab", { [key]: "pty-caller" }, [], [peer()], "main")).toBe("mycmux-w2");
  });
  it("ignores its own stale snapshot and rejects a conflicting peer owner", () => {
    expect(spawnWindowForRequest("pane.spawn", { anchorSessionId: "pty-caller" }, [own()], [peer("main")], "main")).toBe("main");
    expect(() => spawnWindowForRequest("pane.spawn", { anchorSessionId: "pty-caller" }, [own()], [peer()], "main")).toThrow("conflicting");
  });
  it("fails closed for missing or conflicting callers and leaves implicit spawn local", () => {
    expect(() => spawnWindowForRequest("pane.spawn", { anchorSessionId: "gone" }, [own()], [peer()], "main")).toThrow("anchor session not found");
    expect(() => spawnWindowForRequest("pane.spawn_tab", { anchorSessionId: "pty-caller" }, [], [peer(), peer("mycmux-w3")], "main")).toThrow("conflicting");
    expect(spawnWindowForRequest("pane.spawn", {}, [], [], "main")).toBe("main");
    expect(spawnWindowForRequest("pane.spawn", { workspaceId: "child-workspace" }, [], [peer()], "main")).toBe("mycmux-w2");
  });
  it.each(["pane.spawn", "pane.spawn_tab"] as const)("forwards %s without changing the leader store or focus", async (cmd) => {
    const expected = { sessionId: "pty-new", paneId: "child-pane", workspaceId: "child-workspace" };
    mocks.emitTo.mockImplementation(async (target, event, request) => {
      expect(target).toBe("mycmux-w2"); expect(event).toBe(REQUEST);
      expect(request).toMatchObject({ cmd, args: { anchorSessionId: "pty-caller" }, replyWindow: "main", targetWindow: target });
      await mocks.listeners.get(RESULT)!.fn({ payload: { requestId: "unrelated", ownerWindow: target, result: {} } });
      await mocks.listeners.get(RESULT)!.fn({ payload: { requestId: request.requestId, ownerWindow: "another", result: {} } });
      await mocks.listeners.get(RESULT)!.fn({ payload: { requestId: request.requestId, ownerWindow: target, result: expected } });
    });
    expect(await handleSocketCommand(cmd, { anchorSessionId: "pty-caller", commandArgv: ["echo", "child"], activate: false })).toEqual(expected);
    expect(useWorkspaceListStore.getState().workspaces).toEqual([]);
    expect(useUiStore.getState().activePaneId).toBeNull();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.listeners.get(RESULT)!.options).toEqual({ target: { kind: "Window", label: "main" } });
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });
  it("reports a timeout and removes its targeted response listener", async () => {
    vi.useFakeTimers();
    const result = expect(requestPeerSpawn("mycmux-w2", "pane.spawn_tab", { anchorSessionId: "pty-caller" })).rejects.toThrow("owner window did not respond");
    await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(20_000); await result;
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });
  it("executes a targeted request once using the child's real store and PTY attachment", async () => {
    mocks.label = "mycmux-w2";
    useWorkspaceListStore.setState({ workspaces: [own()], activeWorkspaceId: "child-workspace" });
    await listenForPeerSpawns();
    const listener = mocks.listeners.get(REQUEST)!;
    expect(listener.options).toEqual({ target: { kind: "Window", label: "mycmux-w2" } });
    const payload = { requestId: "new", targetWindow: "mycmux-w2", replyWindow: "main", cmd: "pane.spawn_tab",
      expiresAt: Date.now() + 20_000, context: { command: "pane.spawn_tab", receivedAt: Date.now(), deadline: Date.now() + 25_000 }, args: {
      anchorSessionId: "pty-caller", commandArgv: ["echo", "child"], activate: false,
    } };
    await listener.fn({ payload: { ...payload, targetWindow: "mycmux-w3" } });
    expect(mocks.createSession).not.toHaveBeenCalled();
    await listener.fn({ payload }); await listener.fn({ payload });
    expect(mocks.createSession).toHaveBeenCalledOnce();
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs).toHaveLength(2);
    expect(mocks.emitTo).toHaveBeenCalledWith("main", RESULT, expect.objectContaining({ requestId: "new", ownerWindow: "mycmux-w2", result: expect.objectContaining({ workspaceId: "child-workspace" }) }));
  });
  it("rechecks ownership after hydration and propagates errors without spawning", async () => {
    mocks.label = "mycmux-w2";
    useWorkspaceListStore.setState({ workspaces: [own()] });
    await listenForPeerSpawns(async () => { useWorkspaceListStore.setState({ workspaces: [] }); });
    await mocks.listeners.get(REQUEST)!.fn({ payload: { requestId: "moved", targetWindow: "mycmux-w2", replyWindow: "main", cmd: "pane.spawn_tab",
      expiresAt: Date.now() + 20_000, context: { command: "pane.spawn_tab", receivedAt: Date.now(), deadline: Date.now() + 25_000 }, args: { anchorSessionId: "pty-caller" } } });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.emitTo).toHaveBeenCalledWith("main", RESULT, expect.objectContaining({ error: "pane.spawn_tab anchor session not found" }));
  });
});
