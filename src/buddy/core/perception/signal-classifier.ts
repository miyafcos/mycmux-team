import type { BuddySignal } from "./perception";

export type SignalImportance = "important" | "normal";

export const IMPORTANT_KEYWORDS = [
  "error",
  "failed",
  "failure",
  "panic",
  "exception",
  "例外",
  "エラー",
  "失敗",
  "done",
  "completed",
  "complete",
  "完了",
  "成功",
  "✓",
] as const;

export const ERROR_KEYWORDS = [
  "error",
  "failed",
  "failure",
  "panic",
  "exception",
  "エラー",
  "失敗",
] as const;

export const COMPLETION_KEYWORDS = [
  "done",
  "completed",
  "complete",
  "完了",
  "成功",
] as const;

export function classifySignal(signal: BuddySignal): SignalImportance {
  if (signal.kind !== "claudeEvent" && signal.kind !== "codexEvent") {
    return "normal";
  }

  const text = signal.text.toLowerCase();
  return IMPORTANT_KEYWORDS.some((keyword) => text.includes(keyword)) ? "important" : "normal";
}
