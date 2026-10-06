import type { AccountSubscription, ProfileUsage } from "./ipc";
import { formatUpdatedAt } from "./accountRows";

const contractDate = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric", month: "2-digit", day: "2-digit",
});

function validDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function subscriptionLabel(row: ProfileUsage): string {
  const info = row.subscription;
  const renewal = validDate(info?.renews_at);
  const end = validDate(info?.ends_at);
  if (end) return `有料期間終了 ${contractDate.format(end)}`;
  if (renewal) return `次回更新 ${contractDate.format(renewal)}`;
  if ((info?.plan ?? row.plan) === "free") return "無料プラン";
  return "契約更新日・終了日：未取得";
}

export function subscriptionCheckedLabel(info: AccountSubscription | null | undefined): string {
  return info?.plan && validDate(info.checked_at) ? `確認 ${formatUpdatedAt(info!.checked_at)}` : "プラン未確認";
}

export function subscriptionTitle(row: ProfileUsage): string {
  const info = row.subscription;
  const lines = [subscriptionLabel(row)];
  const sources = {
    claude_profile: "Claude プロフィール",
    codex_usage: "Codex 使用量",
    codex_subscription: "ChatGPT 契約",
  };
  if (validDate(info?.ends_at)) lines.push(`有料期間終了: ${formatUpdatedAt(info!.ends_at!)}`);
  else if (validDate(info?.renews_at)) lines.push(`次回更新: ${formatUpdatedAt(info!.renews_at!)}`);
  else if ((info?.plan ?? row.plan) !== "free") lines.push("この連携では契約の次回更新日・終了日を取得できていません。");
  if (validDate(info?.started_at)) lines.push(`契約開始: ${formatUpdatedAt(info!.started_at!)}`);
  if (info && validDate(info.checked_at)) {
    if (!info.plan) lines.push("プラン名は保存済みの情報です。最新のプラン名は未確認です。");
    lines.push(`最終確認: ${formatUpdatedAt(info.checked_at)} (${sources[info.source] ?? info.source})`);
  } else {
    lines.push("プラン名は保存済みの情報です。最新の契約状態は未確認です。");
  }
  return lines.join("\n");
}
