// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: vi.fn(async () => {}) }));
import { useSessionStateClock } from "../../src/hooks/useSessionStateClock";
import { useDetachedDockStore } from "../../src/stores/detachedDockStore";
import { beginTearoutOperation, endTearoutOperation, reserveIncomingTearout, finishIncomingTearout,
  setTearoutDisplayActivity, clearObservedTearoutMoves, observeTearoutMove, finishObservedTearoutMove,
  subscribeTearoutDisplay, tearoutDisplayBusy } from "../../src/lib/tearout/operation";

let root: Root;
let host: HTMLElement;
let renders: number;
let mounted: boolean;
function Consumer() { const now = useSessionStateClock(); renders++; return <span>{now}</span>; }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  endTearoutOperation(); clearObservedTearoutMoves(); useDetachedDockStore.getState().clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); renders = 0;
  mounted = true;
  act(() => root.render(<Consumer />));
});
afterEach(() => {
  if (mounted) act(() => root.unmount());
  host.remove(); endTearoutOperation(); finishIncomingTearout("clock");
  clearObservedTearoutMoves(); setTearoutDisplayActivity("review", false);
  setTearoutDisplayActivity("clock", false); useDetachedDockStore.getState().clear(); vi.useRealTimers();
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});
it.each(["local", "highlight", "approval", "incoming"])("2a pauses %s clock renders and ticks once immediately on completion", kind => {
  act(() => {
    if (kind === "local") expect(beginTearoutOperation()).toBe(true);
    if (kind === "highlight") useDetachedDockStore.setState({ target: { kind: "workspace" } });
    if (kind === "approval") setTearoutDisplayActivity("clock", true);
    if (kind === "incoming") reserveIncomingTearout("clock");
  });
  const before = renders;
  act(() => { vi.advanceTimersByTime(3_000); document.dispatchEvent(new Event("visibilitychange")); });
  expect(renders).toBe(before);
  act(() => {
    endTearoutOperation(); useDetachedDockStore.getState().clear();
    setTearoutDisplayActivity("clock", false); finishIncomingTearout("clock");
  });
  expect(renders).toBe(before + 1); expect(host.textContent).toBe("13000");
  act(() => vi.advanceTimersByTime(1_000)); expect(renders).toBe(before + 2);
});
it("2a keeps the clock paused across overlapping reservations", () => {
  act(() => { beginTearoutOperation(); reserveIncomingTearout("clock"); });
  const before = renders;
  act(() => { vi.advanceTimersByTime(2_000); endTearoutOperation(); });
  expect(renders).toBe(before);
  act(() => finishIncomingTearout("clock")); expect(renders).toBe(before + 1);
});
it("review uses render time for a subscriber first mounted during a pause", () => {
  act(() => root.render(null));
  beginTearoutOperation(); vi.setSystemTime(22_500);
  act(() => root.render(<Consumer />));
  expect(host.textContent).toBe("22500");
});
it("review resumes ticks at ten seconds with one complete reason record per pause", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    act(() => {
      beginTearoutOperation(); reserveIncomingTearout("clock"); setTearoutDisplayActivity("review", true);
      observeTearoutMove({ id: "observed", label: "main", phase: "move" }, "main");
      useDetachedDockStore.setState({ target: { kind: "workspace" } });
    });
    const before = renders;
    act(() => vi.advanceTimersByTime(9_999)); expect(renders).toBe(before); expect(warning).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1)); expect(renders).toBe(before + 1);
    expect(warning).toHaveBeenCalledExactlyOnceWith("[tearout] session state clock pause exceeded 10s", expect.objectContaining({
      phase: "moving", observedMoves: 1, incomingTransfers: 1, displayActivity: ["review"], highlight: true }));
    act(() => vi.advanceTimersByTime(2_000)); expect(host.textContent).toBe("22000"); expect(warning).toHaveBeenCalledTimes(1);
    act(() => {
      endTearoutOperation(); finishObservedTearoutMove("observed"); finishIncomingTearout("clock");
      setTearoutDisplayActivity("review", false); useDetachedDockStore.getState().clear();
    });
    act(() => { beginTearoutOperation(); vi.advanceTimersByTime(10_000); });
    expect(warning).toHaveBeenCalledTimes(2);
  } finally { warning.mockRestore(); }
});
it.each([false, true])("review unmount removes timer, watchdog and both subscriptions while paused=%s", paused => {
  const removed = vi.spyOn(document, "removeEventListener");
  if (paused) act(() => beginTearoutOperation());
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  act(() => root.unmount()); mounted = false;
  expect(removed).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
  const before = renders;
  beginTearoutOperation(); endTearoutOperation();
  useDetachedDockStore.setState({ target: { kind: "workspace" } });
  vi.advanceTimersByTime(20_000); document.dispatchEvent(new Event("visibilitychange"));
  expect(vi.getTimerCount()).toBe(0); expect(renders).toBe(before);
  removed.mockRestore();
});
it("review isolates throwing display listeners from operation transitions and other subscribers", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const bad = subscribeTearoutDisplay(() => { throw new Error("broken display subscriber"); });
  const seen: boolean[] = [];
  const good = subscribeTearoutDisplay(() => { seen.push(tearoutDisplayBusy()); });
  try {
    act(() => { expect(beginTearoutOperation()).toBe(true); expect(() => endTearoutOperation()).not.toThrow(); });
    expect(seen).toEqual([true, false]); expect(tearoutDisplayBusy()).toBe(false);
    expect(warning).toHaveBeenCalledTimes(2);
  } finally { bad(); good(); warning.mockRestore(); }
});
