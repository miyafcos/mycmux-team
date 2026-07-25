# mycmux Refactor Instructions (2026-07-25)

対象リポジトリ: `C:\Users\miyaz\cmux-for-linux-dev-master` (branch=master, v0.20.0, HEAD 47fe96c)
作成: Fable 5 母艦による全量分析 (フロント/Rust/テスト・CI の3系統並列調査 + 正典ドキュメント照合 + ベースライン実測)。
この文書は実装担当モデル (Codex / Opus 等) への完結した指示書である。**この文書に書かれていない大規模変更を勝手に行わないこと。**

> **注意**: この文書自体が untracked のままだと `build-personal.ps1` が clean-tree チェックで abort する。作業開始時にこの文書がリポジトリ内にあれば、最初のコミットに含めるか `docs/plans/` へ移して commit すること。

---

## 1. Objective

既存仕様を一切壊さずに、確定済みの技術的負債を小さく安全な単位で削減し、今後の変更を容易にする。

- 目的は**見た目の綺麗さではない**。重複・死コード・責務混在のうち、証拠で確定したものだけを削る
- 大きな設計変更 (store 統合・型付きエラー移行・god-file の本丸分割) は**実装せず提案に留める** (§8 Phase 6)
- 過去の安定化計画 v2 (`docs/plans/2026-07-03-stability-refactor-plan-v2.md`) と改善計画 v3 (`docs/plans/2026-07-07-improvement-plan-v3.md`) は**ほぼ消化済み**。本書はその残渣 + その後の変化 (lite 廃止・Buddy 削除・FileExplorerSidebar 削除・WebGL 既定化) で生じた負債を対象とする

## 2. Project Understanding

### 何のアプリか
Tauri v2 (Rust) + React 19 + Zustand + xterm.js のターミナルワークスペースアプリ (ptrcode fork, GPL-3.0)。複数ワークスペース × ペイン分割 × タブでターミナルを管理し、Claude Code / Codex 等のコーディングエージェントのセッション検出・resume・savepoint (セッション引き継ぎ)・usage 監視・リモート監視 (iPhone/LAN) を内蔵する。旧 lite 版は 2026-07-23 に配布終了済み (追従不要)。

### エントリーポイント
- Rust: `src-tauri/src/main.rs` → `lib.rs::run()` — 67個の `#[tauri::command]` 登録、起動時 `MYCMUX_*` env 除去 (lib.rs:172-189)、PTY monitor / socket listener / remote server / session retention の起動
- フロント: `src/main.tsx` → `App.tsx` → `AppShell.tsx` (グローバルキーボードルーター) + `SocketListener.tsx` (永続化・IPC イベントハブ)
- 外部 CLI: `scripts/mycmux_agent_cli.py` — `~/.mycmux/mycmux.port` の TCP ソケット (newline-delimited JSON RPC) 経由の公開契約 (`docs/agent-integration.md` が正本)

### データフロー (コア)
- **PTY 出力 → 画面**: `pty/session.rs` の reader thread → tokio forwarder (ACK 背圧 `FrontendFlow`) → Tauri `Channel<InvokeResponseBody>` 上の**バイナリフレーム `MCX1`/`MCS1`** → `src/lib/terminalWire.ts` decode → `attachEpoch` ingest → XTermWrapper の deferred-batch queue → `term.write`
- **入力**: xterm onData → `terminalCache.enqueueSessionWrite` → `ipc.writeToSession` → writer thread (blocking_recv)
- **永続化**: stores 変更 → SocketListener が dirty 検知 → `save_persistent_data` → `db/storage.rs` が `data.json` を atomic write (temp+rename+.bak+破損復旧、プロセス内 static Mutex + Windows named mutex)
- **エージェント検出**: `pty/monitor.rs` の 5秒 sysinfo ポーリング → `~/.claude`/`~/.codex` の JSONL transcript 解析 → `pty_metadata` イベント
- **savepoint**: `commands/online_publish.rs` (生成) / `online.rs` (list/join/pin/trash) — **`scripts/savepoint_publish.py`/`savepoint_join.py`/`savepoint_cleanup.py` は Rust 側の双子** (online_publish.rs 冒頭に「Python CLI と bundle layout / manifest schema / handoff.md template を同期維持せよ」と明記)。**削除禁止・片側だけの変更禁止**

### 主要 store の実際の役割 (命名に注意)
- `workspaceListStore.ts` (582L) = ワークスペースの**コレクション** (CRUD/順序/active) **+ カラム幅・行高のレイアウトメトリクス調停** (命名と不一致)
- `workspaceLayoutStore.ts` (1404L) = ワークスペース**内部の構造** (ペイン/タブ/分割) — サイズは持たない (命名と不一致)
- `workspaceStore.ts` (20L) = 再 export のみの barrel
- `uiStore.ts` = activePaneId 等フォーカスの単一真実。`focusController.ts` が唯一の仲裁者

## 3. Behaviors To Preserve (絶対に壊してはいけない既存挙動)

1. **env 汚染 3層防御** (v0.4.0 全ペイン自動 resume 事故の再発防止):
   `lib.rs:172-189` の `remove_var` 14キー / `commands/terminal.rs:674-728` の `sanitize_launch_env` (`ALWAYS_INTERNAL`/`RESUME_TRIO`/`HANDOFF_QUARTET`) / `SocketListener.tsx:653` の `EPHEMERAL_LAUNCH_ENV_KEYS`。3リストは `tests/test_ephemeral_env_keys_contract.py` が一致を機械検証する。**sanitize 後に create_session が正規値を再注入する順序も不変**
2. **sync `#[tauri::command]` allowlist**: `tests/test_command_sync_contract.py` — sync コマンドは11個限定・sync 本体に blocking トークン禁止。コマンドの追加削除は allowlist と同一コミットで整合させる
3. **バイナリワイヤ形式**: `MCX1` (40byte header) / `MCS1` (24byte header) — `session.rs` と `terminalWire.ts` の両端。`test_terminal_binary_transport_contract.py` がピン
4. **FrontendFlow の背圧規律** (session.rs:141-363): ロックを `.await` 跨ぎで保持しない現行パターン、512KB/16batch inflight 上限、AutoConsume 復帰、generation/seq。**受信時 ACK 化は過去に検証で棄却済み — 再提案禁止**
5. **attach epoch 二相コミット** (`ipc.ts` + `attachEpoch.ts`): backend 成功後にのみ commit。`test_ipc_attach_epoch_contract.py` がピン
6. **terminalCache FE-N1 不変条件** (terminalCache.ts:51-78): mount 中に evict された slot は unmount 時に dispose する (再キャッシュすると Terminal が永久リーク)。`tests/unit/terminalCacheEviction.test.ts` がカバー
7. **focusController が `.xterm-helper-textarea` と `focusSessionSoon` の唯一の居場所** (`test_layout_stability_contract.py` が他ファイルでの出現を禁止。コメント内も禁止)
8. **PtySession の `unsafe impl Sync`** (session.rs:385): フィールド追加時は必ず Mutex 包装か Send+Sync を保証
9. **savepoint Python⇔Rust 双子同期** (§2 参照) + `savepoint_cleanup.py` の実削除無効 (dry-run only) は仕様
10. **version 5点一致**: `package.json` / `package-lock.json` / `tauri.conf.json` / `Cargo.toml` / `Cargo.lock` (`test_version_consistency.py`)
11. **manager.rs の reattach-vs-spawn 分岐** (manager.rs:49-106): 既存セッションはチャネル差し替えのみ (再スポーンしない) — restore の中核
12. **契約テストにピン留めされたファイル群** (§10 付録) — これらの**リネーム・移動・ピン対象スニペットの書き換えは、契約テストの同一コミット更新なしに行わない**

## 4. Non-Negotiables (作業規約)

1. **最初に `git status` を確認**する。既存の未コミット変更 (autocrlf の ` M` ノイズ含む) と自分の変更を混ぜない。ノイズは `git checkout --` で先に解消
2. 編集前に §6 のベースライン検証を実行し結果を記録する
3. 変更は**小さく戻しやすい単位** (1関心=1コミット)。各コミットは単独で全検証グリーン
4. **無関係な整形・ついでのリファクタ禁止**。特に Codex は `cargo fmt` をワークスペース全体に流しがち — コミット前に `git diff --numstat` で無関係ファイルの純整形混入を検出し `git checkout --` で revert
5. 既存挙動を勝手に変えない。「pure move」と書かれたフェーズはロジック変更ゼロ (関数移動 + import 修正のみ)
6. 正しさが不明な場合は**実装を止めて質問** (§5)
7. 各フェーズごとに §9 の検証を実行する
8. `cargo build` 単体で exe を作らない (frontend 未バンドルの壊れた exe になる)。ビルド確認が必要なら `npm run tauri build`。ビルドは必ずこの worktree 内で実行 (Smart App Control)
9. コミット後の push は既定 ON (`git push origin master`)。ただし**本書の作業ではタグは打たない** (リリース判断は親/宮崎さん)
10. `rm -rf` 禁止。tracked ファイルの削除は `git rm` (履歴から復旧可能な形) のみ
11. 削除・変更の理由は各コミットメッセージに残す

## 5. Stop And Ask Conditions (実装を止めて質問する条件)

- env サニタイズ網 (§3-1) の**リスト内容・順序・判定ロジック**を変えたくなったとき (文字列保存の pure move 以外すべて)
- ワイヤ形式・背圧定数・attach epoch の変更が必要に見えたとき
- 契約テスト (pytest) が落ち、**テストと実装のどちらが正か判断できない**とき — テストを書き換えて通すのは、移動に伴うパス更新のみ許可。アサーション内容の変更は質問
- フロントに露出するエラーメッセージ文字列 (例: `agent-restore-downgraded` 系) を変えたくなったとき
- `data.json` のスキーマ (`PersistentData`) に影響が及ぶとき — 保存済みユーザーデータの互換性問題
- remote / socket の認証・bind 挙動を変えたくなったとき (socket.rs の無認証 loopback-only は現状**受容済みリスク**であり変更対象ではない)
- 削除候補が本当に不要か確信が持てないとき (grep 参照ゼロを確認できない場合)
- §8 の Phase 6 (提案のみ) 項目を実装したくなったとき — 必ず提案文書で止める

## 6. Baseline Commands

作業ディレクトリ = リポジトリルート。**2026-07-25 時点の実測ベースライン (全グリーン) を下に記す。作業開始時に再実行して一致を確認すること。**

```powershell
# cargo が PATH に無いマシン (このPCが該当: rustup shim 消失) では先に:
#   $env:Path = "$env:USERPROFILE\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin;$env:Path"

npx tsc --noEmit          # baseline: エラー0
npx vitest run            # baseline: 35 files / 407 tests passed
cd src-tauri; cargo test --release; cd ..   # baseline: 193 passed / 0 failed
python -m pytest tests/ -q                  # baseline: 141 passed (要 pytest + openpyxl)
```

既知ノイズ (失敗扱いにしない):
- `pytest-cache-files-*/` の Permission denied 警告 — 既知・無害
- `pty/session.rs` 等の autocrlf ` M` 表示 (実差分0) — `git checkout --` で解消
- `test_updater_feed_contract.py` は Windows 限定 (他OSでは skip)

## 7. Debt Map

各項目: **根拠 / なぜ負債か / 影響範囲 / リスク / 改善案 / 検証 / 実装可否**。

### D-1. fileExplorerStore の死んだ半身 【実装可 (Phase 3)】
- 根拠: commit b7f0238 で `FileExplorerSidebar.tsx` (1578L) 削除後、`src/stores/fileExplorerStore.ts` (447L) の残存消費者は `PathJumper.tsx:101-109` (roots/activeRootId/entries/recentJumps/searchIndex/searchIndexStatus/selectedPath 読み + setExpanded/buildSearchIndex) と `SocketListener.tsx:889,1332` (setRoots/invalidate) のみ。`startDrag/updateDrag/endDrag/openContextMenu/closeContextMenu/startCreating/cancelCreating/selectPathRange/toggleSelectedPath/clearSelection/setSortMode/addRoot/removeRoot/renameRoot/setActiveRootId/addRecentJump/toggleExpand/ensureLoaded/refresh/setSelectedPath` は外部参照ゼロ。`addRecentJump` 未呼び出しのため PathJumper が読む `recentJumps` は恒久空
- 負債理由: 到達不能な drag/選択/コンテキストメニュー機構が store の半分を占め、読解コストと誤修正リスクになる
- 影響範囲: fileExplorerStore.ts、PathJumper.tsx (recentJumps 表示部)
- リスク: 低〜中 (契約テスト `test_no_restart_ui_surface_contract.py` がこのファイルをピン — **削除前に pytest のピン対象メンバーを grep で確認**し、使用中メンバーは残す)
- 改善案: 未参照アクション・関連 state を削除。`recentJumps` は書き手ゼロなので読み側 (PathJumper) ごと削除
- 検証: `npx tsc --noEmit` (noUnusedLocals で残骸検出) + pytest + PathJumper の手動動作確認 (Ctrl系ジャンプ)
- 実装可否: **可**。ただし1コミット単位で、消したメンバーごとに参照ゼロの grep 結果をコミットメッセージに記録

### D-2. ipc.ts の invoke 型付け不足 【実装可 (Phase 3)】
- 根拠: `src/lib/ipc.ts` (834L) — invoke 63箇所中、明示 `invoke<T>` は1箇所。残り62は関数戻り型の文脈推論頼み。引数は非型付き構造リテラル。`as`/`any` は src 全体で41箇所/24ファイル (例: `settingsStore.ts:66` の `as SettingsState`)
- 負債理由: Rust 側の payload 変更時に TS が緑のままランタイムで壊れる
- 影響範囲: ipc.ts のみ (追加的変更)
- リスク: 低。ただし `getSessionScrollback` 等、契約テストがピンする**エクスポートシグネチャ文字列は変えない**
- 改善案: 全 invoke に型引数付与 + 引数 interface 定義。ランタイム validation は追加しない (挙動変更になるため)
- 検証: tsc + vitest + pytest
- 実装可否: **可**

### D-3. usage/ の OAuth ヘルパー重複 【実装可 (Phase 3)】
- 根拠: `oauth_claude.rs:121-203` と `oauth_codex.rs:174-339` に `http_error/truncate/normalize_pct/epoch_to_rfc3339/number_to_i64/number_field/parse_window/reset_field` がほぼ同一実装で二重存在
- 負債理由: 数値正規化のバグ修正が片側だけに入る危険
- 影響範囲: usage/ 配下のみ。純関数
- リスク: 低
- 改善案: `usage/util.rs` へ抽出 (pure move)。出力 (RFC3339 形式・正規化結果) はバイト等価を維持
- 検証: cargo test (usage/tests/{claude,codex}.rs が既にカバー)
- 実装可否: **可**

### D-4. api_state の async 内 blocking IO 【実装可 (Phase 3)】
- 根拠: `remote/mod.rs:424-552` `api_state` (async) が `db::storage::load()` を直接呼ぶ — interprocess named mutex (最大30s) + 同期ファイル IO を tokio worker 上で実行
- 負債理由: LAN 負荷時に axum worker が詰まる
- 影響範囲: remote/mod.rs のみ。レスポンス形状は不変
- リスク: 低
- 改善案: `tokio::task::spawn_blocking` で包む
- 検証: cargo test + リモートダッシュボードの手動疎通 (可能なら)
- 実装可否: **可**

### D-5. windows_console.rs の no-op 死コード 【実装可 (Phase 2)】
- 根拠: `pty/windows_console.rs:3-5` 両関数とも no-op (CPU 対策でフラッシュ抑制を無効化済み)。呼び出しは `lib.rs:298` の1箇所
- 改善案: ファイル削除 + lib.rs の呼び出し・mod 宣言削除
- リスク: 低 / 検証: cargo test + tsc
- 実装可否: **可**

### D-6. リポジトリルートのビルド残骸 【実装可 (Phase 2) — Q1 は 2026-07-25 に削除承認済み】
- 根拠: **git 管理下**: `mycmux_0.19.2_x64_en-US.msi` (~27MB) + `.msi.sig` + `setup.exe.sig` (.gitignore が `*.msi`/`*.sig` を漏らしている)、`build-full.bat.deprecated`/`build-full.ps1.deprecated`/`build.bat.deprecated` (docs で「撤去予定」明記)。**untracked (git 無視済み・触らない)**: `*.log`, `tmp/`, `mycmux_0.19.2_x64-setup.exe`, `pytest-cache-files-*`
- 実装可否: **可**。msi/sig バイナリ3点の `git rm` は宮崎さん承認済み (2026-07-25)。`.deprecated` 3本の `git rm` と `.gitignore` への `*.msi`/`*.sig` 追加も可 (削除前に `grep -r "build-full\|build\.bat" scripts/ *.ps1 docs/` で参照ゼロ確認。`package-dist.ps1`/`package-source.ps1` が build-full を参照している場合はその行の扱いを質問)。削除は `git rm` のみ (履歴に残る形)・`rm -rf` 禁止

### D-7. docs/current-state.md の陳腐化 【実装可 (Phase 2)】
- 根拠: 「master 最新 v0.14.17」と記載 (実際 v0.20.0)。lite worktree 併存前提の記述 (lite は 2026-07-23 配布終了、CLAUDE.md に明記)。`deploy-update.ps1` 等の旧フロー残骸記述
- 改善案: v0.20.0 / lite 廃止 / 公開ミラー sync 方式 (CLAUDE.md の Git 運用節) を反映した書き直し。**Verification Baseline 節は §6 の4コマンドに統一**
- リスク: 低 (ドキュメントのみ) / 検証: 記載コマンドを実際に叩いて全部通ることを確認
- 実装可否: **可**

### D-8. monitor.rs god-file (2207L) 【実装可・pure move 限定 (Phase 4)】
- 根拠: 非テスト部 (1-1605) に6つの分離可能な関心が同居: (1) Claude transcript 検出 :104-293 (2) Codex transcript 検出 :308-467 (3) プロセスツリー走査 :479-1035 (4) agent-session 予約/帰属 :737-953 (5) git-branch worker pool :1045-1133 (6) ポーリングループ :1140-1605。テスト600行 (:1606-2207)
- 負債理由: エージェント検出の修正のたびに 2207行ファイルを読む必要があり、帰属アルゴリズム (事故修正の蓄積) を壊しやすい
- 影響範囲: pty/monitor.rs → `pty/monitor/` サブモジュール群。`test_session_restore_agent_kind.py` がこのファイルパスをピンしている点に注意 (**分割時は契約テストのパス参照を同一コミットで更新**)
- リスク: 中。**ループ内の順序 (明示 id 予約 → per-pane フォールバック、:1192-1200) は load-bearing — 並べ替え禁止**
- 改善案: 関数単位の pure move のみ。ロジック・順序の変更ゼロ。~30本の既存テストを移動先で維持
- 検証: cargo test (monitor テスト30本全パス) + pytest
- 実装可否: **可 (pure move 限定)**

### D-9. savepoint publish オーケストレーションの重複 (フロント) 【実装可 (Phase 4)】
- 根拠: `PaneTabBar.tsx` と `OnlinePanel.tsx` が両方 `publishSavepoint`/`finalizeSavepoint`/`onSavepointPublishProgress` を import し、進捗ステージ状態機械を各自実装。共有ヘルパーは `onlineSavepoints.ts` にあるがオーケストレーション層が copy-paste
- 負債理由: publish 契約 (backend + `test_savepoint_publish.py`) との整合を2箇所で維持する必要
- 影響範囲: PaneTabBar.tsx / OnlinePanel.tsx / 新規共有 hook。両ファイルとも契約テストのピン対象
- リスク: 中 (`test_savepoint_card_density_contract.py` / `test_savepoint_drag_contract.py` のピン対象スニペットを壊さないこと)
- 改善案: `useSavepointPublish` hook へ抽出。publish→finalize の呼び出し順序・進捗ステージ列は不変
- 検証: tsc + vitest (`publishProgress.test.ts`) + pytest 全部 + 実機で publish 1回の手動確認
- 実装可否: **可**

### D-10. get_default_shell の二重実装 【実装可・慎重 (Phase 5)】
- 根拠: 正典 `commands/shell.rs:52-109` と手コピー `remote/ws_handler.rs:367-404` (自コメントで複製と自認)。**両者は実は差分がある** (shell.rs は `is_bash_like_shell_path` ゲート + `prefer_wrapper_bash` あり、ws_handler 版なし)
- 負債理由: シェル解決の修正が remote 側に伝播しない
- リスク: 中 — 単純置換すると remote シェルの挙動が変わる可能性
- 改善案: shell.rs 側を公開しリモートから呼ぶ。**差分の扱い (remote にも wrapper-bash ロジックを効かせるか) は挙動変更なので、差分を明示した上で §5 に従い質問してから実施**
- 検証: cargo test + remote シェルの手動起動確認
- 実装可否: **条件付き可** (差分の扱いを質問してから)

### D-11. JSONL transcript パーサー3重実装 (Rust) 【提案優先・実装は Phase 5 でテスト先行】
- 根拠: `monitor.rs` (:104, :308) / `online.rs` (:704, :732) / `online_publish.rs` (:179, :262, :340, :667, :920) がそれぞれ「最新 .jsonl 探索・head 読み・cwd/session-id 抽出」を再実装
- 負債理由: transcript 形式変更時に3箇所直す必要。ただし monitor 側は auto-resume 安全系の入力であり、挙動が1バイトでも変わると v0.4.0 型事故のガードが揺らぐ
- リスク: 中〜高
- 改善案: 共有 `agent_transcript` モジュール抽出。**着手条件**: 統合前に現3実装の出力等価性を固定するユニットテストを先に書く (同一 fixture に対し3実装の結果一致を assert) — その後に1本化
- 実装可否: **テスト先行を満たせば可**。満たせなければ提案に留める

### D-12. online.rs (2633L) / online_publish.rs (2313L) の分割 【実装可・pure move 限定 (Phase 5)】
- 根拠: online.rs = manifest 型 / path 安全検証 / listing / join / pin・trash・restore・purge / コマンドラッパー + テスト1000行。online_publish.rs = tokenizer / digest / handoff builder / atomic swap / final-record lifecycle / 360行の `publish_savepoint_impl` + テスト900行
- リスク: 中。atomic-swap 順序・checkpoint/head/final lifecycle・path 安全検証は無傷で移動。**Python 双子 (§3-9) との schema 同期は変更なし** (pure move なので影響しないはずだが、bundle レイアウトに触れる変更は禁止)
- 検証: cargo test (両ファイルの大規模テスト群) + pytest (`test_savepoint_publish.py` / `test_savepoint_trash_contract.py` / `test_savepoint_transfer_contract.py` — ファイルパスのピンを同一コミットで更新)
- 実装可否: **可 (pure move 限定)**。D-11 と混ぜない (transcript 統合は別コミット)

### D-13. エラーハンドリング不統一 【限定実装可 (Phase 5)、全面移行は提案のみ】
- 根拠: Rust 全域が `Result<_, String>` (型付きエラー enum ゼロ)。`.ok()`/`let _ =` の黙殺108箇所 (ws_handler 12 / crsm 13 / socket 9 / storage 7)。フロントは空 catch 15箇所・console 出力96箇所の DEV ゲート混在
- 限定実装 (可): (a) `storage.rs` の `remove_file`/`sync` 失敗黙殺に eprintln (error レベル) を追加 — **サイレント OK 返しの解消は書き込み系で特に重要** (b) フロントの hot-path ログの DEV ゲート統一 (`test_ui_variant_and_logs_contract.py` の既存契約に合わせる)
- 全面移行 (提案のみ): thiserror 導入はフロントに露出するエラー文字列を変えるリスクがあるため Phase 6
- 実装可否: **(a)(b) のみ可**

### D-14. store 越境結合 【提案のみ (Phase 6)】
- 根拠: `.getState()` 直叩き 242箇所/22ファイル。`workspaceLayoutStore.ts` → `workspaceListStore` の "private" `_updateWorkspacePanes` 直叩き32箇所 (改善計画 v3 M-2 の未消化残)。命名の逆転 (List store がサイズメトリクス、Layout store が構造) は §2 記載
- なぜ提案止まりか: 両 store とも契約テストの高密度ピン対象で、rename は全 call site に波及し機能利得ゼロ。境界再設計はプロダクト判断 (`_updateWorkspacePanes` の public 昇格 vs store 統合) を要する
- 実装担当がやってよいこと: `workspaceListStore.ts` / `workspaceLayoutStore.ts` 冒頭に現状の所有権・命名逆転を説明するコメントブロックを追加する (ドキュメント化のみ)

### D-15. XTermWrapper (2117L) / SocketListener (1391L) の本丸分割 【提案のみ (Phase 6)】
- 根拠: XTermWrapper に6関心 (lifecycle / renderer / batch queue / scrollback recovery / 入力フィルタ / buffer export)、SocketListener に5関心 (leader 選出 / 永続化 / fs-change / socket 応答 / mapping 調停) が同居
- なぜ提案止まりか: 両者は契約テストが数十のスニペットをピンする最高密度領域で、FE-N1・attach epoch・deferred-batch の正しさの中枢。文字列一致型テストの上での構造変更は「テストを書き換えて通す」誘惑が強く、過去の focus whack-a-mole (34時間で9修正) の構造原因そのもの。**振る舞いテスト (M-4) を先に張らない限り着手しない**
- 実装担当がやってよいこと: 分割設計案 (抽出単位・移動関数リスト・必要な契約テスト更新の一覧) を文書として書き、提案で止める

### D-16. 検証系の不足 (安全網の穴) 【実装可 (Phase 1)】
- 根拠 (Rust 側の未テスト重要経路): `socket.rs` の 30s timeout/リーク掃除 (:87-112) テストゼロ / `manager.rs` reattach-vs-spawn 分岐・create_lock 剪定テストほぼゼロ / `sanitize_launch_env` の直接ユニットテストなし (キーリスト一致の契約テストのみ) / `storage.rs::update` の並行書き込み未テスト。フロント側: `workspaceLayoutStore` (最大 store) の直接ユニットテストなし
- 改善案 (この順で追加): (1) `sanitize_launch_env` の分岐網羅 `#[cfg(test)]` (正規 resume / 偽装 resume / handoff / ALWAYS_INTERNAL) (2) `manager.rs` reattach 分岐テスト (3) `socket.rs` timeout 経路テスト (4) `workspaceLayoutStore` の主要 move/split アクションの vitest
- リスク: 低 (テスト追加のみ、プロダクションコード変更ゼロ)
- 実装可否: **可** — Phase 2 以降の安全網として最初にやる

## 8. Implementation Phases

**順番厳守。各 Phase 完了ごとに §9 の検証 + 報告。1 Phase 内も1関心=1コミット。**

- **Phase 0 — 現状確認**: `git status` (autocrlf ノイズは `git checkout --`) → §6 ベースライン4コマンド実行・結果記録 → 本書をコミットに含める (未コミットなら)
- **Phase 1 — 安全網 (D-16)**: プロダクションコード変更ゼロのテスト追加4点。以降の全 Phase はこの網の上で行う
- **Phase 2 — 明らかに安全な整理**: D-5 (windows_console 削除) / D-6 (msi/sig 3点 + `.deprecated` 3本の git rm + .gitignore 追記 — Q1 承認済み) / D-7 (current-state.md 書き直し)
- **Phase 3 — 低リスクの型強化・重複解消**: D-2 (ipc.ts 型付け) / D-3 (OAuth util 抽出) / D-4 (spawn_blocking) / D-1 (fileExplorerStore 死コード削除)
- **Phase 4 — 小さな責務分離 (pure move)**: D-8 (monitor.rs サブモジュール化) / D-9 (savepoint publish hook 抽出)
- **Phase 5 — 境界の明確化 (条件付き)**: D-13(a)(b) (限定エラーハンドリング) / D-12 (online 系 pure move 分割) / D-11 (transcript 統合 — 等価性テスト先行が条件) / D-10 (get_default_shell — 差分の扱いを質問してから)
- **Phase 6 — 提案のみ (実装禁止)**: D-14 (store 境界再設計) / D-15 (XTermWrapper/SocketListener 分割設計) / D-13 全面 (typed error) — それぞれ設計文書を `docs/plans/` に書いて止める

途中で行き詰まった場合: その Phase を中断して報告。次の Phase に勝手に進んでよいのは、中断項目が後続の前提でない場合のみ。

## 9. Verification Requirements

- 各コミット後: `npx tsc --noEmit` + `npx vitest run`
- Rust を触ったコミット後: + `cd src-tauri && cargo test --release`
- 各 Phase 完了時: **4コマンド全部** (§6) + `git diff --numstat` で無関係ファイル混入ゼロ確認
- ファイル移動・リネームを含むコミット: 該当する契約テスト (§10) のパス参照を同一コミットで更新し、pytest グリーンを確認
- D-9 (savepoint hook) 完了時: 実機で savepoint publish → OnlinePanel 表示の手動確認を1回 (できない環境なら「未実施・要実機確認」と報告に明記)
- 数値基準: ベースライン (tsc 0 / vitest 407+追加分 / cargo 193+追加分 / pytest 141) から**減少があれば即失敗扱い**

## 10. 付録: 契約テストのピン対象ファイル (移動・リネーム・スニペット変更に注意)

pytest は大部分が「ソース文字列の存在確認」型。以下のファイルはパス・関数名・スニペットがハードコードでピンされている。

**フロント**: `App.tsx` `global.css` / layout: `SocketListener.tsx` `socketCommands.ts` `AppShell.tsx` `TabBar.tsx` `TabItem.tsx` `TitleBar.tsx` `NotificationPanel.tsx` `PathJumper.tsx` `UsageMeter.tsx` `UsagePopover.tsx` / workspace: `WorkspaceView.tsx` `TerminalPane.tsx` `PaneTabBar.tsx` / terminal: `XTermWrapper.tsx` `terminalCache.ts` `terminalFocusHelpers.ts` `terminalSelectionCopy.ts` `terminalMouseInputFilter.ts` `terminalLinkProvider.ts` / online: `OnlinePanel.tsx` `onlineSavepoints.ts` `onlineStrings.ts` `SavepointDragOverlay.tsx` / settings: `SettingsDialog.tsx` `tabs/{RemoteTab,NotificationsLayoutTab,SavepointsTab,AppearanceTab}.tsx` / `CrsmPalette.tsx` `ErrorBoundary.tsx` / stores: `workspaceLayoutStore.ts` `workspaceListStore.ts` `paneMetadataStore.ts` `paneDragStore.ts` `savepointDragStore.ts` `settingsStore.ts` `settingsMigration.ts` `fileExplorerStore.ts` / lib: `ipc.ts` `constants.ts` `attachEpoch.ts` `startupSessionGate.ts` `layoutColumns.ts` `focusController.ts` `keybindings.ts` `agents.ts` `terminalWire.ts` `savepointTransfer.ts` `savepointHandoff.ts` `savepointHandoffRuntime.ts` / hooks: `useSavepointDragSource.ts` `usePaneDragSource.ts` / `package.json` `vite.config.ts`

**src-tauri**: `lib.rs` `socket.rs` `session_retention.rs` `launcher.sh` `launcher.ps1` / commands: `window.rs` `terminal.rs` `online.rs` `online/transfer.rs` `online_publish.rs` `session_mapping.rs` `usage.rs` / `db/storage.rs` / pty: `session.rs` `manager.rs` `monitor.rs` / `capabilities/default.json` `tauri.conf.json` `Cargo.toml` `Cargo.lock`
定数名ピン: `SYNC_ALLOWLIST` メンバー / `ALWAYS_INTERNAL` `RESUME_TRIO` `HANDOFF_QUARTET` / `SESSION_ID_PREFIX` / `TRASH_DIR` `TRANSFER_ENTRY` `MANIFEST_ENTRY` `PUBLISH_LOCK`

**scripts**: `mycmux_agent_cli.py` `savepoint_publish.py` `savepoint_join.py` `savepoint_cleanup.py` (公開関数名が API: `build_parser` `request_for` `publish` `join` `cleanup` `sanitize_project_dir`) / `normalize-updater-feed.ps1` / `verify-focus-stability-cdp.mjs`

**その他**: `package-lock.json` / `docs/qa/mycmux-feature-status-canonical.xlsx` / `tests/fixtures/latest_raw_prenormalize.json`

## 11. 実装前に確認すべき質問 (親/宮崎さんの回答が必要)

- **Q1**: ~~msi/sig バイナリの git rm 可否~~ → **回答済み (2026-07-25): 削除OK**。D-6 に反映済み
- **Q2** (D-10 着手時のみ・**未回答**): remote シェル (`ws_handler.rs`) にも `prefer_wrapper_bash` / `is_bash_like_shell_path` ロジックを効かせてよいか (現状 remote は素の shell 解決で、統一すると remote 側の起動シェルが変わりうる)。**未回答のうちは D-10 は差分分析の報告まで行い、実装はスキップする**

## 12. Reporting Format

各 Phase 完了時に以下を報告:

```
## Phase N 報告
- 実施項目: (D-x, ...)
- コミット: <sha> <message> (1行ずつ)
- 検証結果: tsc=0 / vitest=NNN passed / cargo=NNN passed / pytest=NNN passed (実行した実コマンドと末尾出力を貼る)
- git diff --numstat 確認: 無関係ファイル混入なし / (あれば revert した旨)
- 逸脱・スキップ・未解決: (なければ「なし」)
- 手動確認: (実施内容 or 「未実施・要実機確認」)
```

最終報告には、実行した全コマンドと結果、全コミット一覧、Phase 6 の提案文書パスを含める。**自己申告の「完了しました」だけの報告は不可 — 必ず実行出力を伴うこと。**

## 13. Out-of-scope Items (再提案不要・実装禁止)

- 受信時 ACK 化 / consumer_id の検証昇格 / zero-size ペイン出力破棄 (計画 v2 で検証棄却済み)
- master auto-updater の修理 (B案=手動更新のみ、確定済み意思決定)
- store のリネーム (`workspaceListStore`/`workspaceLayoutStore`) — 高churn低利得
- monitor.rs の帰属アルゴリズム・savepoint lifecycle の書き換え (事故修正の蓄積であり、pure move 以外禁止)
- socket.rs への認証追加・remote の bind 既定変更 (現状は受容済み設計)
- 依存パッケージの一括アップグレード
- UI デザイン変更・テーマ変更
- lite 版 (`release/public-lite`) への追従作業 (2026-07-23 配布終了)
- CI release.yml の mirror ステップ改修 (ローカル実行運用で確定済み)
