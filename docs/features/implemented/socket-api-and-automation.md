# Socket API & Automation

## 概要

mycmux は起動時に `127.0.0.1` のランダムポートで TCP を待ち受け、ポート番号を `~/.mycmux/mycmux.port` に書き出します。外部プロセスはこのポートに改行区切りの JSON を1行送るとタブ操作を実行でき、結果が JSON 1行で返ります。ループバック以外からの接続は `socket.rs` 側で拒否し、さらに**全リクエストにトークンが必要**です (下記「認証」)。

主な用途は、タブ内で動く Claude Code / Codex からの mycmux 操作です。「続きの実装を別エージェントにやらせたい」とき、エージェント自身が可視の新タブを開いて相手を起動できます (v0.14.17)。

## プロトコル

```
リクエスト:  {"cmd": "pane.spawn", "args": {...}, "token": "<64桁hex>"}\n
レスポンス:  {"id": 0, "result": {...}, "error": null}\n
認証失敗:    {"ok": false, "error": "unauthorized"}\n   ← 直後に切断
```

| 層 | 実装 |
| --- | --- |
| TCP 待ち受け | `src-tauri/src/socket.rs` (`start_socket_listener`) — リクエストを `socket-request` イベントとしてフロントエンドへ橋渡し。応答待ちは30秒でタイムアウト |
| コマンド処理 | `src/components/layout/socketCommands.ts` (`handleSocketCommand`) — `SocketListener.tsx` がイベントを受けて呼び出す |
| ポート発見 | `~/.mycmux/mycmux.port` |
| トークン | `~/.mycmux/mycmux.token` (起動ごとに再生成) |
| CLI | `scripts/mycmux_agent_cli.py` (Python 標準ライブラリのみ) |

### 版と能力の照会 (2026-09-25 追加)

`system.version` は、認証を通ったあとに Rust が直接答えます (フロントエンドの準備を待ちません)。応答は `app_version`・`api` (`major: 1`、`minor: 0`)・`status_protocol`・`hook_protocol`・`commands`・`capabilities` です。`commands` には Rust が答える名前とフロントエンドの名前が入り、`e2e.*` は e2e ビルドのときだけ入ります。宣言する能力は `state_view.input_revision_nullable`、`send.enter.single`、`spawn.launch_spec.all_modes`、`launch.kind_env`、`agent.hooks.status`、`pane.screen.v1`、`pane.capture.v1` です。

`session.state_view` の各行は `input_revision` のキーを必ず持ちます。値は 0 以上の整数か `null` です。`null` は入力の数えがないこと (PTY が生きていない行など) を表し、0 とは違います。送信の期待値には使えません。CLI の `status` (`--session` なし) と、プロンプト・引き継ぎ・再開に `--model` または `--effort` を付けた `spawn` / `spawn-tab` は先に `system.version` を問い、能力が足りなければ操作せずに止まります。古い mycmux が `Unknown socket command: system.version` を返したときは `the running mycmux predates capability reporting` と出して止まります。`hooks-status` も `agent.hooks.status` 能力を確かめてから照会します。それ以外の CLI コマンドは 1 回の接続で済みます。

`pane.send_text` の Enter は 1 回だけ書きます。画面から受理を確認できないときは `outcome: "unknown"` と `enterWritten: true` を返し、自動で押し直しません。CLI の `send --enter` は exit 1 と再送禁止の警告を出します。`pane.spawn` / `pane.spawn_tab` は `launchSpec` に要求値・渡した値・`observed: false` を返します。適用できない target や再開の組み合わせはタブを作る前に拒否します。

### hook の導入状態

`agent.hooks.status` は Rust が直接答える読み取り専用コマンドです。返り値は `version: 2` と `providers` の配列で、各行に `provider`、`enabled`、`state`、必要なら `reason` を持ちます。照会はファイルや実行中の hook モードを変更しません。入切を変える socket コマンドはありません。状態と操作の詳細は [エージェント連携](./agent-integrations.md) を参照してください。

## 認証 (2026-08-09 追加)

ループバックは**認可の境界ではない** — 同じ PC 上のどのユーザーセッションのどのプロセスからも届くため、従来はローカルの任意プロセスが pane spawn / send_text / close を叩けました。そのためローカルソケットにもトークン認証を入れています。

- mycmux は起動のたびに 32 バイト乱数を hex 化した**プロセス固有トークン**を `~/.mycmux/mycmux.token` へ書き出す (ポートファイルより先に書く)。前回起動のトークンは使えない
- 呼び出し側は毎リクエストの JSON トップレベルに `"token": "<ファイルの中身>"` を入れる。`status.subscribe` / `status.snapshot` のフィードフレームも同じ
- 検証は定数時間比較 (`socket.rs` の `validate_token`)。不一致・欠落なら `{"ok":false,"error":"unauthorized"}` を返して即切断する。`token` フィールドは検証後に取り除かれ、フロントエンドにもログにも渡らない
- 拒否は diag.log に記録するが、リトライループで 1MB ログを潰さないよう**60秒に1行 + 抑止件数**にまとめる
- **逃げ道**: 未対応の外部ツールがある場合は、mycmux を `MYCMUX_SOCKET_AUTH=off` の環境で起動すると認証を無効化できる (起動時に diag.log へ警告を残し、紛らわしい古いトークンファイルは削除する)
- 同梱の消費者 (`scripts/mycmux_agent_cli.py`・`scripts/status_feed_probe.py`・`scripts/mycmux_doctor_lite.py`) はトークンファイルがあれば自動で添付し、無ければ従来どおり素で送る (旧バージョンの mycmux とも話せる)

## 主な実装済みコマンド

| コマンド | 引数 | 動き |
| --- | --- | --- |
| `workspace.list` | なし | ワークスペース一覧と active ID |
| `workspace.select` | `workspaceId` | ワークスペース切替 |
| `workspace.rename` | `workspaceId`, `name` | ワークスペース名変更 |
| `workspace.new` | `name`、`cwd?`、`gridTemplateId?` | 背景にワークスペースを新設し `{workspaceId, name, panes[], foregroundChanged}` を返す |
| `workspace.close` | `workspaceId` | 背景ワークスペースを閉じる（PTY kill・scrollback 削除・復元履歴の記録）。active は拒否 |
| `pane.list` | `workspaceId` (省略時 active) | 表示中のタブと裏のタブの一覧 (sessionId 含む) |
| `pane.spawn` | 下記 | 新タブを可視で立ち上げ、`{workspaceId, paneId, sessionId, mode}` を返す |
| `pane.spawn_tab` | `anchorSessionId`、起動引数 | 呼び出し元のタブの裏に新しいタブを追加 |
| `pane.list_all` | なし | 全ワークスペースの表示中のタブと裏のタブの一覧。`workspaces[]` に `zoomedPaneId` (入れ物の ID または null) |
| `pane.activate_tab` / `pane.close_tab` / `pane.rename_tab` | `sessionId` 等 | タブの選択・終了・改名 |
| `web.open` / `web.list` / `web.focus` / `web.push` | `presetId`、`tabId` 等 | サービス Web タブの操作 |
| `web.read` / `web.close` | `tabId` (`web.read` は `presetId`、`anchorSessionId` でも指定可) | 会話を JSON で取得 / Web タブを閉じる |
| `web.navigate` | T + url または action (back/forward/reload) | URL移動・履歴移動・再読み込み |
| `web.wait` | T + state、selector?、timeoutMs?、intervalMs? | 読み込み・DOM静止・要素出現を待ち、期限では ready:false |
| `web.eval` | T + script、timeoutMs? | async 関数本体の評価結果を JSON で返す（512 KB） |
| `web.snapshot` | T + mode? (ax/text)、maxBytes? | AX-lite の nodes / ref または本文を取得 |
| `web.find` | T + text?、role?、selector?、exact?、limit? | 可視要素を検索して nodes / ref を取得 |
| `web.click` | T + ref または selector または x,y、button?、clickCount?、trusted? | 要素をクリック |
| `web.type` | T + ref または selector、text、mode?、submit?、trusted? | input / textarea / contenteditable へ置換・追記 |
| `web.key` | T + key、code?、modifiers?、ref?、trusted? | キー入力を送る |
| `web.scroll` | T + ref? または selector?、deltaX?、deltaY? | スクロール容器またはページを移動 |
| `web.upload` | T + ref または selector、paths、mode?、trusted? | ファイル入力またはドロップ（合計25 MB） |
| `web.screenshot` | T + path?、clip? | PNGを保存して path / width / height / dpr を返す（Windows先行） |
| `web.downloads` | T | URL・path・success・finishedAt を取得 |
| `web.dialogs` | T + clear? | browser の自動応答ダイアログ記録を取得・消去 |
| `pane.send_text` | `sessionId`, `text`, `enter?` | 既存タブの端末へ入力を送る |
| `pane.read` | `sessionId`, `lines?` (既定80、最大400) | 既存タブの画面末尾を読む |
| `pane.screen` | `sessionId`, `scrollback?` (既定0、0〜500) | 端末の表示範囲をセルと属性で読む (読み取り専用) |
| `pane.capture` | `sessionId`, `scale?` (`native`・1・2、既定`native`) | 同じ表示範囲をPCの設定のxtermでPNGに描く (読み取り専用) |

新コマンドの `T` は `{tabId?, presetId?, anchorSessionId?}`。tabId 優先、指定がなければ対象ワークスペース内の最新プリセット候補を使う。`trusted` と screenshot は Windows 先行（macOSは段2）。

`web.open` は `url` (既存プリセットはHTTPS、browserはHTTPSまたはlocalhost / 127.0.0.1のHTTP) と `background: true` (フォーカス維持、`replaceAnchor` と併用不可) に対応。`web.list` は `background` / `active` を返す。

一覧・ワークスペース操作には snake_case の別名 (`list_workspaces` など) もあります。全コマンドは `socketCommands.ts` の dispatcher と `mycmux_agent_cli.py` の parser が正本です。
`status.subscribe` / `status.snapshot` は `socket.rs` が直接扱う状態フィードで、PTY 生出力のストリーミングとは別です。

### `pane.capture` の画像読取

`system.version.commands` の `pane.capture` と `capabilities` の `pane.capture.v1` が対応の印です。
要求例 (認証トークンは省略):

```json
{"cmd":"pane.capture","args":{"sessionId":"pty-sample","scale":"native"}}
```

`session_id` は `sessionId` の別名です。成功時の `result` は次の形です (`screen` の本文とbase64は省略):

```json
{
  "sessionId": "pty-sample",
  "screen": {"sessionId": "pty-sample", "cols": 120, "rows": 40},
  "image": {"type": "image/png", "scale": 1.5, "native": true, "width": 1080, "height": 960, "data": "<base64>"},
  "renderer": "webgl",
  "elapsedMs": 42.0
}
```

`screen` は同じ時点に `pane.screen` を `scrollback:0` で読んだ値そのものです。表示中で解析済みの xterm、または headless のセルを読み、別の撮影専用端末へ再生してPNGにします。別の窓のセッションは所有窓へ振り分け、その窓で撮ります。PTYの起動・入力・フォーカス・スクロール・タブ選択は行いません。hookの権限からは呼べません。

`scale` の既定 `native` は、その窓の現在の `devicePixelRatio` で描きます。Chromiumの小数の精度を保って描画し、返す `image.scale` だけを小数2桁に丸めます。`1` と `2` はCSS 1pxあたりの画像の画素数を指定し、`image.native` は実際に窓と同じDPRで描いたかを表します。撮影専用 xterm のインスタンスだけDPRを上書きして字形と格子を描き直し、WebGL backingの画素を1:1でコピーします。本物の端末と窓のDPRには触れません。xterm更新でこの内部APIが無くなった場合は、字の大きさとletterSpacingを `scale / 窓のDPR` 倍にして描き直します。画像の引き伸ばしは行いません。この代替経路では格子の丸めで寸法が異なることがあります。`width`・`height` は実際のPNG画素数です。

設定は本物の端末と同じbuilderと現在の値から読みます。書体・大きさ・太さ・行の高さ・letterSpacing・テーマ・contrast・描字の設定とcomputed typographyを次の撮影へ反映し、未読込の字を待つ時間も期限に含めます。字の読込が失敗した場合は本物と同じブラウザの代替書体を使います。DOM描画を選んでいる間は `unavailable` です。WebGLへ戻すと撮影端末を作り直します。

画像は端末の格子だけで、余白・スクロールバー・選択色・タブ見出しを含みません。背景は不透明で、壁紙と透過はv1では再現しません。カーソルは `screen.cursor` に従い、フォーカスの無い端末の輪郭の形で点滅せず描きます。画面の文字と画像はメモリだけに置き、ファイル・console・診断ログへ残しません。

誤りはソケット応答の `error` に次の語を返します。

| 語 | 条件 |
| --- | --- |
| `pane.screen` と同じ語 | 対象なし・宣言タブ・バッファなし・寿命の変更 (`pane read lifetime changed` を含む) |
| `pane.capture scale must be native, 1 or 2` | 不正な倍率 (文字列 `"1"` も不可) |
| `pane.capture busy` | その窓で撮影・読取中。2本目を待たせず拒否 |
| `pane.capture timeout` | 描画開始からPNGのbase64完成まで400ms以上 |
| `pane.capture unavailable` | WebGLを使えない・文脈の喪失・描画や再生の失敗 |

`elapsedMs` は描画開始からbase64完成までで、元の `screen` の読取時間を含みません。期限超過やタブの寿命変更の結果は捨て、準備済みの撮影端末は次の要求で再利用します。`unavailable` や文脈喪失では端末と文脈を捨て、次に作り直します。撮影端末とWebGL文脈は窓ごとに1つだけ追加し、本物の端末の12枠を消費しません。60秒使わなければ両方を解放します。ソケットの1MiB制限は要求行だけに適用され、応答行には大きさの上限を設けていません。

v1の制限:

- wireのセル属性は下線の種類 (波線・二重)・下線の色 (SGR 58)・上線を運びません。neovimのundercurlなどは、画像では本文色の直線の下線になります。
- WebGL addonの字形atlas cacheは本物の端末と共有されます。nativeの撮影は、裏のタブの字形を本物と同じatlasへ描き足します (atlasの上限内)。nativeと2を交互に撮ると、2のatlasは毎回作り直されます。
- 撮影用の1文脈は本物の12枠とは別です。Chromiumの上限16に対する余白は4から3へ減ります。本物の端末の予算は変更しません。

### `pane.screen` の画面読取

`system.version.commands` の `pane.screen` と `capabilities` の `pane.screen.v1` が対応の印です。
要求例 (認証トークンは省略):

```json
{"cmd":"pane.screen","args":{"sessionId":"pty-sample","scrollback":0}}
```

返り値は `sessionId`・`cols`・`rows`・`cursor`・`atBottom`・`alternateScreen`・`scrollbackLines`・`theme`・`lines` です。
`scrollback` は表示範囲の上へ足す行数で、整数の範囲外は 0〜500 に丸めます。実際に存在する分だけを足します。
`lines` の長さは常に `scrollbackLines + rows`。空行は `[]`、折り返した物理行は別の要素です。
各行の run は `[col, width, text, fg, bg, flags]`:

- `col` は 0 始まりの列、`width` は各書記素のセル幅 (1 または 2)。全角の続きのセルは重複させず、結合文字は元の文字と同じセルに含めます。幅か属性が変わるときや、連結で書記素の境界がセルの境界とずれるときに run を分けます。
- `fg`・`bg` は既定色なら null、色番号なら 0〜255、RGB なら小文字の `#rrggbb`。OSC で変更した 16〜255 番の色は RGB に解決します。
- `flags` は太字 1・斜体 2・下線 4・薄字 8・反転 16・取り消し線 32 のビット和です。
- 既定の空白は省略することがありますが、位置は `col` に残します。背景・反転・下線などのある空白は保持します。非表示属性の文字は空白として扱います。

`cursor` は `{col, row, visible}` (0 始まり) で、`row` は追加した履歴を含めず表示範囲の中の行です。
範囲外なら null。`visible` は端末のカーソル表示モードを表します。PC で上へスクロールしている間は `atBottom: false` で、その位置を読み、PC の表示を動かしません。
`alternateScreen` は代替画面の使用中を表します。
`theme` は端末に適用した前景 `foreground`・背景 `background`・カーソル `cursor`・ANSI 16 色の `palette`。アプリからの OSC 色設定・解除も反映します。
色は RGB で返し、透過背景でもテーマの RGB を保ちます (背景画像や透過率はこの形式に含みません)。

表示中で解析済みなら live xterm、それ以外は PTY の既存出力を headless xterm で再生し、同じ関数でセルを読みます。
headless も Unicode 11 と画面の色変換を使います。ポーリングの IPC 待ちは observation 経路に置き、送信確認の 250ms の期限を占有しません。
別の窓のタブは既存の所有窓への振分けを使います。PTY の起動・入力・フォーカス変更・保存は行いません。
用途ごとに解析状態を分け、`pane.read` の結果は `pane.screen` の呼び出しに左右されません。
`pane.read` の整形済み文字列と `pane.live_tails` の返り値は従来どおりです。

誤りの語は `pane.screen requires sessionId`・`pane.screen cannot target a declared tab`・`pane.screen session is not a known pane`・`no terminal buffer for session`。
`pane.list_all.workspaces[].zoomedPaneId` は「このタブだけ表示」の対象の入れ物 ID で、該当しなければ null。別の窓の値は取得できないため null です。

見本 (62×48・120×40) と測定値の再生成:

```bash
UPDATE_PANE_SCREEN_SAMPLES=1 nice -n 15 ./node_modules/.bin/vitest run --no-cache --configLoader runner tests/unit/paneScreenSamples.test.ts
```

実際の読取関数へ架空の ANSI 画面を通し、`.dispatch/out/pane-screen-sample-62x48.json`・`pane-screen-sample-120x40.json` と測定 JSON を出します。

#### 既知の制約

- PTY の出力履歴は最大 256KB です。それより前の色・非表示属性・代替画面などの状態は、キャッシュが無い場合には復元できません。`pane.read` も同じ履歴の制約を受けます。
- 解析済みの headless キャッシュがあれば、その状態をリサイズして差分を追加します。キャッシュが無い場合の全再生は今の寸法で解釈するため、過去のリサイズ順序を再現できません。
- PC 側で上へスクロール中に解析が遅れている間は、headless の表示位置が一時的にずれることがあります。
- テーマ変更後の全再生では、過去の出力も今の色変換で解釈します。出力時点のテーマや変換設定の履歴は保持しません。
- 解析が遅れている間に OSC の色変更と同じテーマの再適用が重なると、解析が追いついたあとも色が残ることがあり、次のテーマの再適用か再起動で消えます。

### `workspace.new` の作成と起動

既定で active ワークスペースを動かしません。前面を変えるフラグも用意していません（`dbfabc76` の契約）。
例外はワークスペースが 0 個で active ID が null のときだけで、最初のワークスペースを表示し、応答の `foregroundChanged` が true になります。
新ワークスペースの1枚目は起動メニューの仮タブです（`gridTemplateId` 指定時はそのグリッドの枚数）。
起動メニューのタブ1枚だけの未使用状態なら、最初の端末用 `pane.spawn` がそのタブを使い切り、メニューは残りません。応答の `replacedLauncherPane: true` が置き換え、`false` が既存の分割経路を示します。Web ターゲットは従来どおりタブを増やします。その際、`addPaneToWorkspace` と `addWebTabToPane` が全体の active タブを動かすので、`pane.spawn` は前後で UI の active タブ・focus 対象を退避して復元します（`web.open` と同じ扱い。2026-09-11 にこの復元漏れを修正）。
背景ワークスペースでも `startBackgroundTabSession` で PTY が起動します。起動に失敗した場合は追加タブを外し、元の起動メニューを残します。

`workspace.close` は確認ダイアログを持たない代わりに、active なワークスペースを拒否します。人が見ているワークスペースを閉じる操作は画面の ✕ から行います。
背景ワークスペースを閉じると PTY を終了し、scrollback を削除します。復元可能なタブは `Ctrl+Shift+T` の復元履歴に入り、`undoRecorded` が記録件数を返します。

### `pane.spawn` の起動モード (Web 分岐を先に判定、端末は上から優先)

| モード | 引数 | 動き |
| --- | --- | --- |
| web | `target: "web"`、`preset` または `presetId` | PTY を作らずサービス Web タブを開く |
| handoff | `handoffFromSessionId` (+`handoffFromKind`) | 既存セッションの履歴から `crsm handoff` で引き継ぎ書を生成し、`MYCMUX_HANDOFF_*` env で起動 |
| prompt | `promptFile` (+`fromSessionId`, `fromKind`) | 指定した指示書ファイルをそのまま `MYCMUX_HANDOFF_PROMPT_FILE` として起動。`fromSessionId` 省略時は `"external"` を補う (空だと `terminal.rs` の `sanitize_launch_env` が handoff env を剥がすため) |
| resume | `resumeSessionId` | `MYCMUX_RESUME` + `MYCMUX_SESSION_ID` で resume 起動 |
| launch / shell | なし | `MYCMUX_LAUNCH_TARGET=<target>` で新規起動。`target: "shell"` は `shell-starter` の起動メニュー |

共通引数: `target` (カタログの agent 行すべて、agy・hermes・omp を含む。ほかに shell / web。必須)、`workspaceId`、`anchorPaneId`、`direction` (right / down)、`cwd`、`label`、`activate` (`pane.spawn`・`pane.spawn_tab` ともに既定 false = 裏起動)。2026-08-06 に、裏で立ち上げたタブが操作者のフォーカスを奪わないよう、`pane.spawn` も裏起動に統一しました。

env 構築は純関数 `resolveSpawnPlan` に分離してあり、`tests/unit/socketCommands.test.ts` で単体テストしています。

## 安全設計

- ループバック限定 + プロセス固有トークン (上記「認証」)。GUI パレットで人間ができる操作を、トークンを読める呼び出し元にだけ開放している
- `MYCMUX_LAUNCH_TARGET` と、New Workspace ダイアログが同じ経路で渡す `MYCMUX_LAUNCH_MODEL` / `MYCMUX_LAUNCH_EFFORT` は ephemeral env ガード (lib.rs 起動時 `remove_var` / `terminal.rs` の `sanitize_launch_env` / SocketListener の永続化フィルタ、契約テスト `tests/test_ephemeral_env_keys_contract.py`) に登録済み。data.json に残さず、起動時の一時値が再起動時に再利用されるのを防ぐ
- model / effort の値はコマンドラインに載るので、`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` に合うものだけを通す (先頭を英数字に固定してフラグ偽装を封じる)。検証は GUI 側 (`src/lib/agentCatalog.ts`) とランチャー2本の両方に置き、ランチャーは読んだ直後に env から消す
- `pane.send_text` は生の端末入力。CLI ヘルプにも「対象 sessionId を確認してから使う」旨を明記

## CLI 使用例

```bash
python scripts/mycmux_agent_cli.py version
python scripts/mycmux_agent_cli.py hooks-status
python scripts/mycmux_agent_cli.py panes
python scripts/mycmux_agent_cli.py workspace-new --name hermes-lane
python scripts/mycmux_agent_cli.py spawn --split --workspace <id> --target codex --no-activate
python scripts/mycmux_agent_cli.py workspace-close --workspace <id>
python scripts/mycmux_agent_cli.py spawn --target codex --prompt "指示書の内容"   # アクティブなタブは移動しない。--activate は背景ワークスペース内のアクティブ化を許す
python scripts/mycmux_agent_cli.py spawn --target codex --split --prompt "..."   # 別に表示するタブで開く
python scripts/mycmux_agent_cli.py spawn --target claude --handoff-from-session <ID>
python scripts/mycmux_agent_cli.py read --session <sessionId> --lines 120
python scripts/mycmux_agent_cli.py send --session <sessionId> --text "続けて" --enter
```

`--prompt` の本文は `~/.mycmux/agent-prompts/<UTC時刻>-<乱数>.md` に保存してから `promptFile` として送ります。

### CLI `spawn` の配置既定 (2026-07-15 変更)

`spawn` はタブ内から呼ぶと (`MYCMUX_PANE_SESSION_ID` 検出) **既定で `pane.spawn_tab`** に送り、呼び出し元のタブの裏に新しいタブとして、アクティブなタブを移動せずに立ち上がります (呼び出し元との親子関係がタブ並びで見える)。`--activate` は背景ワークスペース内のアクティブ化を許すだけで、操作者の前面は変えません。右や下に別のタブを表示するのは `--split` 明示のみ (2026-08-21 以降)。`--direction` / `--anchor-pane` / `--workspace` は `--split` と併用必須で、単独指定はエラー。タブ外 (env なし) からの実行もエラーになり、暗黙に別の表示先へ落ちることはありません (`--split` を付ければ可)。応答 JSON に `placement` (`tab` / `pane`) が付きます。`pane.spawn` の `activate` 既定値も false です。

### 運用ノート (2026-07-15 実機検証より)

- CLI は stdout/stderr を UTF-8 に reconfigure してから print する (cp932 コンソールでタブ内容の「⚠」等により UnicodeEncodeError で落ちる実害があった)
- `--target shell` は起動メニューを開く。現行の新規タブは React ランチャーで、bash メニューは互換経路。`send` は PTY のある端末タブを選び、送信前に状態を確認する
- `pane.read` は端末バッファの末尾を読む。宣言だけのタブや未知の sessionId はエラーになる

## 未実装 (cmux 参照からの候補)

`pane.close` / `pane.focus`、`notify.*`、`theme.*`、PTY 出力のストリーミング購読。同名コマンドは未実装です。タブ単位の終了・選択は既存の `pane.close_tab` / `pane.activate_tab` を利用できます。
