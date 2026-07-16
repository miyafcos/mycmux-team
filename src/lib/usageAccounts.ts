// Pure, framework-independent logic for the multi-account usage UI.
// Kept free of React so it can be unit tested directly (tests/unit/usageAccounts.test.ts).

import type { AccountUsage, WindowStat } from "./ipc";

export type MeterMode = "full" | "compact" | "hidden";

/**
 * The usage window with the highest pct among an account's four tracked
 * windows (5h, 7d, 7d Sonnet, 7d Opus). Returns null when the account has
 * no window data at all.
 */
export function worstWindow(account: AccountUsage): WindowStat | null {
  const windows = [
    account.five_hour,
    account.seven_day,
    account.seven_day_sonnet,
    account.seven_day_opus,
  ].filter((stat): stat is WindowStat => stat !== null);

  if (windows.length === 0) {
    return null;
  }

  return windows.reduce((worst, current) => (current.pct > worst.pct ? current : worst));
}

function hasNoWindowData(account: AccountUsage): boolean {
  return (
    account.five_hour === null &&
    account.seven_day === null &&
    account.seven_day_sonnet === null &&
    account.seven_day_opus === null
  );
}

/**
 * Sort key used to rank accounts from most attention-needed to least:
 * needs_reauth accounts always sort first (Infinity), accounts erroring out
 * with no window data sort next (200, above any legitimate pct), accounts
 * with window data sort by their worst pct, and accounts with neither data
 * nor an error sort last (-1).
 */
export function accountSortKey(account: AccountUsage): number {
  if (account.needs_reauth) {
    return Infinity;
  }
  if (account.error !== null && hasNoWindowData(account)) {
    return 200;
  }
  const worst = worstWindow(account);
  if (worst !== null) {
    return worst.pct;
  }
  return -1;
}

/**
 * Enabled accounts only, ranked by accountSortKey descending, tie-broken by
 * label ascending for a stable, deterministic order.
 */
export function orderAccounts(accounts: AccountUsage[]): AccountUsage[] {
  return accounts
    .filter((account) => account.enabled)
    .slice()
    .sort((a, b) => {
      const keyA = accountSortKey(a);
      const keyB = accountSortKey(b);
      if (keyA !== keyB) {
        return keyB - keyA;
      }
      return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
    });
}

export interface CapVisibleResult<T> {
  visible: T[];
  overflow: number;
}

/** Splits a list into the first `max` visible items and an overflow count. */
export function capVisible<T>(items: T[], max: number): CapVisibleResult<T> {
  if (items.length <= max) {
    return { visible: items, overflow: 0 };
  }
  return { visible: items.slice(0, max), overflow: items.length - max };
}

function shortLabelBase(label: string): string {
  const at = label.indexOf("@");
  const source = at > 0 ? label.slice(0, at) : label;
  return source.slice(0, 4);
}

/**
 * Builds short (~4 char) chip labels for accounts, keyed by account_id.
 * If an account's label looks like an email address, the local part (before
 * "@") is used as the source text; otherwise the label itself is used.
 * Collisions among accounts sharing the same 4-char base are resolved
 * deterministically (by account_id ascending) into `<3-char prefix><index>`
 * starting at 1.
 */
export function buildChipLabels(accounts: AccountUsage[]): Map<string, string> {
  const sorted = accounts
    .slice()
    .sort((a, b) => (a.account_id < b.account_id ? -1 : a.account_id > b.account_id ? 1 : 0));

  const groups = new Map<string, AccountUsage[]>();
  for (const account of sorted) {
    const base = shortLabelBase(account.label);
    const group = groups.get(base);
    if (group) {
      group.push(account);
    } else {
      groups.set(base, [account]);
    }
  }

  const result = new Map<string, string>();
  for (const [base, group] of groups) {
    if (group.length === 1) {
      result.set(group[0].account_id, base);
    } else {
      group.forEach((account, index) => {
        result.set(account.account_id, `${base.slice(0, 3)}${index + 1}`);
      });
    }
  }
  return result;
}

/**
 * Merges a freshly-fetched accounts list into the previous one. Membership
 * always follows `next`. When a `next` entry represents a transient fetch
 * failure (error set, no window data, not needs_reauth) its window fields
 * are backfilled from the previous entry with the same account_id so the UI
 * doesn't flash to "no data" on a single failed poll. The error itself is
 * preserved. needs_reauth entries are never backfilled.
 */
export function mergeAccounts(prev: AccountUsage[], next: AccountUsage[]): AccountUsage[] {
  const prevById = new Map(prev.map((account) => [account.account_id, account]));

  return next.map((entry) => {
    if (entry.error !== null && hasNoWindowData(entry) && !entry.needs_reauth) {
      const prevEntry = prevById.get(entry.account_id);
      if (prevEntry) {
        return {
          ...entry,
          five_hour: prevEntry.five_hour,
          seven_day: prevEntry.seven_day,
          seven_day_sonnet: prevEntry.seven_day_sonnet,
          seven_day_opus: prevEntry.seven_day_opus,
        };
      }
    }
    return entry;
  });
}

export interface MeterModeFlags {
  max700: boolean;
  max900: boolean;
  max1100: boolean;
}

/**
 * Resolves the UsageMeter display mode from viewport breakpoint flags.
 * hasAccountChips widens the "compact" range to <=1100px so account chips
 * have room to render; with no account chips the behavior matches the
 * original two-breakpoint (700/900) logic exactly.
 */
export function resolveMeterMode(flags: MeterModeFlags, hasAccountChips: boolean): MeterMode {
  if (flags.max700) {
    return "hidden";
  }
  if (flags.max900) {
    return "compact";
  }
  if (hasAccountChips && flags.max1100) {
    return "compact";
  }
  return "full";
}
