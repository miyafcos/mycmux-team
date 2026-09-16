# Agent-driven pane spawn v1 — エージェント命令ベースの可視ペイン立ち上げ

日付: 2026-07-15 / 作業ブランチ: bunshin/A-260715 (分身A worktree)
発案: 宮崎さん。「Claude Code / Codex と会話中に『この続きを Codex にやらせて』と言ったら、
バックグラウンド実行ではなく mycmux 上に**目に見える新ペイン**が立ち上がってそこで動く」UX を実現する。

## 背景 — 既に揃っている部品

| 部品 | 場所 | 役割 |
|---|---|---|
| CLI ソケット橋 | `src-tauri/src/socket.rs` + `src/components/layout/SocketListener.tsx` | `~/.mycmux/mycmux.port` の TCP (loopback限定) に JSON 1行を送るとフロントへ `socket-request` として届き、`handleSocketCommand` が処理して返信。既存 cmd: workspace.list/select/rename, pane.list |
| CRSM handoff | `src-tauri/src/commands/crsm.rs::crsm_create_handoff` → `crsm handoff` CLI | セッション transcript から引き継ぎプロンプトファイルを生成 (`{path}` を返す) |
| ペイン生成 API | `src/stores/workspaceLayoutStore.ts::addPaneToWorkspaceWithOptions` | launchEnv 付きで新ペインを追加。CrsmPalette が実使用例 (`CrsmPalette.tsx:750`) |
| launcher の env プロトコル | `src-tauri/src/launcher.sh:425-485` / `launcher.ps1` | `MYCMUX_HANDOFF*` → 引き継ぎ起動、`MYCMUX_RESUME`+`MYCMUX_SESSION_ID` → resume 起動、`MYCMUX_LAUNCH_TARGET` → 新規エージェント起動 |
| PTY 書き込み | `src/lib/ipc.ts::writeToSession` | 既存ペインへの入力送信 |
| バッファ読み出し | `src/components/terminal/XTermWrapper.tsx::getTerminalBufferLines` | 既存ペインの画面テキスト取得 |

つまり「GUI の CrsmPalette がやっていること」を **socket コマンドとして外部 (ペイン内のエージェント) に開放する**だけで成立する。Rust 側の新規 IPC は不要 (ephemeral env リスト1件追加を除く)。

## 追加するもの

### 1. socket コマンド 3種 (フロントエンドのみ)

`handleSocketCommand` を async 化し、以下を追加。ロジックは `SocketListener.tsx` から
`src/components/layout/socketCommands.ts` (新規) に分離してユニットテスト可能にする。

**`pane.spawn`** — 新ペインを可視で立ち上げる
- args: `workspaceId?` (既定=active) / `anchorPaneId?` (既定=activePane) / `direction?` (既定 "right") / `target` = claude | codex | claude-codex | shell / `cwd?` / `label?` / `activate?` (既定 true = そのワークスペースを前面化)
- モード (排他、優先順):
  1. `handoffFromSessionId` (+`handoffFromKind?`) → `crsmCreateHandoff` でプロンプトファイル生成 → `MYCMUX_HANDOFF*` 起動 (CrsmPalette.tsx:738-748 と同一の env 構築)
  2. `promptFile` → crsm を通さず、そのファイルを `MYCMUX_HANDOFF_PROMPT_FILE` に直接渡す (呼び出し側エージェントが自分で書いたタスク指示書を新ペインに読ませる)。`MYCMUX_HANDOFF_FROM_SESSION` は args の `fromSessionId` か "external"
  3. `resumeSessionId` → `MYCMUX_RESUME`+`MYCMUX_SESSION_ID` 起動
  4. なし → target=shell なら素の shell-starter、agent なら `MYCMUX_LAUNCH_TARGET=<target>` で新規起動
- 返り値: `{ workspaceId, paneId, sessionId }` — 呼び出し元が後で send/read で操作できるように

**`pane.send_text`** — 既存ペインへ入力 (Claude→Codex ペインの対話操作用)
- args: `sessionId` / `text` / `enter?` (true で `\r` 付加) → `writeToSession`

**`pane.read`** — 既存ペインの画面末尾を読む
- args: `sessionId` / `lines?` (既定 80, 上限 400) → `getTerminalBufferLines`。バッファ未初期化ならエラー

### 2. env 地雷の処置 (必須)

`MYCMUX_LAUNCH_TARGET` は現状 ephemeral リスト (lib.rs の remove_var / SocketListener の
EPHEMERAL_LAUNCH_ENV_KEYS) に**入っていない**。launchEnv 経由で使い始めると data.json に
永続化され、restore のたびに新規エージェントが勝手に起動する (v0.4.0 事故と同型)。
→ **両リストに追加**し、`tests/test_ephemeral_env_keys_contract.py` の期待値も更新する。

### 3. エージェント用 CLI: `scripts/mycmux_agent_cli.py` (新規, stdlib のみ)

ペイン内で動く Claude Code / Codex が Bash から叩く薄いクライアント。
- port 発見: `~/.mycmux/mycmux.port`
- サブコマンド: `workspaces` / `panes` / `spawn` / `send` / `read`
- `spawn --target codex --prompt "..."` は `~/.mycmux/agent-prompts/<UTC時刻>-<rand>.md` にプロンプトを書き、`promptFile` として送る。`--handoff-from-session` / `--resume-session` / `--prompt-file` も対応
- 出力は JSON そのまま (エージェントがパースする)

### 4. 呼び出し側の自然言語トリガー (デプロイ後に別途)

- Claude Code 用 skill `mycmux-pane` (~/.claude/skills/) と Codex 用 AGENTS.md 追記は、
  この機能が稼働 exe に載ってから作成する (先に作ると Unknown command エラーを踏むだけ)。
- 自ペインのセッション特定: エージェントは `MYCMUX_PANE_SESSION_ID` (live env) と
  `~/.mycmux/pane-sessions/<pane>.txt` マッピングから自分の agent session id を解決できる。

## UX フロー例

1. 宮崎さんが Claude Code ペインで「この続きの実装、Codex に新しいペインでやらせて」
2. Claude が引き継ぎ内容を md にまとめ `mycmux_agent_cli.py spawn --target codex --prompt-file <md> --cwd <repo>` を実行
3. mycmux 上に Codex ペインが右分割で**見える形で**立ち上がり、指示書を読んで作業開始
4. 人間はそのペインをいつでも直接操作できる。Claude 側も `pane.read` / `pane.send_text` で進捗確認・追加指示が可能

## 安全設計

- ソケットは 127.0.0.1 限定 (socket.rs:184 で non-loopback 拒否)。認証なしだが従来コマンドと同じローカル信頼モデル。spawn は「ユーザーが GUI パレットで出来ることの CLI 化」であり権限は増えない
- `pane.send_text` は生端末入力なので、CLI ヘルプと skill 側で「対象 sessionId を pane.list で確認してから」と明記
- launchEnv は既存の stripEphemeralLaunchEnv を通る経路のみ使用。新規 env キーは ephemeral 契約テストで固定

## 検証

- `npx tsc --noEmit` / `npx vitest run` (socketCommands の単体テスト新規) / `python -m pytest tests/` / `cd src-tauri && cargo test --release`
- 実機 (GUI) 確認は master 合流+ビルド後: 稼働 exe に対し `mycmux_agent_cli.py spawn --target codex --prompt "echo test"` でペインが可視で立つこと

## 合流方針

Codex が master で並行開発中のため、この分身ブランチには**合流指示があるまで留める**。
