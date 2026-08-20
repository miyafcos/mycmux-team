import { CLI_LOGIN_TIMEOUT_MS, type CliAccountProfile, type CliLiveLogin, type CliLoginMode, type CliProvider } from "./ipc";
import type { AgentSessionKind } from "../types";
import { grokAccountStrings } from "./grokAccountStrings";

export const CLI_ACCOUNT_POLL_INTERVAL_MS = 60_000;

export const PROVIDER_ORDER: readonly CliProvider[] = ["claude", "codex", "grok"];

export const PROVIDER_SHORT: Record<CliProvider, string> = {
  claude: "CC",
  codex: "CX",
  grok: "GK",
};

export const PROVIDER_TITLE: Record<CliProvider, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok Build",
};

const CLI_ACCOUNT_MESSAGES: Record<string, string> = {
  "cli_account.error.accounts_unavailable":
    "原因: アカウント一覧を読み取れませんでした。次にすること: ログイン状態と保存ファイルを確認して、もう一度お試しください。",
  "cli_account.error.live_login_unavailable":
    "原因: 現在のログイン情報を読み取れませんでした。次にすること: CLIでログインし直して、もう一度お試しください。",
  "cli_account.error.live_identity_missing":
    "原因: 現在のログインからアカウントを識別できませんでした。次にすること: CLIでログインし直してから登録してください。",
  "cli_account.error.profile_not_found":
    "原因: 対象の登録アカウントが見つかりません。次にすること: 一覧を更新してから選び直してください。",
  "cli_account.error.snapshot_unavailable":
    "原因: 保存済みのログイン情報を読み取れませんでした。次にすること: 対象アカウントでログインし直して登録を更新してください。",
  "cli_account.error.snapshot_invalid":
    "原因: 保存済みのログイン情報が壊れています。次にすること: 対象アカウントでログインし直して登録を更新してください。",
  "cli_account.error.needs_relogin":
    "原因: 保存済みのログイン期限が切れています。次にすること: CLIで再ログインし、「現在のログインを登録/更新」を押してください。",
  "cli_account.error.snapshot_provider_mismatch":
    "原因: 保存済み情報の種類が対象と一致しません。次にすること: 対象アカウントを登録し直してください。",
  "cli_account.error.backup_failed":
    "原因: 切り替え前のバックアップを作成できませんでした。次にすること: 保存先の空き容量とアクセス権を確認してください。認証情報は変更していません。",
  "cli_account.error.restore_failed":
    "原因: 保存済みのログイン情報を反映できませんでした。次にすること: バックアップフォルダーを確認し、CLIでログイン状態を確認してください。",
  "cli_account.error.registry_save_failed":
    "原因: アカウント登録情報を保存できませんでした。次にすること: 保存先のアクセス権を確認して、もう一度お試しください。",
  "cli_account.error.remove_failed":
    "原因: アカウント登録を削除できませんでした。次にすること: 保存先のアクセス権を確認して、もう一度お試しください。",
  "cli_account.error.rename_failed":
    "原因: アカウント名を変更できませんでした。次にすること: 一覧を更新してから、もう一度お試しください。",
  "cli_account.error.orphan_not_found":
    "原因: 未登録の保存情報が見つかりません。次にすること: 一覧を更新してから選び直してください。",
  "cli_account.error.orphan_invalid":
    "原因: 未登録の保存情報を読み取れませんでした。次にすること: 不要なら破棄し、必要ならCLIでログインし直して登録してください。",
  "cli_account.error.orphan_identity_already_registered":
    "原因: 同じアカウントはすでに登録されています。次にすること: 登録済み一覧を確認し、不要な未登録情報は破棄してください。",
  "cli_account.error.orphan_manage_failed":
    "原因: 未登録の保存情報を処理できませんでした。次にすること: 保存先のアクセス権を確認して、もう一度お試しください。",
  "cli_account.error.claude_identity_unreadable":
    "原因: Claudeのログイン情報を読み取れませんでした。次にすること: Claudeでログイン状態を確認してください。",
  "cli_account.error.claude_identity_invalid":
    "原因: Claudeのログイン情報を解析できませんでした。次にすること: Claudeで再ログインしてください。",
  "cli_account.error.codex_identity_unreadable":
    "原因: Codexのログイン情報を読み取れませんでした。次にすること: Codexでログイン状態を確認してください。",
  "cli_account.error.codex_identity_invalid":
    "原因: Codexのログイン情報を解析できませんでした。次にすること: Codexで再ログインしてください。",
  "cli_account.error.grok_identity_unreadable": grokAccountStrings.identityUnreadable,
  "cli_account.error.grok_identity_invalid": grokAccountStrings.identityInvalid,
  "cli_account.error.grok_auth_lock_timeout": grokAccountStrings.authLockTimeout,
  "cli_account.error.login_staging_failed":
    "原因: ログイン用の一時フォルダーを作成できませんでした。次にすること: 保存先の空き容量とアクセス権を確認して、もう一度お試しください。",
  "cli_account.error.login_identity_mismatch":
    "原因: 再ログインの対象と違うアカウントでログインされました。次にすること: 開いているログイン画面でログアウトしてから、対象のアカウントで入り直してください。",
  "cli_account.error.login_timeout":
    "原因: 制限時間内にログインが完了しませんでした。次にすること: 一時フォルダーは破棄しました。もう一度アカウントの追加からお試しください。",
  "cli_account.error.login_cancelled":
    "原因: ログインを中止しました。次にすること: 一時フォルダーは破棄しました。追加が必要な場合はもう一度お試しください。",
  "cli_account.error.login_already_running":
    "原因: このCLIのログインがすでに進行中です。次にすること: 開いているログインタブを完了するか中止してから、もう一度お試しください。",
  "cli_account.error.login_session_not_found":
    "原因: 対象のログイン処理が見つかりません。次にすること: 一覧を更新してから、もう一度お試しください。",
  "cli_account.warning.active_snapshot_refreshed":
    "使用中アカウントの保存情報を更新しました。認証情報の切り替えは行っていません。",
  "cli_account.warning.unregistered_live_login_saved":
    "切り替え前の未登録ログインを保存しました。設定画面の「未登録の保存情報」から登録または破棄できます。",
  "cli_account.warning.restored_identity_mismatch":
    "反映後のログインが対象アカウントと一致しません。バックアップフォルダーを確認し、CLIでログイン状態を確認してください。",
  "cli_account.warning.switch_metadata_not_saved":
    "ログイン情報は反映されましたが、選択履歴を保存できませんでした。バックアップを残したまま、保存先のアクセス権を確認してください。",
};

export function cliAccountMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  return (
    CLI_ACCOUNT_MESSAGES[raw] ??
    "原因: CLIアカウント情報を処理できませんでした。次にすること: ログイン状態を確認して、もう一度お試しください。"
  );
}

/**
 * Wording for the add-account entry points. Kept here so the titlebar panel can
 * name a provider without importing the grouping heading vocabulary the panel
 * deliberately dropped.
 */
export function addAccountLabel(provider: CliProvider): string {
  return `${PROVIDER_TITLE[provider]} のアカウントを追加`;
}

/** Label of the pane tab the isolated login runs in. */
export function loginTabLabel(provider: CliProvider, mode: CliLoginMode): string {
  return `${PROVIDER_TITLE[provider]} ${mode === "reauth" ? "再ログイン" : "ログイン"}`;
}

/**
 * The watcher keeps running after a mismatch so the user can log out and come
 * back with the right account; the message has to say that, and naming the
 * account that did log in is what makes the mistake obvious.
 */
export function loginIdentityMismatchMessage(email: string | null): string {
  const base = cliAccountMessage("cli_account.error.login_identity_mismatch");
  return email ? `${base}（ログインされたアカウント: ${email}）` : base;
}

/** Remaining time before the Rust watcher gives up, as m:ss. */
export function loginRemainingLabel(startedAt: number | null, nowMs: number): string {
  const elapsed = startedAt === null ? 0 : Math.max(0, nowMs - startedAt);
  const remainingSecs = Math.ceil(Math.max(0, CLI_LOGIN_TIMEOUT_MS - elapsed) / 1000);
  return `${Math.floor(remainingSecs / 60)}:${String(remainingSecs % 60).padStart(2, "0")}`;
}

export function liveForProvider(
  live: CliLiveLogin[],
  provider: CliProvider,
): CliLiveLogin | undefined {
  return live.find((entry) => entry.provider === provider);
}

export function attentionReason(
  live: CliLiveLogin[],
  profiles: CliAccountProfile[],
  fetchError: string | null = null,
): string | null {
  const reasons: string[] = [];
  if (fetchError || live.some((entry) => entry.error !== null)) {
    reasons.push("ログイン情報を読み取れない項目があります");
  }
  if (profiles.some((profile) => profile.needs_relogin)) {
    reasons.push("再ログインが必要なアカウントがあります");
  }
  return reasons.length > 0 ? reasons.join("。") : null;
}

export function orderCliAccountProfiles(profiles: CliAccountProfile[]): CliAccountProfile[] {
  return [...profiles].sort((left, right) => {
    const leftTime = left.last_switched_at ? Date.parse(left.last_switched_at) : Number.NaN;
    const rightTime = right.last_switched_at ? Date.parse(right.last_switched_at) : Number.NaN;
    const leftValid = Number.isFinite(leftTime);
    const rightValid = Number.isFinite(rightTime);
    if (leftValid && rightValid && leftTime !== rightTime) return rightTime - leftTime;
    if (leftValid !== rightValid) return leftValid ? -1 : 1;
    return 0;
  });
}

export function canSwitchCliAccount(
  isActive: boolean,
  providerBusy: boolean,
  needsRelogin: boolean,
): boolean {
  return !isActive && !providerBusy && !needsRelogin;
}

export async function executeCliAccountSwitch<T>(
  isActive: boolean,
  providerBusy: boolean,
  needsRelogin: boolean,
  confirmSwitch: () => Promise<boolean>,
  switchAccount: () => Promise<T | null>,
): Promise<T | null> {
  if (!canSwitchCliAccount(isActive, providerBusy, needsRelogin)) return null;
  if (!(await confirmSwitch())) return null;
  return switchAccount();
}

export function cliAccountProfileActivity(
  intendedActiveId: string | null,
  profileId: string,
  live: CliLiveLogin | undefined,
  fetchError: string | null,
): { active: boolean; possiblyActive: boolean } {
  const uncertain = Boolean(fetchError) || !live || Boolean(live.error);
  const lastKnownActive = live?.matched_profile_id === profileId;
  const intendedActive = intendedActiveId === profileId;
  return {
    active: !uncertain && lastKnownActive,
    possiblyActive: uncertain && (lastKnownActive || intendedActive),
  };
}

export interface AgentPaneMetadataLike {
  agentKind?: AgentSessionKind;
  processIsShell?: boolean;
  cwd?: string;
  processTitle?: string;
}

function paneMatchesProvider(meta: AgentPaneMetadataLike, provider: CliProvider): boolean {
  if (!meta.agentKind || meta.processIsShell !== false) return false;
  return meta.agentKind === provider || (
    meta.agentKind === "claude-codex" && (provider === "claude" || provider === "codex")
  );
}

export function runningAgentPaneDetails(
  metadata: Record<string, AgentPaneMetadataLike>,
  provider: CliProvider,
  volatileMetadata: Record<string, Pick<AgentPaneMetadataLike, "processTitle">> = {},
): string[] {
  return Object.entries(metadata)
    .filter(([, meta]) => paneMatchesProvider(meta, provider))
    .map(([sessionId, meta]) => {
      const process = volatileMetadata[sessionId]?.processTitle?.trim()
        || meta.processTitle?.trim()
        || PROVIDER_TITLE[provider];
      const location = meta.cwd?.trim() || "作業フォルダー不明";
      return `${process} / ${location} / セッション ${sessionId.slice(0, 8)}`;
    });
}

/**
 * Count live agent panes per provider. A pane counts only while its
 * foreground process is not a shell (i.e. the agent is actually running);
 * "claude-codex" counts toward both providers because its backend can be
 * either.
 */
export function runningAgentCounts(
  metadata: Record<string, AgentPaneMetadataLike>,
): Record<CliProvider, number> {
  const counts: Record<CliProvider, number> = { claude: 0, codex: 0, grok: 0 };
  for (const meta of Object.values(metadata)) {
    if (!meta.agentKind || meta.processIsShell !== false) continue;
    if (meta.agentKind === "claude") counts.claude += 1;
    else if (meta.agentKind === "codex") counts.codex += 1;
    else if (meta.agentKind === "grok") counts.grok += 1;
    else if (meta.agentKind === "claude-codex") {
      counts.claude += 1;
      counts.codex += 1;
    }
  }
  return counts;
}

export function switchWarningText(
  count: number,
  provider: CliProvider,
  targetLabel?: string,
  paneDetails: readonly string[] = [],
): string {
  const target = targetLabel ? `「${targetLabel}」へ` : "別のアカウントへ";
  const running = count > 0
    ? `${PROVIDER_TITLE[provider]} のセッションが ${count} 件実行中です。`
    : `mycmux 内で実行中の ${PROVIDER_TITLE[provider]} セッションは確認できませんでした。`;
  const panes = paneDetails.length > 0
    ? `\n対象ペイン:\n${paneDetails.map((detail) => `・${detail}`).join("\n")}`
    : "";
  return (
    `${target}切り替えます。切り替え前の状態は自動でバックアップされ、新しく起動するセッションから反映されます。\n` +
    `${running}${panes}\n` +
    "mycmux の外で動いている CLI は検知できません。実行中の CLI がある場合、認証情報を後から上書きする可能性があります。\n" +
    "切り替えを続行しますか？"
  );
}
