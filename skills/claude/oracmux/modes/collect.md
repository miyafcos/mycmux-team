# mode: collect — 既存の会話をファイルに取り込む

```
python ~/.claude/skills/oracmux/scripts/oracmux.py collect --engine chatgpt|gemini|grok \
  [--tab <tabId> | --url <会話 URL> | --latest] [--via pane|cdp] [--close-tab] \
  [--run-dir <run>] [--slug s] [--stable-sec 20] [--timeout-min 15] [--json]
```

| 指定 | 経路 | 動き |
|---|---|---|
| なし | pane | そのサービスの**開いているペインの最新タブ**を読む (宮崎さんが会話した場所) |
| `--tab <tabId>` | pane | 指定した Web タブを読む (`mycmux_agent_cli.py web-list` / ask の meta.json `tab_id`) |
| `--url <会話 URL>` | pane (既定) / cdp | pane: 裏タブで URL を開いて読む (`--close-tab` で回収後に閉じる)。cdp: OracleChrome で開く |
| `--latest` | cdp のみ | OracleChrome のサイドバー履歴の先頭 (ピン留めは飛ばす)。同一アカウントが前提 |

生成中なら止まるまで待ち、最後の回答と描画されているターンを保存する。

| 出力 | 中身 |
|---|---|
| `<engine>/answer.md` | 最後のアシスタント回答 (ヘッダに URL・所要・tab_id) |
| `<engine>/transcript.md` | 描画されているターン (user / assistant)。長い会話は仮想化で古いターンが載らないことがある (冒頭に注記) |
| `<engine>/citations.txt` | 最後の回答内のリンク |

## 使う場面

- **push → 宮崎さんがペインで会話 → 取り込み**。これが往復の帰り道 (pane 経路なら同じタブを読むだけ)
- ask が時間切れになった (`exit 2`)。`--tab` は meta.json、URL は ledger にある
- Web で人が続けた会話の続きを、次の brief の「経緯」に貼りたい

## 完了判定

`--stable-sec` (既定 20 秒) 本文が同一で、生成中でなく、最後のターンが assistant であれば完了とみなす。
最初の回答待ちも `--timeout-min` (既定 15 分) の期限に含まれる。期限で切れたら exit 2 (`partial.md` に途中本文、本文ゼロなら `timeout`)。
Deep Research など長いものは `--timeout-min` を伸ばす。cdp 経路は oracle セッション走行中だと exit 6 (`--force` で強行)。
