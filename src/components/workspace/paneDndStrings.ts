// Japanese UI strings for pane, tab, and savepoint drag-and-drop.

const SESSION_SPLIT_LABELS = {
  left: "左にセッション",
  right: "右にセッション",
} as const;

// 用語は「ワークスペース > タブ > ペイン」(2026-08-11 確定)。
// コードの Pane=タブ (分割区画) / PaneTab=ペイン (1セッション) なので、表示文言はここで読み替える。
export const paneDndStrings = {
  moveToNewWorkspace: "新しいワークスペースへ移動",
  dropInNewWindow: "離すと新しいウィンドウで開きます",
  // A single pane leaves as a content-only window; a whole tab (or a bundle)
  // keeps the normal shell. Saying which one is coming makes the difference
  // read as a rule instead of a surprise.
  dropAsDetachedPane: "離すとこのタブだけの窓になります",
  attachTab: "このタブと同じ場所に追加",
  mergePane: "このタブと同じ場所にまとめる",
  split: {
    left: "左にタブを表示",
    right: "右にタブを表示",
    up: "上にタブを表示",
    down: "下にタブを表示",
  },
  handoffSplit: (direction: keyof typeof SESSION_SPLIT_LABELS): string =>
    `${SESSION_SPLIT_LABELS[direction]}を作成して引き継ぎ`,
  paneGhostMeta: (count: number): string => `タブ${count}個`,
  tabGhostMeta: "タブ",
  handoffDropChip: (agent: string): string => `${agent} へ引き継ぎ文書を渡す`,
  // The drop threw part-way; the drag itself has already ended, so trying again works.
  dropFailed: "移動できませんでした。もう一度ドラッグしてください",
} as const;
