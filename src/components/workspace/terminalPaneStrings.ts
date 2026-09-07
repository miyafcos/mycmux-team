// ターミナルペインのパスリンク操作の文言 (2026-08-20)。
// 失敗は英語の短文で握りつぶさず日本語で見える化する。文言はここに集約し、
// TerminalPane 側のハンドラは非 ASCII を持たない (委譲先の文字化け防止)。
export const terminalPaneStrings = {
  paneActions: "ペインの操作",
  searchTerminal: "端末内を検索",
  searchTerminalTitle: "端末内を検索 (Ctrl+Shift+F)",
  searchUnavailable: "実行中の端末タブで検索できます",
  reopenTab: "最後に閉じたタブを戻す",
  noClosedTab: "復元できる閉じたタブがありません",
  automaticName: "名前はすでに自動設定です",
  openFailed: "開けませんでした",
  revealFailed: "ファイルの場所を表示できませんでした",
  // プレビューに失敗し、既定のアプリへのフォールバックも失敗したとき (別の障害面として区別する)
  previewFallbackFailed: "プレビューに失敗し、既定のアプリでも開けませんでした",
} as const;

export const toastStrings = {
  close: "閉じる",
} as const;

export const resumeStrings = {
  targetKind: "引き継ぎ先の種別",
  sessionKind: "履歴の種別",
} as const;
