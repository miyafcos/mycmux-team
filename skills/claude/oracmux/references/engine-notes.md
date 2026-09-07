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
| モデル/effort | Web 側の選択に従う (`modelStrategy: current`)。9/5 以降は GPT-6 Pro を picker で選んだ状態が前提。ヘッダの `model-switcher-dropdown-button` は空 (ラベル取得不可) |
| Deep Research | `composer-plus-btn` → `div.__menu-item:has-text('Deep research')` (`role=menuitem` は付かない)。到達 2/3 (8/25)・reachable (9/7 preflight) |
| 枠切れ | 画面文言 `Weekly limit` / `Add credits` = Work ワークスペースの週次上限。`doctor --switch-to-chat` で Chat (個人 Pro) へ |
| 添付 | 実アップロードは詰まる (8/31: md 5 本 107 KB で 2 回 timeout)。既定は本文インライン。多行 JSON は 1 行に圧縮 (9/2: 2,770 行が投稿されず・1 行なら 1 分 41 秒) |
| 履歴 | `nav a[href^='/c/']`。先頭にピン留め (`aria-label` に `pinned conversation`) が並ぶので飛ばす |
| 回答要素 | `[data-message-author-role='assistant']` (最後の要素)。停止 = `[data-testid='stop-button']` |
| oracle CLI | `-m gpt-6-astra` は 0.18.0 が知らず gpt-5.2 扱いになる → `-m` を渡さない。ハング時は `oracle session <slug>` で再接続、会話 URL は `sessions/<slug>/meta.json` の `browser.harvest.url` |

## Gemini

| 項目 | 実測 |
|---|---|
| アカウント | `miyazaki.fcos@gmail.com` (aria の「Google アカウント」に出る)。ペインの `web-profiles/google` と同一のはず【要確認: ペイン側で初回ログインした Google アカウント】 |
| モード | picker = `button[aria-label^='モード選択ツールを開く（現在のモデル: Pro）']` → 現状 Pro (= 3.1 Pro)。メニュー項目は 3.1 Pro / 3.7 Flash / 3.5 Flash-Lite / 強化版思考モード (8/25)。doctor の mode label は「Pro」(可視要素の走査で取れる・9/7 12:40) |
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
| mycmux ペイン | プリセットの composer が `textarea` 前提で実物 (TipTap) と合わない → push は失敗見込み (app 側 spec 項目 3) |

## mycmux ペイン (pane 経路) の実測 (2026-09-07・テスト機 profile webread・本番の web-profiles を複製)

| 項目 | 実測 |
|---|---|
| 裏タブの hidden webview | `web.open --background` で作られ、非アクティブのままページをロードし `web.read` に応える (Gemini: signedOut=false / composerPresent=true / title "Google Gemini") |
| Gemini push | 送信ボタンが日本語ラベルのため旧セレクタで失敗 → 修正版で再実射 |
| ChatGPT ペイン | `google` プロファイルは Google ログインのみで ChatGPT 自体は未ログイン (title「ChatGPT: Chat, Work, Create & Code with AI」・composer 無し)。ペインでの ChatGPT ログインが 1 回要る |
| Grok ペイン | `grok` プロファイル (9/4) は未ログイン相当 (composer 無し)。ペインでのログインが 1 回要る |
| signedOut 判定 | URL パターン依存なので、未ログインの着地ページ (root URL) では false のまま。oracmux は composer 不在を「未ログインの可能性」として exit 3 で止める |

## 変更履歴

- 2026-09-07 初版 (`scripts/probe_dom.py` の前身で実 DOM を採取。Gemini/Grok の PING・collect を実測)
