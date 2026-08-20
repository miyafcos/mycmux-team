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

```
python scripts/mycmux_agent_cli.py spawn --target <claude|codex> --prompt-file <spec.md>
```

- 同ペインに新しいタブを開き、純正の対話 TUI (Claude Code / Codex) を起動して spec を流し込む
  (内部 RPC: `pane.spawn_tab`。`--split` 指定時のみ `pane.spawn`)
- effort やモデル指定は CLI フラグでは渡らない — **spec 本文に日本語で明記**する
- 割り込みは send_text → 数秒後に素の Enter 後追い (ペースト扱いで Enter が飲まれるため)

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
5. **表示**: `agentDisplayKind.ts` / `agentKindColors.ts` / `AgentIcons.tsx` / `PaneTabBar.tsx`
6. **Rust**: `pty/monitor/detection.rs` の `DetectedAgentKind`、`pty/monitor/runner.rs` の
   match アーム (**非網羅だとコンパイルエラー**)、`commands/session_mapping.rs` の allowlist、
   `commands/terminal.rs` の resume 可否、`commands/terminal/agent_restore.rs` の存在確認
7. **契約テスト**: `tests/perf/test_week1_day1_behavior_contracts.py` が launcher のメニュー配列と
   数字キー割当を**行文字列レベルで固定**している。`tests/unit/agentDisplayKind.test.ts` は
   `COMMAND_DISPLAY_KINDS` を `toEqual` で丸ごと固定。`tests/test_no_agent_kind_in_stall_path.py` の
   `FORBIDDEN` にも名前を足す (停滞判定はエージェント非依存が契約なので、`promptShape.ts` /
   `stallVerdict.ts` にはエージェント名を書かない)
8. **アカウント/使用量**: `CliProvider` / `cli_accounts/` / `usage/` / `PROVIDER_ORDER` を同時に追加し、
   登録・切替・使用量とログイン staging の全経路を確認する

### 完了検知の規約

spawn したタブの完了・生存は画面でなく**実体を3層でポーリング**する (2026-07-16 確立):

1. **DONE マーカーファイル** (spec で出力先を指定・末尾行判定は CRLF 耐性をつける) — 正常完了
2. **自セッションの rollout ログ増分** (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) —
   質問待ち・ハング・クラッシュはすべて「増分停止」として現れ、文言に依存せず検出できる。
   **自セッションの特定は cwd で行う** (ログ冒頭数行に作業ディレクトリが記録される)。
   spec マーカー文字列での特定はロールオーバーで破綻し、「最新ファイル」は並行セッションと混線する (実測)
3. **repo の編集ファイル mtime** (`git status --porcelain` 対象の stat)

増分が数分止まったらログ末尾の agent_message を読む — 質問待ちなら send_text で回答し、
素の Enter を数秒後に後追い送信する。以下は使わない:
- `pane.read` (v0.18.0 以降の裏起動タブはレンダラ非生成で常に空)
- サブエージェントの自己申告 (「保存しました」) を成果と見なさない

## 配布物: session-dispatch スキル (Claude Code 用)

本契約を Claude Code 側で実運用するスキルの移植版を `examples/claude-skills/session-dispatch/`
に同梱している (spec 生成 → 裏タブ spawn → 台帳 → 自動検収 → 自動 close)。
別環境へ展開するときは同フォルダの README.md に従って `~/.claude/skills/` へコピーする。

## 各エージェント側のルールの所在 (このマシン)

| エージェント | ルールファイル | 該当節 |
| --- | --- | --- |
| Claude Code | `~/.claude/rules/delegation.md` | 「呼び出し経路 (2026-07-16 可視化一本化)」— 常時ロード |
| Claude Code (手順詳細) | `~/.claude/references/delegation-playbook.md` / `~/.claude/skills/codex-helper/` | spec テンプレと spawn 手順 |
| Codex | `~/.codex/AGENTS.md` | 「mycmux 統合」節 |
| 経緯・正本 | memory `reference_gpt56_codex_lineup.md` / `feedback_codex_delegation_visible_interactive.md` | 呼び出し経路の正本・2026-07-15 FB |

## 新しい環境に展開するときのチェックリスト

1. この repo の `scripts/mycmux_agent_cli.py` が動くこと (`spawn --target claude` で素振り)
2. `~/.claude/rules/delegation.md` に「呼び出し経路」節があること (なければ本書の方針を書き写す)
3. `~/.codex/AGENTS.md` に「mycmux 統合」節があること
4. openai-codex プラグイン (`claude plugin list` で `codex@openai-codex`) が**入っていない**こと
   — 入っていると `codex:codex-rescue` が自己推薦して裏バックグラウンドジョブが復活する
