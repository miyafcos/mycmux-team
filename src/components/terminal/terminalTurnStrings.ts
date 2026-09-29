/**
 * User-facing copy for the terminal turn chip and its history list.
 * Kept in one file so the components stay free of Japanese literals.
 */
export const terminalTurnStrings = {
  /** "ターン 3/12" — current position among the session's turns. */
  position: (index: number, total: number): string => `ターン ${index + 1}/${total}`,
  /** Alternate-buffer chip meta: no turn index, relative dashboard nav. */
  conversationHistory: "会話履歴",
  prevTurn: "前のターン",
  nextTurn: "次のターン",
  nextTurnOrTail: "次のターン / 最新に戻る",
  /** Tooltip on the label button that opens the history list. */
  openList: "送った命令の一覧を開く",
  closeList: "一覧を閉じる",
  /** Escape hatch from the in-pane reader to the dashboard chat column. */
  openInDashboard: "ダッシュボードで開く",
  /** In-pane transcript panel. */
  openPanel: "会話履歴を開く",
  closePanel: "会話履歴を閉じる",
  listTitle: "送った命令",
  listEmpty: "このセッションで送った命令はまだありません",
  /** Rows whose buffer line was trimmed out of the scrollback. */
  outOfScrollback: "スクロールバック外",
  currentRow: "現在地",
} as const;
