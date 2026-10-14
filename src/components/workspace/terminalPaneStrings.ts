// ターミナルペインのパスリンク操作の文言 (2026-08-20)。
// 失敗は英語の短文で握りつぶさず日本語で見える化する。文言はここに集約し、
// TerminalPane 側のハンドラは非 ASCII を持たない (委譲先の文字化け防止)。
export const terminalPaneStrings = {
  paneActions: "タブの操作",
  searchTerminal: "端末内を検索",
  searchTerminalTitle: (shortcut: string) => `端末内を検索 (${shortcut})`,
  searchPlaceholder: "検索…",
  searchUnavailable: "実行中の端末タブで検索できます",
  reopenTab: "閉じたタブを開き直す",
  noClosedTab: "復元できる閉じたタブがありません",
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
  newTab: "新しいターミナルタブ",
  splitRight: "右にタブを開く",
  splitDown: "下にタブを開く",
  splitRightAt: (shortcut: string) => `右にタブを開く (${shortcut})`,
  splitDownAt: (shortcut: string) => `下にタブを開く (${shortcut})`,
  zoomPane: "このタブだけ表示",
  restorePane: "元の表示に戻す",
  zoomPaneAt: (shortcut: string) => `このタブだけ表示 (${shortcut})`,
  restorePaneAt: (shortcut: string) => `元の表示に戻す (${shortcut})`,
  openInDashboard: "ダッシュボードで開く",
  closePane: (behindCount: number) => behindCount > 0
    ? `このタブと裏のタブ ${behindCount} 個を閉じる`
    : "このタブを閉じる",
  closePaneWithHidden: (count: number) => `このタブと裏のタブ ${count} 個を閉じる`,
  reopenActiveOnly: "開き直せるのは表示中の 1 つだけ",
  lastPaneCloseUnavailable: "ワークスペースのタブをすべて閉じることはできません",
  duplicateSession: "セッションを複製",
  pinTab: "タブを並びの先頭に固定",
  unpinTab: "並びの先頭の固定を解除",
  pinnedTab: "並びの先頭に固定中のタブ",
  closeTab: "タブを閉じる",
  allTabs: "タブ一覧",
  allTabsAt: (position: string) => `タブ一覧 (${position})`,
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
