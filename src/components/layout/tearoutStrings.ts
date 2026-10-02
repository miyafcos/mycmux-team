export const tearoutStrings = {
  close: "この窓のペインを閉じる",
  closeHint: "この窓のセッションを終了します（戻すには、つまみか帯を掴んで重ねてください）",
  failed: "窓の操作に失敗しました。もう一度お試しください。",
  windowTitle: (count: number): string => `ペイン ${count} 本`,
} as const;
