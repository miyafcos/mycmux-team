import type { ProfileUsage, UsageRowState, WindowStat } from "./ipc";
import { PROVIDER_ORDER } from "./cliAccounts";

export { PROVIDER_SHORT } from "./cliAccounts";

// Successor to unifiedAccounts.ts. That file existed to reconcile two sources of
// usage -- the CLI's own login and mycmux's separate OAuth registrations -- and
// to explain to the user which number came from where. The backend now answers
// per CLI profile, so the reconciliation and its vocabulary are gone; what is
// left is ordering and formatting.

/** Any window with a number, whether from this fetch or a previous one. */
export function rowHasWindows(row: ProfileUsage): boolean {
  return Boolean(row.five_hour || row.seven_day || row.seven_day_sonnet || row.seven_day_opus);
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
  const candidates = [row.five_hour?.pct, row.seven_day?.pct].filter(
    (pct): pct is number => typeof pct === "number",
  );
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Stable and non-destructive: the same input always yields the same order. */
export function orderAccountRows(rows: ProfileUsage[]): ProfileUsage[] {
  return rows.slice().sort((left, right) => {
    const providerOrder =
      PROVIDER_ORDER.indexOf(left.provider) - PROVIDER_ORDER.indexOf(right.provider);
    if (providerOrder !== 0) return providerOrder;
    const leftAttention = rowNeedsAttention(left);
    const rightAttention = rowNeedsAttention(right);
    if (leftAttention !== rightAttention) return leftAttention ? -1 : 1;
    if (left.is_active !== right.is_active) return left.is_active ? -1 : 1;
    const leftPct = worstPct(left) ?? -1;
    const rightPct = worstPct(right) ?? -1;
    if (leftPct !== rightPct) return rightPct - leftPct;
    const labelOrder = compareText(left.label, right.label);
    return labelOrder !== 0 ? labelOrder : compareText(left.profile_id, right.profile_id);
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

const USAGE_ERROR_MESSAGE: Record<string, string> = {
  "usage.error.rate_limited": "取得を一時停止しています。しばらくしてから再表示されます。",
  "usage.error.needs_relogin":
    "要再ログイン。CLI で再ログインしてから「現在のログインを登録」を押してください。",
  "usage.error.token_expired_active":
    "使用量を取得できませんでした。CLI 側でトークンが更新されると表示されます。",
  "usage.error.codex_unsupported": "切り替えると表示されます。",
  "usage.error.network": "使用量を取得できませんでした。ネットワークを確認してください。",
  "usage.error.upstream": "使用量を取得できませんでした。時間をおいて再度お試しください。",
  "usage.error.snapshot_unavailable":
    "保存されたログイン情報を読み取れませんでした。「現在のログインを登録」で更新してください。",
  "usage.error.snapshot_conflict": "登録内容が更新されたため、次回の取得で表示されます。",
  "usage.error.deferred": "今回の取得は見送りました。次回の更新で表示されます。",
};

/** Null for an unknown code, so the caller falls back to the state message. */
export function usageErrorMessage(code: string | null): string | null {
  return code ? (USAGE_ERROR_MESSAGE[code] ?? null) : null;
}

const USAGE_STATE_MESSAGE: Record<UsageRowState, string> = {
  ok: "",
  wait_for_cli: "使用量を取得できませんでした。CLI 側でトークンが更新されると表示されます。",
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
  return row.retry_at ? `${note}・${formatUpdatedAt(row.retry_at)} に再開` : note;
}

/** What to show in place of the numbers. Empty string means "show numbers". */
export function rowMessage(row: ProfileUsage): string {
  if (row.state === "ok") return "";
  if (row.state === "cooldown" && row.retry_at) {
    return `取得を一時停止しています。${formatUpdatedAt(row.retry_at)} に再開します。`;
  }
  return usageErrorMessage(row.error_code) ?? USAGE_STATE_MESSAGE[row.state];
}

export { USAGE_STATE_MESSAGE };
