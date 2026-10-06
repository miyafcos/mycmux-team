// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args: unknown) => true),
  listener: undefined as undefined | ((event: { payload: { owner: string; hovered: boolean; pressed: boolean } }) => void),
  stop: vi.fn(),
  listen: vi.fn(),
  toggle: vi.fn(async () => {}),
  minimize: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  maximized: false,
  resize: undefined as undefined | (() => void),
  resizeHandlers: [] as Array<() => void>,
  moveHandlers: [] as Array<() => void>,
  bounds: { left: 948, top: 9, width: 24, height: 18 },
  viewport: { width: 1000, height: 700 },
  observed: [] as Element[],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({
  listen: mocks.listen, minimize: mocks.minimize, close: mocks.close, toggleMaximize: mocks.toggle,
  isMaximized: async () => mocks.maximized,
  onResized: async (callback: () => void) => { mocks.resize = callback; mocks.resizeHandlers.push(callback); return () => {}; },
  onMoved: async (callback: () => void) => { mocks.moveHandlers.push(callback); return () => {}; },
}) }));
import { WindowControls } from "../../src/components/layout/WindowControls";

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.invoke.mockResolvedValue(true);
  mocks.listen.mockImplementation(async (_name, callback) => { mocks.listener = callback; return mocks.stop; });
  mocks.bounds = { left: 948, top: 9, width: 24, height: 18 };
  mocks.maximized = false;
  mocks.viewport = { width: 1000, height: 700 };
  mocks.observed = [];
  mocks.resizeHandlers = [];
  mocks.moveHandlers = [];
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("innerWidth", 1000);
  vi.stubGlobal("innerHeight", 700);
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.stubGlobal("ResizeObserver", class { observe(el: Element) { mocks.observed.push(el); } disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const b = this === document.documentElement
      ? { left: 0, top: 0, ...mocks.viewport } : mocks.bounds;
    return { ...b, x: b.left, y: b.top, right: b.left + b.width, bottom: b.top + b.height, toJSON: () => ({}) } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(24);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(18);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(strict = false) {
  await act(async () => root.render(strict ? <StrictMode><WindowControls /></StrictMode> : <WindowControls />));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}
function updates() { return mocks.invoke.mock.calls.filter(([name]) => name === "snap_layouts_update").map(([, args]) => args as { owner: string; rect: Record<string, number> | null }); }
function button() { return container.querySelector<HTMLButtonElement>("[data-snap-maximize]")!; }
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); }

describe("Windows native maximize button", () => {
  it("registers after listening and reports the right CSS box", async () => {
    await mount();
    expect(mocks.listen).toHaveBeenCalledWith("snap-layouts-state", expect.any(Function));
    expect(updates().at(-1)?.rect).toEqual({ x: 948, y: 9, width: 24, height: 18, viewportWidth: 1000, viewportHeight: 700 });
    expect(mocks.observed).toContain(button());
    expect(updates()[0].owner.length).toBeGreaterThan(10);
  });
  it("retains the fractional viewport when a physical width is odd at 150 percent", async () => {
    vi.stubGlobal("innerWidth", 799);
    mocks.viewport = { width: 799.328125, height: 549.328125 };
    mocks.bounds = { left: 747.328125, top: 9, width: 24, height: 18 };
    await mount();
    const rect = updates().at(-1)!.rect!;
    expect(rect.viewportWidth).toBe(799.328125);
    expect(rect.viewportWidth - rect.x - rect.width).toBe(28);
  });
  it.each(["resize", "move"])("remeasures a physical %s even when WebView CSS is unchanged", async signal => {
    await mount();
    const before = updates().length;
    const rect = updates().at(-1)!.rect;
    await act(async () => {
      for (const handler of signal === "resize" ? mocks.resizeHandlers : mocks.moveHandlers) handler();
    });
    await flush();
    expect(updates()).toHaveLength(before + 1);
    expect(updates().at(-1)!.rect).toEqual(rect);
  });
  it("updates a moved layout and compensates the pressed transform", async () => {
    await mount();
    mocks.bounds = { left: 918.36, top: 9.27, width: 23.28, height: 17.46 };
    await act(async () => window.dispatchEvent(new Event("resize")));
    await flush();
    expect(updates().at(-1)?.rect?.x).toBeCloseTo(918);
    expect(updates().at(-1)?.rect?.y).toBeCloseTo(9);
    expect(updates().at(-1)?.rect?.width).toBe(24);
  });
  it("reflects only its own native hover and press, with the existing visual tokens", async () => {
    await mount();
    const owner = updates()[0].owner;
    await act(async () => mocks.listener!({ payload: { owner: "other", hovered: true, pressed: true } }));
    expect(button().hasAttribute("data-native-hover")).toBe(false);
    await act(async () => mocks.listener!({ payload: { owner, hovered: true, pressed: true } }));
    expect(button().dataset.nativeHover).toBe("true");
    expect(button().style.background).toBe("var(--cmux-hover)");
    expect(button().style.transform).toBe("scale(0.97)");
    await act(async () => mocks.listener!({ payload: { owner, hovered: false, pressed: false } }));
    expect(button().hasAttribute("data-native-pressed")).toBe(false);
    expect(button().style.transform).toBe("");
  });
  it.each([false, "reject"])("keeps DOM controls when native installation returns %s", async failure => {
    if (failure === "reject") mocks.invoke.mockRejectedValue(new Error("native failed"));
    else mocks.invoke.mockResolvedValue(false);
    await mount();
    await act(async () => { button().click(); container.querySelector<HTMLButtonElement>("button")!.click(); });
    expect(mocks.toggle).toHaveBeenCalledOnce(); expect(mocks.minimize).toHaveBeenCalledOnce();
    const before = updates().length;
    await act(async () => window.dispatchEvent(new Event("resize")));
    await flush(); expect(updates()).toHaveLength(before);
  });
  it.each(["MacIntel", "Linux x86_64"])("does no native installation on %s", async platform => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    await mount();
    expect(updates()).toEqual([]); expect(mocks.listen).not.toHaveBeenCalled();
    await act(async () => button().click()); expect(mocks.toggle).toHaveBeenCalledOnce();
  });
  it("serializes StrictMode cleanup before the new owner and detaches that owner", async () => {
    await mount(true);
    const calls = updates();
    expect(calls[0].rect).toBeNull();
    expect(calls.at(-1)?.rect).not.toBeNull();
    const owner = calls.at(-1)!.owner;
    expect(owner).not.toBe(calls[0].owner);
    await act(async () => root.render(null));
    await flush();
    expect(updates().at(-1)).toEqual({ owner, rect: null });
    expect(mocks.stop).toHaveBeenCalledTimes(2);
  });
  it("unsubscribes a late listener without enabling a dead component", async () => {
    let resolve!: (stop: () => void) => void;
    mocks.listen.mockImplementation(() => new Promise<() => void>(done => { resolve = done; }));
    await act(async () => root.render(<WindowControls />));
    await act(async () => root.render(null));
    await act(async () => resolve(mocks.stop));
    await flush();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(updates().every(call => call.rect === null)).toBe(true);
  });
});
