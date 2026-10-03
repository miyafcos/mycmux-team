// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ listeners: new Map<string, Set<(event: { payload: any }) => void>>(),
  targets: new WeakMap<Function, string>(), broadcastTargetedDelivery: false,
  invoke: vi.fn(), emitTo: vi.fn(), failShow: false, failReceipt: false, escape: true }));
vi.mock("@tauri-apps/api/core", async (original) => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, callback: (event: { payload: any }) => void, options?: { target: { kind: string; label: string } }) => {
    if (options?.target.kind === "Window") mocks.targets.set(callback, options.target.label);
    const callbacks = mocks.listeners.get(event) ?? new Set(); callbacks.add(callback); mocks.listeners.set(event, callbacks);
    return () => { callbacks.delete(callback); };
  }, emit: async () => {}, emitTo: mocks.emitTo,
}));
vi.mock("../../src/lib/windowContext", () => ({ windowLabel: () => "main", isMainWindow: () => true }));
vi.mock("../../src/lib/tearout/sessionAttachment", () => ({ expectTearoutAttachments: () => ({ ready: Promise.resolve(), dispose: () => {} }) }));
vi.mock("../../src/components/terminal/terminalCache", async (original) => ({
  ...await original<typeof import("../../src/components/terminal/terminalCache")>(), evictTerminalCache: vi.fn(),
}));
import { installTearoutRuntime, tearoutTab, tearoutPane, useTearoutStore } from "../../src/lib/tearout/runtime";
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
  mocks.broadcastTargetedDelivery = false;
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
    if (escaped) expect(evictTerminalCache).not.toHaveBeenCalled();
    else expect(evictTerminalCache).toHaveBeenCalledWith("pty-original", { preserveInputQueue: true });
    expect(mocks.invoke.mock.calls.some(([command]) => command === "create_session")).toBe(false);
    expect(mocks.invoke.mock.calls.filter(([command, args]) => command === "tearout_phase" && args.phase === "rolled_back")).toHaveLength(escaped ? 1 : 0);
    useSettingsStore.setState({ macNativePaneTearoutEnabled: false });
  });
});
