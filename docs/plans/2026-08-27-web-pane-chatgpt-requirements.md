# Web ペイン (ChatGPT Pro) 要件定義 — 2026-08-27 壁打ち結果

**Status**: 要件確定 (宮崎さん裁定 2026-08-27)・実装未着手
**関連**: ADR 0008 (`docs/adr/0008-chatgpt-web-pane-webview2-staged-oracle.md`) / 用語 `CONTEXT.md`「Web ペイン」節 / 先行調査 `docs/plans/rich-browser-pane.md` (2026-03-19)

## 1. 背景と目的

- GPT Pro (Pro effort) は ChatGPT Web でしか使えない。エージェント側は oracle (steipete/oracle v0.18.0) が画面外 Chrome (CDP 9222・`~/.oracle/oracle-chrome.ps1`) を自動操作して使っている。
- ChatGPT Web でできることは増え続けている (Deep Research・Canvas・画像・プロジェクト・ファイル添付)。人間がこれを mycmux の外の Chrome で使っている状態をやめ、**mycmux 内でランチャーから他の CLI と同じ手つきで ChatGPT Pro を開き、手元のファイル・セッションの文脈をストレスなく渡せる**ようにする。
- 現状の mycmux に「ブラウザ」は無い。`BrowserPane.tsx` はローカル成果物 (html/md/docx) の iframe プレビューで、http(s) は OS 既定ブラウザへ外部起動する。Rust 側のブラウザ backend は 2026-07-02 (`caf1b7a`) に削除済み。

## 2. 決定リスト (質問順)

| # | 論点 | 決定 | 理由 | 却下した案 |
|---|---|---|---|---|
| 1 | ChatGPT を動かす実体 | **段階移行**: WebView2 ペインを先に作り、spike 合格で oracle も同じ WebView2 に attach して Chrome 常駐を廃止 | oracle 経路を壊さずに価値を先出しできる。最終形は Chrome ゼロ | 一気に統合 (未検証 3 点で最終判定ゲートが止まる) / Chrome 窓の SetParent 埋め込み (ハック・Chrome 依存が残る) |
| 2 | スコープ | **プリセット基盤** (URL + 専用プロファイル + ランチャー項目)。v1 は ChatGPT の 1 件だけ | ultra-deep-research が ChatGPT/Gemini/Grok の Web 本家を Chrome で回している。同じ基盤に後乗せできる | ChatGPT 専用に閉じる (作り直しになる) / 汎用ブラウザ (アドレスバー・履歴・DL の面倒を全部背負う) |
| 3 | 使用感 | **ランチャー項目を選ぶと、そのペインが ChatGPT Web 画面になる**。人間は Web UI で会話 | 動機が「Web の機能が増えている」なので Web UI が主役。実装も軽い | ターミナル REPL `gpt` (Web の機能が使えず動機と逆) / 両方 (Phase 2 の attach 合格まで作れない) |
| 4 | 居場所 | **タブの 1 種** (ターミナルタブと同格・複数可・再起動で復元) | 分割・移動・リネーム・close-tab が他 CLI と同じ操作体系になる | 常駐サイドパネル (会話を並行で複数持てない) / 別ウィンドウ (ペイン分割と並べられない) |
| 5 | ボタン | **作らない。ランチャー項目のみ** (宮崎さん: Claude Code もそこから立ち上げている) | 入口を増やさない | ペインタブバーの GPT ボタン / 「+」ドロップダウン / タイトルバー |
| 6 | セッション内容の渡し方 | **エージェントが引き継ぎ書 (brief.md) を書いて添付し、必要な実ファイルを同梱** | 質が高くサイズが小さい。今の oracle consult と同じ型で慣れている。生 transcript は 30 万 token 級で ChatGPT の窓に載らない | 生 transcript の末尾 N 万字を自動抽出 (ノイズで窓を圧迫・問いが入っていない) / 両方 (v1 の実装量が増える) |
| 7 | 戻り方向 (GPT→mycmux) | **v1 は片道。ダウンロード先を handoff フォルダに固定**。テキスト回答の自動取り込みは Phase 2 の oracle に任せる | 完了検出・回答抽出は oracle が持っている。二重保守しない。ファイル成果物は確実に拾える | v1 から CDP で回答抽出 (ChatGPT DOM 依存を自前保守) / クリップボードと Downloads だけ (成果物が散らばる) |

母艦の自己決定 (質問せず決めた分・いずれも可逆):

- push (載せる) の既定は **composer に載せて止める**。送信は人間が押すか `--send` 明示。Pro のターンは週次枠を消費し取り消せないため
- 外部リンク (許可ホスト外) は OS 既定ブラウザへ。許可ホストは chatgpt.com と認証ドメイン
- `AgentSessionKind` には足さない (PTY プロセスではないので monitor/detection/usage の 8 点チェックリストは対象外)。タブ型 `type: "web"` を新設する
- 引き継ぎ書の置き場は `~/.mycmux/handoff/<preset>/<yyyymmdd-HHMM>-<slug>/`。ダウンロード先も同じ木 (`.../downloads/`)

## 3. 要件

### 3.1 必須 (v1 = Phase 1)

**Web ペイン基盤**

- R1. `PaneTab.type` に `"web"` を追加。タブは `presetId` と `lastUrl` を data.json に持ち、再起動時に同じ URL で復元する (`docs/plans/2026-08-26-datajson-schema-guard.md` のガードを通す)
- R2. プリセット定義 = `{ id, label, url, profileDir, allowedHosts, cdpPort }`。v1 の登録は `chatgpt` のみ (`https://chatgpt.com/`・許可ホスト = chatgpt.com / auth.openai.com / auth0.openai.com / cdn.oaistatic.com / (ログイン方式に応じて accounts.google.com 等)【要確認: 宮崎さんのログイン方式】)
- R3. ペインの実体は Tauri child webview (`Window::add_child` + `WebviewBuilder`)。プリセットごとに `data_directory` を分ける (`%LOCALAPPDATA%/com.miyazaki.mycmux/web-profiles/<presetId>/`)。メイン UI のプロファイルとは別にする (別プロセスになり、`additional_browser_args` を独立に指定できる)
- R4. `additional_browser_args("--remote-debugging-port=<cdpPort>")` を Phase 1 から付ける (127.0.0.1 限定)。プロファイル直下に `DevToolsActivePort` を書き、oracle の attach 探索が拾える形にする (`oracle-chrome.ps1` の `Write-ActivePortFile` と同じ内容)
- R5. 同一プリセットのタブを複数開ける (同じプロファイルを共有・会話は別)。タブを閉じたら webview を破棄する
- R6. 表示同期: ペインの矩形に追従して `set_position` / `set_size`。非アクティブなタブ・別ワークスペース・モーダル (コマンドパレット・ダイアログ・ドラッグ中) の間は webview を `hide()` する (native webview は常に Web コンテンツより前面に出るため)
- R7. キーボード: webview にフォーカスがあっても mycmux のグローバルショートカット (ワークスペース切替・タブ切替・ターミナルへ戻る) が効く。`initialization_script` で該当キーを Rust へ転送する
- R8. ダウンロード: `on_download` で保存先を `~/.mycmux/handoff/<presetId>/downloads/<yyyymmdd>/` に固定し、完了時にパスリンク付きトーストを出す
- R9. ナビゲーション (2026-08-27 12:55 改訂 — 旧文「ポップアップは同じ webview 内で遷移」は誤り。OAuth は `window.opener` への postMessage で戻るため別窓が必須):
  - 同一 webview 内の遷移 (`on_navigation`) は**すべて許可**する (ログインは auth.openai.com → Google/Apple/Microsoft へ top-level リダイレクトすることがあり、許可ホストで絞ると初回ログインが通らない)
  - 新規ウィンドウ要求 (`on_new_window(url, features)`) は 3 分岐: ①URL が許可ホスト内 (共有リンク・Canvas を新しいタブで等) → **新しい Web タブ**として開く ②`features` にサイズ指定があるスクリプト起動のポップアップ (OAuth・コネクタ認可・Google Drive ピッカー) → `NewWindowResponse::Allow` で **WebView2 既定のポップアップ窓** (opener 関係を保つ) ③それ以外 (`target=_blank` の外部リンク) → OS 既定ブラウザ
  - 分岐②の判定は `features.size` の有無 + 認証系ホストの allowlist (accounts.google.com / appleid.apple.com / login.microsoftonline.com / auth.openai.com / auth0.openai.com) の OR。spike で ChatGPT の実挙動に合わせて調整する

**入口**

- R10. ランチャー (`src-tauri/src/launcher.sh` / `launcher.ps1`) に項目「ChatGPT Pro (Web)」を追加。選択すると、そのターミナルタブが Web タブに置き換わる (同じ位置)。`MYCMUX_LAUNCH_TARGET=web-chatgpt` でも同じ動作
- R11. ソケット API (`socketCommands.ts`) に追加: `web.open {presetId, anchorSessionId?, replaceAnchor?}` → `{tabId}` / `web.list` → `[{tabId, presetId, url, title, workspaceId}]` / `web.focus {tabId}` / `web.push {tabId?|presetId, text?, files?[], submit?}`
- R12. CLI (`scripts/mycmux_agent_cli.py`) に `web-open` / `web-list` / `web-push` を追加。加えて薄いラッパー `gpt` (`~/bin/gpt`): `gpt "質問" -f a.pdf -f brief.md [--send] [--tab <id>]`。タブ未指定なら同じワークスペースの最新 ChatGPT タブ、無ければ開く

**コンテキスト受け渡し (push)**

- R13. テキストは composer (`#prompt-textarea`) に挿入する (`evaluate_script`)。既定は送信しない。`submit: true` のときだけ送信する
- R14. ファイルは CDP `DOM.setFileInputFiles` で composer の `<input type=file>` に載せる (mycmux が自ペインの CDP に websocket で接続)。CDP が使えない場合の代替 = base64 経由の File を `drop` イベントで投入
- R15. 引き継ぎ書ワークフロー (mycmux リポ外・`~/.claude/skills/` 側): Claude Code のスキル `/gpt` が `brief.md` (論点・経緯・問い・制約・添付一覧) を handoff フォルダに書き、添付ファイルを集めて `gpt --brief <dir>` を叩く。Codex は同じ CLI をシェルから叩く。スキルの仕様は本書の範囲外だが、CLI の引数契約 (R12) はスキルから見て固定
- R16. 1 回の push で載せられる上限 (ファイル数・サイズ) は ChatGPT Web の制限に従い、超過時は送らずにエラーを返す【要確認: ChatGPT の添付上限。oracle の既定は 1 ファイル 1MB】

**Web の機能を欠かさないための追加要件 (2026-08-27 12:55 追記 — 宮崎さん「Web でできることは過不足なく」)**

- R17. Explorer からのドラッグ&ドロップ添付: 子 webview に `disable_drag_drop_handler()` を付ける (Tauri は既定で Windows の drop を横取りし、ページの HTML5 drop イベントに渡さない)。mycmux UI からの DnD は対象外 (v2)
- R18. バックグラウンドでも止めない: `additional_browser_args` に `--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding` (oracle-chrome.ps1 と同じ)。R6 で `hide()` している間も Deep Research の進行・回答のストリーミング・音声再生が止まらないこと
- R19. メディア権限: 音声モード (マイク) と画像撮影 (カメラ) は WebView2 既定の権限プロンプトに任せる (wry が自動許可するのはクリップボード読取のみ)。プロンプトが mycmux の窓の後ろに隠れないことを spike で確認し、隠れるなら chatgpt.com 限定で自動許可に切り替える
- R20. ブラウザ操作の最小セット (アドレスバーは作らないが、これが無いと Web より不便になる): 戻る/進む (Alt+← / Alt+→・マウスの戻るボタン) → `history.back()` / `history.forward()` / 再読み込み (F5・Ctrl+R) → `reload()` / ズーム (Ctrl+± / Ctrl+0) → WebView2 既定のまま / 新しいチャット (Ctrl+Shift+O) など ChatGPT 自身のショートカットは webview に通す (R7 で横取りするのは mycmux のグローバルキーだけ)
- R21. ログイン方式は Web と同じ全部を通す: パスワード / Google / Apple / Microsoft / パスキー (WebAuthn・Windows Hello)。R9 の分岐②と、WebAuthn の WebView2 対応を spike で確認する
- R22. ダウンロードの経路は 3 種すべて R8 に落とす: 生成ファイルの「ダウンロード」(署名付き URL) / 画像の保存 (blob:) / Canvas・会話のエクスポート。印刷 (Ctrl+P・PDF 保存) は WebView2 既定の印刷ダイアログに任せる

### 3.1.1 Web 機能カバレッジ表 (過不足の点検・v1)

| ChatGPT Web の機能 | Web ペインでの扱い | 状態 |
|---|---|---|
| テキスト会話・Markdown・コード・コピーボタン | そのまま動く (Chromium) | ◯ |
| ファイル添付 (+ ボタンの OS ダイアログ) | そのまま動く | ◯ |
| 画像の貼り付け (クリップボード) | そのまま動く | ◯ |
| Explorer からのドラッグ&ドロップ | R17 | 要件で担保 |
| mycmux 側からの push (テキスト+ファイル) | R11〜R14 | 要件で担保 |
| コネクタ・Apps in ChatGPT (Google Drive / SharePoint / MCP アプリ) の認可 | R9 分岐② (ポップアップ) | 要件で担保・要検証 K10 |
| Apps in ChatGPT の iframe 表示 (第三者 cookie) | WebView2 のトラッキング防止 (既定 Balanced) が邪魔をする可能性 | 要検証 K11 |
| Deep Research (長時間・裏で進行) | R18 | 要件で担保・要検証 |
| Canvas / プロジェクト / メモリ / GPTs / 設定 | ページ内機能・そのまま | ◯ |
| 画像生成・表示・保存 | 表示◯・保存は R8/R22 | 要件で担保 |
| 音声モード (マイク・再生) / 画像撮影 (カメラ) | R19 | 要件で担保・要検証 K12 |
| 共有リンク・「新しいタブで開く」 | R9 分岐① (新しい Web タブ) | 要件で担保 |
| 外部リンク | R9 分岐③ (OS ブラウザ) | 要件で担保 |
| ログイン (パスワード / Google / Apple / Microsoft / パスキー) | R21 | 要検証 K2・K13 |
| Cloudflare チャレンジ | Chromium なので通常通過 | 要検証 K3 |
| Chat / Work の切替・週次上限の表示 | ページ内・そのまま | ◯ |
| ChatGPT のキーボードショートカット | R20・R7 | 要件で担保 |
| 戻る/進む・再読み込み・ズーム | R20 | 要件で担保 |
| 印刷・PDF 保存 | R22 (WebView2 既定ダイアログ) | 要検証 K14 |
| 日本語 IME | WebView2 ネイティブ | ◯ |
| ページ内検索 (Ctrl+F) | WebView2 に検索 UI が無い (wry 未公開の Find API) | **対象外 (v1)**・ChatGPT 側のチャット検索で代替 |
| ブラウザ拡張 (パスワードマネージャ等) | WebView2 は Chrome Web Store 非対応 | **対象外**・初回ログインは手入力 |
| Web Push 通知 (完了通知) | 未対応 | **対象外 (v1)** |
| アドレスバー・履歴・ブックマーク | 設計上作らない (Q2) | 対象外 |

### 3.2 Phase 2 (oracle 統合・spike ゲート)

- P1. `oracle --remote-chrome 127.0.0.1:<cdpPort> -p "PING"` が mycmux の ChatGPT ペインを使って PONG を返す
- P2. MCP (`oracle-mcp`・`~/.oracle/config.json` の `browser.attachRunning: true`) が `DevToolsActivePort` 経由で同じペインに attach して PONG を返す
- P3. 人間が別の ChatGPT タブで会話中でも P1/P2 が壊れない (oracle は `--browser-tab` で自分のタブを使う)
- P4. `-f` の添付アップロードが通る
- P5. Web UI 側で選んだ Pro effort が維持される (`Model selection evidence` で確認)
- P6. consult 中に mycmux を終了した場合、oracle がハングせず失敗で返る
- 合格 = P1〜P6 すべて PASS。合格後に config を切り替え `oracle-chrome down` を常用にし、`~/bin/oracle` の shim から `up` 呼び出しを外す。不合格 = Chrome 常駐を恒久併存とし、ADR 0008 に結果を追記

### 3.3 対象外 (v1 でやらない)

- アドレスバー・履歴・ブックマーク (汎用ブラウザ化)。戻る/進む・再読み込みだけは R20 で持つ
- ページ内検索 (Ctrl+F) の UI / ブラウザ拡張 (パスワードマネージャ) / Web Push 通知 — 3.1.1 のとおり v1 対象外
- mycmux UI からのドラッグ&ドロップで添付 (v2 候補・`tauri-plugin-drag` 系)
- GPT の回答テキストの自動取り込み (Phase 2 の oracle が担当)
- 自動送信を既定にすること
- Gemini / Grok / claude.ai のプリセット登録 (基盤はそのまま使えるが v1 では登録しない)
- 専用ボタン (ペインタブバー・タイトルバー)

## 3.5 軽さ・安定性の設計根拠 (2026-08-27 13:05 追記 — 宮崎さん「異常に重たくならない？安定する？さくさく？」)

- **別プロセス**: 専用 `data_directory` = 別の WebView2 環境なので、ChatGPT のブラウザ/レンダラ/GPU プロセスは mycmux 本体 (メイン UI の WebView2) と分かれる。ChatGPT 側の重い JS・長い会話の DOM・レンダラのクラッシュは本体の UI スレッドに届かない。本体が持つのは矩形の同期 (`set_position` / `set_size`) と show/hide だけ
- **入力経路が直結**: composer への打鍵は OS → 子 webview の HWND へ直接入る (mycmux の IPC を経由しない)。体感は Edge で chatgpt.com を開いたときと同じ
- **作るのは開いたときだけ**: webview は Web タブを表示した瞬間に作る。起動時の復元も「表示されるまで作らない」(lazy)。閉じたら即破棄してプロセスを返す。既定はタブ 1 枚
- **RAM の見積り**: ChatGPT は重い SPA なので 1 タブで 300〜600 MB (会話が長いほど増える・Chrome でも同じ)。移行期間は oracle の画面外 Chrome (200〜300 MB) と二重。Phase 2 で Chrome を止めれば差し引きほぼゼロ、Chrome で ChatGPT を開くのをやめればマイナス。**この PC の制約は設計でなく RAM 総量** (2026-08-27 実測 33.8 GB 中 96% 使用・Codex/Claude タブ多数) — 開くタブ数を増やさない運用が前提
- **CPU**: アイドル (生成なし) の chatgpt.com は 1 コア換算 1% 未満。生成中のストリーミングで 5〜15%。R18 で背景 throttling を切るので hide 中も同じ (Deep Research を止めないための取捨)
- **不安定になりうる場所は 3 つだけ** (すべて子 webview の「位置・重なり・フォーカス」): ①分割・リサイズ後の矩形ズレ (Tauri child webview は unstable API) ②オーバーレイの後ろに出る z-order ③webview にフォーカスがある間のショートカット。3 つとも R6/R7 と下の数値基準で潰す。ここが spike で収まらなければ Q4 で却下した「別ウィンドウ」に落とす (機能は同じ・並べられないだけ)

## 4. 受け入れ基準 (Phase 1)

### 4.1 性能・安定性 (数値・テスト機で計測)

| 指標 | 目標 | 測り方 |
|---|---|---|
| 起動時間 | Web タブ 2 枚を復元する data.json でも、mycmux 起動〜最初のターミナル入力可能まで現行比 +50 ms 以内 (p95・10 回) | lazy 作成の証明。`performance.now()` を起動ログに出す |
| タブ切替・ワークスペース切替 | show/hide の往復 p95 ≤ 16 ms (1 フレーム)・取り残し (隠れ損ね) 0 | 切替 200 回の自動操作 + スクリーンショット照合 |
| リサイズ追従 | 矩形ズレ ≤ 1 フレーム・連続リサイズ中に本体 UI スレッドの 50 ms 超 long task 0 | 分割/リサイズ 200 回・PerformanceObserver |
| RAM | ChatGPT タブ 1 枚 (50 往復の会話) で msedgewebview2 群の合計 ≤ 600 MB・閉じて 30 秒以内にプロセス消滅 | タスクマネージャ / `Get-Process msedgewebview2` を data_directory で絞る |
| CPU | アイドル (生成なし・hide 中) の WebView2 群 ≤ 1% (1 コア換算・1 分平均) | Process Explorer |
| 入力遅延 | composer の打鍵〜表示が Edge 単体と同等 (差 ≤ 5 ms) | 同一ページでキー入力を録画し比較 |
| 隔離 | ChatGPT のレンダラをタスクマネージャで強制終了しても本体が落ちない・R20 の再読み込みで復帰 | 手動 3 回 |
| 連続稼働 | 24 時間 (タブ 2 枚・切替 200 回・リサイズ 200 回・分割 50 回・Deep Research 1 回) でクラッシュ 0・位置ズレ 0・フォーカス迷子 0 | テスト機で放置+自動操作スクリプト |
| 復元 | 再起動 20 回で復元失敗 0・会話 URL 一致 | 自動 |

「軽い」「さくさく」のような測れない語は基準にしない (mail-spec §14 と同じ流儀)。

### 4.2 機能

機械検証 (変更後は全部):

```
npx tsc --noEmit
npx vitest run
python scripts/run_windows_tests.py
python -m pytest tests/
```

- 新規の sync `#[tauri::command]` があれば `tests/test_command_sync_contract.py` の allowlist と整合させる
- ランチャーのメニュー配列を固定している `tests/perf/test_week1_day1_behavior_contracts.py` を新項目に合わせて更新する
- data.json スキーマガードに `type: "web"` を通す

実機検証 (テスト機・`--profile` 隔離で並行起動。本番 exe は触らない):

1. ランチャーで「ChatGPT Pro (Web)」→ そのタブが chatgpt.com になる。初回ログイン後、mycmux 再起動でログインが保持される
2. `gpt "PING" -f README.md` → composer に "PING" と README.md が載り、送信されていない (スクリーンショットで確認)。`--send` で送信され PONG が返る
3. ChatGPT で生成したファイルをダウンロード → `~/.mycmux/handoff/chatgpt/downloads/<date>/` に落ち、トーストのパスリンクで開ける
4. ワークスペース切替・タブ切替・コマンドパレット表示で webview が正しく隠れ、戻ると再表示される (取り残しゼロ)
5. webview フォーカス中にワークスペース切替キーが効く
6. タブを閉じると webview プロセスが消える (タスクマネージャで確認)。再起動後、開いていた ChatGPT タブが同じ会話 URL で復元される
7. 許可ホスト外のリンク (例: 回答内の外部 URL) が OS 既定ブラウザで開く

## 5. リスクと未検証事項

| # | 項目 | 影響 | 確認方法 |
|---|---|---|---|
| K1 | WebView2 の CDP が `Target.createTarget` に非対応の可能性 | oracle が新規タブを作れず attach に失敗 (Phase 2 のみ)。`--browser-tab` 再利用で回避できる可能性 | Phase 1 完成後に P1 を実測 |
| K2 | Google OAuth が埋め込み webview を拒否する | ログイン方式が Google の場合、初回ログインが通らない | 宮崎さんのログイン方式を確認【要確認】。メール+パスワード / Apple なら影響なし |
| K3 | Cloudflare チャレンジ | ログイン時に弾かれる | Phase 1 の実機検証 1 で確認 |
| K4 | child webview の位置・サイズ追従の不安定さ (`rich-browser-pane.md` の unstable 注記) | 分割・リサイズ時のズレ | 実機検証 4 |
| K5 | z-order (native webview が常に前面) | モーダル・ドロップダウンが隠れる | R6 の hide 制御・実機検証 4 |
| K6 | ChatGPT の DOM (`#prompt-textarea`・添付 input) の変更 | R13/R14 が壊れる | セレクタを 1 箇所に集約し、壊れたら手動添付にフォールバック (ペインは使える) |
| K7 | CDP ポートが認証なし | 同一 PC の他プロセスから操作可能 (現行 9222 と同じ露出) | 127.0.0.1 限定を維持。ポート番号は設定で変更可 |
| K8 | RAM | WebView2 プロセスが +150〜300MB。移行期間は Chrome と合わせて +400〜600MB | 移行期間を短くする。`oracle-chrome down` の常用 |
| K9 | ChatGPT Pro の文脈窓と添付上限 | 引き継ぎ書+添付の設計上限 | 【要確認】公式ヘルプで数値を確定してから R16 に転記 |
| K10 | OAuth・コネクタ認可のポップアップが WebView2 既定窓で完走するか (`window.opener` 経由の戻り) | コネクタ・Apps・Google Drive 添付が使えない | spike で Google Drive コネクタの接続を 1 回通す |
| K11 | WebView2 のトラッキング防止 (既定 Balanced) が Apps in ChatGPT の iframe・第三者 cookie を遮る | MCP アプリの画面が出ない | spike で 1 アプリ (例: Canva) を開く。遮られたら `CoreWebView2Profile.PreferredTrackingPreventionLevel` 相当を wry 経由で下げる手段を探す (未公開なら upstream) |
| K12 | マイク・カメラの権限プロンプトが出るか・窓の後ろに隠れないか | 音声モードが使えない | spike で音声モードを 1 回起動 |
| K13 | WebAuthn (パスキー) が WebView2 で通るか | パスキーでログインしている場合に初回ログイン不可 | 宮崎さんのログイン方式確認 (K2) と合わせて spike |
| K14 | 印刷・PDF 保存の WebView2 既定ダイアログ | エクスポート導線が無い | spike で Ctrl+P を 1 回 |

## 6. 実装の当たり (着手時の参考・拘束ではない)

- Rust: `src-tauri/src/web_pane/` (新規) — プリセット定義・webview 生成/破棄/hide/show/set_bounds・CDP クライアント (websocket)・ダウンロード先・`DevToolsActivePort` 書き出し
- フロント: `src/components/workspace/WebPane.tsx` (矩形を ResizeObserver で Rust へ通知するだけの薄い枠) / `workspaceLayoutStore.ts` に `makeWebTab` / `PaneTabBar.tsx` の表示
- ソケット: `socketCommands.ts` に `web.*` 4 本 / `scripts/mycmux_agent_cli.py` に 3 サブコマンド / `~/bin/gpt`
- ランチャー: `launcher.sh` / `launcher.ps1` の `options`・`commands`・`$LaunchTargets`・`MYCMUX_LAUNCH_TARGET` の case。番号の振り直しが必要 (`docs/agent-integration.md:142-144`)
- 規模の目安: Rust 400〜600 行・TS 300〜400 行・スクリプト 150 行・テスト更新。3 ファイル超なので delegation ルール上は Codex ALWAYS 委譲対象 (Grok canary 適格: 認証・決済・DB を含まない)
