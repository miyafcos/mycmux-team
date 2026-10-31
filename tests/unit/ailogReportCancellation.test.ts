import { afterEach, beforeEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async original => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()), invoke,
}));
import { ailogSeries, type AilogReportRequest } from "../../src/lib/ailog";
import { __resetAilogStoreForTests, useAilogStore } from "../../src/stores/ailogStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const report = (marker: number) => ({ marker, range: { from: 1, to: 2, label: "test" } });
const request = (index: number) => invoke.mock.calls[index][1].reportRequest as AilogReportRequest;
beforeEach(() => { __resetAilogStoreForTests(); invoke.mockReset().mockResolvedValue(report(99)); });
afterEach(() => __resetAilogStoreForTests());

it("keeps old API calls compatible without report metadata", async () => {
  await ailogSeries({}, {} as Parameters<typeof ailogSeries>[1]);
  expect(invoke.mock.calls[0][1]).not.toHaveProperty("reportRequest");
});

it("supersedes only the same endpoint and displays only its new result", async () => {
  const old = deferred<unknown>();
  invoke.mockReturnValueOnce(old.promise);
  const first = useAilogStore.getState().refreshUsage();
  await useAilogStore.getState().refreshModels();
  expect(request(1).supersedes).not.toContain(request(0).id);
  useAilogStore.getState().setPreset("7d");
  await useAilogStore.getState().refreshUsage();
  expect(request(2).supersedes).toEqual([request(0).id]);
  old.resolve(report(10));
  await first;
  expect(useAilogStore.getState().usageSeries).toEqual(report(99));
  expect(useAilogStore.getState().usageError).toBeNull();
});

it("does not show cancellation as a section error", async () => {
  invoke.mockRejectedValue("AILOG_REPORT_CANCELLED");
  await useAilogStore.getState().refreshUsage();
  expect(useAilogStore.getState().usageError).toBeNull();
  expect(useAilogStore.getState().usageLoading).toBe(false);
});

it("preserves an in-flight fetchOnce request with another subscriber", async () => {
  const old = deferred<unknown>();
  invoke.mockReturnValueOnce(old.promise);
  const first = useAilogStore.getState().refreshUsage();
  const shared = useAilogStore.getState().refreshUsage();
  expect(invoke).toHaveBeenCalledTimes(1);
  useAilogStore.getState().setPreset("7d");
  await useAilogStore.getState().refreshUsage();
  expect(request(1).supersedes).not.toContain(request(0).id);
  old.resolve(report(10));
  await Promise.all([first, shared]);
  expect(useAilogStore.getState().usageSeries).toEqual(report(99));
});

it("starts a new reader when returning to an already cancelled pending period", async () => {
  const old = deferred<unknown>();
  const middle = deferred<unknown>();
  invoke.mockReturnValueOnce(old.promise).mockReturnValueOnce(middle.promise);
  const first = useAilogStore.getState().refreshUsage();
  useAilogStore.getState().setPreset("7d");
  const second = useAilogStore.getState().refreshUsage();
  useAilogStore.getState().setPreset("30d");
  await useAilogStore.getState().refreshUsage();
  expect(invoke).toHaveBeenCalledTimes(3);
  expect(request(2).supersedes).toContain(request(1).id);
  old.reject("AILOG_REPORT_CANCELLED");
  middle.reject("AILOG_REPORT_CANCELLED");
  await Promise.all([first, second]);
  expect(useAilogStore.getState().usageSeries).toEqual(report(99));
  expect(useAilogStore.getState().usageError).toBeNull();
});
