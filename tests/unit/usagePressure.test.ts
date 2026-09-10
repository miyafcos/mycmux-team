import { describe, expect, it } from "vitest";

import {
  USAGE_ATTENTION_PCT,
  USAGE_DANGER_PCT,
  rowIsPressed,
  usageBarColor,
  worstWindowPct,
} from "../../src/lib/accountRows";
import type { WindowStat } from "../../src/lib/ipc";

// The title bar used to spell out every account at all times, which read as
// "CC miy2 — · CX miy1 7d ▮▮▮ 100% · GK tari — ●" and buried the single figure
// that mattered. What the operator actually watches for is a window running
// out, so an account with room to spare now gets a short line and only a
// pressed one gets its name and bar back. These pin where that line sits.

function stat(pct: number): WindowStat {
  return { pct, used: pct, limit: 100, resets_at: null } as unknown as WindowStat;
}

function row(state: string, fiveHour: number | null, sevenDay: number | null) {
  return {
    state,
    five_hour: fiveHour === null ? null : stat(fiveHour),
    seven_day: sevenDay === null ? null : stat(sevenDay),
  };
}

describe("worstWindowPct", () => {
  it("reports the tighter of the two windows", () => {
    expect(worstWindowPct(row("ok", 12, 88))).toBe(88);
    expect(worstWindowPct(row("ok", 91, 40))).toBe(91);
  });

  it("counts a cooldown row, which still holds its last good numbers", () => {
    expect(worstWindowPct(row("cooldown", 82, null))).toBe(82);
  });

  it("reports nothing for a row that has no usable numbers", () => {
    expect(worstWindowPct(row("error", 90, 90))).toBeNull();
    expect(worstWindowPct(row("ok", null, null))).toBeNull();
  });
});

describe("rowIsPressed", () => {
  it("is quiet below the attention threshold", () => {
    expect(rowIsPressed(row("ok", 12, 79))).toBe(false);
  });

  it("speaks up at the threshold", () => {
    expect(rowIsPressed(row("ok", 0, USAGE_ATTENTION_PCT))).toBe(true);
  });

  it("speaks up for a full window", () => {
    // The state the Codex account was in when this was written.
    expect(rowIsPressed(row("ok", null, 100))).toBe(true);
  });

  it("stays quiet when there is nothing to report", () => {
    // No numbers is not the same as no room. A row that failed to fetch must
    // not shout; it has nothing to shout about.
    expect(rowIsPressed(row("error", null, null))).toBe(false);
    expect(rowIsPressed(undefined)).toBe(false);
  });
});

describe("usageBarColor", () => {
  it("uses the same thresholds the chip does", () => {
    // Colour and detail have to agree: a bar going amber while the chip stays
    // in its short form would say two different things about one account.
    expect(usageBarColor(USAGE_ATTENTION_PCT - 1)).toContain("usage-ok");
    expect(usageBarColor(USAGE_ATTENTION_PCT)).toContain("usage-warn");
    expect(usageBarColor(USAGE_DANGER_PCT)).toContain("usage-danger");
  });
});
