import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
import { __resetAilogStoreForTests, invalidateAilogCaches, useAilogStore } from "../../src/stores/ailogStore";

const totals = { sessions: 1, turns: 1, userMessages: 1, input: 2, output: 3, cacheRead: 4, cacheWrite: 0, reasoning: 0, costUsd: 1, wallMs: 5, activeMs: 5, projects: 1, models: 1 };
beforeEach(() => {
  __resetAilogStoreForTests();
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  invoke.mockReset().mockImplementation((command, args) => {
    const range = args?.range?.from !== undefined ? { ...args.range, label: "custom" }
      : { from: args.range.anchor - (args.range.preset === "7d" ? 7 : 30) * 86_400_000, to: args.range.anchor, label: args.range.preset };
    const data = command === "ailog_overview" ? { range, totals }
      : command === "ailog_series" ? { range, buckets: [], ...args.options }
        : command === "ailog_models" ? { range, rows: [], byWorkTag: [], ...args.options }
          : command === "ailog_sessions" ? { range, sessions: [], ...args.options }
            : command === "ailog_breakdown" ? { range, rows: [], ...args.options }
              : { range, cells: [], ...args.options };
    return Promise.resolve(JSON.parse(JSON.stringify(data)));
  });
});
afterEach(() => { vi.restoreAllMocks(); __resetAilogStoreForTests(); });

async function load(preset: "7d" | "30d") {
  useAilogStore.getState().setPreset(preset);
  await useAilogStore.getState().loadUsage();
  await vi.waitFor(() => {
    expect(useAilogStore.getState().models).not.toBeNull();
    expect(useAilogStore.getState().previousTotalsStatus).toBe("ready");
  }, { timeout: 2_000 });
}

describe("complete current memory snapshots", () => {
  it("restores every warm surface in the preset transition and avoids another load cascade", async () => {
    await load("7d");
    const earlier = useAilogStore.getState();
    await load("30d");
    invoke.mockClear();
    useAilogStore.getState().setPreset("7d");
    const current = useAilogStore.getState();
    for (const field of ["overview", "usageSeries", "models", "sessions", "breakdown", "pivot", "previousTotals"] as const) {
      expect(current[field]).toBe(earlier[field]);
    }
    await current.loadUsage();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("requires fresh requests after index invalidation and on explicit force or reopen", async () => {
    await load("7d");
    await load("30d");
    invalidateAilogCaches();
    invoke.mockClear();
    useAilogStore.getState().setPreset("7d");
    expect(useAilogStore.getState().overview).toBeNull();
    await useAilogStore.getState().loadUsage();
    expect(invoke).toHaveBeenCalled();
    invoke.mockClear();
    await useAilogStore.getState().loadUsage({ force: true });
    expect(invoke).toHaveBeenCalled();
    invoke.mockClear();
    await useAilogStore.getState().loadUsage({ revalidate: true });
    expect(invoke).toHaveBeenCalled();
  });
});
