import { describe, expect, it } from "vitest";
import { accountLimitLabel, accountPanelGroup, groupAccountRows } from "../../src/lib/accountAvailability";
import type { ProfileUsage } from "../../src/lib/ipc";

function row(overrides: Partial<ProfileUsage> = {}): ProfileUsage {
  return {
    profile_id: "test", provider: "claude", label: "test", email: null, plan: null,
    registered: true, is_active: false, needs_relogin: false, state: "ok",
    five_hour: { pct: 10, resets_at: "2026-10-06T00:00:00Z" },
    seven_day: { pct: 20, resets_at: "2026-10-12T00:00:00Z" },
    seven_day_sonnet: null, seven_day_opus: null, model_windows: [],
    error_code: null, retry_at: null, fetched_at: "2026-10-05T00:00:00Z", ...overrides,
  };
}

describe("account availability groups", () => {
  it("places active and usable candidates before near-limit and blocked accounts", () => {
    const rows = [
      row({ profile_id: "weekly", seven_day: { pct: 100, resets_at: null } }),
      row({ profile_id: "near", seven_day: { pct: 98, resets_at: null } }),
      row({ profile_id: "free-capacity" }),
      row({ profile_id: "active", is_active: true, needs_relogin: true }),
      row({ profile_id: "login", needs_relogin: true }),
    ];
    const groups = groupAccountRows(rows);
    expect(groups.map((group) => group.id)).toEqual(["active", "available", "near_limit", "limited", "unverified"]);
    expect(groups.flatMap((group) => group.rows.map((item) => item.profile_id)))
      .toEqual(["active", "free-capacity", "near", "weekly", "login"]);
    expect(groups.find((group) => group.id === "limited")!.collapsible).toBe(true);
    expect(rows[0].profile_id).toBe("weekly");
  });

  it("distinguishes real limits from rounded percentages and near-limit warnings", () => {
    const near = row({ seven_day: { pct: 99.6, resets_at: null } });
    expect(accountPanelGroup(near)).toBe("near_limit");
    expect(accountLimitLabel(near)).toBe("残量わずか");
    expect(accountLimitLabel(row({ seven_day: { pct: 100, resets_at: null } }))).toBe("週間制限");
    expect(accountPanelGroup(row({ five_hour: { pct: 100, resets_at: null } }))).toBe("limited");
    expect(accountLimitLabel(row({ five_hour: { pct: 100, resets_at: null },
      seven_day: { pct: 100, resets_at: null } }))).toBe("5h制限・週間制限");
  });

  it("does not treat a model-specific limit as an account-wide limit", () => {
    const partial = row({ seven_day_sonnet: { pct: 100, resets_at: null },
      model_windows: [{ key: "other", window: { pct: 100, resets_at: null } }] });
    expect(accountPanelGroup(partial)).toBe("available");
    expect(accountLimitLabel(partial)).toBe("一部モデル制限");
  });

  it("keeps missing, invalid, failed, and relogin data out of verified candidates", () => {
    for (const overrides of [
      { five_hour: null, seven_day: null },
      { five_hour: { pct: NaN, resets_at: null }, seven_day: null },
      { state: "cooldown" as const },
      { state: "error" as const },
      { needs_relogin: true },
    ]) expect(accountPanelGroup(row(overrides))).toBe("unverified");
    const previousLimit = row({ state: "cooldown", seven_day: { pct: 100, resets_at: null } });
    expect(accountPanelGroup(previousLimit)).toBe("limited");
    expect(accountLimitLabel(previousLimit)).toBe("前回値：週間制限");
  });

  it("preserves provider and label order within a group as percentages change", () => {
    const rows = [
      row({ profile_id: "z", label: "z", five_hour: { pct: 1, resets_at: null } }),
      row({ profile_id: "codex", provider: "codex", label: "a" }),
      row({ profile_id: "a", label: "a", five_hour: { pct: 70, resets_at: null } }),
    ];
    const ids = () => groupAccountRows(rows).flatMap((group) => group.rows.map((item) => item.profile_id));
    expect(ids()).toEqual(["a", "z", "codex"]);
    rows[0].five_hour!.pct = 90;
    rows[2].five_hour!.pct = 0;
    expect(ids()).toEqual(["a", "z", "codex"]);
  });
});
