import type { CliAccountProfile, CliLiveLogin, CliProvider, ProfileUsage, WindowStat } from "./ipc";

export const AUTO_SWITCH_FRESH_MS = 5 * 60_000;
export const AUTO_SWITCH_COOLDOWN_MS = 5 * 60_000;

function fresh(row: ProfileUsage, now: number): boolean {
  const age = now - Date.parse(row.fetched_at);
  return row.state === "ok" && !row.needs_relogin && !row.error_code
    && age >= 0 && age <= AUTO_SWITCH_FRESH_MS;
}
function valid(window: WindowStat | null, now: number): window is WindowStat {
  return window !== null && Number.isFinite(window.pct) && window.pct >= 0
    && (!window.resets_at || Date.parse(window.resets_at) > now);
}

export interface AutoSwitchDecision {
  source: ProfileUsage;
  target: CliAccountProfile | null;
}

/** Use confirmed account-wide limits, never a terminal's generic HTTP 429. */
export function chooseAutoSwitch(
  provider: CliProvider,
  accounts: ProfileUsage[],
  profiles: CliAccountProfile[],
  live: CliLiveLogin[],
  now: number,
): AutoSwitchDecision | null {
  const login = live.find((entry) => entry.provider === provider);
  if (!login?.present || login.error || !login.matched_profile_id || !login.identity_key) return null;
  const sourceProfile = profiles.find((p) => p.id === login.matched_profile_id && p.provider === provider);
  if (!sourceProfile || sourceProfile.identity_key !== login.identity_key) return null;
  const source = accounts.find((row) => row.provider === provider && row.profile_id === login.matched_profile_id);
  if (!source?.is_active || !fresh(source, now)) return null;
  const keys = ["five_hour", "seven_day"] as const;
  if (!keys.some((key) => valid(source[key], now) && source[key]!.pct >= 100)) return null;
  const candidates = profiles.flatMap((profile) => {
    if (profile.provider !== provider || profile.id === source.profile_id || profile.needs_relogin
      || !profile.identity_key || profile.identity_key === login.identity_key) return [];
    const row = accounts.find((entry) => entry.provider === provider && entry.profile_id === profile.id);
    if (!row || !row.registered || row.is_active || !fresh(row, now)) return [];
    // A missing corresponding window is unknown capacity, not spare capacity.
    if (keys.some((key) => source[key] !== null && !valid(row[key], now))) return [];
    const windows = [row.five_hour, row.seven_day, row.seven_day_sonnet,
      row.seven_day_opus, ...row.model_windows.map((entry) => entry.window)].filter((w) => w !== null);
    if (!windows.length || windows.some((w) => !valid(w, now) || w.pct >= 100)) return [];
    return [{ profile, load: Math.max(...windows.map((w) => w.pct)) }];
  });
  candidates.sort((a, b) => a.load - b.load || a.profile.id.localeCompare(b.profile.id));
  return { source, target: candidates[0]?.profile ?? null };
}
