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
| ペインで進めた会話 (or 時間切れの会話) をファイルに取り込む | **collect** | `modes/collect.md` |
| 「動くか見て」「ログイン切れ？」 | **doctor** | `modes/doctor.md` |

迷ったら `doctor` → `ask`。3 系統の CLI 合議は fusion、調査は ultra-deep-research (本スキルは「回答を 1 つ取る」用)。

## 経路 (`--via`)

| 経路 | 実体 | 位置づけ |
|---|---|---|
| **pane** (既定) | mycmux Web ペインの裏タブ + `web.push` / `web.read` (mycmux v0.65 以降) | 通常はこれ。ログインはペイン側 (`web-profiles/google` / `grok`) |
| oracle (chatgpt のみ) | steipete/oracle CLI → 画面外 OracleChrome | `--upload` (PDF 実アップロード)・oracle の証跡が要るとき |
| cdp | 自前 Playwright ドライバ → OracleChrome | mycmux 外・`--mode` (思考モード切替) が要るとき |

## 共通手順

1. **前提点検**: `python ~/.claude/skills/oracmux/scripts/oracmux.py doctor` (数秒。ソケット・各サービスのペインのログイン状態。`no_tab` は正常)
2. **材料**: 問い (`-q` か `--question-file`)、経緯 (`--context-file`)、制約、添付 (`--file a.md b.md`・glob 可・テキストは本文に展開)。
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
- **effort は Web 側の選択状態に従う** (ChatGPT=GPT-6 Pro・Gemini=Pro・Grok=Expert が 2026-09-07 の状態)。pane 経路は切替不可、cdp 経路の `--mode` は best-effort
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

## 既知の制約 (2026-09-07)

- pane 経路は mycmux 側の `web.read` / `web.open --url --background` / `web.close` (feat/web-read) が入った版が要る。旧版は exit 4/7 になるので `--via cdp` に落とす
- ペインのログインはサービスごと (`web-profiles/google` = ChatGPT/Gemini・`web-profiles/grok` = Grok)。本番 mycmux は 2026-09-07 時点で 3 サービスともログイン済み (宮崎さん確認)。未ログインだと composer が出ず exit 3 になる。Gemini はログインなしでも答えるので、「Gemini が通った」だけではログイン状態の証拠にならない
- 裏タブ往復は 3 サービスとも実射済み (9/7・本番のログイン状態を複製したテスト機: ChatGPT 74 秒 / Gemini 38 秒 / Grok 36 秒で PANE-OK 回収)。テスト機で検証するときは `WEBVIEW2_USER_DATA_FOLDER` が Web ペインのプロファイル分離を上書きする点に注意 (memory `reference-testmachine-webview-profile-override`)
- Gemini の Deep Research は UI から到達不可。Grok の DeepSearch は消滅 (Expert が最深)
- ペイン (`web-profiles/google` / `grok`) と OracleChrome は別プロファイル。cdp 経路の `collect --latest` は同一アカウントが前提

## 関連

oracle 本体の罠 = memory `reference_oracle_gpt55pro_gate` / Work 枠切れ = `reference-oracle-work-weekly-limit` /
Web ペイン仕様 = `~/cmux-for-linux-dev-master/docs/plans/2026-08-27-web-pane-chatgpt-requirements.md` / app 側の契約 = `references/app-side-web-read-spec.md` / 他タブ操作 = mycmux-bridge
