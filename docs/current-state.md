# mycmux Current State

This file is the handoff note for future Codex / Claude sessions.

## Source of Truth

mycmux は git worktree で **master (個人版)** と **release/public-lite (チーム配布版 lite)** の 2 系統を並行運用している。個人版の source は private repo (`miyafcos/mycmux`)、lite の配布 source は public repo (`miyafcos/mycmux-team`) で管理する。同一 Windows 上で並行起動可能 (Bundle ID / config dir / localStorage key / インストールパス完全分離)。

| 系統 | worktree | 実行 exe | runtime data | 配布物 repo |
|------|----------|----------|--------------|-------------|
| 個人版 (master) | `C:\Users\miyaz\cmux-for-linux-dev-master\` | `C:\Users\miyaz\mycmux-app\mycmux.exe` | `C:\Users\miyaz\AppData\Roaming\com.miyazaki.mycmux` + `C:\Users\miyaz\.mycmux` | source: `miyafcos/mycmux` (private), updater: `miyafcos/mycmux-team` fixed feed |
| lite (release/public-lite) | `C:\Users\miyaz\cmux-for-linux-dev\` | `C:\Users\miyaz\mycmux-lite-app\mycmux-lite.exe` | `C:\Users\miyaz\AppData\Roaming\com.miyazaki.mycmux-lite` + `C:\Users\miyaz\.mycmux-lite` | `miyafcos/mycmux-team` (public) |

Upstream: `cai0baa/cmux-for-linux` (定期 cherry-pick の参照元)。

## Current Version

- master 最新 **v0.14.17** (2026-07-15 リリース)。lite 最新 **v0.11.0-lite.1** (2026-07-10)
- `package.json` / `package-lock.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock` / `src-tauri/tauri.conf.json` の `version` を一致させること
- リリース手順: version bump + CHANGELOG → `chore: release vX.Y.Z` コミット → タグ push → GitHub Actions (Release workflow) がビルド → `scripts/mirror-personal-updater-feed.ps1 -SourceTag vX.Y.Z` をローカル実行して updater feed を更新 (CI の mirror ステップは secret 未設定でスキップされる)

## Recent Included Work

### v0.11〜v0.14.17 の主なもの (新しい順)

- **v0.14.17 エージェント発のペイン立ち上げ**: ソケットコマンド `pane.spawn` / `pane.send_text` / `pane.read` と CLI `scripts/mycmux_agent_cli.py` を追加。ペイン内のエージェントが可視の新ペインで別エージェントを起動できる。ディスパッチは `src/components/layout/socketCommands.ts` に分離。`MYCMUX_LAUNCH_TARGET` を ephemeral env ガード3層 (lib.rs / SocketListener / 契約テスト) に追加
- **v0.14.14〜16 セーブポイントのローカル受け渡し**: 共有フォルダを廃し、`.mycmux-transfer` ファイル1件単位の受け渡しに変更。設定はタブ型ダイアログに刷新 (SettingsMenu / ThemeSwitcher 撤去)
- **v0.13.x 系**: セーブポイント GUI、パネル視覚刷新、usage 監視の 429 UX、しおり出没・dormant 消失などの実機修正 (v0.13.4)
- **v0.11〜0.12**: 品質集中パック (安定性・復元まわり)、resume 導線改善 (`Ctrl+Shift+T` / palette resume / launcher ピッカー)

### v0.4.0
- **CRSM Palette (`Ctrl+P`) 大幅刷新**: 1200px 2 カラム、cwd chip、agent kind 色分け、詳細サブパネル、started_at 表示
- **env 汚染対策 (重大トラップ修正)**: 起動時に `MYCMUX_*` / `__CMUX_LAUNCHER_DONE` を `std::env::remove_var()` で全削除。**自動 resume 廃止** (data.json に `agent_session_id` / `agent_kind` / `claude_session_id` を保存しない) → CRSM Palette 経由の手動 resume に統一 (→ v0.5.6 `77f576d` で多層安全弁とセットに再導入。現行 v0.10.1 でも resume-on-restart は正式機能として有効)
- **Windows コンソール窓フラッシュ抑制**: CRSM CLI 呼び出し / git branch detection / file system ops に `CREATE_NO_WINDOW` を付与

### v0.3.x までの主な変更
- Renderer/CPU 最適化 (hidden workspace の pane mount 抑制、`XTermWrapper` lifecycle 整理)
- In-app updater (Settings → 更新を確認 → GitHub Releases `latest.json` から自動更新)
- 個人版 updater: `https://github.com/miyafcos/mycmux-team/releases/download/mycmux-personal-updater/latest.json`
- lite updater: `https://github.com/miyafcos/mycmux-team/releases/latest/download/latest.json`
- Release flow 分離 (personal / lite で別 script・tag・updater key・Actions job)
- Remote Terminal dashboard (WebSocket、iPhone / ブラウザから既存セッション監視)
- `Shift+Enter` の Kitty 互換修正
- 新テーマ: Berry Cream, Ocean Mist, Matcha Latte

## Build and Deploy

> **Smart App Control 制約**: ビルドは必ず各 worktree ディレクトリ内で実行する。別ディレクトリだとブロックされる。

### 個人版 (master worktree)

```powershell
cd C:\Users\miyaz\cmux-for-linux-dev-master
powershell -ExecutionPolicy Bypass -File build-personal.ps1
```

### lite (release/public-lite worktree)

```powershell
cd C:\Users\miyaz\cmux-for-linux-dev
powershell -ExecutionPolicy Bypass -File build-lite.ps1
```

deprecated: `deploy-update.ps1` / `build-and-update.ps1` (旧フローの残骸、撤去予定)。

詳細なリリース手順は [`docs/DEPLOY.md`](./DEPLOY.md) を参照。

## Naming Policy

- Public name: `mycmux` (個人版) / `mycmux-lite` (チーム版)
- 旧名 `ptrterminal` / `ptrcode` が古い docs / 古いビルド成果物 / マイグレーションコードに残っている可能性あり (撤去対象)

## High-Change Areas

- `src-tauri/src/remote/**` (master と lite で設計乖離あり、互換化が中期 TODO)
- `src-tauri/src/commands/crsm.rs` (CRSM Palette バックエンド)
- `src-tauri/src/commands/terminal.rs` (env merge — `MYCMUX_*` リーク経路の見直し対象)
- `src-tauri/src/db/storage.rs` (`launch_env` の保存層)
- `src-tauri/src/pty/session.rs` / `monitor.rs`
- `src/components/CommandPalette/CrsmPalette.tsx`
- `src/components/terminal/XTermWrapper.tsx`
- `src/components/theme/themeDefinitions.ts`
- `src/components/layout/socketCommands.ts` / `SocketListener.tsx` (ソケットコマンドと ephemeral env 永続化フィルタ — 契約テスト `tests/test_ephemeral_env_keys_contract.py` と3点同期)

## Verification Baseline

- Frontend: `cmd /c npm run build`
- Rust: `cargo check --manifest-path src-tauri/Cargo.toml`
- Tests: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- Lint: `cargo clippy --manifest-path src-tauri/Cargo.toml --release -- -D warnings`
- env 隔離 (実機): 新規ペインで `Get-ChildItem env: | Where-Object Name -like 'MYCMUX*'` が空であること

## Cherry-pick Notes (master → lite)

master 側の `lib.rs` を変更するコミットを lite に cherry-pick すると、`remote::RemoteControl` 型 / 4 引数 `start_remote_server` / `get_remote_info` / `rotate_remote_token` の差分で `cargo check` が落ちる。lite の remote module は独自設計 (RemoteState + 3 引数版) のため、cherry-pick 後に手動 adapt が必要 (`de8ed98 fix(lite): adapt v0.4.0 cherry-pick for lite remote module` 参照)。

中期的には lite の remote を master 互換に作り直して負債を解消する方針。

## Recommended Prompt for the Next Session

> mycmux の master / lite 2 worktree 体制を理解した上で開発を続けてください。`docs/current-state.md` を最初に読み、未コミット変更を `git status` で確認してから着手してください。両 worktree の現在実行ファイルが最新の正です。env 汚染対策の `std::env::remove_var()` を消したり、`launch_env` から `MYCMUX_*` を素通りさせたりしないでください (再発すると agent モード暴発)。
