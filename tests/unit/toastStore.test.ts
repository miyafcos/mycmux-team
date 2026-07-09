import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetToastStoreForTests, useToastStore } from "../../src/stores/toastStore";

describe("toastStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    __resetToastStoreForTests();
  });

  afterEach(() => {
    __resetToastStoreForTests();
    vi.useRealTimers();
  });

  it("pushes and dismisses toasts", () => {
    const id = useToastStore.getState().pushToast("Something failed", "warning");

    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({
        id,
        message: "Something failed",
        kind: "warning",
        createdAt: 1_000_000,
      }),
    ]);

    useToastStore.getState().dismissToast(id);

    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("automatically dismisses toasts after eight seconds", () => {
    useToastStore.getState().pushToast("Transient failure", "error");

    vi.advanceTimersByTime(7999);
    expect(useToastStore.getState().toasts).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("keeps only the newest three toasts", () => {
    const first = useToastStore.getState().pushToast("first");
    const second = useToastStore.getState().pushToast("second");
    const third = useToastStore.getState().pushToast("third");
    const fourth = useToastStore.getState().pushToast("fourth");

    expect(useToastStore.getState().toasts.map((toast) => toast.id)).toEqual([
      second,
      third,
      fourth,
    ]);
    expect(useToastStore.getState().toasts.some((toast) => toast.id === first)).toBe(false);
  });
});
