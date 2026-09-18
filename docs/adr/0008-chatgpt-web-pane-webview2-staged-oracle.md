# ChatGPT は mycmux 内の WebView2 (Web ペイン) に載せ、oracle は段階移行で同じ WebView2 に attach する

**Status**: accepted (2026-08-27 宮崎さん裁定)

GPT Pro (Pro effort) は ChatGPT Web でしか使えず、エージェント側の最終判定ゲート (oracle) は画面外 Chrome (CDP 9222) を自動操作している。人間が ChatGPT Web の機能 (Deep Research・Canvas・画像・ファイル添付) を mycmux 内で使いたい要求と、oracle の経路を壊さない要求を両立させるため、**まず人間用の ChatGPT ペインを Tauri child webview (WebView2・専用プロファイル・`--remote-debugging-port` 付き) として実装し、その後 oracle を `--remote-chrome` でこの WebView2 に attach する spike を通してから Chrome 常駐を廃止する**。spike が不合格なら Chrome 常駐は恒久的に併存させる (その場合もペインは人間用として成立する)。

## 検討した選択肢

- **一気に統合 (最初から WebView2 を唯一のエンジンにする)** — 却下。WebView2 の CDP は `Target.createTarget` 非対応の可能性・Google ログイン拒否・Cloudflare の 3 点が未検証で、詰まると oracle の最終判定ゲートが止まる。
- **Chrome 維持 + `SetParent` で窓を mycmux ペインに貼る** — 却下。oracle は無変更で済むが、HWND 埋め込みは DPI・フォーカス・z-order のハックで、Chrome 依存が残り「mycmux 内で完結」にならない。
- **iframe (現行 BrowserPane の延長)** — 却下。chatgpt.com は X-Frame-Options で埋め込めず、cookie 永続化・DevTools・CDP のいずれも成立しない (`docs/plans/rich-browser-pane.md` の Option B と同じ結論)。

## 結果

- Web ペインは「プリセット基盤」として作る (URL + 専用プロファイル + ランチャー項目の 3 組)。v1 は ChatGPT の 1 件だけ登録し、Gemini / Grok の Web 本家は同じ基盤に後から載せる。
- 移行期間中は ChatGPT のログインが 2 本 (画面外 Chrome と WebView2) になり RAM が 200〜300MB 増える。これは受け入れる。
- CDP ポートは 127.0.0.1 限定・認証なし (現行の 9222 と同じ露出)。ポートを開くのは Phase 2 の attach と、Phase 1 のファイル添付注入 (`DOM.setFileInputFiles`) の両方で必要なため、Phase 1 から開ける。
