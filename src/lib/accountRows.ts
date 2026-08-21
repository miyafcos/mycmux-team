import type { ProfileUsage, UsageRowState, WindowStat } from "./ipc";
import { PROVIDER_ORDER } from "./cliAccounts";
import { grokAccountStrings } from "./grokAccountStrings";

export { PROVIDER_SHORT } from "./cliAccounts";

// Successor to unifiedAccounts.ts. That file existed to reconcile two sources of
// usage -- the CLI's own login and mycmux's separate OAuth registrations -- and
// to explain to the user which number came from where. The backend now answers
// per CLI profile, so the reconciliation and its vocabulary are gone; what is
// left is ordering and formatting.

/** Any window with a number, whether from this fetch or a previous one. */
export function rowHasWindows(row: ProfileUsage): boolean {
  return Boolean(
    row.five_hour ||
    row.seven_day ||
    row.seven_day_sonnet ||
    row.seven_day_opus ||
    row.model_windows.length > 0,
  );
}

/**
 * A row needs the user's attention when it cannot show a number. A cooldown
 * row carrying its last successful numbers can, so it stays in its place and
 * keeps the titlebar quiet.
 */
export function rowNeedsAttention(row: ProfileUsage): boolean {
  return row.state !== "ok" && !rowHasWindows(row);
}

export function worstPct(row: ProfileUsage): number | null {
  const candidates = [
    row.five_hour?.pct,
    row.seven_day?.pct,
    row.seven_day_sonnet?.pct,
    row.seven_day_opus?.pct,
    ...row.model_windows.map((named) => named.window.pct),
  ].filter((pct): pct is number => typeof pct === "number");
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Fixed, state-independent order: provider, registered before live-only, then
 * label. This used to also rank by attention, active and usage, which meant
 * every fetch could shuffle the list — a row you were about to click moved
 * away whenever an error appeared or a percentage changed. Each account now
 * keeps one place; "in use" and errors are shown on the row, not by position.
 */
export function orderAccountRows(rows: ProfileUsage[]): ProfileUsage[] {
  return rows.slice().sort((left, right) => {
    const providerOrder =
      PROVIDER_ORDER.indexOf(left.provider) -
      PROVIDER_ORDER.indexOf(right.provider);
    if (providerOrder !== 0) return providerOrder;
    if (left.registered !== right.registered) return left.registered ? -1 : 1;
    const labelOrder = compareText(left.label, right.label);
    return labelOrder !== 0
      ? labelOrder
      : compareText(left.profile_id, right.profile_id);
  });
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatUpdatedAt(iso: string | null): string {
  if (!iso) return "unknown";
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : dateFormatter.format(parsed);
}

/**
 * One definition for the whole UI. The titlebar button and the panel used to
 * round differently, so the same account read 12% in one place and 12.3% in the
 * other. A bar sits next to every number here, so the decimal earns its place
 * only below 10%.
 */
export function formatPct(value: number): string {
  const clamped = Math.min(100, Math.max(0, value));
  return `${clamped.toFixed(clamped >= 10 ? 0 : 1)}%`;
}

/**
 * Numbers stay achromatic until they matter. Painting every healthy row green
 * leaves nothing for 80% and 95% to stand out against.
 */
export function usageColor(pct: number): string {
  if (pct >= 95) return "var(--cmux-usage-danger)";
  if (pct >= 80) return "var(--cmux-usage-warn)";
  return "var(--cmux-text-secondary)";
}

/** The bar carries the healthy colour that the number gives up. */
export function usageBarColor(pct: number): string {
  if (pct >= 95) return "var(--cmux-usage-danger)";
  if (pct >= 80) return "var(--cmux-usage-warn)";
  return "var(--cmux-usage-ok)";
}

export function resetHint(stat: WindowStat | null): string | undefined {
  return stat ? `リセット ${formatUpdatedAt(stat.resets_at)}` : undefined;
}

/** Hover copy when a row collapses every window's reset onto one mark. */
export const SHARED_RESET_TITLE =
  "この行のすべての枠が同じ日にリセットされます";

/**
 * All windows in a row share one reset instant, so it can be shown once.
 * Empty strings are missing data, not a value that can match.
 */
export function sharedResetAt(
  stats: Array<{ resets_at?: string }>,
): string | null {
  if (stats.length === 0) return null;
  const first = stats[0]?.resets_at;
  if (!first) return null;
  for (const stat of stats) {
    if (!stat.resets_at || stat.resets_at !== first) return null;
  }
  return first;
}

export function displayWindows(
  row: ProfileUsage,
): { key: string; label: string; stat: WindowStat; hint: string }[] {
  const fixed = [
    row.five_hour && {
      key: "five_hour",
      label: "5h",
      stat: row.five_hour,
      hint: resetHint(row.five_hour)!,
    },
    row.seven_day && {
      key: "seven_day",
      label: "7d",
      stat: row.seven_day,
      hint: resetHint(row.seven_day)!,
    },
    row.seven_day_sonnet && {
      key: "seven_day_sonnet",
      label: "S",
      stat: row.seven_day_sonnet,
      hint: `sonnet — ${resetHint(row.seven_day_sonnet)}`,
    },
    row.seven_day_opus && {
      key: "seven_day_opus",
      label: "O",
      stat: row.seven_day_opus,
      hint: `opus — ${resetHint(row.seven_day_opus)}`,
    },
  ].filter(
    (window): window is { key: string; label: string; stat: WindowStat; hint: string } =>
      Boolean(window),
  );
  const models = row.model_windows.map(({ key, window }) => {
    const name = key.replace(/^seven_day_/, "");
    return {
      key: `model:${key}`,
      label: name.charAt(0).toUpperCase(),
      stat: window,
      hint: `${name} — ${resetHint(window)}`,
    };
  });
  return [...fixed, ...models];
}

// hour12 is pinned: the meter row is laid out to the character, and a 12-hour
// locale renders "04:00 PM" where the design budgets for "16:00" - wide enough
// to push the row's trailing label back out of view.
const resetTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const resetDayFormatter = new Intl.DateTimeFormat(undefined, {
  month: "numeric",
  day: "numeric",
});

/**
 * The reset moment at glance width: a clock time when it lands today
 * ("16:00"), the date when it does not ("8/12"). Empty for a window whose
 * reset the API left out.
 */
export function formatResetShort(iso: string, now: Date = new Date()): string {
  if (!iso) return "";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  const sameDay =
    parsed.getFullYear() === now.getFullYear() &&
    parsed.getMonth() === now.getMonth() &&
    parsed.getDate() === now.getDate();
  return sameDay
    ? resetTimeFormatter.format(parsed)
    : resetDayFormatter.format(parsed);
}

const USAGE_ERROR_MESSAGE: Record<string, string> = {
  "usage.error.rate_limited":
    "取得を一時停止しています。しばらくしてから再表示されます。",
  "usage.error.needs_relogin":
    "要再ログイン。CLI で再ログインしてから「現在のログインを登録」を押してください。",
  "usage.error.token_expired_active":
    "使用量を取得できませんでした。CLI 側でトークンが更新されると表示されます。",
  "usage.error.codex_unsupported": "切り替えると表示されます。",
  "usage.error.grok_unsupported": grokAccountStrings.usageUnsupported,
  "usage.error.network":
    "使用量を取得できませんでした。ネットワークを確認してください。",
  "usage.error.upstream":
    "使用量を取得できませんでした。時間をおいて再度お試しください。",
  "usage.error.snapshot_unavailable":
    "保存されたログイン情報を読み取れませんでした。「現在のログインを登録」で更新してください。",
  "usage.error.snapshot_conflict":
    "登録内容が更新されたため、次回の取得で表示されます。",
  "usage.error.deferred":
    "今回の取得は見送りました。次回の更新で表示されます。",
};

/** Null for an unknown code, so the caller falls back to the state message. */
export function usageErrorMessage(code: string | null): string | null {
  return code ? (USAGE_ERROR_MESSAGE[code] ?? null) : null;
}

const USAGE_STATE_MESSAGE: Record<UsageRowState, string> = {
  ok: "",
  wait_for_cli:
    "使用量を取得できませんでした。CLI 側でトークンが更新されると表示されます。",
  cooldown: "取得を一時停止しています。",
  needs_relogin:
    "要再ログイン。CLI で再ログインしてから「現在のログインを登録」を押してください。",
  unsupported: "切り替えると表示されます。",
  error: "使用量を取得できませんでした。",
};

/**
 * The caption under numbers a cooldown is keeping alive: when they are from
 * and when fetching resumes. Empty for every other row.
 */
export function staleWindowsNote(row: ProfileUsage): string {
  if (row.state !== "cooldown" || !rowHasWindows(row)) return "";
  const note = `${formatUpdatedAt(row.fetched_at)} 時点・更新一時停止中`;
  return row.retry_at
    ? `${note}・${formatUpdatedAt(row.retry_at)} 頃に再開`
    : note;
}

/** What to show in place of the numbers. Empty string means "show numbers". */
export function rowMessage(row: ProfileUsage): string {
  if (row.state === "ok") return "";
  if (row.state === "cooldown" && row.retry_at) {
    // 頃: the time is a local backoff estimate, not the server's word.
    return `取得を一時停止しています。${formatUpdatedAt(row.retry_at)} 頃に再開します。`;
  }
  return usageErrorMessage(row.error_code) ?? USAGE_STATE_MESSAGE[row.state];
}

export { USAGE_STATE_MESSAGE };
