# Web 自動操作層 — AI が Web を触る作業を mycmux 内で完結させる (Chrome ゼロ化 段1)

読者＝実装担当 (Codex) と将来の保守者／語り手＝母艦 (Claude)／相手＝Codex／その先＝宮崎さん (採否・実機確認)。
状態: 2026-09-08 宮崎さん GO (「開発スタートして進めておいて」)。設計評価の正本は
`C:\Users\miyaz\reports\_quick\2026-09\Chrome_ゼロ化の評価_(AI_の_Web_操作を_mycmux_内で完結)_0907-2133.html`。
要件書 `2026-08-27-web-pane-chatgpt-requirements.md` の決定1 (最終形は Chrome ゼロ) を実装する段。

## 1. 位置づけ (2026-09-08 宮崎さん)

- 人がこのアプリでブラウジングする気はない。人が見るのは AI チャット (既存 5 プリセット)。それ以外は **AI が触るブラウザ** (テスト・自動操作用)
- 拡張機能は不要。Cookie は「AI 用の持続プロファイルに一度覚えたら残す」(現状の仕組み)。Chrome からの Cookie 流用はしない (要件書 §3.7 維持)
- **新しいスキルは作らない**。エージェント向けの入口は既存の `scripts/mycmux_agent_cli.py web-*` に足す。説明は `docs/agent-integration.md` に集約
- macOS も同じコマンド名で動くこと (JS 層は両 OS 共通)。macOS 固有の画面・信頼入力は段2

## 2. 設計: 3 層

| 層 | 中身 | Windows | macOS |
|---|---|---|---|
| JS 層 (段1・レーン1) | 移動・待機・読み取り (AX-lite スナップショット + ref)・検索・クリック・入力・スクロール・添付 (DataTransfer)・ダイアログ記録・ダウンロード受け | `webview.eval` + oneshot (既存 `webpane_push/read` と同型) | 同左 |
| 画面層 (段1・レーン2) | スクリーンショット (CSS ピクセル寸法の PNG) | アプリ内 CDP `Page.captureScreenshot` (`CallDevToolsProtocolMethod`・ポートは開けない) | 段2 (takeSnapshot)。段1 では明示エラー |
| 信頼入力層 (段1・レーン2) | isTrusted が要る操作 (座標クリック・キー・insertText・`<input type=file>` への実ファイル) | アプリ内 CDP `Input.*` / `DOM.setFileInputFiles` | 段2 (NSEvent)。段1 では明示エラー |

原則: **CDP ポートは開けない** (2026-09-07 の既決)。CDP はアプリ内呼び出しだけ。すべてトークン認証済みソケット経由。
**フォーカスを奪わない**: 裏タブ (画面外退避) で全操作が完結する。前面化は `web.focus` を明示したときだけ。

## 3. コマンド契約 (ソケット `web.*` → TS → Rust `webpane_*`)

対象タブの解決は既存 `web.read` と同じ (`tabId` 優先・無ければ `presetId` + `anchorSessionId` のワークスペースで最新)。以下 `T` = `{tabId?, presetId?, anchorSessionId?}`。返り値は camelCase JSON。エラーは文字列 (既存流儀)。

| ソケット | 引数 | 返り値 | 実装 |
|---|---|---|---|
| `web.navigate` | `T + {url?} \| {action: "back"\|"forward"\|"reload"}` | `{tabId, accepted: true}` | `url` は Rust で方針検査 → `Webview::navigate`。back/forward は eval `history.*`、reload は `Webview::reload` |
| `web.wait` | `T + {state: "load"\|"idle"\|"selector", selector?, timeoutMs?=15000, intervalMs?=250}` | `{tabId, state, ready: bool, url, elapsedMs}` | eval を間隔で繰り返す。`idle` = readyState complete かつ最終 DOM 変化から 500ms 以上 (init script の MutationObserver が `window.__mycmux.lastMutationAt` を持つ) |
| `web.eval` | `T + {script, timeoutMs?=5000}` | `{tabId, value}` (JSON 化・undefined は null) / 例外は `Err("web.eval failed: <message>")` | `script` は **async 関数本体** (`return` で値・`await` 可)。結果 512 KB 上限 |
| `web.snapshot` | `T + {mode?: "ax"\|"text", maxBytes?=262144}` | `ax`: `{tabId, url, title, viewport:{width,height,dpr}, nodes:[Node], truncated}` / `text`: `{tabId, url, title, text, truncated}` | AX-lite (§4)。`nodes` 上限 800 |
| `web.find` | `T + {text?, role?, selector?, exact?=false, limit?=20}` | `{tabId, nodes:[Node]}` | snapshot と同じ走査を絞り込む。`text` は name/text の部分一致 (大文字小文字無視)。`exact` で完全一致 |
| `web.click` | `T + ({ref} \| {selector} \| {x, y}) + {button?="left", clickCount?=1, trusted?=false}` | `{tabId, target:{ref?, rect}, trusted}` | JS: scrollIntoView → 中心座標で pointerdown/mousedown/focus/pointerup/mouseup/click を合成。`trusted` は Rust `webpane_input_trusted` (レーン2・非対応時は明示エラー) |
| `web.type` | `T + ({ref} \| {selector}) + {text, mode?="replace"\|"append", submit?=false, trusted?=false}` | `{tabId, target, chars, submitted}` | input/textarea = native setter + InputEvent。contenteditable = `document.execCommand("insertText")`、失敗時は既存 composer 方式。`submit` = Enter の keydown/keypress/keyup を合成 |
| `web.key` | `T + {key, code?, modifiers?: ["ctrl","shift","alt","meta"], ref?, trusted?=false}` | `{tabId, key, trusted}` | JS: KeyboardEvent 合成 (best effort)。`trusted` はレーン2 |
| `web.scroll` | `T + ({ref} \| {selector} \| {}) + {deltaX?=0, deltaY?=600}` | `{tabId, scrollX, scrollY}` | ref なら scrollIntoView 後に最寄りのスクロール祖先を `scrollBy`、無ければ `window.scrollBy` |
| `web.upload` | `T + ({ref} \| {selector}) + {paths:[string], mode?="input"\|"drop", trusted?=false}` | `{tabId, files:[{name,size}], mode, trusted}` | Rust がファイルを読み base64 (合計 25 MB 上限・存在しないパスはエラー) → JS で `File` を作り `DataTransfer` → `input.files` + input/change、`drop` は dragenter/dragover/drop を合成。`trusted` は `DOM.setFileInputFiles` (レーン2) |
| `web.screenshot` | `T + {path?, clip?:{x,y,width,height}}` | `{tabId, path, width, height, dpr}` | レーン2 (Windows・CDP)。段1 の他 OS は `Err("web.screenshot is not supported on this platform yet")`。既定保存先 `~/.mycmux/handoff/web/<tabId>/shot-<UTC ts>.png` |
| `web.downloads` | `T` | `{tabId, downloads:[{url, path, success, finishedAt}]}` | `WebviewBuilder::on_download` で保存先を `~/.mycmux/handoff/web/<presetId>/downloads/<sanitized name>` に固定して記録 |
| `web.dialogs` | `T + {clear?=false}` | `{tabId, dialogs:[{kind, message, at}]}` | `browser` プリセットの init script が `alert/confirm/prompt` を記録して自動応答 (confirm=true・prompt=既定値)。他プリセットはネイティブのまま (人の操作を変えない) |

既存 (`web.open / list / focus / push / read / close`) は不変。`web.list` の行に `presetId` があるので新コマンドは既存の解決関数を再利用する。

補足 (2026-09-08 母艦裁定・実装で確定):
- `web.wait` / `web.eval` の `timeoutMs` は **25000 が上限** (ソケットのフロント応答期限が 30 秒)。超える指定は `Err("web.<cmd> timeoutMs must be <= 25000 (socket response deadline is 30s); poll again instead")`。長く待つときは呼び直す
- `web.upload` の `trusted: true` と `mode: "drop"` の併用は明示エラー (ネイティブ層は `DOM.setFileInputFiles` だけ)
- 追加した launchable target (`web-browser`) は、ランチャー 2 本に加えてカタログ (`agentCatalog.ts`)・アイコン (`launcherModel.ts` / `AgentIcons.tsx`)・スキルパック manifest (`sync_claude_skills.py --write-manifest`) の 3 契約に連鎖する
- 監査で確定した境界 (実装済み): `clickCount` は 1〜3 / `web.snapshot` の `maxBytes` は 4096 以上 / `web.eval` の script 入力は 256 KB 以下 (結果は 512 KB) / `web.upload` は JS 経路もネイティブ経路も合計 25 MB / 1 ソケットコマンドの期限は受信から 25 秒 (キュー待ちを含む。超過した待ちは `queued past the socket deadline` で実行しない) / ネイティブ層は 1 コマンド 20 秒・CDP 1 呼び出し 4 秒で、多段の trusted (`web.type` の End → insertText → Enter) は同じ期限を共有する
- 世代番号 (`__mycmux.generation`) は u32。CDP は int32 を超える数値を小数 (`2147483648.0`) で返すので、ネイティブ側は整数値の小数も同じ値として受ける (2026-09-08 テスト機で 2^31 以上が全滅した実測から)

### Node (AX-lite)

```
{ ref: "r12", role: "button", name: "Send", tag: "button", text?: "...", value?: "...", href?: "...",
  checked?: bool, disabled?: bool, level?: 2, rect: {x, y, width, height}, inViewport: bool }
```

- 走査対象 (可視のもの): `a[href]`, `button`, `input` (hidden 以外), `textarea`, `select`, `[contenteditable]`, `[role]`, `h1〜h6`, `img[alt]`, `summary`, `[tabindex]`。可視 = `getClientRects().length > 0` かつ `visibility != hidden` かつ `opacity != 0`
- role: `role` 属性 → タグ対応表 (a→link, button/input[type=button|submit]→button, text 系 input/textarea/contenteditable→textbox, checkbox→checkbox, radio→radio, select→combobox, h*→heading (level), img→img, summary→button)
- name の優先: `aria-label` → `aria-labelledby` の文字 → `<label for>` → `title` → `placeholder` → innerText (trim・80 字) → `alt`
- `ref` は snapshot/find のたびに付け直す (`window.__mycmux.refs` = Map と `data-mycmux-ref` 属性の両方)。`web.click {ref}` は次の snapshot/navigate まで有効。古い ref は `Err("stale ref")`

### `browser` プリセット (AI ブラウザ)

- `id: "browser"`, label `Browser`, 初期 URL `about:blank`, profile `ai` (`web-profiles/ai`), reader/composer なし, signed_out_patterns 空
- URL 方針: `https://*` すべて、`http://localhost` と `http://127.0.0.1` (任意ポート) を許可。それ以外 (`file:` 等) は拒否。**既存 5 プリセットの許可ホスト方針は不変**
- `on_new_window`: `browser` では新窓要求 (`window.open`・`target=_blank`) を**同じタブで開く** (`navigate` して Deny)。既存プリセットは現行どおり
- ランチャー両本 (`launcher.sh` / `launcher.ps1`) に `Browser (Web)` の項目と dispatch arm、`$LaunchTargets` の `web-browser` を足す (契約テスト `tests/test_web_pane_contract.py` の preset 一覧と `$LaunchTargets` の期待表、`tests/perf/test_week1_day1_behavior_contracts.py` の固定文字列を更新)
ランチャーカタログ (`agentCatalog.ts`) とアイコン (`launcherModel.ts` / `AgentIcons.tsx`) にも登録する

## 4. 段と担当

| 段 | レーン | 中身 | 起点 |
|---|---|---|---|
| 段1-JS | レーン1 (`feat/web-automation`・`C:\Users\miyaz\mycmux-wt-webauto`) | JS 層の全コマンド + `browser` プリセット + CLI + ランチャー + テスト + docs + E2E スクリプト + レーン2 用 Rust スタブ | master d7a73d0b |
| 段1-native | レーン2 (`feat/web-automation-native`・`C:\Users\miyaz\mycmux-wt-webauto-native`) | Windows: `webpane_native.rs` (CDP screenshot・信頼入力・setFileInputFiles) | master d7a73d0b |
| 監査 | レーン3 (読み取り専用) | 2 本の合流後に diff・テスト・契約を直読して指摘 | 合流ブランチ |
| 実機 | 母艦 | テスト機で E2E (画面に出さない・フォーカスを奪わない) → master 合流 → push | |
| 段2 | 後日 | macOS 画面・信頼入力 (takeSnapshot / NSEvent)・Google ログイン UA spike・Claude Code 用 MCP・oracmux `--upload`/`--mode` の pane 化・udr/youtube/firestorage の乗り換え | |

## 5. やらないこと (段1)

- CDP ポートを開ける / Cookie の読み書き・移送 (契約テストが禁止) / 拡張機能 / 自動送信を既定にする (push は載せるだけ) / 既存 5 プリセットの挙動変更 / PTY・エージェント種別・data.json スキーマ / 本番 exe の差し替え・`git push`・タグ (母艦)

### 既知の制約 (監査 2 回の後に母艦が受け入れたもの・2026-09-08)

- 世代検査は preflight。検査の直後にページ自身が遷移した場合、信頼入力や実ファイル設定が新しい文書に届き得る (CDP では原子化できない TOCTOU。自分たちのコマンド同士はタブごとのミューテックスで直列化済み)
- `web.eval` の CSP fallback (直接埋め込み) は script をラッパのスコープ内で実行する。script の書き手はエージェント自身で、ページ側からは干渉できないため許容。この経路で構文エラーがあると返信が無く、timeout 時に「CSP fallback 後に返信なし (構文エラー?)」の文言で返す
- `web.screenshot` の予算切れ後にワーカーの書込みが完了することがある。ファイル名にミリ秒が入るので再試行と衝突しない
- ネイティブ 3 コマンドの呼出元検査は「その webview がウィンドウの primary か」まで。別ウィンドウの primary が他ウィンドウのタブを操作する経路は残る (全ウィンドウがアプリ自身)
- ダウンロード名の Windows 予約名回避は ASCII (`CON` / `PRN` / `AUX` / `NUL` / `COM1-9` / `LPT1-9`・拡張子つき含む)。Unicode 上付き数字 (`COM¹`) は対象外
- テスト機で E2E を回すときは `scripts/test-profile.ps1 -Name <name> -CloneData` が必要 (空のテスト機はワークスペースが無く `web.open` を拒否する)。手順は `scripts/verify_web_automation.py` の docstring と `~/.claude/dispatch/260908-web-automation/E2E_result_260908.md`

## 6. 受け入れ (段1 全体)

- `npx tsc --noEmit` / `npx vitest run` / `CARGO_BUILD_JOBS=2 python scripts/run_windows_tests.py` / `python -m pytest tests/ -q` が全緑 (既存失敗が出たら master 同一コミットで同数を確認して報告)
- E2E `scripts/verify_web_automation.py` がテスト機の裏タブで PASS (fixture `tests/fixtures/web-automation/index.html`)。Windows は screenshot 含む。手順は同スクリプトの docstring
- `docs/agent-integration.md` の Web 操作節に snapshot→ref→click/type の基本ループと全コマンドの 1 行説明がある
