# mode: followup — 開いている会話に続けて質問する

```
python ~/.claude/skills/oracmux/scripts/oracmux.py followup --engine E (-q "問い" | --question-file F) \
  [--tab <tabId>] [--file P ...] [--run-dir D] [--timeout-min N] [--close-tab] [--dry-run] [--json]
```

oracle の `--browser-follow-up` に当たる。`ask` は裏タブを残すので、**その会話にそのまま重ねて聞ける**。
会話の履歴はサービス側に残っているため、前の回答を指して「そこをもう少し」「根拠を出して」が通る。

## ask との違い

| | ask | followup |
|---|---|---|
| タブ | 新しい裏タブを開く | **既にある会話を使う** (`--tab`・省略時はそのサービスの最新の裏タブ) |
| モデルの確認 | する (違えば直す) | **しない** — 会話は始めたモデルに固定されるため |
| Deep Research | `--research` で有効化できる | **しない** — 会話の設定を引き継ぐ |
| 履歴 | 空から始まる | 前のやり取りを踏まえて答える |

`--tab` を省くと、そのサービスの**最後に開いた裏タブ**を使う。会話が複数あるときは `web-list` か
`ask` の出力にある tabId を明示する。

## 使いどころ

- 回答が浅い / 前提を取り違えている → 前提を補って聞き直す (新しい会話より文脈が効く)
- 長い調査の続き → 「その 3 番目の論点だけ深く」
- 出力形式の直し → 「同じ内容を表で」
- Deep Research の結果に対する追い質問 (深い調査は 1 回で済ませ、詰めは followup で)

## 注意

- **1 回の followup も Web ターンを 1 つ消費する**。ask と同じ重さ
- NDA ガードは ask と同じように効く (`guard.json`)
- 会話が長くなるとサービス側が古い部分を切ることがある。回答が文脈を失っていたら新しい `ask` に切り替える
- 会話タブを閉じた後は続けられない。`collect` で本文だけ回収する

## 例

```
# 直前の ask の会話にそのまま重ねる (タブ省略)
python ~/.claude/skills/oracmux/scripts/oracmux.py followup --engine chatgpt \
  -q "3 番目の案について、反対意見と反証をそれぞれ 2 つ挙げてください。"

# タブを明示して、資料を足しながら続ける
python ~/.claude/skills/oracmux/scripts/oracmux.py followup --engine gemini \
  --tab 52877350-0424-4eb5-bb77-67d04c339234 \
  --question-file Q2.md --file docs/plans/*.md
```
