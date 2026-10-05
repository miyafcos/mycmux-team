import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
import { boundedGroupingWait } from "../../src/lib/groupingWaits";
import { abandonJevSettingsLoad, loadJevSettings, useJevSettingsStore, DEFAULT_JEV_SETTINGS, JEV_SETTINGS_TIMEOUT_MS } from "../../src/stores/jevSettingsStore";
beforeEach(() => { vi.useFakeTimers(); mock.invoke.mockReset(); abandonJevSettingsLoad(); useJevSettingsStore.setState({ ...DEFAULT_JEV_SETTINGS, loaded: false, error: null }); });
afterEach(() => { abandonJevSettingsLoad(); vi.useRealTimers(); });
describe("bounded grouping waits", () => {
  it("expires a lost reply and cancels without leaving a timer", async () => {
    const wait = boundedGroupingWait(new Promise<never>(() => {}), 500);
    const expired = expect(wait).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(501); await expired;
    const controller = new AbortController();
    const stopped = boundedGroupingWait(new Promise<never>(() => {}), 500, controller.signal);
    const cancelled = expect(stopped).rejects.toThrow("cancelled");
    controller.abort(); await cancelled;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("times out settings, then retries a fresh IPC request", async () => {
    mock.invoke.mockImplementationOnce(() => new Promise(() => {}));
    const first = loadJevSettings();
    const expired = expect(first).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(JEV_SETTINGS_TIMEOUT_MS + 1); await expired;
    mock.invoke.mockResolvedValueOnce({ ...DEFAULT_JEV_SETTINGS, revision: "fresh" });
    await loadJevSettings();
    expect(mock.invoke).toHaveBeenCalledTimes(2);
    expect(useJevSettingsStore.getState().revision).toBe("fresh");
  });
  it("abandons an old setting read on reopen and ignores its late reply", async () => {
    let resolve!: (value: unknown) => void;
    mock.invoke.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const first = loadJevSettings().catch(() => {});
    abandonJevSettingsLoad();
    mock.invoke.mockResolvedValueOnce({ ...DEFAULT_JEV_SETTINGS, revision: "new" });
    await loadJevSettings();
    resolve({ ...DEFAULT_JEV_SETTINGS, revision: "old" }); await first;
    expect(useJevSettingsStore.getState().revision).toBe("new");
  });
});
