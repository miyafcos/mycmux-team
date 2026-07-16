# v0.13.4 後 実機残存3症状 — 実装引き継ぎ書

作成: 2026-07-12 / 起点コミット: `de20e01` (v0.13.4) + `40faf1b` (安定化修正)
状態: **原因は全て特定済み・未実装**。この文書だけで実装に着手できる粒度で書く。

## 進捗追記 (2026-07-13 更新)

- **症状1 (しおり消失)**: 実装済み・配信済み。waiting ガード (`confirmAgentSessionClear`) は v0.13.4 系列でコミット済み、さらに `7356898` で restore 自己修復 (`rewriteTabAgentSession` / repoint) とセットで強化。
- **症状2①**: 症状1と同時に解消済み。
- **症状2② (未復元タブの視覚サイン)**: 実装済み (`shouldShowDeferredRestoreBadge` + `.pane-tab-restore-badge`、vitest 10件)。2026-07-13 にバッジ文言を「未復元 — クリックで再開」・色を var(--cmux-usage-warn) に統一。
- **症状2③ (dedupe 無通知消去の可視化/退避)**: 実装済み (`07fb2cc`)。敗者は null 化前に `suppressedAgentSessions` へ退避 (kind+sessionId で dedupe・上限5件)、集約トースト+console.warn、`tests/unit/agentSessionDedupe.test.ts` 5件。
- **症状3 (OAuth 429)**: 解決済み。真因はサーバ側が `claude-code/` UA を拒否していたこと (IP 制限説は REFUTED)。`c79c707` で mycmux UA を送るよう修正、3アカウント登録済み (memory `project_mycmux_multiaccount_oauth.md`)。

## 背景

v0.13.3 実機フィードバックの3症状を `40faf1b` で修正し v0.13.4 として配信済み。その後の実機再フィードバックで、うち1つ (しおりボタン) が **v0.13.4 の修正自身の副作用で別の形で再発**していることが判明した。ultracode 診断 (11 agent 反証付き) + 母艦直読で原因を確定。宮崎さんの実機観察 (「しおりだけ消える」「そのセッション中は戻らず再起動で戻る」) で機序が確定している。

実装フェーズはモデルを **Fable 5 に保った状態**で行う (宮崎さん方針: 実装で opus に切り替わるのを避ける)。

---

## 症状1: しおりボタンが Waiting/上部通知時に消える 【最優先・低リスク】

### 確定した機序 (自己回帰)

1. claude が承認プロンプト/入力待ち (`agentStatus==="waiting"`) になると長時間アイドルになる。
2. Rust の monitor (5秒ポーリング) が、アイドルな claude を `deepest_child_pid`(最大PIDの子を辿る, `src-tauri/src/pty/monitor.rs:452`) + `find_agent_descendant`(親子連鎖依存, `monitor.rs:703`) で見失い、`processIsShell=true && agent_active=false` を報告し続ける。
3. これが2ティック(約10秒)続くと、v0.13.4 で追加した `confirmShellObservation` の8秒ガード (`src/lib/agentSessionClearGuard.ts`) が「素のシェルに戻った」と誤判定し、**live の agentKind / claudeSessionId をクリア** (`src/App.tsx:203-206` の confirmShellObservation ブロック / `src/components/layout/SocketListener.tsx:622` の mirrorPtyMetadataForPersistence 内)。
4. `shouldShowPublishButton` (`src/components/workspace/PaneTabBar.tsx:101`) が false になり、**しおりだけ消える** (×・分割は残る=実機観察と一致)。
5. アイドル継続中は monitor が見失ったままで復活しない。再起動で claude が動き出すと monitor の検出が回復する (=「再起動で戻る」と一致)。data.json 由来ではなく **live 検出の問題**。

### REFUTED (再調査・再提案しない)
- レイアウト押し出し説: statusBar は `src/global.css:206` の container query が **ペイン420px以下で `display:none`** にするため、statusBar が存在する幅では右クラスタ(しおり含む)を押し出せない。しおりは右クラスタで最後に消える要素で、レイアウトで消えるのは×・分割も消える極狭ペイン(〜200px未満)のみ。
- `shouldShowPublishButton` は waiting/processIsShell 非依存で健全 (v0.13.4 で processIsShell ゲート撤廃済み)。

### 修正方針 (低リスク・安全弁不干渉)

clear 経路で **`agentStatus==="waiting"` のときクリアを抑止**する。waiting は claude が生きて入力待ちである確証なので、シェル誤検出があってもマーカーを守る。

- 対象1: `src/App.tsx` の onPtyMetadata リスナー内 confirmShellObservation ブロック (現状 203-206 付近)。クリア実行前に `usePaneMetadataStore.getState().metadata[meta.session_id]?.agentStatus === "waiting"` なら skip。
- 対象2: `src/components/layout/SocketListener.tsx` の `mirrorPtyMetadataForPersistence` (622 付近) にも同じガード (2経路が共有するため両方)。
- 実装案: `src/lib/agentSessionClearGuard.ts` に判定を寄せず呼び出し側で waiting を見るのが素直 (agentStatus は paneMetadataStore 管理でガードモジュールからは見えないため)。あるいは confirmShellObservation の引数に `suppressed: boolean` を追加して waiting 時は false 扱いにし、streak もリセットする。
- **触ってはいけない**: `sanitize_launch_env` / `EPHEMERAL_LAUNCH_ENV_KEYS` / `lib.rs` の remove_var / `dedupeAgentSessionsInConfigs` / `tests/test_ephemeral_env_keys_contract.py` (CLAUDE.md 安全弁)。

### テスト
- `tests/unit/agentSessionClearGuard.test.ts` に「waiting 中は 8秒経過してもクリアしない」ケースを追加 (呼び出し側ロジックをテスト可能な形に切り出す)。

---

## 症状2: 会話の復元がまだ微妙 【3系統・②③は中リスク】

### ① 8秒ガード誤クリア (症状1と同根)
waiting 中に消えたマーカーがその状態で保存されると次回復元対象から外れる。症状1の修正で大半が解消する見込み。

### ② マルチタブの遅延復元 (設計・データは無事)
非アクティブタブは起動時に PTY を一切スポーンせず、クリックで初めて復元される (`src/components/workspace/TerminalPane.tsx:748` で activeTab のみ XTermWrapper をマウント)。保存された active_tab が会話タブでないペインは「復元されていない」ように見えるが**データは壊れていない**。
- 修正方針: 非アクティブ&復元可能なタブに「未復元・クリックで再開」の視覚サイン (バッジ)。または起動直後に非アクティブタブも visibility:hidden で遅延スポーン。**体感改善のみで、データ整合には影響しない**ので優先度は中。

### ③ dedupe の無通知ID消去 (本当のデータ喪失)
同一 `${kind}:${sessionId}` が2ペイン/タブに付くと、保存時 `dedupeAgentSessionsInConfigs` (`src/components/layout/SocketListener.tsx:467-554`) が敗者側の claude_session_id/agent_kind/agent_session_id/terminal_snapshot を**警告なく永久 null 化**する。v0.13.4 の monitor 予約は稼働中プロセスの claim のみカバーで、休眠マーカーの重複は防げない。
- 修正方針 (安全弁不干渉で付加のみ): (1) 敗者クリア時に log/toast を出す (agent-restore-downgraded と同様の可視化)、(2) 敗者の ID を完全破棄せず退避フィールドに残す、(3) 根本的には live store 側 `setPaneAgentSessionFromMetadata` (`src/stores/workspaceListStore.ts`) に cross-pane uniqueness guard。**dedupe 本体のロジックは v0.5.6 安全弁の一部なので削除・弱体化しない** (CLAUDE.md)。

### REFUTED (再提案しない)
- cwd 正規化非対称説 (NTFS 大小無視 + claude_project_key で吸収済み) / dedupe 検出前ウィンドウ誤爆説 / 同一tick順序は fallback-only 保持の稀ケースのみ (monitor.rs 予約で大半カバー済み)。

---

## 症状3: OAuth アカウント追加が全アカウント 429 【コード修正不可】

サーバ側 (Anthropic の IP 単位 429・Cloudflare bot management) で、コードでは回避不能。v0.13.4 で文言・診断ログ (`%APPDATA%/com.miyazaki.mycmux/logs/oauth.log` に HTTP status/cf-ray/retry-after) は実装済み。

- **宮崎さん実施の切り分けテスト** (この結果待ち):
  1. 別回線 (スマホテザリング等) から1回だけ追加 → 成功なら IP バケット確定 / 429 なら指紋検知濃厚
  2. 同一回線なら24時間以上まったく試さずに置いてから1回だけ
- 結果次第で: 指紋検知濃厚なら CLAUDE_CONFIG_DIR プロファイル方式へ切替を検討。詳細は memory `project_mycmux_multiaccount_oauth.md`。

---

## 実装後の検証 (CLAUDE.md 準拠・変更後は必ず全部)

```
npx tsc --noEmit
npx vitest run
cd src-tauri && cargo test --release
python -m pytest tests/
```
- ビルドは **`npm run tauri build`** のみ (cargo build 単体は壊れた19MB exe。正常は32〜43MB)。exe は mtime/サイズで実体確認。
- `cargo fmt` の全体流し混入に注意 (`git diff --numstat` で無関係整形を検出し `git checkout --` で revert)。
- Cargo.toml の autocrlf ノイズ (` M` で実差分0) は `git checkout -- src-tauri/Cargo.toml`。

## GUI 実機確認 (実装後)
- 症状1: claude を承認プロンプトで放置 → しおりが消えないこと。
- 症状2②: 複数タブペインで会話タブが非アクティブでも復元導線がわかること。
- 症状2③: dedupe 発火時に通知が出ること。

## リリース
検証全通過後、CLAUDE.md 新ポリシー (2026-07-12: branch/tag push とも既定 ON・検証全通過前提・事後報告) に従い、bump→commit→push→tag push→CI→`scripts/mirror-personal-updater-feed.ps1 -SourceTag vX.Y.Z`→feed 実物確認 (v0.13.5 想定)。

## 関連資料
- memory: `project-v0133-field-fixes.md` (原因の要約) / `project_mycmux_multiaccount_oauth.md` (OAuth) / `project_mycmux.md` (開発史全量)
- 診断ワークフロー結果 (この文書の根拠): セッション 401caf0d の workflow wpm40fmzi / wf_0137f0fa
