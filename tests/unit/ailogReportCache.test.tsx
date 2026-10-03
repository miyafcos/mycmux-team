import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("../../src/stores/ailogStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/stores/ailogStore")>();
  // Only the React subscription is adapted for SSR; transitions are executed
  // by the real Zustand store and the actual serialized IPC wrapper.
  const hook = Object.assign(<T,>(selector: (state: ReturnType<typeof actual.useAilogStore.getState>) => T) => selector(actual.useAilogStore.getState()), actual.useAilogStore);
  return { ...actual, useAilogStore: hook };
});

import { ReportCacheStatus } from "../../src/components/ailog/ReportCacheStatus";
import { __resetAilogStoreForTests, invalidateAilogCaches, useAilogStore } from "../../src/stores/ailogStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const wire = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const totals = (costUsd: number) => ({ sessions: 1, turns: 1, userMessages: 1, input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd, wallMs: 0, activeMs: 0, projects: 1, models: 1 });
const report = (cost = 10) => ({ range: { from: 100, to: 199, label: "test" }, totals: totals(cost), marker: cost });
const saved = (cost = 10) => wire({ ...report(cost), cache: { savedAt: 1_800_000_000_000, stale: true } });

const resources = [
  ["overview", "ailog_overview", "refresh", "overview", "loading"],
  ["usage", "ailog_series", "refreshUsage", "usageSeries", "usageLoading"],
  ["breakdown", "ailog_breakdown", "refreshBreakdown", "breakdown", "breakdownLoading"],
  ["pivot", "ailog_pivot", "refreshPivot", "pivot", "pivotLoading"],
  ["rhythm", "ailog_usage_rhythm", "refreshUsageRhythm", "usageRhythm", "usageRhythmLoading"],
] as const;

beforeEach(() => {
  __resetAilogStoreForTests();
  invokeMock.mockReset().mockResolvedValue({});
});
afterEach(() => { vi.restoreAllMocks(); __resetAilogStoreForTests(); });

describe("persistent AI log report replacements", () => {
  it.each(resources)("publishes saved %s before the pending latest report", async (slot, command, action, field, loading) => {
    const latest = deferred<unknown>();
    const snapshot = saved();
    invokeMock.mockImplementation((name, args) => name !== command ? {}
      : args.filters.reportCache === "prefer" ? wire(snapshot) : latest.promise);
    const pending = useAilogStore.getState()[action]();
    await vi.waitFor(() => expect(useAilogStore.getState()[field]).toEqual(snapshot), { timeout: 2_000 });
    expect(useAilogStore.getState()[loading]).toBe(true);
    expect(useAilogStore.getState().reportSnapshots[slot]).toEqual({ ...snapshot.cache, refreshing: true });
    const html = renderToStaticMarkup(<ReportCacheStatus />);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("\u4fdd\u5b58\u6e08\u307f\u306e\u96c6\u8a08");
    expect(html).toContain("\u6700\u65b0\u306e\u8a18\u9332\u3092\u96c6\u8a08\u4e2d");
    if (slot === "overview") expect(html).toContain("\u4fdd\u5b58\u6642\u306e\u671f\u9593");
    latest.resolve(wire(report(99)));
    await pending;
    expect(useAilogStore.getState()[field]).toEqual(report(99));
    expect(useAilogStore.getState()[loading]).toBe(false);
    expect(useAilogStore.getState().reportSnapshots[slot]).toBeUndefined();
    expect(renderToStaticMarkup(<ReportCacheStatus />)).toBe("");
  });

  it("retains and honestly labels a saved chart after a failed latest request", async () => {
    const latest = deferred<unknown>();
    invokeMock.mockImplementation((_, args) => args.filters.reportCache === "prefer" ? saved() : latest.promise);
    const pending = useAilogStore.getState().refreshUsage();
    await vi.waitFor(() => expect(useAilogStore.getState().usageSeries).toEqual(saved()), { timeout: 2_000 });
    latest.reject(new Error("refresh unavailable"));
    await pending;
    expect(useAilogStore.getState().usageSeries).toEqual(saved());
    expect(useAilogStore.getState().usageError).toContain("refresh unavailable");
    expect(useAilogStore.getState().reportSnapshots.usage.refreshing).toBe(false);
    expect(renderToStaticMarkup(<ReportCacheStatus />)).toContain("\u6700\u65b0\u306e\u96c6\u8a08\u3092\u66f4\u65b0\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f");
  });

  it("does not let an older saved response overwrite an explicit fresh update", async () => {
    const olderSaved = deferred<unknown>();
    invokeMock.mockImplementation((_, args) => args.filters.reportCache === "prefer" ? olderSaved.promise : report(99));
    const old = useAilogStore.getState().refreshUsage();
    await useAilogStore.getState().refreshUsage({ force: true });
    olderSaved.resolve(saved());
    await old;
    expect(useAilogStore.getState().usageSeries).toEqual(report(99));
    expect(useAilogStore.getState().reportSnapshots).toEqual({});
  });

  it("shares an interim snapshot with a second subscriber while latest is pending", async () => {
    const latest = deferred<unknown>();
    invokeMock.mockImplementation((_, args) => args.filters.reportCache === "prefer" ? saved() : latest.promise);
    const first = useAilogStore.getState().refreshUsage();
    await vi.waitFor(() => expect(useAilogStore.getState().reportSnapshots.usage).toBeDefined(), { timeout: 2_000 });
    const second = useAilogStore.getState().refreshUsage();
    expect(useAilogStore.getState().usageSeries).toEqual(saved());
    expect(invokeMock).toHaveBeenCalledTimes(2);
    latest.resolve(report(99));
    await Promise.all([first, second]);
    expect(useAilogStore.getState().usageSeries).toEqual(report(99));
  });

  it("bypasses disk and memory on force, and revalidates memory on reopen", async () => {
    invokeMock.mockResolvedValue(report(10));
    await useAilogStore.getState().refreshUsage();
    await useAilogStore.getState().refreshUsage();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    await useAilogStore.getState().refreshUsage({ revalidate: true });
    expect(invokeMock.mock.calls.at(-1)?.[1].filters.reportCache).toBe("prefer");
    await useAilogStore.getState().refreshUsage({ force: true });
    expect(invokeMock.mock.calls.at(-1)?.[1].filters.reportCache).toBe("refresh");
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });

  it("does not relabel an earlier memory value as current after failed revalidation", async () => {
    invokeMock.mockResolvedValueOnce(report(10));
    await useAilogStore.getState().refreshUsage();
    invokeMock.mockRejectedValueOnce(new Error("latest unavailable"));
    await useAilogStore.getState().refreshUsage({ revalidate: true });
    expect(useAilogStore.getState().usageError).toContain("latest unavailable");
    invokeMock.mockResolvedValueOnce(report(99));
    await useAilogStore.getState().refreshUsage();
    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(useAilogStore.getState().usageSeries).toEqual(report(99));
    expect(useAilogStore.getState().usageError).toBeNull();
  });

  it("drops saved and latest responses across period and index invalidation", async () => {
    const first = deferred<unknown>();
    invokeMock.mockReturnValue(first.promise);
    const pending = useAilogStore.getState().refreshUsage();
    useAilogStore.getState().setPreset("7d");
    invalidateAilogCaches();
    first.resolve(saved());
    await pending;
    expect(useAilogStore.getState().usageSeries).toBeNull();
    expect(useAilogStore.getState().reportSnapshots).toEqual({});
    // Neither an interim result nor a fresh revalidation lands in the new
    // context, even when the old IPC request itself cannot be cancelled.
  });

  it("uses the exact current shared window when reopening, including the last partial five minutes", async () => {
    const now = Date.UTC(2026, 9, 3, 12, 34, 56);
    vi.spyOn(Date, "now").mockReturnValue(now);
    useAilogStore.setState({ rangeAnchor: now - 60_000 });
    invokeMock.mockImplementation((command) => command === "ailog_overview" ? report() : {});
    await useAilogStore.getState().loadUsage({ revalidate: true });
    const windows = invokeMock.mock.calls.map(([, args]) => args?.range).filter((range) => range?.preset);
    expect(windows.length).toBeGreaterThanOrEqual(4);
    expect(windows.every((range) => range.anchor === now)).toBe(true);
    expect(useAilogStore.getState().rangeAnchor).toBe(now);
    // The previous implementation rounded this down, dropping new records in
    // the final partial five-minute interval from a supposedly latest result.
    expect(now % 300_000).not.toBe(0);
  });

  it("clears cached chart labels when the grouping or bucket changes", async () => {
    const latest = deferred<unknown>();
    invokeMock.mockImplementation((_, args) => args.filters.reportCache === "prefer" ? saved() : latest.promise);
    const pending = useAilogStore.getState().refreshUsage();
    await vi.waitFor(() => expect(useAilogStore.getState().reportSnapshots.usage).toBeDefined(), { timeout: 2_000 });
    useAilogStore.getState().setUsageSeriesAxis("provider");
    useAilogStore.getState().setUsageBucket("week");
    expect(useAilogStore.getState().usageSeries).toBeNull();
    expect(useAilogStore.getState().reportSnapshots.usage).toBeUndefined();
    latest.resolve(report(99));
    await pending;
    expect(useAilogStore.getState().usageSeries).toBeNull();
  });
});
