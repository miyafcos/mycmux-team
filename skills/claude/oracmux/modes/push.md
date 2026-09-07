# mode: push — mycmux の Web ペインの composer に引き継ぎ書を載せる (送らない)

```
python ~/.claude/skills/oracmux/scripts/oracmux.py push --engine chatgpt|gemini|grok \
  (-q "問い" | --question-file Q.md | --run-dir <既存 run>) [--file ...] [--send] [--tab <tabId>] [--dry-run]
```

mycmux 内 (`MYCMUX_TERM_PROGRAM=mycmux`) 限定。実体は `mycmux_agent_cli.py web-push --preset <engine> --text-file brief.md`。
同じワークスペースに該当プリセットのペインが無ければ **自動で開いて前面にする** (人が読む前提の操作なので前面化してよい)。

## 使う場面

- 宮崎さんが Web UI の機能 (Canvas・画像・プロジェクト・添付) を使いながら自分で会話したい
- 送る前に問いと添付を目で確認したい (Pro のターンは取り消せない)
- エージェントは材料を整えるだけで、会話の主導権は人に置きたい

## 作法

1. `--dry-run` で brief と push コマンドを確認 (256 KB 上限・NDA ガード)
2. push 後は「載せた。送るのは宮崎さん」と 1 行報告して止まる。`--send` は宮崎さんの明示があるときだけ
3. 回答を取り込むときは `collect --engine <engine> --latest` (または `--url`、ペインのステータスバーの URL)
   → `answer.md` / `transcript.md`。ペインには読み戻し API が無い (2026-09-07)

## 注意

- ペインの composer セレクタは mycmux 側 (`src-tauri/src/commands/webpane.rs`) の固定値。Grok は `textarea` 前提で、
  実物は TipTap (`div.tiptap[role=textbox]`) のため **失敗する可能性が高い** (「composer was not found」)。
  その場合は `ask --engine grok` (OracleChrome 経路) を使い、修正は `references/app-side-web-read-spec.md` の項目 3
- ペインに載る文字数は 256 KB まで。長い添付は `ask` で本文インライン (60,000 字) に切り詰める
- `--tab` は `mycmux_agent_cli.py web-list` の `tabId`。指定しなければ同一ワークスペースの最新ペイン
