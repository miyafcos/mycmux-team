import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowFragment } from "../../src/lib/ipc";
import { handleSocketCommand } from "../../src/components/layout/socketCommands";
import {
  listenForPeerTabStarts, otherWindowWorkspaces, requestPeerTabStart, serializeOtherWindowPanes,
} from "../../src/lib/socketTabWindows";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: any }) => unknown>(),
  listen: vi.fn(), emitTo: vi.fn(), unlisten: vi.fn(),
  getWindowFragments: vi.fn(), createSession: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen, emitTo: mocks.emitTo }));
vi.mock("../../src/lib/windowContext", () => ({ windowLabel: () => "main" }));
vi.mock("../../src/lib/ipc", () => ({
  getWindowFragments: mocks.getWindowFragments, createSession: mocks.createSession,
  getPtyMetadataSnapshot: async () => ({}), getSessionOutputSnapshot: async () => ({}),
}));
const REQUEST = "mycmux://socket-start-tab";
const RESULT = "mycmux://socket-start-tab-result";
function fragment(): WindowFragment {
  return { window_label: "mycmux-w2", workspaces: [{
    id: "peer-workspace", name: "Peer", grid_template_id: "1x1", created_at: 1,
    panes: [{ pane_id: "peer-pane", agent_id: "codex", label: null, tabs: [{
      tab_id: "peer-tab", session_id: "peer-pty", agent_id: "codex", type: "terminal",
      agent_kind: "codex", agent_session_id: "peer-conversation",
    }] }],
  }] };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listeners.clear();
  mocks.listen.mockImplementation(async (name, handler) => {
    mocks.listeners.set(name, handler);
    return mocks.unlisten;
  });
  mocks.emitTo.mockResolvedValue(undefined);
  mocks.getWindowFragments.mockResolvedValue([fragment()]);
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
});
afterEach(() => vi.useRealTimers());

describe("other-window restored tabs", () => {
  it("lists peer panes without adding invented tab fields or stale local duplicates", async () => {
    const peer = fragment();
    const entries = otherWindowWorkspaces([
      { ...peer, window_label: "main" }, peer, { ...peer, window_label: "mycmux-w3" },
    ], new Set());
    expect(entries).toHaveLength(1);
    expect(otherWindowWorkspaces([peer], new Set(["peer-workspace"]))).toEqual([]);
    expect(serializeOtherWindowPanes(entries)[0].tabs[0]).toMatchObject({
      id: "peer-tab", sessionId: "peer-pty", agentKind: "codex", agentSessionId: "peer-conversation",
    });
    expect(serializeOtherWindowPanes(entries)[0].tabs[0].label).toBeUndefined();
    const result = await handleSocketCommand("pane.list_all", {}) as { panes: unknown[] };
    expect(result.panes).toEqual(serializeOtherWindowPanes(entries));
  });

  it("routes an explicit start to the owning window without creating a local PTY", async () => {
    mocks.emitTo.mockImplementation(async (window, event, request) => {
      expect(window).toBe("mycmux-w2");
      expect(event).toBe(REQUEST);
      expect(request).toMatchObject({ cmd: "pane.start_tab", args: { sessionId: "peer-pty" }, targetWindow: "mycmux-w2", replyWindow: "main" });
      await mocks.listeners.get(RESULT)!({ payload: {
        requestId: request.requestId, ownerWindow: "mycmux-w2", result: { started: true, sessionId: "peer-pty" },
      } });
    });
    expect(await handleSocketCommand("pane.start_tab", { sessionId: "peer-pty" })).toEqual({
      started: true, sessionId: "peer-pty",
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBeNull();
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });

  it("returns the owner's conflict text unchanged and ignores unrelated responses", async () => {
    const error = 'AGENT_SESSION_ALREADY_RUNNING:{"kind":"codex","agentSessionId":"peer-conversation","ownerSessionId":"owner"}';
    mocks.emitTo.mockImplementation(async (_window, _event, request) => {
      await mocks.listeners.get(RESULT)!({ payload: { requestId: "another-request", error: "ignore" } });
      await mocks.listeners.get(RESULT)!({ payload: { requestId: request.requestId, ownerWindow: "mycmux-w2", error } });
    });
    await expect(requestPeerTabStart("mycmux-w2", "peer-pty")).rejects.toThrow(error);
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });

  it("removes the response listener when the peer fails to respond", async () => {
    vi.useFakeTimers();
    const failed = expect(requestPeerTabStart("mycmux-w2", "peer-pty"))
      .rejects.toThrow("pane.start_tab owner window did not respond");
    await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(20_000);
    await failed;
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });

  it("runs the owner's local start handler and sends the result to the caller", async () => {
    const start = vi.fn(async () => ({ started: false, reason: "already_running" as const, sessionId: "peer-pty" }));
    await listenForPeerTabStarts(start);
    await mocks.listeners.get(REQUEST)!({ payload: { requestId: "request", targetWindow: "main", cmd: "pane.start_tab", args: { sessionId: "peer-pty" }, replyWindow: "main",
      expiresAt: Date.now() + 20_000, context: { command: "pane.start_tab", receivedAt: Date.now(), deadline: Date.now() + 25_000 } } });
    expect(start).toHaveBeenCalledExactlyOnceWith("peer-pty");
    expect(mocks.emitTo).toHaveBeenCalledExactlyOnceWith("main", RESULT, {
      requestId: "request", ownerWindow: "main", result: { started: false, reason: "already_running", sessionId: "peer-pty" },
    });
  });

  it("preserves an owner-side launch error", async () => {
    const error = "pane.start_tab session not found";
    await listenForPeerTabStarts(async () => { throw new Error(error); });
    await mocks.listeners.get(REQUEST)!({ payload: { requestId: "request", targetWindow: "main", cmd: "pane.start_tab", args: { sessionId: "peer-pty" }, replyWindow: "main",
      expiresAt: Date.now() + 20_000, context: { command: "pane.start_tab", receivedAt: Date.now(), deadline: Date.now() + 25_000 } } });
    expect(mocks.emitTo).toHaveBeenCalledExactlyOnceWith("main", RESULT, { requestId: "request", ownerWindow: "main", error });
  });
});
