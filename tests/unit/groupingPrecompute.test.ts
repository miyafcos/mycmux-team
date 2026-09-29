import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const productionScanHarness = vi.hoisted(() => ({
  scan: null as null | (() => Promise<never>),
}));

vi.mock("../../src/components/layout/tabGrouping", async (importActual) => {
  const actual = await importActual<typeof import("../../src/components/layout/tabGrouping")>();
  return {
    ...actual,
    scanGroupingContext: () => productionScanHarness.scan?.() ?? actual.scanGroupingContext(),
  };
});

import {
  __resetGroupingPrecomputeForTests,
  createGroupingPrecomputeCoordinator,
  generateForegroundGroupingAnalysis,
  groupingActivePtyQuietDelay,
  GROUPING_PTY_QUIET_MS,
  GROUPING_SCAN_TIMEOUT_MS,
  GROUPING_STRUCTURE_DEBOUNCE_MS,
  markGroupingInterest,
  startGroupingPrecomputeIfInterested,
  type GroupingPrecomputeDependencies,
} from "../../src/lib/groupingPrecompute";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useJevSettingsStore } from "../../src/stores/jevSettingsStore";
import { formatJudgeError } from "../../src/components/layout/tabSweep";
import { mockGroupingAnalysis } from "./fixtures/tabGroupingMockScenario";

function createHarness() {
  const storage = new Map<string, string>();
  let layoutRevision = 0;
  let scanRevision = 0;
  let layoutListener: (() => void) | null = null;
  let ptyListener: (() => void) | null = null;
  let aiListener: (() => void) | null = null;
  let visibilityListener: (() => void) | null = null;
  const subscriptions = {
    layout: vi.fn((listener: () => void) => {
      layoutListener = listener;
      return () => { layoutListener = null; };
    }),
    pty: vi.fn((listener: () => void) => {
      ptyListener = listener;
      return () => { ptyListener = null; };
    }),
    ai: vi.fn((listener: () => void) => {
      aiListener = listener;
      return () => { aiListener = null; };
    }),
    visibility: vi.fn((listener: () => void) => {
      visibilityListener = listener;
      return () => { visibilityListener = null; };
    }),
  };
  const scan = vi.fn(async () => {
    const next = structuredClone(mockGroupingAnalysis.scan);
    next.tabs[0].label = `${next.tabs[0].label}-${scanRevision}`;
    return next;
  });
  const judge = vi.fn(async () => "ok");
  const analyze = vi.fn<GroupingPrecomputeDependencies["analyze"]>(async (nextScan, runJudge, requestId) => {
    await runJudge("prompt", requestId());
    return { ...structuredClone(mockGroupingAnalysis), scan: nextScan };
  });
  const analyzeCurrent = vi.fn<GroupingPrecomputeDependencies["analyzeCurrent"]>(async (runJudge, requestId, onProgress) => {
    onProgress?.("scanning");
    const nextScan = await scan();
    onProgress?.("judging");
    await runJudge("prompt", requestId());
    onProgress?.("validating");
    return { ...structuredClone(mockGroupingAnalysis), scan: nextScan };
  });
  const dependencies: GroupingPrecomputeDependencies = {
    now: Date.now,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (timer) => clearTimeout(timer),
    getAiIdentity: () => ({
      enabled: true,
      provider: "codex",
      model: "gpt-test",
      promptVersion: "tab-grouping-v2",
    }),
    getLayoutRevision: () => layoutRevision,
    getPtyQuietDelay: () => 0,
    getVisibility: () => "visible",
    subscribeLayout: subscriptions.layout,
    subscribePty: subscriptions.pty,
    subscribeAi: subscriptions.ai,
    subscribeVisibility: subscriptions.visibility,
    scan,
    analyze,
    analyzeCurrent,
    judge,
    abort: vi.fn(async () => true),
    readStorage: (key) => storage.get(key) ?? null,
    writeStorage: (key, value) => { storage.set(key, value); },
  };
  return {
    coordinator: createGroupingPrecomputeCoordinator(dependencies),
    subscriptions,
    scan,
    analyze,
    analyzeCurrent,
    judge,
    abort: dependencies.abort as ReturnType<typeof vi.fn>,
    dirtyLayout: () => {
      layoutRevision += 1;
      scanRevision += 1;
      layoutListener?.();
    },
    emitPty: () => { ptyListener?.(); },
    listeners: () => ({ layoutListener, ptyListener, aiListener, visibilityListener }),
  };
}

describe("grouping precompute coordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T08:00:00+09:00"));
  });

  afterEach(() => {
    productionScanHarness.scan = null;
    __resetGroupingPrecomputeForTests();
    vi.useRealTimers();
  });

  it("keeps a valid cached plan when a forced refresh returns invalid output", async () => {
    const harness = createHarness();
    await harness.coordinator.generateForeground(true);
    const before = harness.coordinator.peek();
    harness.analyzeCurrent.mockResolvedValueOnce({
      ...mockGroupingAnalysis,
      parsed: { status: "invalid", reason: "invalid", issues: [], raw: "bad", validPlans: [] },
      raw: "bad",
    });
    const failed = await harness.coordinator.generateForeground(true);
    expect(failed.kind).toBe("ready");
    if (failed.kind === "ready") expect(failed.analysis.parsed.status).toBe("invalid");
    expect(harness.coordinator.peek()).toEqual(before);
    harness.coordinator.stop();
  });

  it("does not cache an invalid result on a cold open", async () => {
    const harness = createHarness();
    harness.analyzeCurrent.mockResolvedValueOnce({
      ...mockGroupingAnalysis,
      parsed: { status: "invalid", reason: "invalid", issues: [], raw: "bad", validPlans: [] },
      raw: "bad",
    });
    await harness.coordinator.generateForeground(true);
    expect(harness.coordinator.peek().kind).toBe("miss");
    await harness.coordinator.generateForeground(false);
    expect(harness.analyzeCurrent).toHaveBeenCalledTimes(2);
    harness.coordinator.stop();
  });

  it("ignores output from background panes when the active pane is quiet", () => {
    expect(groupingActivePtyQuietDelay(Date.now(), "active", {
      active: { outputActive: false, backendLastOutputAt: Date.now() - GROUPING_PTY_QUIET_MS },
      background: { outputActive: true, backendLastOutputAt: Date.now() },
    })).toBe(0);
  });

  it("leaves a foreground run alone when a terminal prints or tabs move", async () => {
    // Terminals print constantly and tabs move while a panel is open. Both used
    // to abort whatever judge was running, including the one the user was
    // waiting on, which surfaced as "判定を中止しました" over an empty panel.
    const harness = createHarness();
    harness.coordinator.markInterest();

    let releaseJudge: (() => void) | undefined;
    harness.judge.mockImplementationOnce(() => new Promise<string>((resolve) => {
      releaseJudge = () => resolve("ok");
    }));

    const running = harness.coordinator.generateForeground(true);
    await Promise.resolve();

    harness.emitPty();
    harness.dirtyLayout();
    await vi.advanceTimersByTimeAsync(GROUPING_PTY_QUIET_MS);

    expect(harness.abort).not.toHaveBeenCalled();

    releaseJudge?.();
    const produced = await running;
    expect(produced.kind).not.toBe("obsolete");
  });

  it("starts background generation by the structural deadline during continuous pane output", async () => {
    const harness = createHarness();
    harness.coordinator.markInterest();
    harness.dirtyLayout();
    harness.emitPty();

    for (let elapsed = 10_000; elapsed <= 170_000; elapsed += 10_000) {
      await vi.advanceTimersByTimeAsync(10_000);
      harness.emitPty();
    }

    await vi.advanceTimersByTimeAsync(9_999);
    expect(harness.judge).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(harness.analyze).toHaveBeenCalledTimes(1);
    expect(harness.judge).toHaveBeenCalledTimes(1);
  });

  it("starts foreground work instead of joining a stuck background pending run", async () => {
    const harness = createHarness();
    let releaseBackground: (() => void) | undefined;
    harness.judge.mockImplementationOnce(() => new Promise<string>((resolve) => {
      releaseBackground = () => resolve("ok");
    }));

    harness.coordinator.markInterest();
    harness.coordinator.requestBackgroundRefresh();
    await vi.advanceTimersByTimeAsync(GROUPING_STRUCTURE_DEBOUNCE_MS);

    expect(harness.scan).toHaveBeenCalledTimes(1);
    expect(harness.analyze).toHaveBeenCalledTimes(1);
    expect(harness.judge).toHaveBeenCalledTimes(1);
    expect(harness.analyzeCurrent).not.toHaveBeenCalled();
    expect(harness.coordinator.peek()).toEqual({ kind: "pending" });
    expect(harness.coordinator.getMetrics().actualGenerations).toBe(1);

    const foreground = harness.coordinator.generateForeground();
    try {
      expect(harness.abort).toHaveBeenCalledTimes(1);
      expect(harness.analyzeCurrent).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      expect(harness.scan).toHaveBeenCalledTimes(2);
      expect(harness.judge).toHaveBeenCalledTimes(2);
      await expect(foreground).resolves.toMatchObject({ kind: "ready" });
    } finally {
      releaseBackground?.();
      harness.coordinator.stop();
    }
  });

  it("forwards the current and later progress stages when foreground callers join", async () => {
    const harness = createHarness();
    harness.coordinator.markInterest();
    let releaseJudge: (() => void) | undefined;
    harness.judge.mockImplementationOnce(() => new Promise<string>((resolve) => {
      releaseJudge = () => resolve("ok");
    }));
    const firstStages: string[] = [];
    const joinedStages: string[] = [];

    const first = harness.coordinator.generateForeground(false, (stage) => firstStages.push(stage));
    await Promise.resolve();
    await Promise.resolve();
    const joined = harness.coordinator.generateForeground(false, (stage) => joinedStages.push(stage));

    expect(firstStages).toEqual(["scanning", "judging"]);
    expect(joinedStages).toEqual(["judging"]);

    releaseJudge?.();
    await expect(Promise.all([first, joined])).resolves.toHaveLength(2);
    expect(firstStages).toEqual(["scanning", "judging", "validating"]);
    expect(joinedStages).toEqual(["judging", "validating"]);
  });

  it("rejects a production scan after 20 seconds so the panel can leave analyzing state", async () => {
    const stuckScan = vi.fn(() => new Promise<never>(() => {}));
    productionScanHarness.scan = stuckScan;
    __resetGroupingPrecomputeForTests();

    let outcome: { kind: "resolved" } | { kind: "rejected"; error: unknown } | undefined;
    void generateForegroundGroupingAnalysis(true).then(
      () => { outcome = { kind: "resolved" }; },
      (error: unknown) => { outcome = { kind: "rejected", error }; },
    );

    await vi.advanceTimersByTimeAsync(GROUPING_SCAN_TIMEOUT_MS - 1);
    expect(stuckScan).toHaveBeenCalledTimes(1);
    expect(outcome).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toMatchObject({
      kind: "rejected",
      error: {
        message: "grouping_scan_timeout",
        code: "timeout",
      },
    });
    const error = outcome?.kind === "rejected" ? outcome.error : null;
    expect(formatJudgeError(error, "codex").summary)
      .toBe("判定が時間切れになりました。もう一度実行してください。");
  });

  it("does not subscribe, scan, or generate before the first explicit use", async () => {
    const harness = createHarness();

    expect(harness.coordinator.startIfInterested()).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(harness.subscriptions.layout).not.toHaveBeenCalled();
    expect(harness.subscriptions.pty).not.toHaveBeenCalled();
    expect(harness.subscriptions.ai).not.toHaveBeenCalled();
    expect(harness.subscriptions.visibility).not.toHaveBeenCalled();
    expect(harness.scan).not.toHaveBeenCalled();
    expect(harness.analyze).not.toHaveBeenCalled();
    expect(harness.judge).not.toHaveBeenCalled();
    expect(harness.listeners()).toEqual({
      layoutListener: null,
      ptyListener: null,
      aiListener: null,
      visibilityListener: null,
    });
  });

  it("stops background generation at six physical judge calls per local day", async () => {
    const harness = createHarness();
    harness.coordinator.markInterest();

    for (let attempt = 0; attempt < 7; attempt += 1) {
      if (attempt > 0) harness.dirtyLayout();
      await vi.advanceTimersByTimeAsync(GROUPING_STRUCTURE_DEBOUNCE_MS);
    }

    expect(harness.judge).toHaveBeenCalledTimes(6);
    expect(harness.analyze).toHaveBeenCalledTimes(6);
    expect(harness.scan).toHaveBeenCalledTimes(6);
    expect(harness.coordinator.getMetrics()).toMatchObject({
      actualGenerations: 6,
      budgetSkips: 1,
    });
    harness.coordinator.stop();
  });

  it("opens with the default timers even where they reject a foreign `this` (WebView2)", () => {
    // Node's timers accept any receiver; a browser's throw "Illegal invocation". In v0.80.1 the
    // default dependencies held `clearTimer: clearTimeout` and called it as a method, so the
    // rearrangement button threw inside markGroupingInterest() and its panel never opened.
    const strict = <T extends (...args: never[]) => unknown>(name: string, fn: T) =>
      function (this: unknown, ...args: Parameters<T>) {
        if (this !== globalThis && this !== undefined) throw new TypeError(`Illegal invocation: ${name}`);
        return fn(...args);
      };
    const calls: string[] = [];
    let nextTimer = 0;
    vi.stubGlobal("setTimeout", strict("setTimeout", () => { calls.push("setTimeout"); return ++nextTimer; }));
    vi.stubGlobal("clearTimeout", strict("clearTimeout", () => { calls.push("clearTimeout"); }));
    // The interest lease lives in localStorage, which the node test environment lacks.
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    });
    try {
      __resetGroupingPrecomputeForTests();
      // The button's call: start() arms the lease timer, then markInterest re-arms it.
      expect(() => markGroupingInterest()).not.toThrow();
      expect(() => markGroupingInterest()).not.toThrow();
      // A layout change with a debounce pending clears it from inside the store's listener.
      const { layoutRevision } = useWorkspaceListStore.getState();
      expect(() => useWorkspaceListStore.setState({ layoutRevision: layoutRevision + 1 })).not.toThrow();
      expect(calls).toEqual(expect.arrayContaining(["setTimeout", "clearTimeout"]));
      expect(() => __resetGroupingPrecomputeForTests()).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("structure-stale peek", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T00:00:00+09:00"));
  });

  afterEach(() => {
    productionScanHarness.scan = null;
    __resetGroupingPrecomputeForTests();
    vi.useRealTimers();
  });

  it("keeps the ready plan as structure-stale when only the layout revision moves", async () => {
    const harness = createHarness();
    harness.coordinator.markInterest();
    harness.coordinator.requestBackgroundRefresh();
    await vi.advanceTimersByTimeAsync(GROUPING_STRUCTURE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.coordinator.peek()).toMatchObject({ kind: "fresh" });

    harness.dirtyLayout();
    expect(harness.coordinator.peek()).toMatchObject({ kind: "soft-stale", reason: "structure" });
    // Peeking again does not discard it: the plan stays until a fresh one lands.
    expect(harness.coordinator.peek()).toMatchObject({ kind: "soft-stale", reason: "structure" });
    harness.coordinator.stop();
  });
});

// The interest lease lives in localStorage, which the node test environment lacks.
function stubLocalStorage(): void {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); },
    removeItem: (key: string) => { stored.delete(key); },
  });
}

// v0.80.1-v0.80.2: the precompute threw "Illegal invocation" from inside the layout store's
// listener, and the store passed it on to whoever had changed the layout -- the launcher, a
// drag and drop -- which then stopped half-way.
describe("precompute faults stay inside the precompute", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T09:00:00+09:00"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetGroupingPrecomputeForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createFaultyTimerHarness() {
    const storage = new Map<string, string>();
    const listeners: Partial<Record<"layout" | "pty" | "ai" | "visibility", () => void>> = {};
    const failure = new TypeError("Illegal invocation");
    let timersBroken = false;
    let model = "gpt-test";
    const coordinator = createGroupingPrecomputeCoordinator({
      now: Date.now,
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      // What `clearTimer: clearTimeout` did in WebView2 once the coordinator called it as a method.
      clearTimer: (timer) => {
        if (timersBroken) throw failure;
        clearTimeout(timer);
      },
      getAiIdentity: () => ({ enabled: true, provider: "codex", model, promptVersion: "tab-grouping-v2" }),
      getLayoutRevision: () => 0,
      getPtyQuietDelay: () => 0,
      getVisibility: () => "visible",
      subscribeLayout: (listener) => { listeners.layout = listener; return () => {}; },
      subscribePty: (listener) => { listeners.pty = listener; return () => {}; },
      subscribeAi: (listener) => { listeners.ai = listener; return () => {}; },
      subscribeVisibility: (listener) => { listeners.visibility = listener; return () => {}; },
      scan: vi.fn(async () => structuredClone(mockGroupingAnalysis.scan)),
      analyze: vi.fn<GroupingPrecomputeDependencies["analyze"]>(async (scan) => ({ ...structuredClone(mockGroupingAnalysis), scan })),
      analyzeCurrent: vi.fn(async () => structuredClone(mockGroupingAnalysis)),
      judge: vi.fn(async () => "ok"),
      abort: vi.fn(async () => true),
      readStorage: (key) => storage.get(key) ?? null,
      writeStorage: (key, value) => { storage.set(key, value); },
    });
    return {
      coordinator,
      failure,
      listeners,
      setTimersBroken: (broken: boolean) => { timersBroken = broken; },
      switchModel: () => { model = "gpt-other"; },
    };
  }

  it.each(["layout", "pty", "ai", "visibility"] as const)(
    "keeps a throwing timer inside the %s listener that woke it",
    (name) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const harness = createFaultyTimerHarness();
      expect(harness.coordinator.markInterest()).toBe(true);
      harness.setTimersBroken(true);
      if (name === "ai") harness.switchModel();

      expect(harness.listeners[name]).toBeTypeOf("function");
      expect(() => harness.listeners[name]?.()).not.toThrow();

      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("grouping precompute"), harness.failure);
      harness.setTimersBroken(false);
      harness.coordinator.stop();
    },
  );

  it("lets a real layout change finish when the production timers throw", () => {
    // The same fault through the real store, not a stored callback: the coordinator subscribes
    // with its production dependencies and every clearTimeout throws.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    stubLocalStorage();
    __resetGroupingPrecomputeForTests();
    const failure = new TypeError("Illegal invocation");
    vi.stubGlobal("clearTimeout", () => { throw failure; });
    // The coordinator starts and subscribes; re-arming its interest lease is what throws.
    expect(markGroupingInterest()).toBe(false);

    const later = vi.fn();
    const unsubscribe = useWorkspaceListStore.subscribe(later);
    try {
      const { layoutRevision } = useWorkspaceListStore.getState();
      expect(() => useWorkspaceListStore.setState({ layoutRevision: layoutRevision + 1 })).not.toThrow();

      expect(useWorkspaceListStore.getState().layoutRevision).toBe(layoutRevision + 1);
      expect(later).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("grouping precompute layout listener threw"), failure);
    } finally {
      unsubscribe();
    }
  });

  it("answers false from the rearrangement button's call when the precompute throws", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    stubLocalStorage();
    __resetGroupingPrecomputeForTests();
    expect(markGroupingInterest()).toBe(true);

    const failure = new TypeError("Illegal invocation");
    // A second press re-arms the interest lease, which clears the previous lease timer first.
    vi.stubGlobal("clearTimeout", () => { throw failure; });

    expect(markGroupingInterest()).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("grouping precompute"), failure);
  });

  it("answers false from the startup call when the precompute throws", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    stubLocalStorage();
    __resetGroupingPrecomputeForTests();
    markGroupingInterest();
    // A fresh coordinator with the lease already recorded, as after a restart.
    __resetGroupingPrecomputeForTests();

    const failure = new TypeError("Illegal invocation");
    vi.stubGlobal("setTimeout", () => { throw failure; });

    expect(startGroupingPrecomputeIfInterested()).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("grouping precompute"), failure);
  });
});

// The dashboard can be opened before the Jev settings have been read; the start then waits for
// them. Real timers here: whether a rejection went unhandled only shows after a real turn of the
// event loop, and fake timers take setImmediate too.
describe("precompute start that waits for the Jev settings", () => {
  const settings = { enabled: false, model: "typesafe/jev-1.13", hasApiKey: false, revision: "test" };
  const unhandled = vi.fn();

  beforeEach(() => {
    unhandled.mockClear();
    process.on("unhandledRejection", unhandled);
    stubLocalStorage();
    __resetGroupingPrecomputeForTests();
  });

  afterEach(() => {
    process.off("unhandledRejection", unhandled);
    vi.unstubAllGlobals();
    __resetGroupingPrecomputeForTests();
    vi.restoreAllMocks();
  });

  // invoke() reaches the backend through window.__TAURI_INTERNALS__, which node has not got.
  function answerSettingsRead(read: () => Promise<unknown>): void {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke: vi.fn(read) } });
  }

  const nextTurnOfTheEventLoop = () => new Promise((resolve) => setImmediate(resolve));

  it("reports a start that throws once the settings arrive, and leaves no rejection unhandled", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    markGroupingInterest();
    // A fresh coordinator with the lease recorded and the settings not read yet, as after a restart.
    __resetGroupingPrecomputeForTests();
    useJevSettingsStore.setState({ loaded: false });
    answerSettingsRead(async () => settings);
    const failure = new TypeError("Illegal invocation");
    vi.stubGlobal("setTimeout", () => { throw failure; });

    expect(startGroupingPrecomputeIfInterested()).toBe(false);

    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("grouping precompute start threw"), failure);
    });
    expect(useJevSettingsStore.getState().loaded).toBe(true);
    await nextTurnOfTheEventLoop();
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("reports a settings read that fails instead of dropping it", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    useJevSettingsStore.setState({ loaded: false });
    const failure = new Error("settings_storage");
    answerSettingsRead(async () => { throw failure; });

    expect(startGroupingPrecomputeIfInterested()).toBe(false);

    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        "[mycmux] grouping precompute could not load the Jev settings; the panel carries on without precomputed plans",
        failure,
      );
    });
    await nextTurnOfTheEventLoop();
    expect(unhandled).not.toHaveBeenCalled();
  });
});
