import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accountKey, normalizeEmail } from "../../src/lib/accountIdentity";
import {
  accountNoticeMessage,
  buildUnifiedAccounts,
  orderUnifiedAccounts,
  type BuildUnifiedAccountsInput,
  type UnifiedAccount,
} from "../../src/lib/unifiedAccounts";
import { pollPlan } from "../../src/hooks/useAccountsPolling";
import type {
  AccountUsage,
  CliAccountProfile,
  CliLiveLogin,
  CliProvider,
  UsageSummary,
  WindowStat,
} from "../../src/lib/ipc";

function stat(pct: number): WindowStat {
  return { pct, resets_at: "2026-08-08T00:00:00Z" };
}

function profile(overrides: Partial<CliAccountProfile> = {}): CliAccountProfile {
  return {
    id: "claude-a",
    provider: "claude",
    label: "A",
    email: "a@example.test",
    identity_key: "identity-a",
    plan: "pro",
    org_name: null,
    captured_at: "2026-08-08T00:00:00Z",
    last_switched_at: null,
    needs_relogin: false,
    ...overrides,
  };
}

function liveLogin(overrides: Partial<CliLiveLogin> = {}): CliLiveLogin {
  return {
    provider: "claude",
    present: true,
    email: "a@example.test",
    identity_key: "identity-a",
    plan: "pro",
    org_name: null,
    matched_profile_id: "claude-a",
    error: null,
    ...overrides,
  };
}

function usageAccount(overrides: Partial<AccountUsage> = {}): AccountUsage {
  return {
    account_id: "usage-a",
    label: "usage A",
    email: "usage@example.test",
    enabled: true,
    needs_reauth: false,
    five_hour: stat(20),
    seven_day: null,
    seven_day_sonnet: null,
    seven_day_opus: null,
    error: null,
    fetched_at: "2026-08-08T00:00:00Z",
    ...overrides,
  };
}

function summary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    claude_5h: stat(30),
    claude_7d: stat(40),
    claude_7d_sonnet: null,
    claude_7d_opus: null,
    codex_5h: null,
    codex_7d: null,
    claude_available: true,
    codex_available: false,
    claude_error: null,
    codex_error: null,
    claude_identity_key: "identity-a",
    claude_email: "a@example.test",
    codex_identity_key: null,
    codex_email: null,
    generated_at: "2026-08-08T00:00:00Z",
    ...overrides,
  };
}

function input(overrides: Partial<BuildUnifiedAccountsInput> = {}): BuildUnifiedAccountsInput {
  return {
    profiles: [profile()],
    live: [liveLogin()],
    active: { claude: "claude-a", codex: null },
    usageAccounts: [],
    summary: summary(),
    cliFetchError: null,
    usageAccountsError: null,
    summaryError: null,
    ...overrides,
  };
}

function rowForIdentity(rows: UnifiedAccount[], identityKey: string): UnifiedAccount {
  const row = rows.find((candidate) => candidate.identityKey === identityKey);
  if (!row) throw new Error(`missing row for ${identityKey}`);
  return row;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  );
}

describe("buildUnifiedAccounts invariants", () => {
  it("[1] never attributes a missing or unmatched summary identity", () => {
    for (const identity of [null, "identity-other"]) {
      const view = buildUnifiedAccounts(input({
        summary: summary({ claude_identity_key: identity }),
      }));
      const claudeRows = view.rows.filter((row) => row.provider === "claude");
      expect(claudeRows).toHaveLength(1);
      expect(claudeRows.every((row) => row.usage.source !== "cli-live")).toBe(true);
      expect(view.unattributedSummary.map((item) => item.provider)).toContain("claude");
    }

    const codexProfile = profile({
      id: "codex-a",
      provider: "codex",
      identity_key: "codex-a",
      email: "codex@example.test",
    });
    for (const identity of [null, "codex-other"]) {
      const view = buildUnifiedAccounts(input({
        profiles: [codexProfile],
        live: [liveLogin({
          provider: "codex",
          identity_key: "codex-a",
          email: "codex@example.test",
          matched_profile_id: "codex-a",
        })],
        active: { claude: null, codex: "codex-a" },
        summary: summary({
          claude_5h: null,
          claude_7d: null,
          claude_available: false,
          claude_identity_key: null,
          codex_5h: stat(55),
          codex_available: true,
          codex_identity_key: identity,
          codex_email: "codex@example.test",
        }),
      }));
      const codexRows = view.rows.filter((row) => row.provider === "codex");
      expect(codexRows).toHaveLength(1);
      expect(codexRows.every((row) => row.usage.source !== "cli-live")).toBe(true);
      expect(view.unattributedSummary.map((item) => item.provider)).toContain("codex");
    }
  });

  it("[2] preserves every profile, unregistered live login, and unlinked usage account", () => {
    const profiles = [
      profile(),
      profile({ id: "codex-a", provider: "codex", identity_key: "codex-profile", email: "c@example.test" }),
    ];
    const live = [
      liveLogin(),
      liveLogin({
        provider: "codex",
        identity_key: "codex-unregistered",
        email: "new@example.test",
        matched_profile_id: null,
      }),
    ];
    const usageAccounts = [usageAccount({ account_id: "usage-only", email: "only@example.test" })];
    const view = buildUnifiedAccounts(input({ profiles, live, usageAccounts, summary: null }));

    expect(view.rows).toHaveLength(profiles.length + 1 + usageAccounts.length);
    expect(new Set(view.rows.map((row) => row.key))).toEqual(new Set([
      "claude:id:identity-a",
      "codex:id:codex-profile",
      "codex:id:codex-unregistered",
      "claude:usage:usage-only",
    ]));
    expect(view.rows.find((row) => row.key === "codex:id:codex-unregistered")?.cli.source)
      .toBe("live");
    expect(view.rows.find((row) => row.key === "claude:usage:usage-only")).toMatchObject({
      cli: { source: "none" },
      usage: { source: "oauth-account", accountId: "usage-only" },
    });
  });

  it("[3] produces identical ordered rows for shuffled inputs", () => {
    const profiles = [
      profile({ id: "claude-b", label: "B", identity_key: "identity-b", email: "b@example.test" }),
      profile(),
      profile({ id: "codex-a", provider: "codex", label: "C", identity_key: "codex-a" }),
    ];
    const live = [
      liveLogin({ identity_key: "identity-b", email: "b@example.test", matched_profile_id: "claude-b" }),
      liveLogin({ provider: "codex", identity_key: "codex-a", matched_profile_id: "codex-a" }),
    ];
    const usageAccounts = [
      usageAccount({ account_id: "identity-a", email: "a@example.test" }),
      usageAccount({ account_id: "usage-only", email: "only@example.test" }),
    ];
    const original = structuredClone({ profiles, live, usageAccounts });
    const forward = buildUnifiedAccounts(input({ profiles, live, usageAccounts }));
    for (const profileOrder of permutations(profiles)) {
      for (const liveOrder of permutations(live)) {
        for (const usageOrder of permutations(usageAccounts)) {
          expect(buildUnifiedAccounts(input({
            profiles: profileOrder,
            live: liveOrder,
            usageAccounts: usageOrder,
          }))).toEqual(forward);
        }
      }
    }
    expect({ profiles, live, usageAccounts }).toEqual(original);
  });

  it("[4] always prefers identity linking over a conflicting email match", () => {
    const profiles = [
      profile(),
      profile({ id: "claude-b", label: "B", identity_key: "identity-b", email: "b@example.test" }),
    ];
    const account = usageAccount({ account_id: "identity-a", email: "b@example.test" });
    const view = buildUnifiedAccounts(input({ profiles, usageAccounts: [account], summary: null }));

    expect(rowForIdentity(view.rows, "identity-a").usage.source).toBe("oauth-account");
    expect(rowForIdentity(view.rows, "identity-a").linkBasis).toEqual({
      kind: "identity",
      identityKey: "identity-a",
    });
    expect(rowForIdentity(view.rows, "identity-b").usage.source).toBe("none");

    const reserved = buildUnifiedAccounts(input({
      profiles: [profile({ email: "same@example.test" })],
      usageAccounts: [
        usageAccount({ account_id: "identity-a", email: null, label: "identity usage" }),
        usageAccount({ account_id: "other", email: "same@example.test", label: "email usage" }),
      ],
      summary: null,
    }));
    expect(rowForIdentity(reserved.rows, "identity-a").usage).toMatchObject({
      source: "oauth-account",
      accountId: "identity-a",
    });
    expect(reserved.rows.find((row) => row.key === "claude:usage:other")?.usage).toMatchObject({
      source: "oauth-account",
      accountId: "other",
    });
    expect(reserved.rows).toHaveLength(2);

    const strongConflict = buildUnifiedAccounts(input({
      profiles: [
        profile({ email: "a@example.test" }),
        profile({ id: "claude-b", identity_key: "identity-b", email: "b@example.test" }),
      ],
      usageAccounts: [
        usageAccount({ account_id: "identity-a", email: "a@example.test", label: "duplicate A" }),
        usageAccount({ account_id: "identity-a", email: "b@example.test", label: "duplicate B" }),
      ],
      summary: null,
    }));
    expect(strongConflict.rows.filter((row) => row.usage.source === "oauth-account"))
      .toHaveLength(2);
    expect(strongConflict.rows.filter((row) => row.cli.source === "profile").every(
      (row) => row.usage.source === "none",
    )).toBe(true);
  });

  it("[5] refuses ambiguous email linking and emits an explicit notice", () => {
    const profiles = [
      profile({ email: "same@example.test" }),
      profile({ id: "claude-b", identity_key: "identity-b", email: "SAME@example.test" }),
    ];
    const view = buildUnifiedAccounts(input({
      profiles,
      usageAccounts: [usageAccount({ account_id: "usage-only", email: "same@example.test" })],
      summary: null,
    }));

    const profileRows = view.rows.filter((row) => row.cli.source === "profile");
    const usageOnlyRows = view.rows.filter((row) => row.cli.source === "none");
    expect(profileRows).toHaveLength(2);
    expect(profileRows.every(
      (row) => row.usage.source !== "oauth-account" && row.notices.includes("ambiguous_email"),
    )).toBe(true);
    expect(usageOnlyRows).toHaveLength(1);
    expect(usageOnlyRows[0]).toMatchObject({
      linkBasis: { kind: "none" },
      usage: { source: "oauth-account", accountId: "usage-only" },
    });
    expect(usageOnlyRows[0].notices).toEqual(["ambiguous_email", "usage_only"]);
  });

  it("[6] matches Rust ASCII-only email equality without folding non-ASCII", () => {
    expect(normalizeEmail(" USER@Example.COM ")).toBe("user@example.com");
    expect(normalizeEmail("Ä@EXAMPLE.COM")).toBe("Ä@example.com");
    expect(normalizeEmail("Ä@example.com")).not.toBe(normalizeEmail("ä@example.com"));
  });

  it("[7] never assigns an OAuth-account facet to a Codex row", () => {
    const codex = profile({
      id: "codex-a",
      provider: "codex",
      identity_key: "shared",
      email: "shared@example.test",
    });
    const view = buildUnifiedAccounts(input({
      profiles: [codex],
      live: [liveLogin({ provider: "codex", identity_key: "shared", matched_profile_id: "codex-a" })],
      active: { claude: null, codex: "codex-a" },
      usageAccounts: [usageAccount({ account_id: "shared", email: "shared@example.test" })],
      summary: null,
    }));

    const codexRows = view.rows.filter((row) => row.provider === "codex");
    expect(codexRows).toHaveLength(1);
    expect(codexRows[0].usage.source).not.toBe("oauth-account");
    expect(view.rows.find((row) => row.key === "claude:usage:shared")).toMatchObject({
      provider: "claude",
      cli: { source: "none" },
      usage: { source: "oauth-account", accountId: "shared" },
    });
  });

  it("[8] removes cli-live usage from A immediately when live identity changes to B", () => {
    const profiles = [
      profile(),
      profile({ id: "claude-b", identity_key: "identity-b", email: "b@example.test" }),
    ];
    const before = buildUnifiedAccounts(input({ profiles }));
    const after = buildUnifiedAccounts(input({
      profiles,
      live: [liveLogin({ identity_key: "identity-b", email: "b@example.test", matched_profile_id: "claude-b" })],
      active: { claude: "claude-b", codex: null },
      summary: summary({ claude_identity_key: "identity-b", claude_email: "b@example.test" }),
    }));

    expect(rowForIdentity(before.rows, "identity-a").usage.source).toBe("cli-live");
    expect(rowForIdentity(after.rows, "identity-a").usage.source).not.toBe("cli-live");
    expect(rowForIdentity(after.rows, "identity-b").usage.source).toBe("cli-live");
    expect(rowForIdentity(after.rows, "identity-a").cli).toMatchObject({ live: null });
    expect(rowForIdentity(after.rows, "identity-b").cli).toMatchObject({
      live: { identity_key: "identity-b" },
    });

    const staleSummary = buildUnifiedAccounts(input({
      profiles,
      live: [liveLogin({ identity_key: "identity-b", email: "b@example.test", matched_profile_id: "claude-b" })],
      active: { claude: "claude-b", codex: null },
      summary: summary({ claude_identity_key: "identity-a", claude_email: "a@example.test" }),
    }));
    expect(rowForIdentity(staleSummary.rows, "identity-a").usage.source).not.toBe("cli-live");
    expect(rowForIdentity(staleSummary.rows, "identity-b").usage.source).not.toBe("cli-live");
    expect(staleSummary.unattributedSummary).toMatchObject([
      { provider: "claude", identityKey: "identity-a", windows: { five_hour: { pct: 30 } } },
    ]);
  });

  it("[9] enforces 60s/180s scheduled cadence and the documented focus exception", () => {
    expect(pollPlan({ nowMs: 0, lastCliAt: null, lastUsageAt: null, trigger: "mount" }))
      .toEqual({ cli: true, usage: true });
    expect(pollPlan({ nowMs: 59_999, lastCliAt: 0, lastUsageAt: 0, trigger: "cli-interval" }))
      .toEqual({ cli: false, usage: false });
    expect(pollPlan({ nowMs: 60_000, lastCliAt: 0, lastUsageAt: 0, trigger: "cli-interval" }))
      .toEqual({ cli: true, usage: false });
    expect(pollPlan({ nowMs: 179_999, lastCliAt: 0, lastUsageAt: 0, trigger: "usage-interval" }))
      .toEqual({ cli: false, usage: false });
    expect(pollPlan({ nowMs: 180_000, lastCliAt: 0, lastUsageAt: 0, trigger: "usage-interval" }))
      .toEqual({ cli: false, usage: true });
    expect(pollPlan({ nowMs: 59_999, lastCliAt: 59_999, lastUsageAt: 0, trigger: "focus" }))
      .toEqual({ cli: true, usage: false });
    expect(pollPlan({ nowMs: 60_000, lastCliAt: 60_000, lastUsageAt: 0, trigger: "focus" }))
      .toEqual({ cli: true, usage: true });
  });

  it.each([
    ["CLI", input({
      usageAccounts: [usageAccount({ account_id: "usage-other", email: "other@example.test" })],
      cliFetchError: "failed",
    })],
    ["OAuth usage", input({ usageAccounts: [], usageAccountsError: "failed" })],
    ["summary", input({ summary: null, summaryError: "failed", usageAccounts: [usageAccount({ account_id: "identity-a" })] })],
  ])("[10] keeps the other two sources when %s is unavailable", (_source, buildInput) => {
    const view = buildUnifiedAccounts(buildInput);
    if (_source === "CLI") {
      const oauth = view.rows.find((row) => row.usage.source === "oauth-account");
      expect(oauth?.key).toBe("claude:usage:usage-other");
      expect(oauth?.usage).toMatchObject({ windows: { five_hour: { pct: 20 } } });
      expect(rowForIdentity(view.rows, "identity-a").usage).toMatchObject({
        source: "cli-live",
        windows: { five_hour: { pct: 30 } },
      });
    } else if (_source === "OAuth usage") {
      const row = rowForIdentity(view.rows, "identity-a");
      expect(row.key).toBe("claude:id:identity-a");
      expect(row.cli.source).not.toBe("none");
      expect(row.usage).toMatchObject({ source: "cli-live", windows: { five_hour: { pct: 30 } } });
    } else {
      const row = rowForIdentity(view.rows, "identity-a");
      expect(row.key).toBe("claude:id:identity-a");
      expect(row.cli.source).not.toBe("none");
      expect(row.usage).toMatchObject({ source: "oauth-account", windows: { five_hour: { pct: 20 } } });
    }
  });
});

describe("unified account public helpers", () => {
  it("keeps polling in one mounted hook with complete timer and focus cleanup", () => {
    const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
    const hook = source("src/hooks/useAccountsPolling.ts");
    const titleBar = source("src/components/layout/TitleBar.tsx");
    const usageMeter = source("src/components/layout/UsageMeter.tsx");
    const cliBadge = source("src/components/layout/CliAccountBadge.tsx");

    expect(titleBar.match(/useAccountsPolling\(\)/g)).toHaveLength(1);
    expect(usageMeter).not.toContain("setInterval");
    expect(cliBadge).not.toContain("setInterval");
    expect(cliBadge).not.toContain('addEventListener("focus"');
    expect(hook.match(/window\.setTimeout/g)).toHaveLength(2);
    expect(hook.match(/window\.clearTimeout/g)).toHaveLength(4);
    expect(hook).toContain('window.addEventListener("focus", onFocus)');
    expect(hook).toContain('window.removeEventListener("focus", onFocus)');
    expect(hook).toContain("cliInFlight.current");
    expect(hook).toContain("usageInFlight.current");
  });

  it("links a unique Claude email with an explicit estimated basis", () => {
    const view = buildUnifiedAccounts(input({
      profiles: [profile({ identity_key: "profile-id", email: " Person@Example.TEST " })],
      live: [],
      active: { claude: null, codex: null },
      usageAccounts: [usageAccount({ account_id: "usage-id", email: "person@example.test" })],
      summary: null,
    }));
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({
      linkBasis: { kind: "email", email: "person@example.test" },
      usage: { source: "oauth-account", accountId: "usage-id" },
    });
    expect(view.rows[0].notices).toContain("linked_by_email");
  });

  it("prefers identity keys and falls back to usage account ids", () => {
    expect(accountKey("claude", "identity", "usage")).toBe("claude:id:identity");
    expect(accountKey("claude", null, "usage")).toBe("claude:usage:usage");
    expect(accountKey("claude", null)).toBeNull();
  });

  it("orders by provider, attention, active state, usage, label, and key", () => {
    const makeRow = (
      key: string,
      provider: CliProvider,
      attention: boolean,
      active: boolean,
      pct: number,
      label = key,
    ): UnifiedAccount => ({
      key,
      provider,
      label,
      email: null,
      identityKey: key,
      linkBasis: { kind: "none" },
      cli: { source: "live", live: liveLogin({ provider }), active, possiblyActive: false },
      usage: {
        source: "cli-live",
        windows: { five_hour: stat(pct), seven_day: null, seven_day_sonnet: null, seven_day_opus: null },
        error: null,
        fetchedAt: "2026-08-08T00:00:00Z",
      },
      notices: [],
      attention,
    });
    const rows = [
      makeRow("codex", "codex", true, true, 100),
      makeRow("low", "claude", false, false, 10),
      makeRow("active", "claude", false, true, 5),
      makeRow("attention", "claude", true, false, 1),
      makeRow("high", "claude", false, false, 90),
      makeRow("same-b", "claude", false, false, 0, "same"),
      makeRow("same-a", "claude", false, false, 0, "same"),
      makeRow("alpha", "claude", false, false, 0, "alpha"),
    ];
    expect(orderUnifiedAccounts(rows).map((row) => row.key)).toEqual([
      "attention", "active", "high", "low", "alpha", "same-a", "same-b", "codex",
    ]);
  });

  it("returns every approved notice message exactly and hides unknown codes", () => {
    const messages = {
      linked_by_email: "メールアドレスが一致するため同じアカウントとして表示しています。",
      ambiguous_email: "同じメールアドレスの登録が複数あるため、CLI ログインと使用量を結び付けていません。",
      usage_not_registered: "使用量: 未登録。このアカウントの使用量を見るには mycmux への登録が必要です。",
      codex_no_per_account: "Codex は使用中のアカウント分しか使用量を取得できません。他のアカウントの数値は表示していません。",
      codex_not_logged_in: "使用量: 取得できません。このアカウントに切り替えると表示されます。",
      usage_only: "使用量のみ登録されています。CLI ログインとしては未登録です。",
      summary_unattributed: "使用量を取得しましたが、どのアカウントの分か特定できませんでした。",
    } as const;
    for (const [code, message] of Object.entries(messages)) {
      expect(accountNoticeMessage(code)).toBe(message);
    }
    expect(accountNoticeMessage("unknown" as never)).not.toContain("unknown");
  });
});
