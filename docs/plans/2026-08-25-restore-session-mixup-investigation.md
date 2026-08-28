# 再起動復元のセッション混線 — 調査報告 (2026-08-25・Opus 調査/Fable 裁定)

症状 (宮崎さん実機報告・v0.57.0): 再起動のセッション復活でペイン・タブ分割は正しく
復元されるが、ペインに「さっき開いていた別のセッション」が復活することがある。

## sessionId の構成と復元規則

`pty-<workspaceId>-<paneId>-<tabId>` (ペイン単位は `pty-<ws>-<pane>`)。
`src/lib/constants.ts:20-22` の `makeSessionId` で**毎回導出**され、data.json には保存されない。
復元時は `workspaceLayoutStore.ts:562-568` が**その時点の所属 ws/pane から再計算**する。
→ 実行中に pane/tab が別ワークスペースへ移動していると、再起動で ID が書き換わる。

## 仮説ランク (コード実引用で裏づけ済み)

### H1. WS間移動で sessionId を再導出しない → 再起動時に全セッション資源のキーがズレる (実データ実証)

- `workspaceLayoutStore.ts:1415` はペインオブジェクトを丸ごと別WSへ移す。`tab.sessionId` は
  旧WSを含んだまま (タブ移動も同様 `:1200-1204`)。稼働中 PTY を切らない意図的設計
- 再起動時 restorePanes が新WSで再導出 → スクロールバック
  (`src-tauri/src/pty/scrollback_store.rs:18-32`・`<sessionId>.bin`) と agent マッピング
  (`src-tauri/src/commands/session_mapping.rs:83`・`<sessionId>.txt`) が旧IDのまま孤児化
- **実測**: scrollback 20ファイル中5件が ws セグメント不一致 (全て pane `bb391b49…` のタブ・
  旧WS `5231da42…`→現WS `c30892d0…`)。262,160B / 261,988B の実データ2本が参照不能

### H2. ID検証失敗で `--continue` / `resume --last` に無言降格 → 別会話を掴む → 書き戻しで恒久化 (最有力・症状の直因)

- `src-tauri/src/commands/terminal.rs:398-404` claude → `--continue` (cwd 内の最新会話)、
  `:406-411` codex → `resume --no-alt-screen --last` (グローバル最新)。降格条件 `:490-509`
- `workspaceListStore.ts:524-526` がライブ検出した実際の会話IDでタブ保存値を上書き —
  一度誤った会話を掴むと以後そのタブが「自分のもの」として保持
- 過去実害の記録がコード内コメントに現存 (`session_mapping.rs:22-24`)

### H3. active_tab_id / index===0 の位置ベース接ぎ木

- `SocketListener.tsx:405-410` / `workspaceLayoutStore.ts:543-558`: ペイン側 session を
  「アクティブタブ」位置でタブへ接ぎ木。保存時と復元時でアクティブが変わると別タブに会話が乗る。
  `active_tab_id` 欠落時は index 0 = 完全な位置結合

### H4. suppressedAgentSessions の fallback 再利用

- `TerminalPane.tsx:73-77` が suppressed (dedupe で剥がされたID) を fallback 候補として渡し、
  `terminal.rs:494-505` が「存在する最初のもの」を採用 → 別タブから剥がされたIDを resume しうる

## data.json 点検 (機械走査)

workspaces 3 / panes 13 / tabs 21。ID重複: 全次元ゼロ。dangling ゼロ。
要注視: タブ `7ee61a2f…` (claude) の agent_session_id `fa5cf47d…` が tab_id 不一致
(健全な claude タブは sid==tab_id・9/10 がそう) — 乗り換えが一度起きた痕跡と整合。

## Fable 裁定 (修正方針)

1. **無言降格の廃止**: 完全一致 resume が不能なら新規セッションで起動し可視警告
   (`agent-restore-downgraded` イベントを流用)。`--continue`/`--last` を復元経路から除去
2. **資源キーを tabId 基準へ**: scrollback / session mapping の命名・lookup の主キーを
   安定な tabId に (pane/tab セグメントは実測 20/20 正しい)。旧形式 (フル複合名) の
   fallback 読み+初回アクセス時リネーム移行。既存孤児5件が拾えることを受け入れテストに
3. **接ぎ木は ID 検証つきのみ**: mapping はタブ ID と一致検証できる場合のみ適用。
   index===0 fallback 廃止
4. **suppressed を resume 候補から除外**
5. 多層安全弁 (sanitize_launch_env / EPHEMERAL_LAUNCH_ENV_KEYS / dedupe / 契約テスト) は
   不可侵。実機再起動での確認は宮崎さんの明示GO時に行う (勝手に再起動しない)

## 確定に使う追加証拠 (修正レーンが実施)

- 起動 stderr / diag の `[mycmux] agent restore validation failed` 行 (terminal.rs:126-145)
- `agent-restore-downgraded` イベント payload
- `~/.mycmux/pane-sessions/` の旧形式孤児
- 反証用: codex_session_exists の index cache miss (`agent_restore.rs:152-180`)
