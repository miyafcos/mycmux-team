# mycmux Control

ChatGPT/Codex から mycmux の workspace、pane、tab、現在の論理画面を確認し、
tab 単位のペアリングと構造化された受け渡しを管理するローカル plugin です。

## Safety boundary

- mycmux への接続は `scripts/mycmux_agent_cli.py` の `panes --all` と
  `read --session ... --lines ...` だけを使います。
- `send`、`spawn`、`close`、`move`、focus、raw socket は使いません。
- 受け渡しはローカル state store に保存し、PTY へ入力しません。
- 画面本文は logical screen snapshot で、完全な transcript ではありません。

## Local verification

```powershell
python -m unittest discover -s tests -v
python server\mycmux_control_server.py --self-test
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\miyaz\cmux-for-linux-dev-master\integrations\chatgpt-app\plugins\mycmux-control\scripts\secure_mcp_tunnel.ps1" -Mode Validate
```

## Official ChatGPT Web route

`secure_mcp_tunnel.ps1` は、OpenAI の Secure MCP Tunnel を使って、このローカル
stdio MCP を private developer app として ChatGPT Web へ接続するための入口です。
mycmux の socket や管理画面を外部公開せず、Windows PC から OpenAI へ outbound HTTPS
だけで接続します。

既定の配置は次です。

- client: `C:\Users\miyaz\AppData\Local\mycmux-control\bin\v0.0.12\tunnel-client.exe`
- profile: `C:\Users\miyaz\AppData\Local\mycmux-control\profiles\mycmux-control.yaml`
- runtime health URL: `C:\Users\miyaz\AppData\Local\mycmux-control\runtime\health-url.txt`
- runtime log: `C:\Users\miyaz\AppData\Local\mycmux-control\logs\tunnel-client.jsonl`

安全境界:

- API key は `CONTROL_PLANE_API_KEY` の値をコマンドライン、profile、ログへ書きません。
- tunnel-client の管理 UI は `127.0.0.1` の起動ごとの一時 port に限定します。
- raw HTTP logging と remote admin UI は有効化しません。
- MCP は同時1 requestに制限し、現在の同期型 stdio serverを直列化します。
- MCP から起動する mycmux CLI 子プロセスへ OpenAI/tunnel の API keyを継承しません。
- この手順は mycmux 本体を再起動せず、PTYへ入力しません。

接続前の確認:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\miyaz\cmux-for-linux-dev-master\integrations\chatgpt-app\plugins\mycmux-control\scripts\secure_mcp_tunnel.ps1" -Mode Validate
```

Platform で tunnel を作成し、`tunnel_...` ID と runtime keyを発行した後に profileを作ります。
keyそのものは引数へ渡さず、`CONTROL_PLANE_API_KEY` に安全に保存した実行環境から使います。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\miyaz\cmux-for-linux-dev-master\integrations\chatgpt-app\plugins\mycmux-control\scripts\secure_mcp_tunnel.ps1" -Mode Plan -TunnelId "tunnel_REPLACE_WITH_ID"
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\miyaz\cmux-for-linux-dev-master\integrations\chatgpt-app\plugins\mycmux-control\scripts\secure_mcp_tunnel.ps1" -Mode Init -TunnelId "tunnel_REPLACE_WITH_ID"
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\miyaz\cmux-for-linux-dev-master\integrations\chatgpt-app\plugins\mycmux-control\scripts\secure_mcp_tunnel.ps1" -Mode Doctor
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\miyaz\cmux-for-linux-dev-master\integrations\chatgpt-app\plugins\mycmux-control\scripts\secure_mcp_tunnel.ps1" -Mode Run
```

`Init` は既存 profileを上書きしません。再生成が必要な場合も、内容を確認してから明示的に
扱います。Windowsの自動起動登録はこの plugin の範囲外で、現在は作成しません。

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
