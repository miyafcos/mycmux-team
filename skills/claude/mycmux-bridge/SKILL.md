---
name: mycmux-bridge
description: "Claude Code / claude-codex から mycmux の全 workspace・pane・tab・PTY session を列挙し、\n別ペインの画面・canonical status を確認して安全に入力する。"
metadata:
  triggers:
    - "mycmux の他ペインを見たい"
    - "mycmux のペイン一覧"
    - "mycmux のセッション一覧"
    - "別ペインの画面を読んで"
    - "○○ペインの状態を見て"
    - "○○ペインへ伝えて"
    - "ListAgents に出ないペインを探して"
    - "mycmux の質問に答えて"
  auto_apply: "mycmux 内で agent / session 一覧を求められ、ListAgents が空、または\n目的の mycmux ペインを含まない場合。"
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

一覧は終了済み・launcher 型も行ごとに返す。`send_status` は `candidate` (送信候補) /
`not_applicable` (対象外) / `unavailable` (取得不能)。`input_revision: null` を0に補完しない。
送信時は対象の PTY 型・状態・期待値を改めて厳密検査する。

## ID 契約

- read / status / send / answer-ask の宛先 (`--session`) は `list` が返す PTY `session_id` (`pane.list_all` の `tabs[].sessionId`) だけ。`workspace.id`・`pane.id`・`tab.id`・`agent_session_id`・`claude_session_id` を `--session` に渡さない。一致が 1 件でなければ `stale_target` で止まる。
- `--target <label-or-agent-name>` は `list` の label / agent 名と完全一致が 1 件のときだけ使える。0 件・複数件は `stale_target` で拒否される。部分一致・前方一致はない。

## 送信契約

一般メッセージは `send` だけを使う。wrapper は次の順で処理する。

1. `lifecycle == alive`、`health == fresh`、期待 attention を確認する。
2. 送信直前に canonical state と screen fingerprint を再確認し、epoch・attention id (無しも JSON null)・session revision・input revision の4点を揃える。
3. text-only 送信後、input revision が自分の入力分だけ1進んだことと draft の安定を確認し、semantic key `enter` を1回送る。外部入力による revision 変化があれば Enter 前に拒否する。
4. Enter 後は最後の入力行 (Codex `›` / Claude Code `>`・`❯` / シェルのプロンプト) に始まる本文だけを残留とみなす。履歴の本文は数えない。入力欄から本文が消え、画面か state が変われば `observed_delivered`。入力行を特定できなければ、Enter 直前からの fingerprint 変化で判定する (変化あり = `observed_delivered`、なし = `residue_remains`)。入力行の種類・行番号か、fallback の根拠を `detail` に返す。

一般メッセージの結果 JSON は `enter_sent` を常に持つ。Enter 要求を送ったら true (応答消失を含む)、要求前の拒否・明示的な `sent: false` 応答なら false。配送の確度とは別の値なので、true の結果から本文・Enter を自動再送しない。bridge CLI は従来どおり `observed_delivered` 以外で非 0 を返す。`dispatch_send.py` は再送防止のため `enter_sent: true` なら exit 0 とし、配送未確認時は stdout JSON に `warning` を付ける。自動経路で生の `mycmux_agent_cli.py send --enter` を使わない。`SendMessage` と PTY text send は相互互換ではない。

## 到達の判定と再送禁止

- `input_revision` が 1 進んだことを到達と読まない。`pane.send_text` は composer (入力欄) に本文を出さずに revision だけ進めることがある。到達の根拠は、入力欄に本文が安定して見えたこと (draft) と、Enter 後に入力欄から本文が消えて画面か state が変わったこと (`observed_delivered`) の 2 つだけ。
- `draft_not_observed` と `screen_changed_ambiguously` はどちらも Enter を送っていない (`enter_sent: false`)。本文を再送しない (入力欄に同じ本文が重なって届く)。`read` で入力行を見直し、本文が入力行に残っていれば Enter だけを 1 回送る (`mycmux_agent_cli.py send --key enter` に `status` の view から取った `--expect-epoch` `--expect-attention-id` `--expect-revision` `--expect-input-revision` の 4 点を付ける)。入力行が読めない席 (描画待ち・作業中のアニメーション) は待って `read` し直す。

## Enter が通らないときの手順 (v0.90.7 と旧版)

Enter が通らないときに人へ Enter を頼まない。元の送りを担当した道具が、以下の確認と復旧まで行う。
`enter_sent: true`、`enterWritten: true`、応答消失などの結果不明は、自動再送の根拠にしない。

- **v0.90.7 (下書きの Enter の直しが入った版)**: 同じ epoch・attention と、本文を書く前の入力版 + 1 が維持されていれば、本文なしの Enter を1回送る。出力だけによる session revision の進みでは下書きを拒否しない。期待値は現在の4点をそろえる。
- **`stale_staged_draft`**: その呼び出しでは本文も Enter も書かれておらず、下書きは捨てられている。`textWritten: false` と `enterWritten: false` を確認する。元の送り手だけが、同じ対象で入力欄が自分の本文1回分だけであることを確かめ、期待値4点付きの ctrl-c を1回送る。空の入力欄と入力版 + 1 を確認してから、本文と Enter を1回で送り直す。他の入力・本文の重複・入力行が読めない場合は、理由を返して止める。
- **v0.90.6 以前**: 下書きの古い session revision により Enter だけでは復旧しない場合がある。自分の本文1回分だけが入力欄にあると確認できたときに限り、期待値4点付き ctrl-c → 空欄の確認 → 現在の期待値4点で本文と Enter を1回、の回り道を使う。新しい理由を返さない旧版に、新版用の自動復旧を推測で適用しない。

Claude Code の `❯`・Codex の `›` の直後の NBSP (U+00A0) も空白として読む。
入力行を識別できた画面では、履歴に同じ本文があることや、画面の指紋だけの変化で配送を確定しない。

## resume 失敗の席 (already in use)

- 画面に `Session ID … is already in use` が出ている席へは送らない。その席は目的の会話を持っていない。
- 復帰手順: ①その席を `mycmux_agent_cli.py close-tab --session <PTY session_id>` で閉じる。②同じタブで生きている兄弟ペインの PTY `session_id` を `--anchor-session` にして `mycmux_agent_cli.py spawn-tab --anchor-session <兄弟の PTY session_id> --target claude --resume-session <claude_session_id> --no-activate` を実行する (閉じた席を anchor にしない)。③`read` で会話の履歴が戻ったことを確認してから send する。`already in use` が画面に残る間は送らない。
- 前面を奪わない。spawn / spawn-tab は `--no-activate` を付ける。`--activate` は付けない。

## mycmux や PC を再起動したあとの席 (2026-10-02)

- 再起動のあと、mycmux はペインを全部復元するが、PTY は表示したときに起動する。まだ起動していないペインに `mycmux_agent_cli.py status --session <PTY session_id>` を撃つと、`sessions` が空で `not_started` にそのペインが入った JSON が返る (終了コード 0)。これは「席が消えた」ではない。
- そのペインは `mycmux_agent_cli.py start-tab --session <PTY session_id>` で起こす。前面は変わらず、同じペインが保存済みの会話を再開する。`read` で会話の履歴が戻ったことを確かめてから send する。
- 同じ会話・同じ指示書の席を新しく立てない (2026-09-24 と 10-02 に、同じ会話の席が 2 つでき、古い席があとから自動で再開した)。`spawn-tab --resume-session` が `AGENT_SESSION_ALREADY_RUNNING:{"kind":…,"agentSessionId":…,"ownerSessionId":…}` で失敗したら、その会話は `ownerSessionId` の席で動いている。新しい席は作られないので、その席を使う。
- 席が本当に無いのは、`status --session` のエラーが `(no pane and no PTY)` で終わるときだけ。

## AskUserQuestion 契約

正本は `<mycmux-repository>/docs/adr/0003-askuserquestion-input-contract.md`。

- 単一選択と複数質問は数字キー1バイトだけを送り、Enter を付けない。
- multiSelect は各 toggle 後に画面を再読し、Submit まで Down、Enter 1回、review で `1` の順に処理する。
- 画面を構造解析できない場合は送らない。transcript は回答後の事後確認だけに使う。
