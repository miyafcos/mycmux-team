import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async original => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()), invoke,
}));
import { parseDayInput, type SeriesReport } from "../../src/lib/ailog";
import { __resetAilogStoreForTests, invalidateAilogCaches, useAilogStore } from "../../src/stores/ailogStore";

const from = parseDayInput("2026-10-01")!;
const day = 86_400_000;
function fixture(): SeriesReport {
  const empty = () => ({ models: [] as string[], tokens: 0 });
  return { range: { from, to: from + 3 * day - 1, label: "custom" }, bucket: "day", groupBy: "model_raw",
    buckets: [0, 1, 2].map(index => ({ bucket: from + index * day, turns: 2, sessions: 1, costUsd: 1,
      groups: [{ group: "gpt-sample", turns: 1, sessions: 1, input: index + 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: 1 },
        { group: "<synthetic>", turns: 1, sessions: 1, input: 200, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }] })),
    priceSource: "fixture", costNote: "fixture", priceCoverage: {
      priced: { models: ["gpt-sample"], tokens: 33 }, internal: { models: ["<synthetic>"], tokens: 600 },
      local: empty(), flat: empty(), reported: empty(), unknown: empty(), coveredTokenRatio: 1,
    } };
}
beforeEach(async () => {
  __resetAilogStoreForTests(); invoke.mockReset().mockResolvedValue(fixture());
  useAilogStore.setState({ preset: "custom", customFrom: "2026-10-01", customTo: "2026-10-03" });
  await useAilogStore.getState().refreshUsage();
  invoke.mockClear();
});
afterEach(() => __resetAilogStoreForTests());

describe("complete grass day reuse", () => {
  it("reuses the selected day's buckets and rebuilds its price coverage without IPC", async () => {
    useAilogStore.getState().setCustomRange("2026-10-02", "2026-10-02");
    await useAilogStore.getState().refreshUsage();
    expect(invoke).not.toHaveBeenCalled();
    const report = useAilogStore.getState().usageSeries!;
    expect(report.range).toEqual({ from: from + day, to: from + 2 * day - 1, label: "custom" });
    expect(report.buckets).toEqual([fixture().buckets[1]]);
    expect(report.priceCoverage.priced).toEqual({ models: ["gpt-sample"], tokens: 11 });
    expect(report.priceCoverage.internal.tokens).toBe(200);
    expect(report.priceCoverage.coveredTokenRatio).toBe(1);
  });
  it("keeps index invalidation and explicit refresh authoritative", async () => {
    useAilogStore.getState().setCustomRange("2026-10-02", "2026-10-02");
    await useAilogStore.getState().refreshUsage({ force: true });
    expect(invoke).toHaveBeenCalledTimes(1);
    invalidateAilogCaches();
    await useAilogStore.getState().refreshUsage();
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it.each(["partial", "different-window", "ambiguous-model", "stale"])("fetches again for %s inputs", async mode => {
    const report = fixture();
    if (mode === "partial") report.range.from = from + day + 1;
    if (mode === "different-window") report.range.to -= 1;
    if (mode === "ambiguous-model") report.buckets[1].groups[0].group = "(unknown)";
    if (mode === "stale") useAilogStore.setState({ usageError: "refresh failed" });
    useAilogStore.setState({ usageSeries: report });
    useAilogStore.getState().setCustomRange("2026-10-02", "2026-10-02");
    await useAilogStore.getState().refreshUsage();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("does not seed an invalidated visible parent back into the new epoch", async () => {
    invalidateAilogCaches();
    const fresh = fixture();
    fresh.buckets[1].groups[0].input = 99;
    invoke.mockResolvedValue(fresh);
    useAilogStore.getState().setCustomRange("2026-10-02", "2026-10-02");
    await useAilogStore.getState().refreshUsage();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(useAilogStore.getState().usageSeries!.buckets[1].groups[0].input).toBe(99);
  });
  it("does not overwrite a newer forced day with its older parent", async () => {
    useAilogStore.getState().setCustomRange("2026-10-02", "2026-10-02");
    const fresh = fixture();
    fresh.range = { from: from + day, to: from + 2 * day - 1, label: "custom" };
    fresh.buckets = [fresh.buckets[1]];
    fresh.buckets[0].groups[0].input = 99;
    invoke.mockResolvedValue(fresh);
    await useAilogStore.getState().refreshUsage({ force: true });
    useAilogStore.getState().setCustomRange("2026-10-01", "2026-10-03");
    await useAilogStore.getState().refreshUsage();
    expect(useAilogStore.getState().usageSeries!.buckets[1].groups[0].input).toBe(2);
    invoke.mockClear();
    useAilogStore.getState().setCustomRange("2026-10-02", "2026-10-02");
    await useAilogStore.getState().refreshUsage();
    expect(invoke).not.toHaveBeenCalled();
    expect(useAilogStore.getState().usageSeries!.buckets[0].groups[0].input).toBe(99);
  });
  it("reuses a complete day from the Rust unbounded all-history range", async () => {
    const report = fixture();
    report.range = { from: -(2 ** 61), to: from + 3 * day - 1, label: "all" };
    useAilogStore.getState().setPreset("all");
    useAilogStore.setState({ rangeAnchor: report.range.to });
    invoke.mockResolvedValue(report);
    await useAilogStore.getState().refreshUsage();
    invoke.mockClear();
    useAilogStore.getState().setCustomRange("2026-10-02", "2026-10-02");
    await useAilogStore.getState().refreshUsage();
    expect(invoke).not.toHaveBeenCalled();
    expect(useAilogStore.getState().usageSeries!.buckets).toEqual([report.buckets[1]]);
  });

  it("replaces an older seeded day after a newer parent refresh", async () => {
    useAilogStore.getState().setCustomRange("2026-10-02", "2026-10-02");
    await useAilogStore.getState().refreshUsage();
    useAilogStore.getState().setCustomRange("2026-10-01", "2026-10-03");
    const fresh = fixture();
    fresh.buckets[1].groups[0].input = 99;
    invoke.mockResolvedValue(fresh);
    await useAilogStore.getState().refreshUsage({ force: true });
    invoke.mockClear();
    useAilogStore.getState().setCustomRange("2026-10-02", "2026-10-02");
    await useAilogStore.getState().refreshUsage();
    expect(invoke).not.toHaveBeenCalled();
    expect(useAilogStore.getState().usageSeries!.buckets[0].groups[0].input).toBe(99);
  });

});
