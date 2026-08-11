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
  attachTab: "このタブのペインに追加",
  mergePane: "タブを統合",
  split: {
    left: "左にタブ",
    right: "右にタブ",
    up: "上にタブ",
    down: "下にタブ",
  },
  handoffSplit: (direction: keyof typeof SESSION_SPLIT_LABELS): string =>
    `${SESSION_SPLIT_LABELS[direction]}を作成して引き継ぎ`,
  paneGhostMeta: (count: number): string => `ペイン${count}個`,
  tabGhostMeta: "ペイン",
  handoffDropChip: (agent: string): string => `${agent} へ引き継ぎ文書を渡す`,
} as const;

export type PaneDndStrings = typeof paneDndStrings;
