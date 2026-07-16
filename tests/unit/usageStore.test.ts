import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/ipc", () => ({
  getUsageSummary: vi.fn(),
  getMultiUsage: vi.fn(),
}));

import { getUsageSummary, getMultiUsage } from "../../src/lib/ipc";
import type { AccountUsage, UsageSummary } from "../../src/lib/ipc";
import { __resetUsageStoreForTests, useUsageStore } from "../../src/stores/usageStore";

const mockedGetUsageSummary = vi.mocked(getUsageSummary);
const mockedGetMultiUsage = vi.mocked(getMultiUsage);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const summaryFixture: UsageSummary = {
  claude_5h: { pct: 10, resets_at: "2026-01-01T00:00:00Z" },
  claude_7d: { pct: 20, resets_at: "2026-01-01T00:00:00Z" },
  claude_7d_sonnet: null,
  claude_7d_opus: null,
  codex_5h: null,
  codex_7d: null,
  claude_available: true,
  codex_available: false,
  claude_error: null,
  codex_error: null,
  generated_at: "2026-01-01T00:00:00Z",
};

function makeAccountFixture(accountId: string): AccountUsage {
  return {
    account_id: accountId,
    label: accountId,
    enabled: true,
    needs_reauth: false,
    five_hour: { pct: 5, resets_at: "2026-01-01T00:00:00Z" },
    seven_day: null,
    seven_day_sonnet: null,
    seven_day_opus: null,
    error: null,
    fetched_at: "2026-01-01T00:00:00Z",
  };
}

describe("usageStore", () => {
  beforeEach(() => {
    mockedGetUsageSummary.mockReset();
    mockedGetMultiUsage.mockReset();
    __resetUsageStoreForTests();
  });

  afterEach(() => {
    __resetUsageStoreForTests();
  });

  it("populates both slices on a successful fetch", async () => {
    const accountFixture = makeAccountFixture("a");
    mockedGetUsageSummary.mockResolvedValue(summaryFixture);
    mockedGetMultiUsage.mockResolvedValue([accountFixture]);

    await useUsageStore.getState().fetch();

    const state = useUsageStore.getState();
    expect(state.summary).toEqual(summaryFixture);
    expect(state.accounts).toEqual([accountFixture]);
    expect(state.lastError).toBeNull();
    expect(state.accountsError).toBeNull();
  });

  it("updates accounts even when the summary fetch fails", async () => {
    const accountFixture = makeAccountFixture("a");
    mockedGetUsageSummary.mockRejectedValue(new Error("summary boom"));
    mockedGetMultiUsage.mockResolvedValue([accountFixture]);

    await useUsageStore.getState().fetch();

    const state = useUsageStore.getState();
    expect(state.summary).toBeNull();
    expect(state.lastError).toBe("summary boom");
    expect(state.accounts).toEqual([accountFixture]);
    expect(state.accountsError).toBeNull();
  });

  it("updates the summary even when the accounts fetch fails", async () => {
    mockedGetUsageSummary.mockResolvedValue(summaryFixture);
    mockedGetMultiUsage.mockRejectedValue(new Error("accounts boom"));

    await useUsageStore.getState().fetch();

    const state = useUsageStore.getState();
    expect(state.summary).toEqual(summaryFixture);
    expect(state.lastError).toBeNull();
    expect(state.accounts).toEqual([]);
    expect(state.accountsError).toBe("accounts boom");
  });

  it("keeps stale summary and accounts when a later fetch fails entirely", async () => {
    const accountFixture = makeAccountFixture("a");
    mockedGetUsageSummary.mockResolvedValueOnce(summaryFixture);
    mockedGetMultiUsage.mockResolvedValueOnce([accountFixture]);
    await useUsageStore.getState().fetch();

    mockedGetUsageSummary.mockRejectedValueOnce(new Error("fail2"));
    mockedGetMultiUsage.mockRejectedValueOnce(new Error("fail2b"));
    await useUsageStore.getState().fetch();

    const state = useUsageStore.getState();
    expect(state.summary).toEqual(summaryFixture);
    expect(state.accounts).toEqual([accountFixture]);
    expect(state.lastError).toBe("fail2");
    expect(state.accountsError).toBe("fail2b");
  });

  it("discards a stale accounts response that resolves after a newer fetch", async () => {
    const accountA = makeAccountFixture("older");
    const accountB = makeAccountFixture("newer");
    mockedGetUsageSummary.mockResolvedValue(summaryFixture);

    const first = deferred<AccountUsage[]>();
    const second = deferred<AccountUsage[]>();
    mockedGetMultiUsage.mockImplementationOnce(() => first.promise);
    mockedGetMultiUsage.mockImplementationOnce(() => second.promise);

    const p1 = useUsageStore.getState().fetch();
    const p2 = useUsageStore.getState().fetch();

    // Newer call resolves first.
    second.resolve([accountB]);
    await p2;
    expect(useUsageStore.getState().accounts).toEqual([accountB]);

    // Older call resolves later -- must be dropped, not overwrite the newer result.
    first.resolve([accountA]);
    await p1;
    expect(useUsageStore.getState().accounts).toEqual([accountB]);
  });

  it("fetchAccounts only updates the accounts slice", async () => {
    useUsageStore.setState({
      summary: summaryFixture,
      lastError: "pre-existing error",
      lastFetchedAt: 123,
    });
    const accountFixture = makeAccountFixture("a");
    mockedGetMultiUsage.mockResolvedValueOnce([accountFixture]);

    await useUsageStore.getState().fetchAccounts();

    const state = useUsageStore.getState();
    expect(state.accounts).toEqual([accountFixture]);
    expect(state.accountsError).toBeNull();
    expect(state.summary).toEqual(summaryFixture);
    expect(state.lastError).toBe("pre-existing error");
    expect(mockedGetUsageSummary).not.toHaveBeenCalled();
  });

  it("openAccountsDialog/closeAccountsDialog toggle dialog state and reauth target", () => {
    useUsageStore.getState().openAccountsDialog("acc-1");
    expect(useUsageStore.getState().accountsDialogOpen).toBe(true);
    expect(useUsageStore.getState().reauthTargetId).toBe("acc-1");

    useUsageStore.getState().closeAccountsDialog();
    expect(useUsageStore.getState().accountsDialogOpen).toBe(false);
    expect(useUsageStore.getState().reauthTargetId).toBeNull();
  });
});
