export const tearoutStrings = {
  close: "この窓のタブを閉じる",
  closeHint: "この窓のセッションを終了します（戻すには、タブの見出しか帯を掴んで相手のタブの見出しへ重ねてください）",
  failed: "窓の操作に失敗しました。もう一度お試しください。",
  windowTitle: (count: number): string => `タブ ${count} 個`,
} as const;
