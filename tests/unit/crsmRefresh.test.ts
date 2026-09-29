// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../src/lib/ipc", () => ({
  crsmListSessions: mocks.list,
  crsmCreateHandoff: vi.fn(),
}));

const metadata = (age: number, generated = 1000) => ({
  cacheGeneratedAtMs: generated, cacheAgeMs: age, cacheTtlMs: 60_000, refreshing: age >= 60_000,
});
const sessions = (age: number, id = "a", generated = 1000) =>
  Object.assign([{ id, kind: "claude", cwd: "C:/test", has_user_messages: true }], { cache: metadata(age, generated) });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.resetModules();
  mocks.list.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => { callback(); return 1; });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("CRSM refresh freshness and sharing", () => {
  it("preloads a fresh snapshot without requesting an automatic refresh", async () => {
    mocks.list.mockResolvedValue(sessions(500));
    const palette = await import("../../src/components/CommandPalette/CrsmPalette");
    palette.preloadCrsmSessions();
    await flush();
    expect(mocks.list.mock.calls).toEqual([[undefined, 1000, false]]);
    await palette.autoRefreshCrsmSessions();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("joins a stale background snapshot once even if callers arrive together", async () => {
    let finish!: (value: unknown) => void;
    mocks.list.mockResolvedValueOnce(sessions(60_000)).mockImplementationOnce(() => new Promise(r => { finish = r; }));
    const palette = await import("../../src/components/CommandPalette/CrsmPalette");
    palette.preloadCrsmSessions();
    await flush();
    const first = palette.autoRefreshCrsmSessions();
    const second = palette.autoRefreshCrsmSessions();
    expect(mocks.list.mock.calls).toEqual([[undefined, 1000, false], [undefined, 1000, "auto"]]);
    finish(sessions(0, "fresh", 2000));
    expect((await first)[0].id).toBe("fresh");
    expect(await second).toBe(await first);
  });

  it("ages a previously fresh snapshot using time since receipt", async () => {
    mocks.list.mockResolvedValueOnce(sessions(59_500)).mockResolvedValueOnce(sessions(0, "new", 2000));
    const palette = await import("../../src/components/CommandPalette/CrsmPalette");
    palette.preloadCrsmSessions(); await flush();
    vi.setSystemTime(100_501);
    expect((await palette.autoRefreshCrsmSessions())[0].id).toBe("new");
    expect(mocks.list).toHaveBeenLastCalledWith(undefined, 1000, "auto");
  });

  it("keeps stale data available on failure and retries the next request", async () => {
    mocks.list.mockResolvedValueOnce(sessions(90_000))
      .mockRejectedValueOnce(new Error("scanner failed"))
      .mockResolvedValueOnce(sessions(0, "recovered", 2000));
    const palette = await import("../../src/components/CommandPalette/CrsmPalette");
    palette.preloadCrsmSessions(); await flush();
    expect((await palette.autoRefreshCrsmSessions())[0].id).toBe("recovered");
    expect(mocks.list).toHaveBeenCalledTimes(3);
  });

  it("does not replace a newer snapshot with a late cached response", async () => {
    let finishCache!: (value: unknown) => void;
    mocks.list.mockImplementationOnce(() => new Promise(r => { finishCache = r; }))
      .mockResolvedValueOnce(sessions(0, "restored", 2000));
    const palette = await import("../../src/components/CommandPalette/CrsmPalette");
    palette.preloadCrsmSessions();
    expect((await palette.autoRefreshCrsmSessions())[0].id).toBe("restored");
    finishCache(sessions(90_000, "deleted", 1000)); await flush();
    expect((await palette.autoRefreshCrsmSessions())[0].id).toBe("restored");
  });

  it("uses the backend TTL boundary and treats unknown age as stale", async () => {
    const { isCrsmCacheFresh } = await import("../../src/components/CommandPalette/CrsmPalette");
    expect(isCrsmCacheFresh(metadata(59_999))).toBe(true);
    expect(isCrsmCacheFresh(metadata(60_000))).toBe(false);
    expect(isCrsmCacheFresh(metadata(59_999), 1)).toBe(false);
    expect(isCrsmCacheFresh(undefined)).toBe(false);
    expect(isCrsmCacheFresh(metadata(NaN))).toBe(false);
  });
});
