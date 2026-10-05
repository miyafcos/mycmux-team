// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ listeners: new Map<string, Set<(event: { payload: any }) => void>>(),
  targets: new WeakMap<Function, string>(), broadcastTargetedDelivery: false,
  attachments: vi.fn(), attachmentReady: null as Promise<void> | null, invoke: vi.fn(), emitTo: vi.fn(), failShow: false, failReceipt: false, escape: true }));
vi.mock("@tauri-apps/api/core", async (original) => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, callback: (event: { payload: any }) => void, options?: { target: { kind: string; label: string } }) => {
    if (options?.target.kind === "Window") mocks.targets.set(callback, options.target.label);
    const callbacks = mocks.listeners.get(event) ?? new Set(); callbacks.add(callback); mocks.listeners.set(event, callbacks);
    return () => { callbacks.delete(callback); };
  }, emit: async () => {}, emitTo: mocks.emitTo,
}));
vi.mock("../../src/lib/windowContext", () => ({ windowLabel: () => "main", isMainWindow: () => true }));
vi.mock("../../src/lib/tearout/sessionAttachment", () => ({ expectTearoutAttachments: (ids: string[]) => { mocks.attachments(ids); return { ready: mocks.attachmentReady ?? Promise.resolve(), dispose: () => {} }; }, rememberTearoutDormantSessions: vi.fn() }));
vi.mock("../../src/components/terminal/terminalCache", async (original) => ({
  ...await original<typeof import("../../src/components/terminal/terminalCache")>(), evictTerminalCache: vi.fn(),
}));
import { installTearoutRuntime, tearoutTab, tearoutPane, useTearoutStore, isTearoutChild, markTearoutChildReady } from "../../src/lib/tearout/runtime";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useUiStore } from "../../src/stores/uiStore";
import { restoreTearoutSource, removeTearoutTab } from "../../src/lib/tearout/model";
import { evictTerminalCache } from "../../src/components/terminal/terminalCache";
import { buildWindowFragment, toTransferConfig } from "../../src/components/layout/SocketListener";
import type { Workspace } from "../../src/types";
import type { WorkspaceConfig } from "../../src/lib/ipc";

function dispatch(event: string, payload: unknown, recipient?: string) {
  for (const callback of [...(mocks.listeners.get(event) ?? [])]) {
    const target = mocks.targets.get(callback);
    // Tauri's default Any subscription receives an emitTo for another window.
    if (!recipient || !target || target === recipient) callback({ payload });
  }
}
function workspace(id = "source"): Workspace {
  return { id, name: id, createdAt: 1, status: "running", gridTemplateId: "1x1", splitColumns: [["pane"]],
    columnWidths: [1], rowHeightsPerCol: [[1]], panes: [{ id: "pane", agentId: "shell", sessionId: "pty-original",
      activeTabId: "tab", tabs: [{ id: "tab", agentId: "shell", sessionId: "pty-original", type: "terminal", label: "keep title" }] }] };
}
function config(ws: Workspace): WorkspaceConfig {
  return { id: ws.id, name: ws.name, created_at: ws.createdAt, grid_template_id: ws.gridTemplateId,
    panes: ws.panes.map((pane) => ({ pane_id: pane.id, agent_id: pane.agentId, session_id: pane.sessionId,
      tabs: pane.tabs.map((tab) => ({ tab_id: tab.id, agent_id: tab.agentId, session_id: tab.sessionId, type: tab.type })) })) };
}
let stop: () => void;
beforeEach(() => {
  mocks.listeners.clear(); vi.clearAllMocks(); mocks.failShow = false; mocks.failReceipt = false; mocks.escape = true;
  mocks.broadcastTargetedDelivery = false; mocks.attachmentReady = null;
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
  useSettingsStore.setState({ nativePaneTearoutEnabled: true });
  useWorkspaceListStore.setState({ workspaces: [workspace()], activeWorkspaceId: "source" });
  useUiStore.setState({ activePaneId: "pty-original" });
  mocks.emitTo.mockImplementation(async (_label: string, event: string, payload: any) => {
    if (event.endsWith("tearout-delivery") && mocks.broadcastTargetedDelivery) dispatch(event, payload, _label);
    if (event.endsWith("tearout-delivery")) dispatch("mycmux://tearout-receipt", { token: payload.token, ok: !mocks.failReceipt });
    if (event.endsWith("tearout-revoke")) dispatch("mycmux://tearout-receipt", { token: payload.ack, ok: true });
  });
  mocks.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "tearout_take_spare") return "mycmux-w42";
    if (command === "is_session_alive") return true;
    if (command === "tearout_show" && mocks.failShow) throw new Error("synthetic show failure");
    if (command === "tearout_start_move") {
      expect(useWorkspaceListStore.getState().workspaces).toEqual([]);
      const end = { ...args, x: 900, y: 700, phase: "end", at: Date.now(), escaped: mocks.escape,
        receiver: null, client_x: -1, client_y: -1, approval: null, native_started_at: Date.now(), error: null,
        scale: 1.5, monitor: "DISPLAY1", focus_stolen: false };
      dispatch("mycmux://tearout-native", end); dispatch("mycmux://tearout-native", end);
    }
    return undefined;
  });
  stop = installTearoutRuntime({ serialize: config, publish: async () => {} });
});
afterEach(async () => { stop(); await Promise.resolve(); useSettingsStore.setState({ nativePaneTearoutEnabled: false }); });
const item = { kind: "tab" as const, workspaceId: "source", paneId: "pane", tabId: "tab", label: "Terminal" };
const gap = { x: 0, y: 0, width: 90, height: 30 };
describe("tear-out failure and Esc at the actual transfer entry", () => {
  it("accepts a delivery addressed to this window, preserving its existing workspace", async () => {
    const incoming = config(workspace("incoming"));
    incoming.panes[0].tabs![0] = { ...incoming.panes[0].tabs![0], tab_id: "incoming-tab", session_id: "pty-incoming" };
    dispatch("mycmux://tearout-delivery", { token: "own-delivery", source: "peer", configs: [incoming] }, "main");
    await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith("peer", "mycmux://tearout-receipt", { token: "own-delivery", ok: true }), { timeout: 2000 });
    expect(useWorkspaceListStore.getState().workspaces.map((ws) => ws.id)).toEqual(["source", "incoming"]);
  });
  it("ignores an outgoing request addressed to a different window", async () => {
    const before = useWorkspaceListStore.getState().workspaces;
    dispatch("mycmux://tearout-outgoing", { token: "other-request", deliveryToken: "other-delivery", requester: "parent",
      approval: { receiver: "peer", token: "painted", target: { kind: "workspace" } } }, "moving-child");
    await Promise.resolve(); await Promise.resolve();
    expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "tearout_prepare")).toBe(false);
  });
  it.each(["whole-workspace", "one-of-two-panes", "one-of-two-tabs"] as const)(
    "kept window removes the moved tab from the source list and published fragment: %s", async (shape) => {
      mocks.broadcastTargetedDelivery = true;
      const source = workspace();
      const neighbor = workspace("neighbor");
      neighbor.panes[0] = { ...neighbor.panes[0], id: "neighbor-pane", sessionId: "pty-neighbor",
        activeTabId: "neighbor-tab", tabs: [{ ...neighbor.panes[0].tabs[0], id: "neighbor-tab", sessionId: "pty-neighbor" }] };
      neighbor.splitColumns = [["neighbor-pane"]];
      const sibling = { ...source.panes[0].tabs[0], id: "sibling-tab", sessionId: "pty-sibling" };
      if (shape === "one-of-two-panes") {
        source.panes.push({ ...source.panes[0], id: "sibling-pane", sessionId: sibling.sessionId,
          activeTabId: sibling.id, tabs: [sibling] });
        source.splitColumns = [["pane"], ["sibling-pane"]];
        source.columnWidths = [1, 1]; source.rowHeightsPerCol = [[1], [1]];
      } else if (shape === "one-of-two-tabs") source.panes[0].tabs.push(sibling);
      useWorkspaceListStore.setState({ workspaces: [neighbor, source], activeWorkspaceId: source.id });
      const published: ReturnType<typeof buildWindowFragment>[] = [];
      stop();
      stop = installTearoutRuntime({ serialize: toTransferConfig, publish: async () => {
        const fragment = buildWindowFragment("transfer");
        published.push(fragment);
        await mocks.invoke("publish_window_fragment", { fragment });
      } });
      mocks.invoke.mockImplementation(async (command: string, args: any) => {
        if (command === "tearout_take_spare") return "mycmux-w42";
        if (command === "is_session_alive") return true;
        if (command === "tearout_start_move") dispatch("mycmux://tearout-native", {
          ...args, phase: "end", at: Date.now(), escaped: false, approval: null, error: null,
        });
      });
      await tearoutTab(item, gap, { x: 10, y: 10 });
      const state = useWorkspaceListStore.getState();
      expect(state.workspaces.map((ws) => ws.id)).toEqual(shape === "whole-workspace" ? ["neighbor"] : ["neighbor", "source"]);
      expect(state.workspaces.flatMap((ws) => ws.panes.flatMap((pane) => pane.tabs)).map((tab) => tab.id))
        .toEqual(shape === "whole-workspace" ? ["neighbor-tab"] : ["neighbor-tab", "sibling-tab"]);
      expect(published.length).toBeGreaterThan(0);
      for (const fragment of [...published, buildWindowFragment("transfer")]) {
        expect(fragment.workspaces.flatMap((ws) => ws.panes.flatMap((pane) => pane.tabs ?? [])).map((tab) => tab.tab_id))
          .toEqual(shape === "whole-workspace" ? ["neighbor-tab"] : ["neighbor-tab", "sibling-tab"]);
      }
      const delivered = mocks.emitTo.mock.calls.find(([, event]) => event.endsWith("tearout-delivery"))![2];
      expect(delivered.configs[0].panes[0].tabs).toEqual([expect.objectContaining({ tab_id: "tab", session_id: "pty-original" })]);
      expect(mocks.invoke).toHaveBeenCalledWith("tearout_settle", { label: "mycmux-w42" });
      expect(mocks.invoke.mock.calls.some(([cmd, args]) => cmd === "tearout_phase" && args.phase === "rolled_back")).toBe(false);
    },
  );
  it("rejected duplicate ids or vanished targets leave the receiver unchanged", async () => {
    const before = useWorkspaceListStore.getState().workspaces;
    dispatch("mycmux://tearout-delivery", { token: "duplicate", source: "other", configs: [config(before[0])] });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
    const incoming = config(workspace("incoming"));
    incoming.panes[0].tabs![0].tab_id = "incoming-tab";
    dispatch("mycmux://tearout-delivery", { token: "missing-target", source: "other", configs: [incoming],
      placement: { kind: "pane-zone", workspaceId: "source", paneId: "deleted-pane", zone: "left" } });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
    expect(mocks.emitTo.mock.calls.filter(([, event, payload]) => event.endsWith("tearout-receipt") && payload.ok === false)).toHaveLength(2);
  });
  it("restores the last pane, geometry, selection and session once after native Esc", async () => {
    const before = useWorkspaceListStore.getState().workspaces;
    await tearoutTab(item, gap, { x: 10, y: 10 });
    expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("source");
    expect(useUiStore.getState().activePaneId).toBe("pty-original");
    expect(useTearoutStore.getState().gap).toBeNull();
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "tearout_retire")).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([cmd, args]) => cmd === "tearout_phase" && args.phase === "rolled_back")).toHaveLength(1);
    const sent = mocks.emitTo.mock.calls.find(([, event]) => event.endsWith("tearout-delivery"))![2];
    expect(sent.configs[0].panes[0].tabs[0].session_id).toBe("pty-original");
  });
  it("a show failure keeps the original untouched and retires the reserved child", async () => {
    mocks.failShow = true;
    const before = useWorkspaceListStore.getState().workspaces;
    await expect(tearoutTab(item, gap, { x: 10, y: 10 })).rejects.toThrow("synthetic show failure");
    expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
    expect(mocks.emitTo).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "tearout_retire")).toHaveLength(1);
  });
  it("a rejected receipt rolls back once even after an ordinary release", async () => {
    mocks.escape = false; mocks.failReceipt = true;
    const before = useWorkspaceListStore.getState().workspaces;
    await tearoutTab(item, gap, { x: 10, y: 10 });
    expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
    expect(mocks.invoke.mock.calls.filter(([cmd, args]) => cmd === "tearout_phase" && args.phase === "rolled_back")).toHaveLength(1);
  });
  it("revokes late docking and its escrow before restoring the source after the parent timeout", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = useWorkspaceListStore.getState().workspaces;
    try {
      const invoke = mocks.invoke.getMockImplementation()!;
      mocks.invoke.mockImplementation(async (command: string, args: any) => {
        if (command === "tearout_start_move") {
          dispatch("mycmux://tearout-native", { ...args, phase: "end", at: Date.now(), escaped: false,
            receiver: "peer", client_x: 10, client_y: 10, native_started_at: Date.now(), error: null,
            scale: 1, monitor: "DISPLAY1", focus_stolen: false,
            approval: { receiver: "peer", token: "painted", target: { kind: "workspace" } } });
          return;
        }
        return invoke(command, args);
      });
      mocks.emitTo.mockImplementation(async (_label: string, event: string, payload: any) => {
        if (event.endsWith("tearout-delivery") || event.endsWith("tearout-receipt")) {
          dispatch("mycmux://tearout-receipt", { token: payload.token, ok: true });
        }
        if (event.endsWith("tearout-revoke")) dispatch("mycmux://tearout-revoke", payload);
      });
      const pending = tearoutTab(item, gap, { x: 10, y: 10 });
      await vi.advanceTimersByTimeAsync(19000);
      expect(useWorkspaceListStore.getState().workspaces).toEqual([]);
      const request = mocks.emitTo.mock.calls.find(([, event]) => event.endsWith("tearout-outgoing"))![2];
      expect(request.deliveryToken).toBeTruthy();
      expect(request.deliveryToken).not.toBe(request.token);
      await vi.advanceTimersByTimeAsync(1000);
      await pending;
      expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
      const revokeIndex = mocks.emitTo.mock.calls.findIndex(([, event, payload]) =>
        event.endsWith("tearout-revoke") && payload.token === request.deliveryToken);
      const retireIndex = mocks.invoke.mock.calls.findIndex(([command]) => command === "tearout_retire");
      expect(revokeIndex).toBeGreaterThanOrEqual(0);
      expect(mocks.emitTo.mock.invocationCallOrder[revokeIndex]).toBeLessThan(mocks.invoke.mock.invocationCallOrder[retireIndex]);
      expect(mocks.invoke).toHaveBeenCalledWith("tearout_phase", { id: request.deliveryToken, phase: "rolled_back" });
      expect(mocks.invoke).toHaveBeenCalledWith("tearout_forget", { id: request.deliveryToken });
      const receipts = mocks.emitTo.mock.calls.filter(([, event]) => event.endsWith("tearout-receipt")).length;
      dispatch("mycmux://tearout-delivery", { token: request.deliveryToken, source: "late", configs: [config(workspace("late"))] });
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.emitTo.mock.calls.filter(([, event]) => event.endsWith("tearout-receipt"))).toHaveLength(receipts);
      expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
    } finally { warning.mockRestore(); vi.useRealTimers(); }
  });
  it("keeps delivery receipts distinct from docking receipts when the moving window requests itself", async () => {
    dispatch("mycmux://tearout-outgoing", { token: "dock-request", deliveryToken: "dock-delivery", requester: "main",
      approval: { receiver: "peer", token: "painted", target: { kind: "workspace" } } });
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("tearout_retire", expect.objectContaining({ receiptToken: "dock-request" })), { timeout: 2000 });
    expect(mocks.emitTo).toHaveBeenCalledWith("peer", "mycmux://tearout-delivery", expect.objectContaining({ token: "dock-delivery" }));
    expect(mocks.invoke).toHaveBeenCalledWith("tearout_prepare", expect.objectContaining({ id: "dock-delivery" }));
    expect(mocks.invoke).toHaveBeenCalledWith("tearout_retire", expect.objectContaining({ finalizeLabel: "peer", finalizeToken: "dock-delivery" }));
  });
  it("retains receiver undo when another window still awaits the dock receipt", async () => {
    dispatch("mycmux://tearout-outgoing", { token: "parent-request", deliveryToken: "parent-delivery", requester: "parent",
      approval: { receiver: "peer", token: "painted", target: { kind: "workspace" } } });
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("tearout_retire", expect.objectContaining({ receiptToken: "parent-request" })), { timeout: 2000 });
    expect(mocks.invoke).toHaveBeenCalledWith("tearout_retire", expect.objectContaining({ finalizeLabel: undefined, finalizeToken: undefined }));
  });
  it("the parent finalizes receiver undo only after the successful dock receipt", async () => {
    const invoke = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: any) => {
      if (command === "tearout_start_move") {
        dispatch("mycmux://tearout-native", { ...args, phase: "end", at: Date.now(), escaped: false,
          receiver: "peer", client_x: 10, client_y: 10, native_started_at: Date.now(), error: null,
          scale: 1, monitor: "DISPLAY1", focus_stolen: false,
          approval: { receiver: "peer", token: "painted", target: { kind: "workspace" } } });
        return;
      }
      return invoke(command, args);
    });
    const emitTo = mocks.emitTo.getMockImplementation()!;
    let request: any;
    let confirm = () => {};
    const requested = new Promise<void>((resolve) => { confirm = resolve; });
    mocks.emitTo.mockImplementation(async (label: string, event: string, payload: any) => {
      if (event.endsWith("tearout-outgoing")) { request = payload; confirm(); return; }
      return emitTo(label, event, payload);
    });
    const pending = tearoutTab(item, gap, { x: 10, y: 10 });
    await requested;
    expect(mocks.emitTo.mock.calls.some(([, event]) => event.endsWith("tearout-finalize"))).toBe(false);
    dispatch("mycmux://tearout-receipt", { token: request.token, ok: true });
    await pending;
    expect(mocks.emitTo).toHaveBeenCalledWith("peer", "mycmux://tearout-finalize", { token: request.deliveryToken });
    expect(mocks.invoke.mock.calls.some(([cmd, args]) => cmd === "tearout_phase" && args.phase === "rolled_back")).toBe(false);
  });
  it("restoring a removed workspace keeps its position and unrelated panes", () => {
    const before = workspace();
    const other = { ...workspace("other"), panes: [] };
    expect(removeTearoutTab("source", "pane", "tab", [before, other])).toEqual([other]);
    expect(restoreTearoutSource([other], before, "tab", 0)).toEqual([before, other]);
    const extra = { ...before.panes[0], id: "new-pane", tabs: [] };
    const modified = { ...before, panes: [extra] };
    expect(restoreTearoutSource([modified], before, "tab")[0].panes.map((pane) => pane.id)).toEqual(["pane", "new-pane"]);
  });
  it("restores selected pane metadata and its pin after the real tab-removal action", () => {
    const before = workspace();
    const original = before.panes[0];
    original.pinnedTabId = "tab";
    original.cwd = "C:/original";
    original.agentId = "claude-code";
    original.tabs[0] = { ...original.tabs[0], agentId: "claude-code", cwd: original.cwd };
    original.tabs.push({ id: "sibling", agentId: "shell", sessionId: "pty-sibling", type: "terminal", cwd: "C:/sibling" });
    useWorkspaceListStore.setState({ workspaces: [before], activeWorkspaceId: before.id });
    useUiStore.setState({ activePaneId: original.sessionId });
    useWorkspaceLayoutStore.getState().removeTabFromPane(before.id, original.id, "tab");
    const removed = useWorkspaceListStore.getState().workspaces;
    expect(removed[0].panes[0].pinnedTabId).toBeUndefined();
    expect(removed[0].panes[0].cwd).toBe("C:/sibling");
    expect(restoreTearoutSource(removed, before, "tab")).toEqual([before]);
  });
});

describe("Mac uses the same live transfer state", () => {
  it.each(["MacIntel", "Win32"])("receipts wait for live PTYs and attachments on %s", async platform => {
    stop();
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    let alive = (_value: boolean) => {};
    let attached = () => {};
    const aliveReady = new Promise<boolean>(resolve => { alive = resolve; });
    mocks.attachmentReady = new Promise<void>(resolve => { attached = resolve; });
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: any) => command === "is_session_alive" ? aliveReady : base(command, args));
    stop = installTearoutRuntime({ serialize: config, publish: async () => {} });
    const incoming = config(workspace("incoming"));
    incoming.panes[0].tabs![0] = { ...incoming.panes[0].tabs![0], tab_id: "incoming-tab", session_id: "pty-incoming" };
    dispatch("mycmux://tearout-delivery", { token: "gated-" + platform, source: "peer", configs: [incoming] }, "main");
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("is_session_alive", { sessionId: "pty-incoming" }), { timeout: 2000 });
    expect(useWorkspaceListStore.getState().workspaces.map(ws => ws.id))
      .toEqual(platform === "MacIntel" ? ["source", "incoming"] : ["source"]);
    expect(mocks.emitTo.mock.calls.some(([, event]) => event.endsWith("tearout-receipt"))).toBe(false);
    alive(true);
    await vi.waitFor(() => expect(useWorkspaceListStore.getState().workspaces.map(ws => ws.id)).toEqual(["source", "incoming"]), { timeout: 2000 });
    expect(mocks.emitTo.mock.calls.some(([, event]) => event.endsWith("tearout-receipt"))).toBe(false);
    attached();
    await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith("peer", "mycmux://tearout-receipt", { token: "gated-" + platform, ok: true }), { timeout: 2000 });
  });
  it("a dead Mac PTY removes the provisional layout and never sends a success receipt", async () => {
    stop();
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    let alive = (_value: boolean) => {};
    const aliveReady = new Promise<boolean>(resolve => { alive = resolve; });
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: any) => command === "is_session_alive" ? aliveReady : base(command, args));
    stop = installTearoutRuntime({ serialize: config, publish: async () => {} });
    const before = useWorkspaceListStore.getState().workspaces;
    const incoming = config(workspace("incoming"));
    incoming.panes[0].tabs![0] = { ...incoming.panes[0].tabs![0], tab_id: "incoming-tab", session_id: "pty-incoming" };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      dispatch("mycmux://tearout-delivery", { token: "dead", source: "peer", configs: [incoming] }, "main");
      await vi.waitFor(() => expect(useWorkspaceListStore.getState().workspaces).toHaveLength(2), { timeout: 2000 });
      alive(false);
      await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith("peer", "mycmux://tearout-receipt", { token: "dead", ok: false, error: "tearout_receive_failed" }), { timeout: 2000 });
      expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
      expect(mocks.emitTo.mock.calls.some(([, event, payload]) => event.endsWith("tearout-receipt") && payload.ok)).toBe(false);
    } finally { warning.mockRestore(); }
  });
  it("Mac Esc can roll back its phase during retire but does not reattach until retire finishes", async () => {
    stop();
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    useSettingsStore.setState({ macNativePaneTearoutEnabled: true });
    const original = useWorkspaceListStore.getState().workspaces;
    let retired = () => {};
    const retirement = new Promise<void>(resolve => { retired = resolve; });
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: any) => command === "tearout_retire" ? retirement : base(command, args));
    stop = installTearoutRuntime({ serialize: config, publish: async () => {} });
    const pending = tearoutTab(item, gap, { x: 10, y: 10 });
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([cmd, args]) => cmd === "tearout_phase" && args.phase === "rolled_back")).toBe(true), { timeout: 2000 });
    expect(useWorkspaceListStore.getState().workspaces).toEqual([]);
    retired(); await pending;
    expect(useWorkspaceListStore.getState().workspaces).toEqual(original);
    useSettingsStore.setState({ macNativePaneTearoutEnabled: false });
  });
  it.each([false, true])("group Esc keeps remembered selections exact and preserves an actual receiver visit=%s", async visited => {
    stop();
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    useSettingsStore.setState({ nativePaneTearoutEnabled: true, macNativePaneTearoutEnabled: true });
    const source = workspace(), receiver = workspace("receiver");
    receiver.panes[0] = { ...receiver.panes[0], id: "receiver-pane", sessionId: "pty-receiver",
      tabs: [{ ...receiver.panes[0].tabs[0], id: "receiver-tab", sessionId: "pty-receiver" }], activeTabId: "receiver-tab" };
    receiver.splitColumns = [["receiver-pane"]];
    source.panes[0].tabs.push({ ...source.panes[0].tabs[0], id: "sibling", sessionId: "pty-sibling" });
    useWorkspaceListStore.setState({ workspaces: [receiver, source], activeWorkspaceId: source.id,
      lastActivePaneByWorkspace: { source: "pty-original" } });
    useUiStore.setState({ activePaneId: "pty-original" });
    const before = useWorkspaceListStore.getState().workspaces;
    stop = installTearoutRuntime({ serialize: toTransferConfig, publish: async () => {} });
    mocks.invoke.mockImplementation(async (command: string, args: any) => {
      if (command === "tearout_take_spare") return "mycmux-w42";
      if (command === "is_session_alive") return true;
      if (command === "tearout_start_move") {
        expect(useWorkspaceListStore.getState().workspaces).toEqual([receiver]);
        if (visited) useWorkspaceListStore.getState().setActiveWorkspace(receiver.id);
        dispatch("mycmux://tearout-native", { ...args, phase: "end", at: Date.now(), escaped: true,
          receiver: null, client_x: -1, client_y: -1, approval: null, error: null });
      }
    });
    await tearoutPane({ kind: "pane", workspaceId: source.id, paneId: "pane", label: "Group", tabCount: 2 }, gap, { x: 10, y: 10 });
    expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
    expect(useWorkspaceListStore.getState().lastActivePaneByWorkspace).toEqual({ source: "pty-original",
      ...(visited ? { receiver: "pty-receiver" } : {}) });
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe(source.id);
    expect(useUiStore.getState().activePaneId).toBe("pty-original");
    useSettingsStore.setState({ macNativePaneTearoutEnabled: false });
  });
  it.each([true, false])("preserves session identity when Esc=%s", async escaped => {
    stop();
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    useSettingsStore.setState({ nativePaneTearoutEnabled: true, macNativePaneTearoutEnabled: true });
    stop = installTearoutRuntime({ serialize: toTransferConfig, publish: async () => {} });
    mocks.escape = escaped;
    const baseInvoke = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: any) => {
      if (command === "tearout_start_move") expect(evictTerminalCache).not.toHaveBeenCalled();
      return baseInvoke(command, args);
    });
    const before = useWorkspaceListStore.getState().workspaces;
    await tearoutTab(item, gap, { x: 10, y: 10 });
    expect(useWorkspaceListStore.getState().workspaces).toEqual(escaped ? before : []);
    const delivery = mocks.emitTo.mock.calls.find(([, event]) => event.endsWith("tearout-delivery"))![2];
    expect(delivery.configs[0].panes[0].tabs[0].session_id).toBe("pty-original");
    expect(evictTerminalCache).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.some(([command]) => command === "create_session")).toBe(false);
    expect(mocks.invoke.mock.calls.filter(([command, args]) => command === "tearout_phase" && args.phase === "rolled_back")).toHaveLength(escaped ? 1 : 0);
    useSettingsStore.setState({ macNativePaneTearoutEnabled: false });
  });
});

it("reveals restored children after listeners without taking focus, then keeps their original kind", async () => {
  const restored = window as Window & { __MYCMUX_RESTORED_WINDOW__?: boolean; __MYCMUX_TEAROUT_WINDOW__?: boolean };
  for (const native of [false, true]) {
    restored.__MYCMUX_RESTORED_WINDOW__ = true;
    restored.__MYCMUX_TEAROUT_WINDOW__ = native;
    expect(isTearoutChild()).toBe(true);
    await markTearoutChildReady();
    expect(restored.__MYCMUX_RESTORED_WINDOW__).toBeUndefined();
    expect(isTearoutChild()).toBe(native);
  }
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "plugin:window|show")).toHaveLength(1);
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "tearout_child_ready")).toHaveLength(2);
  expect(mocks.invoke.mock.calls.some(([command]) => command.includes("focus"))).toBe(false);
  delete restored.__MYCMUX_TEAROUT_WINDOW__;
});

it("retains the restoration gate when native reveal fails", async () => {
  const restored = window as Window & { __MYCMUX_RESTORED_WINDOW__?: boolean };
  restored.__MYCMUX_RESTORED_WINDOW__ = true;
  mocks.invoke.mockImplementation(async (command) => {
    if (command === "plugin:window|show") throw new Error("reveal failed");
  });
  await expect(markTearoutChildReady()).rejects.toThrow("reveal failed");
  expect(restored.__MYCMUX_RESTORED_WINDOW__).toBe(true);
  delete restored.__MYCMUX_RESTORED_WINDOW__;
});

it("reserves saved window labels before warming a new native spare", async () => {
  stop();
  let hydrated!: () => void;
  const ready = new Promise<void>((resolve) => { hydrated = resolve; });
  mocks.invoke.mockClear();
  stop = installTearoutRuntime({ serialize: config, publish: async () => {}, hydrated: ready });
  expect(mocks.invoke.mock.calls.some(([command]) => command === "tearout_warm")).toBe(false);
  useSettingsStore.setState({ nativePaneTearoutEnabled: false });
  useSettingsStore.setState({ nativePaneTearoutEnabled: true });
  expect(mocks.invoke.mock.calls.some(([command]) => command === "tearout_warm")).toBe(false);
  hydrated(); await ready; await Promise.resolve();
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "tearout_warm")).toHaveLength(1);
});

it("does not create a spare for a runtime closed while restoration is pending", async () => {
  stop();
  let hydrated!: () => void;
  const ready = new Promise<void>((resolve) => { hydrated = resolve; });
  mocks.invoke.mockClear();
  stop = installTearoutRuntime({ serialize: config, publish: async () => {}, hydrated: ready });
  stop(); hydrated(); await ready; await Promise.resolve();
  expect(mocks.invoke.mock.calls.some(([command]) => command === "tearout_warm")).toBe(false);
});

it.each(["MacIntel", "Win32"])("passes source logical size only on Windows (%s)", async platform => {
  Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
  useSettingsStore.setState({ macNativePaneTearoutEnabled: true });
  const pane = document.createElement("div");
  pane.dataset.dndPaneId = "pane"; pane.dataset.dndWorkspaceId = "source";
  pane.getBoundingClientRect = () => ({ width: 654, height: 432 } as DOMRect);
  document.body.append(pane);
  try {
    await tearoutTab(item, gap, { x: 10, y: 10 });
    const args = mocks.invoke.mock.calls.find(([command]) => command === "tearout_show")![1];
    expect(args).toEqual({ label: "mycmux-w42", offsetX: 10, offsetY: 10,
      ...(platform === "Win32" ? { logicalWidth: 654, logicalHeight: 432 } : {}) });
  } finally { pane.remove(); }
});

it("keeps the original Mac restored-child reveal order for both shell kinds", async () => {
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  const restored = window as Window & { __MYCMUX_RESTORED_WINDOW__?: boolean };
  for (const native of [false, true]) {
    mocks.invoke.mockClear();
    restored.__MYCMUX_RESTORED_WINDOW__ = true; window.__MYCMUX_TEAROUT_WINDOW__ = native;
    await markTearoutChildReady();
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(["plugin:window|show", "tearout_child_ready"]);
  }
  delete window.__MYCMUX_TEAROUT_WINDOW__;
});

// T1-T3: source runtime state, serialized lifecycle and recovery are separate.
describe("mixed-session transfer reliability", () => {
  it.each([true, false])("waits only for running sessions, Esc=%s", async escaped => {
    const source = workspace();
    source.panes[0].tabs.push(
      { id: "declared", sessionId: "pty-declared", agentId: "shell", type: "terminal", lifecycle: "declared" },
      { id: "stopped", sessionId: "pty-stopped", agentId: "shell", type: "terminal" },
      { id: "hidden", sessionId: "pty-hidden", agentId: "shell", type: "terminal" },
      { id: "launcher", sessionId: "pty-launcher", agentId: "shell", type: "launcher" });
    useWorkspaceListStore.setState({ workspaces: [source] });
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: any) => command === "is_session_alive"
      ? Promise.resolve(["pty-original", "pty-hidden"].includes(args.sessionId)) : base(command, args));
    mocks.escape = escaped;
    stop(); stop = installTearoutRuntime({ serialize: toTransferConfig, publish: async () => {} });
    await tearoutPane({ kind: "pane", workspaceId: source.id, paneId: "pane", label: "Mixed", tabCount: 5 }, gap, { x: 10, y: 10 });
    const delivery = mocks.emitTo.mock.calls.find(([, event]) => event.endsWith("tearout-delivery"))![2];
    expect(delivery.liveSessions).toEqual(["pty-original", "pty-hidden"]);
    expect(delivery.configs[0].panes[0].tabs.find((tab: any) => tab.tab_id === "declared").lifecycle).toBe("declared");
    if (escaped) expect(mocks.attachments).toHaveBeenCalledWith(["pty-original", "pty-hidden"]);
    expect(mocks.attachments.mock.calls.every(([ids]) => !ids.includes("pty-stopped") && !ids.includes("pty-declared"))).toBe(true);
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "create_session")).toBe(false);
    expect(useWorkspaceListStore.getState().workspaces).toEqual(escaped ? [source] : []);
  });
  it("accepts passive sessions without treating them as dead running PTYs", async () => {
    const incoming = toTransferConfig(workspace("mixed-incoming"));
    incoming.panes[0].tabs![0].tab_id = "incoming-live";
    incoming.panes[0].tabs![0].session_id = "pty-incoming-live";
    incoming.panes[0].tabs!.push({ tab_id: "incoming-declared", session_id: "pty-declared", agent_id: "shell", lifecycle: "declared" },
      { tab_id: "incoming-stopped", session_id: "pty-stopped", agent_id: "shell" });
    dispatch("mycmux://tearout-delivery", { token: "mixed-receive", source: "peer", configs: [incoming], liveSessions: ["pty-incoming-live"] }, "main");
    await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith("peer", "mycmux://tearout-receipt", { token: "mixed-receive", ok: true }), { timeout: 2000 });
    expect(mocks.attachments).toHaveBeenCalledWith(["pty-incoming-live"]);
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "is_session_alive").map(([, args]) => args.sessionId)).toEqual(["pty-incoming-live"]);
  });
  it("rejects a second start during recovery with a reason and no synthetic release", async () => {
    let attached = () => {};
    mocks.attachmentReady = new Promise<void>(resolve => { attached = resolve; });
    const first = tearoutTab(item, gap, { x: 10, y: 10 });
    await vi.waitFor(() => expect(mocks.attachments).toHaveBeenCalled(), { timeout: 2000 });
    const during = useWorkspaceListStore.getState().workspaces;
    await expect(tearoutTab(item, gap, { x: 10, y: 10 })).rejects.toThrow("tearout_move_busy");
    expect(useWorkspaceListStore.getState().workspaces).toEqual(during);
    const rejected = mocks.invoke.mock.calls.filter(([cmd]) => cmd === "tearout_log_record").map(([, args]) => args.record).find(row => row.result === "rejected_busy");
    try { expect(rejected).toMatchObject({ failure_reason: "tearout_move_busy", failure_phase: "restoring", released_at: null, released: false }); }
    finally { attached(); await first; }
  });
  it("does not claim restoration before attachment and shows a retry on failure", async () => {
    const { useToastStore } = await import("../../src/stores/toastStore");
    useToastStore.setState({ toasts: [] });
    let fail = (_error: Error) => {};
    mocks.attachmentReady = new Promise<void>((_, reject) => { fail = reject; });
    const first = tearoutTab(item, gap, { x: 10, y: 10 });
    await vi.waitFor(() => expect(mocks.attachments).toHaveBeenCalled(), { timeout: 2000 });
    expect(useToastStore.getState().toasts.some(toast => toast.message.includes("\u623b\u3057\u3066\u3044\u307e\u3059"))).toBe(true);
    expect(useToastStore.getState().toasts.some(toast => toast.message.includes("\u623b\u3057\u307e\u3057\u305f"))).toBe(false);
    fail(new Error("tearout_restore_attachment_timeout")); await first;
    const notice = useToastStore.getState().toasts.find(toast => toast.kind === "error")!;
    expect(notice.message).toContain("\u5143\u306e");
    expect(notice.actions?.some(action => action.label.includes("\u3084\u308a\u76f4\u3059"))).toBe(true);
    expect(notice.message).not.toMatch(/pty-|tearout_|rollback/);
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "tearout_log_record").at(-1)![1].record.result).toBe("restore_failed");
  });
});
