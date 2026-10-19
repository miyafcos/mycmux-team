// 設定 →「使うサービス」と、サービスの表示・非表示が効く画面の文言 (2026-10-16)。
// 文言はここに集約する (launcherTabStrings.ts と同じ方針 — 委譲先の文字化け防止)。
// サービス名そのもの (Claude Code・Codex など) は AGENT_CATALOG の label を使い、ここには持たない。
export const agentServiceVisibilityStrings = {
  tabLabel: "使うサービス",
  heading: "使うサービス",
  note: "オフにしたサービスは、ランチャー・新しいワークスペース・エージェント設計 (スキルとふりかえりを含む)・履歴から再開する画面の選択肢に出なくなります。記録済みのセッションや使用量は消えません。",
  firstRunNote: "最初は、Claude Code と Codex に加えて、この PC で見つかったサービスだけをオンにしています。",
  webNote: "Web の項目 (ChatGPT・Gemini など) は、設定の「ランチャー」で切り替えます。",

  // 各サービスの行の右に出す、この PC での見つかり方
  detected: "この PC で見つかりました",
  notDetected: "この PC では見つかりません",
  detecting: "確認中…",
  notChecked: "まだ確かめていません",
  detectFailed: "確認できませんでした",

  // 設定の「ランチャー」の「新規に起動」の下に出す案内
  launcherMoreNote: "ここに無いサービスは、設定の「使うサービス」でオンにできます。",

  // エージェント設計で、表示できるサービスが 1 つも無いとき
  agentDesignNone: "表示するサービスがありません。設定の「使うサービス」でオンにしてください。",

  // ふりかえり (AI ログ) の空の状態の文。names は表示中のサービスの短い名前 (例: ["Claude", "Codex"])
  ailogEmptyBody: (names: readonly string[]) =>
    `${names.length > 0 ? names.join("、") : "エージェント"} の記録を取り込むと、ここに集計が出ます。初回は数十秒かかります。`,
  // ふりかえりの「CLI」で分けるときの説明。names は表示中のサービス名 (例: ["Claude Code", "Codex"])
  ailogKindHint: (names: readonly string[]) => (names.length > 0 ? names.join(" / ") : "エージェントの種類"),
} as const;
