// Japanese UI strings for pane, tab, and savepoint drag-and-drop.

const SESSION_SPLIT_LABELS = {
  left: "左にセッション",
  right: "右にセッション",
} as const;

export const paneDndStrings = {
  moveToNewWorkspace: "新しいワークスペースへ移動",
  dropInNewWindow: "離すと新しいウィンドウで開きます",
  attachTab: "このペインのタブに追加",
  mergePane: "ペインを統合",
  split: {
    left: "左にペイン",
    right: "右にペイン",
    up: "上にペイン",
    down: "下にペイン",
  },
  handoffSplit: (direction: keyof typeof SESSION_SPLIT_LABELS): string =>
    `${SESSION_SPLIT_LABELS[direction]}を作成して引き継ぎ`,
  paneGhostMeta: (count: number): string => `タブ${count}個`,
  tabGhostMeta: "タブ",
  handoffDropChip: (agent: string): string => `${agent} へ引き継ぎ文書を渡す`,
} as const;

export type PaneDndStrings = typeof paneDndStrings;
