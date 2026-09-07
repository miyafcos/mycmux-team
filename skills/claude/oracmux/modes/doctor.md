# mode: doctor — 前提点検と復旧

```
python ~/.claude/skills/oracmux/scripts/oracmux.py doctor [--json] [--chrome] [--no-web] [--up] [--switch-to-chat]
```

既定は pane 経路の点検 (数秒)。`--chrome` を付けると OracleChrome 経路 (oracle / cdp) も 3 サイトを開いて点検する (30〜40 秒)。

| 行 | 見るもの | ok の条件 |
|---|---|---|
| mycmux | `MYCMUX_TERM_PROGRAM`・ソケット (`web-list`)・開いている Web タブ (background / active) | socket=ok |
| chatgpt / gemini / grok (pane) | そのサービスの Web タブを `web.read` して signedOut / composer / generating / ターン数 | `ok` = ログイン済みで composer あり。`no_tab` = 開いていない (異常ではない。ask が裏タブを開く) |
| chrome (`--chrome`) | `http://127.0.0.1:9222/json/version`・oracle セッション (`~/.oracle/sessions/*/meta.json`) | alive=True・alive セッション 0 本 |
| chatgpt / gemini / grok (chrome) | 実ページを開いて login 導線・captcha・composer・枠切れ文言・モードラベル | `ok — logged in, composer available` |

exit: 0 = ソケット ok で全サービスが ok か no_tab / 3 = サインアウト・captcha・枠切れのサービスあり / 7 = mycmux ソケット不通 (または --chrome で Chrome 落ち) / 1 = その他 (composer 不在・プローブ例外)。

## 復旧表

| 症状 | 原因 | 手 |
|---|---|---|
| pane `not_logged_in` | ペインがサインアウト | 宮崎さんに「ペインの『別の窓でログイン』でログインしてください」と 1 行報告。代わりにログインしない |
| pane `mycmux_down` / exit 7 | mycmux 外・ソケットトークン不一致 | mycmux 内で叩く。外なら `--via cdp` |
| pane `composer_absent` | ページ読込中・モーダル | 数十秒後に再点検。続くならタブを閉じて開き直す (`web-close` → ask が開く) |
| chrome `not_logged_in` / `captcha` | OracleChrome のログイン切れ | `oracle-chrome show` で窓を出して報告。済んだら `oracle-chrome hide` |
| chrome chatgpt `limit` | ChatGPT Work の週次上限 | `doctor --chrome --switch-to-chat` |
| chrome alive=False | OracleChrome 落ち | `doctor --chrome --up` |
| oracle session alive=True | 誰かの consult が走行中 (cdp/oracle 経路のみ影響) | 待つか `--force` |
| oracle session zombie=True | kill された CLI の残骸 | `~/.oracle/sessions/<id>` を `~/.oracle/zombie-quarantine/` へ移動 (削除しない) |
