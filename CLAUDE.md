# mycmux — リポジトリ内エージェント向け指示

Tauri v2 (Rust) + React 19 + xterm.js のターミナルワークスペースアプリ (ptrcode fork, GPL-3.0)。
このディレクトリ (`~/cmux-for-linux-dev-master`, branch=master) が**本番ソース**。
公開ミラー = `miyafcos/mycmux-team` の `master` (履歴を持ち込まない sync コミット方式)。
旧 lite 版 (worktree `~/cmux-for-linux-dev`, branch=release/public-lite) は 2026-07-23 に配布終了 — 追従不要。

## 構成

- フロント: `src/` (React + TypeScript + Zustand)
- バックエンド: `src-tauri/src/` (Rust + Tauri v2)、PTY 管理は `src-tauri/src/pty/`
- 設定保存: `%APPDATA%/com.miyazaki.mycmux/data.json` / ソケット: `~/.mycmux/mycmux.port` (+ 認証トークン `~/.mycmux/mycmux.token` — 全リクエストに `"token"` 必須。逃げ道 `MYCMUX_SOCKET_AUTH=off`)
- 稼働中 exe: `~/mycmux-app/mycmux.exe` (updater 対象外・deploy スクリプトで差し替え)
- ランチャー: `~/.mycmux/bin/launcher.sh` (新規ペインの起動メニュー。`~/bin/launcher.sh` は旧世代)
- エージェント委譲規約: `docs/agent-integration.md` — mycmux 内の Codex/Claude/Grok 委譲は `scripts/mycmux_agent_cli.py spawn` で可視タブを立てるのが正 (各エージェント側ルールの所在・新エージェント登録チェックリストもここに記載)
- 対応エージェント種別は `claude` / `codex` / `claude-codex` / `grok` の4種。文字列リテラルが型・ランチャー・検出・契約テストに散っているので、追加時は上記チェックリストを通す

## 検証コマンド (変更後は必ず全部)

```
npx tsc --noEmit
npx vitest run
python scripts/run_windows_tests.py   # Rust テスト (素の cargo test は使わない・下記)
python -m pytest tests/               # sync-command allowlist 契約テスト含む
```

- **Rust テストは `cargo test --release` を直接叩かない。`scripts/run_windows_tests.py` を使う (2026-08-05 恒久化)**:
  素の `cargo test --release` は lib テストハーネス (`mycmux_lib-*.exe`) が起動する前に
  `STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)` で落ちる。原因は test harness に Common Controls v6
  manifest が無いこと (依存クレートが `TaskDialogIndirect` を import するが v5.82 に該当 entrypoint が無い)。
  製品 exe は tauri-build が manifest を埋めるので無関係。
  スクリプトは `--no-run` でビルド → `src-tauri/tests.manifest` を mt.exe で埋め込み → **cargo を介さず
  直接実行**する (`profile.test` で絞るので `examples/oauth_probe` のような対話バイナリは走らせない)。
  CI の release.yml も同じスクリプトを呼ぶ。
  - **mt.exe を手で当てて `cargo test` を再実行する旧手順は無効**。cargo が再リンクして manifest を
    剥がすため、2026-08-05 に実測で 2 回とも失敗した
  - リンカに `/MANIFEST:EMBED` を渡す案 (build.rs の `rustc-link-arg`) も不可。`rustc-link-arg-tests` は
    stable Cargo が受け付けず、全ターゲットに渡すと **LNK1123 (COFF 変換失敗)** を踏むうえ製品 exe の
    リンクにも影響する
  - 履歴: 7/30 に初発 (v0.21.1 は tag のみで GH Release 無し)、7/31 に再発、8/5 の v0.21.15 の CI でも
    再発してリリースが落ちた (v0.21.15 は欠番・v0.21.16 で再出荷)

## ビルド・デプロイの絶対ルール

- **`cargo build` 単体は壊れた exe を作る** (frontend 未バンドル・19MB)。必ず `npm run tauri build` (正常時 32〜42MB)
- **build-personal.ps1 は clean tree 必須** (`git status --porcelain` 非空で abort・branch=master 必須)。CLAUDE.md 含め untracked を放置しない
- ビルドは必ずこの worktree 内で実行 (別ディレクトリだと Smart App Control がブロック)
- deploy の正 = `~/mycmux-app/deploy-update.ps1` (-RunningPid/-ExpectedSha/-ExpectedVersion/-LogPath/-ResultPath 必須。SHA照合+自動ロールバック+再起動確認内蔵)。旧名 `~/deploy-mycmux-v2.ps1` は実体なし (2026-07-30 確認)。mycmux 内から実行すると自プロセス kill で途中死 → **WMI デタッチで起動する**: 引数焼き込みランナー ps1 を書いて `Invoke-CimMethod Win32_Process Create` (schtasks は Claude auto mode でブロックされる・2026-07-30 v0.21.1 で実証済みの手順)。結果検証は deploy-vX-*.json の status/sha/new_pid
- `pytest-cache-files-*/` の Permission denied 警告は既知・無害。`pty/session.rs` 等の autocrlf ノイズ (` M` で実差分0) は `git checkout --` で解消

## Git 運用

- **push は既定 ON — ブランチもタグも** (2026-07-12 宮崎さん指示): master へのコミット後はそのまま `git push origin master` まで実施。リリースすべき変更がまとまったらタグも Claude 判断で打って push してよい (検証コマンド全通過が前提)。すべて事後報告。GitHub が常に最新になる設計が基本
- 複数タグは1個ずつ push (multi-tag push は workflow trigger 漏れあり)
- **updater の署名鍵は `~/.tauri/mycmux-updater.key` が正 (key-id `bbf2382d7a0753cc` = tauri.conf.json の pubkey)**。
  パスワードは `~/.tauri/mycmux-updater.pass` に DPAPI で暗号化保存 (`ConvertTo-SecureString` で復号・平文ではない)。
  CI secret (`TAURI_KEY_PERSONAL` / `_PASSWORD`) は 2026-08-05 にこの鍵へ更新済み。
  - 経緯: 7/31 の鍵ローテートで `~/.tauri` と tauri.conf.json は新鍵に揃えたが **secret だけ旧鍵 (`edfd48df84ad2477`)
    のまま取り残されていた**。8/4 までのリリースは `release-local.ps1` のローカル署名だったため露見せず、
    8/5 に CI リリースした v0.21.16 が「更新に失敗」になって発覚 (欠番)
  - **`gh secret set` に PowerShell のパイプを使わない**。PS 5.1 が出力に BOM を付け、CI が
    `failed to decode base64 key: Invalid symbol 239, offset 0` で落ちる (8/5 に 2 回踏んだ。
    `$OutputEncoding` を BOM なしにしても再発)。**Bash から stdin で渡す**のが正:
    `printf '%s' "$(tr -d '\r\n' < ~/.tauri/mycmux-updater.key)" | gh secret set TAURI_KEY_PERSONAL --repo miyafcos/mycmux`
  - **リリース後の feed 検証は版数だけでは不十分**。latest.json の signature をデコードして key-id が
    tauri.conf.json の pubkey と一致することまで確認する (一致しないと更新ボタンが検証エラーで失敗する)
- **self-hosted runner の起動は `scripts/start-release-runner.ps1` を使う** (手動の env 剥がしをやめる)。
  BASH_FUNC_*/MYCMUX_*/CLAUDE* に加えて **FUGU_API_KEY 等の秘密系ユーザー env も剥がす** —
  剥がさないと runner が継承し、ビルド中の環境ダンプ経由で **CI ログに平文で残る**
  (run 30975163089 で実害。ログに出た鍵はローテーション推奨)。bash の Git 解決チェックも内蔵
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
- テーマ・トークン・タイポを触るときの契約 = `tests/unit/tokenContract.test.ts` (未定義 `var(--cmux-*)` 禁止) / `themeContrast.test.ts` (WCAG床+ANSIラチェット) / `uiDensity.test.ts` (standard=現行同値固定) / `uiQualityTokens.test.ts` (日本語9px禁止)。詳細は `docs/design/theme-system.md`
- **壁紙は同梱していない (オンデマンドDL)**。`src/assets/**` の59枚は配布パックの原本で、ビルドに入るのはサムネイル (`src/assets/wallpaper-thumbs/`) だけ。**原本を足す・差し替えるときは同じ操作で `scripts/wallpapers/make_thumbnails.py` → `build_manifest.py` → `publish_pack.ps1 -Execute` (公開は要承認) まで通す**。1つでも欠けると「ピッカーに出ない/押すと必ず失敗する/404」になる。契約 = `tests/test_wallpaper_pack_contract.py`。詳細は `docs/design/wallpaper-on-demand.md`
- **ailog の系列色は別系統** (テーマ変数を使わない固定色相・塗り専用)。契約 = `tests/unit/ailogPalette.test.ts` (会社=色相/ティア=明度・L安全帯[0.500,0.656]・色覚ΔE床・`price.rs` との parity)。詳細は `docs/design/ailog-series-colours.md`。**`price.rs` に会社やモデルを足すと parity が落ちる — テストを緩めず辞書側を更新する**

## 詳細情報

- 過去の計画・レビュー: `docs/plans/` (現行の正 = `2026-07-03-stability-refactor-plan-v2.md`)
- 横断的な開発履歴・教訓の全量はホームセッションの memory `project_mycmux.md` にある (このファイルはその蒸留)
