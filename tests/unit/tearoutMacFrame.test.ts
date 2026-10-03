// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { afterTearoutFrame } from "../../src/lib/tearout/macFrame";

let paint: FrameRequestCallback;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { paint = callback; return 7; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("WKWebView tear-out frame waits", () => {
  it("continues once when an occluded Mac page never receives a frame", async () => {
    const done = vi.fn();
    afterTearoutFrame(done, "MacIntel");
    await vi.advanceTimersByTimeAsync(39);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledTimes(1);
    paint(42);
    expect(done).toHaveBeenCalledTimes(1);
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(7);
  });
  it("cancels the fallback when a visible Mac page paints first", async () => {
    const done = vi.fn();
    afterTearoutFrame(done, "MacIntel");
    paint(8);
    await vi.advanceTimersByTimeAsync(80);
    expect(done).toHaveBeenCalledTimes(1);
  });
  it("disposal prevents both a late frame and a hidden-page timeout", async () => {
    const done = vi.fn();
    const stop = afterTearoutFrame(done, "MacIntel");
    stop();
    paint(12);
    await vi.advanceTimersByTimeAsync(80);
    expect(done).not.toHaveBeenCalled();
  });
  it("keeps Windows waiting for the original painted-frame acknowledgement", async () => {
    const done = vi.fn();
    afterTearoutFrame(done, "Win32");
    await vi.advanceTimersByTimeAsync(500);
    expect(done).not.toHaveBeenCalled();
    paint(500);
    expect(done).toHaveBeenCalledTimes(1);
  });
});
