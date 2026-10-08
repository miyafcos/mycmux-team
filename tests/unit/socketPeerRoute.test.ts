import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../src/types";
import type { WindowFragment } from "../../src/lib/ipc";
import type { PeerSocketCommandRequest } from "../../src/lib/socketCommandWindows";
import {
  handleSocketCommand, listenForPeerSocketCommands, socketCommandWindowsForRequest,
} from "../../src/components/layout/socketCommands";
import { requestPeerSocketCommand, PEER_COMMAND_EVENTS } from "../../src/lib/socketCommandWindows";
import { webPaneCommandContext } from "../../src/components/workspace/webPaneCommandQueue";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useSessionAttentionStore, type SessionAttention } from "../../src/stores/sessionAttentionStore";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { resetPaneCloseOperationsForTests } from "../../src/lib/paneCloseOperation";

type Listener = { fn: (event: { payload: any }) => Promise<unknown> | void; label: string };
const mocks = vi.hoisted(() => ({
  label: "main", listeners: new Map<string, Set<Listener>>(),
  listen: vi.fn(), emitTo: vi.fn(), unlisten: vi.fn(), fragments: vi.fn(),
  buffer: vi.fn(), write: vi.fn(), guardedWrite: vi.fn(), kill: vi.fn(), invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen, emitTo: mocks.emitTo }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke,
}));
vi.mock("../../src/lib/windowContext", () => ({
  windowLabel: () => mocks.label, isMainWindow: () => mocks.label === "main",
}));
vi.mock("../../src/lib/ipc", async original => ({
  ...await original<typeof import("../../src/lib/ipc")>(),
  getWindowFragments: mocks.fragments, writeToSession: mocks.write,
  writeToSessionGuarded: mocks.guardedWrite, killSession: mocks.kill,
  getPtyMetadataSnapshot: async () => ({}), getSessionOutputSnapshot: async () => ({}),
}));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({
  hasTerminalBuffer: () => true, hasMountedTerminal: () => true,
  getTerminalBufferLines: mocks.buffer,
}));

const OWNER = "mycmux-w2";
const REQUEST = PEER_COMMAND_EVENTS.request, RESULT = PEER_COMMAND_EVENTS.response;
function workspace(prefix: string): Workspace {
  const tabs = ["target", "keeper"].map(suffix => ({
    id: `${prefix}-${suffix}-tab`, sessionId: `${prefix}-${suffix}-pty`, type: "terminal" as const,
    agentId: "shell", label: "Same label",
  }));
  return { id: `${prefix}-ws`, name: "Same workspace name", createdAt: 1, status: "running", gridTemplateId: "1x1",
    panes: [{ id: `${prefix}-pane`, sessionId: tabs[0].sessionId, agentId: "shell", tabs, activeTabId: tabs[0].id }],
    splitColumns: [[`${prefix}-pane`]],
  };
}
function fragment(label = OWNER, prefix = "peer"): WindowFragment {
  const ws = workspace(prefix);
  return { window_label: label, workspaces: [{ id: ws.id, name: ws.name, created_at: 1, grid_template_id: "1x1",
    panes: ws.panes.map(pane => ({ pane_id: pane.id, session_id: pane.sessionId, agent_id: pane.agentId, label: null,
      tabs: pane.tabs.map(tab => ({ tab_id: tab.id, session_id: tab.sessionId, agent_id: tab.agentId, type: tab.type })),
    })),
  }] };
}
async function deliver(label: string, event: string, payload: unknown) {
  for (const listener of [...(mocks.listeners.get(event) ?? [])]) {
    if (listener.label === label) await listener.fn({ payload });
  }
}
function request(cmd: string, args: Record<string, unknown>, id = "request"): PeerSocketCommandRequest {
  return { requestId: id, targetWindow: OWNER, replyWindow: "main", cmd, args,
    context: webPaneCommandContext(cmd), expiresAt: Date.now() + 20_000 };
}
function attention(id: string): SessionAttention {
  return { sessionId: "peer-target-pty", sessionEpoch: 4, attentionId: id, kind: "input",
    detail: null, sessionRevision: 6, uiState: "waiting", stateSince: 1, occurrenceOrder: 1 };
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.listeners.clear(); mocks.label = "main";
  mocks.listen.mockImplementation(async (event, fn, options) => {
    const listener = { fn, label: options?.target?.label ?? mocks.label };
    const listeners = mocks.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener); mocks.listeners.set(event, listeners);
    return () => { listeners.delete(listener); mocks.unlisten(); };
  });
  mocks.emitTo.mockResolvedValue(undefined);
  mocks.fragments.mockResolvedValue([fragment()]);
  mocks.buffer.mockImplementation(sessionId => [`${mocks.label}:${sessionId}:screen`]);
  mocks.write.mockResolvedValue(undefined); mocks.guardedWrite.mockResolvedValue({ sent: true }); mocks.kill.mockResolvedValue(undefined);
  mocks.invoke.mockImplementation(async (cmd, args) => cmd === "webpane_eval" ? { value: { tabId: args.tabId } }
    : cmd === "get_pty_metadata_snapshot" || cmd === "get_session_output_snapshot" ? {} : null);
  useWorkspaceListStore.setState({ workspaces: [workspace("local")], activeWorkspaceId: "local-ws", lastActivePaneByWorkspace: {} });
  useUiStore.setState({ activePaneId: "local-target-pty", focusRevision: 3 });
  useSessionAttentionStore.getState().resetForTests(); usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  useSettingsStore.setState({ declaredLaunchEnabled: false }); resetPaneCloseOperationsForTests();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); resetPaneCloseOperationsForTests(); });

const routes: Array<[string, Record<string, unknown>]> = [
  ["pane.read", { sessionId: "peer-target-pty", lines: 3 }],
  ["pane.send_text", { session_id: "peer-target-pty", text: "hello", expected_input_revision: 8 }],
  ["pane.close_tab", { sessionId: "peer-target-pty" }],
  ["pane.rename_tab", { session_id: "peer-target-pty", label: "renamed" }],
  ["pane.activate_tab", { sessionId: "peer-target-pty" }],
  ["pane.start_tab", { session_id: "peer-target-pty" }],
  ["pane.declare_tab", { pane_id: "peer-pane", label: "declared" }],
  ["pane.declare_tab", { sessionId: "peer-target-pty", label: "declared" }],
  ["pane.launch_declared", { tab_id: "peer-target-tab", request_id: "launch" }],
  ["pane.close_tabs", { tabIds: ["peer-target-tab"] }],
  ["pane.move", { paneId: "peer-pane", workspace_id: "peer-ws", toColumn: 0, toRow: 0 }],
  ["pane.move", { session_id: "peer-target-pty", to_column: 0, to_row: 0 }],
  ["pane.spawn", { anchorSessionId: "peer-target-pty", target: "shell" }],
  ["pane.spawn", { anchor_pane_id: "peer-pane", target: "shell" }],
  ["pane.spawn", { workspaceId: "peer-ws", target: "shell" }],
  ["pane.spawn_tab", { anchorSessionId: "peer-target-pty", commandArgv: ["echo", "hello"] }],
  ...["workspace.select", "select_workspace", "workspace.rename", "rename_workspace", "workspace.close", "close_workspace", "pane.list", "list_panes"]
    .map(cmd => [cmd, { id: "peer-ws", name: "renamed" }] as [string, Record<string, unknown>]),
  ["web.open", { anchor_session_id: "peer-target-pty", presetId: "chatgpt" }],
  ...["web.focus", "web.read", "web.close", "web.push", "web.navigate", "web.wait", "web.eval", "web.snapshot", "web.find", "web.click", "web.type", "web.key", "web.scroll", "web.upload", "web.screenshot", "web.downloads", "web.dialogs"]
    .map(cmd => [cmd, { tab_id: "peer-target-tab", text: "hello" }] as [string, Record<string, unknown>]),
  ["web.read", { anchorSessionId: "peer-target-pty", presetId: "chatgpt" }],
  ["web.push", { anchor_session_id: "peer-target-pty", text: "hello" }],
];

describe("explicit control API targets in another window", () => {
  it.each(routes)("forwards %s %j and returns the owner's result unchanged", async (cmd, args) => {
    const expected = cmd === "pane.start_tab" ? { started: true, sessionId: "peer-target-pty" }
      : { sessionId: "peer-target-pty", lines: ["owner lines"], extra: { unchanged: true } };
    const before = useWorkspaceListStore.getState().workspaces;
    const requestEvent = cmd.startsWith("pane.spawn") ? "mycmux://socket-spawn"
      : cmd === "pane.start_tab" ? "mycmux://socket-start-tab" : REQUEST;
    mocks.emitTo.mockImplementation(async (target, event, payload) => {
      expect(target).toBe(OWNER); expect(event).toBe(requestEvent);
      expect(payload).toMatchObject({ targetWindow: OWNER, replyWindow: "main", cmd,
        args: cmd === "pane.start_tab" ? { sessionId: "peer-target-pty" } : args });
      const responseEvent = event + "-result";
      await deliver("main", responseEvent, { requestId: payload.requestId, ownerWindow: OWNER, result: expected });
    });
    expect(await handleSocketCommand(cmd, args)).toEqual(expected);
    expect(useWorkspaceListStore.getState().workspaces).toBe(before);
    expect(useUiStore.getState().activePaneId).toBe("local-target-pty");
    expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.kill).not.toHaveBeenCalled(); expect(mocks.buffer).not.toHaveBeenCalled();
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });
  it.each(["pane.read", "pane.send_text", "pane.close_tab"])("rejects missing and ambiguous owners for %s before dispatch", async cmd => {
    const args = { sessionId: "peer-target-pty", text: "hello" };
    mocks.fragments.mockResolvedValue([fragment(), fragment("mycmux-w3")]);
    await expect(handleSocketCommand(cmd, args)).rejects.toThrow("conflicting window owners");
    mocks.fragments.mockResolvedValue([]);
    await expect(handleSocketCommand(cmd, args)).rejects.toThrow(cmd === "pane.close_tab" ? "session not found" : "not a known pane");
    expect(mocks.emitTo).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.kill).not.toHaveBeenCalled();
  });
  it("rejects a local/peer ownership conflict and ignores only the local stale fragment", () => {
    const args = { sessionId: "local-target-pty" }, local = [workspace("local")];
    expect(() => socketCommandWindowsForRequest("pane.send_text", args, local, [fragment(OWNER, "local")], "main")).toThrow("conflicting");
    expect([...socketCommandWindowsForRequest("pane.send_text", args, local, [fragment("main", "local")], "main").keys()]).toEqual(["main"]);
  });
  it("does not hide conflicting owners that publish the same workspace id", () => {
    expect(() => socketCommandWindowsForRequest("pane.declare_tab", { paneId: "peer-pane" }, [], [fragment(), fragment("mycmux-w3")], "main")).toThrow("conflicting");
  });
  it("rejects a supplied workspace that does not contain the requested session", async () => {
    await expect(handleSocketCommand("pane.move", { sessionId: "peer-target-pty", workspaceId: "local-ws", toColumn: 0, toRow: 0 })).rejects.toThrow("pane not found");
    await expect(handleSocketCommand("pane.spawn", { anchorSessionId: "peer-target-pty", workspaceId: "local-ws", target: "shell" })).rejects.toThrow("anchor session not found");
    expect(mocks.emitTo).not.toHaveBeenCalled();
  });
  it("fails a bulk request with a missing id before closing any known id", async () => {
    await expect(handleSocketCommand("pane.close_tabs", { tabIds: ["local-target-tab", "gone"] })).rejects.toThrow("tab not found: gone");
    expect(mocks.kill).not.toHaveBeenCalled(); expect(mocks.emitTo).not.toHaveBeenCalled();
  });
  it("preserves the declared-launch not-found response instead of executing a fallback", async () => {
    useSettingsStore.setState({ declaredLaunchEnabled: true });
    expect(await handleSocketCommand("pane.launch_declared", { tabId: "gone", requestId: "gone" })).toEqual({ ok: false, reason: "not-found" });
    expect(mocks.emitTo).not.toHaveBeenCalled();
  });
  it("rechecks local state after reading the fragments", async () => {
    mocks.fragments.mockImplementation(async () => {
      useWorkspaceListStore.setState({ workspaces: [workspace("peer")] });
      return [];
    });
    expect(await handleSocketCommand("pane.read", { sessionId: "peer-target-pty" })).toEqual({ sessionId: "peer-target-pty", lines: ["main:peer-target-pty:screen"] });
    expect(mocks.emitTo).not.toHaveBeenCalled();
  });
  it("keeps known local requests available and missing targets closed on registry failure", async () => {
    mocks.fragments.mockRejectedValue(new Error("registry unavailable"));
    expect(await handleSocketCommand("pane.read", { sessionId: "local-target-pty" })).toMatchObject({ sessionId: "local-target-pty" });
    await expect(handleSocketCommand("pane.read", { sessionId: "gone" })).rejects.toThrow("not a known pane");
    expect(mocks.emitTo).not.toHaveBeenCalled();
  });
});

/** Simulate independent window stores around the addressed event handler.
 * Real command handlers run; only the Tauri event bus and PTY IO are mocked. */
async function connectOwner(ready: () => Promise<void> = async () => {}) {
  const originList = useWorkspaceListStore.getState(), originUi = useUiStore.getState(), originAttention = useSessionAttentionStore.getState();
  mocks.label = OWNER;
  useWorkspaceListStore.setState({ workspaces: [workspace("peer")], activeWorkspaceId: "peer-ws" });
  useUiStore.setState({ activePaneId: "peer-keeper-pty", focusRevision: 11 });
  useSessionAttentionStore.setState({ attentionBySession: { "peer-target-pty": attention("owner-attention") } });
  let ownerList = useWorkspaceListStore.getState(), ownerUi = useUiStore.getState(), ownerAttention = useSessionAttentionStore.getState();
  await listenForPeerSocketCommands(ready);
  useWorkspaceListStore.setState(originList); useUiStore.setState(originUi); useSessionAttentionStore.setState(originAttention); mocks.label = "main";
  mocks.emitTo.mockImplementation(async (target, event, payload) => {
    if (event === RESULT) return deliver(target, event, payload);
    expect(event).toBe(REQUEST); expect(target).toBe(OWNER);
    const list = useWorkspaceListStore.getState(), ui = useUiStore.getState(), att = useSessionAttentionStore.getState();
    mocks.label = OWNER;
    useWorkspaceListStore.setState(ownerList); useUiStore.setState(ownerUi); useSessionAttentionStore.setState(ownerAttention);
    try { await deliver(target, event, payload); }
    finally {
      ownerList = useWorkspaceListStore.getState(); ownerUi = useUiStore.getState(); ownerAttention = useSessionAttentionStore.getState();
      useWorkspaceListStore.setState(list); useUiStore.setState(ui); useSessionAttentionStore.setState(att); mocks.label = "main";
    }
  });
  return () => ownerList;
}

describe("owner-window execution with real socket handlers", () => {
  it("pane.read returns the moved PTY's own screen lines, never another seat's lines", async () => {
    await connectOwner();
    const result = await handleSocketCommand("pane.read", { sessionId: "peer-target-pty", lines: 2 });
    expect(result).toEqual({ sessionId: "peer-target-pty", lines: [`${OWNER}:peer-target-pty:screen`] });
    expect(mocks.buffer).toHaveBeenCalledExactlyOnceWith("peer-target-pty", 2);
    expect(JSON.stringify(result)).not.toContain("local-target-pty");
    expect(JSON.stringify(result)).not.toContain("peer-keeper-pty");
  });
  it("send_text validates the owner's attention and input revision and confirms Enter there", async () => {
    await connectOwner();
    mocks.buffer.mockReturnValueOnce(["ready"]).mockReturnValueOnce(["ready hello"]).mockReturnValueOnce(["ready hello"]).mockReturnValue(["working"]);
    const result = await handleSocketCommand("pane.send_text", { sessionId: "peer-target-pty", text: "hello", enter: true,
      expected_attention_id: "owner-attention", expected_session_epoch: 4, expected_session_revision: 6, expected_input_revision: 8 });
    expect(result).toEqual({ sessionId: "peer-target-pty", bytes: 6, ok: true, confirmed: true, attempts: 1 });
    expect(mocks.guardedWrite.mock.calls).toEqual([
      ["peer-target-pty", "hello", "owner-attention", 4, 6, 8],
      ["peer-target-pty", "\r", "owner-attention", 4, 6, 9],
    ]);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.buffer.mock.calls.every(([sessionId]) => sessionId === "peer-target-pty")).toBe(true);
  });
  it("returns owner-side attention and native input-revision refusals unchanged", async () => {
    await connectOwner();
    const args = { sessionId: "peer-target-pty", text: "hello", expected_attention_id: "wrong",
      expected_session_epoch: 4, expected_session_revision: 6, expected_input_revision: 8 };
    expect(await handleSocketCommand("pane.send_text", args)).toEqual({ sent: false, reason: "attention_id", current: null });
    expect(mocks.guardedWrite).not.toHaveBeenCalled();
    mocks.guardedWrite.mockResolvedValue({ sent: false, reason: "input_revision" });
    expect(await handleSocketCommand("pane.send_text", { ...args, expected_attention_id: "owner-attention" })).toEqual({ sent: false, reason: "input_revision" });
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("close_tab closes only the owner's requested tab and returns the existing identity keys", async () => {
    const owner = await connectOwner();
    expect(await handleSocketCommand("pane.close_tab", { sessionId: "peer-target-pty" })).toEqual({ workspaceId: "peer-ws", paneId: "peer-pane", tabId: "peer-target-tab" });
    expect(mocks.kill).toHaveBeenCalledExactlyOnceWith("peer-target-pty");
    expect(owner().workspaces[0].panes[0].tabs.map(tab => tab.sessionId)).toEqual(["peer-keeper-pty"]);
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs).toHaveLength(2);
  });
  it("rename and move operate on the owner's workspace with equal labels in the leader", async () => {
    const owner = await connectOwner();
    expect(await handleSocketCommand("pane.rename_tab", { sessionId: "peer-target-pty", label: "Renamed" })).toMatchObject({ sessionId: "peer-target-pty", label: "Renamed" });
    expect(owner().workspaces[0].panes[0].tabs[0].label).toBe("Renamed");
    expect(await handleSocketCommand("pane.move", { paneId: "peer-pane", toColumn: 0, toRow: 0 })).toEqual({ workspaceId: "peer-ws", paneId: "peer-pane", splitColumns: [["peer-pane"]] });
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs[0].label).toBe("Same label");
  });
  it("declares and launches a tab in the owner without changing either foreground", async () => {
    const owner = await connectOwner(); useSettingsStore.setState({ declaredLaunchEnabled: true });
    const declared = await handleSocketCommand("pane.declare_tab", { paneId: "peer-pane", label: "Planned" }) as { tabId: string };
    expect(owner().workspaces[0].panes[0].tabs.find(tab => tab.id === declared.tabId)).toMatchObject({ label: "Planned", lifecycle: "declared" });
    const published = fragment();
    published.workspaces[0].panes[0].tabs!.push({ tab_id: declared.tabId, session_id: "declared-pty", agent_id: "shell" });
    mocks.fragments.mockResolvedValue([published]);
    expect(await handleSocketCommand("pane.launch_declared", { tabId: declared.tabId, requestId: "peer-declaration" })).toMatchObject({ ok: true, tabId: declared.tabId });
    expect(owner().workspaces[0].panes[0].activeTabId).toBe("peer-target-tab");
    expect(useUiStore.getState().activePaneId).toBe("local-target-pty");
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs).toHaveLength(2);
  });
  it("renames and lists an explicit peer workspace and preserves its active-workspace close guard", async () => {
    const owner = await connectOwner();
    expect(await handleSocketCommand("rename_workspace", { id: "peer-ws", name: "Owner name" })).toEqual({ id: "peer-ws", name: "Owner name" });
    expect(owner().workspaces[0].name).toBe("Owner name");
    expect(await handleSocketCommand("list_panes", { id: "peer-ws" })).toMatchObject({ workspaceId: "peer-ws", activePaneId: "peer-keeper-pty" });
    expect(await handleSocketCommand("select_workspace", { id: "peer-ws" })).toEqual({ activeWorkspaceId: "peer-ws", requestedWorkspaceId: "peer-ws", foregroundChanged: false });
    await expect(handleSocketCommand("close_workspace", { id: "peer-ws" })).rejects.toThrow("refuses the active workspace");
    expect(mocks.kill).not.toHaveBeenCalled();
  });
  it("executes explicit Web tab operations in the owner and keeps the original native budget", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    await connectOwner(async () => {
      const ws = workspace("peer"); ws.panes[0].tabs[0].type = "web";
      ws.panes[0].tabs[0].presetId = "chatgpt";
      useWorkspaceListStore.setState({ workspaces: [ws] }); vi.setSystemTime(5000);
    });
    mocks.invoke.mockImplementation(async (cmd, args) => ({ tabId: args.tabId, owner: mocks.label, cmd }));
    expect(await handleSocketCommand("web.screenshot", { tabId: "peer-target-tab" })).toEqual({ tabId: "peer-target-tab", owner: OWNER, cmd: "webpane_screenshot" });
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("webpane_screenshot", { tabId: "peer-target-tab", command: "web.screenshot", budgetMs: 15000 });
    expect(useUiStore.getState().activePaneId).toBe("local-target-pty");
  });
  it("caps a peer Web eval at the request deadline while preserving its response shape", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    await connectOwner(async () => {
      const ws = workspace("peer"); ws.panes[0].tabs[0].type = "web";
      useWorkspaceListStore.setState({ workspaces: [ws] }); vi.setSystemTime(5000);
    });
    mocks.invoke.mockResolvedValue({ value: "owner result" });
    expect(await handleSocketCommand("web.eval", { tabId: "peer-target-tab", script: "return 1", timeoutMs: 25000 })).toEqual({ value: "owner result" });
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("webpane_eval", { tabId: "peer-target-tab", script: "return 1", timeoutMs: 15000 });
  });
  it("keeps declared-launch caching bound to its own tab as well as the caller request id", async () => {
    const ws = workspace("local"); ws.panes[0].tabs.forEach(tab => { tab.lifecycle = "declared"; });
    useWorkspaceListStore.setState({ workspaces: [ws] }); useSettingsStore.setState({ declaredLaunchEnabled: true });
    const first = await handleSocketCommand("pane.launch_declared", { tabId: "local-target-tab", requestId: "same-caller-id" });
    const second = await handleSocketCommand("pane.launch_declared", { tabId: "local-keeper-tab", requestId: "same-caller-id" });
    expect(first).toMatchObject({ ok: true, tabId: "local-target-tab" });
    expect(second).toMatchObject({ ok: true, tabId: "local-keeper-tab" });
  });
  it("bulk-closes targets in local and peer windows and combines the existing summary keys", async () => {
    const owner = await connectOwner();
    const result = await handleSocketCommand("pane.close_tabs", { tabIds: ["local-target-tab", "peer-target-tab", "peer-target-tab"] });
    expect(result).toEqual({ moved: [], closed: ["local-target-tab", "peer-target-tab"], skipped: [], removedPanes: [],
      retainedEmptyPanes: [], removedColumns: 0, affectedWorkspaces: ["local-ws", "peer-ws"], staleRevision: false, victims: [] });
    expect(mocks.kill.mock.calls.map(([id]) => id)).toEqual(["local-target-pty", "peer-target-pty"]);
    expect(owner().workspaces[0].panes[0].tabs).toHaveLength(1);
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs).toHaveLength(1);
  });
  it("checks the peer's last-tab guard before any part of a cross-window bulk close", async () => {
    await connectOwner(() => {
      const ws = workspace("peer"); ws.panes[0].tabs = ws.panes[0].tabs.slice(0, 1);
      useWorkspaceListStore.setState({ workspaces: [ws] }); return Promise.resolve();
    });
    await expect(handleSocketCommand("pane.close_tabs", { tabIds: ["local-target-tab", "peer-target-tab"] })).rejects.toThrow("refusing to close the last tab");
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(useWorkspaceListStore.getState().workspaces[0].panes[0].tabs).toHaveLength(2);
  });
  it.each(["pane.read", "pane.send_text", "pane.close_tab"])("rechecks a moved/closed %s target after hydration and never forwards again", async cmd => {
    await connectOwner(async () => { useWorkspaceListStore.setState({ workspaces: [] }); });
    await expect(handleSocketCommand(cmd, { sessionId: "peer-target-pty", text: "hello" })).rejects.toThrow(cmd === "pane.close_tab" ? "session not found" : "not a known pane");
    expect(mocks.buffer).not.toHaveBeenCalled(); expect(mocks.kill).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.fragments).toHaveBeenCalledOnce();
  });
  it.each(["pane.read", "pane.send_text", "pane.close_tab"])("still executes local %s in the current window", async cmd => {
    const result = await handleSocketCommand(cmd, { sessionId: "local-target-pty", text: "hello" });
    expect(result).toBeDefined(); expect(mocks.emitTo).not.toHaveBeenCalled();
    if (cmd === "pane.read") expect(result).toEqual({ sessionId: "local-target-pty", lines: ["main:local-target-pty:screen"] });
    if (cmd === "pane.send_text") expect(mocks.write).toHaveBeenCalledExactlyOnceWith("local-target-pty", "hello");
    if (cmd === "pane.close_tab") expect(mocks.kill).toHaveBeenCalledExactlyOnceWith("local-target-pty");
  });
});

describe("peer request lifetime and send safety", () => {
  it("ignores other request ids and owners and cleans up its addressed response listener", async () => {
    mocks.emitTo.mockImplementation(async (_target, _event, payload) => {
      await deliver("main", RESULT, { requestId: "wrong", ownerWindow: OWNER, result: "wrong seat" });
      await deliver("main", RESULT, { requestId: payload.requestId, ownerWindow: "mycmux-w3", result: "wrong owner" });
      await deliver("main", RESULT, { requestId: payload.requestId, ownerWindow: OWNER, result: { lines: ["correct"] } });
    });
    expect(await requestPeerSocketCommand(OWNER, "pane.read", { sessionId: "peer-target-pty" }, webPaneCommandContext("pane.read"))).toEqual({ lines: ["correct"] });
    expect(mocks.listeners.get(RESULT)?.size).toBe(0); expect(mocks.unlisten).toHaveBeenCalledOnce();
  });
  it.each(["pane.read", "pane.send_text", "pane.close_tab"])("times out %s without retry or local execution and rejects late replies for the next request", async cmd => {
    vi.useFakeTimers();
    const pending = handleSocketCommand(cmd, { sessionId: "peer-target-pty", text: "hello" });
    const failed = expect(pending).rejects.toThrow(`${cmd} owner window did not respond`);
    await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledOnce());
    const expired = mocks.emitTo.mock.calls[0][2];
    await vi.advanceTimersByTimeAsync(20_000); await failed;
    expect(mocks.listeners.get(RESULT)?.size).toBe(0);
    mocks.emitTo.mockImplementation(async (_target, _event, payload) => {
      await deliver("main", RESULT, { requestId: expired.requestId, ownerWindow: OWNER, result: "late old reply" });
      await deliver("main", RESULT, { requestId: payload.requestId, ownerWindow: OWNER, result: { correct: true } });
    });
    expect(await handleSocketCommand(cmd, { sessionId: "peer-target-pty", text: "hello" })).toEqual({ correct: true });
    expect(mocks.kill).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.buffer).not.toHaveBeenCalled();
  });
  it("cleans up a failed emit and returns its error without another dispatch", async () => {
    mocks.emitTo.mockRejectedValue(new Error("window gone"));
    await expect(handleSocketCommand("pane.read", { sessionId: "peer-target-pty" })).rejects.toThrow("window gone");
    expect(mocks.unlisten).toHaveBeenCalledOnce(); expect(mocks.emitTo).toHaveBeenCalledOnce();
  });
  it("rejects a response past the deadline even if the timeout callback has not run", async () => {
    vi.useFakeTimers();
    mocks.emitTo.mockImplementation(async (_target, _event, payload) => {
      vi.setSystemTime(payload.expiresAt);
      await deliver("main", RESULT, { requestId: payload.requestId, ownerWindow: OWNER, result: "too late" });
    });
    await expect(handleSocketCommand("pane.read", { sessionId: "peer-target-pty" })).rejects.toThrow("owner window did not respond");
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });
  it("refuses expired requests after hydration and ignores the wrong destination and duplicate request", async () => {
    vi.useFakeTimers(); mocks.label = OWNER;
    useWorkspaceListStore.setState({ workspaces: [workspace("peer")] });
    await listenForPeerSocketCommands(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    const payload = request("pane.send_text", { sessionId: "peer-target-pty", text: "hello" });
    await deliver(OWNER, REQUEST, { ...payload, targetWindow: "mycmux-w3" });
    expect(mocks.emitTo).not.toHaveBeenCalled();
    await deliver(OWNER, REQUEST, payload);
    expect(mocks.emitTo).toHaveBeenCalledWith("main", RESULT, expect.objectContaining({ error: "pane.send_text owner request expired" }));
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("executes a duplicated close request only once", async () => {
    mocks.label = OWNER; useWorkspaceListStore.setState({ workspaces: [workspace("peer")] });
    await listenForPeerSocketCommands();
    const payload = request("pane.close_tab", { sessionId: "peer-target-pty" });
    await deliver(OWNER, REQUEST, payload); await deliver(OWNER, REQUEST, payload);
    expect(mocks.kill).toHaveBeenCalledExactlyOnceWith("peer-target-pty");
    expect(mocks.emitTo).toHaveBeenCalledOnce();
  });
  it("refuses a queued send if its target leaves the window before the prior send completes", async () => {
    let finish!: () => void;
    mocks.write.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = handleSocketCommand("pane.send_text", { sessionId: "local-target-pty", text: "first" });
    const second = handleSocketCommand("pane.send_text", { sessionId: "local-target-pty", text: "second" });
    const failed = expect(second).rejects.toThrow("not a known pane");
    await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledOnce());
    useWorkspaceListStore.setState({ workspaces: [] }); finish();
    await first; await failed;
    expect(mocks.write.mock.calls).toEqual([["local-target-pty", "first"]]);
  });
  it("does not write an expired peer send after waiting behind another send", async () => {
    vi.useFakeTimers(); let finish!: () => void;
    mocks.write.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const execution = { context: webPaneCommandContext("pane.send_text"), expiresAt: Date.now() + 20_000 };
    const first = handleSocketCommand("pane.send_text", { sessionId: "local-target-pty", text: "first" }, execution);
    await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledOnce());
    const second = handleSocketCommand("pane.send_text", { sessionId: "local-target-pty", text: "expired" }, execution);
    const failed = expect(second).rejects.toThrow("owner request expired");
    await vi.advanceTimersByTimeAsync(0); vi.setSystemTime(execution.expiresAt); finish();
    await first; await failed;
    expect(mocks.write.mock.calls).toEqual([["local-target-pty", "first"]]);
  });
  it("does not send Enter after the target has moved out during text echo", async () => {
    await connectOwner();
    mocks.buffer.mockReturnValueOnce(["ready"]).mockReturnValue(["ready hello"]);
    mocks.write.mockImplementation(async () => { useWorkspaceListStore.setState({ workspaces: [] }); });
    await expect(handleSocketCommand("pane.send_text", { sessionId: "peer-target-pty", text: "hello", enter: true })).rejects.toThrow("not a known pane");
    expect(mocks.write.mock.calls).toEqual([["peer-target-pty", "hello"]]);
  });
});
