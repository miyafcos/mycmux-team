# mode: ask — 1 エンジンに投げて回答を回収する

```
python ~/.claude/skills/oracmux/scripts/oracmux.py ask --engine chatgpt|gemini|grok \
  (-q "問い" | --question-file Q.md) [--context-file C.md] [--constraints "..."] \
  [--file P [P ...]] [--via pane|oracle|cdp] [--tab <tabId>] [--close-tab] [--mode M] \
  [--upload P [P ...]] [--timeout-min N] [--slug s] [--dry-run] [--json]
```

`--file` / `--upload` は複数パスを続けて書けるし、繰り返しても書ける (glob 可)。

## 経路 (lane)

| `--via` | 実体 | 使う場面 |
|---|---|---|
| **pane** (既定・全エンジン) | 呼び出し元と同じペインに **裏タブ (非アクティブ)** で Web ペインを開き、`web.push` で送信、`web.read` で回収。mycmux 内で完結・Chrome 不要 | 通常はこれ。宮崎さんはタブを押せば会話をそのまま見られる |
| oracle (chatgpt のみ) | steipete/oracle CLI → 画面外 OracleChrome。モデル選択証跡・セッション保存・実アップロード (`--upload`) | PDF などをアップロードしたいとき・oracle の証跡が要るとき |
| cdp | 自前 Playwright ドライバ → OracleChrome。思考モード切替 (`--mode`) はこの経路だけ | pane が使えないとき (mycmux 外) やモード切替が要るとき |

pane 経路の前提: そのサービスのペインがログイン済みであること (`doctor` で `ok`)。サインアウトなら exit 3 で止まり、タブは残る (ペインの「別の窓でログイン」でログインして `--tab <tabId>` で再実行)。
`--mode` は pane 経路では効かない (クリック API が無い)。Web 側の選択状態 (GPT-6 Pro / Gemini Pro / Grok Expert) に従う。

## 作法 (母艦)

1. `--dry-run` で `brief.md` を作り、添付一覧 (未添付の理由つき) と文字数を確認する。60,000 字を超える分は落ちる
2. 本番は Bash `run_in_background: true`。出力はログファイルへ (`> run.log 2>&1`)
3. `<run>/<engine>/progress.json` の `phase` (connecting → composing → waiting_answer → answer_streaming → done/failed) と `chars` を 2〜3 分おきに読み、「gemini: streaming 1,200 字・3 分経過」のように 1 行報告
4. 終わったら `answer.md` を読む。ヘッダの `conversation_url` と meta.json の `tab_id` を報告に載せる (宮崎さんは裏タブを押せば同じ会話が見える)。
   回答本文は画面の表示テキスト (innerText) で Markdown 記法は復元されない。表・コードが要るなら会話 URL/タブを開く
5. 裏タブは既定で残す (`--close-tab` で回収後に閉じる)。同じ run フォルダで再実行すると前回の answer.md 等は `<engine>/_prev/<時刻>/` へ退避される

## 所要時間の目安 (2026-09-07 実測)

| engine | PING の往復 | 実務の問い |
|---|---|---|
| gemini (Pro) | 39〜40 秒 | 1〜5 分 |
| grok (Expert) | 39 秒 | 1〜5 分 |
| chatgpt (GPT-6 Pro) | 57 秒 (oracle 経路) / 78 秒 (cdp) | 5〜20 分 |

## 失敗時

| 症状 | 判定 | 次の一手 |
|---|---|---|
| exit 2 `timeout` (本文なし) / `partial` (途中まで) | 回答が出る前・出きる前に時間切れ | 会話は Web 側で続いていることが多い。`collect --engine X --tab <tabId>` (pane) か `--url <会話 URL>`。途中本文は partial.md にある |
| exit 3 (pane) `signed out` | ペインがサインアウト | ペインでログイン → `--tab <tabId>` で再実行。代わりにログインしない |
| exit 3 (chrome 経路) | ログイン切れ・captcha・枠切れ | 窓は出してあり、当該タブは残す。報告して止まる |
| exit 4 `composer did not appear` / `pane: …` | Web ペインが応えない・セレクタ不一致 | `doctor` でタブ状態を見る。cdp 経路は `<engine>/fail.png` |
| exit 7 `mycmux unavailable` | mycmux が動いていない・ソケット不一致 | mycmux 内で叩く。外なら `--via cdp` |
| oracle 経路で `Attachments did not finish uploading` | 実アップロードの詰まり | `--upload` を外して本文インライン (既定) に戻す |
| oracle 経路で `same prompt is already running` | ゾンビ session | `~/.oracle/sessions/<slug>` を `~/.oracle/zombie-quarantine/` へ移す (削除しない) |

## 例

```
# Gemini に設計判断の裏取り (裏タブで実行・経緯ファイル+設計書 2 本を展開)
python ~/.claude/skills/oracmux/scripts/oracmux.py ask --engine gemini \
  --question-file Q.md --context-file keii.md --file docs/plans/2026-08-27-*.md

# ChatGPT に PDF を実アップロードして最終判定 (oracle 経路)
python ~/.claude/skills/oracmux/scripts/oracmux.py ask --engine chatgpt --via oracle --question-file Q.md --upload spec.pdf
```
