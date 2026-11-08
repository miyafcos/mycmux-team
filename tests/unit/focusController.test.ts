import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyStructuralActivation,
  createFocusControllerCore,
  focusController,
  type FocusControllerCoreOptions,
} from "../../src/lib/focusController";
import { useUiStore } from "../../src/stores/uiStore";

function controllerHarness(extra: Partial<FocusControllerCoreOptions> = {}) {
  let activeSessionId = "active";
  const commits: Array<string | null> = [];
  const focusRequests: Array<string | null> = [];
  const core = createFocusControllerCore({
    commit: (sessionId) => {
      activeSessionId = sessionId ?? "";
      commits.push(sessionId);
    },
    focusSession: (sessionId) => {
      focusRequests.push(sessionId ?? null);
    },
    getActiveSessionId: () => activeSessionId || null,
    ...extra,
  });
  return { core, commits, focusRequests };
}

describe("focusController state machine", () => {
  beforeEach(() => {
    useUiStore.setState({ activePaneId: null, lastActivePaneId: null, focusRevision: 0 });
  });

  afterEach(() => {
    focusController.clearSession("pending");
    focusController.clearSession("retry");
    vi.unstubAllGlobals();
  });

  it("commits a pending pointer intent on click resolution", () => {
    const { core, commits, focusRequests } = controllerHarness();

    core.request("pointer", { sessionId: "pending", action: "pending", focus: false });
    core.request("pointer", { sessionId: "pending", action: "commit" });

    expect(commits).toEqual(["pending"]);
    expect(focusRequests).toEqual(["pending"]);
    expect(core.state.pendingPointer).toBeNull();
  });

  it("accepts and commits the first input that reaches a pending pointer target", () => {
    const { core, commits, focusRequests } = controllerHarness();

    core.request("pointer", { sessionId: "pending", action: "pending", focus: false });

    expect(core.shouldAcceptInput("pending")).toBe(true);
    expect(commits).toEqual(["pending"]);
    expect(focusRequests).toEqual(["pending"]);
    expect(core.state.pendingPointer).toBeNull();
  });

  it("still rejects input from a genuinely inactive target", () => {
    const { core, commits, focusRequests } = controllerHarness();

    expect(core.shouldAcceptInput("inactive")).toBe(false);
    expect(commits).toEqual([]);
    expect(focusRequests).toEqual(["active"]);
  });

  it("aborts a pending pointer intent and restores the active focus target", () => {
    const { core, commits, focusRequests } = controllerHarness();

    core.request("pointer", { sessionId: "pending", action: "pending", focus: false });
    core.request("pointer", { sessionId: "pending", action: "abort" });

    expect(commits).toEqual([]);
    expect(focusRequests).toEqual(["active"]);
    expect(core.state.pendingPointer).toBeNull();
  });

  it("treats focusin as an observation and reconciles back to the active pane", () => {
    const { core, commits, focusRequests } = controllerHarness();

    const result = core.observeFocusIn("pending");

    expect(result).toBe("reconcile");
    expect(commits).toEqual([]);
    expect(focusRequests).toEqual(["active"]);
  });

  it("expires the wheel suppress window by deadline", () => {
    let clock = 1000;
    const { core } = controllerHarness({
      now: () => clock,
      wheelFocusSuppressMs: 350,
    });

    core.request("wheel", {
      sessionId: "pending",
      previousSessionId: "active",
      action: "observe",
    });

    expect(core.shouldSuppressWheelInput("pending")).toBe(true);
    expect(core.shouldSuppressWheelInput("active")).toBe(true);

    clock += 351;

    expect(core.shouldSuppressWheelInput("pending")).toBe(false);
    expect(core.state.pendingWheel).toBeNull();
  });

  it("stops terminal focus retries after the retry limit", () => {
    const callbacks: Array<() => void> = [];
    vi.stubGlobal("window", {
      setTimeout: (callback: () => void) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      clearTimeout: vi.fn(),
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callbacks.push(() => callback(0));
        return callbacks.length;
      },
      cancelAnimationFrame: vi.fn(),
    });

    const focus = vi.fn();
    const unregister = focusController.registerTerminal("retry", {
      focus,
      containsActiveElement: () => false,
    });

    focusController.focusSessionSoon("retry", { allowInactive: true });
    while (callbacks.length > 0) {
      callbacks.shift()?.();
    }

    unregister();
    expect(focus).toHaveBeenCalledTimes(8);
  });

  it("lets structural activation bypass pending intent arbitration", () => {
    focusController.request("pointer", { sessionId: "pending", action: "pending", focus: false });

    applyStructuralActivation("structural");

    expect(useUiStore.getState().activePaneId).toBe("structural");
    expect(useUiStore.getState().focusRevision).toBe(1);
  });

  it("does not increment revision for an idempotent activation", () => {
    applyStructuralActivation("structural");
    const revision = useUiStore.getState().focusRevision;

    applyStructuralActivation("structural");

    expect(useUiStore.getState().focusRevision).toBe(revision);
  });

  it("does not increment revision for pending, abort, wheel, or focus observations", () => {
    useUiStore.setState({ activePaneId: "active", lastActivePaneId: "active", focusRevision: 0 });

    focusController.request("pointer", {
      sessionId: "pending",
      action: "pending",
      focus: false,
    });
    focusController.request("pointer", { sessionId: "pending", action: "abort" });
    focusController.request("wheel", {
      sessionId: "pending",
      previousSessionId: "active",
      action: "observe",
    });
    focusController.observeTerminalFocusIn("pending");

    expect(useUiStore.getState().focusRevision).toBe(0);
  });
});

describe("focus retry lifetime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUiStore.setState({ activePaneId: "lifetime", focusRevision: 0 });
    vi.stubGlobal("window", {
      closed: false,
      setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 1),
      cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    });
  });
  afterEach(() => {
    focusController.clearSession("lifetime");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([0, 1, 17])("keeps queued retries across unregister and remount at %d ms", (elapsed) => {
    const focus = vi.fn(), onFocused = vi.fn(), onFocusAborted = vi.fn();
    const unregister = focusController.registerTerminal("lifetime", { focus, containsActiveElement: () => false });
    focusController.focusSessionSoon("lifetime", { onFocused, onFocusAborted });
    vi.advanceTimersByTime(elapsed);
    const attempts = focus.mock.calls.length;
    unregister();
    const replacement = vi.fn();
    focusController.registerTerminal("lifetime", { focus: replacement, containsActiveElement: () => replacement.mock.calls.length > 0 });
    expect(() => vi.runAllTimers()).not.toThrow();
    expect(focus).toHaveBeenCalledTimes(attempts);
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(onFocused).toHaveBeenCalledTimes(1);
    expect(onFocusAborted).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 1, 17])("lets retries run out harmlessly after a bare unregister at %d ms", (elapsed) => {
    const focus = vi.fn(), onFocused = vi.fn(), onFocusAborted = vi.fn();
    const unregister = focusController.registerTerminal("lifetime", { focus, containsActiveElement: () => false });
    focusController.focusSessionSoon("lifetime", { onFocused, onFocusAborted });
    vi.advanceTimersByTime(elapsed);
    const attempts = focus.mock.calls.length;
    unregister();
    expect(() => vi.runAllTimers()).not.toThrow();
    expect(focus).toHaveBeenCalledTimes(attempts);
    expect(onFocused).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a retry whose callback throws, so a later teardown does not abort it again", () => {
    const events = new EventTarget(), focus = vi.fn(), onFocusAborted = vi.fn();
    Object.assign(window, {
      addEventListener: (name: string, listener: EventListener) => events.addEventListener(name, listener),
      removeEventListener: (name: string, listener: EventListener) => events.removeEventListener(name, listener),
    });
    focusController.registerTerminal("lifetime", { focus, containsActiveElement: () => false });
    focusController.focusSessionSoon("lifetime", { onFocusAborted });
    const getState = vi.spyOn(useUiStore, "getState").mockImplementation(() => { throw new Error("boom"); });
    try { expect(() => vi.advanceTimersByTime(1)).toThrow("boom"); } finally { getState.mockRestore(); }
    expect(vi.getTimerCount()).toBe(0);
    focusController.clearSession("lifetime");
    events.dispatchEvent(new Event("pagehide"));
    vi.runAllTimers();
    expect(onFocusAborted).not.toHaveBeenCalled();
  });

  it("cancels retries when the session is cleared", () => {
    const focus = vi.fn(), onFocusAborted = vi.fn();
    focusController.registerTerminal("lifetime", { focus, containsActiveElement: () => false });
    focusController.focusSessionSoon("lifetime", { onFocusAborted });
    vi.advanceTimersByTime(1);
    focusController.clearSession("lifetime");
    expect(vi.getTimerCount()).toBe(0);
    vi.runAllTimers();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(onFocusAborted).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "closed"])("abandons a retry after the window is %s", (state) => {
    const focus = vi.fn(), onFocusAborted = vi.fn();
    focusController.registerTerminal("lifetime", { focus, containsActiveElement: () => false });
    focusController.focusSessionSoon("lifetime", { onFocusAborted });
    vi.advanceTimersByTime(1);
    if (state === "missing") vi.stubGlobal("window", undefined);
    else Object.assign(window, { closed: true });
    expect(() => vi.runAllTimers()).not.toThrow();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(onFocusAborted).toHaveBeenCalledTimes(1);
  });

  it.each(["pagehide", "beforeunload"])("cancels the owning window's retries on %s", (event) => {
    const events = new EventTarget(), focus = vi.fn(), onFocusAborted = vi.fn();
    Object.assign(window, {
      addEventListener: (name: string, listener: EventListener) => events.addEventListener(name, listener),
      removeEventListener: (name: string, listener: EventListener) => events.removeEventListener(name, listener),
    });
    focusController.registerTerminal("lifetime", { focus, containsActiveElement: () => false });
    focusController.focusSessionSoon("lifetime", { onFocusAborted });
    vi.advanceTimersByTime(1);
    events.dispatchEvent(new Event(event));
    expect(vi.getTimerCount()).toBe(0);
    vi.runAllTimers();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(onFocusAborted).toHaveBeenCalledTimes(1);
  });

  it("preserves the eight attempts, 0/16/50 ms delays and one abort on exhaustion", () => {
    const delays: number[] = [], focus = vi.fn(), onFocused = vi.fn(), onFocusAborted = vi.fn();
    Object.assign(window, {
      setTimeout: (callback: () => void, delay: number) => { delays.push(delay); return setTimeout(callback, delay); },
      requestAnimationFrame: undefined,
    });
    focusController.registerTerminal("lifetime", { focus, containsActiveElement: () => false });
    focusController.focusSessionSoon("lifetime", { onFocused, onFocusAborted });
    vi.runAllTimers();
    expect(delays).toEqual([0, 16, 16, 50, 50, 50, 50, 50]);
    expect(focus).toHaveBeenCalledTimes(8);
    expect(onFocused).not.toHaveBeenCalled();
    expect(onFocusAborted).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports successful ownership once and leaves no retries to abort on unregister", () => {
    const focus = vi.fn(), onFocused = vi.fn(), onFocusAborted = vi.fn();
    const unregister = focusController.registerTerminal("lifetime", {
      focus, containsActiveElement: () => focus.mock.calls.length === 2,
    });
    focusController.focusSessionSoon("lifetime", { onFocused, onFocusAborted });
    vi.runAllTimers();
    expect(focus).toHaveBeenCalledTimes(2);
    expect(onFocused).toHaveBeenCalledTimes(1);
    expect(onFocused.mock.calls[0][0]()).toBe(true);
    unregister();
    expect(onFocused.mock.calls[0][0]()).toBe(false);
    expect(onFocusAborted).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
