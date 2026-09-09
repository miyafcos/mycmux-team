# mode: smoke — 実射の生存確認 (Web ターンを消費する)

```
python ~/.claude/skills/oracmux/scripts/oracmux.py smoke [--engines a,b] [--with-upload] [--timeout-min N] [--json]
```

**なぜ要るか**: pytest は `pane.web_*` を差し替えて回すので、ソケットから先 (mycmux CLI・Rust・注入 JS・
サービスの DOM) を 1 行も通らない。**全経路が生きている証拠は実射でしか取れない**。
2026-09-09 に 121 件全緑のまま ChatGPT が送信を飲んでいた、というのが実例。

## 何をするか

エンジンごとに毎回ちがう合言葉を作り、**この CLI を子プロセスとして** `ask` で撃つ (argparse・引き継ぎ書生成・
ガード・ソケット・DOM まで本番と同じ経路を通す)。回答にその合言葉が含まれていれば PASS。
`--with-upload` を付けると、**ファイルの中にしか書いていない 2 つ目の合言葉**も答えさせる。
モデルが「それらしい」返事でごまかせないので、通れば添付が本当に読まれた証拠になる。

## コスト

**1 エンジン = 1 Web ターン**。既定は Gemini 1 本だけ (ChatGPT Pro は週次枠なので既定に入れない)。
3 本まとめて撃つなら `--engines chatgpt,gemini,grok`。

## 読み方

| 出力 | 意味 | 次の一手 |
|---|---|---|
| `PASS` | 全経路が生きている | そのまま使ってよい |
| `FAIL` | 送れた/回収できたが合言葉が無い、または ask が異常終了 | `doctor --deep` でセレクタのズレを見る。run フォルダの `answer.md` と `progress.json` を読む |
| `NEEDS HUMAN` | ログイン切れ・添付が表示されない・送信が受理されない | タブは残してある。ペインを見て人が直す |

exit: 0 = 全部 PASS / 1 = FAIL あり / 3 = 要人手あり / 7 = mycmux 外。台帳には `smoke_pass` / `smoke_fail` で残る。

## いつ叩くか

- 月 1 回 (定期)
- 久しぶりに使う前・重い相談 (council や Pro 枠) の前
- `doctor --deep` が DRIFT を出してセレクタを直した直後 (直ったことの確認)
- サービス側の UI が変わったと感じたとき

**先に `doctor --deep` を叩く**。あちらは 0 円でセレクタとモデルを見られるので、smoke を撃つ前に潰せるものは潰す。

## 例

```
# 既定 (Gemini 1 本・添付なし)
python ~/.claude/skills/oracmux/scripts/oracmux.py smoke

# 3 サービス + 添付経路まで (3 ターン消費・月 1 の定期点検)
python ~/.claude/skills/oracmux/scripts/oracmux.py smoke --engines chatgpt,gemini,grok --with-upload
```
