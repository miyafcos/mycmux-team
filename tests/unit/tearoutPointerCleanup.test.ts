// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/lib/tearout/runtime", () => ({
  tearoutTab: vi.fn(), tearoutPane: vi.fn(), tearoutWorkspace: vi.fn(),
  canRegrabTearoutTab: () => false, canRegrabTearoutPane: () => false, regrabTearoutWindow: vi.fn(),
}));
vi.mock("../../src/lib/tearout/record", () => ({ TearoutRecord: class {
  outside() {} error() {} async finish() {}
} }));
vi.mock("../../src/lib/windowContext", () => ({ windowLabel: () => "main" }));
import { beginNativePaneDrag, beginNativeWorkspaceDrag } from "../../src/lib/tearout/pointerDrag";
import { usePaneDragStore } from "../../src/stores/paneDragStore";
beforeEach(() => { vi.useFakeTimers(); usePaneDragStore.getState().clearDrag(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren(); });
describe("drag exception cleanup", () => {
  it.each(["pane", "workspace"])("always clears %s capture, cursor and listeners when commit throws", async (kind) => {
    const listeners = new Map<string, EventListener>();
    const add = window.addEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation((name, listener, options) => {
      listeners.set(name, listener as EventListener); add(name, listener, options);
    });
    const remove = vi.spyOn(window, "removeEventListener");
    const surface = document.createElement("div");
    surface.className = "pane-tabbar"; surface.dataset.dndWorkspaceSidebar = "true";
    surface.getBoundingClientRect = () => new DOMRect(0, 0, 300, 300);
    const source = document.createElement("span"); surface.append(source); document.body.append(surface);
    source.getBoundingClientRect = () => new DOMRect(0, 0, 90, 36);
    let captured = false;
    Object.assign(source, { setPointerCapture: () => { captured = true; }, hasPointerCapture: () => captured,
      releasePointerCapture: () => { captured = false; } });
    const callbacks = { suppress: vi.fn(), resolve: vi.fn(), commit: vi.fn(() => { throw new Error("commit failed"); }) };
    const down = { pointerId: 1, clientX: 10, clientY: 10 } as PointerEvent;
    if (kind === "pane") beginNativePaneDrag(down, source, { kind: "tab", workspaceId: "source", paneId: "pane", tabId: "tab", label: "Terminal" }, callbacks);
    else beginNativeWorkspaceDrag(down, source, "source", callbacks);
    const next = { pointerId: 1, clientX: 30, clientY: 10, preventDefault: vi.fn() } as unknown as Event;
    listeners.get("pointermove")!(next);
    expect(captured).toBe(true);
    expect(document.body.style.cursor).toBe("grabbing");
    expect(() => listeners.get("pointerup")!(next)).toThrow("commit failed");
    expect(captured).toBe(false);
    expect(document.body.style.cursor).toBe("");
    expect(usePaneDragStore.getState().item).toBeNull();
    for (const name of ["pointermove", "pointerup", "pointercancel", "keydown", "blur"])
      expect(remove.mock.calls.some(([event]) => event === name)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.suppress).toHaveBeenLastCalledWith(false);
  });
});
