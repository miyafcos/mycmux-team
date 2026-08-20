// Pure, framework-independent logic for the titlebar account button.
// Kept free of React so it can be unit tested directly (tests/unit/usageAccounts.test.ts).
//
// Ordering and formatting live in accountRows.ts; what remains here is the
// layout arithmetic the button needs to survive a narrow window.

import type { ProfileUsage } from "./ipc";

export type MeterMode = "full" | "compact" | "hidden";

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
 * Builds short (~4 char) chip labels for accounts, keyed by profile_id.
 * If an account's label looks like an email address, the local part (before
 * "@") is used as the source text; otherwise the label itself is used.
 * Collisions among accounts sharing the same 4-char base are resolved
 * deterministically (by profile_id ascending) into `<3-char prefix><index>`
 * starting at 1.
 */
export function buildChipLabels(accounts: ProfileUsage[]): Map<string, string> {
  const sorted = accounts
    .slice()
    .sort((a, b) => (a.profile_id < b.profile_id ? -1 : a.profile_id > b.profile_id ? 1 : 0));

  const groups = new Map<string, ProfileUsage[]>();
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
      result.set(group[0].profile_id, base);
    } else {
      group.forEach((account, index) => {
        result.set(account.profile_id, `${base.slice(0, 3)}${index + 1}`);
      });
    }
  }
  return result;
}

export interface MeterModeFlags {
  max700: boolean;
  max1000: boolean;
  max1300: boolean;
}

/**
 * Resolves the display mode from viewport breakpoint flags.
 * hasAccountChips widens the "compact" range to <=1100px so account chips
 * have room to render; with no account chips the behavior matches the
 * original two-breakpoint (700/900) logic exactly.
 */
export function resolveMeterMode(flags: MeterModeFlags, hasAccountChips: boolean): MeterMode {
  if (flags.max700) {
    return "hidden";
  }
  if (flags.max1000) {
    return "compact";
  }
  if (hasAccountChips && flags.max1300) {
    return "compact";
  }
  return "full";
}
