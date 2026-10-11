// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Runtime, operation state, executor, stores, sidebar and toast rendering are
// real. Only Tauri IPC is substituted; web tabs need no fake PTY attachment.
const boundary = vi.hoisted(() => ({
  invoke: vi.fn(), emitTo: vi.fn(), listeners: new Map<string, Set<(event: { payload: any }) => void>>(),
  reserved: false, refusePrepare: false, reserveAtNativeStart: false,
}));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: boundary.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit: async () => {}, emitTo: boundary.emitTo,
  listen: async (name: string, callback: (event: { payload: any }) => void) => {
    const callbacks = boundary.listeners.get(name) ?? new Set(); callbacks.add(callback); boundary.listeners.set(name, callbacks);
    return () => callbacks.delete(callback);
  } }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "B" }) }));
import TabBar from "../../src/components/layout/TabBar";
import ToastHost from "../../src/components/common/ToastHost";
import { toTransferConfig } from "../../src/components/layout/SocketListener";
import { installTearoutRuntime, regrabTearoutWindow, tearoutTab } from "../../src/lib/tearout/runtime";
import { beginTearoutOperation, endTearoutOperation, tearoutOperationBusy } from "../../src/lib/tearout/operation";
import { tearOutWorkspaceToNewWindow } from "../../src/lib/workspaceTearOut";
import { commitPaneDragDrop } from "../../src/hooks/usePaneDragSource";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneDragStore } from "../../src/stores/paneDragStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useToastStore, __resetToastStoreForTests } from "../../src/stores/toastStore";
import type { Workspace } from "../../src/types";

const notice = "前の移動の確定を待っています。確認が終わってからもう一度操作してください。";
const workspace: Workspace = { id: "workspace", name: "Web", createdAt: 1, status: "running", gridTemplateId: "1x1",
  panes: [{ id: "pane", agentId: "web", sessionId: "web-original", activeTabId: "tab",
    tabs: [{ id: "tab", agentId: "web", sessionId: "web-original", type: "web" }] }] };
const proof = () => ({ kind: "rejected_busy", pre_ownership: true, phase: "moving", owner_id: "first", source: "A", label: "B" });
function dispatch(name: string, payload: unknown): void {
  for (const callback of [...(boundary.listeners.get(name) ?? [])]) callback({ payload });
}
async function flush(): Promise<void> { for (let i = 0; i < 40; i++) await Promise.resolve(); }
let root: Root, host: HTMLDivElement, stop: () => void, incoming = false, incomingToken = "", serial = 0;
beforeEach(async () => {
  vi.useFakeTimers(); vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
  boundary.listeners.clear(); boundary.reserved = false; boundary.refusePrepare = false; boundary.reserveAtNativeStart = false;
  incoming = false; incomingToken = `V-incoming-${++serial}`;
  endTearoutOperation(); __resetToastStoreForTests(); usePaneDragStore.getState().clearDrag();
  useWorkspaceListStore.setState({ workspaces: [structuredClone(workspace)], activeWorkspaceId: workspace.id, lastActivePaneByWorkspace: {} });
  useUiStore.setState({ activePaneId: "web-original", zoomedPaneId: null });
  // Waiting for an ownership decision must remain visible with optional
  // activity/user-action notifications disabled.
  useSettingsStore.setState({ nativePaneTearoutEnabled: false, macNativePaneTearoutEnabled: false,
    notificationsEnabled: false, toastUserActionEnabled: false });
  boundary.emitTo.mockImplementation(async (_label: string, event: string, payload: any) => {
    if (event === "mycmux://tearout-ready-query") dispatch("mycmux://tearout-receipt", { token: payload.token, ok: true });
  });
  boundary.invoke.mockImplementation(async (command: string) => {
    if (command === "tearout_transfer_refusal") return boundary.reserved ? proof() : undefined;
    if (command === "tearout_prepare" && boundary.refusePrepare) return proof();
    if (command === "tearout_start_move" && boundary.reserveAtNativeStart) { boundary.reserved = true; return proof(); }
    if (command === "open_workspace_window") return "C";
    if (command === "is_session_alive") return true;
  });
  stop = installTearoutRuntime({ serialize: toTransferConfig, publish: () => boundary.invoke("publish_window_state") });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { await flush(); root.render(<><TabBar onNewWorkspace={() => {}} onCloseWorkspace={() => {}} /><ToastHost /></>); });
});
afterEach(async () => {
  await act(async () => {
    if (incoming) dispatch("mycmux://tearout-revoke", { token: incomingToken, source: "A", ack: "cleanup" });
    await flush(); root.unmount(); stop();
  });
  host.remove(); endTearoutOperation(); __resetToastStoreForTests();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function receivePending(): Promise<void> {
  incoming = true;
  await act(async () => {
    useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
    dispatch("mycmux://tearout-delivery", { token: incomingToken, source: "A", configs: [toTransferConfig(workspace)], liveSessions: [] });
    await flush();
  });
  expect(boundary.emitTo).toHaveBeenCalledWith("A", "mycmux://tearout-receipt", { token: incomingToken, ok: true });
  expect(tearoutOperationBusy()).toBe(true);
}
type Entry = "dock" | "detach" | "ordinary";
function attempt(entry: Entry): Promise<unknown> {
  if (entry === "dock") return regrabTearoutWindow();
  if (entry === "ordinary") return tearOutWorkspaceToNewWindow(workspace.id);
  return tearoutTab({ kind: "tab", workspaceId: workspace.id, paneId: "pane", tabId: "tab", label: "Web" },
    { x: 0, y: 0, width: 90, height: 30 }, { x: 8, y: 8 });
}
async function refused(entry: Entry): Promise<void> {
  await act(async () => { await expect(attempt(entry)).rejects.toMatchObject({ name: "LocalTearoutRefusal", phase: "moving" }); await flush(); });
}
function expectNotice(): void {
  expect(visibleToasts().filter(toast => toast.message === notice)).toEqual([expect.objectContaining({ message: notice, kind: "warning" })]);
  expect(visibleToasts().some(toast => toast.kind === "error")).toBe(false);
  const rendered = [...host.querySelectorAll<HTMLElement>('[aria-live="polite"] [role="status"]')].find(element => element.textContent?.includes(notice));
  expect(rendered?.textContent).toContain(notice);
  expect(rendered?.querySelector("svg")?.getAttribute("stroke")).toContain("--cmux-yellow");
  expect(rendered?.textContent).not.toMatch(/閉じ|再起動/);
}
function visibleToasts() {
  const state = useToastStore.getState();
  // The optional read also runs against the unchanged failure-first baseline.
  const explanation = (state as typeof state & { transferReservationNotice?: typeof state.toasts[number] | null }).transferReservationNotice;
  return [...state.toasts, ...(explanation ? [explanation] : [])];
}
const mutations = () => boundary.invoke.mock.calls.filter(([command]) =>
  ["tearout_start_move", "tearout_take_spare", "tearout_prepare", "tearout_retire", "tearout_finalize", "tearout_forget", "open_workspace_window"].includes(command));

it.each(["Win32", "MacIntel"])("%s renders the reservation notice through the actual ordinary sidebar and toast host", async platform => {
  Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
  await receivePending();
  const before = useWorkspaceListStore.getState().workspaces;
  const row = host.querySelector<HTMLElement>('[data-dnd-workspace-target-id="workspace"]')!;
  row.setPointerCapture = vi.fn(); row.hasPointerCapture = vi.fn(() => true); row.releasePointerCapture = vi.fn();
  for (const type of ["pointerdown", "pointermove", "pointerup"]) {
    const x = type === "pointerdown" ? 20 : window.innerWidth + 80;
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { button: { value: 0 }, pointerId: { value: 7 }, clientX: { value: x }, clientY: { value: 40 },
      screenX: { value: x }, screenY: { value: 40 } });
    await act(async () => { row.dispatchEvent(event); await flush(); });
  }
  expectNotice(); expect(mutations()).toEqual([]); expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
});
it.each(["dock", "detach", "ordinary"] as const)("shows the same non-red notice for a local incoming reservation via %s", async entry => {
  await receivePending(); const before = useWorkspaceListStore.getState().workspaces;
  await refused(entry); expectNotice(); expect(mutations()).toEqual([]); expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
});
it.each(["dock", "detach", "ordinary"] as const)("shows the same notice for native reservation proof before any local incoming state via %s", async entry => {
  boundary.reserved = true;
  await refused(entry); expectNotice(); expect(mutations()).toEqual([]); expect(useWorkspaceListStore.getState().workspaces).toEqual([workspace]);
});
it("shows the reservation notice when the native outgoing request is refused", async () => {
  await receivePending();
  await act(async () => {
    dispatch("mycmux://tearout-outgoing", { token: "second", deliveryToken: "second-delivery", requester: "B",
      approval: { receiver: "C", token: "painted", target: { kind: "workspace" } } });
    await flush();
  });
  expectNotice(); expect(mutations()).toEqual([]);
  expect(boundary.emitTo).toHaveBeenCalledWith("B", "mycmux://tearout-receipt", expect.objectContaining({ token: "second", ok: false, error: "tearout_move_busy" }));
});
it.each(["local", "native"] as const)("expiration and dismissal of the %s notice never release a reservation; repeated refusal stays visible", async reservation => {
  if (reservation === "local") await receivePending(); else boundary.reserved = true;
  await refused("dock"); expectNotice();
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); await flush(); });
  expect(visibleToasts()).toEqual([]);
  if (reservation === "local") expect(tearoutOperationBusy()).toBe(true); else expect(boundary.reserved).toBe(true);
  await refused("dock"); expectNotice();
  await refused("dock"); expectNotice(); // one deduplicated notice
  await act(async () => { useToastStore.getState().dismissToast(visibleToasts()[0].id); });
  await refused("dock"); expectNotice(); expect(mutations()).toEqual([]);
});
it("notices a reservation acquired between native preflight and start without acquiring ownership", async () => {
  boundary.reserveAtNativeStart = true;
  await refused("dock"); expectNotice();
  expect(mutations().map(([command]) => command)).toEqual(["tearout_start_move"]);
  expect(useWorkspaceListStore.getState().workspaces).toEqual([workspace]);
});
it("notices an ordinary prepare reservation without reporting a failed creation or rollback", async () => {
  boundary.refusePrepare = true;
  await refused("ordinary"); expectNotice();
  expect(mutations().map(([command]) => command)).toEqual(["open_workspace_window", "tearout_prepare", "tearout_retire"]);
  expect(useWorkspaceListStore.getState().workspaces).toEqual([workspace]);
});
it("keeps a repeated pointer refusal quiet rather than claiming a pending reservation", async () => {
  expect(beginTearoutOperation()).toBe(true);
  await refused("ordinary");
  expect(useToastStore.getState().toasts).toEqual([]); expect(mutations()).toEqual([]);
});
async function openFromContextMenu(): Promise<void> {
  const row = host.querySelector<HTMLElement>('[data-dnd-workspace-target-id="workspace"]')!;
  await act(async () => { row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 40 })); });
  const item = [...host.querySelectorAll<HTMLElement>('button, [role="menuitem"]')].find(element => element.textContent === "新しいウィンドウで開く");
  expect(item).toBeDefined();
  await act(async () => { item!.click(); await flush(); });
}
async function detachPaneInApp(): Promise<void> {
  await act(async () => {
    commitPaneDragDrop({ kind: "tab", workspaceId: workspace.id, paneId: "pane", tabId: "tab", label: "Web" },
      { kind: "new-window", screenX: 1200, screenY: 80 });
    await flush();
  });
}
it.each(["context-menu", "in-app-pane"] as const)("keeps a typed reservation refusal non-red through the %s entry", async entry => {
  await receivePending();
  await (entry === "context-menu" ? openFromContextMenu() : detachPaneInApp());
  expectNotice(); expect(mutations()).toEqual([]);
});
it.each(["context-menu", "in-app-pane"] as const)("keeps a genuine create failure visible through the %s entry", async entry => {
  const invoke = boundary.invoke.getMockImplementation()!;
  boundary.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "open_workspace_window") throw new Error("synthetic create failure");
    return invoke(command, args);
  });
  await (entry === "context-menu" ? openFromContextMenu() : detachPaneInApp());
  expect(useToastStore.getState().toasts.some(toast => toast.kind === "error")).toBe(true);
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(useWorkspaceListStore.getState().workspaces).toEqual([workspace]);
});

async function dragFromSidebar(): Promise<void> {
  const row = host.querySelector<HTMLElement>('[data-dnd-workspace-target-id="workspace"]')!;
  row.setPointerCapture = vi.fn(); row.hasPointerCapture = vi.fn(() => true); row.releasePointerCapture = vi.fn();
  for (const type of ["pointerdown", "pointermove", "pointerup"]) {
    const x = type === "pointerdown" ? 20 : window.innerWidth + 80;
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { button: { value: 0 }, pointerId: { value: 8 }, clientX: { value: x }, clientY: { value: 40 },
      screenX: { value: x }, screenY: { value: 40 } });
    await act(async () => { row.dispatchEvent(event); await flush(); });
  }
}
it.each(["detach", "regrab", "sidebar", "context-menu", "pane"] as const)(
  "V2 I2 renders the reserved %s explanation beside three real action toasts without evicting them", async entry => {
    await receivePending();
    const actions = ["Undo", "Retry", "Visit"].map(label => ({ label, run: vi.fn() }));
    let ids: string[] = [];
    await act(async () => {
      ids = actions.map((action, i) => useToastStore.getState().pushToast(`Existing operation ${i}`, "info", action,
        undefined, 20_000, "failure"));
    });
    const before = useWorkspaceListStore.getState().workspaces;
    if (entry === "detach" || entry === "regrab") await refused(entry === "detach" ? "detach" : "dock");
    else if (entry === "sidebar") await dragFromSidebar();
    else if (entry === "context-menu") await openFromContextMenu();
    else await detachPaneInApp();
    expectNotice();
    expect(useToastStore.getState().toasts.filter(toast => toast.action).map(toast => toast.id)).toEqual(ids);
    for (const action of actions) {
      expect([...host.querySelectorAll("button")].some(button => button.textContent === action.label)).toBe(true);
      expect(action.run).not.toHaveBeenCalled();
    }
    expect(host.querySelector('[aria-live="polite"] [role="alert"]')).toBeNull();
    expect(mutations()).toEqual([]); expect(tearoutOperationBusy()).toBe(true);
    expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); await flush(); });
    expect(visibleToasts().filter(toast => toast.message === notice)).toEqual([]);
    expect(useToastStore.getState().toasts.map(toast => toast.id)).toEqual(ids);
    expect(tearoutOperationBusy()).toBe(true);
    await refused("dock"); await refused("dock"); expectNotice();
    const explanation = visibleToasts().find(toast => toast.message === notice)!;
    expect(explanation.action).toBeUndefined(); expect(explanation.actions).toBeUndefined();
    await act(async () => {
      const close = [...host.querySelectorAll<HTMLElement>('[aria-live="polite"] [role="status"]')]
        .find(element => element.textContent?.includes(notice))!.querySelector<HTMLButtonElement>("button")!;
      close.click();
    });
    expect(visibleToasts().filter(toast => toast.message === notice)).toEqual([]);
    expect(useToastStore.getState().toasts.map(toast => toast.id)).toEqual(ids);
    expect(tearoutOperationBusy()).toBe(true); expect(mutations()).toEqual([]);
    await act(async () => {
      for (const action of actions) [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === action.label)!.click();
    });
    for (const action of actions) expect(action.run).toHaveBeenCalledOnce();
    expect(useToastStore.getState().toasts).toEqual([]);
  },
);

type OutgoingFault = "none" | "release-cleanup" | "geometry-restore" | "outgoing-cleanup" | "prepare";
type ReceiptAlteration = "none" | "bare-string" | "wrong-delivery" | "wrong-source" | "not-preownership";
async function releaseRegrab(reservation: "incoming" | "native" | "none", fault: OutgoingFault = "none", alteration: ReceiptAlteration = "none") {
  const approval = { receiver: "C", token: `V2-painted-${serial}`, release_id: `V2-release-${serial}`,
    layout_revision: "C-current-view", target: { kind: "workspace" } };
  const original = { x: 30, y: 40, width: 600, height: 400 };
  const invoke = boundary.invoke.getMockImplementation()!;
  boundary.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "tearout_resolve_release") return approval;
    if ((command === "tearout_release_cancel" && fault === "release-cleanup")
      || (command === "tearout_restore_geometry" && fault === "geometry-restore")
      || (command === "tearout_forget" && fault === "outgoing-cleanup")) throw new Error(`synthetic ${fault} failure`);
    if (command === "tearout_prepare" && fault === "prepare") throw new Error("tearout_move_busy");
    return invoke(command, args);
  });
  const emit = boundary.emitTo.getMockImplementation()!;
  boundary.emitTo.mockImplementation(async (label: string, event: string, payload: any) => {
    if (event === "mycmux://tearout-outgoing" && label === "B") dispatch(event, payload);
    else if (event === "mycmux://tearout-receipt" && label === "B") {
      let receipt = payload;
      if (alteration === "bare-string") receipt = { token: payload.token, ok: false, error: "tearout_move_busy" };
      else if (alteration !== "none") receipt = { ...payload, refusal: { ...payload.refusal,
        ...(alteration === "wrong-delivery" ? { deliveryToken: "another-operation" }
          : alteration === "wrong-source" ? { source: "A" } : { pre_ownership: false }) } };
      dispatch(event, receipt);
    }
    else if (event === "mycmux://tearout-revoke" && label === "C") {
      // C has no B delivery to undo, but its Tauri receipt acknowledges cleanup.
      dispatch("mycmux://tearout-receipt", { token: payload.ack, ok: true });
    }
    else return emit(label, event, payload);
  });
  await act(async () => { await regrabTearoutWindow(); await flush(); });
  const start = boundary.invoke.mock.calls.find(([command]) => command === "tearout_start_move")![1];
  expect(start.mode).toBe("dock"); expect(tearoutOperationBusy()).toBe(true);
  // The second gesture really started before A-to-B/native reservation appears.
  if (reservation === "incoming") await receivePending();
  if (reservation !== "none") boundary.reserved = true;
  if (reservation === "native") boundary.refusePrepare = true;
  const before = useWorkspaceListStore.getState().workspaces;
  await act(async () => {
    dispatch("mycmux://tearout-native", { ...start, source: "B", phase: "end", at: Date.now(), escaped: false,
      receiver: "C", client_x: 80, client_y: 80, approval: null, error: null,
      release: { x: 80, y: 80, at: Date.now(), method: "native_up" }, original,
      scale: 1, monitor: "test", focus_stolen: false, native_started_at: Date.now(), x: 80, y: 80 });
    await flush(); await flush();
  });
  const outgoing = boundary.emitTo.mock.calls.find(([label, event]) => label === "B" && event === "mycmux://tearout-outgoing")![2];
  expect(boundary.emitTo).toHaveBeenCalledWith("B", "mycmux://tearout-receipt", expect.objectContaining({ token: outgoing.token, ok: false }));
  expect(useWorkspaceListStore.getState().workspaces).toEqual(before);
  expect(boundary.emitTo.mock.calls.some(([label, event]) => label === "C" && event === "mycmux://tearout-delivery")).toBe(false);
  expect(boundary.invoke.mock.calls.some(([command]) => command === "tearout_retire" || command === "tearout_finalize")).toBe(false);
  if (reservation !== "none") expect(boundary.reserved).toBe(true);
  if (reservation === "incoming") expect(tearoutOperationBusy()).toBe(true);
  return { outgoing, approval, original };
}
it.each(["incoming", "native"] as const)("V2 I1 keeps the late %s refusal yellow through real regrab/outgoing/receipt, with release and geometry cleanup", async reservation => {
  const { outgoing, approval, original } = await releaseRegrab(reservation);
  expectNotice();
  expect(visibleToasts().some(toast => toast.kind === "error")).toBe(false);
  expect(host.querySelector('[aria-live="polite"] [role="alert"]')).toBeNull();
  expect(boundary.invoke).toHaveBeenCalledWith("tearout_release_cancel", { id: approval.release_id });
  expect(boundary.invoke).toHaveBeenCalledWith("tearout_restore_geometry", { label: "B", geometry: original });
  expect(boundary.invoke.mock.calls.some(([command, args]) => command === "tearout_phase" && args.id === outgoing.deliveryToken)).toBe(false);
});
it.each(["release-cleanup", "geometry-restore", "outgoing-cleanup", "prepare"] as const)(
  "V2 I1 keeps a genuine %s failure red through the real receipt path", async fault => {
    await releaseRegrab(fault === "outgoing-cleanup" ? "native" : fault === "prepare" ? "none" : "incoming", fault);
    expect(visibleToasts().some(toast => toast.kind === "error")).toBe(true);
    expect(host.querySelector('[aria-live="polite"] [role="alert"]')).not.toBeNull();
  },
);
it.each(["bare-string", "wrong-delivery", "wrong-source", "not-preownership"] as const)(
  "V2 I1 never suppresses an unproven or uncorrelated %s receipt", async alteration => {
    await releaseRegrab("incoming", "none", alteration);
    expect(visibleToasts().some(toast => toast.kind === "error")).toBe(true);
    expect(host.querySelector('[aria-live="polite"] [role="alert"]')).not.toBeNull();
  },
);
it("V2 failed late reservation lookup preserves an authenticated native-start refusal without a red failure or ownership", async () => {
  boundary.reserveAtNativeStart = true;
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const invoke = boundary.invoke.getMockImplementation()!;
  let lookups = 0;
  boundary.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "tearout_transfer_refusal" && ++lookups === 2) throw new Error("synthetic late lookup failure");
    return invoke(command, args);
  });
  await refused("dock");
  expect(lookups).toBe(2); expect(boundary.reserved).toBe(true);
  expect(visibleToasts().some(toast => toast.kind === "error")).toBe(false);
  expect(host.querySelector('[aria-live="polite"] [role="alert"]')).toBeNull();
  expect(mutations().map(([command]) => command)).toEqual(["tearout_start_move"]);
  expect(useWorkspaceListStore.getState().workspaces).toEqual([workspace]);
  expect(warning).toHaveBeenCalledWith("[tearout] reservation notice check failed", expect.any(Error));
});
