# Changelog (mycmux-lite)

## [0.3.3-lite.1] - 2026-04-24

### Fixed

- Detected Codex approval prompts in cached/background panes without reintroducing the high-frequency `runScan()` loop.
- Completed the Settings updater UI with current-version display, explicit update-available status, and console logging for update failures.
- Kept the app/package version numeric as `0.3.3` for Windows MSI compatibility; the public release tag is `v0.3.3-lite.1`.

---

## [0.3.2-lite.1] - 2026-04-24

### Fixed

- Bounded the PTY-to-frontend IPC path so stalled WebView rendering cannot grow the Tauri Channel queue without limit.
- Removed the hardcoded local MSVC linker path so GitHub-hosted Windows runners use the runner-provided `link.exe`.
- Enabled updater artifact generation in GitHub Actions so public lite releases include `latest.json` and signed installer metadata.
- Kept the app/package version numeric as `0.3.2` for Windows MSI compatibility; the public release tag remains `v0.3.2-lite.1`.

---

All notable changes to the **team-distribution** (`release/public-lite` → `mycmux-team`) build of mycmux-lite. The upstream personal `master` build of mycmux has its own changelog at `miyafcos/mycmux:CHANGELOG.md`.

---

## [0.3.0-lite.1] — 2026-04-23

### Performance

- **Stop hidden workspaces/tabs from running in background.** Cherry-picked from upstream personal v0.3.0. Previously every workspace and tab kept its xterm instance alive with `runScan()` firing every 150 ms; renderer + GPU process were burning ~3 hours of CPU per ~9 hours of use. Now the workspace mount set is an LRU capped at 3, panes render only the active tab, `XTermWrapper` disposes its `onWriteParsed` / `onPtyExit` listeners on cache and re-registers them on reattach, and `runScan` is gated by `isActivePane`.

### Features

- **In-app auto-update** via `tauri-plugin-updater` v2. Settings → 更新を確認 で `latest.json` を確認 → 署名検証 → ダウンロード → 自動再起動。lite 用署名鍵は個人版と分離。endpoint = `https://github.com/miyafcos/mycmux-team/releases/latest/download/latest.json`。

### Build / release

- **`build-lite.ps1`** が個人版用 `build-personal.ps1` と分離。ブランチ確認 + working tree clean 確認 + MSVC 環境読込 + ビルド + タイムスタンプ付きバックアップ + 配置 + 配布アセット集約を1コマンドで。
- **GitHub Actions `release.yml`** が tag 名で `build-lite` ジョブを起動 (`v*-lite.*`)。`TAURI_KEY_LITE` secret で署名。
- **タグ命名**: lite は `vX.Y.Z-lite.N` (例 `v0.3.0-lite.1`, `v0.3.0-lite.2`)。

### Notes

- 安全タグ `pre-cpu-fix-lite-2026-04-23` を用意。問題発生時は `git reset --hard pre-cpu-fix-lite-2026-04-23` で戻れる。
- 詳細プラン: `.claude/plans/1e57cfe-initial-witty-marble.md`、観測ベースライン: `.claude/plans/mycmux-cpu-investigation-baseline.md`。

---

## [0.2.0] — 2026-04-22

Initial team-distribution build, derived from mycmux personal v0.2.0.

### Removed (vs. mycmux personal)

- File Explorer Sidebar (`FileExplorerSidebar.tsx`, `PathJumper.tsx`, `fileExplorerStore.ts`) — 1449+728+447 行
- Buddy / Persona / Codex bridge / sensor tails / session_log
- fs watcher (Rust `notify`, `ignore`, `tempfile` クレート)
- `tauri-plugin-dialog` (file dialog 不要)
- 古い build/package スクリプト (`build-and-update.ps1`, `deploy-update.ps1`, `package-source.ps1`)
- `docs/` ディレクトリ (個人版の設計メモ)

### Brand split

- 製品名: `mycmux-lite`
- Bundle ID: `com.miyazaki.mycmux-lite`
- config dir: `~/.mycmux-lite/`
- localStorage key: `mycmux-lite-settings`
- 個人版 (`mycmux`) と同一マシンで並行起動可能。
