import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/ipc", () => ({
  getAccountUsage: vi.fn(),
  getGeminiUsage: vi.fn(),
}));

import { getAccountUsage, getGeminiUsage } from "../../src/lib/ipc";
import { geminiNeedsLogin, usageErrorMessage } from "../../src/lib/accountRows";
import type { AccountUsageReport, ProfileUsage } from "../../src/lib/ipc";
import { __resetUsageStoreForTests, useUsageStore } from "../../src/stores/usageStore";
import { geminiSignedOut } from "./fixtures/geminiSignedOut";

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

it.each([true, false])("L12b rereads Gemini for a newer explicit refresh (first explicit %s)", async firstExplicit => {
  __resetUsageStoreForTests();
  const first = deferred<AccountUsageReport>();
  const signedIn = { ...makeRow("live:gemini", 50), provider: "gemini" as const };
  const signedOut = geminiSignedOut;
  mockedGetAccountUsage.mockResolvedValue(makeReport([makeRow("other", 25)]));
  const gemini = vi.mocked(getGeminiUsage);
  gemini.mockReset()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce({ ...makeReport([signedOut]), gemini_revision: 2 });
  try {
    await useUsageStore.getState().fetch(firstExplicit);
    expect(useUsageStore.getState().accounts.map(row => row.profile_id)).toEqual(["other"]);
    await useUsageStore.getState().fetch(true);
    await useUsageStore.getState().fetch(true);
    first.resolve({ ...makeReport([signedIn]), gemini_revision: 1 });
    await vi.waitFor(() => expect(useUsageStore.getState().accounts).toEqual([makeRow("other", 25), signedOut]));
    expect(gemini.mock.calls).toEqual([[firstExplicit], [true]]);
    expect(usageErrorMessage(signedOut.error_code)).toContain("ログインしていません");
    expect(geminiNeedsLogin(useUsageStore.getState().accounts[1])).toBe(true);
  } finally {
    gemini.mockReset();
    __resetUsageStoreForTests();
  }
});

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

  it("updates Gemini while showing the inventory error and keeping the last other rows", async () => {
    const other = makeRow("a", 12);
    const olderGemini: ProfileUsage = { ...makeRow("live:gemini", 10), provider: "gemini" };
    const gemini: ProfileUsage = { ...makeRow("live:gemini", 30), provider: "gemini" };
    mockedGetAccountUsage.mockResolvedValueOnce(makeReport([other, olderGemini]));
    await useUsageStore.getState().fetch();

    const partial = { ...makeReport([gemini]), inventory_error: "invalid account inventory" };
    mockedGetAccountUsage.mockResolvedValueOnce(partial);
    await useUsageStore.getState().fetch(true);
    const state = useUsageStore.getState();
    expect(state.accounts).toEqual([other, gemini]);
    expect(state.lastError).toBe(partial.inventory_error);

    mockedGetAccountUsage.mockResolvedValueOnce(makeReport([gemini]));
    await useUsageStore.getState().fetch();
    expect(useUsageStore.getState().accounts).toEqual([gemini]);
    expect(useUsageStore.getState().lastError).toBeNull();
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

  it.each([false, true])("keeps the completed Gemini fetch after a cache-only switch (cached row: %s)", async (hasCachedRow) => {
    const slow = deferred<AccountUsageReport>();
    const previous = { ...makeRow("live:gemini", 10), provider: "gemini" as const, email: "old@example.test" };
    const replacement = { ...previous, email: "new@example.test" };
    const newInventory = makeRow("after-switch", 50);
    const cached = hasCachedRow ? [previous] : [];
    mockedGetAccountUsage.mockReturnValueOnce(slow.promise).mockResolvedValueOnce({
      ...makeReport([newInventory, ...cached]), ...(hasCachedRow && { gemini_revision: 1 }),
    });

    const poll = useUsageStore.getState().fetch(true);
    await useUsageStore.getState().fetch(false, undefined, { afterSwitch: true });
    expect(useUsageStore.getState().accounts).toEqual([newInventory, ...cached]);
    expect(useUsageStore.getState().lastFetchedAt).toBeNull();
    const report = { ...makeReport([makeRow("before-switch", 10), replacement]), gemini_revision: 2 };
    slow.resolve(report);
    await poll;

    expect(useUsageStore.getState().accounts).toEqual([newInventory, replacement]);
  });

  it("keeps a newer completed Gemini snapshot if an older inventory report returns late", async () => {
    const slow = deferred<AccountUsageReport>();
    const oldGemini = { ...makeRow("live:gemini", 10), provider: "gemini" as const, email: "old@example.test" };
    const freshGemini = { ...oldGemini, email: "new@example.test" };
    const inventory = makeRow("after-switch", 50);
    mockedGetAccountUsage.mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce({ ...makeReport([inventory, freshGemini]), gemini_revision: 2 });
    const poll = useUsageStore.getState().fetch();
    await useUsageStore.getState().fetch(false, undefined, { afterSwitch: true });
    const staleReport = { ...makeReport([makeRow("before-switch", 10), oldGemini]), gemini_revision: 1 };
    slow.resolve(staleReport);
    await poll;
    expect(useUsageStore.getState().accounts).toEqual([inventory, freshGemini]);
  });

  it("replaces the inventory from a late cache-only switch and keeps the completed Gemini poll", async () => {
    const pollReport = deferred<AccountUsageReport>();
    const switchReport = deferred<AccountUsageReport>();
    const oldGemini = { ...makeRow("live:gemini", 10), provider: "gemini" as const, email: "old@example.test" };
    const freshGemini = { ...oldGemini, email: "new@example.test" };
    const removed = makeRow("before-switch", 10);
    const added = makeRow("after-switch", 50);
    mockedGetAccountUsage
      .mockResolvedValueOnce({ ...makeReport([removed, oldGemini]), gemini_revision: 1 })
      .mockReturnValueOnce(pollReport.promise)
      .mockReturnValueOnce(switchReport.promise);

    await useUsageStore.getState().fetch();
    const poll = useUsageStore.getState().fetch(true);
    const afterSwitch = useUsageStore.getState().fetch(false, undefined, { afterSwitch: true });
    pollReport.resolve({ ...makeReport([removed, freshGemini]), gemini_revision: 2 });
    await poll;
    expect(useUsageStore.getState().accounts).toEqual([removed, freshGemini]);

    switchReport.resolve({ ...makeReport([added, oldGemini]), gemini_revision: 1 });
    await afterSwitch;
    expect(useUsageStore.getState().accounts).toEqual([added, freshGemini]);
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

  it("keeps loading until the newest request finishes and clears it on failure", async () => {
    const first = deferred<AccountUsageReport>();
    const second = deferred<AccountUsageReport>();
    mockedGetAccountUsage.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const firstCall = useUsageStore.getState().fetch();
    const secondCall = useUsageStore.getState().fetch();
    expect(useUsageStore.getState().loading).toBe(true);
    first.resolve(makeReport([]));
    await firstCall;
    expect(useUsageStore.getState().loading).toBe(true);
    second.reject(new Error("temporarily offline"));
    await secondCall;
    expect(useUsageStore.getState().loading).toBe(false);
  });

  it("requests current metadata only for an explicit user refresh", async () => {
    mockedGetAccountUsage.mockResolvedValue(makeReport([]));
    await useUsageStore.getState().fetch();
    expect(mockedGetAccountUsage).toHaveBeenLastCalledWith(false, undefined, true);
    await useUsageStore.getState().fetch(true);
    expect(mockedGetAccountUsage).toHaveBeenLastCalledWith(true, undefined, true);
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

it("keeps the signed-out Gemini row when a queued manual refresh fails", async () => {
  __resetUsageStoreForTests();
  const initial = deferred<AccountUsageReport>();
  const manual = deferred<AccountUsageReport>();
  const other = makeRow("other", 30);
  const gemini = vi.mocked(getGeminiUsage);
  gemini.mockReset().mockReturnValueOnce(initial.promise).mockReturnValueOnce(manual.promise);
  mockedGetAccountUsage.mockResolvedValue(makeReport([other]));
  try {
    await useUsageStore.getState().fetch();
    await useUsageStore.getState().fetch(true);
    initial.resolve({ ...makeReport([geminiSignedOut]), gemini_revision: 1 });
    await vi.waitFor(() => expect(gemini.mock.calls).toEqual([[false], [true]]));
    manual.reject(new Error("temporary transport failure"));
    await manual.promise.catch(() => {});
    expect(useUsageStore.getState().accounts).toEqual([other, geminiSignedOut]);
    expect(geminiNeedsLogin(useUsageStore.getState().accounts[1])).toBe(true);
  } finally {
    gemini.mockReset();
    __resetUsageStoreForTests();
  }
});
