# RESTOREFIX 完了報告

対象: `C:\Users\miyaz\cmux-for-linux-dev-master`

## 実装

1. 無効な agent resume ID は保存済み ID と resume marker を除去し、全 agent kind を新規セッションで起動する。`agent-restore-downgraded` は新規開始を通知する。`--continue`、Codex の `resume --last`、別 ID の探索は復元失敗時に使わない。
2. scrollback と pane-session mapping の保存キーを tab ID にした。複合 `pty-<workspace>-<pane>-<tab>` の旧ファイルは、同じ tab ID の候補がちょうど1件で内容が正常な場合だけ、初回読込時に tab ID 名へ rename する。複数候補は fail-closed。起動 retention は現存 tab の旧形式ファイルを移行前に削除しない。
3. mapping 適用は tab ID の完全一致だけにした。pane mapping、active tab、先頭 tab の graft は撤去した。
4. suppressed agent session は復元候補へ渡さない。復元候補配線そのものを削除した。

## red-first と local commits

- `85f5f84 test(restore): cover session mixup regressions` — red fixture を先に固定。
- `000a86c fix(restore): start fresh when agent resume is invalid`
- `7ca2422 fix(restore): bind agent mappings to tab ids`
- `1cf6372 fix(restore): repair fresh-start compilation`
- `6f5b05e fix(restore): migrate persisted state to tab ids`
- `4522104 test(restore): align mapping contracts with tab ids`

push はしていない。mycmux の再起動・停止もしていない。

## 検証

- `npx tsc --noEmit` — exit 0。
- `npx vitest run --reporter=dot` — 205 files, 2841 tests passed。
- `python -m pytest tests/` — 355 passed。
- `python scripts/run_windows_tests.py` — release build 後、Rust 949 tests: 939 passed, 0 failed, 10 ignored。test binaries 2/2 passed。

Vitest の Canvas/React act 警告は既存テスト環境の stderr であり、exit 0 の結果を妨げていない。

## 自己レビュー

### Pass 1: 実装境界

`85f5f84^..4522104` の変更パスを照合した。restore/resume、mapping、scrollback、retention、対応 IPC、復元テスト、更新が必要な既存契約だけであることを確認した。`tabGrouping*` の差分は 0。`sanitize_launch_env`、環境キー除去、dedupe 安全弁、指定安全契約は変更していない。

### Pass 2: 作業ツリー境界

この報告の commit 後、RESTOREFIX 自身の未コミット差分が 0 であることを確認済み。残る dirty/untracked はこの作業の開始時からの別レーン、または作業中に他者が追加した別レーンのものとして保持し、stage/format/revert しない。

## 実機再起動チェックリスト（未実施）

作業指示の「mycmux を再起動しない」に従い、実機再起動は実行していない。ユーザー承認後の1回の管理された再起動で、次を確認する。

1. 存在しない Claude / Codex / Claude-Codex / Grok ID は警告表示後に新規セッションとなり、別会話を開かない。
2. workspace/pane を移動した tab の旧 `.bin` / `.txt` が、唯一候補なら tab ID ファイルへ移行され、複数候補なら採用されない。
3. pane の session metadata が tab A に付いた状態で tab B を active にしても、tab B や先頭 tab へ graft されない。
4. suppressed session を持つ tab を復元しても、その session を再開候補にしない。
