---
name: mycmux-bridge
description: "Claude Code / claude-codex から mycmux の全 workspace・pane・tab・PTY session を列挙し、\n別タブの画面・canonical status を確認して安全に入力する。"
metadata:
  triggers:
    - "mycmux の他タブを見たい"
    - "mycmux のタブ一覧"
    - "mycmux のセッション一覧"
    - "別タブの画面を読んで"
    - "○○タブの状態を見て"
    - "○○タブへ伝えて"
    - "ListAgents に出ないタブを探して"
    - "mycmux の質問に答えて"
  auto_apply: "mycmux 内で agent / session 一覧を求められ、ListAgents が空、または\n目的の mycmux タブを含まない場合。"
---

# mycmux bridge

`ListAgents` は Claude harness registry、bridge は mycmux PTY registry を読む。両者を同じ agent として偽装しない。結果は `source` 付きで併記し、同名を暗黙統合しない。

## 実行入口

```bash
python "~/.claude/skills/mycmux-bridge/scripts/mycmux_bridge.py" list
python "~/.claude/skills/mycmux-bridge/scripts/mycmux_bridge.py" read --session <PTY-sessionId> --lines 400
python "~/.claude/skills/mycmux-bridge/scripts/mycmux_bridge.py" status --session <PTY-sessionId>
python "~/.claude/skills/mycmux-bridge/scripts/mycmux_bridge.py" send --session <PTY-sessionId> --text "<message>"
python "~/.claude/skills/mycmux-bridge/scripts/mycmux_bridge.py" answer-ask --session <PTY-sessionId> --answers-json '{"<question>": 2}'
```

`--target <label-or-agent-name>` は完全一致が1件の場合だけ使用できる。0件・複数件は拒否される。安全性が必要な操作では `list` が返す exact `session_id` を使う。

一覧は終了済み・launcher 型も行ごとに返す。`send_status` は `candidate` (送信候補) /
`not_applicable` (対象外) / `unavailable` (取得不能)。`input_revision: null` を0に補完しない。
送信時は対象の PTY 型・状態・期待値を改めて厳密検査する。

## ID 契約

read / status / send / answer-ask の対象は `pane.list_all` の `tabs[].sessionId` だけ。workspace ID、pane ID、tab ID、agentSessionId、claudeSessionId を PTY session ID として渡さない。

## 送信契約

一般メッセージは `send` だけを使う。wrapper は次の順で処理する。

1. `lifecycle == alive`、`health == fresh`、期待 attention を確認する。
2. 送信直前に canonical state と screen fingerprint を再確認し、epoch・attention id (無しも JSON null)・session revision・input revision の4点を揃える。
3. text-only 送信後、input revision が自分の入力分だけ1進んだことと draft の安定を確認し、semantic key `enter` を1回送る。外部入力による revision 変化があれば Enter 前に拒否する。
4. Enter 後は最後の入力行 (Codex `›` / Claude Code `>`・`❯` / シェルのプロンプト) に始まる本文だけを残留とみなす。履歴の本文は数えない。入力欄から本文が消え、画面か state が変われば `observed_delivered`。入力行を特定できなければ、Enter 直前からの fingerprint 変化で判定する (変化あり = `observed_delivered`、なし = `residue_remains`)。入力行の種類・行番号か、fallback の根拠を `detail` に返す。

一般メッセージの結果 JSON は `enter_sent` を常に持つ。Enter 要求を送ったら true (応答消失を含む)、要求前の拒否・明示的な `sent: false` 応答なら false。配送の確度とは別の値なので、true の結果から本文・Enter を自動再送しない。bridge CLI は従来どおり `observed_delivered` 以外で非 0 を返す。`dispatch_send.py` は再送防止のため `enter_sent: true` なら exit 0 とし、配送未確認時は stdout JSON に `warning` を付ける。自動経路で生の `mycmux_agent_cli.py send --enter` を使わない。`SendMessage` と PTY text send は相互互換ではない。

## AskUserQuestion 契約

正本は `<mycmux-repository>/docs/adr/0003-askuserquestion-input-contract.md`。

- 単一選択と複数質問は数字キー1バイトだけを送り、Enter を付けない。
- multiSelect は各 toggle 後に画面を再読し、Submit まで Down、Enter 1回、review で `1` の順に処理する。
- 画面を構造解析できない場合は送らない。transcript は回答後の事後確認だけに使う。
