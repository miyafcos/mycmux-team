# mycmux — リポジトリ内エージェント向け指示

Tauri v2 (Rust) + React 19 + xterm.js のターミナルワークスペースアプリ (ptrcode fork, GPL-3.0)。
このディレクトリ (`~/cmux-for-linux-dev-master`, branch=master) が**本番ソース**。
公開ミラー = `miyafcos/mycmux-team` の `master` (履歴を持ち込まない sync コミット方式)。
旧 lite 版 (worktree `~/cmux-for-linux-dev`, branch=release/public-lite) は 2026-07-23 に配布終了 — 追従不要。

## 構成

- フロント: `src/` (React + TypeScript + Zustand)
- バックエンド: `src-tauri/src/` (Rust + Tauri v2)、PTY 管理は `src-tauri/src/pty/`
- 設定保存: `%APPDATA%/com.miyazaki.mycmux/data.json` / ソケット: `~/.mycmux/mycmux.port`
- 稼働中 exe: `~/mycmux-app/mycmux.exe` (updater 対象外・deploy スクリプトで差し替え)
- ランチャー: `~/.mycmux/bin/launcher.sh` (新規ペインの起動メニュー。`~/bin/launcher.sh` は旧世代)
- エージェント委譲規約: `docs/agent-integration.md` — mycmux 内の Codex/Claude 委譲は `scripts/mycmux_agent_cli.py spawn` で可視タブを立てるのが正 (各エージェント側ルールの所在もここに記載)

## 検証コマンド (変更後は必ず全部)

```
npx tsc --noEmit
npx vitest run
cd src-tauri && cargo test --release
python -m pytest tests/   # sync-command allowlist 契約テスト含む
```

- **`STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)` は再発する。直し方は manifest 埋め込み (2026-07-31 更新)**:
  `cargo test --release` の lib テストハーネス (`mycmux_lib-*.exe`) が起動前に落ちる現象。7/30 に発生し
  CI release.yml の test ジョブも落ちた (v0.21.1 は tag のみ・GH Release 無し・deploy はローカル直配)。
  OS 再起動で一度消えたが、**`npm run tauri build` 後の新しいリンク結果で再発した** (7/31 実測)。
  → 一過性のローダ状態ではなく**リンクされた test exe 側の問題**。原因は Common Controls v6 manifest 欠落
  (`TaskDialogIndirect` を import するが v5.82 に該当 entrypoint が無い)。
  **復旧手順 (数秒・OS 再起動は不要)**: Common Controls v6 依存だけを書いた manifest を用意し
  `"C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\mt.exe" -manifest <manifest> -outputresource:"<test exe>;#1"`
  を**生成された test exe にだけ**適用してから `cargo test --release` を再実行する (244 passed を確認済み)。
  製品 exe・installed exe には適用しない。`npm run tauri build` で再リンクされるたびに再適用が要る。

## ビルド・デプロイの絶対ルール

- **`cargo build` 単体は壊れた exe を作る** (frontend 未バンドル・19MB)。必ず `npm run tauri build` (正常時 32〜42MB)
- **build-personal.ps1 は clean tree 必須** (`git status --porcelain` 非空で abort・branch=master 必須)。CLAUDE.md 含め untracked を放置しない
- ビルドは必ずこの worktree 内で実行 (別ディレクトリだと Smart App Control がブロック)
- deploy の正 = `~/mycmux-app/deploy-update.ps1` (-RunningPid/-ExpectedSha/-ExpectedVersion/-LogPath/-ResultPath 必須。SHA照合+自動ロールバック+再起動確認内蔵)。旧名 `~/deploy-mycmux-v2.ps1` は実体なし (2026-07-30 確認)。mycmux 内から実行すると自プロセス kill で途中死 → **WMI デタッチで起動する**: 引数焼き込みランナー ps1 を書いて `Invoke-CimMethod Win32_Process Create` (schtasks は Claude auto mode でブロックされる・2026-07-30 v0.21.1 で実証済みの手順)。結果検証は deploy-vX-*.json の status/sha/new_pid
- `pytest-cache-files-*/` の Permission denied 警告は既知・無害。`pty/session.rs` 等の autocrlf ノイズ (` M` で実差分0) は `git checkout --` で解消

## Git 運用

- **push は既定 ON — ブランチもタグも** (2026-07-12 宮崎さん指示): master へのコミット後はそのまま `git push origin master` まで実施。リリースすべき変更がまとまったらタグも Claude 判断で打って push してよい (検証コマンド全通過が前提)。すべて事後報告。GitHub が常に最新になる設計が基本
- 複数タグは1個ずつ push (multi-tag push は workflow trigger 漏れあり)
- タグ push 後の updater feed: CI の mirror ステップは secret 未設定で**成功表示のままスキップされる**。`scripts/mirror-personal-updater-feed.ps1 -SourceTag vX.Y.Z` をローカル実行し latest.json の version を確認
- **リリース後は公開ミラーも更新**: `git commit-tree "master^{tree}" -p <team masterのHEAD> -m "sync: ..."` で履歴を持ち込まない sync コミットを作り `git push public <sha>:refs/heads/master`。ブランチをそのまま public へ push するのは禁止 (private 履歴が漏れる)

## Codex 委譲時の注意

- `--sandbox` を明示指定しない (Windows でコマンドライン長超過 os error 206。config.toml 既定に任せる)
- Codex は `cargo fmt` をワークスペース全体に流すことがある。コミット前に `git diff --numstat` で無関係ファイルの純整形混入を検出し `git checkout --` で revert
- rescue agent の完了自己申告を信じない。ファイル mtime / ツリー安定 / cargo+tsc で実体検証

## 設計上の地雷

- **portable_pty は親 env を inherit する**。`MYCMUX_*` 系 env の扱いを変える時は `lib.rs` の `remove_var` と `terminal.rs::sanitize_launch_env` の多層防御を壊さないこと (v0.4.0 の全ペイン自動 resume 事故の再発防止)
- data.json への `agent_session_id` / `agent_kind` / `claude_session_id` 保存は v0.5.6 で多層安全弁とセットに再導入済み (保存自体は現行仕様)。ただし安全弁 (`sanitize_launch_env` / `EPHEMERAL_LAUNCH_ENV_KEYS` / `lib.rs` の `remove_var` / `dedupeAgentSessionsInConfigs` / `tests/test_ephemeral_env_keys_contract.py`) を壊す・迂回する変更は禁止
- sync `#[tauri::command]` を増やす変更は `tests/test_command_sync_contract.py` の allowlist と整合させる

## 詳細情報

- 過去の計画・レビュー: `docs/plans/` (現行の正 = `2026-07-03-stability-refactor-plan-v2.md`)
- 横断的な開発履歴・教訓の全量はホームセッションの memory `project_mycmux.md` にある (このファイルはその蒸留)
