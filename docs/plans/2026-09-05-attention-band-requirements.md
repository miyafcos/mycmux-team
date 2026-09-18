# 「要対応の帯」と通知の小窓 要件定義 (2026-09-05)

読者 = この実装を担当するエージェント / 語り手 = mycmux 開発者 (弊社) / 相手 = 宮崎さん (GO 判断) / その先 = 公開ミラー `miyafcos/mycmux-team` の閲覧者。

モック (静止・実寸): `C:/Users/miyaz/.claude/dispatch/260905-mycmux-ux-review/mocks_v2/m1a_band_titlebar.html` (帯・id `m1a-app` / `m1a-band-only` / `m1a-band-only-light`)、同 `m4_bell_popover.html` (通知の小窓・id `m4-popover`)、Astra の `astra/mock_focus.html` (帯から会話へ)。
出典の報告: `C:/Users/miyaz/reports/mycmux_UX設計見直し_20260905.html` 3 章・6 章。
前段の設計: `docs/plans/2026-09-03-launcher-redesign-requirements.md` (React ペイン化・240px・マウス/キー両完結)。

---

## 1. 背景

### 1.1 依頼 (2026-09-05 宮崎さん)

> 今の機能を満たした上で、さらに高次元で使いやすく、見やすく、動作も軽い設計を。(設計見直しの報告を受けて) 進めておいてください。

報告の判断 3「提案 1 (帯) を案 A で要件定義へ。行き先は『会話 + 端末へ』。提案 4 の改訂案を同じ便に含める」を受けた要件定義。

### 1.2 実測した現状

| # | 事実 | 出典 |
|---|---|---|
| P1 | 実運用は 3440px に 1 ワークスペース・11 ペイン横並び (1 ペイン ≈ 300px)。全ペインが Claude Code / Codex | 2026-09-05 13:30 の実機画面 (`_素材/screenshot_260905_1330_3440x1392.png`) |
| P2 | 返事待ち・承認待ちの検知は揃っている (`sessionAttentionStore.ts` 418 行・`attentionStore.ts` 120 行・`attentionPresentation.ts`)。全ワークスペース分を持つ | `src/stores/sessionAttentionStore.ts` / `src/components/dashboard/attentionModel.ts` |
| P3 | 見える場所はダッシュボード (全画面・`Ctrl+Shift+G`) の気づきカード・質問ストリップと、タイトルバーのベルのドット、サイドバー行のバッジだけ。主画面 (端末列) に「誰が待っているか」を並べる面は無い | `src/components/layout/TitleBar.tsx:208` (ベル) / `TabItem.tsx:167` (バッジ) / `DashboardView.tsx:1101` |
| P4 | タイトルバー中央は `TERMINAL · <ワークスペース名>` の文字だけで、ドラッグ領域を兼ねる (300ms 以内の 2 クリックで最大化) | `TitleBar.tsx:300-345` / README §4「タイトルバーのボタン」 |
| P5 | `Ctrl+Alt+A` (`pane.attention.next`) が「次の注意へ」の順送りを持つ。順序は ADR 0011 (待っている人と重さで並べる) | `src/lib/keybindings.ts` / `docs/adr/0011-attention-order-by-who-waits-and-severity.md` / `dashboardAttentionOrder.ts` |
| P6 | 通知パネル (ベル) の行は `div` の click 専用で、1 行 = ワークスペース名・ラベル・件数・最終ログ。クリックで端末へ移り通知を消す | `src/components/layout/NotificationPanel.tsx:22-69, 139` |
| P7 | 質問カード (`QuestionCard.tsx`) は session ID・PTY 世代・状態 revision・入力 revision で照合し、古い質問には送信しない | `docs/adr/0003-askuserquestion-input-contract.md` / README §9 |
| P8 | 同じ出来事を知らせる面が 9 つ (通知パネル・トースト・バッジ/ドット・質問ストリップ・質問カード・気づきカード・報告インボックス・次の一手・見守り行)。独立したイベント源が 9 つあるわけではない | 報告 6 章 / Astra レビュー §2 A |
| P9 | 同時にマウントされるワークスペースは 1 つ (`MAX_MOUNTED_WORKSPACES = 1`)。非表示ワークスペースの端末は保持されないが、検知データは残る | `src/components/workspace/WorkspaceView.tsx:26, 396` |

### 1.3 既にある土台 (作らずに呼ぶ)

| # | 事実 | 出典 |
|---|---|---|
| T1 | 注意の表示モデル: 理由・影響・根拠・返す先・解消条件・主行動を持つ `AttentionCards` と、順序 `dashboardAttentionOrder.ts` | `src/components/dashboard/AttentionCards.tsx` / `attentionModel.ts` |
| T2 | エージェント種別の公式マーク `AgentKindIcon({ kind, size, chip })` と種別色 `KIND_COLORS` | `src/components/icons/AgentIcons.tsx` / `src/lib/agentKindColors.ts` |
| T3 | ペインへ移る処理: `Ctrl+Alt+A` の実装 (アクティブ化 + フォーカス) と、ダッシュボードの行ダブルクリック (`openDashboardForTab.ts` の逆方向) | `AppShell.tsx` の `pane.attention.next` / `focusController.ts` |
| T4 | 会話を読む面: ダッシュボードのチャット列 (`ChatColumn.tsx`) と質問カード。`openDashboardForTab(tabId)` で特定タブの列を開ける | `src/components/layout/openDashboardForTab.ts` |
| T5 | ポップオーバーの部品: `OverlayShell` (inert・最上位 Esc・フォーカス復帰) と `useDismissOnOutside` | `src/components/common/OverlayShell.tsx` / `src/hooks/useDismissOnOutside.ts` |
| T6 | 通知の既読規則: `collectNotificationEntries` と `paneMetadataStore` の通知カウント | `src/lib/notificationEntries.ts` / `src/stores/paneMetadataStore.ts` |
| T7 | トースト: 最大 2 操作・本文クリックで消す | `src/components/common/ToastHost.tsx` |

---

## 2. 決定事項

- **D1. 帯はタイトルバー中央に置く。** いまの `TERMINAL · <ワークスペース名>` の領域を帯にする。ワークスペース名は帯の左端に小さく残す (最大化のダブルクリック領域は帯の余白で維持)。
- **D2. 帯に出すのは「要対応」だけ。** 質問 (AskUserQuestion) と承認 (permission) の 2 種を「回答 N」「確認 N」の見出し札 + 席の札で出す。完了・報告は帯に出さない (6 章の小窓の「未読の到着」へ)。
- **D3. 席の札を押すと「会話を読む場所」へ行き、「端末へ」で戻る。** 既定の行き先はダッシュボードの該当タブの会話列 + 質問カード (`openDashboardForTab`)。会話列に「端末へ」ボタンを置き、押すとダッシュボードを閉じてそのペインをアクティブにする (T3)。`Shift+クリック` は端末へ直行 (Astra 案との両立)。
- **D4. 帯は全ワークスペースの席を出す。** 非表示ワークスペースの席は札の左に小さくワークスペース名を添える。押すとそのワークスペースへ切り替えてから D3 の動きをする。
- **D5. 帯が空のときは何も出さない。** 「要対応なし」の文字も置かない (静かに保つ)。
- **D6. 通知の小窓 (ベル) を 2 区分にする。** 上「要対応 (質問 N・承認 N)」= 行に「開いて答える」だけで既読ボタンは無い。下「未読の到着 (完了 N・報告 N)」= 行に「開く」と、区分の右に「この区分を既読に」。要対応の件数は「開いて答える」→ 回答完了でしか減らない。
- **D7. トーストは「一覧に入りました」の 1 行だけにし、操作ボタンは最大 1 (「開く」)。** 継続課題はトーストで完結させず、小窓の一覧へつなぐ。
- **D8. 既存の入口は全部残す。** `Ctrl+Alt+A` の順送り、ダッシュボードの気づきカード・質問ストリップ、サイドバーのバッジ、通知サウンド、報告インボックスの 3 モードは変えない。帯と小窓は入口を足すだけ。
- **D9. 検知・順序・照合は既存を呼ぶ。** 帯の並びは `dashboardAttentionOrder.ts` (ADR 0011)、回答は既存 `QuestionCard` (ADR 0003 の revision 照合)。新しい store を作らない。

### 2.1 非目標

- 帯に完了・報告・停滞を出す (要対応だけ)
- 帯からの直接回答 (回答は質問カードで。帯は入口)
- 通知パネルの削除 (2 区分化するだけ。既読規則も変えない)
- 右クリックメニュー (方針どおり作らない)
- サイドバーの「席のレール」(案 B) — 帯を 1 週間使ってから判断

---

## 3. 画面仕様

**幅は 1200px を基準、11 列の 3440px でも同じ帯。** タイトルバー中央の可用幅 (左右のボタン群を除いた幅) に収める。

- **S1. 帯の構成 (左から)**: ワークスペース名 (小・省略可) → 見出し札「回答 N」「確認 N」(N > 0 のものだけ) → 席の札 (最大 5 個・6 個目以降は「+N」の札で小窓を開く) → 右端に何も置かない (ベルはタイトルバー右のまま)。
- **S2. 席の札**: `[種別マーク 14px][短いラベル (中間省略・最大 10 文字)][種別語: 質問 / 承認]`。高さ 22px・角丸 999・境界 1px `--cmux-border`・背景 `--cmux-surface-raised`。質問は `--cmux-status-waiting` 系の枠色、承認は `--cmux-yellow` 系。**色だけに頼らず種別語を必ず出す**。
- **S3. hover / focus**: 札の下に理由 1 行のツールチップ (`title` ではなく描画・11px 以上) — 例「回答待ち・方針を選ぶ」。キーボードでは帯に `Tab` で入り、`←→` で札を移動、`Enter` で D3、`Esc` で帯から出る。
- **S4. 並び順**: `dashboardAttentionOrder.ts` の順 (待っている人と重さ)。同じ席に質問と承認が重なるときは 1 つの札にまとめ、種別語を「質問・承認」と並記する (件数を単純加算しない)。
- **S5. 更新**: 検知 store の変化で即時。トーストは出さない (D7 の「一覧に入りました」は小窓側)。帯の札が増減してもタイトルバーの高さは変えない。
- **S6. ライト/ダーク**: 既存トークンだけを使う。`tokenContract` / `themeContrast` を通す。
- **S7. 小窓 (ベル)**: 幅 380px・`OverlayShell` (T5)。上区分の行 = `[マーク][ラベル][理由 1 行][開いて答える]`、下区分の行 = `[マーク][ラベル][到着の要旨 1 行][開く]`。下区分の見出し右に「この区分を既読に」。`↑↓` で行、`Enter` で主行動、`Esc` で閉じてベルにフォーカス復帰。
- **S8. 日本語 11px 以上・横スクロール禁止・記号は種別語と併記。**

---

## 4. データと起動経路

- **DS1. 帯の元データ** = `sessionAttentionStore` の要対応 (質問・承認) を `attentionModel.ts` の表示モデルに通したもの。新しい取得やポーリングを足さない。
- **DS2. 小窓の下区分** = `collectNotificationEntries` (T6) の未読 (完了・報告)。既読規則は既存のまま。
- **L1. 札 → 会話**: `openDashboardForTab(tabId)` → 該当列の質問カードへスクロール・フォーカス。
- **L2. 会話 → 端末へ**: ダッシュボードを閉じて `focusController` 経由でペインをアクティブ化 (T3 の `pane.attention.next` と同じ関数を再利用)。
- **L3. 非表示ワークスペースの席**: ワークスペース切替 → L1。切替中に検知が消えていたら (回答済み) 何もせず帯を更新。

---

## 5. 現行機能の保存 (全数)

| 面 | 残すもの | 根拠 |
|---|---|---|
| 通知パネル | 一覧・クリックで端末へ・全消去・既読規則 | `NotificationPanel.tsx` / README §13 |
| `Ctrl+Alt+A` | 次の注意への順送り | `keybindings.ts` |
| ダッシュボード | 気づきカード・質問ストリップ・質問カード・報告インボックス 3 モード・次の一手・見守り行 | README §9 |
| サイドバー | 行のバッジ・未読リング | `TabItem.tsx` |
| タイトルバー | 全ボタン (サイドバー・ベル・セーブポイント・新規・アカウント・AI ログ・ダッシュボード・設定・窓操作)・ダブルクリック最大化・ドラッグ | README §4 |
| 質問の照合 | revision / epoch / inputRevision の一致で送信、不一致なら送らない | ADR 0003 |

---

## 6. 受入条件 (機械検査)

1. fixture: 11 セッション (質問 2・承認 1・正常 8)。帯に見出し札「回答 2」「確認 1」と席の札 3 個が ADR 0011 の順で出る。正常 8 席は出ない。
2. 質問と承認が同じ席にあるとき、札は 1 個で種別語が「質問・承認」。件数は「回答 1」「確認 1」。
3. 札クリック → `openDashboardForTab` が該当 tabId で 1 回呼ばれ、質問カードが表示される。`Shift+クリック` → ペインがアクティブになりダッシュボードは開かない。
4. 帯に `Tab` で入り `→` `→` `Enter` で 3 個目の札が開く。`Esc` で帯から出て元のフォーカスに戻る。
5. 回答完了 (revision 一致で送信) 後、帯の札が消える。閲覧だけでは送信 0。
6. 小窓: 要対応区分の行に既読ボタンが無い。「この区分を既読に」は未読区分だけを既読にし、要対応の件数は変わらない。
7. 非表示ワークスペースの席の札を押すと、ワークスペースが切り替わってから会話列が開く。
8. トースト: 文面が 1 行・操作は最大 1。
9. 1200px と 3440px (11 列) でタイトルバーの高さ不変・横スクロール 0・日本語 11px 以上。
10. 既存契約 (`tokenContract` / `themeContrast` / `uiDensity` / `uiQualityTokens` / `attentionCards.test.tsx` / `askQuestionCard.test.tsx` / `notificationEntries.test.ts` / `focusController.test.ts`) 全緑。`Ctrl+Alt+A` のテスト不変。

---

## 7. 段階

- **Phase 1 — 帯 (D1〜D5・D8・D9)**: TitleBar 中央の置き換え + `AttentionBand.tsx` (新規・200〜300 行見込み) + 受入 1〜5・7・9・10。
- **Phase 2 — 小窓の 2 区分とトースト (D6・D7)**: `NotificationPanel.tsx` の区分化 (先行して到達性便で行が `button` になる前提) + `ToastHost` の文面規則 + 受入 6・8。
- **Phase 3 — 実機 1 週間**: 本番 11 列で「注意 → 会話 → 端末」を往復し、探す時間を測る。案 B (レール) と提案 3 (操作一覧) の要否をここで判断。

各 Phase は `npx tsc --noEmit` / `npx vitest run` / `python scripts/run_windows_tests.py` / `python -m pytest tests/` の全通過を完了条件とする。

## 8. 未決事項

- U1. 帯の最大札数 5 が 11 列運用で足りるか (実機で判断)。
- U2. ワークスペース名を帯の左端に残すか、札が多いときは隠すか。
- U3. 承認 (permission) の検知が Codex 側でも取れているか (`sessionAttentionStore` の対応範囲を実装前に確認)。
- U4. 「端末へ」ボタンの置き場 (会話列のツールバー右端・Astra モックの位置)。
