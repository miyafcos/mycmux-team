// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
vi.mock("../../src/lib/ailog", async original => ({ ...await original<typeof import("../../src/lib/ailog")>(), ailogUsageRhythm: vi.fn() }));
import { UsageRhythmDetails } from "../../src/components/ailog/UsageRhythmDetails";
import { ailogUsageRhythm, type UsageRhythmReport } from "../../src/lib/ailog";
import { __resetAilogStoreForTests, useAilogStore } from "../../src/stores/ailogStore";
import { rhythm as report } from "../helpers/ailogPlanAFixtures";
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); __resetAilogStoreForTests();
  vi.mocked(ailogUsageRhythm).mockReset().mockResolvedValue(report);
  useAilogStore.setState({ usageRhythm: report });
  host=document.createElement("div"); document.body.append(host); root=createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); __resetAilogStoreForTests(); vi.unstubAllGlobals(); });
it("uses prefetched rhythm and performs no request when its view mounts or remounts", async () => {
  await act(async () => root.render(<UsageRhythmDetails />));
  expect(ailogUsageRhythm).not.toHaveBeenCalled();
  expect(host.querySelectorAll("[data-rhythm-slot]")).toHaveLength(31);
  await act(async () => root.render(null));
  await act(async () => root.render(<UsageRhythmDetails />));
  expect(ailogUsageRhythm).not.toHaveBeenCalled();
});
it("leaves fetching to the period loader and reuses its result across view visits and chart axes", async () => {
  await act(async () => root.render(<UsageRhythmDetails />));
  await act(async () => useAilogStore.getState().setPreset("7d"));
  expect(ailogUsageRhythm).not.toHaveBeenCalled();
  await act(async () => { await useAilogStore.getState().refreshUsageRhythm(); });
  expect(ailogUsageRhythm).toHaveBeenCalledOnce();
  await act(async () => useAilogStore.getState().setUsageSeriesAxis("provider"));
  expect(ailogUsageRhythm).toHaveBeenCalledOnce();
});
it("keeps a saved rhythm visible while the latest request is pending and after it fails", async () => {
  let reject!: (error: Error) => void;
  const latest=new Promise<UsageRhythmReport>((_, no) => { reject=no; });
  const saved={ ...report, cache: { savedAt: 1_800_000_000_000, stale: true } };
  vi.mocked(ailogUsageRhythm).mockImplementation(async (_, filters) => filters.reportCache === "prefer" ? saved : latest);
  let pending!: Promise<void>;
  await act(async () => { root.render(<UsageRhythmDetails />); pending=useAilogStore.getState().refreshUsageRhythm(); });
  expect(host.querySelector('[data-ailog-refreshing="true"]')).not.toBeNull();
  expect(host.textContent).toContain("更新中");
  expect(useAilogStore.getState().usageRhythm).toEqual(saved);
  await act(async () => { reject(new Error("latest unavailable")); await pending; });
  expect(host.textContent).toContain("latest unavailable");
  expect(host.querySelectorAll("[data-rhythm-slot]")).toHaveLength(31);
  expect(useAilogStore.getState().usageRhythm).toEqual(saved);
  expect(useAilogStore.getState().reportSnapshots.rhythm.refreshing).toBe(false);
});
