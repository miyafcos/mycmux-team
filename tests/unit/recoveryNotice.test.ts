import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoveryBusy, recoveryFailed, recoveryReason } from "../../src/lib/tearout/recoveryNotice";
import { __resetToastStoreForTests, useToastStore } from "../../src/stores/toastStore";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  __resetToastStoreForTests();
});

afterEach(() => {
  __resetToastStoreForTests();
  vi.useRealTimers();
});

const location = "Source workspace";
const reason = "restore_attachment_timeout";
const visibleIds = () => useToastStore.getState().toasts.map(toast => toast.id);

describe("caller-owned recovery failure notices", () => {
  it.each([reason, "tearout_publish_failed"])("replaces only the same pane's failure before pushing reason %s", (nextReason) => {
    const oldRetry = vi.fn();
    const oldVisit = vi.fn();
    const retry = vi.fn();
    const visit = vi.fn();
    recoveryFailed("Pane A", location, reason, oldRetry, oldVisit);
    const first = useToastStore.getState().toasts[0];
    vi.advanceTimersByTime(1000);
    const states: string[][] = [];
    const unsubscribe = useToastStore.subscribe(state => states.push(state.toasts.map(toast => toast.id)));
    try {
      recoveryFailed("Pane A", location, nextReason, retry, visit);
    } finally {
      unsubscribe();
    }
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    const second = toasts[0];
    expect(second.id).not.toBe(first.id);
    expect(states).toEqual([[], [second.id]]);
    expect(second.createdAt).toBe(1_001_000);
    expect(second.message).toContain(recoveryReason(nextReason));
    expect(second.actions!.map(action => action.label)).toEqual(first.actions!.map(action => action.label));
    second.actions![0].run();
    second.actions![1].run();
    expect(retry).toHaveBeenCalledOnce();
    expect(visit).toHaveBeenCalledOnce();
    expect(oldRetry).not.toHaveBeenCalled();
    expect(oldVisit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each(["name", "location"] as const)("retains two independently runnable failures for a different %s", (difference) => {
    const firstRetry = vi.fn();
    const firstVisit = vi.fn();
    const secondRetry = vi.fn();
    const secondVisit = vi.fn();
    recoveryFailed("Pane A", location, reason, firstRetry, firstVisit);
    recoveryFailed(difference === "name" ? "Pane B" : "Pane A", difference === "location" ? "Other workspace" : location,
      reason, secondRetry, secondVisit);
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(2);
    expect(toasts[1].id).not.toBe(toasts[0].id);
    toasts[0].actions!.forEach(action => action.run());
    expect(firstRetry).toHaveBeenCalledOnce();
    expect(firstVisit).toHaveBeenCalledOnce();
    expect(secondRetry).not.toHaveBeenCalled();
    expect(secondVisit).not.toHaveBeenCalled();
    toasts[1].actions!.forEach(action => action.run());
    expect(secondRetry).toHaveBeenCalledOnce();
    expect(secondVisit).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(2);
  });

  it("keeps name/location pairs distinct even when they contain delimiters", () => {
    recoveryFailed("Pane|Source", "Window", reason, vi.fn(), vi.fn());
    recoveryFailed("Pane", "Source|Window", reason, vi.fn(), vi.fn());
    expect(useToastStore.getState().toasts).toHaveLength(2);
  });

  it("restarts the full recovery lifetime and cancels the replaced toast's timer", () => {
    recoveryFailed("Pane A", location, reason, vi.fn(), vi.fn());
    const first = visibleIds()[0];
    vi.advanceTimersByTime(59000);
    recoveryFailed("Pane A", location, reason, vi.fn(), vi.fn());
    const second = visibleIds()[0];
    expect(second).not.toBe(first);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(visibleIds()).toEqual([second]);
    vi.advanceTimersByTime(58999);
    expect(visibleIds()).toEqual([second]);
    vi.advanceTimersByTime(1);
    expect(visibleIds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not replace another caller's identical actionable notice", () => {
    recoveryFailed("Pane A", location, reason, vi.fn(), vi.fn());
    const first = useToastStore.getState().toasts[0];
    const otherRetry = vi.fn();
    const otherVisit = vi.fn();
    const other = useToastStore.getState().pushToast(first.message, first.kind, undefined, [
      { label: first.actions![0].label, run: otherRetry },
      { label: first.actions![1].label, run: otherVisit },
    ]);
    expect(visibleIds()).toEqual([first.id, other]);
    const retry = vi.fn();
    recoveryFailed("Pane A", location, reason, retry, vi.fn());
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(2);
    expect(toasts[0].id).toBe(other);
    expect(toasts[1].id).not.toBe(first.id);
    toasts[0].actions!.forEach(action => action.run());
    expect(otherRetry).toHaveBeenCalledOnce();
    expect(otherVisit).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    toasts[1].actions![0].run();
    expect(retry).toHaveBeenCalledOnce();
  });

  it.each(["dismissed", "expired", "evicted", "reset"] as const)("can issue a fresh failure after its previous notice was %s", (removed) => {
    recoveryFailed("Pane A", location, reason, vi.fn(), vi.fn());
    const first = visibleIds()[0];
    if (removed === "dismissed") useToastStore.getState().dismissToast(first);
    else if (removed === "expired") vi.advanceTimersByTime(60000);
    else if (removed === "reset") __resetToastStoreForTests();
    else {
      for (const name of ["Pane B", "Pane C", "Pane D"]) recoveryFailed(name, location, reason, vi.fn(), vi.fn());
    }
    expect(visibleIds()).not.toContain(first);
    const previous = visibleIds();
    recoveryFailed("Pane A", location, reason, vi.fn(), vi.fn());
    const next = visibleIds();
    expect(next).not.toContain(first);
    expect(next.at(-1)).not.toBe(first);
    expect(next).toEqual([...previous, next.at(-1)].slice(-3));
    expect(vi.getTimerCount()).toBe(next.length);
  });

  it("coalesces nine busy warnings without replacing the actionable failure", () => {
    const retry = vi.fn();
    recoveryFailed("Pane A", location, reason, retry, vi.fn());
    const first = visibleIds()[0];
    for (let index = 0; index < 9; index += 1) recoveryBusy();
    expect(useToastStore.getState().toasts).toHaveLength(2);
    expect(visibleIds()[0]).toBe(first);
    useToastStore.getState().toasts[0].actions![0].run();
    expect(retry).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(2);
  });
});
