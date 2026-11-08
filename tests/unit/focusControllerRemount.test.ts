// Rebuilds the state of a terminal tab that is dragged into another pane: the drop handler asks for focus
// (usePaneDragSource.ts:297/312/322), then the source pane's XTermWrapper unmounts
// (unregister) and the target pane's XTermWrapper attaches the cached terminal
// (register with a new FocusTarget). v0.90.7 focused the new terminal.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusController } from "../../src/lib/focusController";
import { useUiStore } from "../../src/stores/uiStore";

describe("drag focus retry across a terminal remount", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUiStore.setState({ activePaneId: "other", focusRevision: 0 });
    vi.stubGlobal("window", {
      closed: false,
      setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 1),
      cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    });
  });
  afterEach(() => {
    focusController.clearSession("moved");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("focuses the remounted terminal when the remount happens before the first retry tick", () => {
    const oldFocus = vi.fn();
    const newFocus = vi.fn();
    const unregisterOld = focusController.registerTerminal("moved", { focus: oldFocus, containsActiveElement: () => false });
    focusController.request("drag", { sessionId: "moved", focus: true });
    unregisterOld();
    focusController.registerTerminal("moved", { focus: newFocus, containsActiveElement: () => newFocus.mock.calls.length > 0 });
    vi.runAllTimers();
    expect(oldFocus).not.toHaveBeenCalled();
    expect(newFocus).toHaveBeenCalledTimes(1);
  });

  it("focuses a terminal that registers late (cold mount) after the old one unregistered", () => {
    const oldFocus = vi.fn();
    const newFocus = vi.fn();
    const unregisterOld = focusController.registerTerminal("moved", { focus: oldFocus, containsActiveElement: () => false });
    focusController.request("drag", { sessionId: "moved", focus: true });
    unregisterOld();
    vi.advanceTimersByTime(30);
    focusController.registerTerminal("moved", { focus: newFocus, containsActiveElement: () => newFocus.mock.calls.length > 0 });
    vi.runAllTimers();
    expect(oldFocus).not.toHaveBeenCalled();
    expect(newFocus).toHaveBeenCalledTimes(1);
  });
});
