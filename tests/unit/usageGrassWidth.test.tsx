// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useGrassWidth } from "../../src/components/ailog/useGrassWidth";

it("measures before paint without waiting for the first ResizeObserver delivery", async () => {
  let deliver: ResizeObserverCallback | undefined;
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { deliver = callback; }
    observe() {}
    disconnect = disconnect;
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const getWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const measured: number[] = [];
  const readsBeforeLayout: number[] = [];
  function Harness() {
    const { ref, width } = useGrassWidth();
    useLayoutEffect(() => { measured.push(width); readsBeforeLayout.push(getWidth.mock.calls.length); }, [width]);
    return <div ref={ref} data-width={width} />;
  }
  try {
    await act(async () => root.render(<Harness />));
    expect(host.firstElementChild?.getAttribute("data-width")).toBe("1200");
    expect(measured).toEqual([0, 1200]);
    expect(readsBeforeLayout[0]).toBeGreaterThan(0);
    getWidth.mockReturnValue(720);
    await act(async () => deliver!([], {} as ResizeObserver));
    expect(host.firstElementChild?.getAttribute("data-width")).toBe("720");
    await act(async () => root.unmount());
    expect(disconnect).toHaveBeenCalledTimes(1);
  } finally {
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
