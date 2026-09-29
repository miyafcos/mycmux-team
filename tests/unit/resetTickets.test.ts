import { describe, expect, it } from "vitest";
import type { ProfileUsage } from "../../src/lib/ipc";
import {
  resetTicketBlockedMessage,
  resetTicketChipLabel,
  resetTicketChipTitle,
  resetTicketConfirm,
  resetTicketHeaderLabel,
  resetTicketInvokeErrorMessage,
  resetTicketOutcomeMessage,
  resetTicketTotals,
  visibleResetTickets,
  type ResetTicketOutcome,
  type ResetTicketOutcomeKind,
  type ResetTickets,
} from "../../src/lib/resetTickets";

const TOKYO = { timeZone: "Asia/Tokyo" };

// The grant every Pro/Max account got at the Opus 5.5 launch (read from the
// API on 2026-09-28): usable before a limit, refills the session and weekly
// windows, ends 2026-10-23 01:00 JST.
const claudeTickets: ResetTickets = {
  available: 1,
  expires_at: "2026-10-22T16:00:00+00:00",
  usable_now: true,
  blocked_reason: null,
  clears: ["five_hour", "seven_day", "seven_day_overage_included"],
  moves_weekly_reset: false,
  requires_limit: false,
  title: "Claude Opus 5.5 launch: one usage-limit reset for Pro and Max",
};

const codexTickets: ResetTickets = {
  available: 1,
  expires_at: "2026-10-22T20:46:05.210547Z",
  usable_now: true,
  blocked_reason: null,
  clears: ["five_hour", "seven_day"],
  moves_weekly_reset: true,
  requires_limit: false,
  title: "Full reset",
};

function row(overrides: Partial<ProfileUsage> = {}): ProfileUsage {
  return {
    profile_id: "claude-1",
    provider: "claude",
    label: "duo",
    email: "cc-user@example.test",
    plan: "max",
    registered: true,
    is_active: false,
    needs_relogin: false,
    state: "ok",
    five_hour: { pct: 25, resets_at: "2026-09-28T07:20:00+00:00" },
    seven_day: { pct: 86, resets_at: "2026-10-02T23:00:00+00:00" },
    seven_day_sonnet: null,
    seven_day_opus: null,
    model_windows: [],
    error_code: null,
    retry_at: null,
    fetched_at: "2026-09-28T02:33:00+00:00",
    ...overrides,
  };
}

describe("which tickets a row shows", () => {
  it("shows nothing when the poll did not report tickets or none are left", () => {
    expect(visibleResetTickets({})).toBeNull();
    expect(visibleResetTickets({ reset_tickets: null })).toBeNull();
    expect(visibleResetTickets({ reset_tickets: { ...claudeTickets, available: 0 } })).toBeNull();
    expect(visibleResetTickets({ reset_tickets: claudeTickets })).toBe(claudeTickets);
  });

  it("totals the tickets per provider for the header and drops empty providers", () => {
    const totals = resetTicketTotals([
      { provider: "claude", reset_tickets: claudeTickets },
      { provider: "claude", reset_tickets: { ...claudeTickets, available: 2 } },
      { provider: "claude", reset_tickets: { ...claudeTickets, available: 0 } },
      { provider: "codex", reset_tickets: codexTickets },
      { provider: "grok", reset_tickets: null },
    ]);
    expect(totals).toEqual({ claude: 3, codex: 1, grok: 0 });
    expect(resetTicketHeaderLabel(totals)).toBe("券 CC 3 · CX 1");
    expect(resetTicketHeaderLabel({ claude: 0, codex: 5, grok: 0 })).toBe("券 CX 5");
    expect(resetTicketHeaderLabel({ claude: 0, codex: 0, grok: 0 })).toBeNull();
  });
});

describe("the chip", () => {
  it("reads as the count and the soonest expiry day", () => {
    expect(resetTicketChipLabel(claudeTickets, TOKYO)).toBe("券1 10/23");
    expect(resetTicketChipLabel({ ...claudeTickets, expires_at: null }, TOKYO)).toBe("券1");
    expect(resetTicketChipLabel({ ...claudeTickets, expires_at: "not a date" }, TOKYO)).toBe("券1");
  });

  it("spells out the expiry and what pressing it does", () => {
    expect(resetTicketChipTitle(claudeTickets, TOKYO)).toBe(
      "リセット券 1 枚 · 10/23 01:00 まで · 押すと、使う前に確認します",
    );
    expect(
      resetTicketChipTitle(
        { ...claudeTickets, usable_now: false, blocked_reason: "requires_limit" },
        TOKYO,
      ),
    ).toBe("リセット券 1 枚 · 10/23 01:00 まで · いまは使えません (上限に達したときだけ使える券)");
  });

  it("explains a blocked ticket instead of offering it", () => {
    expect(
      resetTicketBlockedMessage(row(), { ...claudeTickets, usable_now: false, blocked_reason: "cooldown" }),
    ).toEqual({
      tone: "warn",
      text: "CC cc-user@example.test のリセット券は、いまは使えません。直前のリセットを処理中です。少し待ってから使えます。",
    });
    // An unknown reason still says something rather than nothing.
    expect(
      resetTicketBlockedMessage(row(), { ...claudeTickets, usable_now: false, blocked_reason: null }).text,
    ).toContain("サーバーがいまは受け付けない状態です。");
  });
});

describe("the confirm dialog", () => {
  it("tells a Claude user the weekly reset day stays and warns about unused room", () => {
    const confirm = resetTicketConfirm(row(), claudeTickets, TOKYO);
    expect(confirm.title).toBe("リセット券を使う");
    expect(confirm.okLabel).toBe("使う");
    expect(confirm.cancelLabel).toBe("やめる");
    expect(confirm.message.split("\n")).toEqual([
      "CC cc-user@example.test",
      "",
      "5 時間枠と週の枠の使用率を 0% に戻します。",
      "いまの使用率: 5h 25% · 7d 86%",
      "週のリセット日時 (10/3 08:00) は変わりません。",
      "まだ上限に達していません。いま使うと、枠に残っている分は無駄になります。",
      "",
      "残り 1 枚 → 0 枚 (10/23 01:00 まで)",
    ]);
  });

  it("tells a Codex user the weekly reset moves and that nothing is spent when nothing resets", () => {
    const codexRow = row({
      provider: "codex",
      email: "cx-user@example.test",
      five_hour: null,
      seven_day: { pct: 59, resets_at: "2026-10-02T15:15:01+00:00" },
    });
    expect(resetTicketConfirm(codexRow, codexTickets, TOKYO).message.split("\n")).toEqual([
      "CX cx-user@example.test",
      "",
      "5 時間枠と週の枠の使用率を 0% に戻します。",
      "いまの使用率: 7d 59%",
      "週のリセット日時が変わります。次の週リセットは、このあと最初に Codex を使った時点から 7 日後になり、元の 10/3 00:15 のリセットは来ません。",
      "まだ上限に達していません。いま使うと、枠に残っている分は無駄になります。",
      "戻す使用量がないときは、券は使われずに残ります。",
      "",
      "残り 1 枚 → 0 枚 (10/23 05:46 まで)",
    ]);
  });

  it("drops the early-use warning at a limit and copes with unknown dates", () => {
    const atLimit = row({
      five_hour: { pct: 0, resets_at: "" },
      seven_day: { pct: 100, resets_at: "" },
    });
    const lines = resetTicketConfirm(atLimit, { ...claudeTickets, available: 2, expires_at: null }, TOKYO)
      .message.split("\n");
    expect(lines).toContain("週のリセット日時は変わりません。");
    expect(lines.some((line) => line.startsWith("まだ上限に達していません"))).toBe(false);
    expect(lines[lines.length - 1]).toBe("残り 2 枚 → 1 枚");
  });

  it("names only the windows a ticket refills", () => {
    const weeklyOnly = resetTicketConfirm(row(), { ...claudeTickets, clears: ["seven_day"] }, TOKYO);
    expect(weeklyOnly.message).toContain("週の枠の使用率を 0% に戻します。");
    const withModel = resetTicketConfirm(
      row(),
      { ...claudeTickets, clears: ["five_hour", "seven_day", "seven_day_opus"] },
      TOKYO,
    );
    expect(withModel.message).toContain("5 時間枠、週の枠とOpus の週の枠の使用率を 0% に戻します。");
    const unknown = resetTicketConfirm(row(), { ...claudeTickets, clears: ["seven_day_cowork"] }, TOKYO);
    expect(unknown.message).toContain("使用枠の使用率を 0% に戻します。");
  });
});

describe("after the command answers", () => {
  const outcome = (kind: ResetTicketOutcomeKind, extra: Partial<ResetTicketOutcome> = {}): ResetTicketOutcome => ({
    kind,
    resets_left: null,
    weekly_resets_at: null,
    ...extra,
  });

  it("confirms a reset with what is left", () => {
    expect(resetTicketOutcomeMessage(row(), claudeTickets, outcome("reset", { resets_left: 0 }))).toEqual({
      tone: "ok",
      text: "CC cc-user@example.test のリセット券を使いました。残り 0 枚。使用量を取り直しています。",
    });
    expect(
      resetTicketOutcomeMessage(row({ provider: "codex" }), codexTickets, outcome("reset")).text,
    ).toBe(
      "CX cc-user@example.test のリセット券を使いました。週のリセット日時は、次に Codex を使った時点から 7 日後になります。使用量を取り直しています。",
    );
  });

  it("says nothing was spent whenever that is certain", () => {
    for (const kind of [
      "no_ticket",
      "cooldown",
      "rate_limited",
      "auth_error",
      "token_stale",
      "unavailable",
    ] as const) {
      expect(resetTicketOutcomeMessage(row(), claudeTickets, outcome(kind)).text).toContain("何も使われていません");
    }
    expect(resetTicketOutcomeMessage(row(), claudeTickets, outcome("nothing_to_reset")).text).toContain(
      "券は使われませんでした",
    );
    expect(resetTicketOutcomeMessage(row(), claudeTickets, outcome("owner_mismatch")).text).toContain(
      "使いませんでした",
    );
  });

  it("never claims nothing was spent when the result is unknown", () => {
    const text = resetTicketOutcomeMessage(row(), claudeTickets, outcome("unconfirmed")).text;
    expect(text).not.toContain("何も使われていません");
    // The backend re-sends the same request only within 10 minutes of the first
    // try, so the line promises no more than that.
    expect(text).toContain("10 分以内にもう一度押してください (同じ要求として送り直します)");
    expect(text).not.toContain("二重には使われません");
  });

  it("says a changed offer spent nothing on this press, and leaves the earlier one to the meters", () => {
    expect(resetTicketOutcomeMessage(row(), claudeTickets, outcome("offer_changed"))).toEqual({
      tone: "warn",
      text: "CC cc-user@example.test で使える券が入れ替わっていたため、今回は何も使っていません。使用量を取り直しています。",
    });
    const retry = resetTicketOutcomeMessage(
      row(),
      claudeTickets,
      outcome("offer_changed", { retry_of_unconfirmed: true }),
    );
    expect(retry.tone).toBe("warn");
    expect(retry.text).toContain("前回の操作が通ったかは、取り直した使用量で確かめてください。");
    expect(retry.text).not.toContain("通っていたようです");
  });

  it("points an expired active token at the CLI and an idle one at the next poll", () => {
    expect(resetTicketOutcomeMessage(row({ is_active: true }), claudeTickets, outcome("token_stale")).text).toContain(
      "使用中の CLI がトークンを更新してから",
    );
    expect(resetTicketOutcomeMessage(row(), claudeTickets, outcome("token_stale")).text).toContain(
      "使用量の更新でトークンが新しくなってから",
    );
  });

  it("colours only a definite success as ok", () => {
    const tones = (
      [
        "reset",
        "already_used",
        "nothing_to_reset",
        "no_ticket",
        "cooldown",
        "rate_limited",
        "auth_error",
        "token_stale",
        "owner_mismatch",
        "unconfirmed",
        "unavailable",
        "offer_changed",
        "busy",
      ] as const
    ).map((kind) => [kind, resetTicketOutcomeMessage(row(), claudeTickets, outcome(kind)).tone]);
    expect(tones.filter(([, tone]) => tone === "ok").map(([kind]) => kind)).toEqual(["reset"]);
  });

  it("stops promising that nothing was used once an earlier press is unconfirmed", () => {
    const retry = (kind: ResetTicketOutcomeKind) =>
      resetTicketOutcomeMessage(row(), claudeTickets, outcome(kind, { retry_of_unconfirmed: true }));
    for (const kind of ["no_ticket", "cooldown", "rate_limited", "auth_error", "token_stale", "unavailable"] as const) {
      expect(retry(kind).text).not.toContain("何も使われていません");
    }
    for (const kind of ["rate_limited", "auth_error", "token_stale", "unavailable"] as const) {
      expect(retry(kind).text).toContain("前回の操作が通ったかは、まだ分かりません。");
    }
    expect(retry("already_used")).toEqual({
      tone: "ok",
      text: "CC cc-user@example.test の前回の操作は通っていたようです。使用量を取り直しています。",
    });
    expect(retry("nothing_to_reset").tone).toBe("ok");
    expect(retry("no_ticket").text).toContain("前回の操作で使われた可能性があります");
    expect(retry("cooldown").text).toContain("前回の操作がまだ処理中かもしれません");
  });

  it("keeps the ordinary lines for kinds a retry does not change", () => {
    for (const kind of ["reset", "unconfirmed", "owner_mismatch", "busy"] as const) {
      expect(
        resetTicketOutcomeMessage(row(), claudeTickets, outcome(kind, { retry_of_unconfirmed: true })),
      ).toEqual(resetTicketOutcomeMessage(row(), claudeTickets, outcome(kind)));
    }
  });

  it("reports a rejected call with its detail", () => {
    expect(resetTicketInvokeErrorMessage(row(), new Error("profile not found"))).toEqual({
      tone: "error",
      text: "CC cc-user@example.test のリセット券を使えませんでした (profile not found)。",
    });
  });
});
