// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WinterNightBackground } from "../../src/components/theme/WinterNightBackground";
import { HANABI_SCENES } from "../../src/lib/hanabiScenes";
import * as sceneGeometry from "../../src/lib/hanabiScene";
import * as scenePainter from "../../src/lib/hanabiCanvas";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), release: vi.fn(), native: false, minimized: false, nativeHidden: false,
  nativeResize: undefined as (() => void) | undefined, nativeRelease: vi.fn() }));
vi.mock("../../src/stores/hanabiCelebrationObserver", () => ({ connectHanabiCelebrations: mocks.connect }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => mocks.native }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({
  isMinimized: async () => mocks.minimized, isVisible: async () => !mocks.nativeHidden,
  onResized: async (callback: () => void) => { mocks.nativeResize = callback; return mocks.nativeRelease; },
  onFocusChanged: async () => mocks.nativeRelease,
}) }));
let root: Root, host: HTMLDivElement;
let hidden = false, reduced = false, sequence = 0;
let motionListener: (() => void) | undefined;
let callbacks: Map<number, FrameRequestCallback>;
let ctx: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  hidden = false; reduced = false; sequence = 0; callbacks = new Map();
  mocks.native = false; mocks.minimized = false; mocks.nativeHidden = false; mocks.nativeResize = undefined; mocks.nativeRelease.mockClear();
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.stubGlobal("devicePixelRatio", 3);
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    callbacks.set(++sequence, callback); return sequence;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => callbacks.delete(id)));
  vi.stubGlobal("matchMedia", () => ({ get matches() { return reduced; },
    addEventListener: (_: string, callback: () => void) => { motionListener = callback; },
    removeEventListener: () => { motionListener = undefined; } }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  ctx = Object.fromEntries(["fillRect", "drawImage", "putImageData", "setTransform", "beginPath", "moveTo", "lineTo", "stroke", "arc", "fill", "closePath", "save", "restore", "rect", "clip"].map(key => [key, vi.fn()]));
  ctx.createImageData = vi.fn((w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }));
  ctx.createRadialGradient = vi.fn(() => ({ addColorStop: vi.fn() }));
  ctx.createLinearGradient = vi.fn(() => ({ addColorStop: vi.fn() }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ctx as unknown as CanvasRenderingContext2D);
  mocks.connect.mockReset(); mocks.release.mockReset(); mocks.connect.mockReturnValue(mocks.release);
  host = document.createElement("div"); document.body.append(host);
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue({ width: 320, height: 200 } as DOMRect);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function step(at: number) {
  const pending = [...callbacks.values()]; callbacks.clear();
  act(() => pending.forEach(callback => callback(at)));
}
describe("winter scene lifetime and render budget", () => {
  it.each(HANABI_SCENES)("keeps a single loop, static reduced mode and cleanup in $id", ({id}) => {
    act(()=>root.render(<WinterNightBackground sceneId={id} fireworksEnabled />));
    expect(callbacks.size).toBe(1);
    expect(host.querySelector("canvas")?.dataset.hanabiScene).toBe(id);
    act(()=>{reduced=true;motionListener?.();}); expect(callbacks.size).toBe(0);
    act(()=>{reduced=false;motionListener?.();}); expect(callbacks.size).toBe(1);
  });
  it("caps DPR at two, keeps exactly one RAF, and paints at 30fps normally", () => {
    act(() => root.render(<WinterNightBackground fireworksEnabled />));
    const canvas = host.querySelector("canvas")!;
    expect([canvas.width, canvas.height]).toEqual([640, 400]);
    expect(callbacks.size).toBe(1);
    ctx.drawImage.mockClear();
    step(0); step(16.67); step(33.34);
    expect(ctx.drawImage).toHaveBeenCalledTimes(2);
    expect(callbacks.size).toBe(1);
    act(() => root.unmount());
    expect(callbacks.size).toBe(0); expect(mocks.release).toHaveBeenCalled();
    root = createRoot(host);
  });
  it("runs at most 60fps while a manual firework is active", () => {
    act(() => root.render(<WinterNightBackground fireworksEnabled manualCelebration={{ kind: "merge", nonce: 1 }} />));
    ctx.drawImage.mockClear();
    step(0); step(8.3); step(16.7); step(33.4);
    expect(ctx.drawImage).toHaveBeenCalledTimes(3);
    expect(callbacks.size).toBe(1);
  });
  it("stops the RAF and observation demand while hidden, and resumes one loop", () => {
    act(() => root.render(<WinterNightBackground fireworksEnabled />));
    act(() => { hidden = true; document.dispatchEvent(new Event("visibilitychange")); });
    expect(callbacks.size).toBe(0); expect(mocks.release).toHaveBeenCalledTimes(1);
    act(() => { hidden = false; document.dispatchEvent(new Event("visibilitychange")); });
    expect(callbacks.size).toBe(1); expect(mocks.connect).toHaveBeenCalledTimes(2);
  });
  it("draws a still only under reduced motion and stops immediately on preference change", () => {
    act(() => root.render(<WinterNightBackground fireworksEnabled />));
    act(() => { reduced = true; motionListener?.(); });
    expect(callbacks.size).toBe(0); expect(mocks.release).toHaveBeenCalled();
    const count = ctx.drawImage.mock.calls.length;
    act(() => root.render(<WinterNightBackground fireworksEnabled manualCelebration={{ kind: "done", nonce: 2 }} />));
    expect(ctx.drawImage.mock.calls.length).toBe(count);
    act(() => { reduced = false; motionListener?.(); });
    expect(callbacks.size).toBe(1);
  });
  it("stops for a native minimized or hidden window and resumes after restoration", async () => {
    mocks.native = true; mocks.minimized = true;
    await act(async () => root.render(<WinterNightBackground fireworksEnabled />));
    await vi.waitFor(() => expect(mocks.nativeResize).toBeDefined());
    expect(callbacks.size).toBe(0);
    mocks.minimized = false;
    await act(async () => { mocks.nativeResize?.(); });
    expect(callbacks.size).toBe(1);
    mocks.nativeHidden = true;
    await act(async () => { mocks.nativeResize?.(); });
    expect(callbacks.size).toBe(0);
    mocks.nativeHidden = false;
    await act(async () => { mocks.nativeResize?.(); });
    expect(callbacks.size).toBe(1);
  });
  it("places the cabin above the visible composer, ignoring a hidden terminal composer", () => {
    vi.mocked(host.getBoundingClientRect).mockReturnValue({
      width: 1280, height: 800, left: 0, top: 0, right: 1280, bottom: 800,
    } as DOMRect);
    const geometry = vi.spyOn(sceneGeometry, "createWinterNightScene");
    const rect = (top: number): DOMRect => ({
      left: 348, right: 1108, top, bottom: 753, width: 760, height: 753 - top,
    } as DOMRect);
    act(() => root.render(<>
      <WinterNightBackground fireworksEnabled previewMode previewTimeMs={0} />
      <div className="cmux-composer-shell" style={{ visibility: "hidden" }}
        ref={element => { if (element) vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect(700)); }} />
      <div className="cmux-composer-shell"
        ref={element => { if (element) vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect(500)); }} />
    </>));
    expect(geometry.mock.calls.at(-1)?.[3]?.inputRect?.top).toBe(500);
    expect(geometry.mock.results.at(-1)?.value.house.y).toBeLessThan(500);
  });
  it("uses the newly measured conversation for both placement and ray attenuation", () => {
    vi.mocked(host.getBoundingClientRect).mockReturnValue({ width: 1280, height: 800, left: 0, top: 0, right: 1280, bottom: 800 } as DOMRect);
    let ink = { left: 600, top: 150, right: 1000, bottom: 400, width: 400, height: 250 };
    const paint = vi.spyOn(scenePainter, "paintNightFireworks").mockImplementation(() => {});
    const render = (nonce?: number) => <>
      <WinterNightBackground fireworksEnabled manualCelebration={nonce ? { kind: "merge", nonce } : undefined} />
      <div className="message" ref={element => { if (element) vi.spyOn(element, "getBoundingClientRect").mockImplementation(() => ink as DOMRect); }} />
    </>;
    act(() => root.render(render()));
    const sharedScene = paint.mock.calls.at(-1)![1];
    expect(sharedScene.layout.conversationRect?.left).toBe(600);
    ink = { left: 520, top: 240, right: 1050, bottom: 560, width: 530, height: 320 };
    act(() => root.render(render(1)));
    step(100);
    expect(paint.mock.calls.at(-1)?.[1].layout.conversationRect).toEqual({ left: 520, top: 240, right: 1050, bottom: 560 });
    expect(sharedScene.layout.conversationRect).toEqual({ left: 520, top: 240, right: 1050, bottom: 560 });
  });
  it("does not acquire terminal observations when celebrations are disabled or frozen", () => {
    act(() => root.render(<WinterNightBackground fireworksEnabled={false} />));
    expect(mocks.connect).not.toHaveBeenCalled();
    act(() => root.render(<WinterNightBackground fireworksEnabled previewTimeMs={1800} previewFireworks="done" />));
    expect(callbacks.size).toBe(0); expect(mocks.connect).not.toHaveBeenCalled();
  });
});
