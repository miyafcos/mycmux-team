import type { CliAccountProfile, CliLiveLogin, CliProvider } from "./ipc";

export const CLI_ACCOUNT_POLL_INTERVAL_MS = 60_000;

export const PROVIDER_ORDER: readonly CliProvider[] = ["claude", "codex"];

export const PROVIDER_SHORT: Record<CliProvider, string> = {
  claude: "CC",
  codex: "CX",
};

export const PROVIDER_TITLE: Record<CliProvider, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

export function liveForProvider(
  live: CliLiveLogin[],
  provider: CliProvider,
): CliLiveLogin | undefined {
  return live.find((entry) => entry.provider === provider);
}

/**
 * Label shown on the titlebar badge for one provider.
 * Priority: registered label > email localpart > 未登録 / 未ログイン / "?".
 */
export function badgeLabel(
  live: CliLiveLogin | undefined,
  profiles: CliAccountProfile[],
): string {
  if (!live) return "未ログイン";
  if (live.error) return "?";
  if (!live.present) return "未ログイン";
  const matched = live.matched_profile_id
    ? profiles.find((profile) => profile.id === live.matched_profile_id)
    : undefined;
  if (matched) return matched.label;
  if (live.email) {
    const localpart = live.email.split("@")[0];
    return localpart || live.email;
  }
  return "未登録";
}

export function hasAttention(
  live: CliLiveLogin[],
  profiles: CliAccountProfile[],
): boolean {
  return (
    live.some((entry) => entry.error !== null) ||
    profiles.some((profile) => profile.needs_relogin)
  );
}

export interface AgentPaneMetadataLike {
  agentKind?: "claude" | "codex" | "claude-codex";
  processIsShell?: boolean;
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
  const counts: Record<CliProvider, number> = { claude: 0, codex: 0 };
  for (const meta of Object.values(metadata)) {
    if (!meta.agentKind || meta.processIsShell !== false) continue;
    if (meta.agentKind === "claude") counts.claude += 1;
    else if (meta.agentKind === "codex") counts.codex += 1;
    else {
      counts.claude += 1;
      counts.codex += 1;
    }
  }
  return counts;
}

export function switchWarningText(
  count: number,
  provider: CliProvider,
): string | null {
  if (count <= 0) return null;
  return (
    `${PROVIDER_TITLE[provider]} のセッションが ${count} 件実行中です。\n` +
    "実行中の CLI はメモリ上のトークンを保持しており、トークン更新のタイミングで" +
    "切り替え後の認証情報を上書きする可能性があります。\n切り替えを続行しますか？"
  );
}
