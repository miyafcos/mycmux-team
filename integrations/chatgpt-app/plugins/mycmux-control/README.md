# mycmux Control

ChatGPT/Codex の dot から mycmux の workspace、pane、tab、状態、現在の論理画面を確認し、
tab 単位のペアリングと構造化された受け渡しを管理するローカル plugin です。

## Safety boundary

- mycmux への接続は `scripts/mycmux_agent_cli.py` の `panes --all`、`status`、
  `read --session ... --lines ...` だけを使います。
- `send`、`spawn`、`close`、`move`、focus、raw socket は使いません。
- 受け渡しはローカル state store に保存し、PTY へ入力しません。
- 画面本文は logical screen snapshot で、完全な transcript ではありません。
- `get_control_map` と dashboard の初期表示・再読込は画面本文を読みません。
  `read_session_screen` は利用者が指定したセッションだけに使います。

## Canonical session state

一覧の構造と PTY session ID は `panes --all`、状態は `status` (`session.state_view`)
を正本にします。session ID で照合し、各 tab の `state` と互換用 `agentStatus` に
canonical な `ui_state` を入れます。古い一覧の agent/process status は状態判定に使いません。
status に無い tab は `state: "unknown"`、`stateSource: "unknown"` です。
`agentStatusStale` は一覧の古い状態を使わないため false です。
canonical な `stateView.health` は別の情報として、そのまま保持します。

dot が読む `structuredContent` には次を含めます。

- `sessions`: status が返す全セッション。tab の無い終了済み PTY も含みます。
- `summary.states` / `summary.sessionCount`: 全 canonical セッションの状態別件数と総数。
  tab 数より多い場合があります。
- `summary.tabStates` / `summary.missingStatusCount`: 一覧の tab の状態別件数と、
  canonical 状態が無い tab 数。
- `attention.kind`: `input` は質問・入力待ち、`approval` は承認待ち。
  `none`、`rate_limited`、`error`、`done` も正本の値を返します。
  `summary.attention` は全 canonical セッションでの kind 別件数です。

status の取得に失敗した場合はエラーにします。一覧の古い状態で補完しません。

## Local verification

plugin のルートで実行します。全テストは実際の tunnel を起動せず、隔離した fixture と
mock を使います。重い作業の共通ルールがある席では、先にその順番を取ってください。

```powershell
$env:PYTHONDONTWRITEBYTECODE = "1"
python -m unittest discover -s tests -v
python server\mycmux_control_server.py --self-test
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\secure_mcp_tunnel.ps1 -Mode Validate
```

## Official ChatGPT Web route for dot

`secure_mcp_tunnel.ps1` は OpenAI の Secure MCP Tunnel を使い、ローカル stdio MCP を
private developer app として ChatGPT Web の dot に接続する入口です。
mycmux の socket や管理画面を外部公開せず、Windows PC から outbound HTTPS で接続します。

既定の配置は次です。

- client: `%LOCALAPPDATA%\mycmux-control\bin\v0.0.12\tunnel-client.exe`
- key: `%LOCALAPPDATA%\mycmux-control\control-plane.key`
- profile: `%LOCALAPPDATA%\mycmux-control\profiles\mycmux-control.yaml`
- stack state / PID: `%LOCALAPPDATA%\mycmux-control\runtime\stack.json` / `tunnel-client.pid`
- health URL: `%LOCALAPPDATA%\mycmux-control\runtime\health-url-<run ID>.txt`
- log: `%LOCALAPPDATA%\mycmux-control\logs\tunnel-client-<run ID>.jsonl`

鍵と tunnel の作成は所有者が行います。Platform で tunnel と Tunnels Read+Use の
runtime key を作り、本人だけが読める権限で上記の key ファイルに保存します。
台本は key を作成せず、内容も読みません。profile の `control_plane.api_key` には
`file:<鍵ファイルの絶対パス>` を記録し、key の値はコマンドライン・profile・ログに出しません。

1. 所有者が公式 tunnel-client、tunnel ID、key ファイルを用意します。
2. 台本の Validate / Plan で配置と参照先を確認し、Init で profile を作ります。
3. 接続を行う許可を受けた実行で Doctor を通し、stack を detached で起動します。
4. ChatGPT の developer app と dot に tunnel を登録し、`get_control_map` で一覧と
   状態・質問待ち・承認待ちを確認します。画面本文は必要な対象だけ指定して読みます。

以下は導入した plugin のルートで実行します。profile の MCP command には、その配置の絶対パスが入ります。

```powershell
$ControlScripts = (Resolve-Path -LiteralPath ".\scripts").Path
$env:MYCMUX_AGENT_CLI = "C:\Users\miyaz\.mycmux\bin\mycmux_agent_cli.py"
$env:PYTHONDONTWRITEBYTECODE = "1"
powershell -NoProfile -ExecutionPolicy Bypass -File "$ControlScripts\secure_mcp_tunnel.ps1" -Mode Validate
powershell -NoProfile -ExecutionPolicy Bypass -File "$ControlScripts\secure_mcp_tunnel.ps1" -Mode Plan -TunnelId "tunnel_REPLACE_WITH_ID"
powershell -NoProfile -ExecutionPolicy Bypass -File "$ControlScripts\secure_mcp_tunnel.ps1" -Mode Init -TunnelId "tunnel_REPLACE_WITH_ID"
powershell -NoProfile -ExecutionPolicy Bypass -File "$ControlScripts\secure_mcp_tunnel.ps1" -Mode Doctor
python "$ControlScripts\stack.py" start
python "$ControlScripts\stack.py" status
python "$ControlScripts\stack.py" stop
```

`Init` は既存 profile を上書きしません。別の設定には新しい `-ProfileName` を指定し、
stack 側にも同じ `--profile` を指定します。key ファイルが無い `stack.py start` は、
runtime の作成やプロセスの起動より先に exit 2 で止まり、保存先と案内だけを返します。
`--state-dir`、`--key-file`、`--profile-dir`、`--tunnel-client` で隔離した配置も使えます。

互換用の環境変数参照は wrapper の `-UseEnvironmentApiKey` で明示的に選べます。
その場合も値を引数へ渡さず、`env:CONTROL_PLANE_API_KEY` を参照します。
stack は常に file 参照を使います。

安全境界と運用:

- health / 管理 UI は `127.0.0.1` の起動ごとの一時 port に限定します。
- stack は raw HTTP logging、remote admin UI、payload capture、自動 browser 起動を無効にします。
- MCP は同時 1 request に制限し、同期型 stdio server を直列化します。
- Windows では Init が python.exe の隣の pythonw.exe を MCP の起動コマンドに使います。切り離した tunnel-client の子の python.exe には console の窓が付き、それを閉じると server が 0xC000013A で終わり tunnel-client も止まるためです (2026-10-08 に実機で発生)。pythonw.exe が無いときだけ python.exe に戻し、その旨を標準エラーに出します。
- tunnel-client が stdio MCP server を起動・所有するため、stack の detached プロセスは 1 本です。
  開始した席の終了後も稼働し、PID と process creation time で同じプロセスを識別します。
- `status` は所有するプロセスの loopback `/healthz` と `/readyz` のコードだけを返します。
  応答本文やログ本文は返さず、proxy と redirect を使いません。
- `stop` はこの stack が所有する PID と creation time が一致する process tree だけを停止します。
  runtime、PID、health URL、ログは保持し、次の起動で新しい health URL ファイルを使います。
- MCP から起動する mycmux CLI 子プロセスへ OpenAI/tunnel の API key を継承しません。
  stack も環境変数中の key を tunnel client へ継承せず、file 参照を渡します。
- mycmux 本体の再起動と PTY への入力は行いません。Windows 自動起動登録は作成しません。

## Bridge state

既定では `C:\Users\miyaz\.mycmux\chatgpt-bridge\state.json` 相当へ保存します。
テストや分離実行では `MYCMUX_CHATGPT_STATE_DIR` で変更できます。

## Pairing and handoff

1. Codex の mycmux Control を開き、対象 tab を選びます。
2. `紐づける` で現在の Codex task key と exact tab/session ID を保存します。
3. Codex → mycmux は UI の `受け渡す`、mycmux → Codex は下記 CLI の `send` を使います。
4. 受信側で内容を確認した後に `--binding-id` と `--message-id` を指定して acknowledge します。handoff は PTY command として自動実行されません。

```powershell
python "C:\Users\miyaz\cmux-for-linux-dev-master\integrations\chatgpt-app\plugins\mycmux-control\scripts\mycmux_chat_bridge.py" bindings
python "C:\Users\miyaz\cmux-for-linux-dev-master\integrations\chatgpt-app\plugins\mycmux-control\scripts\mycmux_chat_bridge.py" inbox --direction chatgpt_to_mycmux --status queued
```

Codex の plugin cache からは `MYCMUX_AGENT_CLI`、`MYCMUX_REPO_ROOT`、既定の
`C:\Users\miyaz\cmux-for-linux-dev-master` の順で mycmux bridge を解決します。
checkout を移動した場合は、どちらかの環境変数を明示してください。

## Next protocol step

現在画面は `pane.read` を使用します。mycmux の Dashboard と同じ会話表示へ揃えるには、
LiveBrief semantic events を read-only socket API として公開し、この plugin の
`session detail` データ源を差し替えます。
