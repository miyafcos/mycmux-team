import type { CliLiveLogin, CliProvider } from "./ipc";

/**
 * How long to wait before checking that a switch actually stuck.
 *
 * Both CLIs rewrite their credential file whenever they refresh a token, so a
 * session that was already running under the previous account can overwrite a
 * switch seconds after it completed. One late check catches that without
 * turning into a fight loop: re-applying the switch would only trade one
 * silent clobber for another.
 */
export const SWITCH_REVERT_CHECK_MS = 8000;

/**
 * Whether the live login drifted away from the account we just switched to.
 *
 * Unknown identities are treated as "no verdict": the credential file can be
 * mid-write, and a warning the user cannot act on is worse than silence.
 */
export function switchWasReverted(
  provider: CliProvider,
  targetIdentityKey: string | null | undefined,
  live: CliLiveLogin[],
): boolean {
  if (!targetIdentityKey) return false;
  const current = live.find((entry) => entry.provider === provider);
  if (!current || !current.present || current.error) return false;
  if (!current.identity_key) return false;
  return current.identity_key !== targetIdentityKey;
}

/** Warning shown when the check above says the switch was undone. */
export function switchRevertMessage(label: string): string {
  return `「${label}」に切り替えた直後に、別のアカウントのログイン情報で上書きされました。実行中のセッションがトークンを更新した可能性があります。実行中のセッションを終了してから切り替え直してください。`;
}
