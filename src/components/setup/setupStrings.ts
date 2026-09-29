// ワークスペース作成ダイアログの文言。
// この画面だけ全体が英語のまま残っていて、開いた瞬間にアプリの言語が
// 切り替わって見えていた。エージェント欄の aria も同じ理由でここに置く。
export const setupStrings = {
  title: "新しいワークスペース",
  nameLabel: "名前",
  folderLabel: "作業フォルダ",
  folderPlaceholder: "(ホーム)",
  browse: "参照",
  cancel: "やめる",
  launch: "開く",
  layout: "レイアウト",
  agents: (paneCount: number) => `エージェント (${paneCount} ペイン)`,
  modelPlaceholder: "モデル（既定）",
  paneModelLabel: (slot: number) => `ペイン ${slot} のモデル`,
  paneEffortLabel: (slot: number) => `ペイン ${slot} の thinking`,
} as const;
