# GROK_FIX: タブ再配置 Sol 監査 round 1

入口ゲート `TAB_GROUPING_ENTRY_ENABLED = false` は未変更。push なし。

## 対応表

| ID | 方針 | 変更点 | テスト |
|---|---|---|---|
| A-01 | fix | reorganize+current_locations を validate で拒否。compile は dest が new/existing の adopted group だけ tab を外す | `refuses reorganize+current_locations without deleting any tab` |
| A-02 | fix | 再分析で selectedPlan/edited/selection/popup/applied を消す。Apply は plans=0 / parseError / applied で無効 | パネル Analyze reset + Apply disabled 条件 |
| A-03 | fix | parser は 1〜3 plans を受理。1 valid は comparisonInsufficient。再生成後1案を表示 | `shows a single valid plan after retry` |
| A-04 | fix | keep.layout は exactly null。rationale/warnings 必須。非string ID は filter せず plan drop | `drops plans that omit required fields` |
| A-05 | 仕様改訂提案 | keep の tabIds は実装上必須のまま。仕様本文への追記が先 | — |
| A-06 | fix | 新規名 vs 既存WS名、編集後 validator でも重複検査 | `rejects a new workspace name that collides` |
| A-07 | won't-fix | denylist 近似は残す。一般英単語の完全機械強制は不能 | — |
| A-08 | fix | prompt payload に labelSource | `includes labelSource in the prompt payload` |
| A-09 | fix | prompt に role enum と warning code 契約 | 同上 |
| A-10 | won't-fix | snapshot_unavailable と all-DEAD の区別は後便 | — |
| B-01 | fix | activePaneId が null なら lastActivePaneId | `follows lastActivePaneId when dashboard cleared activePaneId` |
| B-02 | fix | paneFromTabs は preferred focus tab を active にする | 同上 |
| B-03 | fix | 空ペインは sessionId/activeTabId/agent を空にする | `clears stale session identity from an emptied workspace pane` |
| B-04 | fix | 既存WS合流後に prune を再実行 | compile 合流テスト |
| B-05 | fix | compile 既定は純関数 (seq id / now=0 / pet=undefined)。Panel は同一 transaction を Apply に渡す | `compiles the same proposal twice into identical transactions` |
| B-06 | fix | tabIds と layout の一致を再検証。compile は throw せず errors | validate 経路 |
| B-07 | fix | stale (missing dest / closed tab) を validate より先に分類 | `lists a closed target tab as tab_closed` |
| B-08 | fix | 照合に session 集合・splitColumns・activeTab・空/新WS・空pane session を追加 | commit 照合 / rollback テスト |
| B-09 | fix | rollback を try で囲み、失敗を結果型で返す | `rolls back when committed layout does not match` |
| B-10 | fix | signature から activeTabId を外し、幅/高さ/label を入れる。lastActivePaneByWorkspace を setState で復元 | undo hide/recall + signature |
| B-11 | won't-fix | createWorkspace 共有は store 編集が要り境界外 | — |
| B-12 | won't-fix | 既存列+合流の総列上限は後便 | — |
| B-13 | won't-fix | 壊れた duplicate tab ID 入力の fail-closed は後便 | — |
| B-14 | fix | 既存列の幅/高さは extendMetrics で保持 | extendMetrics |
| C-01 | fix | × は snapshot を破棄せず hidden。Recall で再表示 | `hides undo on dismiss and restores it with recall` |
| C-02 | fix | 「変更内容を見る」は保存済み appliedWorkspaces / snapshot を表示 | パネル reviewApplied |
| C-03 | fix | plan 切替と再分析で selection/popup を消す | パネル reset |
| C-04 | fix | 未分類リスト、未分類へ移動、paneTitle 指定 | パネル UI |
| C-05 | fix | Apply 失敗で status/全 error/stale を edit に出す | applyErrors |
| C-06 | fix | warning の code/message/tabIds をカードに表示 | パネル |
| C-07 | fix | group に is-error、error 全件表示 | パネル |
| C-08 | won't-fix | dest 往復で AI 骨格を完全保持は後便 | — |
| C-09 | fix | Undo バーに空WS件数と「削除されません」 | パネル |
| C-10 | fix | 0 移動は Apply 不可 | applyZeroMoves |
| C-11 | fix | analyze generation guard | パネル |
| C-12 | fix | Apply 中は header/footer も disabled。lock 待ちは 0ms | パネル |
| C-13 | fix | radio / aria-current / aria-pressed / popover / Escape で popup のみ閉じる | パネル |
| C-14 | fix | 比較/確認の chip は button ではなく div | PreviewWorkspaces |
| C-15 | fix | 成功後は applied transaction を固定し、live 再compile しない | applied state |
| C-16 | won't-fix | Dashboard 下部固定 Undo は DashboardView が境界外。Panel 内 hidden/recall で代替 | — |
| D-01 | fix | A-01/B-03 修正 + sessionId/tab field 全数保存テスト | `keeps every original tab object field` |
| E-01 | fix | 仕様どおり keep.layout=null を残しつつ、tabIds 省略は drop するテスト | parse tests |
| E-02 | fix | 1案リトライ、2回目0、初回2案で retry なし | runGroupingAnalysis |
| E-03 | fix | 実 tab_closed + replace 0 回 | closed target test |
| E-04 | fix | replaceCount=1、focus/session/fields assert | commit tests |
| E-05 | fix | dismiss/recall、tab click は signature 外 | undo tests |
| E-06 | 部分 | SSR に再分析文言と手順 aria。effect フル操作は入口封印中のためエンジンテストで代替 | panel SSR |
| E-07 | 部分 | 契約テストに ENTRY_ENABLED=false を追加。実 Tauri invoke は封印中 | contract |
| F-01 | won't-fix | 余白 px は既存 overlay と揃えてある | — |
| F-02 | won't-fix | 100+tab の preview memo は後便 | — |
| F-03 | fix | 「やり直す」→「再分析する」 | dashboardStrings |
| F-04 | 部分 | 未使用 copy の一部を使用開始 | — |
| F-05 | won't-fix | tail 並列取得は後便 | — |
| G-01 | n/a | 検証は挙動テストで固定。git 境界はこのレーンの明示 add のみ | — |
| G-02 | n/a | 本ラウンドは push しない | — |
| G-03 | 仕様改訂提案 | 移動先 pane は新 UUID。sessionId は保持。PTY 非再作成は cache 依存で未実機 | — |
| G-04 | n/a | 本ラウンドの commit メッセージは fix 内容に限定 | — |

## won't-fix 一覧

A-05, A-07, A-10, B-11, B-12, B-13, C-08, C-16, F-01, F-02, F-05, E-06 のフル DOM 操作。

## 仕様改訂提案

1. keep group の `tabIds` を schema 本文に必須として書く。layout=null ではタブ列挙先がない。
2. AI 応答の plans 件数: 初回は 2〜3 を要求しつつ、再生成後の 1 案表示を parser が受理できる、と明記する。
3. 移動先 pane ID は新採番でよい、と §7 の「pane ID 維持」claim を sessionId 保持に言い換える。

## テスト出力

```
npx tsc --noEmit
→ exit 0

npx vitest run
→ Test Files 204 passed / Tests 2808 passed

python -m pytest tests/ -p no:xonsh -p no:cacheprovider
→ grouping 契約 7 passed
→ フル: 354 passed / 1 failed
  tests/test_updater_feed_contract.py は PowerShell stderr UTF-8 デコード失敗（このレーン外・コンソール無し環境ノイズ）

python scripts/run_windows_tests.py
→ test result: ok. 931 passed; 0 failed; 10 ignored。all 2 test binaries passed。grouping は Rust 変更なし。
```

## セルフレビュー

1周目: Blocker/Critical/High は表のとおり修正。tab 消失経路は compile/commit で fail-closed。入口は false。

2周目: ステージは明示パスのみ。`TAB_GROUPING_ENTRY_ENABLED` は false。他レーン dirty には未接触。

## 未検証

- 実 AI CLI / 実機 Apply（入口封印）
- xterm remount/fit
- updater pytest の環境ノイズ
