# mycmux 側の拡張 spec: Web ペインの読み戻し (`web.read`) と URL 指定オープン

読者＝Codex (実装担当)／語り手＝母艦 (Claude)／相手＝Codex／その先＝宮崎さん (採否)。
oracmux の `push → 人が会話 → collect` の帰り道を、OracleChrome 経由でなくペインから直接取れるようにする。
**採否は宮崎さん。着手は別 GO** (本番アプリの変更・リリース工程が要る)。

## 背景 (一次資料)

- 要件書 `docs/plans/2026-08-27-web-pane-chatgpt-requirements.md` R4 (`--remote-debugging-port`) と決定 7 (戻りは v1 片道) は実装されていない。
  `src-tauri/src/commands/webpane.rs` に `remote-debugging` の記述は無く、ソケットは `web.open / web.list / web.focus / web.push` の 4 本 (`src/components/layout/socketCommands.ts`)
- `webpane_push` は `webview.eval(script)` + `webpane_push_result` (oneshot) で結果を返す。**同じ型で読み戻しが作れる** (CDP ポートを開けるより露出が小さい)
- Grok プリセットの composer が `textarea[aria-label], form textarea` で、実物は TipTap の `div.tiptap[role='textbox']` (2026-08-23/09-07 実測)

## 変更境界

| # | 変更 | 場所 |
|---|---|---|
| 1 | `webpane_read` command: 引数 `tab_id`。プリセットごとの `reader` セレクタ (assistant / user / generating) で `{url, generating, turns:[{role,text}], last_assistant}` を eval → `webpane_read_result` で返す (push と同じ oneshot・5 秒 timeout・256 KB 上限) | `src-tauri/src/commands/webpane.rs`, `commands/mod.rs`, `lib.rs` (登録) |
| 2 | ソケット `web.read {tabId? \| presetId, anchorSessionId?}` → 上記 JSON。CLI `web-read [--tab] [--preset]` | `src/components/layout/socketCommands.ts`, `scripts/mycmux_agent_cli.py` |
| 3 | Grok プリセットの composer を `div.tiptap[role='textbox']`、submit を `[data-testid='chat-submit']` に修正 | `webpane.rs` の `WEB_PANE_PRESETS` |
| 4 | `web.open` に任意の `url` (プリセットの許可ホスト内のみ) を足す。oracmux の `ask` 後に同じ会話をペインで開く用 | `webpane_create` に `initial_url: Option<String>`、`socketCommands.ts`、CLI `web-open --url` |
| 5 | reader セレクタ表 (chatgpt: `[data-message-author-role]` / gemini: `user-query, model-response` / grok: `[data-testid='user-message'], [data-testid='assistant-message']`) は oracmux の `engines.json` と同値にする。二重保守を避けるため、値の出典コメントに oracmux を書く | `webpane.rs` |

触らないもの: PTY・エージェント種別・ランチャー・data.json スキーマ (URL は既存の `lastUrl` 復元と整合させる)。

## 受入条件 (実行コマンド)

```
npx tsc --noEmit
npx vitest run
python scripts/run_windows_tests.py          # webpane.rs のユニットテストに reader 契約を追加
python -m pytest tests/                       # test_command_sync_contract.py の allowlist 整合
python scripts/mycmux_agent_cli.py web-open --preset gemini && python scripts/mycmux_agent_cli.py web-read --preset gemini
```

- `web-read` が `{url, generating:false, turns:[...]}` を返し、`turns` の最後が直前に送った PING の回答であること (テスト機・`--profile` 隔離で実施)
- Grok ペインに `web-push --preset grok --text "PING"` が「composer was not found」を出さないこと
- 既存 4 コマンドの挙動不変 (vitest の socketCommands テストが緑)

## 判断者・セルフレビュー

採否は母艦→宮崎さん。提出前にセルフレビュー 2 周 (1 周目=受入条件の充足、2 周目=指示外変更・退行・積み残し) を報告に書く。
モデル・effort: `gpt-6-astra` high (標準実装)。3 ファイル超なので Codex ALWAYS 委譲。Grok canary 適格 (認証・決済・DB を含まない)。

## 完成後に oracmux 側で変えること

- `collect` に `--from-pane` を足し、`web-read` を第一経路、OracleChrome を代替にする
- `ask --show` で `web-open --url <会話 URL>` を叩き、回収済みの会話をペインで開く
