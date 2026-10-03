// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
import { __resetAilogStoreForTests, invalidateAilogCaches, useAilogStore } from "../../src/stores/ailogStore";

const wire = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const totals = { sessions: 1, turns: 3, userMessages: 1, input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 1, wallMs: 10, activeMs: 5, projects: 1, models: 1 };
const range = { from: 100, to: 199, label: "30d" };
const overview = { range, totals, topModels: [], topProjects: [], topTitles: [] };
const series = (groupBy = "model_raw", bucket = "day") => ({ range, groupBy, bucket, buckets: [], groups: [] });
const snapshot = <T,>(report: T): T => wire({ ...report, cache: { savedAt: 1_800_000_000_000, stale: true } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
async function microtasks() { for (let i = 0; i < 30; i += 1) await Promise.resolve(); }

beforeEach(() => { __resetAilogStoreForTests(); invokeMock.mockReset(); });
afterEach(() => { document.getElementById("ailog-panel")?.remove(); vi.restoreAllMocks(); __resetAilogStoreForTests(); });

describe("primary saved-report paint", () => {
  it("publishes both real store snapshots before two paint frames and fresh IPC", async () => {
    const shell = document.createElement("div"); shell.id = "ailog-panel"; document.body.append(shell);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let frames: FrameRequestCallback[] = [];
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => { frames.push(callback); return frames.length; });
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
    const nextOverview = deferred<unknown>(); const nextSeries = deferred<unknown>();
    invokeMock.mockImplementation((command, args) => {
      if (command === "ailog_overview") return args.filters.reportCache === "prefer" ? snapshot(overview)
        : args.filters.reportCache === "refresh" ? nextOverview.promise : wire(overview);
      if (command === "ailog_series") return args.filters.reportCache === "prefer" ? snapshot(series()) : nextSeries.promise;
      return wire({ range, granularity: args?.options?.granularity ?? "raw" });
    });
    const load = useAilogStore.getState().loadUsage();
    await microtasks();
    expect(useAilogStore.getState().reportSnapshots.overview?.refreshing).toBe(true);
    expect(useAilogStore.getState().reportSnapshots.usage?.refreshing).toBe(true);
    const fresh = () => invokeMock.mock.calls.filter(([, args]) => args?.filters?.reportCache === "refresh");
    expect(fresh()).toHaveLength(0);
    const frame = () => { const current = frames; frames = []; current.forEach((callback) => callback(performance.now())); };
    frame(); await microtasks(); expect(fresh()).toHaveLength(0);
    frame(); await microtasks(); expect(fresh()).toHaveLength(2);
    nextOverview.resolve(wire(overview)); nextSeries.resolve(wire(series()));
    await load;
    expect(useAilogStore.getState().reportSnapshots).toEqual({});
  });

  it("drops a replaced primary snapshot before starting old-period revalidation", async () => {
    const shell = document.createElement("div"); shell.id = "ailog-panel"; document.body.append(shell);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let frames: FrameRequestCallback[] = [];
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => { frames.push(callback); return frames.length; });
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
    invokeMock.mockImplementation((command) => command === "ailog_overview" ? snapshot(overview) : command === "ailog_series" ? snapshot(series()) : {});
    const old = useAilogStore.getState().loadUsage();
    await microtasks();
    useAilogStore.getState().setPreset("7d");
    for (let i = 0; i < 2; i += 1) { const current = frames; frames = []; current.forEach((callback) => callback(performance.now())); await microtasks(); }
    await old;
    expect(invokeMock.mock.calls).toHaveLength(2);
    expect(useAilogStore.getState().overview).toBeNull();
    expect(useAilogStore.getState().usageSeries).toBeNull();
    expect(useAilogStore.getState().reportSnapshots).toEqual({});
  });

  it("restores an already fresh chart during the grouping transition without copying or IPC", async () => {
    invokeMock.mockImplementation((command, args) => command === "ailog_series" ? wire(series(args.options.groupBy, args.options.bucket)) : wire(overview));
    await useAilogStore.getState().refreshUsage();
    const raw = useAilogStore.getState().usageSeries;
    useAilogStore.getState().setUsageSeriesAxis("provider");
    await useAilogStore.getState().refreshUsage();
    expect(invokeMock).toHaveBeenCalledTimes(2);
    useAilogStore.getState().setUsageSeriesAxis("model_raw");
    expect(useAilogStore.getState().usageSeries).toBe(raw);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    invalidateAilogCaches();
    useAilogStore.getState().setUsageSeriesAxis("provider");
    expect(useAilogStore.getState().usageSeries).toBeNull();
  });
});
