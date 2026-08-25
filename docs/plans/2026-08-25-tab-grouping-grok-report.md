# GROK_DONE: タブ再配置 (tab grouping)

## 実装サマリ

配置図フッタの「タブ再配置」から、全ワークスペースの生きたターミナルを AI に渡して 2〜3 案を出し、比較 → 編集 → 適用前確認のあと `_replaceWorkspaces` 1 発で適用する。タブは閉じない。1 世代 undo はメモリ内。

- Phase A: `tabGrouping.ts`（scan / prompt / 厳格パース / compile / stale / commit / undo）
- Phase B: 3 モードパネル + CSS（トークンのみ）
- Phase C: 入口ボタン、`run_tab_sweep_judge` の `mode: "grouping"`（180s）、契約テスト
- 修正メモ反映: 固有名詞はアルファベット可、1WS=1案件に割らない（目安 3〜8 タブ）

## 仕様書 §7 の実コード確認

1. `_replaceWorkspaces` は `workspaces` 配列だけを置き換える。`activeWorkspaceId` / `lastActivePaneByWorkspace` / layoutMetrics は更新しない。metrics は workspace オブジェクトに載る。フォーカスは commit 側で `setActiveWorkspace` + `applyStructuralActivation`。
2. TerminalGrid のキーは `pane.id`。xterm キャッシュは `sessionId`。既存 pane id と tab.sessionId を保てば PTY は作り直さない。
3. PTY 同一性は `sessionId` で足りる。移動時に tab オブジェクト（sessionId 含む）をそのまま移す。
4. `splitColumns` 変更は Allotment 列の再マウントを起こしうる。fit はレイアウト確定後の既存 ResizeObserver / activation retry に任せる。
5. undo 失効は `workspaceListStore.subscribe` の layout signature と、復元前の sessionId 集合照合。

前提との食い違いはなし（実装停止なし）。

## 変更ファイル全列挙（このレーン）

新規:

- `src/components/layout/tabGrouping.ts`
- `src/components/layout/TabGroupingPanel.tsx`
- `src/components/layout/TabGroupingPanel.css`
- `src/components/layout/TabGroupingButton.tsx`
- `tests/unit/tabGrouping.test.ts`
- `tests/unit/tabGroupingApply.test.ts`
- `tests/unit/tabGroupingPanel.test.tsx`

編集:

- `src-tauri/src/commands/tab_sweep.rs` — `grouping` アーム + `GROUPING_TIMEOUT` のみ
- `src/components/dashboard/LayoutMinimapPanel.tsx` — 入口ボタン
- `src/components/dashboard/dashboardStrings.ts` — `tabGroupingStrings`
- `tests/test_tab_sweep_command_contract.py` — grouping 契約

ローカル commit（push していない）:

- `0fddbe2` feat(layout): add tab grouping scan, parse, compile, and undo engine
- `2e851f6` feat(layout): add tab regrouping panel with compare, edit, and confirm modes
- `cc31963` feat(layout): wire tab grouping entry and grouping judge mode
- `e46cc75` test(layout): assert grouping entry copy from dashboard strings
- `43d8001` fix(layout): allow proper nouns and comfortable workspace sizes in tab grouping

## テスト 4 種

```
npx tsc --noEmit
→ exit 0

npx vitest run
→ Test Files  202 passed (202)
→ Tests  2780 passed (2780)
（最終 naming 修正後は grouping 3 ファイル 15 tests 再実行で全緑）

python -m pytest tests/ -p no:xonsh
→ grouping 契約 tests/test_tab_sweep_command_contract.py 7 passed
→ フル: 353 passed / 2 failed のうち
  - grouping 契約は修正後 7 passed
  - tests/test_updater_feed_contract.py は PowerShell stderr の UTF-8 デコード失敗（この環境・コンソール無し）。このレーンのファイル外。foreign ノイズとして未修正。

python scripts/run_windows_tests.py
→ test result: ok. 909 passed; 0 failed; 10 ignored
→ all 2 test binaries passed
```

## セルフレビュー

### 1 周目（完了条件）

- プロンプト: 系譜・全 WS・日本語基本+固有名詞・サイズ目安を含む
- パース異常: 重複タブ / 欠落タブ / 未知 WS / コードフェンス / 件数超過
- compile: 新 WS・既存合流・空 WS は残す
- stale / undo 失効 / expectedResult 不一致ロールバック
- `pane.close_tab` を grouping 経路に入れていない

### 2 周目（境界）

`git status --porcelain` でこのレーンの対象ファイルはクリーン。残っている dirty / untracked（ailog, socket, agent CLI, integrations, AMENDMENT_tab_grouping.md など）は他レーン。`git add -A` は使っていない。

境界外ゼロ（このレーンが触った範囲）。

## 未検証事項

- 実 AI CLI への grouping コール（ユニットは固定 JSON）
- 稼働中 mycmux への実機適用（第 2 インスタンスは data.json / port 共有のため起動していない）
- 適用後の xterm fit を実レイアウトで目視
- `_replaceWorkspaces` 後の `lastActivePaneByWorkspace` 完全復元（store API が配列置換のみなので、undo は active WS + session 活性化まで）

## 設計への提案

- `createWorkspace` の pet / color / split 正規化を純関数として共有する（今は tabGrouping 側で同規約を複製）
- keep グループの `tabIds` をスキーマ本文へ正式記載（layout null だとタブ列挙先が無い）
- ショートカット / コマンドパレット入口（いまは配置図ボタンのみ）
- 空 WS の最後の空ペイン表示がワークスペースビューで破綻しないか、実機で確認
- undo スナップショットの Rust 永続は計画どおり後便でよい
