# エンジン別の実測メモ (セレクタの正本は `scripts/engines.json`。ここは理由と履歴)

計測環境: OracleChrome (Chrome 152・CDP 9222・プロファイル `%LOCALAPPDATA%\OracleChrome`)。
UI が変わったら **engines.json を直し、この表に日付と症状を 1 行足す**。壊れたセレクタを推測で直さない
(fail.png と `python scripts/probe_dom.py --engine <id> [--wide] [--selector ...]` で実 DOM を見る。送信も click もしない読み取り専用)。

## 共通

| 項目 | 実測 | 日付 |
|---|---|---|
| 3 サイトのログイン | 同一プロファイルで全部生存。composer 出現まで 2〜10 秒 (SPA なのでポーリング必須) | 2026-09-07 |
| composer は textarea ではない | ChatGPT=ProseMirror `#prompt-textarea` / Gemini=Quill `div.ql-editor[role=textbox]` / Grok=TipTap `div.tiptap[role=textbox]` | 2026-08-23 |
| 送信ボタンは本文を入れるまで DOM に無い | 入力後に `send` を待つ (最大 15 秒)。無ければ Enter | 2026-08-23 |
| 開いたメニューの再クリックはオーバーレイに阻まれる | Radix 系 (ChatGPT/Grok)。モード切替は 1 段ずつ・失敗時は Escape | 2026-08-23 |
| 完了判定 | baseline (送信前の最後の回答) と違う本文が出てから、停止ボタン無し + 長さ不変 20〜30 秒 + 最低待ち | 2026-08-25 |
| 回答の先頭にキャプション行 | Gemini「Gemini の回答」/ Grok「Worked for 1s」→ `answer_strip_patterns` で除去 (transcript は生のまま) | 2026-09-07 |
| PING の所要 | Gemini 39 秒・Grok 39 秒 (appeared 5 秒 + 安定 20 秒 + 最低待ち)・ChatGPT 57 秒 (oracle 経路・evidence 行あり) | 2026-09-07 |

## ChatGPT

| 項目 | 実測 |
|---|---|
| モデル/effort | Web 側の選択に従う (`modelStrategy: current`)。9/5 以降は GPT-6 Pro を picker で選んだ状態が前提。**切替ボタンは 9/9 に `button[aria-label='モデルを切り替える']` へ変わった** (旧 `model-switcher-dropdown-button` は消滅)。どちらもモデル名を持たないので、**ChatGPT だけは選択中モデルを機械で読めない** — 人が picker を見る |
| Deep Research | `composer-plus-btn` → `div.__menu-item:has-text('Deep research')` (`role=menuitem` は付かない)。到達 2/3 (8/25)・reachable (9/7 preflight) |
| 枠切れ | 画面文言 `Weekly limit` / `Add credits` = Work ワークスペースの週次上限。`doctor --switch-to-chat` で Chat (個人 Pro) へ |
| 添付 | **oracle 経路の**実アップロードは詰まる (8/31: md 5 本 107 KB で 2 回 timeout)。**pane 経路の `--upload` は 9/9 に実射で通った**。多行 JSON は 1 行に圧縮 (9/2: 2,770 行が投稿されず・1 行なら 1 分 41 秒) |
| 履歴 | `nav a[href^='/c/']`。先頭にピン留め (`aria-label` に `pinned conversation`) が並ぶので飛ばす |
| 回答要素 | `[data-message-author-role='assistant']` (最後の要素)。停止 = `[data-testid='stop-button']` |
| oracle CLI | `-m gpt-6-astra` は 0.18.0 が知らず gpt-5.2 扱いになる → `-m` を渡さない。ハング時は `oracle session <slug>` で再接続、会話 URL は `sessions/<slug>/meta.json` の `browser.harvest.url` |

## Gemini

| 項目 | 実測 |
|---|---|
| アカウント | `miyazaki.fcos@gmail.com` (aria の「Google アカウント」に出る)。ペインの `web-profiles/google` と同一のはず【要確認: ペイン側で初回ログインした Google アカウント】 |
| モード | picker = `button[aria-label^='モード選択ツールを開く（現在のモデル: ']`。メニュー項目は 3.1 Pro / 3.7 Flash / 3.5 Flash-Lite / 強化版思考モード (8/25)。**選択中モデルは固定ではない — 9/7 は Pro・9/9 は Flash だった**。`doctor --deep` がラベルをそのまま出すので、重い相談の前に人が見る |
| Deep Research | 「アップロードとツール」の先に届かない (8/25 0/3・9/7 preflight unreachable)。`--mode deep-research` は current に落ちる |
| UI 言語 | 日本語。aria-label も日本語 (`プロンプトを送信` / `停止` / `チャットを新規作成`)。**mycmux ペインの push もこのラベルが要る** (9/7 テスト機: 旧プリセット `Send` では「submit button was not found」→ feat/web-read で修正) |
| 履歴 | `a[href^='/app/']` (先頭が最新・9/7 に `--latest` で自分の PING 会話を回収済)。会話 URL = `/app/<16 hex>` |
| 回答要素 | `model-response` (最後)。user 側は `user-query`。transcript 2 ターン取得済 (9/7) |
| キャプション | 「Gemini の回答」が先頭行に混ざる → strip |

## Grok

| 項目 | 実測 |
|---|---|
| モード | `button#model-select-trigger[aria-label='Model select']` の文字 = Expert (9/7)。メニューは Auto / Fast / Expert / Build / Heavy。DeepSearch は消滅 (8/23) |
| モーダル | 「Be the first to try new features / Receive emails …」が composer を塞ぐ → `No, thank you` を押す (`dismiss`)。preflight が `composer absent` を誤報する (9/4) |
| 履歴 | `a[href^='/c/']` (サイドバー・9/7 実測 30 件)。会話 URL = `/c/<uuid>?rid=…` |
| 回答要素 | `[data-testid='assistant-message']`。user 側 `[data-testid='user-message']` (transcript 2 ターン取得済 9/7)。composer の testid = `chat-input` |
| キャプション | 「Worked for 1s」が先頭行 → strip |
| 枠 | Chat / Imagine / Build の週次共有プール。残量は grok.com Settings→Usage |
| mycmux ペイン | composer は 9/7 の feat/web-read で TipTap に修正済み。9/9 に `--upload` つきの実射が通った (44 秒) |

## mycmux ペイン (pane 経路) の実測 (2026-09-07・テスト機 profile webread・本番の web-profiles を複製)

| 項目 | 実測 |
|---|---|
| 裏タブの hidden webview | `web.open --background` で作られ、非アクティブのままページをロードし `web.read` に応える (Gemini: signedOut=false / composerPresent=true / title "Google Gemini") |
| Gemini push | 送信ボタンが日本語ラベルのため旧セレクタで失敗 → 修正版で再実射 |
| ChatGPT ペイン | `google` プロファイルは Google ログインのみで ChatGPT 自体は未ログイン (title「ChatGPT: Chat, Work, Create & Code with AI」・composer 無し)。ペインでの ChatGPT ログインが 1 回要る |
| Grok ペイン | `grok` プロファイル (9/4) は未ログイン相当 (composer 無し)。ペインでのログインが 1 回要る |
| signedOut 判定 | URL パターン依存なので、未ログインの着地ページ (root URL) では false のまま。oracmux は composer 不在を「未ログインの可能性」として exit 3 で止める |

## pane 経路の添付 (`--upload`) の実測 (2026-09-09・**本番の mycmux v0.67.2**・テスト機ではない)

`web.upload` はサービス自身の隠し file input へ `DataTransfer` でファイルを載せ、`input`+`change` を発火する。
**OS のファイル選択ダイアログは開かない** (開く導線＝メニューの「ファイルをアップロード」項目は押さない)。

| 項目 | 実測 |
|---|---|
| file input がいつ生えるか | **ChatGPT `input#upload-files`・Grok `input[type=file].hidden` は読込時点で存在**。**Gemini は存在しない** — `button[aria-label='アップロードとツール']` (`aria-haspopup=menu`・安定した data-test-id は無い) を押すと `input.hidden-file-input` が 2 個生える |
| 受理の確認 | サービス自身のプレビューにファイル名が出るまで待つ。**フルネームか stem のどちらかで照合する** — Gemini は `TXT` + stem の 2 要素でフルネームを出さない (下の「ズレ検知」参照)。file input の `files.length` は証拠にならない (Gemini は受理後に input を外す) |
| **ChatGPT の送信が飲まれる** | **添付のアップロードが終わる前に送信すると、本文も添付も composer に入ったまま何も起きない** (turn 0・URL は `chatgpt.com/` のまま・エラーも出ない)。送信ボタンは事後に見ると enabled なので、後から状態を見ても分からない。対策 = `pane_driver.confirm_submitted` (composer に本文が残っていて・turn が増えず・会話 URL でもないときだけ送信を押し直す。最大 2 回) |
| 実測の所要 | Grok `--upload` 44 秒 (attach 2 秒)・ChatGPT は Pro で 5 分超 (attach 後の送信押し直しを含む) |
| 上限 | 合計 25MB (`WEB_PANE_UPLOAD_LIMIT`)。超過は送信前に弾く |
| 到達確認 | 3 サービスとも「添付の中身にしか書いていないトークン」を答えさせて確認 (Gemini `ZEBRA-7741` / Grok `TOKEN-GROK-8812` / ChatGPT `TOKEN-CHATGPT-8812`) |

## セレクタのズレ検知 (`doctor --deep`・2026-09-09 新設)

engines.json のセレクタを実 DOM と突き合わせる。**Web ターンを消費しない**ので、重い相談の前に必ず叩く。
初回実行で 2 件のズレを検知した。

| 検知 | 実測 | 対応 |
|---|---|---|
| ChatGPT `mode_label` が 0 件 | `[data-testid='model-switcher-dropdown-button']` が DOM から消えていた。現物は `button[aria-label='モデルを切り替える']` (Radix の `aria-haspopup=menu`) | engines.json を差し替え。**このボタンにモデル名は入っていない** (innerText・title・兄弟すべて空) ので、ChatGPT だけは選択中モデルを読めない |
| Gemini が Flash だった | picker のラベル `モード選択ツールを開く（現在のモデル: Flash）`。SKILL の「Gemini=Pro」は 9/7 の記録 | ラベルを doctor に出すようにした。使う前に人が見る |
| Gemini の添付チップは拡張子を落とす | `TXT` + `oracmux_smoke_probe` の 2 要素で、`oracmux_smoke_probe.txt` という文字列は画面に無い。Grok/ChatGPT はフルネームを出す | 受理判定を **フルネームか stem のどちらか**に緩めた。緩める前は Gemini の添付が全部 needs_human になっていた (smoke が検知) |

## モデル選択の実測と自動化 (2026-09-09・`ensure_model`)

**実測時点で 3 サービス中 2 つが安いモデルだった** (Gemini=Flash・Grok=ファスト)。書類はどれも Pro / Expert と書いていた。
ask は毎回 picker を読み、違えば選び直し、読み直して確かめてから送る。確かめられなければ 1 ターンも使わず exit 3。

| エンジン | picker のセレクタ | 現在のモデルの在り処 | メニュー行 | 期待値 |
|---|---|---|---|---|
| ChatGPT | `button.__composer-pill[aria-haspopup='menu']` (入力欄の横) | **ボタンの innerText がモデル名** (`6 Pro`) | `[role=menuitem]` (`6 Pro`) | `Pro` |
| Gemini | `button[aria-label*='モード選択']` | aria-label の `現在のモデル: ○○` (`model_pattern` で抽出) | `[role=menuitem]` (`3.1 Pro / 高度な推論`) | `Pro` |
| Grok | `button#model-select-trigger` | ボタンの innerText (`エキスパート`) | `[role=menuitemradio]` + `aria-checked` (`自動/ファスト/エキスパート/Build/ヘビー`) | `エキスパート` |

**罠**: ChatGPT の picker は**新規チャット画面にしかない**。会話ページにある
`button[aria-label='モデルを切り替える']` は**メッセージ単位の再試行**ボタンで、押すと「6 Pro をもう一度試す」
メニューが出る。9/9 午前に一度これを picker と誤認して engines.json に入れた (`doctor --deep` は
「1 件マッチ」で緑になってしまい、誤りに気づけなかった) — **セレクタを直したら必ず実物の要素を見て確かめる**。

実射で確認 (本番): ChatGPT `6 Pro` は既選択のまま 64 秒、Gemini は Flash から Pro へ**自動で切り替えて** 41 秒、
Grok は `エキスパート` 既選択のまま 36 秒。証跡は `answer.md` の `model` / `model_evidence`。

## Deep Research の実測 (2026-09-09)

| エンジン | 導線 | 有効化の確認 | 状態 |
|---|---|---|---|
| ChatGPT | `[data-testid='composer-plus-btn']` → `div.__menu-item` の「Deep Research / 詳細レポートを取得」 | **composer に「Deep Research」ピルが出る** | <b>実測で確認済み</b> |
| Gemini | 「アップロードとツール」→「その他のツール」→ `[role=menuitemcheckbox]` の「Deep Research」 | 同じ行の `aria-checked` | メニュー行は実在するが、手動 2 回とも `aria-checked` が false のまま。**要再測** (Pro に切り替えてからも不成立) |
| Grok | なし | — | DeepSearch は廃止・`エキスパート` が最深 |

`ensure_research` は各段を待って押し、**最後に有効化を画面で確認する**。確認できなければ送らずに exit 3。
oracle 側も `--browser-research deep` は ChatGPT 専用なので、機能の対応関係としてはこれで揃っている。

## 変更履歴

- 2026-09-09 pane 経路の `--upload` を実装 (3 サービス実測)。**本番 mycmux での初実射**: Gemini ask 39 秒 (`ORACMUX-PROD-OK`)・回帰 33 秒 (`ORACMUX-REGRESS-OK`・二重送信なし)。Gemini の picker ラベルが **Flash** になっていた (SKILL.md の「Gemini=Pro」は 9/7 時点の記録)
- 2026-09-07 初版 (`scripts/probe_dom.py` の前身で実 DOM を採取。Gemini/Grok の PING・collect を実測)
