# Socket API & Automation

## 概要

mycmux は起動時に `127.0.0.1` のランダムポートで TCP を待ち受け、ポート番号を `~/.mycmux/mycmux.port` に書き出します。外部プロセスはこのポートに改行区切りの JSON を1行送るとペイン操作を実行でき、結果が JSON 1行で返ります。ループバック以外からの接続は `socket.rs` 側で拒否し、さらに**全リクエストにトークンが必要**です (下記「認証」)。

主な用途は、ペイン内で動く Claude Code / Codex からの mycmux 操作です。「続きの実装を別エージェントにやらせたい」とき、エージェント自身が可視の新ペインを開いて相手を起動できます (v0.14.17)。

## プロトコル

```
リクエスト:  {"cmd": "pane.spawn", "args": {...}, "token": "<64桁hex>"}\n
レスポンス:  {"id": 0, "result": {...}, "error": null}\n
認証失敗:    {"ok": false, "error": "unauthorized"}\n   ← 直後に切断
```

| 層 | 実装 |
| --- | --- |
| TCP 待ち受け | `src-tauri/src/socket.rs` (`start_socket_listener`) — リクエストを `socket-request` イベントとしてフロントエンドへ橋渡し。応答待ちは30秒でタイムアウト |
| コマンド処理 | `src/components/layout/socketCommands.ts` (`handleSocketCommand`) — `SocketListener.tsx` がイベントを受けて呼び出す |
| ポート発見 | `~/.mycmux/mycmux.port` |
| トークン | `~/.mycmux/mycmux.token` (起動ごとに再生成) |
| CLI | `scripts/mycmux_agent_cli.py` (Python 標準ライブラリのみ) |

## 認証 (2026-08-09 追加)

ループバックは**認可の境界ではない** — 同じ PC 上のどのユーザーセッションのどのプロセスからも届くため、従来はローカルの任意プロセスが pane spawn / send_text / close を叩けました。remote サーバと同じ姿勢に揃えて、ローカルソケットにもトークン認証を入れています。

- mycmux は起動のたびに 32 バイト乱数を hex 化した**プロセス固有トークン**を `~/.mycmux/mycmux.token` へ書き出す (ポートファイルより先に書く)。前回起動のトークンは使えない
- 呼び出し側は毎リクエストの JSON トップレベルに `"token": "<ファイルの中身>"` を入れる。`status.subscribe` / `status.snapshot` のフィードフレームも同じ
- 検証は定数時間比較 (`remote::auth::validate_token`)。不一致・欠落なら `{"ok":false,"error":"unauthorized"}` を返して即切断する。`token` フィールドは検証後に取り除かれ、フロントエンドにもログにも渡らない
- 拒否は diag.log に記録するが、リトライループで 1MB ログを潰さないよう**60秒に1行 + 抑止件数**にまとめる
- **逃げ道**: 未対応の外部ツールがある場合は、mycmux を `MYCMUX_SOCKET_AUTH=off` の環境で起動すると認証を無効化できる (起動時に diag.log へ警告を残し、紛らわしい古いトークンファイルは削除する)
- 同梱の消費者 (`scripts/mycmux_agent_cli.py`・`scripts/status_feed_probe.py`・`scripts/mycmux_doctor_lite.py`) はトークンファイルがあれば自動で添付し、無ければ従来どおり素で送る (旧バージョンの mycmux とも話せる)

## 主な実装済みコマンド

| コマンド | 引数 | 動き |
| --- | --- | --- |
| `workspace.list` | なし | ワークスペース一覧と active ID |
| `workspace.select` | `workspaceId` | ワークスペース切替 |
| `workspace.rename` | `workspaceId`, `name` | ワークスペース名変更 |
| `pane.list` | `workspaceId` (省略時 active) | ペインとタブの一覧 (sessionId 含む) |
| `pane.spawn` | 下記 | 新ペインを可視で立ち上げ、`{workspaceId, paneId, sessionId, mode}` を返す |
| `pane.spawn_tab` | `anchorSessionId`、起動引数 | 既存ペイン内に新タブを追加 |
| `pane.list_all` | なし | 全ワークスペースのペイン一覧 |
| `pane.activate_tab` / `pane.close_tab` / `pane.rename_tab` | `sessionId` 等 | タブの選択・終了・改名 |
| `web.open` / `web.list` / `web.focus` / `web.push` | `presetId`、`tabId` 等 | サービス Web タブの操作 |
| `pane.send_text` | `sessionId`, `text`, `enter?` | 既存ペインの端末へ入力を送る |
| `pane.read` | `sessionId`, `lines?` (既定80、最大400) | 既存ペインの画面末尾を読む |

一覧・ワークスペース操作には snake_case の別名 (`list_workspaces` など) もあります。全コマンドは `socketCommands.ts` の dispatcher と `mycmux_agent_cli.py` の parser が正本です。
`status.subscribe` / `status.snapshot` は `socket.rs` が直接扱う状態フィードで、PTY 生出力のストリーミングとは別です。

### `pane.spawn` の起動モード (Web 分岐を先に判定、端末は上から優先)

| モード | 引数 | 動き |
| --- | --- | --- |
| web | `target: "web"`、`preset` または `presetId` | PTY を作らずサービス Web タブを開く |
| handoff | `handoffFromSessionId` (+`handoffFromKind`) | 既存セッションの履歴から `crsm handoff` で引き継ぎ書を生成し、`MYCMUX_HANDOFF_*` env で起動 |
| prompt | `promptFile` (+`fromSessionId`, `fromKind`) | 指定した指示書ファイルをそのまま `MYCMUX_HANDOFF_PROMPT_FILE` として起動。`fromSessionId` 省略時は `"external"` を補う (空だと `terminal.rs` の `sanitize_launch_env` が handoff env を剥がすため) |
| resume | `resumeSessionId` | `MYCMUX_RESUME` + `MYCMUX_SESSION_ID` で resume 起動 |
| launch / shell | なし | `MYCMUX_LAUNCH_TARGET=<target>` で新規起動。`target: "shell"` は `shell-starter` の起動メニュー |

共通引数: `target` (claude / codex / claude-codex / grok / shell / web、必須)、`workspaceId`、`anchorPaneId`、`direction` (right / down)、`cwd`、`label`、`activate` (`pane.spawn` は既定 true、`pane.spawn_tab` は既定 false)。

env 構築は純関数 `resolveSpawnPlan` に分離してあり、`tests/unit/socketCommands.test.ts` で単体テストしています。

## 安全設計

- ループバック限定 + プロセス固有トークン (上記「認証」)。GUI パレットで人間ができる操作を、トークンを読める呼び出し元にだけ開放している
- `MYCMUX_LAUNCH_TARGET` と、New Workspace ダイアログが同じ経路で渡す `MYCMUX_LAUNCH_MODEL` / `MYCMUX_LAUNCH_EFFORT` は ephemeral env ガード (lib.rs 起動時 `remove_var` / `terminal.rs` の `sanitize_launch_env` / SocketListener の永続化フィルタ、契約テスト `tests/test_ephemeral_env_keys_contract.py`) に登録済み。data.json に残さず、起動時の一時値が再起動時に再利用されるのを防ぐ
- model / effort の値はコマンドラインに載るので、`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` に合うものだけを通す (先頭を英数字に固定してフラグ偽装を封じる)。検証は GUI 側 (`src/lib/agentCatalog.ts`) とランチャー2本の両方に置き、ランチャーは読んだ直後に env から消す
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

`spawn` はペイン内から呼ぶと (`MYCMUX_PANE_SESSION_ID` 検出) **既定で `pane.spawn_tab`** に送り、呼び出し元ペインの新タブとして、アクティブなタブを移動せずに立ち上がります (呼び出し元との親子関係がタブ並びで見える)。`--activate` で新しいタブへ切り替えます。従来のペイン分割にするのは `--split` 明示のみ (2026-08-21 以降)。`--direction` / `--anchor-pane` / `--workspace` は `--split` と併用必須で、単独指定はエラー。ペイン外 (env なし) からの実行もエラーになり、暗黙に新ペインへ落ちることはありません (`--split` を付ければ可)。応答 JSON に `placement` (`tab` / `pane`) が付きます。`pane.spawn` の `activate` 既定値は true のままです。

### 運用ノート (2026-07-15 実機検証より)

- CLI は stdout/stderr を UTF-8 に reconfigure してから print する (cp932 コンソールでペイン内容の「⚠」等により UnicodeEncodeError で落ちる実害があった)
- `--target shell` は起動メニューを開く。現行の新規タブは React ランチャーで、bash メニューは互換経路。`send` は PTY のある端末タブを選び、送信前に状態を確認する
- `pane.read` は端末バッファの末尾を読む。宣言だけのタブや未知の sessionId はエラーになる

## 未実装 (cmux 参照からの候補)

`workspace.new` / `workspace.close`、`pane.close` / `pane.focus`、`notify.*`、`theme.*`、PTY 出力のストリーミング購読。同名コマンドは未実装です。タブ単位の終了・選択は既存の `pane.close_tab` / `pane.activate_tab` を利用できます。
