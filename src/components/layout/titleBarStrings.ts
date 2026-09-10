// タイトルバーの文言。
// 設定・最小化・最大化・閉じるの tooltip だけが英語で残っていて、
// 隣のワークスペース名や保存パネルは日本語という状態だった。
// ウィンドウ操作の 3 つは Windows でしか出ない (macOS は信号機ボタン)。
export const titleBarStrings = {
  settings: "設定",
  newWorkspaceAdvanced: "エージェントとモデルを選んで新しいワークスペース",
  newWorkspaceAdvancedAt: (shortcut: string) =>
    `エージェントとモデルを選んで新しいワークスペース (${shortcut})`,
  minimize: "最小化",
  maximize: "最大化",
  restore: "元のサイズに戻す",
  close: "閉じる",
} as const;
