---
name: oracmux
description: "oracle 型の相談 (引き継ぎ書+添付を投げて回答を回収) を ChatGPT / Gemini / Grok の Web に広げ、mycmux の Web ペイン (呼び出し元と同じペインの裏タブ) で完結させる入口。単発 ask・三者並列 council・ペインへの push・ペインの会話の collect・前提点検 doctor。最終判定ゲートの裏取り、設計判断の異系統チェック、Web 本家モデルの比較に使う。"
metadata:
  triggers:
    - "oracmux"
    - "Gemini の Web に聞いて"
    - "Grok に聞いて"
    - "ChatGPT に聞いて"
    - "Oracle に相談して"
    - "三者に聞いて"
    - "Web の AI 三つで比べて"
    - "ペインに載せて"
    - "ペインの会話を回収して"
  exclusions:
    - "CLI 3 系統 (Claude+Codex+agy) の合議=fusion"
    - "7 系統のディープリサーチ=ultra-deep-research"
---

# oracmux — oracle を 3 つの Web に広げ、mycmux の裏タブで完結させる

oracle (steipete・ChatGPT Pro の Last-Resort ゲート) の「引き継ぎ書+添付を投げて回答を回収する」型を、
ChatGPT / Gemini / Grok の Web 本家へ広げる。実体は決定論スクリプト `scripts/oracmux.py`。
**既定の経路は pane**: 呼び出し元と同じペインに裏タブ (非アクティブ) で Web ペインを開き、`web.push` で送り、`web.read` で回収する。
Chrome も CDP も使わない。宮崎さんは裏タブを押せばその会話をそのまま見られる。エージェントが読む場所は `~/.mycmux/handoff/oracmux/<run>/`。

## モード判定 (依頼を受けて 3 秒で)

| 依頼の型 | モード | 詳細 |
|---|---|---|
| 1 つの Web モデルに聞いて回答が要る (Oracle 相談・Gemini/Grok の意見) | **ask** | `modes/ask.md` |
| 同じ問いを 3 系統で比べて裁定したい (異系統 Web 合議) | **council** | `modes/council.md` |
| 宮崎さんが Web ペインで自分の手で会話したい・送る前に見たい | **push** | `modes/push.md` |
| 開いている会話に続けて聞く (深掘り・言い直し・形式直し) | **followup** | `modes/followup.md` |
| ペインで進めた会話 (or 時間切れの会話) をファイルに取り込む | **collect** | `modes/collect.md` |
| 「動くか見て」「ログイン切れ？」 | **doctor** | `modes/doctor.md` |
| 「本当に動く？」「久しぶりに使う」「セレクタ古びてない？」 | **smoke** | `modes/smoke.md` |

迷ったら `doctor` → `ask`。3 系統の CLI 合議は fusion、調査は ultra-deep-research (本スキルは「回答を 1 つ取る」用)。

## テストは何を守っていないか (2026-09-09・ここを読まずに「テスト緑=動く」と言わない)

pytest 131 件は **`pane.web_*` を差し替えて回す**。守っているのは待ち受け判定・NDA ガード・整形・分岐だけで、
**ソケットから先 (mycmux CLI → Rust → 注入 JS → サービスの DOM) は 1 行も通らない**。
だから **サービス側の画面変更はテストでは絶対に検知できない**。実際 2026-09-09 に、全緑のまま
ChatGPT が送信を飲み、**Gemini は Flash・Grok は ファスト** に変わり、ChatGPT の picker セレクタが消えていた
(3 サービス中 2 つが安いモデルのまま動いていた)。

| 確かめたいこと | 使う | Web ターン | 目安 |
|---|---|---|---|
| ログイン・タブの生死 | `doctor` | 消費しない | 実行のたび |
| **セレクタが実 DOM と合っているか・今どのモデルか** | **`doctor --deep`** | **消費しない** | 週 1・久しぶりに使う前。**ask は毎回自分で確認して直すので、これは点検用** |
| 送信から回収までの全経路 | `smoke [--with-upload]` | **1 エンジン 1 ターン** | 月 1・重い相談の前・`--deep` が DRIFT を出した後 |
| ロジックの回帰 | `python -m pytest scripts/tests -q` | 消費しない | コードを触ったら |

**重い相談 (council・長い brief・Pro 枠を使う ChatGPT) の前は `doctor --deep` を先に叩く**。数十秒で、
セレクタのズレとモデルの取り違えを 0 円で潰せる。

## 経路 (`--via`)

| 経路 | 実体 | 位置づけ |
|---|---|---|
| **pane** (既定) | mycmux Web ペインの裏タブ + `web.push` / `web.read` / `web.upload` (mycmux v0.65 以降・添付は v0.66 以降) | 通常はこれ。3 エンジンとも `--upload` 可。ログインはペイン側 (`web-profiles/google` / `grok`) |
| oracle (chatgpt のみ) | steipete/oracle CLI → 画面外 OracleChrome | oracle の証跡が要るときだけ。添付は pane で足りる |
| cdp | 自前 Playwright ドライバ → OracleChrome | mycmux 外・`--mode` (思考モード切替) が要るとき。添付は不可 |

## 共通手順

1. **前提点検**: `python ~/.claude/skills/oracmux/scripts/oracmux.py doctor` (数秒。ソケット・各サービスのペインのログイン状態。`no_tab` は正常)
2. **材料**: 問い (`-q` か `--question-file`)、経緯 (`--context-file`)、制約、添付。添付は 2 種類 — `--file`
   はテキストを引き継ぎ書の本文に展開する (差分・ログ・md 向き)。`--upload` は実ファイルをサービスへ添付する
   (PDF・画像・Office 向き・pane 経路は 3 エンジンとも可・合計 25MB まで)。どちらも glob 可。
   引き継ぎ書の書き方は `references/brief-template.md` (読者・語り手の行はスクリプトが先頭に置く)
3. **実行**: ask / council は数分〜数十分かかるので **Bash は `run_in_background: true`** で回し、`<run>/<engine>/progress.json`
   を 2〜3 分おきに読んで 1 行報告する (無音区間を作らない)。時間切れでも**再送しない** (`collect --tab` で回収する)
4. **回収・報告**: `answer.md` (先頭に status / mode / 会話 URL のヘッダ・meta.json に `tab_id`) を読んで裁定する。council は `council.md` の
   judge 欄を母艦が埋め、HTML (`quick_html`) のパスと run フォルダを独立行バッククォートで報告する

## 鉄則

- **NDA・社外提供不可の素材は投げない**。`guard.json` のマーカー・deny_roots で機械ブロック (exit 5)。`--allow-markers` は人が中身を確認した後だけ
- **1 consult = Web 1 ターン消費** (ChatGPT Pro は週次枠・Grok は Chat/Build 共有プール)。大量バッチに使わない。PING 以外の再試行は原因を直してから
- **裏タブは残す** (宮崎さんが見るため)。閉じるのは `--close-tab` を付けたときだけ。フォーカスは奪わない (`web.open background`)
- **push は載せるだけ**。送信は宮崎さんのクリックか `--send` 明示。Pro のターンは取り消せない
- **サインアウト (exit 3) は止まって報告**: ペインの「別の窓でログイン」を案内し、代わりにログインしない・認証情報を扱わない
- **モデルは実行のたびに確認し、違えば選び直してから送る (2026-09-09〜)**。pane 経路は毎回 picker を読み、`engines.json` の `expected_model` (ChatGPT/Gemini=`Pro`・Grok=`エキスパート`) と違えばメニューで選び直し、**選び直せたことを読み直して確かめてから**送る。確かめられなければ **1 ターンも使わずに exit 3 で止まる**。証跡は `answer.md` の `model` / `model_evidence` に残る (oracle の "Model selection evidence" と同じ役割)。`--model <名前>` で上書き、`--any-model` で確認を省略
- **ChatGPT の picker は新規チャット画面にしか無い**。会話の中にある「モデルを切り替える」ボタンは**メッセージ単位の再試行**であって picker ではない。`--tab` で会話中のタブを再利用すると picker が見つからず exit 3 になる (既定の新規裏タブなら問題ない)
- **Deep Research は `--research`** (ChatGPT は実測済み・Gemini はメニューまで到達・Grok は該当機能なし)。有効化を画面で確認できなければ**送らずに exit 3** で止まる (浅い回答に Pro ターンを使わないため)。所要は数十分単位なので `run_in_background` で回し `progress.json` を見る
- **同じ引き継ぎ書の二重起動は止まる**。走行中の同一 brief があれば exit 7 で拒否し、走行中の run を指す。意図して 2 回投げるときだけ `--force` (1 回 = 1 ターン)
- **続けて聞くのは `followup`**。裏タブの会話にそのまま重ねる。モデル確認と Deep Research は会話の設定を引き継ぐので再実行しない
- **ChatGPT のプロジェクト内で聞くときは `--url`** (`ask --url https://chatgpt.com/g/.../project`)
- **生ログを母艦に流さない**: 読むのは `answer.md` / `council.md` / `progress.json` だけ。lane.log は失敗時のみ
- **回答は表示テキスト** (Markdown 記法なし・描画済みターンのみ)。構造が要るときは会話タブ/URL を開く。セレクタは `scripts/engines.json` と mycmux 側 `webpane.rs` の reader 表 (同値を保つ)
- OracleChrome 経路 (oracle / cdp) は oracle セッション走行中なら待つ (exit 6)。`--force` は理由を報告に書く

## 出力の置き場と台帳

```
~/.mycmux/handoff/oracmux/<YYMMDD-HHMM>-<slug>/   brief.md / request.json / council.md / judge.md
  <engine>/answer.md | partial.md / meta.json (tab_id・URL) / progress.json / citations.txt / transcript.md / _prev/
~/.mycmux/handoff/oracmux/ledger.jsonl             oracmux.py ledger --recent 20
```

## 終了コードと次の一手

| exit | 意味 | 次の一手 |
|---|---|---|
| 0 | 回収済 | answer.md を読む |
| 2 | 途中まで (partial) / 時間切れ (timeout) | 再送しない。`collect --engine X --tab <tabId>` (pane) か `--url <会話 URL>` で回収 |
| 3 | 要人手 (ペインのサインアウト・captcha・枠切れ) | タブは残してある。宮崎さんに 1 行報告 (ペインでログイン → `--tab` で再実行) |
| 4 | UI が応えない (composer 不在・セレクタ不一致) | `doctor` でタブ状態。cdp 経路は `<engine>/fail.png` と `engines.json` |
| 5 | NDA ガード | 素材を外すか、人が確認して `--allow-markers` |
| 6 | oracle 走行中 (oracle / cdp 経路のみ) | 待つ (`oracle status`) |
| 7 | 前提不足 (mycmux 不通・引数/設定不正・経路に無い flag) | mycmux 内で実行 / 引数を直す / `--via cdp` |

## 既知の制約 (2026-09-09 更新)

- pane 経路は mycmux 側の `web.read` / `web.open --url --background` / `web.close` (feat/web-read) が入った版が要る。旧版は exit 4/7 になるので `--via cdp` に落とす。`--upload` はさらに `web.upload` (v0.66.0 以降) が要る
- **`--upload` の実体**: サービス自身の隠し file input へ直接ファイルを載せる。OS のファイル選択ダイアログは開かない。file input がいつ DOM に生えるかはサービスで違う (2026-09-09 実測) — ChatGPT (`input#upload-files`) と Grok (`input[type=file]`) は読込時点で存在、Gemini は「アップロードとツール」を押すまで存在しない。セレクタは `engines.json` の `upload_input` / `upload_open`。**サービス側のプレビューにファイル名が出るまで待ってから送る** (出なければ送らず exit 3) ので、「添付したつもりで中身が届いていない引き継ぎ書」は送られない
- ペインのログインはサービスごと (`web-profiles/google` = ChatGPT/Gemini・`web-profiles/grok` = Grok)。本番 mycmux は 2026-09-07 時点で 3 サービスともログイン済み (宮崎さん確認)。未ログインだと composer が出ず exit 3 になる。Gemini はログインなしでも答えるので、「Gemini が通った」だけではログイン状態の証拠にならない
- **本番実射済み (2026-09-09)**: Gemini ask 39 秒で `ORACMUX-PROD-OK`、Grok は `--upload` つきで 44 秒。テスト機での 3 サービス往復は 9/7 (ChatGPT 74 秒 / Gemini 38 秒 / Grok 36 秒)。テスト機で検証するときは `WEBVIEW2_USER_DATA_FOLDER` が Web ペインのプロファイル分離を上書きする点に注意 (memory `reference-testmachine-webview-profile-override`)
- **モデルの取り違えは 2026-09-09 に実在した**: Gemini=Flash・Grok=ファストで動いていた。いまは ask が毎回直すが、**ChatGPT だけは会話中のタブで picker が見えない**ので `--tab` の再利用に注意
- Gemini の Deep Research は UI から到達不可。Grok の DeepSearch は消滅 (Expert が最深)
- ペイン (`web-profiles/google` / `grok`) と OracleChrome は別プロファイル。cdp 経路の `collect --latest` は同一アカウントが前提

## 関連

oracle 本体の罠 = memory `reference_oracle_gpt55pro_gate` / Work 枠切れ = `reference-oracle-work-weekly-limit` /
Web ペイン仕様 = `~/cmux-for-linux-dev-master/docs/plans/2026-08-27-web-pane-chatgpt-requirements.md` / app 側の契約 = `references/app-side-web-read-spec.md` / 他タブ操作 = mycmux-bridge
