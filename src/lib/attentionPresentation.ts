// Shared vocabulary for "this session wants you" indicators.
//
// The pane tab pills, the all-tabs dropdown and the sidebar workspace rows all
// paint the same three attention categories. They live in different component
// trees, so the color/label mapping sits here rather than in whichever file
// happened to need it first.

import type { AttentionCategory } from "../stores/sessionAttentionStore";

export const ATTENTION_REASON_COLOR: Record<AttentionCategory, string> = {
  waiting: "var(--status-waiting)",
  error: "var(--status-error)",
  done: "var(--status-done)",
};

export const ATTENTION_REASON_LABEL: Record<AttentionCategory, string> = {
  waiting: "入力待ち",
  error: "エラー",
  done: "完了",
};

/** Accessible label for an indicator that marks an *unseen* attention. */
export function unseenAttentionLabel(category: AttentionCategory): string {
  return `未確認の${ATTENTION_REASON_LABEL[category]}`;
}
