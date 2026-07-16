# Socket API & Automation

## 概要

mycmux は起動時に `127.0.0.1` のランダムポートで TCP を待ち受け、ポート番号を `~/.mycmux/mycmux.port` に書き出します。外部プロセスはこのポートに改行区切りの JSON を1行送るとペイン操作を実行でき、結果が JSON 1行で返ります。ループバック以外からの接続は `socket.rs` 側で拒否します。

主な用途は、ペイン内で動く Claude Code / Codex からの mycmux 操作です。「続きの実装を別エージェントにやらせたい」とき、エージェント自身が可視の新ペインを開いて相手を起動できます (v0.14.17)。

## プロトコル

```
リクエスト:  {"cmd": "pane.spawn", "args": {...}}\n
レスポンス:  {"id": 0, "result": {...}, "error": null}\n
```

| 層 | 実装 |
| --- | --- |
| TCP 待ち受け | `src-tauri/src/socket.rs` (`start_socket_listener`) — リクエストを `socket-request` イベントとしてフロントエンドへ橋渡し。応答待ちは30秒でタイムアウト |
| コマンド処理 | `src/components/layout/socketCommands.ts` (`handleSocketCommand`) — `SocketListener.tsx` がイベントを受けて呼び出す |
| ポート発見 | `~/.mycmux/mycmux.port` |
| CLI | `scripts/mycmux_agent_cli.py` (Python 標準ライブラリのみ) |

## 実装済みコマンド

| コマンド | 引数 | 動き |
| --- | --- | --- |
| `workspace.list` | なし | ワークスペース一覧と active ID |
| `workspace.select` | `workspaceId` | ワークスペース切替 |
| `workspace.rename` | `workspaceId`, `name` | ワークスペース名変更 |
| `pane.list` | `workspaceId` (省略時 active) | ペインとタブの一覧 (sessionId 含む) |
| `pane.spawn` | 下記 | 新ペインを可視で立ち上げ、`{workspaceId, paneId, sessionId, mode}` を返す |
| `pane.send_text` | `sessionId`, `text`, `enter?` | 既存ペインの端末へ入力を送る |
| `pane.read` | `sessionId`, `lines?` (既定80、最大400) | 既存ペインの画面末尾を読む |

snake_case の別名 (`list_workspaces` など) も受け付けます。

### `pane.spawn` の起動モード (上から優先)

| モード | 引数 | 動き |
| --- | --- | --- |
| handoff | `handoffFromSessionId` (+`handoffFromKind`) | 既存セッションの履歴から `crsm handoff` で引き継ぎ書を生成し、`MYCMUX_HANDOFF_*` env で起動 |
| prompt | `promptFile` (+`fromSessionId`, `fromKind`) | 指定した指示書ファイルをそのまま `MYCMUX_HANDOFF_PROMPT_FILE` として起動。`fromSessionId` 省略時は `"external"` を補う (空だと `terminal.rs` の `sanitize_launch_env` が handoff env を剥がすため) |
| resume | `resumeSessionId` | `MYCMUX_RESUME` + `MYCMUX_SESSION_ID` で resume 起動 |
| launch / shell | なし | `MYCMUX_LAUNCH_TARGET=<target>` で新規起動。`target: "shell"` は素の shell-starter |

共通引数: `target` (claude / codex / claude-codex / shell、必須)、`workspaceId`、`anchorPaneId`、`direction` (right / down)、`cwd`、`label`、`activate` (`pane.spawn` は既定 true、`pane.spawn_tab` は既定 false)。

env 構築は純関数 `resolveSpawnPlan` に分離してあり、`tests/unit/socketCommands.test.ts` で単体テストしています。

## 安全設計

- ループバック限定・認証なし。GUI パレットで人間ができる操作を CLI に開放したもので、権限は増えていない
- `MYCMUX_LAUNCH_TARGET` は ephemeral env ガード3層 (lib.rs 起動時 `remove_var` / SocketListener の永続化フィルタ / 契約テスト `tests/test_ephemeral_env_keys_contract.py`) に登録済み。data.json に残らないため、復元時にエージェントが勝手に起動する事故 (v0.4.0 の env 汚染事故と同型) は起きない
- `pane.send_text` は生の端末入力。CLI ヘルプにも「対象 sessionId を確認してから使う」旨を明記

## CLI 使用例

```bash
python scripts/mycmux_agent_cli.py panes
python scripts/mycmux_agent_cli.py spawn --target codex --prompt "指示書の内容"   # アクティブなタブは移動しない。切り替えるときは --activate
python scripts/mycmux_agent_cli.py spawn --target codex --split --prompt "..."   # 分割ペインで開く
python scripts/mycmux_agent_cli.py spawn --target claude --handoff-from-session <ID>
python scripts/mycmux_agent_cli.py read --session <sessionId> --lines 120
python scripts/mycmux_agent_cli.py send --session <sessionId> --text "続けて" --enter
```

`--prompt` の本文は `~/.mycmux/agent-prompts/<UTC時刻>-<乱数>.md` に保存してから `promptFile` として送ります。

### CLI `spawn` の配置既定 (2026-07-15 変更)

`spawn` はペイン内から呼ぶと (`MYCMUX_PANE_SESSION_ID` 検出) **既定で `pane.spawn_tab`** に送り、呼び出し元ペインの新タブとして、アクティブなタブを移動せずに立ち上がります (呼び出し元との親子関係がタブ並びで見える)。`--activate` で新しいタブへ切り替えます。従来のペイン分割にするのは次のいずれか: `--split` 明示 / `--direction` / `--anchor-pane` / `--workspace` の指定 / ペイン外 (env なし) からの実行。`pane.spawn` の `activate` 既定値は true のままです。

### 運用ノート (2026-07-15 実機検証より)

- CLI は stdout/stderr を UTF-8 に reconfigure してから print する (cp932 コンソールでペイン内容の「⚠」等により UnicodeEncodeError で落ちる実害があった)
- `--target shell` は launcher メニュー起動。**起動直後に `send` すると入力がメニューに食われて意図しないエージェントが起動する**。send 前に `read` でプロンプト表示を確認する
- `pane.read` はフロントエンドの描画バッファ読みのため、一度も表示されていないタブは空を返す

## 未実装 (cmux 参照からの候補)

`workspace.new` / `workspace.close`、`pane.close` / `pane.focus`、`notify.*`、`theme.*`、PTY 出力のストリーミング購読。必要になった時点で `socketCommands.ts` に追加します。
