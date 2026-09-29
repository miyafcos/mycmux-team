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
