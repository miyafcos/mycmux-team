// 設定 → ランチャー タブの文言 (2026-09-05)。
// LauncherTab.tsx 側は非 ASCII を持たず、文言はここに集約する
// (launcherStrings.ts / webPaneStrings と同じ方針 — 委譲先の文字化け防止)。
export const launcherTabStrings = {
  launchHeading: "新規に起動",
  webHeading: "Web",
  resumeRow: "続きから",
  resumeNote: "このPCの履歴から再開する行。中身の絞り込みは「このPCの履歴から再開」タブと共通",

  // ── フォルダ (登録済み) ──
  foldersHeading: "フォルダ",
  foldersNote: "登録済み。手動は並べ替え可、自動は新しい順",
  sectionCount: (total: number, manual: number, auto: number) =>
    `${total} 件 (手動 ${manual}・自動 ${auto})`,
  showSection: "表示",
  editLabelTooltip: "クリックで表示名を編集",
  pickFolder: "フォルダを選んで登録…",
  pickFolderTitle: "ランチャーに登録するフォルダ",
  sectionEmpty: "登録がありません。フォルダを選んで登録してください",
  badgeManual: "手動",
  badgeAuto: "自動",
  moveUp: "上へ",
  moveDown: "下へ",
  pin: "固定",
  pinTooltip: "手動に昇格させ、走査で消えないようにする",
  remove: "削除",
  ignore: "無視",
  ignoreTooltip: "この場所を候補・自動から外す (詳細で解除できる)",
  missing: "見つかりません",
  markLegend: "印: ●MM/DD = 自分のセッションで触れた / MM/DD = リポジトリやファイルの更新。手動には印が付かない。",
  alreadyRegistered: (section: string) => `すでに「${section}」に登録されています`,
  notADirectory: "フォルダが見つかりません",
  labelEmpty: "表示名が空です",

  // ── 詳細 ──
  detailsHeading: "詳細",
  jsonLabel: "正本",
  rootsLabel: "bash 用",
  rootsWrittenAt: (when: string) => `(書き出し ${when})`,
  rootsNeverWritten: "(未書き出し)",
  exportNow: "今すぐ書き出す",
  open: "開く",
  externalMerged: (when: string) => `launch-roots.txt の外部変更を取り込みました (${when})`,
  ignoredHeading: "無視",
  ignoredEmpty: "無視している場所はありません",
  unignore: "解除",
  saveFailed: (reason: string) => `保存できませんでした: ${reason}`,
  loading: "読み込み中…",
} as const;
