// ターミナルペインのパスリンク操作の文言 (2026-08-20)。
// 失敗は英語の短文で握りつぶさず日本語で見える化する。文言はここに集約し、
// TerminalPane 側のハンドラは非 ASCII を持たない (委譲先の文字化け防止)。
export const terminalPaneStrings = {
  paneActions: "タブの操作",
  searchTerminal: "端末内を検索",
  searchTerminalTitle: (shortcut: string) => `端末内を検索 (${shortcut})`,
  searchPlaceholder: "検索…",
  searchUnavailable: "実行中の端末ペインで検索できます",
  reopenTab: "最後に閉じたペインを戻す",
  noClosedTab: "復元できる閉じたペインがありません",
  automaticName: "名前はすでに自動設定です",
  openFailed: "開けませんでした",
  revealFailed: "ファイルの場所を表示できませんでした",
  // プレビューに失敗し、既定のアプリへのフォールバックも失敗したとき (別の障害面として区別する)
  previewFallbackFailed: "プレビューに失敗し、既定のアプリでも開けませんでした",
} as const;

// タブのツールバーとペインの操作ボタンの tooltip (2026-09-10)。
// 同じ 1 本のツールバーに "Split right" と「セッションを複製」が並んでいて、
// ホバーするたび言語が入れ替わっていた。ショートカットは埋め込まず
// formatShortcutLabel で組む — mac は ⇧⌘↩ で、Ctrl とは書かれていない。
export const paneToolbarStrings = {
  newTab: "新しいターミナルペイン",
  splitRight: "右に分割",
  splitDown: "下に分割",
  zoomPane: "タブを最大化",
  restorePane: "最大化を解除",
  zoomPaneAt: (shortcut: string) => `タブを最大化 (${shortcut})`,
  restorePaneAt: (shortcut: string) => `最大化を解除 (${shortcut})`,
  openInDashboard: "ダッシュボードで開く",
  closePane: "タブを閉じる",
  pinTab: "ペインを固定",
  unpinTab: "固定を解除",
  pinnedTab: "固定中のペイン",
  closeTab: "ペインを閉じる",
  allTabs: "ペイン一覧",
  allTabsAt: (position: string) => `ペイン一覧 (${position})`,
} as const;

// ペイン (つまみ) を右クリック (⋮ 経由) したときのメニュー。
export const paneTabMenuStrings = {
  rename: "名前を変更",
  resetName: "名前を自動に戻す",
} as const;

export const toastStrings = {
  close: "閉じる",
} as const;

export const resumeStrings = {
  targetKind: "引き継ぎ先の種別",
  sessionKind: "履歴の種別",
} as const;
