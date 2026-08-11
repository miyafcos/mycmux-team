export const settingsStrings = {
  remoteTabLabel: "スマホ・リモート操作",
  remoteDescription: "スマホや別のブラウザから、今このPCで開いている端末を操作します。セーブポイントとは別の機能です。",
} as const;

// キャラ (pet) 設定タブの文言。用語は「ワークスペース > タブ > ペイン」(2026-08-11 確定)。
export const petSettingsStrings = {
  tabLabel: "キャラ",
  displayTitle: "表示",
  displayHint: "キャラの出し方。",
  displayModeWs: "ワークスペースに1体 (既定)",
  displayModeBoth: "＋タブにも小さく",
  displayModeNone: "キャラなし",
  candidatesTitle: "キャラ (pet) の候補",
  candidatesHint: "チェックを入れたものだけが、新しいワークスペースのランダム抽選に出ます。クリックで切替。",
  newWsTitle: "新しいワークスペースを作ったとき",
  newWsRandom: "候補からランダムで1体 (以後そのワークスペースに固定)",
  newWsChoose: "毎回自分で選ぶ",
  newWsFixed: "いつも同じ1体にする",
  importTitle: "pet を増やす",
  importHint: "Codex の pet 規格 (8列×9行アトラス) をそのまま読みます。~/.codex/pets/ に置くだけで候補に並びます。",
  rescanButton: "今すぐ再スキャン",
  importFolderButton: "フォルダを選んで取り込む…",
  assignTitle: "ワークスペースごとの割り当て",
  assignHint: "決まった後でも変更できます。",
  rerollButton: "振り直す",
  changeButton: "変更 ▸",
  bundledSourceLabel: "同梱",
  externalSourceLabel: "取り込み",
} as const;
