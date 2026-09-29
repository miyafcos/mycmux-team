// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  label: "main",
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  outerPosition: vi.fn(async () => ({ x: 300, y: 150 })),
  scaleFactor: vi.fn(async () => 1.5),
  handoff: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  getAllWindows: vi.fn(async () => [{ label: "child" }]),
}));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: mocks.handoff, listen: vi.fn(async (name, callback) => {
  mocks.listeners.set(name, callback); return () => mocks.listeners.delete(name);
}) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: mocks.label, outerPosition: mocks.outerPosition, scaleFactor: mocks.scaleFactor }),
  getAllWindows: mocks.getAllWindows,
  Window: { getByLabel: vi.fn(async () => ({ close: mocks.close })) },
}));
import { detachedDockTarget, useDetachedDockStore, listenForDetachedDock,
  takeDetachedPlacements, DETACHED_DRAG_EVENT, type DetachedDragPayload } from "../../src/stores/detachedDockStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Workspace } from "../../src/types";
import { WINDOW_REGISTRY_CHANGED_EVENT } from "../../src/lib/ipc";

let hit: ReturnType<typeof vi.fn>;
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
async function frame() {
  const callbacks = [...frames.values()]; frames.clear();
  callbacks.forEach((callback) => callback(0));
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.label = "main";
  useWorkspaceListStore.setState({ workspaces: [{ id: "destination", panes: [{ id: "pane", tabs: [] }] } as unknown as Workspace] });
  frames.clear();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.set(++frameId, callback); return frameId; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  document.body.innerHTML = `<div data-dnd-workspace-id="destination" data-dnd-pane-id="pane">
    <div class="pane-tabbar"><div data-tab-id="a"></div><div data-tab-id="b"></div></div></div>`;
  const tabs = document.querySelectorAll<HTMLElement>("[data-tab-id]");
  tabs.forEach((tab, i) => { tab.getBoundingClientRect = () => ({ left: i * 100, right: (i + 1) * 100 }) as DOMRect; });
  hit = vi.fn((x: number, y: number) => x >= 0 && x <= 250 && y >= 0 && y < 30 ? tabs[0] : null);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hit });
  useDetachedDockStore.getState().clear();
  takeDetachedPlacements(["transfer"]);
});
afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });
const payload = (phase: DetachedDragPayload["phase"], screenX = 310): DetachedDragPayload => ({
  label: "child", workspaceId: "transfer", sessionId: "pty-carried", tabId: "incoming",
  screenX, screenY: 110, phase,
});
async function send(phase: DetachedDragPayload["phase"], x?: number) {
  mocks.listeners.get(DETACHED_DRAG_EVENT)!({ payload: payload(phase, x) });
  await frame();
}

describe("detached dock target", () => {
  it.each(["main", "mycmux-w2", "mycmux-w7"])("targets the actual receiving window %s", async (label) => {
    mocks.label = label;
    const stop = listenForDetachedDock();
    try {
      await send("start"); await send("end");
      expect(mocks.handoff).toHaveBeenCalledWith("child", "mycmux://detached-dock-request", {
        toLabel: label, workspaceId: "transfer",
      });
      expect(takeDetachedPlacements(["transfer"])).toEqual({ transfer: {
        kind: "pane", workspaceId: "destination", paneId: "pane", index: 1,
      } });
    } finally { stop(); }
  });
  it.each([[-1, 10], [1024, 10], [10, -1], [10, 768]])(
    "rejects a broadcast outside the receiver viewport at %s,%s before hit testing", (x, y) => {
      hit.mockReturnValue(document.querySelector("[data-tab-id]"));
      expect(detachedDockTarget({ screenX: x + 200, screenY: y + 100 }, { x: 300, y: 150, scale: 1.5 })).toBeNull();
      expect(hit).not.toHaveBeenCalled();
    });
  it("refuses a DOM target whose workspace is not owned by the receiver", async () => {
    useWorkspaceListStore.setState({ workspaces: [] });
    const stop = listenForDetachedDock();
    try {
      await send("start"); await send("end");
      expect(mocks.handoff).not.toHaveBeenCalled();
      expect(takeDetachedPlacements(["transfer"])).toEqual({});
    } finally { stop(); }
  });

  it.each([[220, 0], [250, 1], [349, 1], [350, 2], [440, 2]])(
    "converts screen x %s at 150 percent scale into slot %s", (screenX, index) => {
      expect(detachedDockTarget(payload("move", screenX), { x: 300, y: 150, scale: 1.5 }))
        .toEqual({ kind: "tab-index", workspaceId: "destination", paneId: "pane", index });
      expect(hit).toHaveBeenCalledWith(screenX - 200, 10);
    });
  it("does not publish an unchanged target", () => {
    const changes = vi.fn();
    const unsubscribe = useDetachedDockStore.subscribe(changes);
    const store = useDetachedDockStore.getState();
    const target = { kind: "tab-index" as const, workspaceId: "destination", paneId: "pane", index: 1 };
    store.setTarget(target);
    const before = useDetachedDockStore.getState();
    store.setTarget({ ...target });
    expect(useDetachedDockStore.getState()).toBe(before);
    expect(changes).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
  it("caches geometry once, resolves the release point, and records placement before handoff", async () => {
    const stop = listenForDetachedDock();
    try {
      await send("start"); await send("move"); await send("move");
      expect(mocks.outerPosition).toHaveBeenCalledTimes(1);
      expect(mocks.scaleFactor).toHaveBeenCalledTimes(1);
      mocks.handoff.mockImplementationOnce(async () => {
        expect(takeDetachedPlacements(["transfer"])).toEqual({ transfer: {
          kind: "pane", workspaceId: "destination", paneId: "pane", index: 2,
        } });
      });
      await send("end", 400);
      expect(mocks.handoff).toHaveBeenCalledTimes(1);
      expect(useDetachedDockStore.getState().active).toBeNull();
      expect(takeDetachedPlacements(["transfer"])).toEqual({});
    } finally { stop(); }
  });
  it.each(["cancel", "outside", "destroyed"])("clears %s without closing or leaving a placement", async (mode) => {
    const stop = listenForDetachedDock();
    try {
      await send("start");
      if (mode === "destroyed") {
        mocks.getAllWindows.mockResolvedValueOnce([]);
        mocks.listeners.get(WINDOW_REGISTRY_CHANGED_EVENT)!({ payload: 1 });
        await Promise.resolve(); await Promise.resolve();
      } else await send(mode === "cancel" ? "cancel" : "end", 999);
      expect(useDetachedDockStore.getState().active).toBeNull();
      expect(useDetachedDockStore.getState().target).toBeNull();
      expect(mocks.handoff).not.toHaveBeenCalled();
      expect(mocks.close).not.toHaveBeenCalled();
      expect(takeDetachedPlacements(["transfer"])).toEqual({});
    } finally { stop(); }
  });
  it("ignores stale geometry that resolves after cancellation", async () => {
    let resolve!: (value: { x: number; y: number }) => void;
    mocks.outerPosition.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const stop = listenForDetachedDock();
    try {
      await send("start"); await send("cancel");
      resolve({ x: 300, y: 150 });
      await Promise.resolve(); await Promise.resolve();
      expect(useDetachedDockStore.getState().active).toBeNull();
      expect(useDetachedDockStore.getState().target).toBeNull();
    } finally { stop(); }
  });
  it.each([
    [5, 150, "left"], [395, 150, "right"], [200, 35, "up"], [200, 295, "down"], [200, 150, "center"],
  ] as const)("resolves body point %s,%s to %s", (x, y, zone) => {
    const pane = document.querySelector<HTMLElement>("[data-dnd-pane-id]")!;
    pane.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300 }) as DOMRect;
    hit.mockReturnValue(pane);
    expect(detachedDockTarget({ screenX: x + 200, screenY: y + 100 }, { x: 300, y: 150, scale: 1.5 }))
      .toEqual({ kind: "pane-zone", workspaceId: "destination", paneId: "pane", zone });
  });
  it("coalesces a burst into one hit test per frame and uses the release point", async () => {
    const stop = listenForDetachedDock();
    try {
      const emit = (phase: DetachedDragPayload["phase"], x: number) => mocks.listeners.get(DETACHED_DRAG_EVENT)!({ payload: payload(phase, x) });
      emit("start", 220); emit("move", 250); emit("move", 350);
      expect(hit).not.toHaveBeenCalled(); expect(frames.size).toBe(1);
      await frame();
      expect(hit).toHaveBeenCalledTimes(1);
      expect(useDetachedDockStore.getState().target).toMatchObject({ kind: "tab-index", index: 2 });
      emit("move", 440); emit("end", 220);
      await frame();
      expect(hit).toHaveBeenCalledTimes(2);
      expect(takeDetachedPlacements(["transfer"])).toEqual({ transfer: { kind: "pane", workspaceId: "destination", paneId: "pane", index: 0 } });
      expect(mocks.handoff).toHaveBeenCalledTimes(1);
    } finally { stop(); }
  });
  it("cancels a queued frame without hit testing", async () => {
    const stop = listenForDetachedDock();
    try {
      mocks.listeners.get(DETACHED_DRAG_EVENT)!({ payload: payload("start") });
      mocks.listeners.get(DETACHED_DRAG_EVENT)!({ payload: payload("cancel") });
      await frame();
      expect(hit).not.toHaveBeenCalled(); expect(frames.size).toBe(0);
      expect(useDetachedDockStore.getState().target).toBeNull();
    } finally { stop(); }
  });
  it("records a pane-zone placement before handoff and clears its preview", async () => {
    const pane = document.querySelector<HTMLElement>("[data-dnd-pane-id]")!;
    pane.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300 }) as DOMRect;
    hit.mockReturnValue(pane);
    const stop = listenForDetachedDock();
    try {
      await send("start", 205);
      expect(useDetachedDockStore.getState().target).toMatchObject({ kind: "pane-zone", zone: "left" });
      mocks.handoff.mockImplementationOnce(async () => {
        expect(takeDetachedPlacements(["transfer"])).toEqual({ transfer: { kind: "pane-zone", workspaceId: "destination", paneId: "pane", zone: "left" } });
      });
      await send("end", 205);
      expect(mocks.handoff).toHaveBeenCalledOnce();
      expect(useDetachedDockStore.getState().target).toBeNull();
    } finally { stop(); }
  });
  it("distinguishes strip and body targets while suppressing identical zone updates", () => {
    const store = useDetachedDockStore.getState();
    store.setTarget({ kind: "tab-index", workspaceId: "destination", paneId: "pane", index: 0 });
    const changes = vi.fn(); const unsubscribe = useDetachedDockStore.subscribe(changes);
    store.setTarget({ kind: "pane-zone", workspaceId: "destination", paneId: "pane", zone: "center" });
    store.setTarget({ kind: "pane-zone", workspaceId: "destination", paneId: "pane", zone: "center" });
    store.setTarget({ kind: "pane-zone", workspaceId: "destination", paneId: "pane", zone: "right" });
    expect(changes).toHaveBeenCalledTimes(2); unsubscribe();
  });

  it("clears a failed geometry read before any animation frame without an unhandled rejection", async () => {
    mocks.outerPosition.mockRejectedValueOnce(new Error("geometry unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = listenForDetachedDock();
    try {
      mocks.listeners.get(DETACHED_DRAG_EVENT)!({ payload: payload("start") });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await frame();
      expect(warn).toHaveBeenCalledOnce();
      expect(hit).not.toHaveBeenCalled();
      expect(useDetachedDockStore.getState().active).toBeNull();
      expect(mocks.handoff).not.toHaveBeenCalled();
      expect(mocks.close).not.toHaveBeenCalled();
    } finally { stop(); }
  });
  it("removes the pending placement when the handoff request fails", async () => {
    mocks.handoff.mockRejectedValueOnce(new Error("close failed"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = listenForDetachedDock();
    try {
      await send("start"); await send("end");
      expect(takeDetachedPlacements(["transfer"])).toEqual({});
      expect(useDetachedDockStore.getState().active).toBeNull();
    } finally { stop(); }
  });

});
