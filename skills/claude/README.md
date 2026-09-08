# mycmux を使うならこの 3 本

**session-dispatch** は、指示書を作り、可視タブへの委譲と完了条件の確認を扱います。「別タブに任せて」「作業を委譲して」が発火語です。mycmux 内の Claude Code が前提で、送信機能には mycmux-bridge も必要です。

**mycmux-bridge** は、タブ一覧・画面・状態を読み、宛先と入力状態を確認してメッセージや質問回答を渡します。「タブの状態を見て」「セッションに伝えて」が発火語です。起動中の mycmux と対象の PTY session ID が前提です。

**oracmux** は、引き継ぎ文書を作り、Web ペインで相談し、回答を回収します。「oracmux で相談して」「Web ペインで聞いて」が発火語です。mycmux と Web サービスへのログインが前提です。既定の pane 経路は標準ライブラリで動きます。別経路の oracle / cdp は追加の外部ツールが必要です。

## 導入

mycmux の「設定 → AI → Claude Code スキル → 導入」からも、3 スキルと agent CLI を導入できます (git・ZIP 不要)。アプリ更新後は同じカードの「更新」で更新でき、ローカル改変がある場合は「退避して置き換える」で旧フォルダを退避してから置き換えます。

Claude Code、Python 3.10 以上を用意し、リポジトリのルートで次の 3 コマンドを実行します。

```text
python --version
python scripts/install_claude_skills.py install
python scripts/install_claude_skills.py check
```

スキルは mycmux の中で使います。Web ペインのログインは各自で行ってください。
導入・同期ツールは Python 標準ライブラリのみです。
導入先はホーム下の `~/.claude/skills/` と `~/.mycmux/bin/mycmux_agent_cli.py` です。
Windows のホームは Python が認識する `%USERPROFILE%`、POSIX では `~` です。

更新も `install` を再実行します。同じ内容なら書き換えません。
導入マーカーがない既存フォルダや、導入後の変更を検出すると停止します。
確認後に `--force` を付けると、旧フォルダを隣の日時付き `.bak-*` に退避して置き換えます。
`--skills mycmux-bridge,oracmux` で選択導入、`--home <dir>` でテスト用ホームを指定できます。

`check` は未導入 (`not-installed`)、最新 (`latest`)、古い (`outdated`)、ローカル改変 (`locally-modified`) を表に表示します。すべて最新なら exit 0、それ以外は exit 1 です。

## CLI と設定

3 スキル共通の CLI 解決順は次のとおりです。存在するファイルを採用します。

1. `MYCMUX_AGENT_CLI` 環境変数
2. `~/.mycmux/bin/mycmux_agent_cli.py`
3. スクリプト自身がリポジトリ内にある場合の `scripts/mycmux_agent_cli.py`

見つからなければ導入コマンドを表示して exit 7 です。
スキル文中の `<resolved-mycmux-agent-cli>` はこの順で解決した絶対パスです。
`~` を含む例も実行前にホームの絶対パスへ展開します。Windows で Python に渡す引数の `~` は自動展開されません。

oracmux は `scripts/guard.json` がなければ `scripts/guard.example.json` を読みます。
固有の送信禁止フォルダは、example を guard.json にコピーして `deny_roots` に設定します。
`ORACMUX_GUARD` で明示したファイルが欠けている場合は停止します。
guard.json の追加もローカル改変として検出されるため、更新時は設定を確認してバックアップから戻してください。

個人用ルールは任意です。`~/.claude/rules/delegation.md` などは配布・上書きしません。
スキル本文が参照する個人用の台帳・通知ツールは同梱していません。必要な手順は自分の環境で用意してください。

## 見張り (dispatch_guard) の有効化

session-dispatch には、立てた子タブや手動タブが「起動ダイアログ・入力欄に残った本文・質問・承認・ログイン」で黙って止まるのを検出し、回復か通報を行う常駐スクリプト `scripts/dispatch_guard.py` が同梱されています。mycmux のランチャーが agent TUI を起動するたびに `ensure` を呼ぶので、導入後は自動で常駐します (`MYCMUX_DISPATCH_GUARD=off` で止められます)。

あわせて Claude Code 側に次の 2 点を入れると、起動ダイアログと子セッションの質問が構造的に起きなくなります。

1. `~/.claude/settings.json` に `"enableAllProjectMcpServers": true` と `"skipAutoPermissionPrompt": true`
2. 同ファイルの `hooks.PreToolUse` に次を追加 (子セッションだけ AskUserQuestion / plan モードを拒否します)

```json
{"matcher": "AskUserQuestion|EnterPlanMode|ExitPlanMode",
 "hooks": [{"type": "command", "timeout": 5,
            "command": "python -X utf8 ~/.claude/skills/session-dispatch/scripts/dispatch-child-guard.py"}]}
```

状態は `python -X utf8 ~/.claude/skills/session-dispatch/scripts/dispatch_guard.py doctor`、実機試験は同フォルダの `dispatch_canary.py --scenario startup,askuser,draft` です。通報は判断カードと Windows トーストで、カードの投入先 (`~/.claude/ops/ops_common.py`) は個人環境のツールなので同梱していません。無い環境では記録 (`~/.claude/dispatch/guard/escalations.jsonl`) だけが残ります。

## 配布コピーの同期

```text
python scripts/sync_claude_skills.py --from-live --write-manifest
python scripts/sync_claude_skills.py --check
```

live の個人パス・CLI 解決・guard 設定を配布用に変換してから比較します。
同期先に余分なファイルがあれば停止して差分を確認します。自動削除はしません。
manifest は各スキル全ファイルとリポジトリ CLI の SHA-256 を記録します。
テキスト拡張子 (.py .md .json .txt .yaml .yml .sh .ps1 .toml .cfg .ini) は LF 正規化後のバイトで照合し、それ以外は元のバイトで照合します。
導入時はテキストを LF で書き出します。エディタによる改行だけの変更はローカル改変とせず、install の再実行で LF に戻します。
キャッシュ、バックアップ、導入マーカーは同期対象外です。live がない環境では理由付きで skip します。

`--to-live` は保守者だけが使う逆方向のコピーです。既存の guard.json を保持します。
通常は `install` を使います。テスト時は `PYTHONDONTWRITEBYTECODE=1` と
`PYTEST_ADDOPTS=-p no:cacheprovider` を設定して、パックにキャッシュを作らないでください。
