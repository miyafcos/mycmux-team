import { describe, expect, it } from "vitest";
import {
  accountSortKey,
  buildChipLabels,
  capVisible,
  mergeAccounts,
  orderAccounts,
  resolveMeterMode,
  worstWindow,
} from "../../src/lib/usageAccounts";
import type { AccountUsage, WindowStat } from "../../src/lib/ipc";

function stat(pct: number): WindowStat {
  return { pct, resets_at: "2026-01-01T00:00:00Z" };
}

function makeAccount(overrides: Partial<AccountUsage> & { account_id: string }): AccountUsage {
  return {
    label: overrides.account_id,
    enabled: true,
    needs_reauth: false,
    five_hour: null,
    seven_day: null,
    seven_day_sonnet: null,
    seven_day_opus: null,
    error: null,
    fetched_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("worstWindow", () => {
  it("returns null when all windows are null", () => {
    const account = makeAccount({ account_id: "a" });
    expect(worstWindow(account)).toBeNull();
  });

  it("returns the window with the highest pct", () => {
    const account = makeAccount({
      account_id: "a",
      five_hour: stat(10),
      seven_day: stat(90),
      seven_day_sonnet: stat(40),
      seven_day_opus: stat(20),
    });
    expect(worstWindow(account)).toEqual(stat(90));
  });

  it("returns the only present window", () => {
    const account = makeAccount({ account_id: "a", seven_day_opus: stat(55) });
    expect(worstWindow(account)).toEqual(stat(55));
  });
});

describe("accountSortKey", () => {
  it("ranks needs_reauth accounts as Infinity", () => {
    const account = makeAccount({ account_id: "a", needs_reauth: true });
    expect(accountSortKey(account)).toBe(Infinity);
  });

  it("ranks error-with-no-data accounts as 200", () => {
    const account = makeAccount({ account_id: "a", error: "network down" });
    expect(accountSortKey(account)).toBe(200);
  });

  it("ranks accounts with window data by worst pct", () => {
    const account = makeAccount({ account_id: "a", five_hour: stat(42) });
    expect(accountSortKey(account)).toBe(42);
  });

  it("ranks accounts with no data and no error as -1", () => {
    const account = makeAccount({ account_id: "a" });
    expect(accountSortKey(account)).toBe(-1);
  });

  it("does not use the 200 error rank when window data is present", () => {
    // error set but a window still has data -- should NOT hit the "error + no
    // data" branch, so it ranks by the worst pct instead of 200.
    const account = makeAccount({ account_id: "a", error: "partial failure", five_hour: stat(30) });
    expect(accountSortKey(account)).toBe(30);
  });
});

describe("orderAccounts", () => {
  it("filters out disabled accounts", () => {
    const accounts = [
      makeAccount({ account_id: "a", enabled: false, five_hour: stat(90) }),
      makeAccount({ account_id: "b", enabled: true, five_hour: stat(10) }),
    ];
    expect(orderAccounts(accounts).map((a) => a.account_id)).toEqual(["b"]);
  });

  it("sorts needs_reauth accounts first, then error-only, then by worst pct", () => {
    const accounts = [
      makeAccount({ account_id: "low", five_hour: stat(10) }),
      makeAccount({ account_id: "reauth", needs_reauth: true }),
      makeAccount({ account_id: "erroring", error: "boom" }),
      makeAccount({ account_id: "high", five_hour: stat(80) }),
    ];
    expect(orderAccounts(accounts).map((a) => a.account_id)).toEqual([
      "reauth",
      "erroring",
      "high",
      "low",
    ]);
  });

  it("tie-breaks equal keys by label ascending", () => {
    const accounts = [
      makeAccount({ account_id: "1", label: "zeta", five_hour: stat(50) }),
      makeAccount({ account_id: "2", label: "alpha", five_hour: stat(50) }),
    ];
    expect(orderAccounts(accounts).map((a) => a.label)).toEqual(["alpha", "zeta"]);
  });

  it("returns an empty array for zero accounts", () => {
    expect(orderAccounts([])).toEqual([]);
  });
});

describe("capVisible", () => {
  it("returns all items with zero overflow when under the cap", () => {
    expect(capVisible([1, 2], 5)).toEqual({ visible: [1, 2], overflow: 0 });
  });

  it("returns exactly max items with zero overflow when equal to the cap", () => {
    expect(capVisible([1, 2], 2)).toEqual({ visible: [1, 2], overflow: 0 });
  });

  it("caps items and reports overflow when over the cap", () => {
    expect(capVisible([1, 2, 3, 4], 2)).toEqual({ visible: [1, 2], overflow: 2 });
  });
});

describe("buildChipLabels", () => {
  it("truncates a plain label to 4 characters", () => {
    const accounts = [makeAccount({ account_id: "a", label: "workaccount" })];
    expect(buildChipLabels(accounts).get("a")).toBe("work");
  });

  it("uses the local part of an email-shaped label", () => {
    const accounts = [makeAccount({ account_id: "a", label: "hanako@example.com" })];
    expect(buildChipLabels(accounts).get("a")).toBe("hana");
  });

  it("resolves collisions with a 3-char prefix + 1-based index, ordered by account_id", () => {
    const accounts = [
      makeAccount({ account_id: "b-second", label: "hanako@example.com" }),
      makeAccount({ account_id: "a-first", label: "hanako@other.com" }),
    ];
    const labels = buildChipLabels(accounts);
    // account_id ascending: "a-first" processed before "b-second"
    expect(labels.get("a-first")).toBe("han1");
    expect(labels.get("b-second")).toBe("han2");
  });

  it("is deterministic across input order for the same account set", () => {
    const a = makeAccount({ account_id: "a-first", label: "hanako@other.com" });
    const b = makeAccount({ account_id: "b-second", label: "hanako@example.com" });
    expect(buildChipLabels([a, b])).toEqual(buildChipLabels([b, a]));
  });

  it("does not collide non-matching labels", () => {
    const accounts = [
      makeAccount({ account_id: "a", label: "hanako@example.com" }),
      makeAccount({ account_id: "b", label: "taro@example.com" }),
    ];
    const labels = buildChipLabels(accounts);
    expect(labels.get("a")).toBe("hana");
    expect(labels.get("b")).toBe("taro");
  });
});

describe("mergeAccounts", () => {
  it("backfills window data on a transient fetch failure", () => {
    const prev = [
      makeAccount({ account_id: "a", five_hour: stat(10), seven_day: stat(20), seven_day_sonnet: stat(30), seven_day_opus: stat(40) }),
    ];
    const next = [makeAccount({ account_id: "a", error: "timeout" })];

    const merged = mergeAccounts(prev, next);
    expect(merged).toEqual([
      makeAccount({
        account_id: "a",
        error: "timeout",
        five_hour: stat(10),
        seven_day: stat(20),
        seven_day_sonnet: stat(30),
        seven_day_opus: stat(40),
      }),
    ]);
  });

  it("does not backfill needs_reauth accounts", () => {
    const prev = [makeAccount({ account_id: "a", five_hour: stat(10) })];
    const next = [makeAccount({ account_id: "a", needs_reauth: true })];

    const merged = mergeAccounts(prev, next);
    expect(merged).toEqual(next);
  });

  it("does not backfill when the account has real window data", () => {
    const prev = [makeAccount({ account_id: "a", five_hour: stat(10) })];
    const next = [makeAccount({ account_id: "a", five_hour: stat(99) })];

    expect(mergeAccounts(prev, next)).toEqual(next);
  });

  it("leaves an entry unbackfilled when there is no matching prev entry", () => {
    const prev: AccountUsage[] = [];
    const next = [makeAccount({ account_id: "a", error: "timeout" })];

    expect(mergeAccounts(prev, next)).toEqual(next);
  });

  it("follows next for membership -- removed accounts drop out, new accounts appear", () => {
    const prev = [
      makeAccount({ account_id: "gone", five_hour: stat(10) }),
      makeAccount({ account_id: "kept", five_hour: stat(20) }),
    ];
    const next = [
      makeAccount({ account_id: "kept", five_hour: stat(25) }),
      makeAccount({ account_id: "new", five_hour: stat(5) }),
    ];

    expect(mergeAccounts(prev, next).map((a) => a.account_id)).toEqual(["kept", "new"]);
  });
});

describe("resolveMeterMode", () => {
  it("is hidden at or below 700px regardless of other flags", () => {
    expect(resolveMeterMode({ max700: true, max900: true, max1100: true }, true)).toBe("hidden");
    expect(resolveMeterMode({ max700: true, max900: false, max1100: false }, false)).toBe("hidden");
  });

  it("is compact at or below 900px", () => {
    expect(resolveMeterMode({ max700: false, max900: true, max1100: true }, false)).toBe("compact");
  });

  it("is full above 900px with no account chips, even under 1100px", () => {
    expect(resolveMeterMode({ max700: false, max900: false, max1100: true }, false)).toBe("full");
  });

  it("is compact between 900px and 1100px when account chips are present", () => {
    expect(resolveMeterMode({ max700: false, max900: false, max1100: true }, true)).toBe("compact");
  });

  it("is full above 1100px regardless of account chips", () => {
    expect(resolveMeterMode({ max700: false, max900: false, max1100: false }, true)).toBe("full");
    expect(resolveMeterMode({ max700: false, max900: false, max1100: false }, false)).toBe("full");
  });

  it("matches the legacy two-breakpoint behavior when there are zero accounts", () => {
    // hasAccountChips=false must reproduce the original 700/900-only logic
    // exactly, across the full flag matrix, since zero-account behavior must
    // be a pure regression-free match.
    const matrix: Array<{ max700: boolean; max900: boolean; max1100: boolean }> = [
      { max700: false, max900: false, max1100: false },
      { max700: false, max900: false, max1100: true },
      { max700: false, max900: true, max1100: true },
      { max700: true, max900: true, max1100: true },
    ];
    for (const flags of matrix) {
      const legacy = flags.max700 ? "hidden" : flags.max900 ? "compact" : "full";
      expect(resolveMeterMode(flags, false)).toBe(legacy);
    }
  });
});
