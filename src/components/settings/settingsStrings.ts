export const settingsStrings = {
  remoteTabLabel: "スマホ・リモート操作",
  remoteDescription: "スマホや別のブラウザから、今このPCで開いている端末を操作します。セーブポイントとは別の機能です。",
} as const;

// 委譲を見守る機能の画面語。内部の dispatchWatchdog* 識別子とは分ける。
export const delegationWatchStrings = {
  heading: "委譲の見守り",
  description: "バックグラウンドで動かしている AI タブを定期的に確認し、質問待ち・完了未確認・見守りの停滞を通知します。",
  enabledLabel: "見守りを有効にする",
  sensitivityTitle: "通知の敏感さ",
  sensitivityAriaLabel: "見守り通知の敏感さ",
  sensitivityPresetLabel: (id: "relaxed" | "standard" | "eager"): string => {
    if (id === "relaxed") return "控えめ";
    if (id === "eager") return "敏感";
    return "標準";
  },
  sensitivityDescription: (intervalMinutes: number, stallMinutes: number): string => `${intervalMinutes}分ごとにチェック・見守りの停滞が${stallMinutes}分続くと通知`,
  customSensitivity: "カスタム",
  currentSensitivity: (intervalMinutes: number, stallMinutes: number): string => `現在の設定: ${intervalMinutes}分ごとにチェック・見守りの停滞が${stallMinutes}分続くと通知`,
  notifyTitle: "見守りの通知",
  notifyLabel: "見守りの通知を出す",
  notifyHint: "「通知とレイアウト」の通知をオフにしている間は、ここをオンにしてもトーストとバッジは出ません。",
  queueTitle: (count: number): string => `いま気になっているタブ (${count}件)`,
  queueEmpty: "問題は見つかっていません。",
  queueUnknownSubject: "セッション",
  queueContinuing: (elapsed: string, confirmations: number): string => `${elapsed}継続・連続確認 ${confirmations} 回`,
  additionalQueueItems: (count: number): string => `ほか ${count} 件の要確認があります`,
  kindLabels: {
    ask: "判断待ち",
    rate_limited: "レート制限で待機中",
    done_unverified: "完了・未確認",
    done_needs_review: "確認が必要な完了",
    no_log: "ログ未作成",
    stalled: "見守りの停滞",
    timeout: "タイムアウト",
    tab_no_output: "出力停止",
    tab_queued_input: "未送信の入力",
    tab_silent: "無応答で停止",
  },
  dormancyTitle: "休眠セッションの整理",
  dormancyDescription: "非表示で休眠した Claude / Codex セッションを終了するまでの時間です。0分は自動整理を止めます。",
  dormancyAriaLabel: "休眠セッションを整理するまでの時間",
  dormancyPreset: (minutes: number): string => minutes === 0 ? "自動整理しない" : `${minutes}分後`,
} as const;

export const autonomySettingsStrings = {
  heading: "自律モード",
  autoAdvanceLabel: "実行契約の次の作業を自動で始める",
  autoAdvanceHint: "オフにすると、次の作業はカードでお知らせし、開始はあなたが押します。",
  attentionCardsLabel: "先回りカード (気づき)",
  attentionCardsHint: "オフにすると、新しいお知らせカードを作りません (表示済みのカードは残ります)。",
} as const;

export const notificationSettingsStrings = {
  title: "通知",
  enabledLabel: "通知",
  enabledHint: "オフにすると、左上のベルも右下のトーストも出しません。",
  soundLabel: "通知サウンド",
  bellCategoryTitle: "左上のベル",
  bellQuestionLabel: "質問を知らせる",
  bellApprovalLabel: "承認待ちを知らせる",
  bellWorkDoneLabel: "作業完了を知らせる",
  bellUnreadLabel: "その他の未読を知らせる",
  bellHint: "ベルに出す種類です。オフにした種類はベルの一覧にもバッジの数にも入りません。ベルの通知はパネルの「すべて既読にする」か各行の × で消せます。",
  toastCategoryTitle: "右下トースト",
  toastAiActivityLabel: "AIの自動処理結果",
  toastUserActionLabel: "操作の結果",
  toastSystemLabel: "システム・接続",
  toastFailureAlwaysShownHint: "失敗・エラーは通知設定に関わらず常に表示します。",
  layoutTitle: "レイアウト",
  splitRightLabel: "「右に分割」ボタンを表示",
  splitDownLabel: "「下に分割」ボタンを表示",
  groupingApplyAnimationLabel: "タブ再配置の適用時に動きを表示",
  groupingApplyAnimationHint: "オフにすると、配置図から実画面への移動を省略して即時に切り替えます。Windows のアニメーション効果をオフにしている場合も動きません。",
  terminalInputTitle: "ターミナル入力",
  paneComposerLabel: "ペインの下に入力欄を出す",
  paneComposerHint: "文字を選んで消す・書き直すといった編集ができる入力欄です。Enter で送信、Shift+Enter で改行。ペインが低いときは自動的に隠れます。",
} as const;

export const aiSettingsStrings = {
  tabLabel: "AI",
  automationTabLabel: "自動化",
  enableLabel: "AI機能を有効にする",
  enableHint: "オフにすると下の機能がすべて止まります",
  providerTitle: "使用する AI",
  modelTitle: "モデル",
  customModelLabel: "カスタム…",
  featureTitle: "この設定で動く機能",
  automaticBadge: "自動",
  manualBadge: "ボタンで実行",
  features: {
    autoPaneNaming: {
      label: "タブの自動命名",
      disclosure: "画面末尾14行・作業フォルダ・ペイン構成を送ります",
    },
    replyDraft: {
      label: "返信案の準備",
      disclosure: "ダッシュボードの会話末尾を送ります",
    },
    reportInboxSummary: {
      label: "報告インボックスの要約",
      disclosure: "報告本文を送ります",
    },
    tabSweep: {
      label: "タブ整理のAI判定",
      disclosure: "各タブの画面末尾8行と作業フォルダを送ります",
    },
    ailogSession: {
      label: "ailog セッション要約",
      disclosure: "セッションログ全文を送ります（トークン消費が大きい機能です）",
    },
    ailogBatch: {
      label: "ailog 一括要約",
      disclosure: "選択したセッションのログを順に送ります",
    },
    tabRelayout: {
      label: "タブ再配置（準備中）",
      disclosure: "監査完了まで利用できません",
    },
  },
  modelMismatch: (providerLabel: string): string =>
    `このモデルIDは ${providerLabel} のものではないようです。このまま使うと実行時に失敗する可能性があります。`,
  modelCustom: "候補一覧にないモデルIDです。そのまま使用します。",
  disabledReason: "設定 > AI で「AI機能を有効にする」がオフになっています",
} as const;

// タブ名の自動命名 (AI が無名タブに名前を付ける定期ジョブ) の文言。
export const autoPaneNamingStrings = {
  title: "タブ名の自動命名",
  label: "名前のないタブに AI が名前を付ける",
  hint: "作業内容から短い名前を自動で付けます。あなたが自分で付けた名前は書き換えません (名前をリセットすると、また自動命名の対象に戻ります)。",
  disabledByAiHint: "「AI機能を有効にする」がオフの間は動きません。",
  toastApplied: (count: number): string => `タブ名を${count}件つけました`,
  toastUndo: "元に戻す",
  toastUndone: "タブ名を元に戻しました",
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
  importHint: "Codex の pet 規格 (8列×9行 / 8列×11行アトラス) をそのまま読みます。~/.codex/pets/ に置くだけで候補に並びます。",
  rescanButton: "今すぐ再スキャン",
  assignTitle: "ワークスペースごとの割り当て",
  assignHint: "決まった後でも変更できます。",
  rerollButton: "振り直す",
  changeButton: "変更 ▸",
  bundledSourceLabel: "同梱",
  externalSourceLabel: "取り込み",
  // ギャラリー (codex-pets.net 内蔵・2026-08-11) で追加
  galleryTitle: "ギャラリーから探す (codex-pets.net)",
  galleryHint: "検索してワンクリックで取り込めます。保存先は ~/.codex/pets/。",
  gallerySearchPlaceholder: "ペット名・タグで検索",
  galleryInstall: "取り込む",
  galleryInstalled: "取り込み済み",
  galleryInstalling: "取り込み中…",
  galleryPrev: "← 前へ",
  galleryNext: "次へ →",
  galleryCount: (total: number): string => `全${total}件`,
  galleryEmpty: "見つかりませんでした",
  galleryError: "ギャラリーの取得に失敗しました",
  galleryInstallError: "取り込みに失敗しました",
  galleryQuarantine: "隔離する",
  petPickerTitle: "キャラを選ぶ",
  petPickerCancel: "やめる",
  petQuarantineAction: "隔離する (候補から外す)",
  petQuarantineHint: "ファイルは削除せず ~/.codex/pets/_disabled/ へ移します。",
  invalidTitle: "読み込めなかった pet",
  invalidHint: "規格外のためそのままでは表示できません。隔離すると候補から消えます (ファイルは削除しません)。",
  quarantineButton: "_disabled へ移す",
  quarantinedTitle: "隔離中の pet",
  quarantinedHint: "~/.codex/pets/_disabled/ にあります。戻すと再び候補に並びます。",
  restoreButton: "戻す",
} as const;
