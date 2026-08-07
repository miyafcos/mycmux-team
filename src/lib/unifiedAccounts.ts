import type {
  AccountUsage,
  CliAccountActivePointers,
  CliAccountProfile,
  CliLiveLogin,
  CliProvider,
  UsageSummary,
} from "./ipc";
import { accountKey, normalizeEmail } from "./accountIdentity";
import {
  attentionReason,
  cliAccountProfileActivity,
  PROVIDER_ORDER,
} from "./cliAccounts";
import { worstWindow } from "./usageAccounts";

export type LinkBasis =
  | { kind: "identity"; identityKey: string }
  | { kind: "email"; email: string }
  | { kind: "none" };

export type UsageWindows = Pick<
  AccountUsage,
  "five_hour" | "seven_day" | "seven_day_sonnet" | "seven_day_opus"
>;

export type UsageFacet =
  | {
      source: "oauth-account";
      accountId: string;
      windows: UsageWindows;
      enabled: boolean;
      needsReauth: boolean;
      error: string | null;
      fetchedAt: string;
    }
  | {
      source: "cli-live";
      windows: UsageWindows;
      error: string | null;
      fetchedAt: string;
    }
  | {
      source: "none";
      reason: "not-registered" | "provider-unsupported" | "not-logged-in" | "disabled";
    };

export type CliFacet =
  | {
      source: "profile";
      profile: CliAccountProfile;
      live: CliLiveLogin | null;
      active: boolean;
      possiblyActive: boolean;
    }
  | {
      source: "live";
      live: CliLiveLogin;
      active: boolean;
      possiblyActive: boolean;
    }
  | { source: "none" };

export type AccountNoticeCode =
  | "linked_by_email"
  | "ambiguous_email"
  | "usage_not_registered"
  | "codex_no_per_account"
  | "codex_not_logged_in"
  | "usage_only"
  | "summary_unattributed";

export interface UnifiedAccount {
  key: string;
  provider: CliProvider;
  label: string;
  email: string | null;
  identityKey: string | null;
  linkBasis: LinkBasis;
  cli: CliFacet;
  usage: UsageFacet;
  notices: AccountNoticeCode[];
  attention: boolean;
}

export interface UnattributedSummary {
  provider: CliProvider;
  identityKey: string | null;
  email: string | null;
  windows: UsageWindows;
  error: string | null;
  generatedAt: string;
}

export interface UnifiedAccountsView {
  rows: UnifiedAccount[];
  unattributedSummary: UnattributedSummary[];
  attentionMessage: string | null;
}

export interface BuildUnifiedAccountsInput {
  profiles: CliAccountProfile[];
  live: CliLiveLogin[];
  active: CliAccountActivePointers;
  usageAccounts: AccountUsage[];
  summary: UsageSummary | null;
  cliFetchError?: string | null;
  usageAccountsError?: string | null;
  summaryError?: string | null;
}

const ACCOUNT_NOTICE_MESSAGES: Record<AccountNoticeCode, string> = {
  linked_by_email: "メールアドレスが一致するため同じアカウントとして表示しています。",
  ambiguous_email:
    "同じメールアドレスの登録が複数あるため、CLI ログインと使用量を結び付けていません。",
  usage_not_registered:
    "使用量: 未登録。このアカウントの使用量を見るには mycmux への登録が必要です。",
  codex_no_per_account:
    "Codex は使用中のアカウント分しか使用量を取得できません。他のアカウントの数値は表示していません。",
  codex_not_logged_in: "使用量: 取得できません。このアカウントに切り替えると表示されます。",
  usage_only: "使用量のみ登録されています。CLI ログインとしては未登録です。",
  summary_unattributed: "使用量を取得しましたが、どのアカウントの分か特定できませんでした。",
};

export function accountNoticeMessage(code: unknown): string {
  const key = typeof code === "string" ? code as AccountNoticeCode : null;
  return (key ? ACCOUNT_NOTICE_MESSAGES[key] : undefined) ?? "アカウント情報を確認できませんでした。";
}

function windowsFromAccount(account: AccountUsage): UsageWindows {
  return {
    five_hour: account.five_hour,
    seven_day: account.seven_day,
    seven_day_sonnet: account.seven_day_sonnet,
    seven_day_opus: account.seven_day_opus,
  };
}

function summaryDetails(summary: UsageSummary, provider: CliProvider): UnattributedSummary {
  if (provider === "claude") {
    return {
      provider,
      identityKey: summary.claude_identity_key ?? null,
      email: summary.claude_email ?? null,
      windows: {
        five_hour: summary.claude_5h,
        seven_day: summary.claude_7d,
        seven_day_sonnet: summary.claude_7d_sonnet,
        seven_day_opus: summary.claude_7d_opus,
      },
      error: summary.claude_error,
      generatedAt: summary.generated_at,
    };
  }
  return {
    provider,
    identityKey: summary.codex_identity_key ?? null,
    email: summary.codex_email ?? null,
    windows: {
      five_hour: summary.codex_5h,
      seven_day: summary.codex_7d,
      seven_day_sonnet: null,
      seven_day_opus: null,
    },
    error: summary.codex_error,
    generatedAt: summary.generated_at,
  };
}

function hasSummaryData(summary: UsageSummary, details: UnattributedSummary): boolean {
  const available = details.provider === "claude" ? summary.claude_available : summary.codex_available;
  return available || details.error !== null || Object.values(details.windows).some((value) => value !== null);
}

function usageFacetFromAccount(account: AccountUsage): UsageFacet {
  return {
    source: "oauth-account",
    accountId: account.account_id,
    windows: windowsFromAccount(account),
    enabled: account.enabled,
    needsReauth: account.needs_reauth,
    error: account.error,
    fetchedAt: account.fetched_at,
  };
}

function usageAsAccount(row: UnifiedAccount): AccountUsage {
  const windows = row.usage.source === "none"
    ? { five_hour: null, seven_day: null, seven_day_sonnet: null, seven_day_opus: null }
    : row.usage.windows;
  return {
    account_id: row.key,
    label: row.label,
    email: row.email,
    enabled: true,
    needs_reauth: row.usage.source === "oauth-account" && row.usage.needsReauth,
    ...windows,
    error: row.usage.source === "none" ? null : row.usage.error,
    fetched_at: row.usage.source === "none" ? "" : row.usage.fetchedAt,
  };
}

function addNotice(row: UnifiedAccount, notice: AccountNoticeCode): void {
  if (!row.notices.includes(notice)) row.notices.push(notice);
}

function rowIsActive(row: UnifiedAccount): boolean {
  return row.cli.source !== "none" && row.cli.active;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function usageCanonicalKey(account: AccountUsage): string {
  return JSON.stringify([
    account.account_id,
    account.label,
    account.email,
    account.enabled,
    account.needs_reauth,
    account.five_hour?.pct ?? null,
    account.five_hour?.resets_at ?? null,
    account.seven_day?.pct ?? null,
    account.seven_day?.resets_at ?? null,
    account.seven_day_sonnet?.pct ?? null,
    account.seven_day_sonnet?.resets_at ?? null,
    account.seven_day_opus?.pct ?? null,
    account.seven_day_opus?.resets_at ?? null,
    account.error,
    account.fetched_at,
  ]);
}

export function orderUnifiedAccounts(rows: UnifiedAccount[]): UnifiedAccount[] {
  return rows.slice().sort((left, right) => {
    const providerOrder = PROVIDER_ORDER.indexOf(left.provider) - PROVIDER_ORDER.indexOf(right.provider);
    if (providerOrder !== 0) return providerOrder;
    if (left.attention !== right.attention) return left.attention ? -1 : 1;
    if (rowIsActive(left) !== rowIsActive(right)) return rowIsActive(left) ? -1 : 1;
    const leftPct = worstWindow(usageAsAccount(left))?.pct ?? -1;
    const rightPct = worstWindow(usageAsAccount(right))?.pct ?? -1;
    if (leftPct !== rightPct) return rightPct - leftPct;
    const labelOrder = compareText(left.label, right.label);
    return labelOrder !== 0 ? labelOrder : compareText(left.key, right.key);
  });
}

export function buildUnifiedAccounts(input: BuildUnifiedAccountsInput): UnifiedAccountsView {
  const rows: UnifiedAccount[] = [];
  const liveByProvider = new Map<CliProvider, CliLiveLogin | undefined>();
  for (const provider of PROVIDER_ORDER) {
    const providerLive = input.live.filter((entry) => entry.provider === provider);
    liveByProvider.set(provider, providerLive.length === 1 ? providerLive[0] : undefined);
  }

  const profileIdentityCounts = new Map<string, number>();
  for (const profile of input.profiles) {
    const key = accountKey(profile.provider, profile.identity_key)!;
    profileIdentityCounts.set(key, (profileIdentityCounts.get(key) ?? 0) + 1);
  }

  for (const profile of input.profiles.slice().sort((a, b) => compareText(a.id, b.id))) {
    const providerLive = liveByProvider.get(profile.provider);
    const activity = cliAccountProfileActivity(
      input.active[profile.provider],
      profile.id,
      providerLive,
      input.cliFetchError ?? null,
    );
    const identityKey = accountKey(profile.provider, profile.identity_key);
    const rowKey = identityKey && profileIdentityCounts.get(identityKey) === 1
      ? identityKey
      : `${identityKey ?? `${profile.provider}:profile`}:profile:${profile.id}`;
    rows.push({
      key: rowKey,
      provider: profile.provider,
      label: profile.label,
      email: profile.email,
      identityKey: profile.identity_key,
      linkBasis: { kind: "none" },
      cli: { source: "profile", profile, live: null, ...activity },
      usage: {
        source: "none",
        reason: profile.provider === "codex" ? "not-logged-in" : "not-registered",
      },
      notices: [],
      attention: profile.needs_relogin,
    });
  }

  for (const provider of PROVIDER_ORDER) {
    const live = liveByProvider.get(provider);
    if (!live?.present) continue;
    const matches = live.identity_key
      ? rows.filter((row) => row.provider === provider && row.identityKey === live.identity_key)
      : [];
    if (matches.length === 1 && matches[0].cli.source === "profile") {
      matches[0].cli.live = live;
      matches[0].linkBasis = { kind: "identity", identityKey: live.identity_key! };
      matches[0].attention ||= live.error !== null;
      continue;
    }

    rows.push({
      key: matches.length === 0
        ? accountKey(provider, live.identity_key) ?? `${provider}:live`
        : `${accountKey(provider, live.identity_key) ?? provider}:live`,
      provider,
      label: live.email?.split("@")[0] || "未登録",
      email: live.email,
      identityKey: live.identity_key,
      linkBasis: live.identity_key
        ? { kind: "identity", identityKey: live.identity_key }
        : { kind: "none" },
      cli: { source: "live", live, active: live.error === null, possiblyActive: false },
      usage: {
        source: "none",
        reason: provider === "codex" ? "provider-unsupported" : "not-registered",
      },
      notices: [],
      attention: live.error !== null,
    });
  }

  const sortedUsage = input.usageAccounts.slice().sort((left, right) => {
    const idOrder = compareText(left.account_id, right.account_id);
    if (idOrder !== 0) return idOrder;
    const emailOrder = compareText(normalizeEmail(left.email) ?? "", normalizeEmail(right.email) ?? "");
    if (emailOrder !== 0) return emailOrder;
    const labelOrder = compareText(left.label, right.label);
    return labelOrder !== 0
      ? labelOrder
      : compareText(usageCanonicalKey(left), usageCanonicalKey(right));
  });
  const usageAccountIdCounts = new Map<string, number>();
  for (const account of sortedUsage) {
    usageAccountIdCounts.set(
      account.account_id,
      (usageAccountIdCounts.get(account.account_id) ?? 0) + 1,
    );
  }
  const linkedUsage = new Set<AccountUsage>();

  for (const account of sortedUsage) {
    const identityMatches = rows.filter(
      (row) => row.provider === "claude" && row.identityKey === account.account_id,
    );
    if (
      usageAccountIdCounts.get(account.account_id) === 1 &&
      identityMatches.length === 1 &&
      identityMatches[0].usage.source === "none"
    ) {
      const row = identityMatches[0];
      row.usage = usageFacetFromAccount(account);
      row.linkBasis = { kind: "identity", identityKey: account.account_id };
      row.attention ||= account.needs_reauth || account.error !== null;
      linkedUsage.add(account);
    }
  }

  const remainingUsage = sortedUsage.filter((account) => !linkedUsage.has(account));
  const emailEligibleUsage = new Set<AccountUsage>();
  const usageEmailCounts = new Map<string, number>();
  for (const account of remainingUsage) {
    const identityMatches = rows.filter(
      (row) => row.provider === "claude" && row.identityKey === account.account_id,
    );
    if (usageAccountIdCounts.get(account.account_id) !== 1 || identityMatches.length !== 0) {
      continue;
    }
    emailEligibleUsage.add(account);
    const normalizedEmail = normalizeEmail(account.email);
    if (normalizedEmail) {
      usageEmailCounts.set(normalizedEmail, (usageEmailCounts.get(normalizedEmail) ?? 0) + 1);
    }
  }

  for (const account of remainingUsage) {
    if (!emailEligibleUsage.has(account)) continue;
    const normalizedEmail = normalizeEmail(account.email);
    const emailMatches = normalizedEmail
      ? rows.filter(
          (row) =>
            row.provider === "claude" &&
            row.usage.source === "none" &&
            normalizeEmail(row.email) === normalizedEmail,
        )
      : [];
    if (normalizedEmail && usageEmailCounts.get(normalizedEmail) === 1 && emailMatches.length === 1) {
      const row = emailMatches[0];
      row.usage = usageFacetFromAccount(account);
      row.linkBasis = { kind: "email", email: normalizedEmail };
      addNotice(row, "linked_by_email");
      row.attention ||= account.needs_reauth || account.error !== null;
      linkedUsage.add(account);
    }
  }

  const usageOnlyKeyCounts = new Map<string, number>();
  for (const account of sortedUsage.filter((candidate) => !linkedUsage.has(candidate))) {
    const normalizedEmail = normalizeEmail(account.email);
    const emailMatches = normalizedEmail
      ? rows.filter(
          (row) =>
            row.provider === "claude" &&
            row.usage.source === "none" &&
            normalizeEmail(row.email) === normalizedEmail,
        )
      : [];
    const ambiguous = emailEligibleUsage.has(account) && Boolean(
      normalizedEmail && (usageEmailCounts.get(normalizedEmail)! > 1 || emailMatches.length > 1),
    );
    if (ambiguous) emailMatches.forEach((row) => addNotice(row, "ambiguous_email"));
    const baseKey = accountKey("claude", null, account.account_id)!;
    const keyIndex = usageOnlyKeyCounts.get(baseKey) ?? 0;
    usageOnlyKeyCounts.set(baseKey, keyIndex + 1);
    rows.push({
      key: usageAccountIdCounts.get(account.account_id) === 1 ? baseKey : `${baseKey}:${keyIndex + 1}`,
      provider: "claude",
      label: account.label,
      email: account.email,
      identityKey: null,
      linkBasis: { kind: "none" },
      cli: { source: "none" },
      usage: usageFacetFromAccount(account),
      notices: ambiguous ? ["ambiguous_email", "usage_only"] : ["usage_only"],
      attention: account.needs_reauth || account.error !== null,
    });
  }

  const unattributedSummary: UnattributedSummary[] = [];
  if (input.summary) {
    for (const provider of PROVIDER_ORDER) {
      const details = summaryDetails(input.summary, provider);
      if (!hasSummaryData(input.summary, details)) continue;
      const currentLive = liveByProvider.get(provider);
      const liveMatchesSummary = input.cliFetchError
        ? true
        : currentLive?.present === true &&
          currentLive.error === null &&
          currentLive.identity_key !== null &&
          currentLive.identity_key === details.identityKey;
      const matches = details.identityKey
        ? rows.filter((row) => row.provider === provider && row.identityKey === details.identityKey)
        : [];
      if (liveMatchesSummary && matches.length === 1) {
        const row = matches[0];
        if (row.usage.source !== "oauth-account") {
          row.usage = {
            source: "cli-live",
            windows: details.windows,
            error: details.error,
            fetchedAt: details.generatedAt,
          };
          row.linkBasis = { kind: "identity", identityKey: details.identityKey! };
        }
      } else {
        unattributedSummary.push(details);
      }
    }
  }

  for (const row of rows) {
    if (row.provider === "codex") {
      addNotice(row, rowIsActive(row) ? "codex_no_per_account" : "codex_not_logged_in");
    } else if (
      row.usage.source === "none" &&
      row.cli.source !== "none" &&
      !row.notices.includes("ambiguous_email")
    ) {
      addNotice(row, "usage_not_registered");
    }
  }

  const attentionMessage = attentionReason(
    input.live,
    input.profiles,
    input.cliFetchError ?? null,
  );
  return {
    rows: orderUnifiedAccounts(rows),
    unattributedSummary: unattributedSummary.sort(
      (left, right) => PROVIDER_ORDER.indexOf(left.provider) - PROVIDER_ORDER.indexOf(right.provider),
    ),
    attentionMessage,
  };
}
