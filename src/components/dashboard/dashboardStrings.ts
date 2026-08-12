// ダッシュボード (全ワークスペース×全ペインの一覧) の文言。
// 用語は「ワークスペース > タブ > ペイン」(2026-08-11 確定)。
// 表示方針: 会話の正本は livebrief の意味イベント。生端末は [端末] タブへ降格し、
// 「裏」「観測外」のような断定表示は置かない (2026-08-12 段3)。
export const dashboardStrings = {
  buttonTitle: "ダッシュボード",
  panelAriaLabel: "ダッシュボード — 全ペイン一覧",
  // 状態語 (resolveDisplayState の6値に対応)
  stateNeedsHuman: "要対応",
  stateError: "エラー",
  stateRunning: "作業中",
  stateNoUpdate: "更新なし",
  stateDone: "完了",
  stateIdle: "待機",
  sortByWorkspace: "ワークスペース順",
  sortByAttention: "要対応順",
  liveUpdating: "自動更新中",
  jumpButtonTitle: "このペインへ移動",
  myInstructionLabel: "私の指示",
  agentAskingLabel: "エージェントの質問",
  clearDoneButton: (n: number): string => `完了 ${n}件を既読にする`,
  countUnit: (n: number): string => `${n}件`,
  paneLocation: (tab: number | string, pane: number | string): string => `タブ${tab}·P${pane}`,
  breadcrumb: (ws: string, tab: number | string, pane: number | string): string => `${ws} › タブ${tab} › P${pane}`,
  elapsed: (min: number): string => (min < 60 ? `${min}分` : `${Math.floor(min / 60)}時間${min % 60}分`),
  // 停滞理由 (P5: 常時検知の3分類)
  stallNoOutput: "5分以上 出力なし",
  stallQueuedInput: "未送信の指示が残っている",
  stallPtyDead: "プロセスが終了している",
  stallSince: (min: number): string => `${min}分 無反応`,
  stallQueuedPreviewLabel: "未送信テキスト",
  // フルスクリーンビュー (2026-08-11) / 2ペイン化 (2026-08-12)
  viewAriaLabel: "ダッシュボード — 全ペイン俯瞰ビュー",
  sessionListAriaLabel: "セッション一覧",
  sectionNeedsHuman: "要対応",
  sectionAllSessions: "全セッション",
  searchPlaceholder: "検索 (ワークスペース・ラベル・cwd・ログ)",
  backToSession: "セッションへ戻る",
  filterNeedsHumanOnly: "要対応のみ",
  agentFilterTitle: "エージェント",
  allWorkspaces: "全て",
  keyboardHint: "j/k 選択 · Enter 移動 · Tab 次の要対応 · / 検索 · Esc 戻る",
  markReadButton: "完了を既読",
  totalSummary: (panes: number, ws: number): string => `全${panes}ペイン / ${ws}ワークスペース`,
  filteredSummary: (n: number, m: number): string => `絞り込み ${n} / 全 ${m}`,
  detailEmpty: "セッションを選ぶと詳細が出ます",
  listEmpty: "該当するセッションがありません",
  // ライブ要約 (LiveBrief) — 英語ハードコード全廃 (2026-08-12)
  liveBriefTitle: "ライブ要約",
  liveBriefTaskLabel: "目的",
  liveBriefActivityLabel: "実行中",
  liveBriefCheckpointLabel: "確認済み",
  liveBriefQuestionLabel: "質問",
  // 介入結果 (intervene.rs の InterventionResult 7種に対応)
  interventionConfirmed: "送信を会話ログで確認しました",
  interventionConflict: "対象が変わったため送っていません",
  interventionBusy: "この質問への送信は処理中です",
  interventionWritten: "書き込みました。会話ログでの反映を待っています",
  interventionRejected: (reason: string): string => `送っていません: ${reason}`,
  interventionReason: (code: string): string => {
    if (code === "target_missing") return "質問の対象を特定できませんでした";
    if (code === "transport") return "内部通信に失敗しました";
    return code;
  },
  interventionIndeterminate: "書き込み結果が不確定です。端末で確認してください (自動再送はしません)",
  interventionUnconfirmed: "書き込みは会話ログで未確認です。質問は残っています (自動再送はしません)",
  // テレメトリの健全性 (TelemetryHealth)
  telemetryUnlinked: "セッション履歴と未接続",
  telemetryUnavailable: "履歴を読めません (未検出・重複・サイズ超過のいずれか)",
  lastCheckedAgo: (min: number): string => `最終確認 ${min}分前`,
  noUpdateFor: (min: number): string => `更新なし ${min}分`,
  // 詳細ペインのタブ
  tabNow: "現在",
  tabHistory: "経緯",
  tabTerminal: "端末",
  recommendedBadge: "推奨",
  otherFreeText: "その他 (自由入力)…",
  numberKeyHint: "1 / 2 / 3 キーでも選択",
  openTerminalButton: "端末を開く",
  // 経緯 (EventTimeline) / 端末タブ
  timelineEmpty: "まだ会話の記録がありません",
  timelineAriaLabel: "会話の経緯",
  terminalTailTitle: "画面の末尾 40行",
  terminalUnreadable: "この端末の内容は読み取れませんでした",
  fallbackTitle: "端末から拾える情報",
  fallbackHint: "生のログは [端末] タブで確認できます",
  // v2: 終了・未起動 (断定しない事実表示)
  telemetryEnded: "エージェント終了 (記録は保持)",
  stateNotStarted: "未起動",
  notStartedDetail: "まだ開いていないタブです ([端末] で開くと記録が始まります)",
  // v2: 常設コンポーザ (ReplyComposer)
  composerPlaceholder: "ここに指示をタイプ → Enter で送信 (送達確認つき)",
  composerSend: "送信 ⏎",
  composerAriaLabel: "選択中のペインへの指示入力",
  composerTo: (ws: string, tab: number | string, pane: string): string => `→ ${ws} · タブ${tab} · ${pane}`,
  composerRunningDisabled: "作業中です。終わるまで待つか [端末] タブで直接送ってください",
  composerNotStarted: "まだ開いていないタブなので送信できません",
  sendConfirmedOnScreen: "送信を画面で確認しました",
  sendUnverified: "送信しましたが画面で確認できませんでした",
  sendFailedBeforeWrite: "送信できませんでした (実行前にエラー)",
  // v2: ヘッダの visinfo
  visinfoCounts: (panes: number, tabs: number, ws: number): string => `${panes}ペイン · ${tabs}タブ · ${ws}ワークスペース`,
  visinfoVisible: (visible: number, background: number): string => `表示中 ${visible} / 裏で稼働 ${background}`,
} as const;
