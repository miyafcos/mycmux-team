// ターミナルペインのパスリンク操作の文言 (2026-08-20)。
// 失敗は英語の短文で握りつぶさず日本語で見える化する。文言はここに集約し、
// TerminalPane 側のハンドラは非 ASCII を持たない (委譲先の文字化け防止)。
export const terminalPaneStrings = {
  openFailed: "開けませんでした",
  revealFailed: "エクスプローラーで表示できませんでした",
  // プレビューに失敗し、既定のアプリへのフォールバックも失敗したとき (別の障害面として区別する)
  previewFallbackFailed: "プレビューに失敗し、既定のアプリでも開けませんでした",
} as const;
