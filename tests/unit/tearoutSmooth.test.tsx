// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transfer: vi.fn(async () => {}), invoke: vi.fn(async () => {}) }));
vi.mock("../../src/lib/tearout/runtime", () => ({
  tearoutTab: mocks.transfer, tearoutPane: mocks.transfer, tearoutWorkspace: mocks.transfer,
  canRegrabTearoutTab: () => false, canRegrabTearoutPane: () => false, regrabTearoutWindow: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()), invoke: mocks.invoke }));
vi.mock("../../src/lib/tearout/record", () => ({ TearoutRecord: class { outside() {} error() {} async finish() {} } }));
import { beginNativePaneDrag, beginNativeWorkspaceDrag } from "../../src/lib/tearout/pointerDrag";
import { FrameHistogram, startTearoutFrames, finishTearoutFrames, disposeTearoutFrames } from "../../src/lib/tearout/frameMetrics";
import PaneDragOverlay from "../../src/components/workspace/PaneDragOverlay";
import { usePaneDragStore } from "../../src/stores/paneDragStore";

const item = { kind: "tab" as const, workspaceId: "source", paneId: "pane", tabId: "tab", label: "Terminal" };
let callbacks: Map<number, FrameRequestCallback>;
let frameId: number;
function frame(at = 16.7) {
  const pending = [...callbacks.values()]; callbacks.clear();
  for (const callback of pending) callback(at);
}
function pointer(type: string, x: number, y: number): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, Object.fromEntries(Object.entries({ button: 0, pointerId: 1, clientX: x, clientY: y })
    .map(([key, value]) => [key, { value }])));
  return event as PointerEvent;
}
function surface() {
  const strip = document.createElement("div"); strip.className = "pane-tabbar"; strip.dataset.dndWorkspaceSidebar = "true";
  const grip = document.createElement("span"); strip.append(grip); document.body.append(strip);
  strip.getBoundingClientRect = () => new DOMRect(0, 0, 300, 36);
  grip.getBoundingClientRect = () => new DOMRect(0, 0, 90, 36);
  return grip;
}
beforeEach(() => {
  vi.clearAllMocks(); callbacks = new Map(); frameId = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callbacks.set(++frameId, callback); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
  usePaneDragStore.getState().clearDrag();
});
afterEach(() => {
  window.dispatchEvent(pointer("pointercancel", 0, 0)); disposeTearoutFrames();
  document.body.replaceChildren(); usePaneDragStore.getState().clearDrag(); vi.unstubAllGlobals();
  delete window.__MYCMUX_TEAROUT_PERF__;
});

describe("high-rate drag state and termination", () => {
  it.each(["pane", "workspace"])("coalesces %s movement and commits the exact release point", (kind) => {
    const grip = surface(); const resolve = vi.fn(); const commit = vi.fn();
    const cb = { suppress: vi.fn(), resolve, commit };
    if (kind === "pane") beginNativePaneDrag(pointer("pointerdown", 10, 10), grip, item, cb);
    else beginNativeWorkspaceDrag(pointer("pointerdown", 10, 10), grip, "source", cb);
    for (let x = 20; x < 260; x++) window.dispatchEvent(pointer("pointermove", x, 10));
    expect(resolve).not.toHaveBeenCalled();
    frame(); expect(resolve).toHaveBeenCalledExactlyOnceWith(259, 10);
    window.dispatchEvent(pointer("pointermove", 261, 10));
    window.dispatchEvent(pointer("pointerup", 280, 10));
    expect(resolve).toHaveBeenLastCalledWith(280, 10); expect(commit).toHaveBeenCalledOnce();
    frame(); expect(resolve).toHaveBeenCalledTimes(2);
    expect(usePaneDragStore.getState().item).toBeNull();
  });
  it("handoff and Esc cancel queued frames, including a subframe boundary crossing", () => {
    const grip = surface(); const resolve = vi.fn();
    beginNativePaneDrag(pointer("pointerdown", 10, 10), grip, item, { suppress: vi.fn(), resolve, commit: vi.fn() });
    window.dispatchEvent(pointer("pointermove", 30, 10));
    window.dispatchEvent(pointer("pointermove", 30, 49));
    frame(); expect(resolve).not.toHaveBeenCalled(); expect(mocks.transfer).toHaveBeenCalledOnce();
    beginNativePaneDrag(pointer("pointerdown", 10, 10), grip, item, { suppress: vi.fn(), resolve, commit: vi.fn() });
    window.dispatchEvent(pointer("pointermove", 30, 10));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    frame(); expect(resolve).not.toHaveBeenCalled(); expect(mocks.transfer).toHaveBeenCalledOnce();
  });
  it("moves the mounted ghost without repeated layout reads and clamps at the viewport edge", async () => {
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    await act(async () => { usePaneDragStore.getState().beginDrag(item, { x: 10, y: 20 }); root.render(<PaneDragOverlay />); });
    const ghost = host.querySelector<HTMLElement>(".pane-drag-ghost")!;
    const width = vi.spyOn(ghost, "offsetWidth", "get");
    const height = vi.spyOn(ghost, "offsetHeight", "get");
    const mounted = ghost;
    for (let i = 0; i < 240; i++) usePaneDragStore.getState().moveDrag({ x: 10+i, y: 20 });
    frame();
    expect(host.querySelector(".pane-drag-ghost")).toBe(mounted);
    expect(ghost.style.transform).toBe("translate3d(263px, 34px, 0)");
    expect(width).not.toHaveBeenCalled(); expect(height).not.toHaveBeenCalled();
    usePaneDragStore.getState().moveDrag({ x: window.innerWidth-2, y: window.innerHeight-2 }); frame();
    expect(ghost.style.transform).toBe(`translate3d(${window.innerWidth-8}px, ${window.innerHeight-8}px, 0)`);
    await act(async () => root.unmount()); width.mockRestore(); height.mockRestore();
  });
});

describe("bounded real-drag frame recording", () => {
  it("keeps quantiles and exact slow-frame counts without retaining frames", () => {
    const histogram = new FrameHistogram();
    for (let i = 0; i < 100_000; i++) histogram.add(16.7);
    histogram.add(1000.1); histogram.add(Number.NaN);
    expect(histogram.summary()).toEqual({ count: 100001, median: 16.75, p95: 16.75, max: 1000.1, over20: 1, over33: 1 });
  });
  it("writes one metadata-only summary per webview/drag after frames finish", async () => {
    startTearoutFrames("real-drag"); startTearoutFrames("real-drag");
    frame(10); frame(26.7); frame(60.1);
    expect(mocks.invoke).not.toHaveBeenCalled();
    finishTearoutFrames("real-drag"); finishTearoutFrames("real-drag");
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce(), { timeout: 1000 });
    const record = mocks.invoke.mock.calls[0][1].record;
    expect(record).toMatchObject({ kind: "tearout_performance", drag_id: "real-drag", native: null,
      frames: { count: 2, p95: 33.5, over33: 1 } });
    expect(Object.keys(record)).toEqual(["kind", "drag_id", "window_label", "frames", "native"]);
    expect(callbacks.size).toBe(0);
  });
  it("respects opt-out and caps simultaneous recordings at four", () => {
    window.__MYCMUX_TEAROUT_PERF__ = false; startTearoutFrames("disabled");
    expect(callbacks.size).toBe(0);
    window.__MYCMUX_TEAROUT_PERF__ = true;
    for (let i=0;i<10;i++) startTearoutFrames(String(i));
    disposeTearoutFrames(); expect(mocks.invoke).toHaveBeenCalledTimes(4); expect(callbacks.size).toBe(0);
  });
});
