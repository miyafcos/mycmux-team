// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/ailog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ailog")>()),
  ailogUsageRhythm: vi.fn(),
}));

import { DeferredDetails } from "../../src/components/ailog/ui";
import { UsageRhythmDetails } from "../../src/components/ailog/UsageRhythmDetails";
import { ailogUsageRhythm, type UsageRhythmReport } from "../../src/lib/ailog";
import { __resetAilogStoreForTests, useAilogStore } from "../../src/stores/ailogStore";

const report: UsageRhythmReport = {
  range: { from: 0, to: 1, label: "empty" }, dayOffsetMinutes: 540,
  totals: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, io: 0, costUsd: 0 },
  days: [], byHour: [], byWeekday: [], activeDays: 0, spanDays: 0, firstDay: null, lastDay: null,
  streak: { current: 0, currentThroughDay: null, longest: 0, longestEndDay: null },
  busiestTotal: null, busiestIo: null, indexFreshness: { lastIndexedAt: 1, staleFiles: 0 },
  timings: { sqlMs: 0, rowsScanned: 0, buildMs: 0, path: "raw" },
};

let container: HTMLDivElement;
let root: Root;

async function toggle(open: boolean) {
  await act(async () => {
    const details = container.querySelector("details")!;
    details.open = open;
    details.dispatchEvent(new Event("toggle"));
  });
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  __resetAilogStoreForTests();
  vi.mocked(ailogUsageRhythm).mockReset().mockResolvedValue(report);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<DeferredDetails summary="rhythm"><UsageRhythmDetails metric="ioTokens" /></DeferredDetails>); });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  __resetAilogStoreForTests();
  vi.unstubAllGlobals();
});

describe("lazy usage rhythm", () => {
  it("fetches only on expansion, reuses the result on reopening, and tracks mounting", async () => {
    expect(ailogUsageRhythm).not.toHaveBeenCalled();
    await toggle(true);
    expect(ailogUsageRhythm).toHaveBeenCalledOnce();
    expect(useAilogStore.getState().usageRhythmOpen).toBe(true);
    await toggle(false);
    expect(useAilogStore.getState().usageRhythmOpen).toBe(false);
    await toggle(true);
    expect(ailogUsageRhythm).toHaveBeenCalledOnce();
  });

  it("reloads an expanded rhythm for period changes but reuses it across chart axes", async () => {
    await toggle(true);
    await act(async () => {
      useAilogStore.getState().setUsageSeriesAxis("provider");
      useAilogStore.getState().setUsageBucket("week");
    });
    expect(ailogUsageRhythm).toHaveBeenCalledOnce();
    await act(async () => useAilogStore.getState().setPreset("7d"));
    expect(ailogUsageRhythm).toHaveBeenCalledTimes(2);
  });
  it("keeps the saved rhythm tree visible while refreshing and after a failure", async () => {
    let reject!: (error: Error) => void;
    const latest = new Promise<UsageRhythmReport>((_, no) => { reject = no; });
    const saved = JSON.parse(JSON.stringify({ ...report, cache: { savedAt: 1_800_000_000_000, stale: true } }));
    vi.mocked(ailogUsageRhythm).mockImplementation(async (_, filters) =>
      (filters as any).reportCache === "prefer" ? saved : latest);
    await toggle(true);
    expect(container.querySelector('[data-ailog-refreshing="true"]')).not.toBeNull();
    expect(container.textContent).toContain("\u66f4\u65b0\u4e2d");
    expect(useAilogStore.getState().usageRhythm).toEqual(saved);
    await act(async () => { reject(new Error("latest unavailable")); });
    expect(container.textContent).toContain("latest unavailable");
    expect(container.querySelector('[data-ailog-refreshing="true"]')).toBeNull();
    expect(useAilogStore.getState().usageRhythm).toEqual(saved);
    expect(useAilogStore.getState().reportSnapshots.rhythm.refreshing).toBe(false);
  });

});
