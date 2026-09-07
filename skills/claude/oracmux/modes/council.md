# mode: council — 同じ引き継ぎ書を 3 つの Web に並列で投げ、母艦が裁定する

```
python ~/.claude/skills/oracmux/scripts/oracmux.py council (-q "問い" | --question-file Q.md) \
  [--engines chatgpt,gemini,grok] [--file ...] [--mode-gemini pro] [--mode-grok expert] \
  [--timeout-min 30] [--no-html] [--dry-run] [--json]
```

fusion (Claude+Codex+agy の CLI 合議) の Web 版。価値は**訓練系統も検索も違う 3 本の間違え方が相関しない**こと。
費用は Web ターン 3 つ (ChatGPT Pro の 1 ターンを含む)。軽い問いに使わない。

## 動き

1. brief を 1 本作り (読者＝ChatGPT / Gemini / Grok)、NDA ガードを通す
2. 各エンジンを `ask --run-dir <run> --via cdp` の**別プロセス**で 2 秒ずらして起動 (同じ OracleChrome に 3 タブ)
3. 30 秒おきに `progress.json` を集めて 1 行ログ (`chatgpt=answer_streaming(1200c) gemini=done(900c) grok=waiting_answer(0c)`)
4. 全レーン終了後 `council.md` (回収状況の表 + 各回答 + judge 欄) と HTML (`quick_html.py`) を書く

`--engines` で 2 本に絞れる。1 本でも ok なら exit 2 (部分)、全滅なら exit 1。

## 母艦の仕事 = judge と合成

`council.md` の末尾テンプレ (正本 `references/judge-template.md`) を埋める:
合意点 / 矛盾点 (どちらが妥当か・根拠) / カバー範囲の差 / 固有の洞察 / 盲点 → 合成回答 (結論・根拠・confidence)。
多数決ではなく**根拠の強さ**で決める。矛盾が残るときは両論併記で宮崎さんへ。

判定を `judge.md` (同じ run フォルダ) に書き、報告は HTML のパスと run フォルダを独立行バッククォートで。
HTML は `council.md` を作った時点のもの (judge 欄は空)。judge を書いた後に読ませたければ
`python ~/.claude/scripts/quick_html.py --title "<件名> council" --md <run>/council.md` を再実行する。

## 使わない場面

- 事実確認 1 件・軽微な判断 (ask 1 本で足りる)
- 正解が機械照合で決まるもの (Codex Dual-Verify の領分)
- 素材に社外秘が混じるもの (ガードが止めるが、そもそも Web に出さない)
