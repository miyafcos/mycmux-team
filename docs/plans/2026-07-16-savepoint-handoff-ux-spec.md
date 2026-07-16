# Savepoint 引き継ぎ UX 改善 + ペイン移動時の引き継ぎドロップ — Codex 委譲 spec

日付: 2026-07-16 / 発注: 宮崎さんフィードバック (音声) / 判断者: 親セッション (Claude)

## 背景 (親の調査で確定済みの原因 — 再調査不要、ただし実装時に反証を見つけたら報告)

1. **Codex ペインが「引き継ぎ文書き込み」ドロップ先に出ない**
   - `src-tauri/src/pty/monitor.rs` の `DetectedAgentKind::Codex` 分岐 (現行 ~L1468):
     `agent_kind = agent_session_id.as_ref().map(|_| "codex".to_string())`
     — **session id が検出できた時しか kind を emit しない**。
   - 一方 Claude 分岐 (~L1413) は「Process detection and session-id discovery are independent.
     Emit the Claude kind immediately…」のコメント通り、session id 未解決でも kind を即 emit する。
   - この非対称のため、`~/.codex/sessions` スキャンが外れると frontend の
     `paneMetadataStore.metadata[].agentKind` が永遠に undefined →
     `resolveLiveSavepointTargetKind` が null → paste ターゲットにならない。

2. **Claude Code ペインでも「たまに」出ない**
   - `src/lib/savepointHandoff.ts::resolveLiveSavepointTargetKind` が
     `processIsShell !== false → null` で弾く。
   - `processIsShell` は sysinfo 5秒ポーリングの deepest-child ヒューリスティック由来で、
     Claude が Bash ツールを実行中のスナップショットでは shell (bash) になる
     (App.tsx L206-211 のコメント参照)。その間 paste ターゲットが消える。
   - `metadata.agentKind` は `dropUndefined` マージ (paneMetadataStore.ts L35-44) +
     confirmShellObservation 経由クリアなので transient shell tick では消えない。
     → **agentKind の有無をゲートにすれば安定する**。

## タスク一覧

### T1. monitor.rs: Codex kind の即時 emit (Rust)

- `DetectedAgentKind::Codex` 分岐で、Claude 分岐と同様に
  `agent_kind = Some("codex".to_string())` を **session id 未検出でも** 返す。
- `agent_session_id` / `claude_session_id` の扱いは現行のまま。
- mapping ファイル書き込み (`should_write_agent_session_mapping`) は
  kind+session_id 両方ある時のみ、という既存条件を変えない。
- 既存の Claude 系ユニットテストを参考に、「codex プロセス検出 + session id 未検出でも
  metadata.agent_kind == Some("codex")」を固定するテストを追加。

### T2. resolveLiveSavepointTargetKind のゲート変更 (TS)

- `src/lib/savepointHandoff.ts`: `processIsShell !== false → null` の行を削除し、
  **`liveKind` (= metadata.agentKind) が claude/codex/claude-codex なら target とする**。
  - 根拠: metadata.agentKind は agent_active tick でのみ設定され、クリアは
    confirmShellObservation 経由。transient shell 中も引き継ぎ書き込みは
    Claude Code の入力キューに届く (ツール subprocess は pty stdin を読まない)。
  - agent 終了直後〜クリア確認までの数tick は誤って shell に paste しうるが、
    既存の isApprovalWaiting / waitForSessionAlive / revalidate ガードは維持し許容する。
- シグネチャから processIsShell 引数を外す場合は呼び出し元
  (`useSavepointDragSource.ts::resolveLiveAgentTarget`) と既存テストも更新。

### T3. 文言修正 + 切れ (ellipsis) 解消

- `src/components/online/onlineStrings.ts`:
  - `dragDropPastePreview`: `ここに${agent}へ引き継ぎ文書を渡します（Enterで送信）` に変更。
- `src/global.css`:
  - `.savepoint-write-preview__label` が省略 (…) される場合は全文が見えるよう修正
    (nowrap+ellipsis をやめ、2行まで折り返し可 or 幅拡大。ペイン幅が狭い場合のみ折り返し)。
  - セーブポイントドラッグゴースト (`.pane-drag-ghost--savepoint`) の meta
    「右に会話ごと再開」等が「右に会…」に切れる問題を解消:
    `.pane-drag-ghost` の max-width 320px と `.pane-drag-ghost-label` max-width 190px の
    競合が原因。**meta は常に全文表示** (meta を優先し label 側を縮める / max-width を
    `min(420px, calc(100vw - 32px))` へ拡大、いずれか堅い方)。長い `dragGhostMeta`
    (中央: 入力欄へ貼り付け / …) も切れない or 意図的に短文化すること。

### T4. ペイン/タブ移動 DnD の日本語化

- `src/components/workspace/TerminalPane.tsx::getDropPreviewLabel` を日本語に:
  - new-workspace: タブ=「新しいワークスペースへ移動」/ ペイン=同文
  - center: タブ=「このペインのタブに追加」/ ペイン=「ペインを統合」
  - split: 「右にペイン」「左にペイン」「上にペイン」「下にペイン」(タブ・ペイン共通)
- `src/components/workspace/PaneDragOverlay.tsx` の ghost meta を日本語に:
  - pane: `タブ${n}個` / tab: `タブ`
- 文言はハードコードせず、新規 `src/components/workspace/paneDndStrings.ts` に集約
  (onlineStrings と同スタイル)。savepoint 側の既存日本語文言とトーンを揃える。

### T5. 【新機能】ペイン/タブ移動ドラッグに「エージェントへ引き継ぎ文書を渡す」ドロップ選択肢

挙動:
- ペイン or タブをドラッグ中、以下を全て満たす**ターゲットペイン**に、
  ドロップチップ (pill) を表示する:
  1. ドラッグ元セッション (タブ drag はそのタブ、ペイン drag はアクティブタブ) に
     live agent metadata がある: `metadata.agentKind` ∈ {claude, codex, claude-codex}
     かつ `metadata.agentSessionId` かつ `metadata.cwd` が取れる
  2. ターゲットペインのアクティブタブが T2 後の `resolveLiveAgentTarget` 相当で
     live agent target になる
  3. ターゲットペイン ≠ ドラッグ元ペイン
- チップ文言: `${targetAgentLabel} へ引き継ぎ文書を渡す` (targetAgentLabel は
  `savepointTargetLabel` を再利用: Claude Code / Codex / Claude + Codex)。
- 表示位置: ターゲットペイン内・水平中央・上寄り (タブバー直下〜上部 20% 程度)。
  見た目は `.savepoint-write-preview` 系のトーンを踏襲した pill。既存の
  center/edge ゾーン判定と両立させるため、チップ要素自体を hit-test 可能にし
  (`data-dnd-handoff-target` 属性 + pointer-events: auto)、
  `resolveDropTargetAtPoint` (usePaneDragSource.ts) で **チップ優先**で解決する。
- チップへドロップした時の commit フロー (移動はしない):
  1. `publishSavepoint({ cwd, agentKind, agentSessionId })` (src/lib/ipc.ts L393。
     agentKind "claude-codex" は publishSavepoint の型が claude|codex のため、
     claude として扱うか対象外にするか、既存の publish UI (PaneTabBar のしおり) の
     扱いに合わせる)
  2. 返った `bundle_dir` で `joinSavepointSummary`
  3. useSavepointDragSource.ts::commitSavepointDrop の paste 分岐と同じガード
     (isApprovalWaiting / setActiveWorkspace / setActivePaneTab / focus /
     waitForSessionAlive / revalidate) を通し `writeToSession(target, sanitize(joinPrompt))`
  4. トースト文言は onlineStrings の既存 (dragDropPreparingDraft / dragDropPasted /
     dragDropErrorPrefix 等) を再利用。publish に数秒かかる間は
     dragDropPreparingDraft トーストを出す。
  - ガード/フローの共通部分は useSavepointDragSource から関数抽出して共有し、
    コピペ二重実装にしない。
- 判定ロジック (eligibility・ゾーン解決) は純関数として `src/lib/` に切り出し、
  vitest でユニットテスト (「ドラッグ元が agent でない → チップなし」
  「同一ペイン → なし」「ターゲットが shell → なし」「チップ上 → handoff target」等)。

## 境界 (変更してよい範囲)

- 変更可: 上記に列挙したファイル + それらの直接のテストファイル + 新規ファイル
  (paneDndStrings.ts / 判定純関数 / チップコンポーネント)。
- **禁止**: `sanitize_launch_env` / `EPHEMERAL_LAUNCH_ENV_KEYS` / `lib.rs` の `remove_var` /
  `dedupeAgentSessionsInConfigs` 周辺の変更・迂回。新規 sync `#[tauri::command]` の追加
  (今回は既存 IPC のみで足りる。追加した場合 tests/test_command_sync_contract.py と不整合)。
- `cargo fmt` をワークスペース全体に流さない (無関係ファイルの整形混入禁止)。

## 完了条件 (受け入れテスト — 全部通ること)

```
npx tsc --noEmit
npx vitest run
cd src-tauri && cargo test --release
python -m pytest tests/
```

+ 新規テスト: T1 の Rust テスト、T2/T5 の vitest テストが存在し PASS。
+ `git diff --numstat` に無関係ファイルの整形のみ差分がないこと。

## 接続先 (一次資料)

- 本ファイルの他、実コードを直接読むこと:
  - src/lib/savepointHandoff.ts / src/hooks/useSavepointDragSource.ts
  - src/hooks/usePaneDragSource.ts / src/stores/paneDragStore.ts
  - src/components/workspace/TerminalPane.tsx (drop preview / savepoint preview 描画部)
  - src/components/workspace/PaneDragOverlay.tsx / src/components/online/SavepointDragOverlay.tsx
  - src/components/online/onlineStrings.ts / src/global.css (.pane-drag-ghost* / .savepoint-write-preview* / .pane-drop-preview*)
  - src/stores/paneMetadataStore.ts (dropUndefined マージ仕様)
  - src-tauri/src/pty/monitor.rs (DetectedAgentKind 分岐と既存テスト群)
  - src/lib/ipc.ts (publishSavepoint / joinSavepointSummary / writeToSession / isSessionAlive)

## 報告フォーマット

- 変更ファイル一覧 + 各タスク T1〜T5 の実装方針の要約 + テスト実行結果 (生出力の要点)。
- コミットはしない (親が検証後にコミット・push する)。
