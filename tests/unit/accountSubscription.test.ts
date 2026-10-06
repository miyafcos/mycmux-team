import { describe, expect, it } from "vitest";
import type { AccountSubscription, ProfileUsage } from "../../src/lib/ipc";
import {
  subscriptionCheckedLabel, subscriptionLabel, subscriptionTitle,
} from "../../src/lib/accountSubscription";

function row(subscription: AccountSubscription | null = null): ProfileUsage {
  return {
    profile_id: "test-account", provider: "claude", label: "Test",
    email: "test@example.test", plan: "pro", registered: true, is_active: true,
    needs_relogin: false, state: "ok", five_hour: null, seven_day: null,
    seven_day_sonnet: null, seven_day_opus: null, model_windows: [],
    error_code: null, retry_at: null, fetched_at: "2026-10-05T12:00:00Z", subscription,
  };
}

function info(overrides: Partial<AccountSubscription> = {}): AccountSubscription {
  return {
    plan: "pro", source: "codex_subscription", checked_at: "2026-10-05T12:00:00Z",
    started_at: "2026-09-20T12:00:00Z", renews_at: null, ends_at: null,
    will_renew: null, ...overrides,
  };
}

describe("account contract display", () => {
  it("distinguishes a renewal from paid access ending and includes the year", () => {
    const renewing = row(info({ renews_at: "2026-10-20T12:00:00Z", will_renew: true }));
    expect(subscriptionLabel(renewing)).toMatch(/^次回更新 2026\/10\/20$/);
    const ending = row(info({ ends_at: "2026-10-20T12:00:00Z", will_renew: false }));
    expect(subscriptionLabel(ending)).toMatch(/^有料期間終了 2026\/10\/20$/);
    expect(subscriptionTitle(ending)).toContain("ChatGPT 契約");
  });

  it("never substitutes contract start, usage reset, or token/ticket dates", () => {
    const claude = row(info({ source: "claude_profile" }));
    claude.five_hour = { pct: 10, resets_at: "2026-10-06T12:00:00Z" };
    expect(subscriptionLabel(claude)).toBe("契約更新日・終了日：未取得");
    expect(subscriptionTitle(claude)).toContain("契約開始:");
    expect(subscriptionTitle(claude)).not.toContain("10月6日");
  });

  it("shows unverified saved plans and rejects invalid date strings", () => {
    expect(subscriptionCheckedLabel(null)).toBe("プラン未確認");
    expect(subscriptionCheckedLabel(info({ plan: null }))).toBe("プラン未確認");
    expect(subscriptionTitle(row())).toContain("保存済み");
    expect(subscriptionLabel(row(info({ renews_at: "broken", ends_at: "broken" }))))
      .toBe("契約更新日・終了日：未取得");
    expect(subscriptionCheckedLabel(info({ checked_at: "broken" }))).toBe("プラン未確認");
  });

  it("shows an automatically verified paid-to-free change", () => {
    const free = row(info({ plan: "free", source: "claude_profile" }));
    expect(subscriptionLabel(free)).toBe("無料プラン");
    expect(subscriptionCheckedLabel(free.subscription)).toMatch(/^確認 /);
  });
});
