import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/ipc", () => ({
  getAccountUsage: vi.fn(),
}));

import { getAccountUsage } from "../../src/lib/ipc";
import type { AccountUsageReport, ProfileUsage } from "../../src/lib/ipc";
import { __resetUsageStoreForTests, useUsageStore } from "../../src/stores/usageStore";

const mockedGetAccountUsage = vi.mocked(getAccountUsage);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeRow(profileId: string, pct: number): ProfileUsage {
  return {
    profile_id: profileId,
    provider: "claude",
    label: profileId,
    email: null,
    plan: null,
    registered: true,
    is_active: false,
    needs_relogin: false,
    state: "ok",
    five_hour: { pct, resets_at: "2026-01-01T00:00:00Z" },
    seven_day: null,
    seven_day_sonnet: null,
    seven_day_opus: null,
    model_windows: [],
    error_code: null,
    retry_at: null,
    fetched_at: "2026-01-01T00:00:00Z",
  };
}

function makeReport(rows: ProfileUsage[], generatedAt = "2026-01-01T00:00:00Z"): AccountUsageReport {
  return { accounts: rows, generated_at: generatedAt };
}

describe("useUsageStore", () => {
  beforeEach(() => {
    __resetUsageStoreForTests();
    mockedGetAccountUsage.mockReset();
  });

  afterEach(() => {
    __resetUsageStoreForTests();
  });

  it("stores the report and clears any previous error", () => {
    const report = makeReport([makeRow("a", 12)]);
    mockedGetAccountUsage.mockResolvedValue(report);

    return useUsageStore
      .getState()
      .fetch()
      .then(() => {
        const state = useUsageStore.getState();
        expect(state.accounts).toEqual(report.accounts);
        expect(state.generatedAt).toBe("2026-01-01T00:00:00Z");
        expect(state.lastError).toBeNull();
        expect(state.lastFetchedAt).not.toBeNull();
      });
  });

  it("keeps the last known-good rows when a fetch fails", async () => {
    mockedGetAccountUsage.mockResolvedValueOnce(makeReport([makeRow("a", 12)]));
    await useUsageStore.getState().fetch();

    mockedGetAccountUsage.mockRejectedValueOnce(new Error("backend down"));
    await useUsageStore.getState().fetch();

    const state = useUsageStore.getState();
    expect(state.accounts).toHaveLength(1);
    expect(state.accounts[0].profile_id).toBe("a");
    expect(state.lastError).toBe("backend down");
  });

  it("drops an earlier response that resolves after a newer one", async () => {
    const slow = deferred<AccountUsageReport>();
    const fast = deferred<AccountUsageReport>();
    mockedGetAccountUsage.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);

    const firstCall = useUsageStore.getState().fetch();
    const secondCall = useUsageStore.getState().fetch();

    fast.resolve(makeReport([makeRow("newer", 50)], "2026-01-02T00:00:00Z"));
    await secondCall;
    slow.resolve(makeReport([makeRow("older", 10)], "2026-01-01T00:00:00Z"));
    await firstCall;

    const state = useUsageStore.getState();
    expect(state.accounts.map((row) => row.profile_id)).toEqual(["newer"]);
    expect(state.generatedAt).toBe("2026-01-02T00:00:00Z");
  });

  it("drops a stale rejection so it cannot clobber a newer success", async () => {
    const slow = deferred<AccountUsageReport>();
    const fast = deferred<AccountUsageReport>();
    mockedGetAccountUsage.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);

    const firstCall = useUsageStore.getState().fetch();
    const secondCall = useUsageStore.getState().fetch();

    fast.resolve(makeReport([makeRow("newer", 50)]));
    await secondCall;
    slow.reject(new Error("stale failure"));
    await firstCall;

    expect(useUsageStore.getState().lastError).toBeNull();
  });

  it("replaces the row list outright rather than merging", async () => {
    mockedGetAccountUsage.mockResolvedValueOnce(makeReport([makeRow("a", 12), makeRow("b", 30)]));
    await useUsageStore.getState().fetch();

    // 'b' has gone (removed account); a stale merge would keep showing it.
    mockedGetAccountUsage.mockResolvedValueOnce(makeReport([makeRow("a", 15)]));
    await useUsageStore.getState().fetch();

    expect(useUsageStore.getState().accounts.map((row) => row.profile_id)).toEqual(["a"]);
  });
});
