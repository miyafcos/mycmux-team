# Changelog (mycmux-lite)

## [0.5.1] - 2026-05-05

### Changed

- **Resume / CRSM Palette**: Ctrl+P opens quickly from the cached session list, then refreshes CRSM in the background so Claude Code / Codex sessions started outside mycmux, including PowerShell sessions, are picked up automatically.
- **Resume / CRSM Palette**: Kept the large-history path bounded with request de-duplication, a 10 second auto-refresh cooldown, initial 1000-session loading, and the existing explicit deep load path.

---

## [0.5.0] - 2026-05-04

### Notes

- mycmux personal `master` v0.5.0 (Buddy / Codex Pet bridge 追加) と本体 version を同期するための minor release。**lite には機能差分なし** — Buddy / Codex Pet 関連機能は元から lite に含まれない (lite は Buddy 削除版)。
- これ以降、mycmux 本体機能の bump は master/lite で揃え、Buddy 関連の単独更新は master 内 `src/buddy/version.ts` の `BUDDY_VERSION` で別管理する運用に変更。

---

## [0.4.4] - 2026-05-04

### Fixed

- **GitHub Actions の release workflow**: `workflow_dispatch` で `tag` input を渡しても `tauri-action` が `github.ref_name` (= branch 名) を見て release upload を skip していた問題を修正。`tagName` / `releaseName` / `releaseBody` を `${{ github.event.inputs.tag || github.ref_name }}` で参照するように変更。

### Changed

- **release.yml の構成**: 旧来の tag 名 suffix (`v0.x.y-lite.n`) で `build-personal` / `build-lite` を振り分けていた `if:` 条件付き 2 job 構成を、repo 別の専用 job 1 つに整理。lite worktree は `build-lite` のみ。lite-suffix tag 運用廃止に伴うシンプル化。

---
## [0.4.3] - 2026-05-04

### Fixed

- **壁紙時の Settings / 通知パネル透過**: 壁紙 (media background) を有効にしているとき、Settings メニューと通知ベルのドロップダウンまで `panelOpacity` が乗って文字が読みづらかった問題を解消。新 CSS variable `--cmux-popover` (常に opacity 1) を導入し、popover 系 (Settings 本体 / NotificationPanel) のみ不透明化。TabBar / TitleBar は従来どおり壁紙と調和させる。

### Changed

- **CRSM Palette → Resume にリブランド**: Settings ボタン / 設定セクション見出し / Keybindings 一覧の表示文言を `CRSM Palette` から `Resume` に変更。内部 symbol (`CrsmPalette` コンポーネント、`crsm.palette` action ID、`crsmShow*` 設定キー、Tauri `crsm.rs`、localStorage `mycmux-lite-settings`) は不変のため既存ユーザー設定は保持。
- **Settings 内の Resume 関連設定を統合**: 「Resume」ボタンと「Resume で表示する種類」(Claude / Codex / Hybrid チェックボックス) を 1 ブロックに集約し、関連設定として認識しやすくした。

---

## [0.4.2] - 2026-05-04

### Added

- **Settings → CRSM Palette ボタン**: 右上 ⚙ メニューに `Themes` / `Keybindings` と並んで `CRSM Palette` ボタンを追加。`Ctrl+P` を覚えていなくても歯車から palette を開ける。

### Changed

- **CRSM Palette 引き継ぎ先連動**: Settings の「CRSM Palette で表示する種類」で OFF にした kind は、palette 内の引き継ぎ先 (handoff target) ボタン行と Tab キー循環からも消える。引き継ぎ先として選べないようになった。

---

## [0.4.1] - 2026-05-04

### Added

- **Settings → CRSM Palette (Ctrl+P) で表示する種類**: 右上 ⚙ メニューに `Claude Code` / `Codex` / `Hybrid (Claude+Codex)` の表示 ON/OFF チェックボックスを追加。OFF にした kind は CRSM Palette のリストとフィルタチップから完全に消える。設定は localStorage 永続化 (デフォルト全 ON)。

### Notes

- master 側で行った Remote Terminal の URL 形式変更 (`#token=` → `?token=`) と embedded client refresh、Settings の Remote セクション追加は **lite には今回反映していない**。lite の Remote パスは現状の v0.4.0 構成のまま動作する (Phase 3-D の RemoteControl 互換化のみ済み)。

---

## [0.4.0] - 2026-05-04

Synced from upstream personal `master` v0.4.0 plus lite-specific remote terminal hardening.

### Fixed

- **CRSM Palette**: Ctrl+P で開いたセッションの env が親プロセス経由で他の PTY に伝播し、新規ペイン作成時に意図せず resume される問題を修正 (`MYCMUX_*` / `__CMUX_LAUNCHER_DONE` を起動時に `std::env::remove_var()` で除去)。**配布物で再発するとチーム全員のシェルで agent モード暴発事故になる重大バグ。**
- **CRSM Palette**: CRSM CLI 呼び出し時に Windows コンソール窓が一瞬表示される問題を抑制 (`CREATE_NO_WINDOW = 0x08000000`)。
- **Remote terminal (lite-only)**: WebSocket 接続失敗時に Terminal 読み込みを待ってからステータスバナーで通知。

### Added

- **CRSM Palette**: 詳細サブパネル (右ペイン) で USER / ASSISTANT ブロック分け表示。
- **CRSM Palette**: cwd フィルタ chip (頻度上位 8 件 + 「他 N 件」展開)。
- **CRSM Palette**: kind バッジを色分け (Claude オレンジ / Codex 青 / Hybrid 緑)。
- **CRSM Palette**: 相対時刻表示、開始時刻 (`started_at`) 表示。
- **CRSM Palette**: 「さらに過去のセッションを読み込む」ボタン (1000 件 → 全件)。

### Changed

- **CRSM Palette**: パネル幅 940px → 1200px、左 480px リスト + 右詳細の 2 カラム構造。
- **CRSM Palette**: リスト各行を 2 行構造化 (1 行目: kind + label + 時刻 / 2 行目: cwd・source・✏ N ☐ N)。
- **Persistence**: `agent_session_id` / `agent_kind` / `claude_session_id` を `data.json` に保存しなくなった (再起動後の自動 resume は廃止、Ctrl+P から手動 resume する仕様)。
- **Remote terminal (lite-only)**: `<script async>` → `<script defer>` で読み込み順を決定的に。

---

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
