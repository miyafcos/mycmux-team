import { listCliAccounts, type CliProvider } from "./ipc";
import { useCliAccountStore } from "../stores/cliAccountStore";

export interface AccountTarget {
  provider: CliProvider;
  profileId: string;
}

/** No caller-controlled text is included in argument errors. */
export function parseAccountTarget(input: unknown, command: string): AccountTarget {
  const invalid = () => { throw new Error(`${command}.invalid_args`); };
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  const args = input as Record<string, unknown>;
  const provider = args.provider;
  if (provider !== "claude" && provider !== "codex" && provider !== "grok") return invalid();
  const snake = args.profile_id;
  const camel = args.profileId;
  if (snake !== undefined && (typeof snake !== "string" || !snake.trim())) return invalid();
  if (camel !== undefined && (typeof camel !== "string" || !camel.trim())) return invalid();
  if (snake !== undefined && camel !== undefined && snake !== camel) return invalid();
  const profileId = snake ?? camel;
  if (typeof profileId !== "string" || !profileId.trim()) return invalid();
  // Match the snapshot ID grammar without binding a valid ID to a provider;
  // the backend remains authoritative for unknown / wrong-provider targets.
  const savedId = profileId.length <= 160
    && /^(?:claude-|codex-|grok-|unregistered-claude-|unregistered-codex-|unregistered-grok-)/.test(profileId)
    && !/[^A-Za-z0-9_.+-]/.test(profileId);
  const liveId = command === "account.use_reset_ticket"
    && ["live:claude", "live:codex", "live:grok"].includes(profileId);
  if (!savedId && !liveId) return invalid();
  return { provider, profileId };
}

const SWITCH_ERRORS = new Set([
  "accounts_unavailable", "live_login_unavailable", "live_identity_missing",
  "profile_not_found", "snapshot_unavailable", "snapshot_invalid", "needs_relogin",
  "snapshot_provider_mismatch", "backup_failed", "restore_failed", "registry_save_failed",
  "claude_identity_unreadable", "claude_identity_invalid", "codex_identity_unreadable",
  "codex_identity_invalid", "codex_credentials_store_unsupported", "codex_config_unreadable",
  "grok_identity_unreadable", "grok_identity_invalid", "grok_auth_lock_timeout",
  "snapshot_foreign", "live_token_foreign", "live_token_unverified", "switch_busy", "switch_expired",
].map((code) => `cli_account.error.${code}`));

const SWITCH_WARNINGS = new Set([
  "active_snapshot_refreshed", "unregistered_live_login_saved", "restored_identity_mismatch",
  "switch_metadata_not_saved", "live_token_not_saved", "live_token_filed_to_owner",
  "live_token_foreign_unregistered",
].map((code) => `cli_account.warning.${code}`));

export function switchErrorCode(error: unknown): string {
  const code = error instanceof Error ? error.message : error;
  return typeof code === "string" && SWITCH_ERRORS.has(code) ? code : "cli_account.error.switch_failed";
}

export interface AccountSwitchResponse {
  provider: CliProvider;
  profile_id: string;
  status: "switched" | "already_active" | "rejected" | "failed";
  applied: boolean;
  active_profile_id: string | null;
  active_known: boolean;
  intended_active_profile_id: string | null;
  wrote_back_to: string | null;
  warnings: string[];
  error_code: string | null;
}

export async function switchAccountForApi(args: unknown, deadline: number): Promise<AccountSwitchResponse> {
  const { provider, profileId } = parseAccountTarget(args, "account.switch");
  const execution = await useCliAccountStore.getState().switchToForApi(provider, profileId, deadline);
  const result = execution.kind === "switched" ? execution.result : null;
  const warnings = result?.warnings.filter((code) => SWITCH_WARNINGS.has(code)) ?? [];
  // Read independently of the store's last-good cache and any other request.
  let activeProfileId: string | null = null;
  let activeKnown = false;
  let intendedActiveProfileId: string | null = null;
  try {
    const snapshot = await listCliAccounts();
    const live = snapshot.live.find((entry) => entry.provider === provider);
    activeKnown = live !== undefined && live.error === null;
    activeProfileId = activeKnown ? live!.matched_profile_id : null;
    intendedActiveProfileId = snapshot.active[provider];
  } catch {
    // Unknown observation is explicit; never substitute cached active data.
  }
  return {
    provider, profile_id: profileId,
    status: execution.kind === "cancelled" ? "failed" : execution.kind,
    applied: result !== null,
    active_profile_id: activeProfileId,
    active_known: activeKnown,
    intended_active_profile_id: intendedActiveProfileId,
    wrote_back_to: result?.wrote_back_to ?? null,
    warnings,
    error_code: execution.kind === "switched" || execution.kind === "already_active"
      ? null : switchErrorCode("error" in execution ? execution.error : null),
  };
}
