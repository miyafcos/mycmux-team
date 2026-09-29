// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Allotment, setSashSize } from "allotment";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("unsubscribes disposed sashes from global size changes and cancels hover work", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const observers: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal("ResizeObserver", class {
    disconnect = vi.fn();
    constructor(private callback: ResizeObserverCallback) { observers.push(this); }
    observe(target: Element) {
      this.callback([{ target, contentRect: { width: 800, height: 600 },
        borderBoxSize: [{ inlineSize: 800, blockSize: 600 }],
      } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
  });
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Allotment defaultSizes={[400, 400]}>
    <Allotment.Pane><span>first</span></Allotment.Pane>
    <Allotment.Pane><span>second</span></Allotment.Pane>
  </Allotment>));
  const sash = host.querySelector<HTMLElement>('[data-testid="sash"]');
  expect(sash).not.toBeNull();
  const left = sash!.style.left;
  setSashSize(12);
  expect(sash!.style.left).not.toBe(left); // The live subscription really runs.
  vi.useFakeTimers();
  sash!.dispatchEvent(new MouseEvent("mouseenter"));
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  await act(async () => root.unmount());
  const disposedPosition = sash!.style.left;
  setSashSize(20);
  expect(sash!.style.left).toBe(disposedPosition);
  expect(vi.getTimerCount()).toBe(0);
  for (const observer of observers) expect(observer.disconnect).toHaveBeenCalledTimes(1);
  setSashSize(8);
  host.remove();
});
