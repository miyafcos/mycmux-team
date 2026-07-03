# mycmux 安定化リファクタ計画 v2 (2026-07-03)

対象: `C:\Users\miyaz\cmux-for-linux-dev-master` (branch master, v0.8.54, HEAD `1a61dab`)
方法: 6次元並列コードレビュー (PTY/IPC・永続化・フロント状態・描画perf・コマンド衛生・修正履歴forensics、
sonnet/high ×6) → 全findingを敵対的検証 (Fable/high ×29)。**29件中24件確定・5件棄却**。
前計画 `2026-07-02-code-review-stability-perf-plan.md` の Phase 0+1 は実装済みを前提に、
Phase 2/3/Perf の残項目を現コードで再検証した上で統合。

---

## 0. 前提: 検証で確定した全体像

### 健全 (壊さないこと)
- FrontendFlow 背圧コア (reserve/ack/cancel/replace_channel) — ロック規律は本当に綺麗。await跨ぎロックなし
- attach epoch 二相コミット — 成功/失敗両パスで stale drain+ack が正しい
- data.json crash-safe 置換 + backup復旧 (欠損/空/破損JSON全対応を確認) — W-8/item 8 は **fixed**
- mapping atomic write + save時のTTLキャッシュ強制バイパス — W-9 は **partially_fixed** (残りは軽微)
- sync-command allowlist 契約テスト — **67 command 全数カバーを確認、漏れなし**
- リスナー/オブザーバのリークなし (XTermWrapper 全登録サイトに対応する破棄あり)

### 誤報として棄却された5件 (安心材料)
| 疑い | 棄却理由 |
|---|---|
| pane kill で子孫プロセス孤児化+reader thread リーク | ConPTY の Drop 連鎖 (`manager.rs:133` remove → `session.rs:701` Drop → ClosePseudoConsole) が正しく効く |
| agent session-id が5秒poll窓で取り逃げ | kill と同一ハンドラで pane がレイアウトから消えるため復元対象にならず症状到達不能 |
| scheduleFullRefresh が repaint 連打 | xterm RenderDebouncer が1フレーム1回に合流させる |
| ACK定数不整合で「25秒ダンプ」 | 機構が逆 (dropであってdumpでない)。ただし black-hole 問題として B-1 で確定 |
| attach中 pendingBatches 無限成長 (ipc.ts側) | backend の 512KB/16batch inflight 上限が届く量を制限 |

---

## Phase A — 即効修正パック (全部 S〜S/M、1セッション)

体感バグに直結する確定findingから。**着手前に v0.8.54 ビルド済みexeのデプロイを完了させること**
(Phase 0+1 の修正が稼働exeに未達のままだと症状評価が濁る)。

### A-1. ワークスペース切替で常に pane[0] に飛ぶ ★日常体感バグ
- `src/stores/workspaceListStore.ts:280` setActiveWorkspace の同一sessionId探索は
  ワークスペース跨ぎでは絶対にマッチせず (sessionId=UUID)、常に `panes[0]` へフォールバック
- 修正: workspaceListStore に非永続の `lastActivePaneByWorkspace: Record<string,string>` を持ち、
  `set({activeWorkspaceId})` の**直前**に離脱側 workspaceId をキーに `uiState.activePaneId` を保存、
  復帰時にそこから復元 (setActivePaneId 全サイトへのフックは不要)

### A-2. Buddy 無効化トグルが見た目だけ (backend センサー稼働継続)
- `set_buddy_enabled`/`is_buddy_enabled` (buddy/commands.rs:529,535) は登録済みだがフロント呼び出しゼロ。
  Settings のトグルは `<BuddyWidget/>` の描画を消すだけで、file watcher は動き続ける
- 修正: SettingsMenu の onChange で `invoke("set_buddy_enabled",{enabled})` を併発 + アプリmount時に
  フロントの persisted 値を backend へ**push**する一方向同期 (backend atomic は起動毎に true リセット
  されるので backend→front のhydrateは逆向きで不正)

### A-3. pinned_roots の lost-update (item 13 の最小修正)
- `commands/workspace.rs:16` save_persistent_data は全構造体の盲目上書き、
  `fs.rs:245` save_pinned_roots は read-modify-write。デバウンス中の full-snapshot が後着すると
  ピン留めが黙って巻き戻る
- 修正 (**所有権スコープのmerge**): save_persistent_data を `storage::update` 化し、snapshot が所有する
  フィールド (workspaces/settings/active_*/schema_version) だけ書き、pinned_roots はディスク値を保持。
  あわせて `SocketListener.tsx:932` buildSnapshot から pinned_roots を外す
- 注意: 全フィールド代入の update 化は save() と等価で無意味。フィールド所有権の分離が本体

### A-4. tao 0.34.6 → 0.34.8 (無料パッチ、dry-run検証済み)
- `cd src-tauri && cargo update -p tao`。動くのは1パッケージのみ、0.34.7/0.34.8 の変更は
  Linux/macOS のみで Windows コードパス無接触。0.35.x (shutdown panic 根治) は tauri minor 待ちで別管理

### A-5. SessionManager.create_locks のエントリ無限蓄積
- `pty/manager.rs:24` create_lock_for は insert のみで kill/kill_all が create_locks を触らない
- 修正: kill() の sessions.remove 成功後、create_locks の Mutex を保持したまま
  `Arc::strong_count==1` なら remove (クローン配布元が同じ map mutex 下なので race-free)

### A-6. 死にコマンド7本の削除
- `get_claude_session_id` / `read_pane_session_mappings` / `refresh_work_context` /
  `load_buddy_profile` / `save_buddy_profile` (facets版に置換済み) — 削除
- `set_buddy_enabled` / `is_buddy_enabled` — **A-2 で配線するので削除しない**
- 注意: (1) `SessionMappingCache` 機構 (terminal.rs:3558-3677) は生きている
  `read_agent_session_mappings` が使うので消さない。
  (2) 削除時は `tests/test_command_sync_contract.py:23-24` の SYNC_ALLOWLIST からも同時に外す
  (stale-allowlist assertion で test が落ちる)

---

## Phase B — サイレント黒穴の解消 (安定の本丸、M)

「ペインが突然固まって見える」系の残存根因。B-1 と B-3 は同時に入れて計測しながら確認する。

### B-1. ACK stale 後の永久 AutoConsume 黒穴 (item 10 改訂版)
- 現機構: 未ACKバッチが ~5秒 (2500ms×2) 滞留すると `reserve()` が AutoConsume を返し、
  forwarder が `continue` で**バッチを黙って破棄** (session.rs:476)。`stale_timeouts` のリセット経路が
  実質 full remount しかなく、WebView が一度5秒詰まる (大量replay/GC/重いpaint) と
  そのペインの生出力は見た目フリーズのまま
- **前計画の案(a) 「受信時ACK」は採用しない** — 背圧設計 (512KB/16batch) を無効化し、
  遅延レンダ時に JS 側 queue が無制限化する。検証で明確に否定された
- 修正は backend のみ: `FrontendFlow::ack` (session.rs:190-213) で遅延ACK到着時に
  stale_timeouts をリセットし黒穴から復帰させる + `set_visible(true)` でも復帰。
  復帰時は 32KB scrollback replay (既存 syncBackendScrollbackToTerminal) で欠落分を埋める

### B-2. zero-size ペインの pendingBatches 無制限成長 (item 11/12 統合)
- `XTermWrapper.tsx:2310` enqueueFrontendBatch は display!==none のみ確認し、
  `hasWritableTerminalSize()` (2082) を見ないため、0px に潰れたsplitのペインが出力し続けると
  JS heap に MB 単位で溜まる
- **enqueue時のack-and-discardはNG** (検証指摘): zero-size は divider を戻せば回復し、現行は
  queue済みを書き戻すので出力が残る。捨てると scrollback resync が attach 時しか走らず恒久欠落
- 修正: pendingBatches に上限 (backend の FRONTEND_MAX_INFLIGHT_BATCHES 相当) + 超過時は
  oldest-drop-and-ack、**回復時に backend ring から dup-guard 付き replay** (=item 12 の resync を
  ここで一緒に実装する。単独でやるより結合して1回で)

### B-3. AutoConsume メトリクス (item 14、S — B-1/B-2 の観測装置)
- `PtyMetrics` (session.rs:39-49) に `autoconsume_events: AtomicU64` を追加。
  reserve() の呼び出し元は 1箇所 (session.rs:474) なので、FrontendFlow への Arc<PtyMetrics>
  配管は不要 — 呼び出し側でインクリメントするのが最小
- 「たまに固まる」の再現報告が来たとき、これが有るか無いかで診断コストが桁で変わる

### B-4. consumer_id の未使用配管を削除 (S)
- ipc.ts:43 で生成 → create_session → manager → session.rs で `_consumer_id` (未読)。
  ACK検証への昇格は generation/seq が既に同じ役割を果たすので**やらない**。end-to-end で削除

---

## Phase C — 描画パフォーマンス (S〜M、隙間時間)

「なんとなく重い/カクつく」の実測根因。機能変更なし。

### C-1. metadata 全量購読による全アプリ再レンダ嵐 ★効果大
- `PaneTabBar.tsx:198` と `TabBar.tsx:29` が `s.metadata` (トップレベルobject) を素で購読。
  XTermWrapper の runScan が ~150ms 毎に metadata を差し替えるため、**どれか1ペインが
  ストリーミング中は全ワークスペース(最大3 mounted)の全タブバーが150ms毎に再レンダ**
- 修正: `usePaneMetadataStore(useShallow(s => pane.tabs.map(t => s.metadata[t.sessionId])))` 型の
  スコープ付きセレクタへ (TerminalPane.tsx は既に粒度選択をやっており、パターンの水平展開)

### C-2. TerminalPane の launchEnv/launchArgs が毎レンダ新参照 (memo無効化)
- TerminalPane.tsx:548/680 で毎回新 array/object → XTermWrapper の memo() が常に不一致
- 修正: useMemo 化。ただし**先に `savedAgentSession` 自体を useMemo すること**
  (resolveSavedAgentSession が毎回新objectを返すため、depsに入れても再計算が止まらない)

### C-3. 毎バッチ getBoundingClientRect (強制reflow)
- `hasWritableTerminalSize` (XTermWrapper.tsx:2082) が pumpTerminalWrites の while 内で毎バッチ実行
- 注意: **単純hoistはNG** — 2262-2272 のmid-drain hide処理 (hidden→ack+drop / zero→requeue+break)
  がこのチェックに依存。rect 結果を drain サイクル内でキャッシュし、resize/visibility シグナルと
  MutationObserver で無効化する形に

### C-4. provideLinks LRUキャッシュ (item 19、据え置きで有効)
- 行内容ハッシュ+viewport範囲キーの小さなLRU。ホバー中のCPU張り付き解消

### Perf残 (前計画から継続・据え置き)
- item 17: monitor negative TTL + iter_pids 重複除去 (positive検出のみキャッシュ中と確認済み)
- item 18: reader thread の無条件 chunk.clone() → receiver_count ガード (session.rs:600 確認済み)

---

## Phase D — テスト基盤の是正 (Phase E の安全網として先行、M)

**今回レビューの最重要構造発見**: 契約テストが「ソース文字列の存在確認」で、
ロジックを実行していない。fix commit の度にテストも文字列を書き換えて通しており、
focus/selection が9回/34時間 (2026-06-22→24、同一タイトルで挙動反転する2 commit を含む) の
whack-a-mole になった構造的理由がこれ。**Phase E のリファクタはこの網を張ってから**。

### D-1. ipc.ts の attach-epoch/pending-batch 状態機械を pure module 化 + vitest
- jsdom不要 (検証指摘)。module-level state を pure な reserve/commit/fail/ingestBatch に抽出し、
  node 環境の vitest で合成 Channel メッセージを epoch commit 前後に流して queued/dropped を直接assert

### D-2. FrontendFlow (pty/session.rs) に #[tokio::test]
- 現状 **PTYコア3ファイルのユニットテスト0件** (storage.rs には7本あるのに)
- リファクタ不要で書ける (tauri 2.10.3 の `Channel::new(|_| Ok(()))` はプレーンclosureで構築可)。
  reserve() の低/高backlog、stale generation の ack、cancel、AutoConsume フォールバックをカバー
- B-1/B-2 の変更はこのテストの上に載せるのが理想 (B と D の順序は入れ替え可、同時が最良)

---

## Phase E — 本丸リファクタ (focus SoT 統一 + god-file 分割、M/L)

発火条件は前計画どおり「次に focus 系バグが出た時、個別修正でなくこちらに切り替える」。
ただし今回の履歴forensicsで**発火は時間の問題**と確認済み — 計画着手を早める判断も合理的。

### E-1. focusController 集約 (item 15、検証済み設計指針つき)
- 現状再計測: activePaneId 参照 14ファイル/55箇所・直接 `setActivePaneId` 20+サイト。
  7/2計画時 (14ファイル/61箇所) からの自然減なし = 待っていても収束しない
- 吸収すべき**競合4機構** (検証で列挙済み):
  1. focusin ゲート `shouldAcceptTerminalInput`/`refocusActiveTerminalIfNeeded` (XTermWrapper.tsx:376-389)
  2. `focusTerminalSoon` リトライループ
  3. pointer-down の 1500ms `allowInactiveTerminalPointerFocus` 許可窓
  4. wheel focus 復元 (`terminalPointerFocusAllowUntil`/`wheelFocusRestore` 等の module-level singleton 群)
- **設計上の注意 (検証指摘)**: 20サイトを一律 controller 経由にしない。store 内部の8サイト
  (workspaceLayoutStore.ts ×7 / workspaceListStore.ts:290) は構造変更の同期的後続処理なので
  store 内に残す。controller が仲裁するのは**ユーザー意図由来**の12サイト
- 安全網: D-1/D-2 + 既存 CDP probe (`scripts/verify-focus-stability-cdp.mjs`)

### E-2. terminal.rs 分割 (4,661行 → 4モジュール、pure-move)
- 実測構造: L1-845=コアsessionコマンド / L847-3146 (~2,300行)=**artifact変換エンジン
  (State/session_manager 参照ゼロ = 完全stateless、移動リスク最小)** / shell検出 ~75行 / mapping ~260行
- 分割: `commands/terminal.rs` (コア~850行) + `commands/artifact.rs` (将来 validate/docx/office_html/
  markdown/mod に再分割可) + `commands/shell.rs` + `commands/session_mapping.rs`
- クロスモジュール消費者 (検証で特定済み、lib.rs 以外に2箇所):
  `pty/monitor.rs:60` → `write_session_mapping_file` (mapping へ移動)、
  `commands/workspace.rs:3` → `can_restore_agent_session` (コアに残留)

### E-3. XTermWrapper.tsx 分割 (2,814行)
- E-1 と同時 (同じ場所を触るため)。link provider / ACK・背圧フロー / selection-copy /
  wheel-mouse 判定を hooks/services に抽出

### E-4. 同時にやる小掃除
- `paneMetadataStoreCompat.ts` → `paneMetadataStore.ts` rename (import 3サイトのみ、S)。
  workspaceStore.ts barrel の解体は11ファイルに波及するので任意
- eprintln!/println! 51箇所の整理 — **一律 no-op 化は禁止** (検証指摘): lib.rs:96 panic hook、
  bind/accept 失敗 (remote/mod.rs:240,258, socket.rs:136,159)、セキュリティ拒否 (socket.rs:147) は
  error レベルで常時残す。debug/trace 級だけ `#[cfg(debug_assertions)]` かログマクロへ

---

## 実施順序と委譲ルーティング

| 順 | Phase | 工数 | 委譲先 | デプロイ単位 |
|---|---|---|---|---|
| 0 | v0.8.54 デプロイ+症状再評価 | S | 宮崎 (deploy-mycmux-v2.ps1 外部PS) | — |
| 1 | A (即効6件) | S×6 | Codex gpt-5.5 `--effort high` (spec化して一括) | v0.8.55 |
| 2 | D (テスト基盤2件) | M | Codex gpt-5.5 `--effort high` (test-gen) | コミットのみ |
| 3 | B (黒穴3件+削除1件) | M | Codex gpt-5.5 `--effort xhigh` (契約整合はデリケート) | v0.8.56 |
| 4 | C (perf 4件+残2件) | S/M | Codex gpt-5.5 `--effort high` | v0.8.57 |
| 5 | E (本丸リファクタ) | M/L | Codex `--effort xhigh` 分割spec×3、親がゲート | v0.9.0 |
| 6 | lite への cherry-pick (または S-5 一本化判断) | M | — | — |

- 各ステップの受け入れ: `npx tsc --noEmit` + `cargo test --release` + `pytest tests -q` 全GREEN +
  sync-command 契約テスト維持。E は加えて CDP probe
- Codex 委譲時の既知トラップ: cargo fmt のワークスペース全体整形混入 → コミット前に
  `git diff --numstat` で純整形ファイルを検出し `git checkout --` で revert
- 1ステップ=1デプロイで症状変化を切り分ける (まとめて入れると B-3 メトリクスの意味が薄れる)

## 今回やらないこと (再提案不要)
- 受信時ACK化 (背圧設計を壊す — 検証で否定)
- consumer_id の検証への昇格 (generation/seq で足りる — 削除が正)
- enqueue時の zero-size ペイン出力破棄 (回復可能状態の出力を恒久喪失させる)
- master auto-updater 修理 (B案=放置・手動更新のみ、確定済み意思決定)
