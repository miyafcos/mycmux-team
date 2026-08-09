import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachGlobalFontZoom,
  attachTerminalWheelScroll,
  resetFontZoomQueueForTests,
  shouldForwardWheelToApplication,
  wheelDeltaToZoomAmount,
} from "../../src/components/terminal/terminalMouseInputFilter";
import { useThemeStore } from "../../src/stores/themeStore";

type WheelHandler = (event: WheelEvent) => void;

function attachWheelHandler(): { handleWheel: WheelHandler; scrollLines: ReturnType<typeof vi.fn> } {
  let handleWheel: WheelHandler | null = null;
  const container = {
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      handleWheel = listener as WheelHandler;
    },
    removeEventListener: vi.fn(),
  } as unknown as HTMLElement;
  const scrollLines = vi.fn();
  const terminal = {
    rows: 24,
    buffer: { active: { type: "normal" } },
    scrollLines,
  } as unknown as Parameters<typeof attachTerminalWheelScroll>[1];

  attachTerminalWheelScroll(container, terminal, "font-zoom-test", false);
  if (!handleWheel) throw new Error("wheel handler was not attached");
  return { handleWheel, scrollLines };
}

function wheelEvent(overrides: Partial<WheelEvent> = {}): WheelEvent {
  return {
    deltaY: 100,
    deltaMode: 0,
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    ...overrides,
  } as unknown as WheelEvent;
}

beforeEach(() => {
  resetFontZoomQueueForTests();
  useThemeStore.setState({ fontSize: 14 });
});

afterEach(() => {
  resetFontZoomQueueForTests();
  vi.unstubAllGlobals();
});

describe("wheelDeltaToZoomAmount", () => {
  it("normalizes pixel, line, and page deltas", () => {
    expect(wheelDeltaToZoomAmount({ deltaY: 250, deltaMode: 0 })).toBe(2.5);
    expect(wheelDeltaToZoomAmount({ deltaY: 6, deltaMode: 1 })).toBe(2);
    expect(wheelDeltaToZoomAmount({ deltaY: -2, deltaMode: 2 })).toBe(-2);
  });
});

describe("terminal font zoom", () => {
  it("accumulates fractional Ctrl+wheel input and flushes one whole step per frame", () => {
    let flush: FrameRequestCallback | null = null;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      flush = callback;
      return 1;
    });
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { handleWheel, scrollLines } = attachWheelHandler();

    const first = wheelEvent({ ctrlKey: true, deltaY: 50 });
    const second = wheelEvent({ ctrlKey: true, deltaY: 50 });
    handleWheel(first);
    handleWheel(second);

    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(useThemeStore.getState().fontSize).toBe(14);
    expect(flush).not.toBeNull();
    (flush as FrameRequestCallback)(0);
    expect(useThemeStore.getState().fontSize).toBe(13);
    expect(scrollLines).not.toHaveBeenCalled();
    expect(first.preventDefault).toHaveBeenCalled();
    expect(first.stopImmediatePropagation).toHaveBeenCalled();
  });

  it.each([
    ["Ctrl+Shift", { ctrlKey: true, shiftKey: true }],
    ["Ctrl+Alt", { ctrlKey: true, altKey: true }],
  ])("does not treat %s+wheel as font zoom", (_label, modifiers) => {
    const requestFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    const { handleWheel, scrollLines } = attachWheelHandler();

    handleWheel(wheelEvent(modifiers));

    expect(requestFrame).not.toHaveBeenCalled();
    expect(useThemeStore.getState().fontSize).toBe(14);
    expect(scrollLines).toHaveBeenCalledTimes(1);
  });
});

describe("attachGlobalFontZoom", () => {
  function stubWindow(): { target: Window; getHandler: () => WheelHandler; removeEventListener: ReturnType<typeof vi.fn> } {
    let handler: WheelHandler | null = null;
    const removeEventListener = vi.fn();
    const target = {
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        handler = listener as WheelHandler;
      },
      removeEventListener,
    } as unknown as Window;
    return {
      target,
      getHandler: () => {
        if (!handler) throw new Error("global wheel handler was not attached");
        return handler;
      },
      removeEventListener,
    };
  }

  it("zooms on Ctrl+wheel outside of a terminal pane and stops the event", () => {
    let flush: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      flush = callback;
      return 1;
    });
    const { target, getHandler } = stubWindow();
    attachGlobalFontZoom(target);

    const event = wheelEvent({ ctrlKey: true, deltaY: -100 });
    getHandler()(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    (flush as unknown as FrameRequestCallback)(0);
    expect(useThemeStore.getState().fontSize).toBe(15);
  });

  it("ignores modified and already-handled wheel events", () => {
    const requestFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    const { target, getHandler } = stubWindow();
    attachGlobalFontZoom(target);

    getHandler()(wheelEvent({ ctrlKey: true, shiftKey: true }));
    getHandler()(wheelEvent({ ctrlKey: true, altKey: true }));
    getHandler()(wheelEvent({ ctrlKey: true, metaKey: true }));
    getHandler()(wheelEvent({ ctrlKey: true, defaultPrevented: true }));
    getHandler()(wheelEvent({ ctrlKey: false }));

    expect(requestFrame).not.toHaveBeenCalled();
    expect(useThemeStore.getState().fontSize).toBe(14);
  });

  it("detaches the listener it registered", () => {
    const { target, removeEventListener } = stubWindow();
    const detach = attachGlobalFontZoom(target);
    detach();
    expect(removeEventListener).toHaveBeenCalledTimes(1);
  });
});

describe("terminal wheel routing", () => {
  it("keeps normal-buffer agent history scroll local", () => {
    expect(shouldForwardWheelToApplication("normal", false, true, false)).toBe(false);
  });

  it("keeps normal-buffer history local even if stale mouse mode was recorded", () => {
    expect(shouldForwardWheelToApplication("normal", true, false, false)).toBe(false);
  });

  it("uses the agent fallback only in the alternate buffer", () => {
    expect(shouldForwardWheelToApplication("alternate", false, true, false)).toBe(true);
  });

  it("forwards explicit mouse mode only from the alternate buffer", () => {
    expect(shouldForwardWheelToApplication("alternate", true, false, false)).toBe(true);
  });

  it("always leaves Shift+wheel available for local history", () => {
    expect(shouldForwardWheelToApplication("alternate", true, true, true)).toBe(false);
  });
});
