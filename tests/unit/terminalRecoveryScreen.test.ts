// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { freezeTerminalScreen } from "../../src/components/terminal/terminalRecoveryFrame";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); document.body.replaceChildren(); });

function renderer(automatic = true) {
  const parent = document.createElement("div");
  const element = document.createElement("div"); element.className = "xterm";
  const canvas = document.createElement("canvas"); canvas.width = 100; canvas.height = 60;
  element.append(canvas); parent.append(element); document.body.append(parent);
  let callback: (() => void) | null = null;
  let painting = false;
  const copies: { source: unknown; painting: boolean }[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
    drawImage: (source: unknown) => copies.push({ source, painting }),
  }) as unknown as CanvasRenderingContext2D);
  const dispose = vi.fn(() => { callback = null; });
  const paint = () => { painting = true; callback?.(); painting = false; };
  const term = {
    element, rows: 3,
    onRender: vi.fn((listener: () => void) => { callback = listener; return { dispose }; }),
    refresh: vi.fn(() => { if (automatic) queueMicrotask(paint); }),
  } as unknown as Pick<Terminal, "element" | "rows" | "onRender" | "refresh">;
  return { term, parent, element, canvas, copies, dispose, paint };
}

describe("the previous screen during large-ring recovery", () => {
  it("captures a non-preserved WebGL buffer inside the render notification", async () => {
    const fixture = renderer();
    const release = await freezeTerminalScreen(fixture.term);
    expect(fixture.term.refresh).toHaveBeenCalledWith(0, 2);
    // At any later task/microtask the simulated drawing buffer is cleared.
    expect(fixture.copies).toEqual([{ source: fixture.canvas, painting: true }]);
    expect(fixture.dispose).toHaveBeenCalledOnce();
    const mask = fixture.parent.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(mask.style.opacity).toBe("1"); expect(mask.inert).toBe(true);
    expect(mask.querySelector("canvas")?.width).toBe(100);
    release(); expect(fixture.parent.children).toHaveLength(1);
  });

  it("bounds a renderer that never sends its next paint and disposes the listener", async () => {
    vi.useFakeTimers(); const fixture = renderer(false);
    const checked = expect(freezeTerminalScreen(fixture.term)).rejects.toThrow("terminal recovery screen");
    await vi.advanceTimersByTimeAsync(4_000); await checked;
    expect(fixture.dispose).toHaveBeenCalledOnce();
    expect(fixture.copies).toEqual([]); expect(fixture.parent.children).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retain a terminal that was detached while waiting for the paint", async () => {
    const fixture = renderer(false); const pending = freezeTerminalScreen(fixture.term);
    fixture.element.remove(); fixture.paint(); const release = await pending;
    release(); expect(fixture.parent.children).toHaveLength(0);
    expect(fixture.copies).toEqual([]); expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it("does not request paints or install listeners for an unopened terminal", async () => {
    const fixture = renderer(false); fixture.element.remove();
    const release = await freezeTerminalScreen(fixture.term); release();
    expect(fixture.term.onRender).not.toHaveBeenCalled(); expect(fixture.term.refresh).not.toHaveBeenCalled();
  });
});
