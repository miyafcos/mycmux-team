// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only the Tauri boundary is substituted. Hit testing/paint are controlled browser
// scheduling; the hook, runtime, release receiver, stores and restoration are real.
const boundary = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: { payload: any }) => void>>(),
  invoke: vi.fn(), emitTo: vi.fn(), frames: new Map<string, any>(), decisions: [] as any[],
  raf: new Map<number, FrameRequestCallback>(), nextFrame: 0, beginReply: null as Promise<any> | null,
}));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: boundary.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, callback: (event: { payload: any }) => void) => {
    const callbacks = boundary.listeners.get(name) ?? new Set(); callbacks.add(callback); boundary.listeners.set(name, callbacks);
    return () => callbacks.delete(callback);
  }, emit: async () => {}, emitTo: boundary.emitTo,
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
import { installTearoutRuntime, type NativeSample } from "../../src/lib/tearout/runtime";
import type { ReleaseFrame } from "../../src/lib/tearout/release";
import { usePaneDragSource } from "../../src/hooks/usePaneDragSource";
import TabBar from "../../src/components/layout/TabBar";
import { toTransferConfig } from "../../src/components/layout/SocketListener";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { usePaneDragStore, type PaneDragItem } from "../../src/stores/paneDragStore";
import { useDetachedDockStore } from "../../src/stores/detachedDockStore";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useUiStore } from "../../src/stores/uiStore";
import { useToastStore } from "../../src/stores/toastStore";
import { endTearoutOperation } from "../../src/lib/tearout/operation";
import type { Workspace } from "../../src/types";

function workspace(id: string): Workspace {
  return { id, name: id, createdAt: 1, status: "running", gridTemplateId: "1x1", splitColumns: [[`pane-${id}`]],
    columnWidths: [1], rowHeightsPerCol: [[1]], panes: [{ id: `pane-${id}`, sessionId: `web-${id}`, agentId: "web", activeTabId: `tab-${id}`,
      tabs: [{ id: `tab-${id}`, sessionId: `web-${id}`, agentId: "web", type: "web" }] }] };
}
function dispatch(name: string, payload: unknown): void {
  for (const callback of [...(boundary.listeners.get(name) ?? [])]) callback({ payload });
}
async function flush(): Promise<void> { for (let i = 0; i < 40; i++) await Promise.resolve(); }
async function paint(): Promise<void> {
  await act(async () => {
    const callbacks = [...boundary.raf.values()]; boundary.raf.clear(); callbacks.forEach(cb => cb(performance.now())); await flush();
  });
}
async function dwell(ms: number): Promise<void> { await act(async () => { await vi.advanceTimersByTimeAsync(ms); await flush(); }); }
let serial = 0;
let id: string;
let stop: () => void;
let root: Root | undefined;
let container: HTMLDivElement;
let rowA: HTMLElement, rowB: HTMLElement, missingRow: HTMLElement, newWorkspace: HTMLElement;
let paneA: HTMLElement, paneB: HTMLElement;
let hit: Element | null;
const delivered: { token: string; source: string }[] = [];
function sample(overrides: Partial<NativeSample> = {}): NativeSample {
  return { id, mode: "dock", label: "child", source: "child", receiver: "main", receiver_epoch: 1, region_count: 1,
    client_x: 150, client_y: 150, x: 150, y: 150, phase: "move", at: Date.now(), escaped: false,
    approval: null, native_started_at: 0, error: null, scale: 1, monitor: null, focus_stolen: false,
    esc_at: null, original: { x: 0, y: 0, width: 300, height: 240 }, ...overrides };
}
function release(overrides: Partial<ReleaseFrame> = {}): ReleaseFrame {
  return { id, mode: "dock", label: "child", source: "child", receiver: "main", receiver_epoch: 1, region_count: 1,
    client_x: 150, client_y: 150, token: `token-${id}`,
    point: { x: 150, y: 150, at: Date.now(), method: "native_up" }, ...overrides };
}
async function move(element: Element | null, overrides: Partial<NativeSample> = {}, painted = true): Promise<void> {
  hit = element;
  await act(async () => { dispatch("mycmux://tearout-native", sample(overrides)); await flush(); });
  if (painted) await paint();
}
async function request(frame = release()): Promise<void> {
  boundary.frames.set(frame.id, frame);
  await act(async () => { dispatch("mycmux://tearout-release", { id: frame.id, epoch: frame.receiver_epoch }); await flush(); });
}
async function finishPaint(): Promise<void> { await paint(); await paint(); await flush(); }
async function openB(): Promise<void> {
  await move(rowB); await dwell(350);
  expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("B");
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  boundary.listeners.clear(); boundary.frames.clear(); boundary.decisions = []; boundary.raf.clear(); boundary.beginReply = null;
  endTearoutOperation(); id = `B7-${++serial}`;
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
  window.__MYCMUX_TEAROUT_PERF__ = false;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
    const key = ++boundary.nextFrame; boundary.raf.set(key, callback); return key;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(key => { boundary.raf.delete(key); });
  useSettingsStore.setState({ nativePaneTearoutEnabled: true, macNativePaneTearoutEnabled: true });
  useWorkspaceListStore.setState({ workspaces: [workspace("A"), workspace("B")], activeWorkspaceId: "A", lastActivePaneByWorkspace: {} });
  useUiStore.setState({ activePaneId: "web-A", zoomedPaneId: null, sidebarCollapsed: true });
  usePaneDragStore.getState().clearDrag(); useDetachedDockStore.getState().clear(); useToastStore.setState({ toasts: [] });
  const sidebar = document.createElement("div"); sidebar.dataset.dndWorkspaceSidebar = "true";
  const makeRow = (name: string) => { const row = document.createElement("div"); row.dataset.dndWorkspaceTargetId = name; sidebar.append(row); return row; };
  rowA = makeRow("A"); rowB = makeRow("B"); missingRow = makeRow("missing");
  newWorkspace = document.createElement("button"); Object.assign(newWorkspace.dataset, { dndNewWorkspaceTarget: "true", dndWorkspaceTargetId: "B" }); sidebar.append(newWorkspace);
  const makePane = (name: string) => {
    const pane = document.createElement("div"); Object.assign(pane.dataset, { dndPaneId: `pane-${name}`, dndWorkspaceId: name });
    pane.getBoundingClientRect = () => new DOMRect(0, 30, 300, 240); return pane;
  };
  paneA = makePane("A"); paneB = makePane("B"); container = document.createElement("div");
  document.body.append(sidebar, paneA, paneB, container); hit = null;
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => hit });
  boundary.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "tearout_release_begin") return boundary.beginReply ?? boundary.frames.get(args.id);
    if (command === "tearout_release_decision") { boundary.decisions.push(args); return true; }
    if (command === "tearout_preview" || command === "tearout_release_consume") return true;
    if (command === "is_session_alive") return true;
  });
  boundary.emitTo.mockImplementation(async () => {});
  stop = installTearoutRuntime({ serialize: toTransferConfig, publish: () => boundary.invoke("publish_window_state") }); await flush();
});
afterEach(async () => {
  for (const delivery of delivered.splice(0)) dispatch("mycmux://tearout-revoke", { ...delivery, ack: `cleanup-${delivery.token}` });
  await flush();
  await act(async () => { root?.unmount(); root = undefined; stop(); await flush(); });
  endTearoutOperation(); document.body.replaceChildren(); usePaneDragStore.getState().clearDrag();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.__MYCMUX_TEAROUT_PERF__;
});

describe("B7 real receiver workspace hover", () => {
  it.each(["Win32", "MacIntel"])("%s opens at 350 ms, marks the row immediately and does not restart on repeated samples", async platform => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    await move(rowB);
    expect(usePaneDragStore.getState().hoverWorkspaceId).toBe("B");
    await dwell(200); await move(rowB); await dwell(149);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("A");
    await dwell(1);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("B");
    expect(usePaneDragStore.getState().hoverWorkspaceId).toBeNull();
    expect(useToastStore.getState().toasts).toEqual([]);
  });
  it.each(["current", "new", "missing", "outside"])("does not open on the %s target", async kind => {
    await move(kind === "current" ? rowA : kind === "new" ? newWorkspace : kind === "missing" ? missingRow : null);
    await dwell(700);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("A");
    expect(usePaneDragStore.getState().hoverWorkspaceId).toBeNull();
  });
  it("restarts the full dwell when the row changes", async () => {
    const third = workspace("C");
    useWorkspaceListStore.setState({ workspaces: [...useWorkspaceListStore.getState().workspaces, third] });
    const rowC = document.createElement("div"); rowC.dataset.dndWorkspaceTargetId = "C"; rowB.parentElement!.append(rowC);
    await move(rowB); await dwell(349); await move(rowC); await dwell(349);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("A");
    expect(usePaneDragStore.getState().hoverWorkspaceId).toBe("C");
    await dwell(1); expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("C");
  });
  it.each(["leave", "receiver-leave", "epoch", "end", "escape", "error", "dispose", "removed"])("cancels armed hover on %s before a coalesced frame can run", async reason => {
    await move(rowB); await dwell(349);
    expect(usePaneDragStore.getState().hoverWorkspaceId).toBe("B");
    if (reason === "leave") await move(paneA, {}, false);
    if (reason === "receiver-leave") await move(rowB, { receiver: null }, false);
    if (reason === "epoch") await move(rowB, { receiver_epoch: 2 }, false);
    if (reason === "end") await move(rowB, { phase: "end", release: null }, false);
    if (reason === "escape") await move(rowB, { phase: "end", escaped: true, release: null }, false);
    if (reason === "error") await move(rowB, { error: "native_move_failed" }, false);
    if (reason === "dispose") { stop(); stop = () => {}; }
    if (reason === "removed") useWorkspaceListStore.setState({ workspaces: [workspace("A")] });
    await dwell(1);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("A");
    if (reason !== "epoch") expect(usePaneDragStore.getState().hoverWorkspaceId).toBeNull();
  });
  it.each(["Win32", "MacIntel"])("%s detach never switches or paints a dock target", async platform => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    await move(rowB, { mode: "detach" }); await dwell(700);
    await move(rowB, { mode: "dock" }); await dwell(700); // One ID cannot change its mode.
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("A");
    expect(usePaneDragStore.getState().hoverWorkspaceId).toBeNull();
    expect(boundary.invoke.mock.calls.some(([command]) => command === "tearout_preview")).toBe(false);
  });
  it("uses the existing row mark, giving it priority over the new-workspace mark while waiting", async () => {
    root = createRoot(container);
    await act(async () => root!.render(<TabBar onNewWorkspace={() => {}} onCloseWorkspace={() => {}} />));
    const row = container.querySelector<HTMLElement>('[data-dnd-workspace-target-id="B"]')!;
    await move(row); await dwell(121); await move(row); await paint();
    expect(row.style.outline).toBe("1px solid var(--cmux-accent, #007aff)");
    expect(container.querySelector<HTMLElement>('[data-dnd-new-workspace-target="true"]')!.style.outline).toBe("1px solid transparent");
    await dwell(229);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("B");
    expect(row.style.outline).toBe("1px solid transparent");
  });
  it("Mac still switches when requestAnimationFrame is occluded, through the original sample fallback", async () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    await move(rowB, {}, false); await dwell(350);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("B");
  });
  it("does not arm again from delayed move samples after end or release", async () => {
    await move(rowB); await move(rowB, { phase: "end", release: null });
    await move(rowB); await dwell(700);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("A");
    expect(usePaneDragStore.getState().hoverWorkspaceId).toBeNull();
  });
});

describe("B7 workspace identity in preview and final release", () => {
  it("rejects an immediately received old-workspace DOM sample after switching", async () => {
    await openB();
    await move(paneA); await dwell(121); await move(paneA); await paint();
    expect(boundary.invoke.mock.calls.filter(([command, args]) => command === "tearout_preview" && args.target?.workspaceId === "A")).toEqual([]);
    expect(useDetachedDockStore.getState().target).toBeNull();
    await request(); await finishPaint();
    expect(boundary.decisions).toEqual([expect.objectContaining({ target: null, token: null })]);
  });
  it("invalidates a previous workspace's pending paint approval even before the next sample", async () => {
    await move(paneA); await dwell(121); await move(paneA);
    expect(useDetachedDockStore.getState().target).toMatchObject({ workspaceId: "A" });
    await act(async () => { useWorkspaceListStore.getState().setActiveWorkspace("B"); });
    await paint();
    expect(boundary.invoke.mock.calls.filter(([command, args]) => command === "tearout_preview" && args.token && args.target?.workspaceId === "A")).toEqual([]);
    expect(useDetachedDockStore.getState().target).toBeNull();
  });
  it("a late native hover-approval reply cannot dim the source after the workspace changed", async () => {
    let reply!: (value: boolean) => void;
    const pending = new Promise<boolean>(resolve => { reply = resolve; });
    const normal = boundary.invoke.getMockImplementation()!;
    boundary.invoke.mockImplementation((command: string, args: any) => command === "tearout_preview" && args.token ? pending : normal(command, args));
    await move(paneA); await dwell(121); await move(paneA); await paint();
    await act(async () => { useWorkspaceListStore.getState().setActiveWorkspace("B"); });
    reply(true); await flush();
    expect(boundary.invoke.mock.calls.filter(([command, args]) => command === "tearout_alpha" && args.alpha === 128)).toEqual([]);
  });
  it("release on an old pane during the switch cannot obtain a final approval", async () => {
    let requested = false;
    const unsubscribe = useWorkspaceListStore.subscribe(state => {
      if (state.activeWorkspaceId === "B" && !requested) {
        requested = true; hit = paneA; boundary.frames.set(id, release());
        dispatch("mycmux://tearout-release", { id, epoch: 1 });
      }
    });
    try { await openB(); await finishPaint(); }
    finally { unsubscribe(); }
    expect(requested).toBe(true);
    expect(boundary.decisions).toEqual([expect.objectContaining({ target: null, token: null })]);
  });
  it("release cancels a 349 ms hover before awaiting the native release snapshot", async () => {
    await move(rowB); await dwell(349);
    expect(usePaneDragStore.getState().hoverWorkspaceId).toBe("B");
    let ready!: (frame: ReleaseFrame) => void;
    boundary.beginReply = new Promise(resolve => { ready = resolve; });
    await request(); await dwell(1);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("A");
    expect(usePaneDragStore.getState().hoverWorkspaceId).toBeNull();
    ready(release()); await flush(); await finishPaint();
    expect(boundary.decisions[0].target).toEqual({ kind: "workspace" });
  });
  it.each(["Win32", "MacIntel"])("%s sidebar release still creates a new workspace, including multi-region windows", async platform => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    await move(rowB, { region_count: 2 }); await dwell(350);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("B");
    await request(release({ region_count: 2 })); await finishPaint();
    expect(boundary.decisions[0].target).toEqual({ kind: "workspace" });
    hit = paneB; await request(release({ id: `${id}-pane`, token: `${id}-pane-token`, region_count: 2 }));
    expect(boundary.decisions.at(-1).target).toBeNull();
  });
  it.each(["Win32", "MacIntel"])("%s active workspace change during final paint cancels the old target", async platform => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    hit = paneA; await request();
    await act(async () => { useWorkspaceListStore.getState().setActiveWorkspace("B"); });
    await finishPaint();
    expect(boundary.decisions[0]).toMatchObject({ target: null, error: "tearout_drop_target_changed" });
  });
  it("returning to the old workspace cannot resurrect its previous final approval", async () => {
    hit = paneA; await request(); await finishPaint();
    const decision = boundary.decisions[0];
    expect(decision.target).toMatchObject({ workspaceId: "A" });
    await act(async () => {
      useWorkspaceListStore.getState().setActiveWorkspace("B");
      useWorkspaceListStore.getState().setActiveWorkspace("A");
    });
    const delivery = { token: `old-approval-${id}`, source: "child", configs: [toTransferConfig(workspace(`incoming-${id}`))], placement: decision.target,
      approval: { receiver: "main", token: decision.token, target: decision.target, release_id: id, layout_revision: decision.layoutRevision }, liveSessions: [] };
    delivered.push(delivery);
    await act(async () => { dispatch("mycmux://tearout-delivery", delivery); await flush(); });
    expect(boundary.invoke.mock.calls.filter(([command]) => command === "tearout_release_consume")).toEqual([]);
    expect(useWorkspaceListStore.getState().workspaces.flatMap(ws => ws.panes.flatMap(pane => pane.tabs.map(tab => tab.id)))).not.toContain(`tab-incoming-${id}`);
  });
  it("really adopts a multi-region sidebar drop as a new workspace after the hover switch", async () => {
    await move(rowB, { region_count: 2 }); await dwell(350);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("B");
    const beforeB = structuredClone(useWorkspaceListStore.getState().getWorkspace("B"));
    await request(release({ region_count: 2 })); await finishPaint();
    const decision = boundary.decisions[0]; expect(decision.target).toEqual({ kind: "workspace" });
    const bundle = workspace(`bundle-${id}`); bundle.panes.push(workspace(`second-${id}`).panes[0]);
    bundle.splitColumns = bundle.panes.map(pane => [pane.id]); bundle.columnWidths = [0.5, 0.5]; bundle.rowHeightsPerCol = [[1], [1]];
    const delivery = { token: `bundle-delivery-${id}`, source: "child", configs: [toTransferConfig(bundle)], placement: decision.target,
      approval: { receiver: "main", token: decision.token, target: decision.target, release_id: id, layout_revision: decision.layoutRevision }, liveSessions: [] };
    delivered.push(delivery);
    await act(async () => { dispatch("mycmux://tearout-delivery", delivery); await flush(); });
    const list = useWorkspaceListStore.getState();
    expect(boundary.emitTo).toHaveBeenCalledWith("child", "mycmux://tearout-receipt", { token: delivery.token, ok: true });
    expect(list.getWorkspace("B")).toEqual(beforeB);
    expect(list.workspaces).toHaveLength(3);
    expect(list.workspaces.find(ws => ws.id === list.activeWorkspaceId)!.panes).toHaveLength(2);
  });
  it.each(["Win32", "MacIntel"].flatMap(platform => ["center", "left"].map(zone => [platform, zone] as const)))(
    "%s switches then really adopts into B at its %s, leaving A intact", async (platform, zone) => {
      Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
      const beforeA = structuredClone(useWorkspaceListStore.getState().getWorkspace("A"));
      await openB(); hit = paneB;
      await request(release({ client_x: zone === "left" ? 20 : 150 })); await finishPaint();
      const decision = boundary.decisions[0];
      expect(decision.target).toEqual({ kind: "pane-zone", workspaceId: "B", paneId: "pane-B", zone });
      const config = toTransferConfig(workspace(`incoming-${id}`));
      const delivery = { token: `delivery-${id}`, source: "child", configs: [config], placement: decision.target,
        approval: { receiver: "main", token: decision.token, target: decision.target, release_id: id, layout_revision: decision.layoutRevision }, liveSessions: [] };
      delivered.push(delivery);
      await act(async () => { dispatch("mycmux://tearout-delivery", delivery); await flush(); });
      expect(boundary.emitTo).toHaveBeenCalledWith("child", "mycmux://tearout-receipt", { token: delivery.token, ok: true });
      const list = useWorkspaceListStore.getState();
      expect(list.getWorkspace("A")).toEqual(beforeA);
      const target = list.getWorkspace("B")!;
      const incomingTabId = config.panes[0].tabs![0].tab_id;
      expect(target.panes.flatMap(pane => pane.tabs.map(tab => tab.id))).toContain(incomingTabId);
      expect(target.panes).toHaveLength(zone === "center" ? 1 : 2);
      expect(list.activeWorkspaceId).toBe("B");
      expect(boundary.invoke.mock.calls.filter(([command]) => command === "tearout_release_consume")).toHaveLength(1);
      expect(boundary.invoke.mock.calls.filter(([command]) => command === "publish_window_state")).toHaveLength(1);
    });
});

function pointer(type: string, x: number, y: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { button: { value: 0 }, pointerId: { value: 1 }, clientX: { value: x }, clientY: { value: y }, screenX: { value: x }, screenY: { value: y } });
  return event;
}
function HookHarness({ item }: { item: PaneDragItem }) {
  const drag = usePaneDragSource();
  return <div data-testid="source" onPointerDown={event => drag.beginPointerDrag(event, item)} />;
}
describe("B7 shares the original native-off in-app policy", () => {
  it.each(["current", "new", "missing", "outside"])("in-app hover keeps the same %s exclusion", async kind => {
    useSettingsStore.setState({ nativePaneTearoutEnabled: false, macNativePaneTearoutEnabled: false });
    root = createRoot(container);
    const item: PaneDragItem = { kind: "tab", workspaceId: "A", paneId: "pane-A", tabId: "tab-A", label: "A" };
    await act(async () => root!.render(<HookHarness item={item} />));
    hit = kind === "current" ? rowA : kind === "new" ? newWorkspace : kind === "missing" ? missingRow : null;
    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="source"]')!.dispatchEvent(pointer("pointerdown", 10, 10));
      window.dispatchEvent(pointer("pointermove", 19, 10));
    });
    await dwell(700);
    expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("A");
    expect(usePaneDragStore.getState().hoverWorkspaceId).toBeNull();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  });
  it.each(["workspace", "minimap"] as const)("preserves %s hover and the 9 px in-app threshold", async surface => {
    useSettingsStore.setState({ nativePaneTearoutEnabled: false, macNativePaneTearoutEnabled: false });
    root = createRoot(container);
    const item: PaneDragItem = { kind: "tab", workspaceId: "A", paneId: "pane-A", tabId: "tab-A", label: "A", surface };
    await act(async () => root!.render(<HookHarness item={item} />));
    const source = container.querySelector<HTMLElement>('[data-testid="source"]')!; hit = rowB;
    await act(async () => {
      source.dispatchEvent(pointer("pointerdown", 10, 10));
      window.dispatchEvent(pointer("pointermove", 18, 10));
    });
    if (surface === "workspace") expect(usePaneDragStore.getState().item).toBeNull();
    await act(async () => window.dispatchEvent(pointer("pointermove", 19, 10)));
    expect(usePaneDragStore.getState().hoverWorkspaceId).toBe(surface === "workspace" ? "B" : null);
    await dwell(349); expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe("A");
    await dwell(1); expect(useWorkspaceListStore.getState().activeWorkspaceId).toBe(surface === "workspace" ? "B" : "A");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(usePaneDragStore.getState().item).toBeNull();
    expect(usePaneDragStore.getState().hoverWorkspaceId).toBeNull();
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
