// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
const mocks = vi.hoisted(() => ({ listeners: new Map<string, Set<(event: { payload: any }) => void>>(),
  targets: new WeakMap<Function, string>(), broadcastTargetedDelivery: false,
  isMainWindow: true,
  attachments: vi.fn(), attachmentReady: null as Promise<void> | null, attachmentPrepared: null as Promise<void> | null,
  windows: vi.fn(), invoke: vi.fn(), emitTo: vi.fn(), failShow: false, failReceipt: false, failNativeListen: false, escape: true }));
vi.mock("@tauri-apps/api/core", async (original) => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, callback: (event: { payload: any }) => void, options?: { target: { kind: string; label: string } }) => {
    if (event === "mycmux://tearout-native" && mocks.failNativeListen) throw new Error("tearout_native_listener_failed");
    if (options?.target.kind === "Window") mocks.targets.set(callback, options.target.label);
    const callbacks = mocks.listeners.get(event) ?? new Set(); callbacks.add(callback); mocks.listeners.set(event, callbacks);
    return () => { callbacks.delete(callback); };
  }, emit: async () => {}, emitTo: mocks.emitTo,
}));
vi.mock("../../src/lib/windowContext", () => ({ windowLabel: () => "main", isMainWindow: () => mocks.isMainWindow }));
vi.mock("../../src/lib/tearout/sessionAttachment", () => ({ expectTearoutAttachments: (ids: string[]) => { mocks.attachments(ids); return { prepared: mocks.attachmentPrepared ?? Promise.resolve(), ready: mocks.attachmentReady ?? Promise.resolve(), dispose: () => {} }; }, rememberTearoutDormantSessions: vi.fn() }));
vi.mock("@tauri-apps/api/window", async original => ({ ...await original<typeof import("@tauri-apps/api/window")>(), getAllWindows: mocks.windows }));
vi.mock("../../src/components/terminal/terminalCache", async (original) => ({
  ...await original<typeof import("../../src/components/terminal/terminalCache")>(), evictTerminalCache: vi.fn(),
}));
import { sendTearoutWorkspaces, installTearoutRuntime, tearoutTab, tearoutPane, useTearoutStore, isTearoutChild, markTearoutChildReady, visitTearoutLocation, regrabTearoutWindow, canRegrabTearoutTab, canRegrabTearoutPane, TEAROUT_SPARE_IDLE_MS } from "../../src/lib/tearout/runtime";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useSessionAttentionStore } from "../../src/stores/sessionAttentionStore";
import { createPaneMoveRequest, executePaneMove } from "../../src/lib/paneMoveOperation";
import { useWorkspaceLayoutStore } from "../../src/stores/workspaceLayoutStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useUiStore } from "../../src/stores/uiStore";
import { restoreTearoutSource, removeTearoutTab } from "../../src/lib/tearout/model";
import { evictTerminalCache } from "../../src/components/terminal/terminalCache";
import { tearoutOperationBusy, beginTearoutOperation, endTearoutOperation, tearoutDisplayReasons,
  reserveIncomingTearout, finishIncomingTearout, localTearoutRefusal } from "../../src/lib/tearout/operation";
import { activeTearoutRecords, TearoutRecord } from "../../src/lib/tearout/record";
import * as tearoutHandoff from "../../src/lib/tearout/handoff";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";
import { restoreWorkspaceConfigs } from "../../src/lib/workspaceRestore";
import { buildWindowFragment, toTransferConfig } from "../../src/components/layout/SocketListener";
import type { Workspace } from "../../src/types";
import type { WorkspaceConfig } from "../../src/lib/ipc";

const deliveredToMain: { token: string; source: string }[] = [];
function dispatch(event: string, payload: unknown, recipient?: string) {
  if (event === "mycmux://tearout-delivery" && (!recipient || recipient === "main")) deliveredToMain.push(payload as { token: string; source: string });
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
  mocks.listeners.clear(); vi.clearAllMocks(); mocks.failShow = false; mocks.failReceipt = false; mocks.failNativeListen = false; mocks.escape = true;
  mocks.broadcastTargetedDelivery = false; mocks.attachmentReady = null; mocks.attachmentPrepared = null;
  mocks.isMainWindow = true;
  mocks.windows.mockResolvedValue(["main", "peer", "other"].map(label => ({ label })));
  endTearoutOperation(); usePaneMetadataStore.setState({ metadata: {} });
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
afterEach(async () => {
  // Cancel the test's source transactions before reusing this WebView's
  // module graph in the next test; pointer-up alone intentionally cannot.
  for (const delivery of deliveredToMain.splice(0)) dispatch("mycmux://tearout-revoke", { ...delivery, ack: `cleanup-${delivery.token}` }, "main");
  for (let i = 0; i < 12; i++) await Promise.resolve();
  stop(); await Promise.resolve(); useSettingsStore.setState({ nativePaneTearoutEnabled: false }); });
const item = { kind: "tab" as const, workspaceId: "source", paneId: "pane", tabId: "tab", label: "Terminal" };
const gap = { x: 0, y: 0, width: 90, height: 30 };
describe("review settled reservation recovery", () => {
  const flush = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
  const receivedConfig = (id: string) => {
    const cfg = config(workspace(id)); cfg.panes[0].tabs![0].tab_id = `${id}-tab`; cfg.panes[0].tabs![0].session_id = `pty-${id}`;
    return cfg;
  };
  it("review releases an orphan reservation only when no incoming entry exists", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    reserveIncomingTearout("review-orphan");
    try {
      dispatch("mycmux://window-registry-changed", 1); await flush();
      expect(tearoutOperationBusy()).toBe(false);
      expect(warning).toHaveBeenCalledWith("[tearout] incoming reservation released", { token: "review-orphan", reason: "missing_incoming_entry" });
    } finally { finishIncomingTearout("review-orphan"); warning.mockRestore(); }
  });
  it("review releases a settled failed receive when sender revoke authority times out before REVOKE", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: any) => command === "tearout_revoke_attachments"
      ? new Promise(() => {}) : original(command, args));
    mocks.emitTo.mockImplementation(async (_label: string, event: string, payload: any) => {
      if (event.endsWith("tearout-delivery")) dispatch(event, { ...payload, source: "peer" }, "main");
      if (event.endsWith("tearout-receipt")) dispatch(event, payload, "main");
    });
    let failure: unknown;
    const sent = sendTearoutWorkspaces("main", [config(workspace())], [], undefined, "review-authority-timeout").catch(error => { failure = error; });
    try {
      await vi.advanceTimersByTimeAsync(5000); await sent;
      expect(failure).toMatchObject({ message: "tearout_adoption_duplicate" });
      expect(mocks.emitTo.mock.calls.some(([, event]) => event.endsWith("tearout-revoke"))).toBe(false);
      expect(tearoutOperationBusy()).toBe(true);
      await vi.advanceTimersByTimeAsync(5000);
      expect(tearoutOperationBusy()).toBe(false);
      expect(warning).toHaveBeenCalledWith("[tearout] incoming reservation released", expect.objectContaining({ reason: "failed_or_revoked_settled" }));
    } finally { warning.mockRestore(); vi.useRealTimers(); }
  });
  it("review retains a receive past the 5.5 second revoke wait and source loss until it really settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let reply = () => {};
    const base = mocks.emitTo.getMockImplementation()!;
    mocks.emitTo.mockImplementation((label: string, event: string, payload: any) => event.endsWith("tearout-receipt") && payload.token === "review-unsettled"
      ? new Promise<void>(resolve => { reply = resolve; }) : base(label, event, payload));
    try {
      dispatch("mycmux://tearout-delivery", { token: "review-unsettled", source: "peer", configs: [config(workspace())] }, "main"); await flush();
      dispatch("mycmux://tearout-revoke", { token: "review-unsettled", source: "peer", ack: "review-unsettled-ack" }, "main");
      await vi.advanceTimersByTimeAsync(5500);
      expect(mocks.emitTo).toHaveBeenCalledWith("peer", "mycmux://tearout-receipt", { token: "review-unsettled-ack", ok: false, error: "tearout_revoke_failed" });
      mocks.windows.mockResolvedValue([{ label: "main" }]); dispatch("mycmux://window-registry-changed", 2); await flush();
      await vi.advanceTimersByTimeAsync(5000); expect(tearoutOperationBusy()).toBe(true);
      expect(warning).toHaveBeenCalledWith("[tearout] incoming reservation retained", expect.objectContaining({ reason: "receive_not_settled", receiving: true }));
      reply(); await flush(); expect(tearoutOperationBusy()).toBe(false);
    } finally { reply(); await flush(); warning.mockRestore(); vi.useRealTimers(); }
  });
  it.each(["backend-cleared", "backend-active", "backend-unknown", "source-gone-no-event"])("review recovers a lost finalize only with safe evidence: %s", async condition => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const token = `review-finalize-${condition}`;
    const original = mocks.invoke.getMockImplementation()!;
    let active = condition === "backend-active";
    let unknown = condition === "backend-unknown";
    mocks.invoke.mockImplementation((command: string, args: any) => command === "tearout_transfer_refusal"
      ? Promise.resolve(unknown ? { unverifiable: true } : active ? { kind: "rejected_busy", pre_ownership: true, phase: "moving", owner_id: "held-transfer", source: "peer", label: "main" } : null)
      : original(command, args));
    try {
      dispatch("mycmux://tearout-delivery", { token, source: "peer", configs: [receivedConfig(token)] }, "main"); await flush();
      expect(tearoutOperationBusy()).toBe(true);
      if (condition === "source-gone-no-event") mocks.windows.mockResolvedValue([{ label: "main" }]);
      await vi.advanceTimersByTimeAsync(10_000);
      if (active || unknown) {
        expect(tearoutOperationBusy()).toBe(true);
        expect(warning).toHaveBeenCalledWith("[tearout] incoming reservation retained", expect.objectContaining({
          reason: unknown ? "backend_proof_unverifiable" : "backend_reservation_active", receiving: false }));
        active = false; unknown = false; await vi.advanceTimersByTimeAsync(5000);
      }
      expect(tearoutOperationBusy()).toBe(false);
      expect(useWorkspaceListStore.getState().workspaces.some(ws => ws.panes.some(p => p.tabs.some(tab => tab.id === `${token}-tab`)))).toBe(true);
    } finally { warning.mockRestore(); vi.useRealTimers(); }
  });
  it("review keeps attachment preparation reserved after silent source loss until reception settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let prepare = () => {};
    mocks.attachmentPrepared = new Promise<void>(resolve => { prepare = resolve; });
    try {
      dispatch("mycmux://tearout-delivery", { token: "review-pending-preparation", source: "peer", configs: [receivedConfig("review-pending-preparation")] }, "main"); await flush();
      mocks.windows.mockResolvedValue([{ label: "main" }]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(tearoutOperationBusy()).toBe(true); expect(useWorkspaceListStore.getState().workspaces).toHaveLength(1);
      prepare(); await flush(); expect(useWorkspaceListStore.getState().workspaces).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(5000); expect(tearoutOperationBusy()).toBe(false);
    } finally { prepare(); await flush(); warning.mockRestore(); vi.useRealTimers(); }
  });
  it("review defers an authenticated finalize until a still-running receipt publish settles", async () => {
    let sent = () => {};
    const original = mocks.emitTo.getMockImplementation()!;
    mocks.emitTo.mockImplementation((label: string, event: string, payload: any) => event.endsWith("tearout-receipt") && payload.token === "review-early-finalize"
      ? new Promise<void>(resolve => { sent = resolve; }) : original(label, event, payload));
    dispatch("mycmux://tearout-delivery", { token: "review-early-finalize", source: "peer", configs: [receivedConfig("review-early-finalize")] }, "main"); await flush();
    dispatch("mycmux://tearout-finalize", { token: "review-early-finalize", source: "peer" }, "main");
    expect(tearoutOperationBusy()).toBe(true);
    sent(); await flush(); expect(tearoutOperationBusy()).toBe(false);
  });
  it.each([true, false])("review clears outgoing display activity after dock success=%s", async success => {
    mocks.failReceipt = !success;
    const id = `review-outgoing-${success}`;
    dispatch("mycmux://tearout-outgoing", { token: id, deliveryToken: id, requester: "parent",
      approval: { receiver: "peer", token: "painted", target: { kind: "workspace" } } }, "main");
    await vi.waitFor(() => expect(success ? mocks.invoke.mock.calls.some(([command, args]) => command === "tearout_retire" && args.transferId === id)
      : mocks.emitTo.mock.calls.some(([, event, value]) => event.endsWith("tearout-receipt") && value.token === id && value.ok === false)).toBe(true));
    await vi.waitFor(() => expect(tearoutDisplayReasons().displayActivity).not.toContain(`outgoing:${id}`));
  });
});
describe("review2 comparable docking diagnostics", () => {
  const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
  const logged = () => mocks.invoke.mock.calls.filter(([command, args]) => command === "tearout_log_record" && args.record.result).at(-1)?.[1].record;
  function selfRequester(options: { receiverCleanup?: boolean; afterDelivery?: boolean; revokeMissing?: boolean; requesterRevokeMissing?: boolean; releaseCancel?: boolean; silentRevoke?: boolean; rollbackFails?: boolean } = {}) {
    const original = mocks.invoke.getMockImplementation()!;
    const times = { tabs: -1, geometry: -1 };
    const started = Date.now();
    let revokes = 0;
    mocks.invoke.mockImplementation(async (command: string, args: any) => {
      if (command === "tearout_start_move") {
        dispatch("mycmux://tearout-native", { ...args, source: "main", phase: "end", at: Date.now(), escaped: false,
          receiver: "peer", client_x: 50, client_y: 50, approval: { receiver: "peer", token: "painted", target: { kind: "workspace" },
            ...(options.releaseCancel ? { release_id: args.id } : {}) }, error: null, original: { x: 0, y: 0, width: 300, height: 200 } }, "main");
        return;
      }
      if (command === "tearout_phase" && args.phase === "received" && options.afterDelivery) throw new Error("received_phase_failed");
      if (command === "tearout_phase" && args.phase === "rolled_back" && options.rollbackFails) throw new Error("child_rollback_failed");
      if (command === "tearout_revoke_attachments" && options.revokeMissing) throw new Error("tearout_transfer_missing");
      if (command === "tearout_revoke_attachments" && ++revokes === 2 && options.requesterRevokeMissing) throw new Error("tearout_transfer_missing");
      if (command === "tearout_release_cancel" && options.releaseCancel) throw new Error("release_cancel_failed");
      if (command === "tearout_restore_geometry") times.geometry = Date.now() - started;
      return original(command, args);
    });
    mocks.emitTo.mockImplementation(async (label: string, event: string, payload: any) => {
      if (event.endsWith("tearout-delivery")) dispatch("mycmux://tearout-receipt", { token: payload.token, ok: !!options.afterDelivery,
        reason: "receiver_rejected", failure_checkpoint: "receiver_validation",
        ...(options.receiverCleanup ? { receiver_cleanup_reason: "receiver_cleanup_failed" } : {}) }, "main");
      else if (event.endsWith("tearout-revoke")) {
        if (!options.silentRevoke) dispatch("mycmux://tearout-receipt", { token: payload.ack, ok: true }, "main");
      } else if (label === "main") dispatch(event, payload, "main");
    });
    const unsubscribe = useWorkspaceListStore.subscribe((state, previous) => {
      if (previous.workspaces.length === 0 && state.workspaces.length > 0) times.tabs = Date.now() - started;
    });
    return { times, unsubscribe };
  }
  it.each(["receiver-only", "child-only", "both"])("review2 keeps receiver cleanup and child restoration independent: %s", async condition => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let reject = (_error: Error) => {};
    const childFailed = condition !== "receiver-only";
    if (childFailed) mocks.attachmentReady = new Promise<void>((_, fail) => { reject = fail; });
    const { unsubscribe } = selfRequester({ receiverCleanup: condition !== "child-only" });
    try {
      await regrabTearoutWindow(); await flush();
      if (childFailed) expect(tearoutDisplayReasons().phase).toBe("restoring");
      if (childFailed) { reject(new Error("child_attachment_failed")); await flush(); }
      await vi.advanceTimersByTimeAsync(0);
      expect(logged()).toMatchObject({ result: childFailed ? "restore_failed" : "failed_restored", restore_unconfirmed: childFailed,
        receiver_cleanup_reason: condition === "child-only" ? null : "receiver_cleanup_failed", recovery_reason: childFailed ? "child_attachment_failed" : null,
        failed_session_ids: childFailed ? ["pty-original"] : [], transferred_session_ids: ["pty-original"],
        failure_phase: childFailed ? "restoring" : "docking", failure_phase_before_restore: childFailed ? "docking" : null,
        failure_reason: "receiver_rejected", release_decision: "approved" });
      expect(useWorkspaceListStore.getState().workspaces).toEqual([workspace()]);
      expect(tearoutOperationBusy()).toBe(false);
    } finally { unsubscribe(); vi.useRealTimers(); }
  });
  it("review2 marks a child rollback failure explicitly even when its tabs reattach", async () => {
    const { unsubscribe } = selfRequester({ rollbackFails: true, receiverCleanup: true });
    try {
      await regrabTearoutWindow(); await vi.waitFor(() => expect(logged()).toBeDefined());
      expect(logged()).toMatchObject({ result: "restore_failed", restore_unconfirmed: true, recovery_reason: "child_rollback_failed",
        receiver_cleanup_reason: "receiver_cleanup_failed", failure_phase: "restoring", failure_phase_before_restore: "docking" });
      expect(useWorkspaceListStore.getState().workspaces).toEqual([workspace()]);
      expect(tearoutOperationBusy()).toBe(false);
    } finally { unsubscribe(); }
  });
  it("review2 records all transferred PTY identities without treating dormant sessions as failed", async () => {
    const before = workspace();
    before.panes[0].tabs.push({ id: "dormant-tab", agentId: "shell", sessionId: "pty-dormant", type: "terminal" });
    useWorkspaceListStore.setState({ workspaces: [before] });
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: any) => command === "is_session_alive" && args.sessionId === "pty-dormant"
      ? Promise.resolve(false) : base(command, args));
    const { unsubscribe } = selfRequester({ receiverCleanup: true });
    try {
      await regrabTearoutWindow(); await vi.waitFor(() => expect(logged()).toBeDefined());
      expect(logged()).toMatchObject({ result: "failed_restored", failed_session_ids: [], transferred_session_ids: ["pty-original", "pty-dormant"] });
      expect(mocks.attachments.mock.calls.every(([ids]) => !ids.includes("pty-dormant"))).toBe(true);
    } finally { unsubscribe(); }
  });
  it("review2 separates release cancellation and ignores an already missing transfer on the requester revoke", async () => {
    const { unsubscribe } = selfRequester({ releaseCancel: true, requesterRevokeMissing: true });
    try {
      await regrabTearoutWindow(); await vi.waitFor(() => expect(logged()).toBeDefined());
      expect(logged()).toMatchObject({ release_cancel_reason: "release_cancel_failed", revoke_reason: null, result: "failed_restored" });
      expect(logged().receiver_cleanup_reason).toBeNull();
    } finally { unsubscribe(); }
  });
  it("review2 preserves release cancellation and revocation failures in separate fields", async () => {
    const { unsubscribe } = selfRequester({ releaseCancel: true, revokeMissing: true });
    try {
      await regrabTearoutWindow(); await vi.waitFor(() => expect(logged()).toBeDefined());
      expect(logged()).toMatchObject({ release_cancel_reason: "release_cancel_failed", revoke_reason: "tearout_transfer_missing" });
    } finally { unsubscribe(); }
  });
  it("review2 refreshes successful self-retirement highlight metadata immediately before retiring", async () => {
    const original = mocks.invoke.getMockImplementation()!;
    let drag = "";
    mocks.invoke.mockImplementation(async (command: string, args: any) => {
      if (command === "tearout_start_move") {
        drag = args.id;
        dispatch("mycmux://tearout-native", { ...args, source: "main", phase: "end", at: 1000, escaped: false, receiver: "peer",
          client_x: 50, client_y: 50, approval: { receiver: "peer", token: "painted", target: { kind: "workspace" } }, error: null,
          original: { x: 0, y: 0, width: 300, height: 200 } }, "main"); return;
      }
      if (command === "tearout_phase" && args.phase === "cleaned") activeTearoutRecords.get(drag)!.clearedHighlight(1234, true);
      if (command === "tearout_retire") dispatch("mycmux://tearout-receipt", { token: args.receiptToken, ok: true }, "main");
      return original(command, args);
    });
    mocks.emitTo.mockImplementation(async (label: string, event: string, payload: any) => {
      if (event.endsWith("tearout-delivery")) dispatch("mycmux://tearout-receipt", { token: payload.token, ok: true }, "main");
      else if (label === "main") dispatch(event, payload, "main");
    });
    await regrabTearoutWindow(); await flush();
    expect(mocks.invoke.mock.calls.find(([command]) => command === "tearout_retire")?.[1].record).toMatchObject({
      result: "docked", highlight_cleared_at: 1234, receiver_window: "peer", transferred_session_ids: ["pty-original"] });
    expect(tearoutOperationBusy()).toBe(false);
  });
  it("review2 retains live session identities after string transport and restoration failures", async () => {
    let reject = (_error: unknown) => {};
    mocks.attachmentReady = new Promise<void>((_, fail) => { reject = fail; });
    const base = mocks.emitTo.getMockImplementation()!;
    mocks.emitTo.mockImplementation(async (label: string, event: string, payload: any) => {
      if (event.endsWith("tearout-delivery")) throw "delivery_string_failure";
      return base(label, event, payload);
    });
    dispatch("mycmux://tearout-outgoing", { token: "string-request", deliveryToken: "string-transfer", requester: "parent",
      approval: { receiver: "peer", token: "painted", target: { kind: "workspace" } } }, "main");
    await flush(); reject("restore_string_failure"); await flush();
    expect(mocks.emitTo).toHaveBeenCalledWith("parent", "mycmux://tearout-receipt", expect.objectContaining({ token: "string-request", ok: false,
      reason: "delivery_string_failure", recovery_reason: "restore_string_failure", restore_unconfirmed: true, failedSessions: ["pty-original"] }));
  });
  it("review2 classifies attachment-context IPC preparation deadlines as attachment_timeout", async () => {
    mocks.attachmentPrepared = Promise.reject(new Error("Terminal IPC timed out: get_session_attachment_contexts"));
    dispatch("mycmux://tearout-delivery", { token: "context-timeout", source: "peer", configs: [config(workspace())] }, "main"); await flush();
    expect(mocks.emitTo).toHaveBeenCalledWith("peer", "mycmux://tearout-receipt", expect.objectContaining({ token: "context-timeout", ok: false,
      failure_checkpoint: "attachment_timeout" }));
  });
  it("review2 measures a six second revoke receipt timeout in the real self requester path", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { times, unsubscribe } = selfRequester({ afterDelivery: true, silentRevoke: true });
    try {
      await regrabTearoutWindow(); await vi.advanceTimersByTimeAsync(5999);
      expect(useWorkspaceListStore.getState().workspaces).toEqual([]); expect(times).toEqual({ tabs: -1, geometry: -1 });
      await vi.advanceTimersByTimeAsync(1);
      expect(times.tabs).toBe(6000); expect(useWorkspaceListStore.getState().workspaces).toEqual([workspace()]);
      expect(times.geometry).toBe(-1); expect(logged()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(5999); expect(times.geometry).toBe(-1);
      await vi.advanceTimersByTimeAsync(1);
      expect(times.geometry).toBe(12000);
      expect(logged()).toMatchObject({ result: "restore_failed", restore_unconfirmed: true, revoke_reason: "tearout_revoke_timeout",
        failure_reason: "received_phase_failed", release_decision: "approved", failed_session_ids: [], failure_phase: "restoring", failure_phase_before_restore: "docking" });
      expect(tearoutOperationBusy()).toBe(false);
    } finally { unsubscribe(); vi.useRealTimers(); }
  });
  it("review2 disposes both an active local operation and a settled incoming reservation without leaving busy", async () => {
    const cfg = config(workspace("dispose-review2")); cfg.panes[0].tabs![0].tab_id = "dispose-tab"; cfg.panes[0].tabs![0].session_id = "pty-dispose";
    dispatch("mycmux://tearout-delivery", { token: "dispose-review2", source: "peer", configs: [cfg] }, "main"); await flush();
    expect(tearoutOperationBusy()).toBe(true); stop(); await flush();
    expect(tearoutOperationBusy()).toBe(false);
    expect(beginTearoutOperation()).toBe(true); stop(); expect(tearoutOperationBusy()).toBe(false);
  });
});
describe("2a dock failure diagnostics and cleanup", () => {
  const request = (id: string) => ({ token: `request-${id}`, deliveryToken: `delivery-${id}`, requester: "parent",
    approval: { receiver: "peer", token: "painted", target: { kind: "workspace" } } });
  const failureReceipt = (id: string) => mocks.emitTo.mock.calls.find(([, event, payload]) =>
    event.endsWith("tearout-receipt") && payload.token === `request-${id}`)?.[2];
  it.each(["send", "after-delivery"])("sends the original %s failure despite a throwing revoke without a 20 second wait", async where => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: any) => {
      if (command === "tearout_revoke_attachments") throw new Error("revoke_unavailable");
      if (command === "tearout_phase" && args.phase === "received" && where === "after-delivery") throw new Error("received_phase_failed");
      return original(command, args);
    });
    const base = mocks.emitTo.getMockImplementation()!;
    mocks.emitTo.mockImplementation(async (label: string, event: string, payload: any) => {
      if (event.endsWith("tearout-delivery") && where === "send") {
        dispatch("mycmux://tearout-receipt", { token: payload.token, ok: false, reason: "tearout_drop_target_changed", failure_checkpoint: "consume" });
      } else await base(label, event, payload);
    });
    try {
      dispatch("mycmux://tearout-outgoing", request(where));
      await vi.advanceTimersByTimeAsync(0);
      expect(failureReceipt(where)).toMatchObject({ ok: false, error: "tearout_dock_failed", revoke_reason: "revoke_unavailable",
        reason: where === "send" ? "tearout_drop_target_changed" : "received_phase_failed",
        failure_checkpoint: where === "send" ? "consume" : "other" });
      expect(useWorkspaceListStore.getState().workspaces).toEqual([workspace()]);
      expect(tearoutOperationBusy()).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it("send rethrows the original transport error when revocation also throws", async () => {
    const original = new Error("delivery_transport_failed");
    mocks.emitTo.mockRejectedValue(original);
    mocks.invoke.mockRejectedValue(new Error("revocation_failed"));
    await expect(sendTearoutWorkspaces("peer", [], [])).rejects.toBe(original);
  });
  it("send preserves a string IPC rejection when revocation also rejects as a string", async () => {
    mocks.emitTo.mockRejectedValue("delivery_ipc_failed"); mocks.invoke.mockRejectedValue("revoke_ipc_failed");
    await expect(sendTearoutWorkspaces("peer", [], [])).rejects.toThrow("delivery_ipc_failed");
  });
  it("the real self-requester finishes immediately and logs the original failure when revoke throws", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: any) => {
      if (command === "tearout_start_move") {
        dispatch("mycmux://tearout-native", { ...args, source: "main", phase: "end", at: Date.now(), escaped: false,
          receiver: "peer", client_x: 50, client_y: 50, approval: { receiver: "peer", token: "painted", target: { kind: "workspace" } },
          error: null, original: { x: 0, y: 0, width: 300, height: 200 } }, "main");
        return;
      }
      if (command === "tearout_phase" && args.phase === "received") throw new Error("received_phase_failed");
      if (command === "tearout_revoke_attachments") throw new Error("revoke_failed");
      return base(command, args);
    });
    mocks.emitTo.mockImplementation(async (label: string, event: string, payload: any) => {
      if (event.endsWith("tearout-delivery")) dispatch("mycmux://tearout-receipt", { token: payload.token, ok: true }, "main");
      else if (label === "main") dispatch(event, payload, "main");
    });
    try {
      await regrabTearoutWindow(); await vi.advanceTimersByTimeAsync(0);
      const record = mocks.invoke.mock.calls.filter(([command]) => command === "tearout_log_record").at(-1)![1].record;
      expect(record).toMatchObject({ failure_reason: "received_phase_failed", revoke_reason: "revoke_failed", result: "restore_failed", restore_unconfirmed: true,
        attempted_destination: { kind: "sidebar" }, receiver_window: "peer" });
      expect(tearoutOperationBusy()).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it("keeps source recovery_reason separate from the receiver's original reason", async () => {
    const base = mocks.emitTo.getMockImplementation()!;
    mocks.emitTo.mockImplementation(async (label: string, event: string, payload: any) => {
      if (event.endsWith("tearout-delivery")) dispatch("mycmux://tearout-receipt", { token: payload.token, ok: false,
        reason: "tearout_drop_target_changed", failure_checkpoint: "consume" });
      else await base(label, event, payload);
    });
    let reject = (_error: Error) => {};
    mocks.attachmentReady = new Promise<void>((_, fail) => { reject = fail; });
    dispatch("mycmux://tearout-outgoing", request("recovery"));
    await vi.waitFor(() => expect(mocks.attachments).toHaveBeenCalled());
    reject(new Error("tearout_restore_attachment_timeout"));
    await vi.waitFor(() => expect(failureReceipt("recovery")).toMatchObject({ reason: "tearout_drop_target_changed",
      recovery_reason: "tearout_restore_attachment_timeout", failure_checkpoint: "consume" }));
    expect(tearoutOperationBusy()).toBe(false);
  });
  it("preserves receiver validation failure even when publishing its cleanup fails", async () => {
    stop(); stop = installTearoutRuntime({ serialize: config, publish: async () => { throw new Error("cleanup_publish_failed"); } });
    dispatch("mycmux://tearout-delivery", { token: "receiver-original", source: "peer", configs: [config(workspace())] }, "main");
    await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith("peer", "mycmux://tearout-receipt", expect.objectContaining({
      token: "receiver-original", ok: false, reason: "tearout_adoption_duplicate", receiver_cleanup_reason: "cleanup_publish_failed",
      failure_checkpoint: "receiver_validation" })));
  });
  it("classifies receiver publication failure as other rather than a failed target validation", async () => {
    const publish = vi.fn().mockRejectedValueOnce(new Error("receiver_publish_failed")).mockResolvedValue(undefined);
    stop(); stop = installTearoutRuntime({ serialize: config, publish });
    const cfg = config(workspace("publish-failure")); cfg.panes[0].tabs![0].tab_id = "publish-new";
    cfg.panes[0].tabs![0].session_id = "pty-publish-new";
    dispatch("mycmux://tearout-delivery", { token: "publish-failure", source: "peer", configs: [cfg], dock: { requester: "parent" } }, "main");
    await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith("peer", "mycmux://tearout-receipt", expect.objectContaining({
      token: "publish-failure", ok: false, reason: "receiver_publish_failed", failure_checkpoint: "other",
      dock_stages: expect.arrayContaining([{ side: "receiver", stage: "publish_wait", at: expect.any(Number) }]) })));
    expect(publish).toHaveBeenCalledTimes(2);
    expect(useWorkspaceListStore.getState().workspaces).toEqual([workspace()]);
  });
  it("keeps the six second deadline and records the receiver's last progress before timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const base = mocks.emitTo.getMockImplementation()!;
    mocks.emitTo.mockImplementation(async (label: string, event: string, payload: any) => {
      if (event.endsWith("tearout-delivery")) {
        dispatch("mycmux://tearout-progress", { token: payload.token, sender: "peer",
          dock_stages: [{ side: "receiver", stage: "attachment_prepared_wait", at: Date.now() }] }, "main");
      } else await base(label, event, payload);
    });
    try {
      dispatch("mycmux://tearout-outgoing", request("deadline"));
      await vi.advanceTimersByTimeAsync(5999); expect(failureReceipt("deadline")).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(failureReceipt("deadline")).toMatchObject({ reason: "tearout_receipt_timeout", failure_checkpoint: "receipt_timeout",
        dock_stages: expect.arrayContaining([{ side: "receiver", stage: "attachment_prepared_wait", at: expect.any(Number) }]) });
      expect(failureReceipt("deadline").dock_stages.filter((stage: any) => stage.side === "child").map((stage: any) => stage.stage))
        .toEqual(["prepare_wait", "prepared", "phase_shown", "phase_committed", "publish_wait", "published", "delivery_sent", "receipt_wait"]);
    } finally { vi.useRealTimers(); }
  });
  it.each(["before-failure", "after-failure"])("drops failed incoming reservations when the source disappears %s", async when => {
    if (when === "before-failure") mocks.windows.mockResolvedValue([{ label: "main" }]);
    dispatch("mycmux://tearout-delivery", { token: `abandoned-${when}`, source: "peer", configs: [config(workspace())] }, "main");
    await vi.waitFor(() => expect(mocks.emitTo.mock.calls.some(([, event, payload]) => event.endsWith("tearout-receipt") && payload.token === `abandoned-${when}`)).toBe(true));
    if (when === "after-failure") {
      expect(tearoutOperationBusy()).toBe(true);
      mocks.windows.mockResolvedValue([{ label: "main" }]); dispatch("mycmux://window-registry-changed", 1);
    }
    await vi.waitFor(() => expect(tearoutOperationBusy()).toBe(false));
    expect(beginTearoutOperation()).toBe(true); endTearoutOperation();
  });
  it("cancels an unfinished attachment preparation and releases its reservation on revoke", async () => {
    let prepared = () => {};
    mocks.attachmentPrepared = new Promise<void>(resolve => { prepared = resolve; });
    const cfg = config(workspace("cancel-prepared")); cfg.panes[0].tabs![0].tab_id = "new-prepared";
    cfg.panes[0].tabs![0].session_id = "pty-prepared";
    dispatch("mycmux://tearout-delivery", { token: "cancel-prepared", source: "peer", configs: [cfg] }, "main");
    await vi.waitFor(() => expect(tearoutOperationBusy()).toBe(true));
    dispatch("mycmux://tearout-revoke", { token: "cancel-prepared", source: "peer", ack: "cancel-prepared-ack" }, "main");
    await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith("peer", "mycmux://tearout-receipt", { token: "cancel-prepared-ack", ok: true }));
    expect(tearoutOperationBusy()).toBe(false);
    prepared(); await Promise.resolve(); await Promise.resolve();
    expect(useWorkspaceListStore.getState().workspaces).toEqual([workspace()]);
  });
  it("reports every receiver stage and the attachment timeout checkpoint", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    mocks.attachmentReady = new Promise<void>(() => {});
    const cfg = config(workspace("timed-receiver")); cfg.panes[0].tabs![0].tab_id = "timed-new";
    cfg.panes[0].tabs![0].session_id = "pty-timed-new";
    try {
      dispatch("mycmux://tearout-delivery", { token: "timed-receiver", source: "peer", configs: [cfg], dock: { requester: "parent" } }, "main");
      await vi.advanceTimersByTimeAsync(5000);
      const receipt = mocks.emitTo.mock.calls.find(([, event, payload]) => event.endsWith("tearout-receipt") && payload.token === "timed-receiver")![2];
      expect(receipt).toMatchObject({ reason: "tearout_attachment_timeout", failure_checkpoint: "attachment_timeout" });
      expect(receipt.dock_stages.map((stage: any) => stage.stage)).toEqual(["attachment_prepared_wait", "attachment_prepared", "session_alive_wait", "session_alive", "layout", "attachment_wait", "receipt"]);
    } finally { mocks.attachmentReady = null; vi.useRealTimers(); }
  });
});
describe("tear-out failure and Esc at the actual transfer entry", () => {
  it("I0-R4 bounds sender revocation without sending a premature revoke event", async () => {
    vi.useFakeTimers();
    const original = mocks.invoke.getMockImplementation()!;
    let release = () => {};
    mocks.failReceipt = true;
    mocks.invoke.mockImplementation((command: string, args: any) => command === "tearout_revoke_attachments"
      ? new Promise<void>(resolve => { release = resolve; }) : original(command, args));
    let result: unknown;
    const pending = sendTearoutWorkspaces("peer", [], [], undefined, "lost-revoke-sender")
      .catch(error => { result = error; });
    try {
      await vi.advanceTimersByTimeAsync(6000);
      expect(result).toBeInstanceOf(Error);
      await pending;
      expect(mocks.emitTo.mock.calls.some(([, event]) => event.endsWith("tearout-revoke"))).toBe(false);
      release(); await vi.advanceTimersByTimeAsync(0);
      expect(mocks.emitTo.mock.calls.some(([, event]) => event.endsWith("tearout-revoke"))).toBe(false);
    } finally { release(); await vi.advanceTimersByTimeAsync(0); vi.useRealTimers(); }
  });
  it("I0-R4 reports failed receiver revocation instead of acknowledging an unconfirmed revoke", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const original = mocks.invoke.getMockImplementation()!;
    let release = () => {};
    mocks.invoke.mockImplementation((command: string, args: any) => command === "tearout_revoke_attachments"
      ? new Promise<void>(resolve => { release = resolve; }) : original(command, args));
    try {
      await vi.advanceTimersByTimeAsync(0);
      dispatch("mycmux://tearout-revoke", { token: "lost-revoke-receiver", ack: "revoke-ack", source: "peer" }, "main");
      await vi.advanceTimersByTimeAsync(6000);
      expect(mocks.emitTo).toHaveBeenCalledWith("peer", "mycmux://tearout-receipt",
        { token: "revoke-ack", ok: false, error: "tearout_revoke_failed" });
      release(); await vi.advanceTimersByTimeAsync(0);
      expect(mocks.emitTo.mock.calls.filter(([, event, payload]) => event.endsWith("tearout-receipt") && payload.token === "revoke-ack" && payload.ok)).toHaveLength(0);
    } finally { release(); await vi.advanceTimersByTimeAsync(0); warning.mockRestore(); vi.useRealTimers(); }
  });
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
    await vi.waitFor(() => expect(mocks.emitTo.mock.calls.filter(([, event, payload]) => event.endsWith("tearout-receipt") && payload.ok === false)).toHaveLength(2));
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
      const pending = regrabTearoutWindow();
      await vi.advanceTimersByTimeAsync(19000);
      expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
      const request = mocks.emitTo.mock.calls.find(([, event]) => event.endsWith("tearout-outgoing"))![2];
      expect(request.deliveryToken).toBeTruthy();
      expect(request.deliveryToken).not.toBe(request.token);
      await vi.advanceTimersByTimeAsync(1000);
      await pending;
      await vi.waitFor(() => expect(tearoutOperationBusy()).toBe(false));
      expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
      const revokeIndex = mocks.emitTo.mock.calls.findIndex(([, event, payload]) =>
        event.endsWith("tearout-revoke") && payload.token === request.deliveryToken);
      const restoreIndex = mocks.invoke.mock.calls.findIndex(([command]) => command === "tearout_restore_geometry");
      expect(revokeIndex).toBeGreaterThanOrEqual(0);
      expect(mocks.emitTo.mock.invocationCallOrder[revokeIndex]).toBeLessThan(mocks.invoke.mock.invocationCallOrder[restoreIndex]);
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
    const pending = regrabTearoutWindow();
    await requested;
    expect(mocks.invoke.mock.calls.some(([command]) => command === "tearout_finalize")).toBe(false);
    dispatch("mycmux://tearout-receipt", { token: request.token, ok: true });
    await pending;
    await vi.waitFor(() => expect(tearoutOperationBusy()).toBe(false));
    expect(mocks.invoke).toHaveBeenCalledWith("tearout_finalize", { id: request.deliveryToken, token: request.deliveryToken });
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
      await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith("peer", "mycmux://tearout-receipt", { token: "dead", ok: false,
        error: "tearout_receive_failed", reason: "tearout_session_not_alive", failure_checkpoint: "receiver_validation" }), { timeout: 2000 });
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

describe("idle spare refill", () => {
  const warms = () => mocks.invoke.mock.calls.filter(([command]) => command === "tearout_warm");
  beforeEach(() => {
    stop();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    stop = installTearoutRuntime({ serialize: config, publish: async () => {} });
    mocks.invoke.mockClear();
  });
  afterEach(() => { stop(); vi.useRealTimers(); });

  it("keeps Rust's spare idle gate equal to the JavaScript refill delay", () => {
    const source = readFileSync(fileURLToPath(new NodeURL("../../src-tauri/src/tearout/mod.rs", import.meta.url).href), "utf8");
    const value = source.match(/const SPARE_IDLE_MS:\s*u64\s*=\s*([\d_]+);/)?.[1];
    expect(value).toBeDefined();
    expect(Number(value!.replaceAll("_", ""))).toBe(TEAROUT_SPARE_IDLE_MS);
  });

  it("refills once with idleOnly after three seconds, without delaying startup or demand warm", async () => {
    stop(); mocks.invoke.mockClear();
    stop = installTearoutRuntime({ serialize: config, publish: async () => {} });
    expect(mocks.invoke).toHaveBeenCalledWith("tearout_warm");
    mocks.invoke.mockClear();
    const base = mocks.invoke.getMockImplementation()!;
    let take = 0;
    mocks.invoke.mockImplementation((command: string, args: any) => command === "tearout_take_spare"
      ? Promise.resolve(++take === 1 ? null : "mycmux-w42") : base(command, args));
    await tearoutTab(item, gap, { x: 10, y: 10 });
    expect(warms()).toEqual([["tearout_warm"]]);
    mocks.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(TEAROUT_SPARE_IDLE_MS - 1);
    expect(warms()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.invoke).toHaveBeenCalledWith("tearout_warm", { idleOnly: true });
    await vi.advanceTimersByTimeAsync(30000);
    expect(warms()).toEqual([["tearout_warm", { idleOnly: true }]]);
  });

  it("refills from a child after idle without warming on startup, hydration or settings changes", async () => {
    stop(); mocks.invoke.mockClear(); mocks.isMainWindow = false;
    let hydrated!: () => void;
    const ready = new Promise<void>(resolve => { hydrated = resolve; });
    stop = installTearoutRuntime({ serialize: config, publish: async () => {}, hydrated: ready });
    expect(warms()).toHaveLength(0);
    hydrated(); await ready; await Promise.resolve();
    expect(warms()).toHaveLength(0);
    useSettingsStore.setState({ nativePaneTearoutEnabled: false });
    useSettingsStore.setState({ nativePaneTearoutEnabled: true });
    expect(warms()).toHaveLength(0);
    await tearoutTab(item, gap, { x: 10, y: 10 });
    await vi.advanceTimersByTimeAsync(TEAROUT_SPARE_IDLE_MS - 1);
    expect(warms()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(warms()).toEqual([["tearout_warm", { idleOnly: true }]]);
  });

  it.each(["detach", "regrab", "incoming", "outgoing", "window transfer"])("extends a pending refill when %s begins", async operation => {
    await tearoutTab(item, gap, { x: 10, y: 10 });
    await vi.advanceTimersByTimeAsync(2000);
    if (operation === "detach") await tearoutTab(item, gap, { x: 10, y: 10 });
    else if (operation === "incoming") {
      dispatch("mycmux://tearout-delivery", { token: "idle-incoming", source: "peer", configs: [config(workspace("received"))] }, "main");
      for (let i = 0; i < 40; i++) await Promise.resolve();
    } else if (operation === "outgoing") {
      dispatch("mycmux://tearout-outgoing", { token: "idle-outgoing", deliveryToken: "idle-transfer", requester: "peer",
        approval: { receiver: "peer", token: "approval", target: { kind: "workspace" } } }, "main");
      for (let i = 0; i < 40; i++) await Promise.resolve();
    } else if (operation === "window transfer") {
      expect(beginTearoutOperation()).toBe(true);
      endTearoutOperation();
    } else {
      const base = mocks.invoke.getMockImplementation()!;
      mocks.invoke.mockImplementation((command: string, args: any) => command === "tearout_start_move" ? Promise.resolve() : base(command, args));
      await regrabTearoutWindow();
      const id = [...activeTearoutRecords.keys()][0];
      dispatch("mycmux://tearout-native", { id, label: "main", source: "main", mode: "dock", phase: "end", at: Date.now(),
        escaped: false, receiver: null, approval: null, native_started_at: Date.now(), error: null,
        scale: 1, monitor: null, focus_stolen: false });
      for (let i = 0; i < 40; i++) await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(2999);
    expect(warms()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(warms()).toEqual([["tearout_warm", { idleOnly: true }]]);
  });

  it("retries only a deferred warm once per second and stops at the original thirty-second deadline", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await tearoutTab(item, gap, { x: 10, y: 10 });
      mocks.invoke.mockRejectedValue("tearout_warm_deferred");
      await vi.advanceTimersByTimeAsync(2999); expect(warms()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1); expect(warms()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(999); expect(warms()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1); expect(warms()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(56000);
      // Initial delay consumes three seconds of the total 30-second budget.
      expect(warms()).toHaveLength(27);
      expect(warms().length).toBeLessThanOrEqual(30);
      expect(warning).toHaveBeenCalledWith("[tearout] refill abandoned", expect.stringContaining("tearout_warm_deferred"));
    } finally { warning.mockRestore(); }
  });

  it("bounds continuous postponement by the original deadline", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await tearoutTab(item, gap, { x: 10, y: 10 });
      for (let n = 0; n < 14; n++) {
        await vi.advanceTimersByTimeAsync(2000);
        await tearoutTab(item, gap, { x: 10, y: 10 });
      }
      await vi.advanceTimersByTimeAsync(2000);
      expect(warms()).toHaveLength(0);
      expect(warning).toHaveBeenCalledWith("[tearout] refill abandoned", expect.stringContaining("deadline"));
    } finally { warning.mockRestore(); }
  });

  it("does not retry other errors", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await tearoutTab(item, gap, { x: 10, y: 10 });
      mocks.invoke.mockRejectedValue("window_create_failed");
      await vi.advanceTimersByTimeAsync(30000);
      expect(warms()).toHaveLength(1);
      expect(warning).toHaveBeenCalledWith("[tearout] refill abandoned", "window_create_failed");
    } finally { warning.mockRestore(); }
  });

  it.each(["disable", "dispose", "pagehide", "beforeunload"])("cancels the refill on %s", async action => {
    await tearoutTab(item, gap, { x: 10, y: 10 });
    if (action === "disable") {
      useSettingsStore.setState({ nativePaneTearoutEnabled: false });
      expect(mocks.invoke).toHaveBeenCalledWith("tearout_release_spare");
    } else if (action === "dispose") stop();
    else window.dispatchEvent(new Event(action));
    await vi.advanceTimersByTimeAsync(30000);
    expect(warms()).toHaveLength(0);
  });
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
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "tearout_log_record").at(-1)![1].record).toMatchObject({
      result: "restore_failed", session_id_equal: false, failure_phase: "restoring",
      failure_reason: "tearout_restore_attachment_timeout", failed_session_ids: ["pty-original"],
    });
  });
});

it("visits the affected hidden tab and clears an unrelated zoom", () => {
  const target = workspace("target");
  target.panes[0].id = "target-pane";
  target.panes[0].tabs[0] = { id: "visible", agentId: "shell", sessionId: "pty-visible", type: "terminal" };
  target.panes[0].tabs.push({ id: "affected", agentId: "shell", sessionId: "pty-affected", type: "terminal" });
  target.panes[0].activeTabId = "visible"; target.panes[0].sessionId = "pty-visible";
  useWorkspaceListStore.setState({ workspaces: [workspace(), target], activeWorkspaceId: "source" });
  useUiStore.setState({ zoomedPaneId: "pane" });
  visitTearoutLocation("target", "pty-affected");
  expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("target");
  expect(useWorkspaceListStore.getState().getWorkspace("target")?.panes[0].activeTabId).toBe("affected");
  expect(useUiStore.getState()).toMatchObject({ activePaneId: "pty-affected", zoomedPaneId: null });
});

it("releases the regrab operation when registering its native listener fails", async () => {
  mocks.failNativeListen = true;
  try {
    await expect(regrabTearoutWindow()).rejects.toThrow("tearout_native_listener_failed");
    expect(tearoutOperationBusy()).toBe(false);
    expect(activeTearoutRecords.size).toBe(0);
    expect(useWorkspaceListStore.getState().workspaces).toEqual([workspace()]);
    const diagnostic = mocks.invoke.mock.calls.filter(([cmd]) => cmd === "tearout_log_record").at(-1)?.[1].record;
    expect(diagnostic).toMatchObject({ failure_reason: "tearout_native_listener_failed", failure_phase: "preparing", released_at: null, released: false });
  } finally { endTearoutOperation(); activeTearoutRecords.clear(); }
});

it.each(["dead-session", "publish-failure"])("keeps failed dock retry visible until %s is resolved", async failure => {
  const { useToastStore } = await import("../../src/stores/toastStore");
  useToastStore.setState({ toasts: [] });
  const publish = vi.fn().mockResolvedValue(undefined);
  stop(); stop = installTearoutRuntime({ serialize: config, publish });
  mocks.failReceipt = true;
  let reject = (_error: Error) => {};
  mocks.attachmentReady = new Promise<void>((_, fail) => { reject = fail; });
  dispatch("mycmux://tearout-outgoing", { token: "retry-request", deliveryToken: "retry-delivery", requester: "parent",
    approval: { receiver: "peer", token: "painted", target: { kind: "workspace" } } });
  await vi.waitFor(() => expect(mocks.attachments).toHaveBeenCalled(), { timeout: 2000 });
  reject(new Error("tearout_restore_attachment_timeout"));
  await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith("parent", "mycmux://tearout-receipt", expect.objectContaining({ token: "retry-request", ok: false })), { timeout: 2000 });
  endTearoutOperation();
  const initialPublishes = publish.mock.calls.length;
  const failed = useToastStore.getState().toasts.find(toast => toast.actions?.some(a => a.label.includes("\u4ed8\u3051\u76f4\u3057")))!;
  expect(failed.message).toContain("keep title");
  expect(failed.message).not.toMatch(/pty-|tearout_/);
  mocks.attachmentReady = Promise.resolve();
  if (failure === "dead-session") mocks.invoke.mockImplementation(async command => command === "is_session_alive" ? false : undefined);
  else publish.mockRejectedValueOnce(new Error("tearout_publish_failed"));
  failed.actions![0].run();
  await vi.waitFor(() => expect(tearoutOperationBusy()).toBe(false), { timeout: 2000 });
  expect(useToastStore.getState().toasts.some(toast => toast.message.includes("\u623b\u3057\u307e\u3057\u305f"))).toBe(false);
  expect(useToastStore.getState().toasts.filter(toast => toast.actions?.some(a => a.label.includes("\u4ed8\u3051\u76f4\u3057")))).toHaveLength(1);
  expect(useWorkspaceListStore.getState().workspaces).toEqual([workspace()]);
  const retry = useToastStore.getState().toasts.find(toast => toast.actions?.some(a => a.label.includes("\u4ed8\u3051\u76f4\u3057")))!;
  expect(retry.id).not.toBe(failed.id);
  expect(useToastStore.getState().toasts.some(toast => toast.id === failed.id)).toBe(false);
  expect(retry.actions![0].run).not.toBe(failed.actions![0].run);
  mocks.invoke.mockImplementation(async command => command === "is_session_alive" ? true : undefined);
  retry.actions![0].run();
  await vi.waitFor(() => expect(useToastStore.getState().toasts.some(toast => toast.message.includes("\u623b\u3057\u307e\u3057\u305f"))).toBe(true), { timeout: 2000 });
  expect(publish).toHaveBeenCalledTimes(initialPublishes + (failure === "dead-session" ? 1 : 2));
  await vi.waitFor(() => expect(tearoutOperationBusy()).toBe(false), { timeout: 2000 });
});

it("visits the failed hidden session from the actual group recovery notice", async () => {
  const { useToastStore } = await import("../../src/stores/toastStore");
  useToastStore.setState({ toasts: [] });
  const source = workspace();
  source.panes[0].tabs.push({ id: "failed-hidden", sessionId: "pty-hidden-failed", agentId: "shell", type: "terminal", label: "Hidden error pane" });
  useWorkspaceListStore.setState({ workspaces: [source] });
  const base = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command: string, args: any) => command === "is_session_alive"
    ? Promise.resolve(args.sessionId !== "pty-hidden-failed" || !mocks.attachments.mock.calls.length) : base(command, args));
  stop(); stop = installTearoutRuntime({ serialize: toTransferConfig, publish: async () => {} });
  await tearoutPane({ kind: "pane", workspaceId: source.id, paneId: "pane", label: "Mixed", tabCount: 2 }, gap, { x: 10, y: 10 });
  const notice = useToastStore.getState().toasts.find(toast => toast.kind === "error")!;
  expect(notice.message).toContain("Hidden error pane");
  expect(notice.message).not.toMatch(/pty-|tearout_/);
  notice.actions![1].run();
  expect(useWorkspaceListStore.getState().getWorkspace("source")?.panes[0].activeTabId).toBe("failed-hidden");
  expect(useUiStore.getState().activePaneId).toBe("pty-hidden-failed");
});

it.each(["tearout_session_not_alive", "tearout_attachment_timeout", "tearout_adoption_duplicate_session"])("distinguishes receiver rejection %s from source restoration failure", async reason => {
  const { useToastStore } = await import("../../src/stores/toastStore");
  useToastStore.setState({ toasts: [] });
  mocks.escape = false;
  const base = mocks.emitTo.getMockImplementation()!;
  mocks.emitTo.mockImplementation(async (_label: string, event: string, payload: any) => {
    if (event.endsWith("tearout-delivery")) dispatch("mycmux://tearout-receipt", { token: payload.token, ok: false, error: "tearout_receive_failed", reason, failedSessions: ["pty-original"] });
    else await base(_label, event, payload);
  });
  await tearoutTab(item, gap, { x: 10, y: 10 });
  const notice = useToastStore.getState().toasts.find(toast => toast.kind === "error")!;
  expect(notice.message).toContain("\u79fb\u52d5\u5148\u306e\u7a93\u304c\u30bf\u30d6\u3092\u53d7\u3051\u53d6\u308c\u307e\u305b\u3093\u3067\u3057\u305f");
  expect(notice.message).toContain("\u623b\u3057\u307e\u3057\u305f");
  expect(notice.message).not.toMatch(/pty-|tearout_/);
  expect(useWorkspaceListStore.getState().workspaces).toEqual([workspace()]);
});

describe("handoff from a detached child preserves its existing state", () => {
  it.each(["success", "failed", "request-error"])("preserves IDs, selection and live session on %s", async outcome => {
    const before = useWorkspaceListStore.getState().workspaces;
    useWorkspaceListStore.setState({ lastActivePaneByWorkspace: { source: "pty-original" } });
    useUiStore.setState({ activePaneId: "pty-original", zoomedPaneId: "pane" });
    usePaneMetadataStore.setState({ metadata: { "pty-original": {
      agentKind: "claude", agentSessionId: "source-agent", cwd: "C:/demo" } } });
    const clear = vi.fn(async () => {});
    const publish = vi.spyOn(tearoutHandoff, "publishTearoutHandoffDrag").mockResolvedValue(clear);
    const handoff = vi.spyOn(tearoutHandoff, "requestTearoutHandoff");
    if (outcome === "request-error") handoff.mockRejectedValue(new Error("synthetic receiver failure"));
    else handoff.mockResolvedValue(outcome === "success");
    const approval = { receiver: "peer", token: "painted", target: { kind: "handoff", workspaceId: "target", paneId: "target-pane",
      tabId: "target-tab", sessionId: "target-pty", targetAgentKind: "codex" } };
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "tearout_start_move") dispatch("mycmux://tearout-native", { ...args, phase: "end", at: Date.now(), escaped: false,
        receiver: "peer", client_x: 150, client_y: 150, approval, error: null, original: { x: 10, y: 20, width: 600, height: 400 } });
    });
    try {
      await regrabTearoutWindow(); await vi.waitFor(() => expect(tearoutOperationBusy()).toBe(false));
      expect(handoff).toHaveBeenCalledWith(expect.any(String), approval); expect(clear).toHaveBeenCalledOnce();
      expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
      expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("source");
      expect(useWorkspaceListStore.getState().lastActivePaneByWorkspace).toEqual({ source: "pty-original" });
      expect(useUiStore.getState().activePaneId).toBe("pty-original"); expect(useUiStore.getState().zoomedPaneId).toBe("pane");
      expect(mocks.attachments).not.toHaveBeenCalled();
      expect(mocks.invoke.mock.calls.some(([cmd]) => ["tearout_take_spare", "tearout_retire", "create_session", "kill_session"].includes(cmd))).toBe(false);
      expect(mocks.invoke).toHaveBeenCalledWith("tearout_restore_geometry", { label: "main", geometry: { x: 10, y: 20, width: 600, height: 400 } });
      const record = mocks.invoke.mock.calls.find(([cmd, args]) => cmd === "tearout_log_record" && args.record.result)![1].record;
      expect(record.result).toBe(outcome === "success" ? "handed_off" : "handoff_failed");
      expect(record.destination.kind).toBe("handoff");
      if (outcome === "request-error") expect(record.failure_reason).toBe("synthetic receiver failure");
    } finally { publish.mockRestore(); handoff.mockRestore(); }
  });
});

describe("native transport common move result", () => {
  it("rejects a generation change during the commit command before removing source ownership", async () => {
    const feed = (epoch: number) => useSessionAttentionStore.getState().applySnapshot({ server_epoch: "move-server", seq: epoch,
      sessions: [{ session_id: "pty-original", session_revision: epoch, status: { session_epoch: epoch, lifecycle: "alive", ui_state: "working",
        attention: { attention_id: null, kind: "none", detail: null, state_since: 0 } } }] });
    useSessionAttentionStore.getState().resetForTests(); feed(7);
    const original = useWorkspaceListStore.getState().workspaces;
    const invoke = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: any) => {
      if (command === "tearout_phase" && args.phase === "committed") feed(8);
      return invoke(command, args);
    });
    try {
      const result = await executePaneMove(createPaneMoveRequest(item, { kind: "native-window", gap, offset: { x: 10, y: 10 } }));
      expect(result).toMatchObject({ status: "failed", phase: "rolled_back", receipt: "pending", reason: expect.stringContaining("execution_changed") });
      expect(useWorkspaceListStore.getState().workspaces).toEqual(original);
      expect(mocks.invoke.mock.calls.some(([command]) => command === "tearout_start_move")).toBe(false);
      expect(mocks.emitTo.mock.calls.some(([, event]) => event.endsWith("tearout-delivery"))).toBe(false);
    } finally { useSessionAttentionStore.getState().resetForTests(); }
  });

  it("reports a kept native window as moved only after the real receiver receipt", async () => {
    mocks.escape = false;
    const request = createPaneMoveRequest(item, { kind: "native-window", gap, offset: { x: 10, y: 10 } });
    expect(await executePaneMove(request)).toMatchObject({ operationId: request.operationId, status: "moved", phase: "cleaned",
      receipt: "acknowledged", destinationWindow: "mycmux-w42" });
    expect(mocks.invoke).toHaveBeenCalledWith("tearout_phase", { id: request.operationId, phase: "received" });
  });
});


describe("local overlap refusal (E1/E4/E5)", () => {
  it("records the backend owner when tearout_prepare refuses a detach", async () => {
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: any) => command === "tearout_prepare"
      ? Promise.resolve({ kind: "rejected_busy", pre_ownership: true, phase: "moving", owner_id: "prepare-owner", source: "peer", label: "main" })
      : base(command, args));
    await expect(tearoutTab(item, gap, { x: 10, y: 10 })).rejects.toMatchObject({ name: "LocalTearoutRefusal", phase: "moving" });
    expect(mocks.invoke.mock.calls.find(([command, args]) => command === "tearout_log_record" && args.record.result === "rejected_busy")?.[1].record)
      .toMatchObject({ refusal_source: "backend_transfer", blocker_id: "prepare-owner", blocker_phase: "moving" });
    expect(mocks.invoke.mock.calls.some(([command]) => command === "tearout_show")).toBe(false);
    expect(useWorkspaceListStore.getState().workspaces).toEqual([workspace()]);
  });
  it("records the backend owner when dockOutgoing is refused by Rust", async () => {
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: any) => command === "tearout_prepare"
      ? Promise.resolve({ kind: "rejected_busy", pre_ownership: true, phase: "moving", owner_id: "dock-owner", source: "peer", label: "main" })
      : base(command, args));
    dispatch("mycmux://tearout-outgoing", { token: "refused-dock", deliveryToken: "refused-delivery", requester: "parent",
      approval: { receiver: "peer", token: "painted", target: { kind: "workspace" } } });
    await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith("parent", "mycmux://tearout-receipt", expect.objectContaining({ token: "refused-dock", ok: false })));
    expect(mocks.invoke.mock.calls.find(([command, args]) => command === "tearout_log_record" && args.record.result === "rejected_busy")?.[1].record)
      .toMatchObject({ refusal_source: "backend_transfer", blocker_id: "dock-owner", blocker_phase: "moving" });
    expect(useWorkspaceListStore.getState().workspaces).toEqual([workspace()]);
  });
  it.each([true, false])("uses the outgoing record ID as phase owner when present=%s", async withRecord => {
    const deliveryToken = "owned-delivery";
    const record = withRecord ? new TearoutRecord("outgoing-drag", "tab", "main", Date.now()).forRetire({ kind: "workspace" }) : undefined;
    const base = mocks.invoke.getMockImplementation()!;
    let complete!: () => void;
    mocks.invoke.mockImplementation((command: string, args: any) => command === "tearout_prepare"
      ? new Promise<void>(resolve => { complete = resolve; }) : base(command, args));
    dispatch("mycmux://tearout-outgoing", { token: "owned-dock", deliveryToken, requester: "parent", record,
      approval: { receiver: "peer", token: "painted", target: { kind: "workspace" } } });
    try {
      await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("tearout_prepare", expect.objectContaining({ id: deliveryToken })));
      expect(localTearoutRefusal()).toMatchObject({ source: "phase", blockerId: withRecord ? "outgoing-drag" : deliveryToken });
    } finally {
      complete();
      await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("tearout_retire", expect.objectContaining({ receiptToken: "owned-dock" })));
      await vi.waitFor(() => expect(tearoutOperationBusy()).toBe(false));
    }
  });
  it.each([true, false])("keeps the outgoing record phase owner during a restoration retry when present=%s", async withRecord => {
    const { useToastStore } = await import("../../src/stores/toastStore");
    useToastStore.setState({ toasts: [] });
    mocks.failReceipt = true;
    const deliveryToken = "retry-delivery";
    const record = withRecord ? new TearoutRecord("retry-drag", "tab", "main", Date.now()).forRetire({ kind: "workspace" }) : undefined;
    let fail = (_error: Error) => {};
    mocks.attachmentReady = new Promise<void>((_, reject) => { fail = reject; });
    dispatch("mycmux://tearout-outgoing", { token: "retry-dock", deliveryToken, requester: "parent", record,
      approval: { receiver: "peer", token: "painted", target: { kind: "workspace" } } });
    await vi.waitFor(() => expect(mocks.attachments).toHaveBeenCalledTimes(1));
    fail(new Error("tearout_restore_attachment_timeout"));
    await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith("parent", "mycmux://tearout-receipt",
      expect.objectContaining({ token: "retry-dock", ok: false, restore_unconfirmed: true })));
    await vi.waitFor(() => expect(tearoutOperationBusy()).toBe(false));
    const notice = useToastStore.getState().toasts.find(toast => toast.kind === "error" && toast.actions?.length === 2)!;
    expect(notice.actions![0].label).toBe("\u4ed8\u3051\u76f4\u3057\u3092\u3084\u308a\u76f4\u3059");
    let complete = () => {};
    mocks.attachmentReady = new Promise<void>(resolve => { complete = resolve; });
    try {
      notice.actions![0].run();
      await vi.waitFor(() => expect(mocks.attachments).toHaveBeenCalledTimes(2));
      expect(localTearoutRefusal()).toMatchObject({ source: "phase", blockerId: withRecord ? "retry-drag" : deliveryToken });
    } finally {
      complete();
      await vi.waitFor(() => expect(tearoutOperationBusy()).toBe(false));
    }
    expect(useToastStore.getState().toasts.some(toast => toast.kind === "info")).toBe(true);
  });
  it("copies native UI queue delay into the completed gesture record", async () => {
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args: any) => {
      if (command === "tearout_start_move") dispatch("mycmux://tearout-native", { ...args, phase: "move", at: Date.now(),
        native_started_at: Date.now(), native_start_delay_ms: 5419, receiver: null, escaped: false,
        scale: 1.5, monitor: "DISPLAY1", focus_stolen: false });
      return base(command, args);
    });
    await tearoutTab(item, gap, { x: 10, y: 10 });
    expect(mocks.invoke.mock.calls.find(([cmd, args]) => cmd === "tearout_log_record" && args.record.result)?.[1].record.native_start_delay_ms).toBe(5419);
  });
  it("captures moving before a delayed or failed rejection log, without a recovery warning", async () => {
    const { useToastStore } = await import("../../src/stores/toastStore");
    useToastStore.setState({ toasts: [] });
    expect(beginTearoutOperation("phase-owner")).toBe(true);
    const before = useWorkspaceListStore.getState().workspaces;
    let failLog = (_error: Error) => {};
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "tearout_log_record") return new Promise((_, reject) => { failLog = reject; });
    });
    const refused = regrabTearoutWindow().catch(error => error);
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("tearout_log_record", expect.anything()));
    endTearoutOperation();
    failLog(new Error("log unavailable"));
    const error = await refused;
    expect(error).toMatchObject({ message: "tearout_move_busy", phase: "moving" });
    expect(mocks.invoke.mock.calls.find(([cmd, args]) => cmd === "tearout_log_record" && args.record.result === "rejected_busy")?.[1].record)
      .toMatchObject({ refusal_source: "phase", blocker_id: "phase-owner", blocker_phase: "moving" });
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "tearout_start_move" || cmd === "tearout_settle")).toBe(false);
  });
  it("recognizes another WebView's accepted move from native lifecycle samples", async () => {
    const sample = { id: "other-owner", mode: "detach", label: "main", source: "peer", phase: "move", at: Date.now(),
      receiver: null, client_x: -1, client_y: -1, approval: null, escaped: false, region_count: 1 };
    dispatch("mycmux://tearout-native", sample, "main");
    try {
      expect(tearoutOperationBusy()).toBe(true);
      await expect(regrabTearoutWindow()).rejects.toMatchObject({ message: "tearout_move_busy", phase: "moving" });
      expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "tearout_start_move")).toBe(false);
      expect(mocks.invoke.mock.calls.find(([cmd, args]) => cmd === "tearout_log_record" && args.record.result === "rejected_busy")?.[1].record)
        .toMatchObject({ failure_phase: "moving", refusal_source: "observed_move", blocker_id: "other-owner", blocker_phase: "moving" });
    } finally {
      dispatch("mycmux://tearout-native", { ...sample, phase: "end" }, "main");
      endTearoutOperation();
    }
  });
});

it.each([undefined, "backend_pre_ownership", "backend_release", "backend_transfer"] as const)(
  "refuses a cross-WebView regrab and retains the native blocker before its first sample: %s", async refusalSource => {
  const { useToastStore } = await import("../../src/stores/toastStore"); useToastStore.setState({ toasts: [] });
  const before = useWorkspaceListStore.getState().workspaces;
  let id = "";
  mocks.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "tearout_start_move") {
      id = args.id;
      return { kind: "rejected_busy", pre_ownership: true, phase: "moving", owner_id: "main-owned", source: "peer", label: "main", refusal_source: refusalSource };
    }
  });
  try {
    await expect(regrabTearoutWindow()).rejects.toMatchObject({ message: "tearout_move_busy", phase: "moving" });
    expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "tearout_settle" || cmd === "tearout_restore_geometry")).toBe(false);
    expect(mocks.invoke.mock.calls.find(([cmd, args]) => cmd === "tearout_log_record" && args.record.result === "rejected_busy")?.[1].record)
      .toMatchObject({ failure_phase: "moving", refusal_source: refusalSource ?? "backend_pre_ownership", blocker_id: "main-owned", blocker_phase: "moving" });
    expect(tearoutOperationBusy()).toBe(false);
  } finally {
    dispatch("mycmux://tearout-native", { id, mode: "dock", phase: "end", at: Date.now(), escaped: true, receiver: null, error: null });
    await Promise.resolve(); await Promise.resolve(); endTearoutOperation();
  }
});


it.each(["raw-busy", "not-pre-ownership", "different-window", "same-request"] as const)(
  "preserves native-start recovery without an authentic pre-ownership refusal: %s", async reason => {
    const { useToastStore } = await import("../../src/stores/toastStore"); useToastStore.setState({ toasts: [] });
    mocks.invoke.mockImplementation(async (command: string, args: any) => {
      if (command !== "tearout_start_move") return;
      if (reason === "raw-busy") throw new Error("tearout_move_busy");
      return { kind: "rejected_busy", pre_ownership: reason !== "not-pre-ownership", phase: "moving",
        owner_id: reason === "same-request" ? args.id : "main-owned", source: "peer",
        label: reason === "different-window" ? "other-window" : args.label };
    });
    await expect(regrabTearoutWindow()).rejects.toThrow(reason === "raw-busy" ? "tearout_move_busy" : "tearout_start_result_invalid");
    expect(mocks.invoke).toHaveBeenCalledWith("tearout_settle", { label: "main" });
    expect(useToastStore.getState().toasts.some(toast => toast.kind === "error")).toBe(true);
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "tearout_log_record").at(-1)?.[1].record)
      .toMatchObject({ result: "failed_restored", failure_phase: "moving", errors: ["native_move_failed"] });
    expect(tearoutOperationBusy()).toBe(false); expect(activeTearoutRecords.size).toBe(0);
  });


describe("O2 separates first detach from whole-window dock", () => {
  it.each(["workspace", "handoff"])("keeps the first window despite an otherwise valid %s approval", async kind => {
    const approval = { receiver: "peer", token: "painted", target: kind === "workspace" ? { kind } : {
      kind, workspaceId: "target", paneId: "target-pane", tabId: "target-tab", sessionId: "target-pty", targetAgentKind: "codex" } };
    const publish = vi.spyOn(tearoutHandoff, "publishTearoutHandoffDrag").mockResolvedValue(async () => {});
    const handoff = vi.spyOn(tearoutHandoff, "requestTearoutHandoff").mockResolvedValue(true);
    usePaneMetadataStore.setState({ metadata: { "pty-original": { agentKind: "claude", agentSessionId: "source-agent", cwd: "C:/demo" } } });
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "tearout_start_move") {
        dispatch("mycmux://tearout-native", { ...args, source: "main", phase: "end", at: Date.now(), escaped: false,
          receiver: "peer", client_x: 150, client_y: 150, approval, error: null,
          release: { x: 150, y: 150, at: Date.now(), method: "native_up" } });
        return;
      }
      if (command === "tearout_resolve_release") return approval;
      return base(command, args);
    });
    const emit = mocks.emitTo.getMockImplementation()!;
    mocks.emitTo.mockImplementation(async (label, event, payload) => {
      if (event.endsWith("tearout-outgoing")) dispatch("mycmux://tearout-receipt", { token: payload.token, ok: true });
      else return emit(label, event, payload);
    });
    try {
      await tearoutTab(item, gap, { x: 10, y: 10 });
      expect(mocks.invoke).toHaveBeenCalledWith("tearout_settle", { label: "mycmux-w42" });
      expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "tearout_resolve_release")).toBe(false);
      expect(mocks.emitTo.mock.calls.some(([, event]) => event.endsWith("tearout-outgoing"))).toBe(false);
      expect(publish).not.toHaveBeenCalled(); expect(handoff).not.toHaveBeenCalled();
      expect(mocks.invoke).toHaveBeenCalledWith("tearout_start_move", expect.objectContaining({ mode: "detach" }));
      expect(useWorkspaceListStore.getState().workspaces).toEqual([]);
      expect(mocks.invoke.mock.calls.find(([cmd, args]) => cmd === "tearout_log_record" && args.record.result)?.[1].record.result).toBe("kept_window");
    } finally { publish.mockRestore(); handoff.mockRestore(); }
  });
  it("detaches a partial pane inside a child and reserves dock for the whole child", async () => {
    window.__MYCMUX_TEAROUT_WINDOW__ = true;
    const source = workspace();
    source.panes.push({ ...source.panes[0], id: "other", sessionId: "pty-other", activeTabId: "other-tab",
      tabs: [{ ...source.panes[0].tabs[0], id: "other-tab", sessionId: "pty-other" }] });
    source.splitColumns = [["pane"], ["other"]];
    useWorkspaceListStore.setState({ workspaces: [source] });
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "tearout_start_move") { dispatch("mycmux://tearout-native", { ...args, phase: "end", at: Date.now(), escaped: false, approval: null, error: null }); return; }
      return base(command, args);
    });
    try {
      expect(canRegrabTearoutTab(item)).toBe(false);
      expect(canRegrabTearoutPane({ kind: "pane", workspaceId: "source", paneId: "pane", label: "Group", tabCount: 1 })).toBe(false);
      await tearoutPane({ kind: "pane", workspaceId: "source", paneId: "pane", label: "Group", tabCount: 1 }, gap, { x: 10, y: 10 });
      expect(mocks.invoke).toHaveBeenCalledWith("tearout_start_move", expect.objectContaining({ mode: "detach", regionCount: 1, offsetX: 10, offsetY: 10 }));
      expect(useWorkspaceListStore.getState().workspaces[0].panes.map(p => p.id)).toEqual(["other"]);
    } finally { delete window.__MYCMUX_TEAROUT_WINDOW__; }
  });
  it.each([true, false])("publishes regrab handoff context, awaits its receipt and preserves ownership, ok=%s", async ok => {
    const before = useWorkspaceListStore.getState().workspaces;
    usePaneMetadataStore.setState({ metadata: { "pty-original": { agentKind: "claude", agentSessionId: "source-agent", cwd: "C:/demo" } } });
    const clear = vi.fn(async () => {});
    const publish = vi.spyOn(tearoutHandoff, "publishTearoutHandoffDrag").mockResolvedValue(clear);
    let receipt!: (ok: boolean) => void;
    const handoff = vi.spyOn(tearoutHandoff, "requestTearoutHandoff").mockImplementation(() => new Promise(resolve => { receipt = resolve; }));
    const approval = { receiver: "peer", token: "final", release_id: "release-id", layout_revision: "revision", target: {
      kind: "handoff", workspaceId: "target", paneId: "target-pane", tabId: "target-tab", sessionId: "target-pty", targetAgentKind: "codex" } };
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "tearout_start_move") {
        dispatch("mycmux://tearout-native", { ...args, source: "main", phase: "end", at: Date.now(), escaped: false, receiver: "peer",
          client_x: 150, client_y: 150, approval: null, error: null, original: { x: 10, y: 10, width: 600, height: 400 },
          release: { x: 150, y: 150, at: Date.now(), method: "native_up" } });
      }
      if (command === "tearout_resolve_release") return approval;
    });
    // Old regrab misroutes this target through dock. Acknowledge that request
    // so the red run has no pending timeout or ownership leaking to the next test.
    const emit = mocks.emitTo.getMockImplementation()!;
    mocks.emitTo.mockImplementation(async (label, event, payload) => {
      if (event.endsWith("tearout-outgoing")) dispatch("mycmux://tearout-receipt", { token: payload.token, ok: true });
      else return emit(label, event, payload);
    });
    try {
      await regrabTearoutWindow();
      await vi.waitFor(() => expect(handoff).toHaveBeenCalled());
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ id: expect.any(String), label: "main", sourceWindow: "main",
        endpoint: expect.objectContaining({ tab: expect.objectContaining({ id: "tab", sessionId: "pty-original" }) }) }));
      expect(publish.mock.invocationCallOrder[0]).toBeLessThan(mocks.invoke.mock.invocationCallOrder[mocks.invoke.mock.calls.findIndex(([cmd]) => cmd === "tearout_start_move")]);
      expect(mocks.invoke).toHaveBeenCalledWith("tearout_start_move", expect.objectContaining({ mode: "dock", regrab: true }));
      expect(tearoutOperationBusy()).toBe(true); expect(clear).not.toHaveBeenCalled();
      receipt(ok);
      await vi.waitFor(() => expect(tearoutOperationBusy()).toBe(false));
      expect(clear).toHaveBeenCalledOnce();
      expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
      expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "tearout_take_spare" || cmd === "tearout_retire")).toBe(false);
      expect(mocks.emitTo.mock.calls.some(([, event]) => event.endsWith("tearout-outgoing"))).toBe(false);
      expect(mocks.invoke.mock.calls.find(([cmd, args]) => cmd === "tearout_log_record" && args.record.result)?.[1].record.result).toBe(ok ? "handed_off" : "handoff_failed");
    } finally { receipt?.(false); await Promise.resolve(); publish.mockRestore(); handoff.mockRestore(); }
  });
});


it.each(["center", "left", "right", "up", "down"] as const)("O2 docks the next whole-window gesture at the same point into %s without a spare", async zone => {
  const approval = { receiver: "peer", token: "final", release_id: "second-release", layout_revision: "layout", target: {
    kind: "pane-zone", workspaceId: "receiver", paneId: "receiver-pane", zone } };
  const base = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "tearout_start_move") dispatch("mycmux://tearout-native", { ...args, source: "main", phase: "end", at: Date.now(),
      escaped: false, error: null, receiver: "peer", client_x: 150, client_y: 150, approval,
      release: { x: 150, y: 150, at: Date.now(), method: "native_up" }, original: { x: 0, y: 0, width: 600, height: 400 } });
    else if (command === "tearout_resolve_release") return approval;
    else return base(command, args);
  });
  await tearoutTab(item, gap, { x: 10, y: 10 });
  expect(mocks.emitTo.mock.calls.some(([, event]) => event.endsWith("tearout-outgoing"))).toBe(false);
  expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "tearout_take_spare")).toHaveLength(1);
  // Load the received child state; this second gesture owns the existing window.
  useWorkspaceListStore.setState({ workspaces: [workspace()], activeWorkspaceId: "source" });
  let outgoing: any;
  const emit = mocks.emitTo.getMockImplementation()!;
  mocks.emitTo.mockImplementation(async (label, event, payload) => {
    if (event.endsWith("tearout-outgoing")) outgoing = payload;
    else return emit(label, event, payload);
  });
  await regrabTearoutWindow();
  await vi.waitFor(() => expect(outgoing?.approval.target).toEqual(approval.target));
  expect(tearoutOperationBusy()).toBe(true);
  expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "tearout_take_spare")).toHaveLength(1);
  expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "tearout_resolve_release")).toHaveLength(1);
  dispatch("mycmux://tearout-receipt", { token: outgoing.token, ok: true });
  await vi.waitFor(() => expect(tearoutOperationBusy()).toBe(false));
  expect(mocks.invoke).toHaveBeenCalledWith("tearout_finalize", { id: outgoing.deliveryToken, token: outgoing.deliveryToken });
});


it.each([false, true])("O2 regrab uses received identity before metadata and honors live clearing, cleared=%s", async cleared => {
  const cfg = config(workspace("received"));
  cfg.panes[0].tabs![0].agent_kind = "claude";
  cfg.panes[0].tabs![0].agent_session_id = "received-agent";
  cfg.panes[0].tabs![0].cwd = "C:/demo/received";
  useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: "received" });
  usePaneMetadataStore.setState({ metadata: cleared ? { "pty-original": { cwd: "C:/demo/received" } } : {} }); restoreWorkspaceConfigs([cfg]);
  const clear = vi.fn(async () => {});
  const publish = vi.spyOn(tearoutHandoff, "publishTearoutHandoffDrag").mockResolvedValue(clear);
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "tearout_start_move") dispatch("mycmux://tearout-native", { ...args, phase: "end", at: Date.now(), escaped: true, error: null,
      receiver: null, approval: null, original: { x: 0, y: 0, width: 600, height: 400 } });
  });
  try {
    await regrabTearoutWindow(); await vi.waitFor(() => expect(tearoutOperationBusy()).toBe(false));
    if (cleared) { expect(publish).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled(); }
    else {
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ mode: "dock", endpoint: expect.objectContaining({ metadata: {
        agentKind: "claude", agentSessionId: "received-agent", cwd: "C:/demo/received" } }) }));
      expect(clear).toHaveBeenCalledOnce();
    }
  } finally { publish.mockRestore(); }
});
