# session-dispatch — mycmux 用セッション分散スキル (Claude Code)

母艦の Claude Code セッションで受けた重い依頼を、mycmux の新しいタブに立てた
新鮮な Claude セッションへ振り分けるスキルです。spec 生成 → spawn → 台帳記録 →
自動検収 → タブ自動 close までを回します。

コンテキストが長くなったセッションは品質が落ち、コストも増えます (コストは文脈長の
O(N²))。独立した重作業を小さな spec で新セッションに切り出すことで、要約劣化のない
品質と並列スループットを両立するのが目的です。

## 前提

- mycmux が起動していること (このスキルは `MYCMUX_TERM_PROGRAM=mycmux` の
  セッション内でのみ動作します)
- Claude Code (スキル機能が使えるバージョン)
- Python 3.10+
- この mycmux リポジトリ一式 (`scripts/mycmux_agent_cli.py` を使います)

## セットアップ

1. このフォルダを Claude Code のスキルディレクトリへコピーします:

   ```
   cp -r examples/claude-skills/session-dispatch ~/.claude/skills/session-dispatch
   ```

2. 環境変数 `MYCMUX_AGENT_CLI` に `scripts/mycmux_agent_cli.py` のフルパスを
   設定します (watcher がタブを自動 close するときに使います):

   ```
   # 例 (PowerShell プロファイルや .bashrc に)
   $env:MYCMUX_AGENT_CLI = "C:/path/to/mycmux/scripts/mycmux_agent_cli.py"
   ```

3. mycmux 内で Claude Code を開き、「新タブでやって」「分散して」などと頼むと
   スキルが発火します。

## 構成

| ファイル | 役割 |
| --- | --- |
| `SKILL.md` | 入口。振り分け判定・表示形態・手順 |
| `references/spec-template.md` | 子セッションへ渡す spec の雛形 |
| `references/dispatch-guide.md` | 台帳スキーマ・完了検知・検収・片付けの詳細 |
| `references/decompose-guide.md` | 一括依頼を並列単位へ分割する設計指針 |
| `scripts/dispatch_status.py` | 台帳と実体 (DONE.md / セッションログ) の突合表示 |
| `scripts/dispatch_watch.py` | 1 dispatch を監視し、機械検収 PASS でタブを自動 close |

## 表示形態のポリシー

子セッションは既定で**裏タブ** (親のフォーカスを奪わず、同一ペインのタブバーの
後ろに開く) で立ちます。画面に見える横ペイン (`--split`) にするのは、ユーザーが
明示的に指定したか、スキルが確認して承認を得たときだけです。`--activate`
(フォーカスを奪う) は使いません。

## 子セッションとの対話 — ASK.md 方式

子は走行中にブロッキング判断が必要になったら `<dispatch-dir>/ASK.md` を書いて
待機します (書式は `references/spec-template.md` 参照)。母艦は
`dispatch_status.py` の表示 (`ASK(判断待ち)`) で気づき、内容を読んで
`mycmux_agent_cli.py send` で回答を届けます。

## ライセンス

リポジトリ本体と同じ GPL-3.0 です。
