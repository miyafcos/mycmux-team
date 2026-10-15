import type { AutoNameMeaning } from "./autoNamePolicy";

export type AutoNameReason = "no-record" | "instruction-unclear" | "reply" | "history-incomplete"
  | "instruction-truncated" | "unsafe-name" | "name-too-long" | "name-conflict"
  | "waiting" | "read-failed" | "launch-label-unusable" | "record-unverified" | "record-contended";

const REASONS: Record<AutoNameReason, string> = {
  "record-unverified": "この席の会話と確かめられない",
  "record-contended": "会話の記録を一つに絞れない",
  "no-record": "会話の記録が見つからない",
  "instruction-unclear": "指示から作業を一つに絞れない",
  reply: "返事・続きの指示",
  "history-incomplete": "記録の一部を読めない",
  "instruction-truncated": "指示が読み取り範囲を超える",
  "unsafe-name": "安全に表示できる名前がない",
  "name-too-long": "作業名を短くまとめられない",
  "name-conflict": "他のタブと名前を区別できない",
  waiting: "起動直後で材料待ち",
  "read-failed": "記録の読み取りに失敗",
  "launch-label-unusable": "起動時の名前が作業を示していない",
};
export const autoNameReasonLabel = (reason: AutoNameReason | undefined): string => REASONS[reason ?? "waiting"];

/** Explanations stay in runtime state; the saved name contains only the task. */
export function autoNameDescription(meaning?: AutoNameMeaning): string | undefined {
  if (!meaning) return undefined;
  if (meaning.staleSince !== undefined) return "前回の作業名を表示: " + autoNameReasonLabel(meaning.unknownReason);
  if (meaning.strength === "unknown") return "未取得: " + autoNameReasonLabel(meaning.unknownReason);
  if (meaning.source === "prompt") return "会話の最初の依頼から取得";
  if (meaning.source === "heading") return "作業の依頼書から取得";
  if (meaning.source === "label") return "起動時の名前";
  return undefined;
}
