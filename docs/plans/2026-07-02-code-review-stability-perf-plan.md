# mycmux コードレビュー — 安定動作・高速化に向けた改善計画 (2026-07-02)

対象: `C:\Users\miyaz\cmux-for-linux-dev-master` (branch master, package.json v0.8.53, HEAD `3dff65b`)
方法: Claude によるソース直接精読 + git 履歴分析 (v0.8.16..HEAD = 97 commits)。
注: Codex (gpt-5.5/xhigh) の敵対的レビューは分類器停止のため未実施。spec は
`C:\Users\miyaz\AppData\Local\Temp\claude\C--Users-miyaz\0cc99dbb-1fb4-4ff6-8556-62c05377253c\scratchpad\codex-review-spec-mycmux.md`
に保存済み。復旧後に `/codex:rescue --model gpt-5.5 --effort xhigh` で実行し、本書とクロスチェックすること。

---

## 0. 即時対応 (コード変更不要)

### 0-1. 稼働 exe がリポジトリより 3 パッチ古い ★最優先
- 稼働中: `C:\Users\miyaz\AppData\Local\mycmux\mycmux.exe` = **v0.8.50** (PID 21700)
- リポジトリ HEAD には v0.8.50 以降の fix が未デプロイ:
  - `885ca59` fix: restore codex sessions and terminal layout
  - `3dff65b` Fix selection copy and preview open feedback
  - `7efb01e`/`39b956e` pane tab rename fix, `e783973` agent wheel scroll fix
- **今「まだ不安定」と感じている症状の一部は修正済みの可能性がある。** レビュー・追加改修の前に
  v0.8.53 をビルド→デプロイして症状を再確認するのが最も安い一手。
- 過去の教訓 (2026-06-23 handoff): built exe / `~/mycmux-app` / `AppData\Local\mycmux` の
  3 コピーがハッシュ乖離した実績あり。デプロイ後は必ずハッシュ照合。

### 0-2. 未コミット資産のコミット
- untracked: `docs/qa/`, `tests/test_qa_tracker_contract.py`, `test_socket_api_contract.py`,
  `test_window_command_contract.py`, handoff 2 本 — QA 資産なのでコミットして保全する。
- `src-tauri/src/db/storage.rs` の ` M` は改行ノイズ (実差分ゼロ) → `git checkout --` で解消。

---

## 1. 検証済みの現状 (過去の既知課題との照合)

| 既知課題 | 現状 | 証拠 |
|---|---|---|
| 背圧 (FrontendFlow: reserve/ACK/watchdog/AutoConsume) | **実装済み・設計良好** | `pty/session.rs:78-277` — std Mutex を await 跨ぎで保持しない、ack 低水位で notify_waiters、generation/seq、cancel/replace/set_visible 全て notify |
| 非表示ペインの垂れ流し (B2) | **解決** | `XTermWrapper.tsx:2122-2130` `setFrontendVisibleIfChanged` → AutoConsume |
| PTY writer の UI ブロック | **解決** | `pty/session.rs:279-288` 専用 writer スレッド + 非ブロッキング enqueue |
| data.json 永続化 | **堅牢** | `db/storage.rs:302-361` tmp+rename+backup の atomic 置換 / `SocketListener.tsx:880-1043` dirty フラグ + debounce + beforeunload flush + close 時メタデータ flush |
| monitor.rs ポーリングコスト | **改善済み** | agent 検出キャッシュ (`monitor.rs:391-422`) |
| artifact link provider の O(R²·C) | **上限緩和のみ** | walk 上限・`hasArtifactLinkCandidate`・8192 字上限は健在 (`XTermWrapper.tsx:1294-1413`)。**provideLinks 結果キャッシュ (Wave 3-C) は未実装** |
| tao shutdown panic (上流 #1180) | **未解決のまま** | Cargo.lock tao = 0.34.6 (最新 0.35.x)。実害は終了時のみ |
| master updater | **稼働** | endpoint = `mycmux-team/releases/download/mycmux-personal-updater/latest.json` |
| lite 残骸 (master 内) | **なし** | src/src-tauri に `mycmux-lite` 参照ゼロ |

---

## 2. 発見事項

### CRITICAL-1: 同期 #[tauri::command] の再発防止機構がない (構造欠陥)
UI スレッドハング (AppHangB1) の再発原因は毎回「新しいコマンドが同期のまま追加される」こと。
2026-06-03 と 06-10 の 2 回、同じパターンで回帰した。現在も同期のまま I/O するコマンドが残存:

- `commands/workspace.rs:8` `load_persistent_data` — data.json 読込 (起動時、UI スレッド)
- `commands/terminal.rs:835` `get_session_scrollback` — **スクロールバック全量 Vec<u8> クローンを UI スレッドで実行** (ペイン再アタッチ毎)
- `commands/fs.rs`: `save_pinned_roots` / `reveal_in_explorer` / `open_with_default` (プロセス起動) / `create_file` / `create_folder`
- `buddy/commands.rs`: `save_buddy_settings` / `append_buddy_log` / `append_buddy_chat` (JSONL 追記 = 発話毎のディスク書込) / `save_buddy_profile*` / `save_observation_state` / `list_codex_pets` / `read_codex_pet_spritesheet` (画像ファイル全読み)
- `commands/terminal.rs:843` `kill_session`、`window.rs:62` `quit_app` (kill_all)

個々の重さは小〜中だが、**問題は「リストが増え続けること」**。恒久対策:

1. 上記を async / spawn_blocking 化 (機械的、S)
2. **契約テストで再発を封じる** (S): `docs/qa/mycmux-static-inventory.json` に command 一覧が
   既にあるので、「sync command は明示 allowlist のみ許可、新規はデフォルト async 必須」を
   `tests/test_*_contract.py` 方式で 1 本追加。これが本命。CI で自動検出できる。

### CRITICAL-2: フォーカス/選択/アクティベーション状態の単一権威ソース欠如
v0.8.16 以降の fix 65 件中 **19 件が focus/selection/repaint/click** のループ修正。
`activePaneId` 系の参照が 14 ファイル 61 箇所に分散し、
DOM focus / xterm helper textarea / `uiStore.activePaneId` / `lastActivePaneId` /
`allowInactiveTerminalPointerFocus` が別々の場所で書き換わる。
右クリック選択は 2026-06-23 handoff で「自動テスト PASS でも実機 NG」を繰り返した後、
`3dff65b` (未デプロイ) まで修正が続いている。

**提案 (M〜L)**: 「focus controller」モジュールへの集約リファクタ。
- pane activation / terminal DOM focus / selection 許可 を明示的な状態機械 1 つに畳む
- 書き込み経路を 1 API に限定 (`focusController.request(source, intent)`)、他は購読のみ
- 既存の CDP probe (`scripts/verify-focus-stability-cdp.mjs`) + layout contract test が
  回帰網として使えるため、リファクタの安全網は既に揃っている
- これをやらない限り focus 系 whack-a-mole は続く。次に focus 系バグが再発した時点で
  個別修正でなくこのリファクタに切り替えるのが合理的

### WARNING-1: ゴッドファイル 2 本
- `src-tauri/src/commands/terminal.rs` = **4,528 行** (セッション管理 + artifact preview/zip/docx パース + resume 検証 + 諸々)
- `src/components/terminal/XTermWrapper.tsx` = **2,806 行** (レンダラ + link provider + ACK フロー + 選択/フォーカス + 診断)

分割案 (M): terminal.rs → `commands/artifact.rs` (preview 系 ~1,300 行) を分離するだけで見通しが激変。
XTermWrapper → link provider / ACK フロー / selection-copy を hooks に切り出し。
機能変更ゼロの純移動なので回帰リスクは低いが、**改修頻度が高いファイルなので着手時期は
CRITICAL-2 のリファクタと同時が効率的** (どうせ同じ場所を触る)。

### WARNING-2: provideLinks 結果キャッシュ未実装 (Wave 3-C)
リンクホバー中は xterm が再描画毎にプロバイダを再実行する。上限打ち切りで hang は
しなくなったが、大量出力ペインでポインタがパス上にあると CPU を食い続ける。
行内容ハッシュ + viewport 範囲キーの小さな LRU で解決可能 (S/M)。

### WARNING-3: get_session_scrollback の全量クローン
同期問題 (CRITICAL-1) に加え、スクロールバック上限まで溜まったペインの再アタッチ毎に
数 MB のクローンが走る。async 化 + 必要ならチャンク送出 (S)。

### SUGGESTION
- **S-1**: `get_all_cwds` は完全な死にコード (frontend 呼び出しゼロ)。command 本体
  (`terminal.rs:3482`) + `lib.rs:165` 登録 + `ipc.ts:224` を削除。
- **S-2**: `eprintln!` が src-tauri に 50 箇所 (buddy/codex 系が多い)。release でも
  stderr に出る。ログマクロ or `#[cfg(debug_assertions)]` へ寄せる (S)。
- **S-3**: tao 0.34.6 → tauri/tao のバージョンアップ検討 (終了時 panic の上流修正待ち。
  実害小、急がない)。
- **S-4**: `paneMetadataStoreCompat.ts` / `workspaceStore.ts` と `workspaceListStore.ts` の
  並存 — 移行負債なら統合を検討 (要調査、リファクタ時に同時に)。
- **S-5**: lite/master 一本化 (2026-06-23 handoff の方針)。cherry-pick 税と二重ビルド税が
  毎リリースかかっている。社内リリース済みの今が畳み時 (M、ただし別プロジェクトとして)。

### 維持すべき良いパターン (壊さないこと)
- FrontendFlow 背圧設計 (ロックスコープ規律・notify 網羅・generation/seq)
- atomic 永続化 + 多段 flush (beforeunload / close 時)
- 専用 PTY writer スレッド
- 契約テスト + CDP probe + static inventory という QA 三点セット — このリポジトリ最大の資産。
  リファクタはこの網の上でやること

---

## 3. 優先アクションリスト

| # | アクション | 種別 | 効果 | 工数 | リスク |
|---|---|---|---|---|---|
| 1 | v0.8.53 ビルド→デプロイ→症状再確認 (ハッシュ照合込み) | 運用 | 高 | S | 低 |
| 2 | QA 資産 (docs/qa, contract tests) コミット | 運用 | 中 | S | 無 |
| 3 | sync command 契約テスト (allowlist 方式) 追加 | 安定 | **高 (再発根絶)** | S | 無 |
| 4 | 残存 sync command の async 化 (workspace/fs/buddy/scrollback) | 安定 | 高 | S | 低 |
| 5 | get_all_cwds 削除 + eprintln! 整理 | 保守 | 低 | S | 無 |
| 6 | provideLinks LRU キャッシュ (Wave 3-C) | 高速化 | 中 | S/M | 低 |
| 7 | focus controller 集約リファクタ | 安定 | **高 (whack-a-mole 終了)** | M/L | 中 (CDP+contract の網あり) |
| 8 | terminal.rs / XTermWrapper.tsx 分割 (#7 と同時) | 保守 | 中 | M | 低 |
| 9 | Codex xhigh 敵対的レビュー (spec 保存済み) で本書クロスチェック | 検証 | 中 | S | 無 |
| 10 | lite/master 一本化 (別プロジェクト) | 運用 | 中 | M | 中 |

推奨順序: 1→2→3→4 を 1 セッションで (全部 S)。5-6 は隙間時間。7-8 は次に focus 系バグが
出た時点で「修正」でなく「リファクタ」として着手。9 は分類器復旧後すぐ。

---

# 追記: Codex (gpt-5.5/xhigh) クロスレビュー結果の統合 (2026-07-02 同日)

Codex レビュー完了。全文: `C:\Users\miyaz\mycmux-codex-review-20260702.md` (536 行)。
Claude 所見と CRITICAL-1 (sync command ガード欠如) / focus SoT 分裂 / ゴッドファイル /
get_all_cwds 死にコード / 良パターン評価は完全一致。加えて Codex が新規に確定した問題:

## Codex 新規発見 (Claude 所見に無かったもの)

| # | 問題 | 実症状との対応 |
|---|---|---|
| C-2 | **data.json 置換が crash-safe でない**: tmp+fsync 後に「旧→backup rename → tmp→本体 rename」の 2 段階で、data.json が存在しない瞬間がある。そこで落ちると次回起動は default 読込 (全 workspace 消失) | 「たまに全部消える」系の潜在爆弾 |
| W-5 | **attach epoch を create_session 成功前に進める** (`ipc.ts:33-56`) → 旧 channel の生きた出力が stale 扱いで ACK+破棄される | 「表示が更新されない」「ペイン切替/reload で出力欠落」に直結 |
| W-9 | **agent_session_id 補完が 2 秒 TTL cache + 非 atomic mapping write に負ける** → agent 起動直後/終了直前の保存で session id を取り逃がす | 「セッション復活成功率 ~40%」の残存原因候補 |
| W-3 | backend ACK timeout (2.5s×2) と frontend watchdog (30s) の契約ズレ → WebView が 5 秒詰まると以後 AutoConsume 落ち | 大量出力時の表示欠落 |
| W-4 | visible 判定 (`display!==none`) が実際の書込可能性より緩い → pendingBatches が JS 側に無制限に溜まる | 折り畳み/0px ペインでのメモリ膨張 |
| W-6 | WebView reload 後の scrollback resync が JS メモリ tail 前提 → reload で履歴復旧しない経路 | crash recovery の弱さ |
| W-7 | full snapshot save と save_pinned_roots の read-modify-write が競合 → lost update | pinned roots 消失 |
| W-8 | close 時 forced save 失敗を握りつぶして quit | 終了時の状態喪失 |

## Codex 追加の死にコード・整理対象
- `src-tauri/src/commands/browser.rs` は **mod.rs 未 export・lib.rs 未登録の完全孤児** → `src-tauri/src/browser/**` ごと削除候補 (フロントは iframe BrowserPane 使用)
- `get_claude_session_id` / `read_pane_session_mappings` もフロント呼び出しなし疑い (要 rg 確認)
- `VITE_UI_VARIANT`: package.json は `mycmux` を渡すが App.tsx:115 / vite.config.ts:7 は `cmux` 分岐 → 不整合
- dev ガードなし本番ログ: XTermWrapper.tsx:1107/2546/2553/2620, pty/manager.rs:59/66
- `consumerId` はフロントで生成するが Rust 側 ACK 契約で未使用 (`_consumer_id`) → 照合するか削る

## 統合版・実施順 (Claude 表を置き換える最終版)

**Phase 0 — 運用 (今日中, コード変更なし)**
1. v0.8.53 ビルド→デプロイ→ハッシュ照合→症状再確認
2. QA 資産 (docs/qa + contract tests 3 本 + handoff 2 本) コミット

**Phase 1 — S 工数の安定化パック (1-2 セッション)**
3. CI sync-command scanner (契約テスト, allowlist 方式) — 両レビュー一致の #1
4. 危険 sync command の async 化 (load_persistent_data / get_session_scrollback / get_claude_session_id / read_*_mappings / kill_session / fs 系 / buddy 系)
5. data.json crash-safe 置換 (`MoveFileExW(MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)` 相当 + 欠落時 backup 自動復旧)
6. attach epoch のコミットタイミング修正 (create_session 成功後に確定 / 失敗時ロールバック)
7. mapping cache の persistence 時 bypass + mapping file atomic write (resume 安定性)
8. close 時 forced save 失敗で quit しない + 再試行 UI
9. 死にコード削除: get_all_cwds / browser.rs+browser/ / VITE_UI_VARIANT 整理 / 本番ログの dev ガード

**Phase 2 — M 工数の契約整合 (安定運用に入ってから)**
10. ACK 契約整合 (受領時 ACK 化 or late-ACK/visible 復帰で stale 解除) + 定数の共有化
11. visible 判定を書込可能性と一致させ pendingBatches に上限
12. scrollback resync: fresh attach 時に backend ring を dup-guard 付き replay
13. 永続化を単一 persistence queue に統合 (save_pinned_roots の直送廃止 or revision 拒否)
14. AutoConsume metrics 追加 (障害解析用)

**Phase 3 — L 工数の本丸リファクタ (次に focus 系バグが出た時に着手)**
15. `activePaneId`→`activeSessionId` 改名 + `activatePaneTab()` 正規 API + `terminalFocusService` 集約 (Codex 詳細設計は report §10)
16. terminal.rs 4 分割 / XTermWrapper 4 サービス抽出 (15 と同時)

**Perf (隙間時間, 全部 S-M)**
17. monitor negative TTL + iter_pids 重複除去
18. PTY hot path の clone 削減 (broadcast receiver_count ガード / Bytes 化 / with_capacity)
19. provideLinks 短期キャッシュ + search debounce
