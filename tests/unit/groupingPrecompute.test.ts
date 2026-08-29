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
  type GroupingPrecomputeDependencies,
} from "../../src/lib/groupingPrecompute";
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
