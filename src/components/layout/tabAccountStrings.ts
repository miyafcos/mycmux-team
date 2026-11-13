import type { CliLaunchTokenStatus, TabAccountEvidence } from "../../lib/ipc";
import { cliAccountMessage } from "../../lib/cliAccounts";

export const tokenOwnerLabels: Record<CliLaunchTokenStatus["owner_check"], string> = {
  verified: "確認済み (サーバーで確認)",
  org_matched: "確認済み (組織が一致)",
  org_shared: "組織だけ一致 (同じ組織のアカウントが複数)",
  unverified: "未確認",
  mismatch: "不一致 (このトークンでは起動しません)",
};


export const tabAccountPanelTitle = "このタブのアカウント";
export function evidenceTime(value: string, now = new Date()): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "不明";
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return date.toDateString() === now.toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}
export function accountMismatchText(name: string): string {
  return `不一致: このタブのログインは ${name} のものではありません。設定のアカウントで、タブ用の登録をやり直してください`;
}
export function accountEvidenceText(evidence: TabAccountEvidence, name: string, email?: string | null): string {
  const time = evidenceTime(evidence.checked_at);
  switch (evidence.result) {
    case "matched": return `確認済み: このタブのログインが ${evidence.owner_email || name} のものだと確かめました (最後に確かめた時刻: ${time})`;
    case "verified": return `確認済み: トークンの持ち主が ${email || name} だとサーバーで確かめました (最後に確かめた時刻: ${time})`;
    case "org_matched": return `確認済み: トークンの組織が ${name} の組織と一致しました (最後に確かめた時刻: ${time})`;
    case "org_shared": return "組織だけ一致: 同じ組織のアカウントがほかにも登録されているため、どのアカウントかまでは確かめられていません";
    case "unverified": return `未確認: トークンの持ち主をサーバーで確かめられませんでした。このタブで作業して、${name} の使用量が上がるかで確かめてください`;
    case "stale": return "未確認: このタブは、トークンを登録し直す前に起動しました。タブを開き直すと、今のトークンで動きます";
    case "mismatch": return accountMismatchText(name);
  }
}
export function accountEvidenceColor(result?: TabAccountEvidence["result"]): string {
  if (result === "mismatch") return "var(--cmux-usage-danger)";
  if (result === "org_shared" || result === "unverified" || result === "stale") return "var(--cmux-usage-warn)";
  return "var(--cmux-text-secondary)";
}
export function defaultTabAccountText(globalName: string): string {
  return `このタブはアカウントを指定せずに起動しました。全体のアカウントで動いています (今の全体のアカウント: ${globalName})。`;
}


export function accountUsageText(evidence: TabAccountEvidence | null, name: string, sameAsGlobal: boolean): string {
  if (evidence?.result !== "matched" && evidence?.result !== "verified" && evidence?.result !== "org_matched") {
    return `指定したアカウントは ${name} です。実際にどのアカウントの使用量が上がるかは、上の「確認」と使用量で確かめてください。`;
  }
  return sameAsGlobal
    ? `この指定は、今の全体のアカウントと同じ ${name} です。このタブで作業すると ${name} の使用量が上がります。`
    : `このタブで作業すると ${name} の使用量が上がり、全体のアカウントの使用量は動きません。`;
}

export interface AccountRecheckNotice {
  message: string;
  role: "alert" | "status";
  color: string;
}
type AccountRecheckOutcome =
  | { error: unknown }
  | {
    provider: TabAccountEvidence["provider"];
    result: TabAccountEvidence["result"];
    owner_method?: TabAccountEvidence["owner_method"];
    owner_check_status?: number;
    checked_at?: string;
    mismatchName?: string;
  };

/** Share the result/exception distinction between tab panels and settings. */
export function accountRecheckNotice(outcome: AccountRecheckOutcome): AccountRecheckNotice | null {
  const alert = (message: string): AccountRecheckNotice => ({
    message, role: "alert", color: "var(--cmux-usage-danger)",
  });
  if ("error" in outcome) return alert(cliAccountMessage(outcome.error));
  if (outcome.provider === "claude" && outcome.result === "unverified") {
    if (outcome.owner_method === undefined && outcome.owner_check_status === undefined) return alert(accountRecheckFailure);
    const time = outcome.checked_at ? ` (${evidenceTime(outcome.checked_at)})` : "";
    return {
      message: `確かめ直しました${time}: サーバーは、このトークンの持ち主を答えませんでした。`,
      role: "status", color: "var(--cmux-usage-warn)",
    };
  }
  if (outcome.result === "mismatch" && outcome.mismatchName !== undefined) return alert(accountMismatchText(outcome.mismatchName));
  return null;
}

export const accountRecheckFailure = "確かめられませんでした: サーバーにつながりませんでした。少し待ってから、もう一度押してください。";
