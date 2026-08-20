import { describe, expect, it } from "vitest";
import { buildChipLabels, capVisible, resolveMeterMode } from "../../src/lib/usageAccounts";
import type { ProfileUsage } from "../../src/lib/ipc";

function makeAccount(overrides: Partial<ProfileUsage> & { profile_id: string }): ProfileUsage {
  return {
    provider: "claude",
    label: overrides.profile_id,
    email: null,
    plan: null,
    registered: true,
    is_active: false,
    needs_relogin: false,
    state: "ok",
    five_hour: null,
    seven_day: null,
    seven_day_sonnet: null,
    seven_day_opus: null,
    model_windows: [],
    error_code: null,
    retry_at: null,
    fetched_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

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
    const accounts = [makeAccount({ profile_id: "a", label: "workaccount" })];
    expect(buildChipLabels(accounts).get("a")).toBe("work");
  });

  it("uses the local part of an email-shaped label", () => {
    const accounts = [makeAccount({ profile_id: "a", label: "hanako@example.com" })];
    expect(buildChipLabels(accounts).get("a")).toBe("hana");
  });

  it("resolves collisions with a 3-char prefix + 1-based index, ordered by account_id", () => {
    const accounts = [
      makeAccount({ profile_id: "b-second", label: "hanako@example.com" }),
      makeAccount({ profile_id: "a-first", label: "hanako@other.com" }),
    ];
    const labels = buildChipLabels(accounts);
    // account_id ascending: "a-first" processed before "b-second"
    expect(labels.get("a-first")).toBe("han1");
    expect(labels.get("b-second")).toBe("han2");
  });

  it("is deterministic across input order for the same account set", () => {
    const a = makeAccount({ profile_id: "a-first", label: "hanako@other.com" });
    const b = makeAccount({ profile_id: "b-second", label: "hanako@example.com" });
    expect(buildChipLabels([a, b])).toEqual(buildChipLabels([b, a]));
  });

  it("does not collide non-matching labels", () => {
    const accounts = [
      makeAccount({ profile_id: "a", label: "hanako@example.com" }),
      makeAccount({ profile_id: "b", label: "taro@example.com" }),
    ];
    const labels = buildChipLabels(accounts);
    expect(labels.get("a")).toBe("hana");
    expect(labels.get("b")).toBe("taro");
  });
});

describe("resolveMeterMode", () => {
  it("is hidden at or below 700px regardless of other flags", () => {
    expect(resolveMeterMode({ max700: true, max1000: true, max1300: true }, true)).toBe("hidden");
    expect(resolveMeterMode({ max700: true, max1000: false, max1300: false }, false)).toBe("hidden");
  });

  it("is compact at or below 1000px", () => {
    expect(resolveMeterMode({ max700: false, max1000: true, max1300: true }, false)).toBe("compact");
  });

  it("is full above 1000px with no account chips, even under 1300px", () => {
    expect(resolveMeterMode({ max700: false, max1000: false, max1300: true }, false)).toBe("full");
  });

  it("is compact between 1000px and 1300px when account chips are present", () => {
    expect(resolveMeterMode({ max700: false, max1000: false, max1300: true }, true)).toBe("compact");
  });

  it("is full above 1300px regardless of account chips", () => {
    expect(resolveMeterMode({ max700: false, max1000: false, max1300: false }, true)).toBe("full");
    expect(resolveMeterMode({ max700: false, max1000: false, max1300: false }, false)).toBe("full");
  });

  it("matches the legacy two-breakpoint behavior when there are zero accounts", () => {
    // hasAccountChips=false follows the 700/1000 layout thresholds.
    // exactly, across the full flag matrix, since zero-account behavior must
    // be a pure regression-free match.
    const matrix: Array<{ max700: boolean; max1000: boolean; max1300: boolean }> = [
      { max700: false, max1000: false, max1300: false },
      { max700: false, max1000: false, max1300: true },
      { max700: false, max1000: true, max1300: true },
      { max700: true, max1000: true, max1300: true },
    ];
    for (const flags of matrix) {
      const legacy = flags.max700 ? "hidden" : flags.max1000 ? "compact" : "full";
      expect(resolveMeterMode(flags, false)).toBe(legacy);
    }
  });
});
