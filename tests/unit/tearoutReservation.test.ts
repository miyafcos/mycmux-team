// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../src/types";
import type { WorkspaceConfig } from "../../src/lib/ipc";

const deferred = () => {
  let resolve!: () => void, reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
type WindowContext = Awaited<ReturnType<typeof openWindow>>;
const windows = new Map<string, WindowContext>();
const listeners = new Map<string, Set<(event: { payload: any }) => void>>();
const calls: { caller: string; command: string; args: any }[] = [];
const transfers = new Map<string, { source: string; receiver: string; token: string; phase: string; finalized: boolean; sessions: string[] }>();
// Shared PTY model: attachment replaces one data channel, never spawns a process.
const channels = new Map<string, string>();
let delay: ReturnType<typeof deferred>, stage: "attachment" | "publication";
function emitTo(label: string, event: string, payload: any) {
  for (const callback of [...(listeners.get(`${label}:${event}`) ?? [])]) callback({ payload });
  return Promise.resolve();
}
function approval(id: string) {
  const c = windows.get("C")!;
  return { receiver: "C", token: "painted", release_id: id, target: { kind: "workspace" },
    layout_revision: JSON.stringify([window.innerWidth, window.innerHeight, window.devicePixelRatio,
      c.ui.getState().zoomedPaneId, c.list.getState().activeWorkspaceId, 0, [], []]) };
}
function nativeEnd(caller: string, args: any, approval: any = null) {
  const sample = { ...args, source: caller, phase: "end", at: Date.now(), escaped: false,
    receiver: approval?.receiver ?? null, approval, error: null, original: { x: 1, y: 2, width: 800, height: 600 } };
  for (const label of new Set([caller, args.label])) void emitTo(label, "mycmux://tearout-native", sample);
}
const source: Workspace = { id: "original", name: "Original", createdAt: 1, status: "running", gridTemplateId: "1x1",
  panes: [{ id: "pane", agentId: "shell", sessionId: "pty-original", activeTabId: "tab",
    tabs: [{ id: "tab", agentId: "shell", sessionId: "pty-original", type: "terminal" }] }] };
function config(ws: Workspace): WorkspaceConfig {
  return { id: ws.id, name: ws.name, created_at: ws.createdAt, grid_template_id: ws.gridTemplateId,
    panes: ws.panes.map(p => ({ pane_id: p.id, agent_id: p.agentId, session_id: p.sessionId, active_tab_id: p.activeTabId,
      tabs: p.tabs.map(t => ({ tab_id: t.id, agent_id: t.agentId, session_id: t.sessionId, type: t.type })) })) };
}
async function openWindow(label: string) {
  // Separate module graphs give A/B/C distinct real Zustand stores, operation
  // state, incoming maps, adapters and listeners, as separate WebViews do.
  vi.resetModules();
  vi.doMock("../../src/lib/windowContext", () => ({ windowLabel: () => label, isMainWindow: () => label === "A" }));
  vi.doMock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: async (command: string, args: any) => {
    calls.push({ caller: label, command, args });
    if (command === "is_session_alive") return true;
    if (command === "tearout_take_spare") return label === "A" ? "B" : "C";
    const reserved = [...transfers.entries()].filter(([, entry]) => !entry.finalized && entry.phase !== "rolled_back");
    const proof = (owner: [string, typeof reserved[number][1]]) => ({ kind: "rejected_busy", pre_ownership: true, phase: "moving",
      owner_id: owner[0], source: owner[1].source, label });
    if (command === "tearout_transfer_refusal") {
      const owner = reserved.find(([, entry]) => entry.receiver === label); return owner ? proof(owner) : undefined;
    }
    if (command === "tearout_prepare") {
      const sessions = args.configs.flatMap((config: WorkspaceConfig) => config.panes.flatMap(p => (p.tabs ?? []).map(t => t.session_id)));
      const owner = reserved.find(([, entry]) => entry.receiver === label || entry.sessions.some(id => sessions.includes(id)));
      if (owner) return proof(owner);
      transfers.set(args.id, { source: label, receiver: args.receiver, token: args.deliveryToken, phase: "prepared", finalized: false, sessions });
    }
    if (command === "tearout_phase") { const entry = transfers.get(args.id); if (entry) entry.phase = args.phase; }
    if (command === "tearout_finalize") {
      const entry = transfers.get(args.id)!;
      expect(entry.source).toBe(label); expect(entry.phase).toBe("cleaned"); expect(entry.token).toBe(args.token);
      entry.finalized = true;
      await emitTo(entry.receiver, "mycmux://tearout-finalize", { token: entry.token, source: label });
    }
    if (command === "tearout_start_move") {
      const owner = reserved.find(([id, entry]) => entry.receiver === label || (entry.receiver === args.label && !(id === args.id && entry.source === label)));
      if (owner) return proof(owner);
      nativeEnd(label, args, label === "B" && args.mode === "dock" ? approval(args.id) : null);
    }
    if (command === "tearout_retire") {
      windows.get(args.label)?.list.setState({ workspaces: [], activeWorkspaceId: null });
      for (const [session, owner] of channels) if (owner === args.label) channels.delete(session);
      if (args.finalizeLabel) {
        const entry = transfers.get(args.transferId)!; entry.finalized = true;
        await emitTo(args.finalizeLabel, "mycmux://tearout-finalize", { token: args.finalizeToken, source: entry.source });
      }
      if (args.receiptLabel) await emitTo(args.receiptLabel, "mycmux://tearout-receipt", { token: args.receiptToken, ok: true });
    }
    if (command === "tearout_forget") { const entry = transfers.get(args.id); if (entry?.finalized || entry?.phase === "rolled_back") transfers.delete(args.id); }
  } }));
  vi.doMock("@tauri-apps/api/event", () => ({ emit: async () => {}, emitTo, listen: async (event: string, callback: (event: { payload: any }) => void, options: any) => {
    const key = `${options?.target?.label ?? label}:${event}`, callbacks = listeners.get(key) ?? new Set();
    callbacks.add(callback); listeners.set(key, callbacks); return () => { callbacks.delete(callback); };
  } }));
  vi.doMock("@tauri-apps/api/window", () => ({ getAllWindows: async () => [...windows.keys()].map(label => ({ label })) }));
  vi.doMock("../../src/lib/tearout/sessionAttachment", () => ({ rememberTearoutDormantSessions: () => {}, expectTearoutAttachments: (ids: string[]) => {
    for (const id of ids) channels.set(id, label);
    return { ready: label === "B" && stage === "attachment" ? delay.promise : Promise.resolve(), dispose: () => {} };
  } }));
  vi.doMock("../../src/components/terminal/terminalCache", async original => ({ ...await original<typeof import("../../src/components/terminal/terminalCache")>(), evictTerminalCache: () => {} }));
  vi.doMock("../../src/lib/tearout/release", async original => ({ ...await original<typeof import("../../src/lib/tearout/release")>(),
    // An authenticated valid release is a precondition; release/frame behavior
    // has its own suite. Here real delivery, store mutation and rollback run.
    TearoutReleaseReceiver: class { consume = async () => true; dispose() {} },
  }));
  const runtime = await import("../../src/lib/tearout/runtime");
  const { useWorkspaceListStore: list } = await import("../../src/stores/workspaceListStore");
  const { useUiStore: ui } = await import("../../src/stores/uiStore");
  const { useToastStore: toasts } = await import("../../src/stores/toastStore");
  const { useSettingsStore: settings } = await import("../../src/stores/settingsStore");
  const move = await import("../../src/lib/paneMoveOperation");
  list.setState({ workspaces: label === "A" ? [structuredClone(source)] : [], activeWorkspaceId: label === "A" ? "original" : null });
  toasts.setState({ toasts: [] }); settings.setState({ nativePaneTearoutEnabled: true });
  const stop = runtime.installTearoutRuntime({ serialize: config, publish: async () => {
    if (label === "A" && stage === "publication" && !list.getState().workspaces.length) await delay.promise;
  } });
  const context = { label, runtime, list, ui, toasts, move, stop }; windows.set(label, context); return context;
}
async function detach(context: WindowContext) {
  const ws = context.list.getState().workspaces[0], pane = ws.panes[0], tab = pane.tabs[0];
  const request = context.move.createPaneMoveRequest({ kind: "tab", workspaceId: ws.id, paneId: pane.id, tabId: tab.id, label: "Terminal" },
    { kind: "native-window", gap: { x: 0, y: 0, width: 90, height: 30 }, offset: { x: 8, y: 8 } });
  return context.runtime.performNativePaneMove(request, { assertSource: () => expect(context.move.validatePaneMoveRequest(request)).toBeNull(),
    mark: () => {}, result: (status, reason) => ({ operationId: request.operationId, status, reason, phase: "requested", receipt: "pending" }) }, {});
}
beforeEach(() => { vi.clearAllMocks(); calls.length = 0; transfers.clear(); channels.clear(); listeners.clear(); windows.clear(); delay = deferred();
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" }); });
afterEach(() => { for (const context of windows.values()) context.stop(); vi.resetModules(); });

describe("R2 provisional incoming ownership survives native end", () => {
  it.each(["attachment", "publication"].flatMap(stage => ["dock", "detach", "outgoing"].map(entry => [stage, entry] as const)))(
    "refuses B→C before mutation during A→B %s via %s, then recovers one owner/channel", async (pendingStage, entry) => {
      stage = pendingStage; const a = await openWindow("A"), b = await openWindow("B"), c = await openWindow("C");
      channels.set("pty-original", "A");
      const first = detach(a); void first.catch(() => {});
      await vi.waitFor(() => expect(b.list.getState().workspaces).toHaveLength(1));
      await vi.waitFor(() => expect(calls.some(call => call.caller === "A" && call.command === "tearout_start_move")).toBe(true));
      expect(a.list.getState().workspaces).toHaveLength(0); expect(channels.get("pty-original")).toBe("B");
      const beforeSecond = calls.length;
      let refusal: unknown;
      if (entry === "outgoing") {
        await emitTo("B", "mycmux://tearout-outgoing", { token: "second", deliveryToken: "second-delivery", requester: "B",
          approval: approval("second") });
        await vi.waitFor(() => expect(calls.some(call => call.caller === "B" && call.command === "tearout_prepare")
          || b.list.getState().workspaces.length === 1).toBe(true));
      } else {
        try { await (entry === "dock" ? b.runtime.regrabTearoutWindow() : detach(b)); }
        catch (error) { refusal = error; }
      }
      // Let an incorrectly accepted second transfer finish before failing the
      // original one, to expose the A+C duplicate rather than a serial-store test.
      await new Promise(resolve => setTimeout(resolve, 30));
      const secondMutations = calls.slice(beforeSecond).filter(call => call.caller === "B" && ["tearout_start_move", "tearout_take_spare", "tearout_prepare", "tearout_retire"].includes(call.command));
      delay.reject(new Error(`synthetic ${stage} failure`)); await first.catch(() => {});
      await vi.waitFor(() => expect(a.list.getState().workspaces).toHaveLength(1));
      expect(secondMutations).toEqual([]);
      if (entry !== "outgoing") expect(refusal).toMatchObject({ name: "LocalTearoutRefusal", phase: "moving" });
      expect(b.toasts.getState().toasts.some(toast => toast.kind === "error")).toBe(false);
      const owners = [...windows.values()].filter(context => context.list.getState().workspaces.some(ws => ws.panes.some(p => p.tabs.some(t => t.id === "tab"))));
      expect(owners.map(context => context.label)).toEqual(["A"]);
      expect([...channels]).toEqual([["pty-original", "A"]]);
    }, 15000);
  it.each(["dock", "detach"] as const)("backend reservation refuses %s before the child's delivery listener has restored anything", async entry => {
    stage = "publication"; await openWindow("A"); const b = await openWindow("B"); await openWindow("C");
    b.list.setState({ workspaces: [structuredClone(source)], activeWorkspaceId: source.id });
    transfers.set("original-move", { source: "A", receiver: "B", token: "original-delivery", phase: "cleaned", finalized: false, sessions: ["pty-original"] });
    const before = calls.length;
    await expect(entry === "dock" ? b.runtime.regrabTearoutWindow() : detach(b)).rejects.toMatchObject({ name: "LocalTearoutRefusal", phase: "moving" });
    expect(calls.slice(before).some(call => ["tearout_start_move", "tearout_take_spare", "tearout_prepare", "tearout_retire", "tearout_warm"].includes(call.command))).toBe(false);
    expect(b.list.getState().workspaces).toEqual([source]);
    expect(b.toasts.getState().toasts.some(toast => toast.kind === "error")).toBe(false);
    expect(transfers.get("original-move")?.finalized).toBe(false);
  });
  it("an unrelated finalize cannot unlock the receiver; valid source finalization unlocks it", async () => {
    stage = "publication"; const a = await openWindow("A"), b = await openWindow("B"); await openWindow("C");
    const first = detach(a);
    await vi.waitFor(() => expect(b.list.getState().workspaces).toHaveLength(1));
    const token = [...transfers.values()][0].token;
    await emitTo("B", "mycmux://tearout-finalize", { token, source: "C" });
    await expect(b.runtime.regrabTearoutWindow()).rejects.toMatchObject({ name: "LocalTearoutRefusal", phase: "moving" });
    delay.resolve(); await first;
    await b.runtime.regrabTearoutWindow();
    await vi.waitFor(() => expect(windows.get("C")!.list.getState().workspaces).toHaveLength(1));
  });
  it("allows the next whole-child dock immediately after successful source finalization", async () => {
    stage = "publication"; const a = await openWindow("A"), b = await openWindow("B"), c = await openWindow("C");
    channels.set("pty-original", "A"); const first = detach(a);
    await vi.waitFor(() => expect(b.list.getState().workspaces).toHaveLength(1));
    delay.resolve(); await first;
    await b.runtime.regrabTearoutWindow();
    await vi.waitFor(() => expect(c.list.getState().workspaces).toHaveLength(1));
    expect(a.list.getState().workspaces).toHaveLength(0); expect(b.list.getState().workspaces).toHaveLength(0);
    expect([...channels]).toEqual([["pty-original", "C"]]);
  }, 15000);
});
