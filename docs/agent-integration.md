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

### Antigravity (agy) の可視 spawn (2026-07-16 追加)

Gemini CLI は 2026-06-18 に個人アカウント向け終了 (実測: `IneligibleTierError`)。後継は
`agy` (Antigravity CLI)。`spawn --target` は claude/codex 系のみなので、agy は
**spawn-tab の任意コマンド argv 経路**で可視タブを立てる:

```
python scripts/mycmux_agent_cli.py spawn-tab --label agy -- agy -i "C:/path/spec.md を読んで実行して"
```

- `-i` = 初期プロンプトつき対話モード (委譲の既定)。`-p` はヘッドレス単発 (許可場面は上記3つと同じ)
- 長い spec は argv に直接埋めず、spec ファイルを書いて「読んで実行」と渡す (quoting 事故防止)
- launcher メニューにも「Antigravity (agy)」あり (手動起動用・v0.150 系以降のビルドに同梱)

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
