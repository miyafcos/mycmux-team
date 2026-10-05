import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { __resetToastStoreForTests, TOAST_UNDO_DISMISS_MS, useToastStore } from "../../src/stores/toastStore";

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

  it("coalesces nine identical notices into one toast and returns the visible id", () => {
    const push = useToastStore.getState().pushToast;
    const id = push("Recovery is busy", "warning");
    for (let repeat = 1; repeat < 9; repeat += 1) {
      vi.advanceTimersByTime(100);
      expect(push("Recovery is busy", "warning")).toBe(id);
    }
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ id, message: "Recovery is busy", createdAt: 1_000_000 }),
    ]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("extends a repeated toast from the latest call and cancels its old timer", () => {
    const id = useToastStore.getState().pushToast("Still busy", "warning");
    vi.advanceTimersByTime(7000);
    expect(useToastStore.getState().pushToast("Still busy", "warning")).toBe(id);
    vi.advanceTimersByTime(1000);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(6999);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the duration of the latest repeat when it extends the deadline", () => {
    const push = useToastStore.getState().pushToast;
    const id = push("Retry available", "error", undefined, undefined, 1000);
    vi.advanceTimersByTime(500);
    expect(push("Retry available", "error", undefined, undefined, 2500)).toBe(id);
    vi.advanceTimersByTime(2499);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("does not shorten an actionless notice when a repeat requests less time", () => {
    const push = useToastStore.getState().pushToast;
    const id = push("Still recovering", "warning", undefined, undefined, 60000);
    vi.advanceTimersByTime(1000);
    expect(push("Still recovering", "warning")).toBe(id);
    vi.advanceTimersByTime(58999);
    expect(useToastStore.getState().toasts.map((toast) => toast.id)).toEqual([id]);
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("retains two identical undo notices with independent callbacks and twenty-second deadlines", () => {
    const push = useToastStore.getState().pushToast;
    const firstUndo = vi.fn();
    const secondUndo = vi.fn();
    const first = push("Closed 1 pane", "info", { label: "Undo", run: firstUndo }, undefined, TOAST_UNDO_DISMISS_MS);
    vi.advanceTimersByTime(1000);
    const second = push("Closed 1 pane", "info", { label: "Undo", run: secondUndo }, undefined, TOAST_UNDO_DISMISS_MS);
    expect(second).not.toBe(first);
    const toasts = useToastStore.getState().toasts;
    expect(toasts.map((toast) => toast.id)).toEqual([first, second]);
    expect(toasts.map((toast) => toast.createdAt)).toEqual([1_000_000, 1_001_000]);
    expect(vi.getTimerCount()).toBe(2);
    toasts[0].action!.run();
    expect(firstUndo).toHaveBeenCalledOnce();
    expect(secondUndo).not.toHaveBeenCalled();
    toasts[1].action!.run();
    expect(firstUndo).toHaveBeenCalledOnce();
    expect(secondUndo).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(18999);
    expect(useToastStore.getState().toasts.map((toast) => toast.id)).toEqual([first, second]);
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts.map((toast) => toast.id)).toEqual([second]);
    vi.advanceTimersByTime(999);
    expect(useToastStore.getState().toasts.map((toast) => toast.id)).toEqual([second]);
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an earlier undo's long deadline independent of an identical default-duration action", () => {
    const push = useToastStore.getState().pushToast;
    const action = { label: "Undo", run: vi.fn() };
    const first = push("Closed", "info", action, undefined, TOAST_UNDO_DISMISS_MS);
    vi.advanceTimersByTime(1000);
    const second = push("Closed", "info", action);
    expect(second).not.toBe(first);
    vi.advanceTimersByTime(7999);
    expect(useToastStore.getState().toasts.map(toast => toast.id)).toEqual([first, second]);
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts.map(toast => toast.id)).toEqual([first]);
    vi.advanceTimersByTime(10999);
    expect(useToastStore.getState().toasts.map(toast => toast.id)).toEqual([first]);
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains both pairs of matching actions without replacing the earlier callbacks", () => {
    const push = useToastStore.getState().pushToast;
    const oldRetry = vi.fn();
    const oldVisit = vi.fn();
    const retry = vi.fn();
    const visit = vi.fn();
    const first = push("Recovery failed", "error", undefined, [
      { label: "Retry", run: oldRetry }, { label: "Visit", run: oldVisit },
    ]);
    const other = push("Other notice", "info");
    vi.advanceTimersByTime(1000);
    const second = push("Recovery failed", "error", undefined, [
      { label: "Retry", run: retry }, { label: "Visit", run: visit },
    ]);
    expect(second).not.toBe(first);
    const toasts = useToastStore.getState().toasts;
    expect(toasts.map((toast) => toast.id)).toEqual([first, other, second]);
    expect(toasts[0].createdAt).toBe(1_000_000);
    expect(toasts[2].createdAt).toBe(1_001_000);
    toasts[0].actions!.forEach((action) => action.run());
    expect(oldRetry).toHaveBeenCalledOnce();
    expect(oldVisit).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(visit).not.toHaveBeenCalled();
    toasts[2].actions!.forEach((action) => action.run());
    expect(retry).toHaveBeenCalledOnce();
    expect(visit).toHaveBeenCalledOnce();
    expect(oldRetry).toHaveBeenCalledOnce();
    expect(oldVisit).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(3);
  });

  it("keeps equivalent legacy actions and actions arrays separate", () => {
    const push = useToastStore.getState().pushToast;
    const oldRun = vi.fn();
    const run = vi.fn();
    const legacyRun = vi.fn();
    const first = push("Retry available", "warning", { label: "Retry", run: oldRun });
    const second = push("Retry available", "warning", undefined, [{ label: "Retry", run }]);
    const third = push("Retry available", "warning", { label: "Retry", run: legacyRun });
    expect(new Set([first, second, third]).size).toBe(3);
    const toasts = useToastStore.getState().toasts;
    expect(toasts.map((toast) => toast.id)).toEqual([first, second, third]);
    expect(toasts[1].action).toBeUndefined();
    expect(toasts[0].actions).toBeUndefined();
    expect(toasts[2].actions).toBeUndefined();
    toasts[0].action!.run();
    toasts[1].actions![0].run();
    toasts[2].action!.run();
    expect(oldRun).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(legacyRun).toHaveBeenCalledOnce();
  });

  it.each(["kind", "message"] as const)("keeps actionless notices with a different %s separate", (difference) => {
    const push = useToastStore.getState().pushToast;
    const first = push("Still busy", "warning");
    const second = push(difference === "message" ? "Another notice" : "Still busy", difference === "kind" ? "error" : "warning");
    expect(second).not.toBe(first);
    expect(useToastStore.getState().toasts.map((toast) => toast.id)).toEqual([first, second]);
    expect(vi.getTimerCount()).toBe(2);
  });

  it.each([false, true])("keeps plain and actionable notices separate with actionable first=%s", (actionFirst) => {
    const push = useToastStore.getState().pushToast;
    const action = { label: "Undo", run: vi.fn() };
    const first = push("Closed", "info", actionFirst ? action : undefined);
    const second = push("Closed", "info", actionFirst ? undefined : action);
    expect(second).not.toBe(first);
    expect(useToastStore.getState().toasts.map((toast) => toast.id)).toEqual([first, second]);
    expect(vi.getTimerCount()).toBe(2);
  });

  it.each(["kind", "message", "label", "count", "order"] as const)(
    "keeps notices with a different %s separate",
    (difference) => {
      const push = useToastStore.getState().pushToast;
      const actions = [{ label: "Retry", run: vi.fn() }, { label: "Visit", run: vi.fn() }];
      const id = push("Recovery failed", "error", undefined, actions);
      const nextActions = difference === "label" ? [{ ...actions[0], label: "Try again" }, actions[1]]
        : difference === "count" ? actions.slice(0, 1)
          : difference === "order" ? [...actions].reverse() : actions;
      expect(push(
        difference === "message" ? "Another failure" : "Recovery failed",
        difference === "kind" ? "warning" : "error",
        undefined,
        nextActions,
      )).not.toBe(id);
      expect(useToastStore.getState().toasts).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(2);
    },
  );

  it("keeps matching displayed actions separate and honors an explicit empty actions array", () => {
    const push = useToastStore.getState().pushToast;
    const actions = [{ label: "Retry", run: vi.fn() }, { label: "Visit", run: vi.fn() }];
    const hidden = { label: "Hidden", run: vi.fn() };
    const first = push("Recovery failed", "error", undefined, actions);
    const second = push("Recovery failed", "error", undefined, [...actions, hidden]);
    expect(second).not.toBe(first);
    expect(useToastStore.getState().toasts.map((toast) => toast.id)).toEqual([first, second]);
    for (const toast of useToastStore.getState().toasts) expect(toast.actions).toHaveLength(2);
    expect(hidden.run).not.toHaveBeenCalled();
    __resetToastStoreForTests();
    const plain = push("No displayed actions", "info");
    expect(push("No displayed actions", "info", actions[0], [])).toBe(plain);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("evicts the oldest plain notice before an older action-bearing failure", () => {
    const push = useToastStore.getState().pushToast;
    const action = { label: "Retry", run: vi.fn() };
    const failure = push("Recovery failed", "error", undefined, [action]);
    const oldestPlain = push("First plain", "info");
    const newestPlain = push("Second plain", "warning");
    const incoming = push("Third plain", "info");
    expect(useToastStore.getState().toasts.map((toast) => toast.id)).toEqual([failure, newestPlain, incoming]);
    expect(useToastStore.getState().toasts.some((toast) => toast.id === oldestPlain)).toBe(false);
    expect(vi.getTimerCount()).toBe(3);
  });

  it("protects an action-bearing failure from nine repeated busy notices", () => {
    const push = useToastStore.getState().pushToast;
    const failure = push("Recovery failed", "error", undefined, [{ label: "Retry", run: vi.fn() }]);
    const busy = push("Recovery is busy", "warning");
    for (let repeat = 1; repeat < 9; repeat += 1) expect(push("Recovery is busy", "warning")).toBe(busy);
    const next = push("Another notice", "info");
    const last = push("Last notice", "warning");
    expect(useToastStore.getState().toasts.map((toast) => toast.id)).toEqual([failure, next, last]);
    expect(vi.getTimerCount()).toBe(3);
  });

  it("evicts the oldest action toast when every toast has actions, including matching repeats", () => {
    const push = useToastStore.getState().pushToast;
    const action = { label: "Retry", run: vi.fn() };
    const first = push("First", "error", action);
    const second = push("Second", "error", undefined, [action]);
    const third = push("Third", "info", action);
    vi.advanceTimersByTime(1000);
    const repeatedFirst = push("First", "error", action);
    expect(repeatedFirst).not.toBe(first);
    expect(useToastStore.getState().toasts.map((toast) => toast.id)).toEqual([second, third, repeatedFirst]);
    const fourth = push("Fourth", "error", undefined, [action]);
    expect(useToastStore.getState().toasts.map((toast) => toast.id)).toEqual([third, repeatedFirst, fourth]);
    expect(vi.getTimerCount()).toBe(3);
    vi.advanceTimersByTime(7000);
    expect(useToastStore.getState().toasts.map((toast) => toast.id)).toEqual([repeatedFirst, fourth]);
    expect(vi.getTimerCount()).toBe(2);
  });

  it("drops an incoming plain toast rather than any of three existing action toasts", () => {
    const push = useToastStore.getState().pushToast;
    const action = { label: "Undo", run: vi.fn() };
    const ids = [push("First", "info", action), push("Second", "warning", action), push("Third", "error", action)];
    const skipped = push("Plain", "warning");
    expect(ids).not.toContain(skipped);
    expect(useToastStore.getState().toasts.map((toast) => toast.id)).toEqual(ids);
    expect(vi.getTimerCount()).toBe(3);
  });

  it("allows the same notice to return with a new id after dismissal without a stale timer", () => {
    const push = useToastStore.getState().pushToast;
    const first = push("Notice", "error");
    vi.advanceTimersByTime(1000);
    useToastStore.getState().dismissToast(first);
    const second = push("Notice", "error");
    expect(second).not.toBe(first);
    vi.advanceTimersByTime(7000);
    expect(useToastStore.getState().toasts.map((toast) => toast.id)).toEqual([second]);
    vi.advanceTimersByTime(1000);
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
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
