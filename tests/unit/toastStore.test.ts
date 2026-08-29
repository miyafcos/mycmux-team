import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { __resetToastStoreForTests, useToastStore } from "../../src/stores/toastStore";

describe("toast notification defaults", () => {
  it("starts with the AI activity toasts off and the rest on", () => {
    // The auto-naming and auto-sweep runs report results that are already on
    // screen, so their toast is noise by default. The other two categories
    // stay on, and every one of them remains switchable.
    const fresh = useSettingsStore.getState();
    expect(fresh.toastAiActivityEnabled).toBe(false);
    expect(fresh.toastUserActionEnabled).toBe(true);
    expect(fresh.toastSystemEnabled).toBe(true);
  });
});

describe("toastStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    __resetToastStoreForTests();
    useSettingsStore.setState({
      notificationsEnabled: true,
      toastAiActivityEnabled: true,
      toastUserActionEnabled: true,
      toastSystemEnabled: true,
    });
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

  it.each([
    ["ai-activity", "toastAiActivityEnabled"],
    ["user-action", "toastUserActionEnabled"],
    ["system", "toastSystemEnabled"],
  ] as const)("suppresses %s toasts when its category is off", (category, setting) => {
    useSettingsStore.setState({ [setting]: false });

    const id = useToastStore.getState().pushToast(
      `${category} completed`,
      "info",
      undefined,
      undefined,
      undefined,
      category,
    );

    expect(id).toEqual(expect.any(String));
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["ai-activity", "user-action", "system"] as const)(
    "suppresses %s toasts when the notification master is off",
    (category) => {
      useSettingsStore.setState({ notificationsEnabled: false });

      useToastStore.getState().pushToast(
        `${category} completed`,
        "info",
        undefined,
        undefined,
        undefined,
        category,
      );

      expect(useToastStore.getState().toasts).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("always shows failure notifications even when every notification setting is off", () => {
    useSettingsStore.setState({
      notificationsEnabled: false,
      toastAiActivityEnabled: false,
      toastUserActionEnabled: false,
      toastSystemEnabled: false,
    });

    useToastStore.getState().pushToast(
      "AI judgement fell back",
      "info",
      undefined,
      undefined,
      undefined,
      "failure",
    );
    useToastStore.getState().pushToast(
      "Connection failed",
      "error",
      undefined,
      undefined,
      undefined,
      "system",
    );

    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ message: "AI judgement fell back", category: "failure" }),
      expect.objectContaining({ message: "Connection failed", category: "failure" }),
    ]);
  });

  it("keeps untagged warning calls fail-safe while allowing an explicit success warning to be suppressed", () => {
    useSettingsStore.setState({ toastUserActionEnabled: false });

    useToastStore.getState().pushToast("Copy failed", "warning");
    useToastStore.getState().pushToast(
      "Savepoint published",
      "warning",
      undefined,
      undefined,
      undefined,
      "user-action",
    );

    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ message: "Copy failed", category: "failure" }),
    ]);
  });
});
