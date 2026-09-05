// ダッシュボード (全ワークスペース×全ペインの一覧) の文言。
// 用語は「ワークスペース > タブ > ペイン」(2026-08-11 確定)。
// 表示方針: 会話の正本は livebrief の意味イベント。生端末は小さな切替で確認し、
// 「裏」「観測外」のような断定表示は置かない (2026-08-12 段3)。
type PrimaryActionLabel = "openSession" | "answerQuestion" | "retryWorkItem" | "reviewConflict" | "raiseBudget" | "acknowledgeGoalReached";
type AttentionKindLabel = "agentAsked" | "workStopped" | "reportsComplete" | "completionWithoutTests" | "budgetReached" | "outOfScopeWrite" | "conflictDetected" | "goalReached" | "nextItemReady" | "workOrderStalled" | "sessionBoardIncident";

export const dashboardStrings = {
  buttonTitle: "ダッシュボード",
  panelAriaLabel: "ダッシュボード — 全ペイン一覧",
  // 状態語 (resolveDisplayState の6値に対応)
  stateNeedsHuman: "要回答・要確認",
  stateNeedsAnswer: "要回答",
  stateNeedsReview: "要確認",
  stateError: "エラー",
  stateRunning: "作業中",
  stateNoUpdate: "出力なし",
  stateDone: "完了",
  stateIdle: "待機",
  stateStopped: "停止",
  collapsedDone: (n: number): string => `完了 ${n}件`,
  collapsedIdle: (n: number): string => `待機・未起動 ${n}件`,
  collapsedTitle: "クリックで展開",
  jumpButtonTitle: "このペインへ移動",
  myInstructionLabel: "私の指示",
  agentAskingLabel: "エージェントの質問",
  clearDoneButton: (n: number): string => `完了 ${n}件を既読にする`,
  countUnit: (n: number): string => `${n}件`,
  paneLocation: (tab: number | string, pane: number | string): string => `タブ${tab}·P${pane}`,
  breadcrumb: (ws: string, tab: number | string, pane: number | string): string => `${ws} › タブ${tab} › P${pane}`,
  elapsed: (min: number): string => (min < 60 ? `${min}分` : `${Math.floor(min / 60)}時間${min % 60}分`),
  // 停滞理由 (P5: 常時検知の3分類)
  stallNoOutput: "5分 出力なし",
  stallQueuedInput: "未送信の指示が残っている",
  stallPtyDead: "プロセスが終了している",
  stallSince: (min: number): string => `${min}分 無反応`,
  stallQueuedPreviewLabel: "未送信テキスト",
  // フルスクリーンビュー (2026-08-11) / 2ペイン化 (2026-08-12)
  viewAriaLabel: "ダッシュボード — 全ペイン俯瞰ビュー",
  sessionListAriaLabel: "セッション一覧",
  sectionNeedsHuman: "要対応",
  sectionNeedsAnswer: "要回答",
  sectionNeedsReview: "要確認",
  sectionWorking: "作業中",
  sectionOther: "その他",
  sectionAllSessions: "全セッション",
  searchPlaceholder: "検索 (ワークスペース・ラベル・cwd・ログ)",
  askStripTitle: "質問",
  askStripAriaLabel: "未解決の質問",
  askStripEmpty: "なし — 全員動いています",
  watchTitle: "委譲の見守り",
  watchUnmeasured: "計測なし",
  watchRunning: "動作中",
  watchStopped: "停止",
  watchHidden: "ウィンドウ非表示のため停止",
  watchNotMain: "子ウィンドウのため停止",
  watchDisabled: "見守りがオフ",
  watchNotifyOff: "見守りの通知オフ",
  layoutMinimapTitle: "配置図",
  layoutMinimapAriaLabel: "ワークスペースの読取専用配置図",
  watchLastTick: (value: string): string => `最終チェック ${value}`,
  watchNextTick: (value: string): string => `次回 ${value}`,
  watchDueIn: (minutes: number): string => `${minutes}分後`,
  watchJustNow: "たった今",
  watchAgo: (minutes: number): string => `${minutes}分前`,
  backToSession: "セッションへ戻る",
  agentFilterTitle: "エージェント",
  allWorkspaces: "全て",
  keyboardHint: "j/k 選択 · Enter 移動 · Tab 次の要対応 · / 検索 · Esc 戻る",
  markReadButton: "完了を既読",
  // 手動の完了マーク (状態を問わず個別カードを完了扱いにする。新しい動きがあれば自動で解除)
  markDoneButton: "完了にする",
  unmarkDoneButton: "完了を戻す",
  markDoneTitle: "このセッションを確認済み・完了として扱う (新しい動きがあれば要確認に戻ります)",
  unmarkDoneTitle: "手動の完了マークを外す",
  manualDoneBadge: "確認済み",
  totalSummary: (panes: number, ws: number): string => `全${panes}ペイン / ${ws}ワークスペース`,
  filteredSummary: (n: number, m: number): string => `絞り込み ${n} / 全 ${m}`,
  detailEmpty: "セッションを選ぶと詳細が出ます",
  chatColumnsEmpty: "配置図か一覧から開くと、ここに並びます",
  chatColumnLimitGroupLabel: "同時に開ける列数",
  chatColumnLimitButtonLabel: (n: number): string => `${n}列`,
  chatColumnCapLabel: (n: number): string => `${n}列まで`,
  chatColumnPin: "固定",
  chatColumnPinAriaLabel: "この列を固定",
  chatColumnUnpinAriaLabel: "この列の固定を解除",
  chatColumnOpenBlocked: "全ての列が固定されています。固定を外すか上限を上げてください",
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
  recommendedBadge: "推奨",
  otherFreeText: "その他 (自由入力)…",
  numberKeyHint: "1 / 2 / 3 キーでも選択",
  askQuestionSubmit: "送信",
  askQuestionSending: "送信中",
  askQuestionTabProgress: (done: number, total: number): string => `${done}/${total}`,
  askQuestionStopReason: (code: string): string => {
    if (code === "superseded_launch") return "Prompt belongs to a superseded launch.";
    if (code === "timed_out") return "Prompt timed out before the screen changed.";
    if (code === "busy") return "この質問への送信は処理中です";
    if (code === "stale_question") return "質問が変わったため送っていません";
    if (code === "null_scan") return "画面の質問を読めなかったため送っていません";
    if (code === "attention_mismatch") return "対象が変わったため送っていません";
    if (code === "session_revision_mismatch") return "対象が変わったため送っていません";
    if (code === "target_disappeared") return "質問の対象が消えたため送っていません";
    if (code === "unchanged_screen") return "画面が変わらなかったため、続きは送っていません";
    if (code === "read_failure") return "画面を読めなかったため送っていません";
    if (code === "transport") return "内部通信に失敗したため送っていません";
    if (code === "ambiguous") return "画面の状態が確定できないため送っていません";
    if (code === "undiscovered_tab") return "未表示の質問には送っていません";
    if (code === "needs_confirmation") return "新しい質問が現れました。確認してから続けてください";
    return code;
  },
  // チャット (ChatTranscript)
  chatEmpty: "まだ会話の記録がありません",
  // 読み込み失敗と「本当に空」を区別する (2026-08-17 FB)。理由の詳細は telemetryUnlinked / telemetryUnavailable を併記
  chatUnavailable: "会話の記録を読み込めていません",
  chatAriaLabel: "会話ログ (整形表示)",
  chatRoleUser: "私",
  chatRoleAgent: "エージェント",
  userTurnNavAriaLabel: (n: number, total: number): string => `自分の命令文 ${n}/${total}`,
  userTurnPrevAriaLabel: "前の命令文",
  userTurnNextAriaLabel: "次の命令文 / 最新に戻る",
  // 端末 tail
  terminalTailTitle: "画面の末尾 40行",
  terminalUnreadable: "この端末の内容は読み取れませんでした",
  fallbackTitle: "端末から拾える情報",
  fallbackHint: "生のログは端末表示で確認できます",
  // v2: 終了・未起動 (断定しない事実表示)
  telemetryEnded: "エージェント終了 (記録は保持)",
  stateNotStarted: "未起動",
  notStartedDetail: "まだ開いていないタブです (端末を開くと記録が始まります)",
  // v2: 常設コンポーザ (ReplyComposer)
  composerPlaceholder: "ここに指示をタイプ",
  composerSend: "送信 ⏎",
  composerAriaLabel: "選択中のペインへの指示入力",
  composerNotStarted: "まだ開いていないタブなので送信できません",
  composerBlockedByAskQuestion: "質問カードで回答するまで通常の指示は送信できません",
  sendConfirmedOnScreen: "入力後の画面更新を確認しました",
  sendUnverified: "入力をキューに追加しましたが、画面で確認できませんでした",
  sendUnverifiedTargetUnmounted: "入力をキューに追加しましたが、対象タブが未マウントのため画面で確認できませんでした",
  sendSubmitUnconfirmed: "入力をキューに追加しましたが、Enter 後の画面更新を確認できませんでした（自動再送しません）",
  sendFailedBeforeWrite: "送信できませんでした (実行前にエラー)",
  composerMessageSending: "送信中",
  composerMessageSent: "送信済み",
  composerMessageFailed: "送信に失敗しました",
  composerRetry: "再送",
  composerRetryRouteChanged: "送信先の状態が変わったため再送できません",
  // 段6b: 構造化 @メンションによる決定的な宛先指定。
  mentionTokensAriaLabel: "指定した宛先",
  mentionMenuAriaLabel: "メンション候補",
  mentionNoMatches: "一致する宛先がありません",
  removeMention: (label: string): string => `@${label} を外す`,
  statusTemplatesAriaLabel: "定型質問",
  statusTemplateWhat: "これ何してたっけ？",
  statusTemplateGoal: "ゴールと残りは？",
  dispatchPreview: (count: number): string => `${count}件へ送ります`,
  dispatchInvalidTargets: "宛先が消えたか、作業中の宛先がありません。送信していません",
  dispatchPending: "送達確認待ち",
  dispatchConfirmed: "送達確認済み",
  dispatchUnconfirmed: "書き込み結果は未確認 (自動再送しません)",
  dispatchFailed: "送信前に失敗 (再送できます)",
  dispatchBlocked: "対象が変わったため送信していません",
  dispatchTargetMissing: "対象が消えたか別のセッションに置き換わりました",
  dispatchResultsAriaLabel: "分配送信の結果",
  dispatchResults: (count: number): string => `${count}件の送達結果`,
  dispatchRetryFailed: (count: number): string => `失敗した ${count}件だけ再送`,
  questionGuardConflict: "質問が更新されたため送信していません。もう一度「その他」を選んでください",
  dispatchMode: (kind: "plain" | "status-request" | "answer-forward" | "continue"): string => {
    if (kind === "status-request") return "定型質問";
    if (kind === "answer-forward") return "質問への回答";
    if (kind === "continue") return "次の一手";
    return "通常の指示";
  },
  // AI案 (NextActionSuggestions) の失敗表示 — 無言で消さない (2026-08-17 FB)
  aiSuggestionFailed: "AI案を作れませんでした",
  aiSuggestionFailureReason: (code: string): string => {
    if (code === "ai_disabled") return "AI機能がオフです";
    if (code === "cli_not_found") return "AI CLI が見つかりません";
    if (code === "cli_failed") return "AI CLI の実行に失敗しました";
    if (code === "invalid_output") return "AI の応答を解釈できませんでした";
    if (code === "timeout") return "応答が時間内に返りませんでした";
    if (code === "provider_model_mismatch") return "モデルとプロバイダの組み合わせが合っていません (設定 > AI とおまかせ)";
    if (code === "duplicate_request") return "同じ依頼が処理中です";
    if (code === "no_context") return "会話の記録がまだ無いため案を作れません";
    return "原因を特定できませんでした";
  },
  // 次の一手 v2 — 選択中チャット専用の AI 提案 (2026-08-20)。
  // 文言はここに集約し、NextActionSuggestions 側は非 ASCII を持たない (委譲先の文字化け防止)。
  nextActionAriaLabel: "次の一手",
  nextActionLoading: "次の一手を用意中… (会話を読んでいます)",
  nextActionRetry: "作り直す",
  nextActionRecommended: "推奨",
  nextActionSendPreviewTitle: "送る全文",
  nextActionSendConfirm: "この内容を送る",
  nextActionSendCancel: "戻る",
  nextActionFailed: (reason: string): string => `AI案を作れませんでした: ${reason}`,
  // パスリンクの操作 (DashboardLinkedText) — 失敗は無言にせず日本語で見える化 (2026-08-20)
  pathActionOpenDefault: "既定のアプリで開く",
  pathActionReveal: "ファイルの場所を表示",
  pathActionFailed: (reason: string): string => `開けませんでした: ${reason}`,
  // 「機械信号」「機械」は実装都合の語なので画面には出さない (2026-08-15 FB)。
  previewColumnTitle: "プレビュー",
  previewColumnEmpty: "ファイルのリンクを開くと、ここに表示します",
  reportInboxTitle: "報告インボックス",
  reportInboxHint: "届いた順に記録します",
  reportInboxRailIcon: "報",
  sessionListCollapse: "◀ 畳む",
  sessionListExpand: "▶",
  sessionListCollapseTitle: "セッション一覧を畳む",
  sessionListExpandTitle: "セッション一覧を開く",
  attentionTitle: "気づき",
  attentionWhyNow: "今知らせる理由",
  attentionImpact: "影響",
  attentionEvidence: "根拠",
  attentionReplyRoute: "返す先",
  attentionResolution: "解消の条件",
  attentionNoReplyRoute: "返答は不要です",
  attentionReplyToSession: "このセッションへ返します",
  attentionReplyToContract: "この実行契約へ返します",
  attentionResolveByAcknowledgement: "確認したときに解消します",
  attentionResolveWhenFinished: "実行が終わると解消します",
  attentionResolveWhenChanged: "状態が変わると解消します",
  attentionActionSucceeded: "操作しました",
  attentionActionFailed: "操作できませんでした",
  attentionActionLabel: (kind: PrimaryActionLabel): string => {
    if (kind === "answerQuestion") return "開いて答える";
    if (kind === "retryWorkItem") return "再試行";
    if (kind === "reviewConflict") return "契約を見る";
    if (kind === "raiseBudget") return "契約を見る";
    if (kind === "acknowledgeGoalReached") return "完了を確認";
    return "開く";
  },
  attentionKindLabel: (kind: AttentionKindLabel): string => {
    if (kind === "agentAsked") return "回答待ち";
    if (kind === "workStopped") return "停止を検知";
    if (kind === "reportsComplete") return "報告がそろいました";
    if (kind === "completionWithoutTests") return "確認が残っています";
    if (kind === "budgetReached") return "使える枠に達しました";
    if (kind === "outOfScopeWrite") return "作業先を確認してください";
    if (kind === "conflictDetected") return "食い違いを検知";
    if (kind === "goalReached") return "完了条件を満たしました";
    if (kind === "nextItemReady") return "次の作業を始められます";
    if (kind === "sessionBoardIncident") return "調整事項";
    return "対応をまとめました";
  },
  // 段1: 実行契約カード
  contractTitle: "実行契約",
  contractAriaLabel: "実行契約",
  contractAfterGoAriaLabel: "GO 後の実行契約",
  contractAiPlan: "計画=AI案",
  contractMachineNumbers: "数字=機械",
  contractBeforeGo: "GO 前 · 副作用なし",
  contractPurpose: "目的",
  contractMaterials: "素材",
  contractExecution: "実行",
  contractReferenceLabel: "参照位置",
  contractWrite: "書込み",
  contractCompletion: "完了条件",
  contractCoverage: "取得状況",
  contractRoleMaterial: "素材",
  contractRoleWork: "作業",
  contractRoleIntegrator: "統合役",
  contractRoleReview: "レビュー",
  contractRoleCaret: "▾",
  contractRoleMenuFor: (label: string): string => `@${label} の役割を選ぶ`,
  contractNewSession: "新規セッション 1",
  contractExecutionDetail: (agent: string): string => `${agent} で起動します`,
  contractReference: (label: string, eventId: string): string => `${label}:#${eventId}`,
  contractReferenceSeparator: " ｜ ",
  contractReferencePending: "確認中",
  contractReferenceRefreshing: "役割変更後の参照位置を取り直しています",
  contractWriteTarget: "この実行契約専用の作業フォルダ",
  contractWriteUnavailable: "この場所では専用の作業フォルダを用意できません",
  contractWritePending: "作業先を確認中",
  contractWriteRefreshing: "役割変更後の作業先を取り直しています",
  contractBranchProtection: "(本ブランチには触りません)",
  contractCoverageSummary: (target: number, acquired: number, missing: number, failed: number): string => `対象${target} ｜ 取得${acquired} ｜ 未取得${missing}${failed ? ` ｜ 失敗${failed}` : ""}`,
  contractPromptSummary: "統合役に実際に渡す内容",
  contractPromptPending: "確認中",
  contractNoSourceSend: "素材セッションには何も送りません",
  contractFix: "直す",
  contractCancel: "やめる",
  contractGo: "GO — 1セッション起動",
  contractMissingIntegrator: "まとめ役が決まっていません。どれか1つを統合役にしてください",
  contractMultipleIntegrators: "まとめ役が複数です。統合役を1つにしてください",
  contractMissingSources: "未取得の素材があるため、GO は実行できません",
  contractWorkingDirectoryUnavailable: "選択中のセッションの作業ディレクトリを確認できません",
  contractPreparing: "計画を確認中です",
  contractRefreshing: "役割の変更を反映して、計画を取り直しています",
  contractOperationFailed: "計画を確認できませんでした",
  contractRepositoryUnavailable: "選択中の作業フォルダはリポジトリではありません",
  contractSourceAcquisitionFailed: "素材を取得できていません",
  contractAlreadyStarted: "すでに開始済みのため、新しいセッションは起動していません",
  contractCorrectionHint: "役割チップを押して内容を直してください",
  contractPlanSealed: "計画v1 · 確定済み",
  contractRunSources: "素材の取り込み",
  contractRunSourcesAcquired: (count: number): string => `${count}件を取得済み`,
  contractRunSourcesPartial: "一部を取得できていません",
  contractRunSession: "統合用セッション",
  contractLaunchPending: "起動要求はまだ処理されていません",
  contractLaunchChecking: "起動結果を確認中です",
  contractLaunchDelivered: "起動済み",
  contractLaunchFailed: "起動失敗",
  contractLaunchUnknown: "まだ分かりません",
  contractLaunchFailureUnknown: "起動処理から理由を取得できませんでした",
  contractLaunchFailureFrontend: "画面側でセッションを起動できませんでした",
  contractRetryLaunch: "もう一度起動する",
  contractDismissRunning: "表示を閉じる",
  contractHiddenPath: "非表示の場所",
  contractSourceNameUnknown: "名前を確認できない素材",
  contractPromptSnapshotUnavailable: "素材の記録を取得できませんでした",
  contractPromptTelemetryUnavailable: "セッションの状況を取得できませんでした",
  contractPromptStatusUnavailable: "状況を取得できませんでした",
  contractRunTests: "統合テスト",
  contractRunUnknown: "まだ分かりません",
  contractRunMerge: "本ブランチへの反映",
  contractHumanApprovalRequired: "人の承認が必要",
  futureSchemaUnsavedQuitPrompt: "新しい形式の設定ファイルを検出したため、この起動中の変更は保存されません。終了しますか？",
} as const;

export const tabGroupingStrings = {
  buttonLabel: "タブ再配置",
  buttonBusy: "再配置を分析中…",
  panelAriaLabel: "タブ再配置",
  title: "タブ再配置",
  stepCompare: "1 案を比較",
  stepEdit: "2 内容を編集",
  stepConfirm: "3 適用前確認",
  analyzing: "全ワークスペースを分析しています…",
  // Each stage names what is happening, so the elapsed seconds read as
  // "still working on this" rather than "nothing is happening". Repeating
  // "分析しています" after the stage would just say the same thing twice.
  analysisStage: (stage: "scanning" | "judging" | "validating" | "retrying"): string => ({
    scanning: "全ワークスペースを走査中",
    judging: "配置を判定中",
    validating: "結果を検証中",
    retrying: "もう一度判定中",
  })[stage],
  analysisProgress: (
    stage: "scanning" | "judging" | "validating" | "retrying",
    seconds: number,
  ): string => `${tabGroupingStrings.analysisStage(stage)}… ${seconds}秒`,
  analysisSlowHint: "タブが多いと1〜2分かかります",
  judgeReadyKeepingCurrent: "AI の案ができました。いまの案を編集中なので、切り替えるときは「再分析する」を押してください。",
  localPlanWhileJudging: "表示中の案は作業フォルダと系譜から組んだものです。このまま編集・適用できます。",
  analyzeAgain: "再分析する",
  analyzed: "分析完了",
  unassignedTitle: "未分類",
  moveToUnassigned: "未分類へ",
  applyZeroMoves: "動かすタブがありません",
  warningsTitle: "警告",
  close: "閉じる",
  empty: "再配置できる生きたターミナルがありません",
  comparisonInsufficient: "比較できる案が1件しかありません",
  strategyProject: "案件",
  strategyRole: "役割",
  strategyMinimal: "移動最小",
  strategyMixed: "複合",
  movedCount: (n: number): string => `移動 ${n}`,
  newWorkspaceCount: (n: number): string => `新規WS ${n}`,
  keptCount: (n: number): string => `現状維持 ${n}`,
  warningCount: (n: number): string => `警告 ${n}`,
  showCurrent: "現在を表示",
  showAfter: "適用後を表示",
  adopt: "採用",
  defer: "保留",
  deferredHint: "現状位置に残します",
  changeDestination: "変更",
  destinationCurrent: "現状位置に残す",
  destinationExisting: "既存ワークスペースへ合流",
  destinationNew: "新しいワークスペース",
  newGroup: "＋新しいグループ",
  moveSelected: "移動先…",
  selectedTabs: (n: number): string => `${n}件を選択中`,
  paneRoleMother: "母艦",
  paneRoleWorker: "作業",
  paneRoleReview: "レビュー",
  paneRoleMixed: "混在",
  paneRoleUnspecified: "未指定",
  confirmCurrent: "現在",
  confirmAfter: "適用後",
  confirmDiff: "差分",
  confirmSideBySide: "並べて見る",
  sideBySideLegend: "線は別のワークスペースへ移るタブ / 線の色は移動先のワークスペース / タブをクリックすると1本だけ固定して追えます",
  sideBySideDiffCount: (crossCount: number, withinCount: number): string => (
    withinCount === 0
      ? `移動 ${crossCount}件（すべて WS 跨ぎ）`
      : `移動 ${crossCount + withinCount}件（うち WS 跨ぎ ${crossCount}件・同 WS 内 ${withinCount}件）`
  ),
  moveBadgeColumns: (fromColumn: number, toColumn: number): string => `列${fromColumn} → 列${toColumn}`,
  moveBadgePanes: (fromPaneTitle: string, toPaneTitle: string): string => `${fromPaneTitle} → ${toPaneTitle}`,
  moveBadgeAriaLabel: (label: string, detail: string): string => `${label} は同じワークスペース内で ${detail} へ移ります`,
  liveStatusWorking: "作業中",
  liveStatusWaiting: "返答待ち",
  liveStatusDone: "完了",
  liveStatusError: "エラー",
  liveStatusIdle: "待機",
  lineageChild: (parentName: string): string => `${parentName} から起動`,
  lineageOrphan: "起動元のタブは残っていません",
  sideBySideGroupAriaLabel: (side: string): string => `${side}の配置図。矢印キーでタブを移動できます`,
  liveChipAriaDescription: (status: string, age: string | null): string => (
    age ? `${status}・最終出力から${age}` : status
  ),
  sideBySideMoveAriaDescription: (fromWorkspaceName: string, toWorkspaceName: string): string => (
    `${fromWorkspaceName} から ${toWorkspaceName} へ`
  ),
  sideBySideNoMoves: "移動するタブはありません",
  apply: "適用",
  applying: "適用しています…",
  applyBlocked: "状態が変わったため適用できません。差分を確認して編集に戻ってください。",
  applyPlanChanged: "確認後に再配置案が変更されました。もう一度確認してください。",
  applyInvalidInput: "適用内容を確認できませんでした。編集に戻って内容を見直してください。",
  applyMismatch: "適用結果が想定と一致しなかったため元に戻しました。",
  applySchemaIncompatible: "保存形式が更新されたため適用できません。アプリを再起動してください。",
  applyOperationInProgress: "別の再配置処理が実行中です。完了してからもう一度お試しください。",
  prepareFailed: "適用前確認を準備できませんでした。",
  ticketInvalidated: "レイアウトが変わったため、適用前確認をやり直しました。",
  emptyWorkspaces: (n: number): string => `${n}個のWSが空になりました`,
  inspectEmpty: "確認する",
  notDeleted: "削除されません",
  newBadge: "新規",
  undoApplied: (n: number): string => `再配置を適用しました — ${n}タブ移動`,
  undoAppliedUnknown: "再配置を適用しました",
  undo: "元に戻す",
  undoRestored: "再配置を元に戻しました",
  undoReview: "変更内容を見る",
  undoExpired: "その後レイアウトが変更されたため元に戻せません",
  undoMissing: "戻せる再配置がありません",
  undoRestoreFailed: "元に戻せませんでした。現在の配置を確認してください。",
  undoPostFailed: "再配置は元に戻しましたが、保存処理を完了できませんでした。現在の配置を確認してください。",
  recallUndo: "直前の再配置",
  headCounts: (tabs: number, workspaces: number): string => `${tabs}タブ / ${workspaces}ワークスペース`,
  planEditing: (title: string): string => `${title} を編集中`,
  toEdit: "この案を編集",
  confirmPlan: "この案で確認",
  editPlan: "内容を編集",
  changedOnly: "変更対象のみ表示",
  editMapLegend: "タブを選んで、右の配置図の移動先ペインをクリックします",
  keepTrayHint: "ここへ入れたタブは現在の位置に残ります",
  emptyGroupDropHint: "タブをここへ戻すと、元の配置を復元します",
  dragGhostCount: (count: number): string => `${count}件`,
  dragCancelAnnounce: "移動を取り消しました",
  dragNoopAnnounce: "移動先が同じため変更しませんでした",
  dragTargetGoneAnnounce: "移動先が見つからないため取り消しました",
  dropPickerHint: "矢印キーで移動先を選び、Enter で確定、Esc で中断します",
  dragCancelHint: "ドラッグ中に Esc を押すと中断できます",
  moveAnnounce: (count: number, destination: string): string => `${count}件を${destination}へ移動しました`,
  keepAnnounce: (count: number): string => `${count}件を現在の位置に残しました`,
  dispositionLabel: (title: string) => `${title}の扱い`,
  dispositionReorganize: "再配置する",
  dispositionKeep: "現状維持",
  stateMoved: "移動",
  stateKept: "現状維持",
  stateUnassigned: "未分類",
  editSummary: (moved: number, kept: number, unassigned: number) => `${moved}タブ移動 / ${kept}タブ現状維持 / ${unassigned}タブ未分類`,
  dropTargetLabel: (workspaceName: string, paneTitle: string) => `${workspaceName} の ${paneTitle} へ移動`,
  dropDestinationLabel: (workspaceName: string, paneTitle: string) => `${workspaceName} の ${paneTitle}`,
  retryPrepare: "もう一度確認する",
  durabilityPending: "保存中です。アプリを終了しないでください。",
  goConfirm: "適用前確認へ",
  backToCompare: "案の比較へ戻る",
  backToEdit: "編集へ戻る",
  planMoveNote: (n: number): string => `この案で ${n}タブ移動`,
  unassignedCount: (n: number): string => `未分類 ${n}`,
  previewLegend: "青=移動するタブ / 黄=未分類のタブ / 破線=新しいワークスペース",
  adoptSwitchLabel: (title: string): string => `${title}を採用する`,
  groupAdoptedMeta: (n: number): string => `新規ワークスペース・${n}タブ`,
  destinationHeading: (name: string): string => `移動先: ${name}`,
  selectHint: "タブをクリックで選択",
  columnLabel: (n: number): string => `列${n}`,
  emptyColumn: "（空）",
  fromWorkspace: (name: string): string => `${name}から`,
  excludeToCurrent: "除外して現状維持",
  confirmSummary: (moved: number, created: number, kept: number): string => `${moved}タブを移動 / ${created}個のワークスペースを作成 / ${kept}タブは現状維持`,
  confirmSummaryNote: "適用は1回で確定し、「元に戻す」で元の配置に戻せます。空になったワークスペースは削除されません。",
  undoDismissLabel: "閉じる",
  newGroupTitle: "新しいグループ",
  stepsAriaLabel: "手順",
  tabCount: (n: number): string => `${n}タブ`,
  statusPoisoned: "タブ再配置の復旧確認に失敗しました。安全のため、この機能を停止しました。現在のターミナルは引き続き使用できます。作業内容を確認してアプリを再起動してください。レイアウトは保存されません。再起動で最後の正常状態に戻ります。",
  statusCopyDiagnostics: "診断情報をコピー",
  statusInspectLayout: "現在の配置を確認",
  statusRestartApp: "アプリを再起動",
  statusUndoAvailable: "タブの再配置を適用しました。",
  statusUndo: "タブの再配置を元に戻す",
  statusDismiss: "×",
  statusDurabilityWarning: "再配置は適用されましたが、ディスクへの保存を確認できません。アプリを終了せず、再保存を待ってください。",
  unnamedTab: "無名タブ",
  undoEdit: "元に戻す (編集)",
  resetToAiPlan: "AI 案に戻す",
  renameLabel: "名前を編集",
  liveLegendWithParentRef: "●は作業中 / ◐は返答待ち / ✓は完了 / ✗はエラー / 数字は最終出力からの経過 / ↑は起動元",
  liveParentRef: (parentName: string, parentWorkspaceName: string | null): string => (
    parentWorkspaceName ? `↑${parentWorkspaceName}/${parentName}` : `↑${parentName}`
  ),
  liveParentRefAriaLabel: (parentName: string, parentWorkspaceName: string | null): string => (
    parentWorkspaceName
      ? `${parentWorkspaceName}の${parentName}から起動`
      : `${parentName}から起動`
  ),
} as const;
