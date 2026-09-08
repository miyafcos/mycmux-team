# Agent Integration Contract — mycmux 内エージェントの委譲規約

mycmux はエージェント (Claude Code / Codex) の振る舞いを強制しない。
「委譲は見える形で = 新しいセッションタブを開いて行う」という方針は、
**各エージェント側のルールファイルに書くことで成立する**設計になっている。
この文書はその契約の正本 (mycmux 側から見た全体図)。環境再構築・別 PC 展開時はここを起点にする。

## 方針 (2026-07-16 宮崎さん確定)

- mycmux 内でエージェントが別エージェントへまとまった作業を委譲するときは、
  **ヘッドレスのバックグラウンドジョブではなく、同ペインに可視タブを spawn する**。
  画面で監視・介入できる形が正 (openai-codex プラグインの裏ジョブは同日撤去済み)。
- ヘッドレス (`codex exec` 等) の許可場面は3つのみ:
  1. 非 mycmux セッション (cron / schedule の自律ジョブ — 見る人がいない)
  2. Workflow の大量 fan-out 並列段 (タブ爆発防止)
  3. 介入余地のない短い照合 (math-verify 等)
- Claude Code 内部の Task / subagent は対象外 (従来どおり裏実行。タブ爆発防止)。

## mycmux がエージェントに提供するもの

### 環境変数 (mycmux 内判定に使う)

| 変数 | 用途 |
| --- | --- |
| `MYCMUX_TERM_PROGRAM=mycmux` | mycmux 内で動いているかの判定 (委譲経路の分岐キー) |
| `MYCMUX_TAB_ID` / `MYCMUX_PANE_SESSION_ID` | 自タブ・自ペインの識別。spawn-tab のアンカーに使われる |
| `MYCMUX_MARKDOWN_OUT` / `MYCMUX_HTML_OUT` / `MYCMUX_ARTIFACTS_DIR` | セッション成果物の出力先 |

### CLI (`scripts/mycmux_agent_cli.py`)

Web 操作: `web-open --url https://chatgpt.com/c/abc --background`、`web-read --tab <id>` (または `--preset <id>`)、`web-close --tab <id>`。結果は JSON で返す。
`web-push` がタブを新規作成するときは裏タブで開き、呼び出し元のフォーカスを維持する。前面で開く場合は `web-open` → `web-push --tab <id>` を使う。

```
python scripts/mycmux_agent_cli.py spawn --target <claude|codex> --prompt-file <spec.md>
```

- 同ペインに新しいタブを開き、純正の対話 TUI (Claude Code / Codex) を起動して spec を流し込む
  (内部 RPC: `pane.spawn_tab`。`--split` または `spawn-tab --detach` 指定時のみ `pane.spawn` = 新ペイン。`--workspace` / `--anchor-pane` / `--direction` は `--split` 必須。`MYCMUX_PANE_SESSION_ID` 欠落時はエラー終了 — 新ペインへのフォールバックはしない (2026-08-21 裁定)。応答 JSON の `placement` が `tab` / `pane` を示す)
- effort やモデル指定は CLI フラグでは渡らない — **spec 本文に日本語で明記**する
- spawn の初期 handoff と、既存タブへの一般入力は別経路。一般入力で生の `send --enter` を自動実行せず、後述の mycmux bridge で画面と canonical state を検証する

#### Web 操作

基本ループは `open --background → wait → snapshot → find/click/type → wait → snapshot/eval → close`。
`browser` は汎用の AI 用プリセットで、HTTPS と `http://localhost` / `http://127.0.0.1` を開ける。
省略時のプリセットは従来どおり `chatgpt`。open の結果の `tabId` を後続の `--tab` に渡して対象を固定する。

`web-snapshot --mode ax` の `nodes` は role・name・rect と `ref` を返す。ref は次の snapshot/find またはページ移動まで有効で、古い ref はエラーになる。
ref は同一文書内で有効（hash 遷移では維持・ページ遷移と reload で無効）。snapshot/find を再実行すると ref は再発行される。
`web-eval` の script は async 関数本体なので、値の取得には `return`、非同期処理には `await` を使う。
`web-wait` / `web-eval` の `timeoutMs`（CLIは `--timeout-ms`）は25000 ms以下。ソケット応答期限30秒を超える待機は、結果を確認して再度ポーリングする。
`web-wait` は期限で `ready:false` を返す。`idle` は読み込み完了かつ DOM 変化から500 ms以上経過した状態。

| CLI | 動き |
| --- | --- |
| `web-open --preset browser --url URL --background` | フォーカスを維持して裏タブを開く |
| `web-list` | Web タブ一覧と presetId / background / active を取得 |
| `web-navigate --tab ID (--url URL / --back / --forward / --reload)` | URL移動・履歴移動・再読み込み |
| `web-wait --tab ID --state load/idle/selector [--selector CSS] [--timeout-ms N]` | 読み込み・DOM静止・要素出現を待つ |
| `web-eval --tab ID (--script JS / --script-file PATH) [--timeout-ms N]` | async 関数本体を評価し JSON を取得（入力256 KB・結果512 KB上限） |
| `web-snapshot --tab ID [--mode ax/text] [--max-bytes N]` | AX-lite または本文を取得（AXは最大800要素、max-bytesは4096以上） |
| `web-find --tab ID [--text TEXT] [--role ROLE] [--selector CSS] [--exact] [--limit N]` | 可視要素を検索 |
| `web-click --tab ID (--ref REF / --selector CSS / --x X --y Y) [--trusted]` | 要素・座標をクリック（button、click-count 1〜3も指定可） |
| `web-type --tab ID (--ref REF / --selector CSS) (--text TEXT / --text-file PATH) [--append] [--submit] [--trusted]` | 置換・追記し、指定時だけ Enter を送る |
| `web-key --tab ID --key KEY [--code CODE] [--mod ctrl,shift,alt,meta] [--ref REF] [--trusted]` | キー入力 |
| `web-scroll --tab ID [--ref REF / --selector CSS] [--delta-x N] [--delta-y N]` | 容器またはページを移動 |
| `web-upload --tab ID (--ref REF / --selector CSS) --file PATH [--file PATH ...] [--drop] [--trusted]` | ファイル添付（合計25 MB、drop と trusted は併用不可） |
| `web-screenshot --tab ID [--out PNG]` | PNGを保存し寸法・パスを返す |
| `web-downloads --tab ID` | ダウンロードの成功状態・パス・時刻を取得 |
| `web-dialogs --tab ID [--clear]` | browser の alert / confirm / prompt 記録を取得・消去 |
| `web-read --tab ID` | 既存サービスの会話を取得（reader 対応プリセットのみ） |
| `web-push --tab ID --text TEXT [--send]` | 既存サービスの composer に入力し、指定時だけ送信 |
| `web-focus --tab <id>` | 明示時のみ前面化（--tabのみ、--preset不可） |
| `web-close --tab ID` | Web タブを閉じる（--tabのみ、--preset不可） |

close / focus は `--tab` のみ（`--preset` 不可）。それ以外の操作コマンドの `--tab` は `--preset` に置き換えられる。プリセット指定では呼出元のワークスペース内の最新候補を使う。
JS の click/type/key/upload は合成イベントで、キーの既定動作は best effort。
`--trusted` と screenshot は Windows 先行（native レーンとの合流後）。macOS は段2で、未対応時は明示エラーになる。
browser の confirm は true、prompt は既定値で自動応答する。既存サービスのネイティブダイアログは維持する。
ダウンロード先は `~/.mycmux/handoff/web/<presetId>/downloads/`、同名ファイルは `-2`、`-3` と採番する。

実機検証は、母艦がテスト機を起動した後に `python scripts/verify_web_automation.py --runtime-dir <test-runtime-dir>` を実行する。
このディレクトリにはテスト機の `mycmux.port` / `mycmux.token` が必要。Windowsではscreenshotとtrusted操作の検証が必須で、未対応の応答もFAILになる。`--skip-screenshot` は非Windowsのみ指定できる。

### claude-codex 用 mycmux bridge

Claude harness の `ListAgents` は harness registry、mycmux の `pane.list_all` は workspace / pane / tab / PTY registry を返す。片方に存在するセッションがもう片方へ自動登録されることはない。claude-codex で一覧が不足するときは `mycmux-bridge list` を追加実行し、結果を `source` 付きで併記する。同名の agent や tab を暗黙統合しない。

共有 skill の入口:

```
python C:/Users/miyaz/.claude/skills/mycmux-bridge/scripts/mycmux_bridge.py list
python C:/Users/miyaz/.claude/skills/mycmux-bridge/scripts/mycmux_bridge.py read --session <PTY-sessionId> --lines 400
python C:/Users/miyaz/.claude/skills/mycmux-bridge/scripts/mycmux_bridge.py status --session <PTY-sessionId>
python C:/Users/miyaz/.claude/skills/mycmux-bridge/scripts/mycmux_bridge.py send --session <PTY-sessionId> --text "<message>"
python C:/Users/miyaz/.claude/skills/mycmux-bridge/scripts/mycmux_bridge.py answer-ask --session <PTY-sessionId> --answers-json '{"<question>": 2}'
```

- `read` / `status` / `send` / `answer-ask` の ID は、`pane.list_all` の `tabs[].sessionId` にある PTY session ID だけを使う。workspace ID、pane ID、tab ID、agentSessionId、claudeSessionId は別物
- `status` は一発 socket request に対応する `session.state_view` を使う。指定 session が未検出、重複、schema 不正なら fail closed
- `read` は mounted tab の renderer buffer、または inactive/background tab の PTY scrollback を headless xterm で再生した logical screen snapshot。transcript ではなく、最大400行
- 一般送信は alive / fresh / expected attention、session epoch、attention ID、session revision、PTY input revision、screen fingerprint を確認する。attention が `none` の場合も `expectedAttentionId: null` を明示し、attention / session / input の完全3点を atomic lock として送る。text-only write 成功時の input revision に1を足した値を Enter 用に固定し、draft が安定して見えた場合だけ semantic `enter` を1回送る。途中で別入力が入れば native CAS が拒否し、追加 Enter は送らない。成功後は residue 消失と state transition を確認する
- `SendMessage` は Claude harness session 用、bridge の PTY send は mycmux tab 用。相互互換として扱わない
- AskUserQuestion は `docs/adr/0003-askuserquestion-input-contract.md` が正本。初回に `input revision → screen` の順で観測し、screen identity にその revision を固定する。送信直前の再観測で revision を上書きせず、自分のwrite成功後だけ固定値を1増やす。単一選択と通常の複数質問は数字キー1バイトだけを送り、Enter を付けない。multiSelect のみ各 toggle 後に画面を再読し、Submit まで Down、Enter 1回、review で `1` の順に処理する

### ソケット認証 (2026-08-09 追加・自作ツールを書くとき必読)

ローカルソケットは**トークン必須**になった (ループバックは認可の境界ではないため)。CLI 経由なら意識不要 —
`mycmux_agent_cli.py` が自動で添付する。生ソケットを直接叩くツールを書く場合だけ以下に従う:

```
{"cmd": "pane.list_all", "args": {}, "token": "<~/.mycmux/mycmux.token の中身>"}\n
```

- トークンは mycmux の**起動ごとに再生成**される 64桁 hex。毎回ファイルから読む (キャッシュしない)
- 欠落・不一致は `{"ok":false,"error":"unauthorized"}` を返して即切断。`status.subscribe` などフィード系フレームも同じ扱い
- トークンファイルが無い = その mycmux が認証導入前か `MYCMUX_SOCKET_AUTH=off` 起動。素で送ってよい
- 未移行の外部ツールがあるときの逃げ道は、mycmux を `MYCMUX_SOCKET_AUTH=off` の環境で起動すること (全リクエストが無認証で通る。diag.log に警告が残る)
- 詳細は `docs/features/implemented/socket-api-and-automation.md` の「認証」節

### Antigravity (agy) の可視 spawn (2026-07-16 追加)

Gemini CLI は 2026-06-18 に個人アカウント向け終了 (実測: `IneligibleTierError`)。後継は
`agy` (Antigravity CLI)。`spawn --target` は claude/codex 系のみなので、agy は
**spawn-tab の任意コマンド argv 経路**で可視タブを立てる:

```
python scripts/mycmux_agent_cli.py spawn-tab --label agy -- env NO_COLOR=1 agy -i "C:/path/spec.md を読んで実行して"
```

- `-i` = 初期プロンプトつき対話モード (委譲の既定)。`-p` はヘッドレス単発 (許可場面は上記3つと同じ)
- 長い spec は argv に直接埋めず、spec ファイルを書いて「読んで実行」と渡す (quoting 事故防止)
- launcher メニューにも「Antigravity (agy)」あり (手動起動用・v0.150 系以降のビルドに同梱)
- **`NO_COLOR=1` を必ず付ける** (2026-08-09 追加)。agy は Google のライト配色をハードコードしていて、
  本文が `rgb(32,33,36)` (ほぼ黒)、インラインコードが 256色 index 254 (明るいグレー) の背景ベタ塗りになる。
  端末の背景色を一度も問い合わせない (ConPTY キャプチャで OSC 11 の送出ゼロ) ため mycmux 側から
  「暗いテーマだ」と伝える経路が無く、テーマ切替の env も持たない (`AGY_CLI_*` は 9 個あるが色関連はゼロ)。
  色を落とすのが唯一の対処 (agy 1.1.11 で `--theme`/`--no-color` 等の代替フラグが無いことも確認済み)。
  **launcher メニュー側は 2026-08-11 に PowerShell 側だけ実装された** (2026-08-15 実測: `launcher.ps1`
  に `NO_COLOR` 7件 / **`launcher.sh` は 0件で未実装のまま**。Windows 運用では launcher.ps1 しか
  使わないため実害は出ていない)。実装は `eval`/`& $exe` 直前の1点で、対象コマンドのときだけ**その1回の
  呼び出しにだけスコープして** `NO_COLOR=1` を前置する — `launcher.sh` は `.bashrc` から source され
  末尾で `exec bash -i` により同一プロセスへ戻るため `export` すると agy 終了後も `ls`/`git diff` 等の
  色が消えたまま残るリークになる。`launcher.ps1` は `-NoExit` の同一プロセスがそのまま生き続けるため
  try/finally で必ず元の値へ復元する。加えて `terminal.rs::inject_no_color_for_agy` が、launcher を
  経由せず `command="gemini"` 等を直接 spawn するビルトインエージェント経路
  (`src/lib/agents.ts`) 向けの防御として同じ処理を担う

### Grok Build (grok) の可視 spawn (2026-08-15 追加)

xAI の Grok Build CLI。**claude / codex と同格の `--target` 対応**なので、agy のような argv 経路は不要:

```
python scripts/mycmux_agent_cli.py spawn --target grok --prompt-file <spec.md>
```

- 実体は `~/.grok/bin/grok.exe` (PATH 済み)。`.cmd` シムではないので launcher の shim 関数は不要
- **初期プロンプトを位置引数で受ける**ため、codex のような「send しても submit されない」問題が無い。
  spawn 時に確実に投入される
- `--session-id <UUID>` を受けるので、launcher が起動前に採番して pane マッピングを直接書く
  (codex のようなログ推測は行わない)。resume は `--resume <id>` / `--continue` / `--fork-session`
- ランチャーの手動起動項目は「Grok Build」と「Grok Build (resume)」の2つ。
  `MYCMUX_LAUNCH_TARGET` は `grok` / `grok-resume`
- **(dangerous) 系のメニュー項目は 2026-08-15 に全廃**した (claude / codex / claude-codex / grok とも。
  実運用で使われていなかったうえ、メニューが 20 項目まで伸びて番号が押しづらくなっていた)。
  権限を開けた起動が要るときは Custom... から手で打つ。spawn の handoff 経路が内部で使う
  `bypassPermissions` は別経路なので影響しない
- セッションの実体は `~/.grok/sessions/<percent-encoded cwd>/<session-id>/` に1会話1ディレクトリ
  (`chat_history.jsonl` / `summary.json` / `events.jsonl` など。2026-08-15 実測)。
  cwd キーは `C%3A%5CUsers%5C...` 形式なので、復元判定は cwd バケットを走査して
  session-id のディレクトリを探す方式にしてある (`agent_restore.rs::grok_session_exists`)
- ailog の使用量集計、livebrief の会話取り込み (ダッシュボードの介入・要約)、およびアカウント
  切替と週間使用量表示は対応済み。CRSM パレットのフィルタは未対応で、grok タブはここでは見えない。
- 認証は SuperGrok / X Premium Plus のブラウザログイン (`grok login`)。未認証だと TUI が
  サインイン画面で止まる

### 新エージェントを登録するときのチェックリスト

`grok` 追加 (2026-08-15) で踏んだ全経路。エージェント種別は文字列リテラルで各層に散っているので、
**まず `rg -n '"claude-codex"' src src-tauri/src scripts tests` で全数抽出してから潰す**。

1. **型の正本**: `src/types/workspace.ts` の `AgentSessionKind`
2. **委譲の関門**: `src/components/layout/socketCommands.ts` の `isAgentKind()` —
   ここを通さないと `pane.spawn` が `unsupported pane.spawn target` で弾かれる
3. **CLI**: `scripts/mycmux_agent_cli.py` の `AGENT_TARGETS` / `AGENT_KINDS`、および
   `declare-tab --target` (**別ハードコードなので忘れやすい**)
4. **ランチャー**: `src-tauri/src/launcher.ps1` (Windows 本命) と `launcher.sh`。
   メニュー項目・`$LaunchTargets` / `MYCMUX_LAUNCH_TARGET` の case・handoff 分岐・resume 分岐・
   セッションID注入。**両ファイルともインデックス直書きがあるので既存項目の番号を全部振り直す**
5. **GUI の台帳**: `src/lib/agentCatalog.ts` の `AGENT_CATALOG` — New Workspace ダイアログが
   出す行はここが正本。`target` と `label` をランチャーと一致させ、`cli` と model / effort の
   選択肢を書く。CLI が model / effort を取るなら、あわせて3箇所:
   ①ランチャー2本の翻訳アーム (`Add-MycmuxLaunchSpecToCommandArray` / `__add_launch_spec_to_cmd`)
   ②ランチャー2本の選択肢台帳 (`$LaunchSpecCatalog` / `__spec_models_for`・`__spec_efforts_for`・
   `__spec_has_target`) ③メニュー行と target の対応 (`New-MycmuxOption` の第4引数 /
   `spec_targets` 配列)。
   `tests/test_launcher_catalog_contract.py` が欠落を機械検出し、両ランチャーに同じ入力を与えて
   出力一致まで確認する (選択肢リストは PowerShell と bash を実際に走らせて突き合わせる)
6. **表示**: `agentDisplayKind.ts` / `agentKindColors.ts` / `AgentIcons.tsx` / `PaneTabBar.tsx`
7. **Rust**: `pty/monitor/detection.rs` の `DetectedAgentKind`、`pty/monitor/runner.rs` の
   match アーム (**非網羅だとコンパイルエラー**)、`commands/session_mapping.rs` の allowlist、
   `commands/terminal.rs` の resume 可否、`commands/terminal/agent_restore.rs` の存在確認
8. **契約テスト**: `tests/perf/test_week1_day1_behavior_contracts.py` が launcher のメニュー配列と
   数字キー割当を**行文字列レベルで固定**している。`tests/unit/agentDisplayKind.test.ts` は
   `COMMAND_DISPLAY_KINDS` を `toEqual` で丸ごと固定。`tests/test_no_agent_kind_in_stall_path.py` の
   `FORBIDDEN` にも名前を足す (停滞判定はエージェント非依存が契約なので、`promptShape.ts` /
   `stallVerdict.ts` にはエージェント名を書かない)
9. **アカウント/使用量**: `CliProvider` / `cli_accounts/` / `usage/` / `PROVIDER_ORDER` を同時に追加し、
   登録・切替・使用量とログイン staging の全経路を確認する

### 完了検知の規約

spawn したタブの完了・生存は画面でなく**実体を3層でポーリング**する (2026-07-16 確立):

1. **DONE マーカーファイル** (spec で出力先を指定・末尾行判定は CRLF 耐性をつける) — 正常完了
2. **自セッションの rollout ログ増分** (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) —
   質問待ち・ハング・クラッシュはすべて「増分停止」として現れ、文言に依存せず検出できる。
   **自セッションの特定は cwd で行う** (ログ冒頭数行に作業ディレクトリが記録される)。
   spec マーカー文字列での特定はロールオーバーで破綻し、「最新ファイル」は並行セッションと混線する (実測)
3. **repo の編集ファイル mtime** (`git status --porcelain` 対象の stat)

増分が数分止まったらログ末尾の agent_message と canonical state を確認する。質問待ちへの入力は `mycmux-bridge` の safe path を使い、画面解析なしの素の Enter 後追いは行わない。

- `pane.read` は mounted tab の renderer buffer を返す。inactive/background tab は PTY scrollback を headless xterm で再生するため、logical screen snapshot として利用できる。ただし transcript ではない
- AskUserQuestion への回答は通常メッセージ送信と分け、数字1バイトまたは規定の multiSelect sequence を使う
- サブエージェントの自己申告 (「保存しました」) を成果と見なさない

## 配布物: Claude Code スキルパック

mycmux の「設定 → AI → Claude Code スキル → 導入」からも、3 スキルと agent CLI を導入できます (git・ZIP 不要)。パックはアプリに同梱され、アプリ更新後はカードから更新できます。コマンド導入と同じ manifest・導入マーカーで改変を保護し、置き換えるときは旧フォルダを退避します。

[skills/claude/README.md](../skills/claude/README.md) に 3 スキルの用途・前提・導入手順をまとめています。
旧 `examples/claude-skills/session-dispatch/` はパックへ移動しました。

```text
python scripts/install_claude_skills.py install
python scripts/install_claude_skills.py check
```

3 スキルは `~/.claude/skills/`、CLI は `~/.mycmux/bin/mycmux_agent_cli.py` に入ります。
更新も install です。導入後の改変がある場合は停止し、確認後の `--force` で旧フォルダを退避して置き換えます。
CLI は `MYCMUX_AGENT_CLI` → ホームの導入先 → スクリプトがあるリポジトリの順で解決し、欠落時は導入手順を表示して exit 7 です。

保守者の同期は `python scripts/sync_claude_skills.py --from-live --write-manifest`、
検証は `python scripts/sync_claude_skills.py --check` です。manifest と live の配布用変換後の SHA-256 を照合します。
逆方向の `--to-live` は保守者だけが実行します。個人用の rules は同梱しません。

## 各エージェント側のルールの所在 (このマシン)

| エージェント | ルールファイル | 該当節 |
| --- | --- | --- |
| Claude Code | `~/.claude/rules/delegation.md` | 「呼び出し経路 (2026-07-16 可視化一本化)」— 常時ロード |
| Claude Code (手順詳細) | `~/.claude/references/delegation-playbook.md` / `~/.claude/skills/codex-helper/` | spec テンプレと spawn 手順 |
| Codex | `~/.codex/AGENTS.md` | 「mycmux 統合」節 |
| 経緯・正本 | memory `reference_gpt56_codex_lineup.md` / `feedback_codex_delegation_visible_interactive.md` | 呼び出し経路の正本・2026-07-15 FB |

## 新しい環境に展開するときのチェックリスト

1. Python 3.10 以上と Claude Code を用意し、リポジトリのルートで `python scripts/install_claude_skills.py install` を実行する
2. `python scripts/install_claude_skills.py check` が 3 スキルと CLI を最新と表示し、exit 0 になること
3. mycmux 内で Claude Code を起動し、スキルの一覧・状態取得を確認する。Web ペインは各自でログインする
4. oracmux の送信禁止フォルダが必要なら guard.example.json を基に設定する
5. 個人用の委譲ルールは任意で整備する。既存の rules や Codex の AGENTS.md は installer の変更対象にしない
6. openai-codex プラグイン (`claude plugin list` で `codex@openai-codex`) が**入っていない**こと
   — 入っていると `codex:codex-rescue` が自己推薦して裏バックグラウンドジョブが復活する
