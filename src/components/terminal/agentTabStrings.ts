export const agentTabStrings = {
  settingLabel: "エージェントのタブの中身",
  settingTerminal: "端末 (今まで)",
  settingConversation: "会話の表示 (試作)",
  settingHint: "会話の表示では、端末は裏で動かし続け、見出しから切り替えられます。",
  toTerminal: "端末の表示にする",
  toConversation: "会話の表示にする",
  contentSwitchUnavailable: "会話の記録を読めるようになると、会話の表示に戻ります",
  terminalButton: "端末",
  conversation: "会話の表示",
  conversationShort: "会話",
  search: "会話履歴を検索",
  closeSearch: "検索を閉じる",
  toolGroup: (count: number) => `ツール ${count} 件`,
  newRecords: "新しい記録へ",
  liveAnswerWaiting: "回答待ち",
  liveDone: (at: string | null, seconds: number | null) => {
    const minutes = seconds === null ? 0 : Math.floor(seconds / 60);
    const rest = seconds === null ? 0 : seconds % 60;
    const elapsed = seconds === null ? "" : minutes ? `${minutes} 分${rest ? ` ${rest} 秒` : ""}` : `${rest} 秒`;
    return `終わり${at ? ` ${at}` : ""}${elapsed ? ` (${elapsed})` : ""}`;
  },
  terminalRequired: "端末で操作してください",
  slashMenu: "スラッシュコマンドの候補",
  fallback: {
    empty: "まだ会話がありません。始まると会話の表示に切り替わります",
    missing: "会話の記録が見つからないため、端末を表示しています",
    unsupported: "このエージェントの会話の記録には対応していないため、端末を表示しています",
    unreadable: "会話の記録を読めないため、端末を表示しています",
    partial: "会話の読み取りが欠けているため、端末を表示しています",
    loading: "会話の記録を確認しています。端末で操作できます",
  },
} as const;
