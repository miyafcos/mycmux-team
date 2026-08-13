import { describe, expect, it } from "vitest";
import type {
  ProfileUsage,
  UsageRowState,
  WindowStat,
} from "../../src/lib/ipc";
import {
  USAGE_STATE_MESSAGE,
  displayWindows,
  formatPct,
  formatResetShort,
  orderAccountRows,
  rowHasWindows,
  rowMessage,
  rowNeedsAttention,
  staleWindowsNote,
  usageBarColor,
  usageColor,
  worstPct,
} from "../../src/lib/accountRows";

function stat(pct: number): WindowStat {
  return { pct, resets_at: "2026-08-08T20:00:00Z" };
}

function row(overrides: Partial<ProfileUsage> = {}): ProfileUsage {
  return {
    profile_id: "claude-1",
    provider: "claude",
    label: "one",
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
    fetched_at: "2026-08-08T12:00:00Z",
    ...overrides,
  };
}

describe("orderAccountRows", () => {
  it("is deterministic regardless of input order", () => {
    const rows = [
      row({
        profile_id: "d",
        label: "d",
        provider: "codex",
        five_hour: stat(90),
      }),
      row({
        profile_id: "a",
        label: "a",
        is_active: true,
        five_hour: stat(10),
      }),
      row({
        profile_id: "b",
        label: "b",
        state: "error",
        error_code: "usage.error.network",
      }),
      row({ profile_id: "c", label: "c", five_hour: stat(50) }),
    ];
    const expected = orderAccountRows(rows).map((entry) => entry.profile_id);
    for (const shuffle of [
      [3, 1, 0, 2],
      [2, 0, 3, 1],
      [1, 3, 2, 0],
    ]) {
      const reordered = shuffle.map((index) => rows[index]);
      expect(
        orderAccountRows(reordered).map((entry) => entry.profile_id),
      ).toEqual(expected);
    }
  });

  it("ranks by provider, registration, then label — never by state or usage", () => {
    const ordered = orderAccountRows([
      row({ profile_id: "codex-quiet", provider: "codex", label: "z" }),
      row({ profile_id: "live:claude", label: "aa-live", registered: false }),
      row({ profile_id: "claude-busy", label: "busy", five_hour: stat(80) }),
      row({
        profile_id: "claude-active",
        label: "active",
        is_active: true,
        five_hour: stat(1),
      }),
      row({
        profile_id: "claude-broken",
        label: "broken",
        state: "needs_relogin",
      }),
    ]);
    expect(ordered.map((entry) => entry.profile_id)).toEqual([
      "claude-active", // plain label order within a provider...
      "claude-broken", // ...errors do not jump the queue
      "claude-busy", // ...nor does a high percentage
      "live:claude", // unregistered live logins trail the registered rows
      "codex-quiet", // codex always trails claude
    ]);
  });

  it("keeps a row in its place when only its state changes between fetches", () => {
    const before = [
      row({ profile_id: "a", label: "a" }),
      row({ profile_id: "b", label: "b" }),
      row({ profile_id: "c", label: "c" }),
    ];
    const after = [
      before[0],
      row({
        profile_id: "b",
        label: "b",
        state: "error",
        error_code: "usage.error.upstream",
      }),
      row({ profile_id: "c", label: "c", five_hour: stat(99) }),
    ];
    expect(orderAccountRows(before).map((entry) => entry.profile_id)).toEqual(
      orderAccountRows(after).map((entry) => entry.profile_id),
    );
  });

  it("does not mutate its input", () => {
    const rows = [
      row({ profile_id: "b", label: "b" }),
      row({ profile_id: "a", label: "a" }),
    ];
    const before = rows.map((entry) => entry.profile_id);
    orderAccountRows(rows);
    expect(rows.map((entry) => entry.profile_id)).toEqual(before);
  });
});

describe("worstPct", () => {
  it("takes the larger of the two headline windows and null when neither exists", () => {
    expect(worstPct(row({ five_hour: stat(12), seven_day: stat(40) }))).toBe(
      40,
    );
    expect(worstPct(row({ five_hour: stat(70), seven_day: stat(3) }))).toBe(70);
    expect(worstPct(row({ seven_day: stat(8) }))).toBe(8);
    expect(worstPct(row())).toBeNull();
  });

  it("includes model-specific windows", () => {
    expect(
      worstPct(
        row({
          seven_day: stat(40),
          model_windows: [{ key: "Fable", window: stat(54) }],
        }),
      ),
    ).toBe(54);
  });

  it("includes legacy model windows", () => {
    expect(worstPct(row({ seven_day_sonnet: stat(63) }))).toBe(63);
  });
});

describe("displayWindows", () => {
  it("skips null fixed windows and appends abbreviated model windows", () => {
    const windows = displayWindows(
      row({
        seven_day: stat(37),
        model_windows: [{ key: "seven_day_fable", window: stat(54) }],
      }),
    );
    expect(windows.map(({ label, stat: value }) => [label, value.pct])).toEqual(
      [
        ["7d", 37],
        ["F", 54],
      ],
    );
    expect(windows[1].hint).toContain("fable");
  });

  it("includes legacy Sonnet and Opus windows", () => {
    const windows = displayWindows(
      row({ seven_day_sonnet: stat(41), seven_day_opus: stat(58) }),
    );
    expect(windows.map(({ key, label, stat: value }) => [key, label, value.pct])).toEqual([
      ["seven_day_sonnet", "S", 41],
      ["seven_day_opus", "O", 58],
    ]);
  });

  it("keeps distinct keys for models with the same abbreviation", () => {
    const windows = displayWindows(
      row({
        model_windows: [
          { key: "Fable", window: stat(31) },
          { key: "Falcon", window: stat(47) },
        ],
      }),
    );
    expect(windows.map(({ key }) => key)).toEqual(["model:Fable", "model:Falcon"]);
  });
});

describe("formatResetShort", () => {
  const now = new Date("2026-08-09T12:00:00");

  it("shows a clock time for a same-day reset and a date otherwise", () => {
    expect(formatResetShort("2026-08-09T16:00:00", now)).toMatch(/16[:時]00/);
    expect(formatResetShort("2026-08-12T00:00:00", now)).toMatch(/8[/月]12/);
  });

  it("is empty for missing or unparsable values", () => {
    expect(formatResetShort("", now)).toBe("");
    expect(formatResetShort("not-a-date", now)).toBe("");
  });
});

describe("formatPct", () => {
  it("drops the decimal once the number is wide enough to read on its own", () => {
    expect(formatPct(0)).toBe("0.0%");
    expect(formatPct(9.94)).toBe("9.9%");
    expect(formatPct(10)).toBe("10%");
    expect(formatPct(12.34)).toBe("12%");
    expect(formatPct(100)).toBe("100%");
  });

  it("clamps out-of-range values", () => {
    expect(formatPct(-5)).toBe("0.0%");
    expect(formatPct(140)).toBe("100%");
  });
});

describe("usage colours", () => {
  it("keeps healthy numbers achromatic so the warning colours stand out", () => {
    expect(usageColor(79.9)).toBe("var(--cmux-text-secondary)");
    expect(usageColor(80)).toBe("var(--cmux-usage-warn)");
    expect(usageColor(94.9)).toBe("var(--cmux-usage-warn)");
    expect(usageColor(95)).toBe("var(--cmux-usage-danger)");
  });

  it("gives the bar the healthy colour the number gives up", () => {
    expect(usageBarColor(79.9)).toBe("var(--cmux-usage-ok)");
    expect(usageBarColor(80)).toBe("var(--cmux-usage-warn)");
    expect(usageBarColor(95)).toBe("var(--cmux-usage-danger)");
  });
});

describe("row messaging", () => {
  it("covers every row state", () => {
    const states: UsageRowState[] = [
      "ok",
      "wait_for_cli",
      "cooldown",
      "needs_relogin",
      "unsupported",
      "error",
    ];
    expect(Object.keys(USAGE_STATE_MESSAGE).sort()).toEqual([...states].sort());
  });

  it("shows nothing for a healthy row and something for every other state", () => {
    expect(rowMessage(row())).toBe("");
    for (const state of [
      "wait_for_cli",
      "cooldown",
      "needs_relogin",
      "unsupported",
      "error",
    ] as const) {
      expect(rowMessage(row({ state }))).not.toBe("");
      expect(rowNeedsAttention(row({ state }))).toBe(true);
    }
    expect(rowNeedsAttention(row())).toBe(false);
  });

  it("names the resume time when a cooldown has one", () => {
    const withTime = rowMessage(
      row({ state: "cooldown", retry_at: "2026-08-08T20:00:00Z" }),
    );
    expect(withTime).toContain("再開");
    expect(rowMessage(row({ state: "cooldown" }))).toBe(
      "取得を一時停止しています。",
    );
  });

  it("keeps a cooldown row with stale numbers out of the attention set", () => {
    const paused = row({ state: "cooldown", five_hour: stat(26) });
    expect(rowHasWindows(paused)).toBe(true);
    expect(rowNeedsAttention(paused)).toBe(false);
    // Without numbers to show, the cooldown still asks for attention.
    expect(rowNeedsAttention(row({ state: "cooldown" }))).toBe(true);
    // A relogin can never ride on stale numbers -- it has none.
    expect(rowNeedsAttention(row({ state: "needs_relogin" }))).toBe(true);
    expect(
      rowHasWindows(
        row({ model_windows: [{ key: "Fable", window: stat(54) }] }),
      ),
    ).toBe(true);
  });

  it("captions stale numbers with their age and the resume time", () => {
    const paused = row({
      state: "cooldown",
      five_hour: stat(26),
      retry_at: "2026-08-08T13:56:00Z",
    });
    const note = staleWindowsNote(paused);
    expect(note).toContain("時点");
    expect(note).toContain("更新一時停止中");
    expect(note).toContain("に再開");
    // No known resume time: say so by omission, not by guessing one.
    const noRetry = staleWindowsNote(
      row({ state: "cooldown", five_hour: stat(26) }),
    );
    expect(noRetry).toContain("時点");
    expect(noRetry).not.toContain("に再開");
    // Healthy rows and blank cooldowns carry no caption.
    expect(staleWindowsNote(row({ five_hour: stat(26) }))).toBe("");
    expect(staleWindowsNote(row({ state: "cooldown" }))).toBe("");
  });

  it("prefers the specific error code over the generic state message", () => {
    const message = rowMessage(
      row({ state: "error", error_code: "usage.error.network" }),
    );
    expect(message).toContain("ネットワーク");
    // An unknown code must not blank the row out.
    expect(
      rowMessage(row({ state: "error", error_code: "usage.error.who_knows" })),
    ).toBe(USAGE_STATE_MESSAGE.error);
  });
});
