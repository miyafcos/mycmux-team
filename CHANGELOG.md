# Changelog (mycmux-lite)

## [0.7.13-lite.1] - 2026-06-05

- Fixed: Raw Windows artifact paths are now linkified by a dedicated terminal link provider, including paths with spaces or Japanese folder names, so output such as `HTML: C:\Users\miyaz\report.html` can open in the in-app preview tab even though it is not a URL.
- Changed: Removed the manual Preview artifact eye button from pane tab bars; artifact previews now open from terminal links only.

## [0.7.12-lite.1] - 2026-06-05

- Fixed: Terminal output containing raw Windows artifact paths such as `HTML: C:\Users\miyaz\report.html` now opens local `.html`, `.htm`, `.md`, and `.markdown` files in the in-app preview tab instead of requiring a `file:///...` URL. Markdown previews for external local files are rendered into the session preview cache.

## [0.7.11-lite.1] - 2026-06-05

- Added: AI artifact preview for lite panes. Each PTY now receives `MYCMUX_MARKDOWN_OUT` and `MYCMUX_ARTIFACTS_DIR`; `out.html` opens directly, `out.md` is rendered to safe static HTML, and terminal `file:///...` artifact links open inside a mycmux browser tab when they belong to the active session.

## [0.7.10-lite.1] - 2026-06-05

- Fixed: Pane zoom no longer leaves the workspace blank when the zoomed pane is closed or when switching to a workspace that does not contain the zoomed pane. The workspace stores now clear stale `zoomedPaneId` at the source, and `AppShell` keeps a self-healing guard as a safety net.

## [0.7.8-lite.1] - 2026-05-18

- Fixed: The theme picker now actually switches themes (setTheme was pinned to the default theme id), so light themes apply correctly including the ANSI palette.
- Changed: UI colors are fully theme-tokenized — hardcoded dark-assumption colors across modals, palettes, status badges, drag-and-drop, and chrome now use theme-aware tokens, so light themes render correctly.
- Fixed: Terminal text no longer washes out over a background image (minimumContrastRatio is disabled while a media background is active).
- Fixed: Terminal display stability under heavy agent output — PTY output applies backpressure instead of being dropped, session re-attach swaps the data channel cleanly, resize triggers a staggered full refresh, and WebGL context-loss recovery is hardened.

## [0.7.4-lite.1] - 2026-05-16

- Changed: Title bar text/icon shadows are theme-aware and key off the effective chrome background lightness — light chrome (including dark themes recolored light) drops the dark drop-shadow; a subtle white halo is kept only over image backgrounds.

## [0.7.2-lite.1] - 2026-05-15

- Added: Pane tab rename via double-click / context menu. Label is persisted per tab in data.json; empty value restores auto-naming.
- Added: Resume palette can hide sessions without user messages (toggle in Settings, default ON).
- Changed: Usage Meter now reads live values from Anthropic OAuth /usage endpoint, replacing the local JSONL token-counting heuristic. Fixes the 100% artifact caused by tier mismatch / hardcoded limits.
- Changed: Codex usage section auto-hides when the ChatGPT rate-limit endpoint is not reachable.

## [0.7.1-lite.1] - 2026-05-14

### Diagnostic

v0.7.1-lite.1 は v0.7.2 で予定している display stability fix の根因特定用
instrumentation リリース。terminal レンダリング層の挙動を可視化する log/counter
のみ追加し、描画ロジック自体は無変更。TitleBar の文字色 tweak (下記 Changed) のみが
ユーザー視認可能な変更。

### Added — diagnostics

- **PTY metrics (Rust → stderr, 5 秒ごと)**: 各 session の `reads`, `avg_read_us`,
  `flushes`, `avg_batch`, `send_err`, `queue_full`, `dropped_chunks`,
  `dropped_bytes`, `closed` を `[mycmux-diag pty {id}]` で出力。
- **SessionManager::create handoff log**: `[mycmux-diag manager]` で `new` vs
  `idempotent` を区別し、idempotent path では古い session の age と新規 channel ID
  (破棄される側) を log。
- **Frontend attach epoch + stale message counter** (`[mycmux-diag ipc]`):
  `createSession()` が `sessionId` 別 epoch を bump し、古い epoch から届く
  `Channel.onmessage` を `stale_message` として 25 回ごとに log。
- **xterm 1 秒統計** (`[mycmux-diag xterm:{sid}]`): `writes/s`, `bytes/s`,
  `webgl=on|fallback|never`, `replays`, `replay_lines` を console に出力。
- **`WEBGL_LOST` event**: `WebglAddon.onContextLoss` 発火時刻と直近 writes 数を log。
- **termCache lifecycle log**: `cache_hit`, `cache_miss`, `cache_evict` を console
  に出力。
- **initial_replay log**: 起動時の terminal_snapshot 再生量 (`lines`, `bytes`,
  `source`) を log。

### Changed

- **TitleBar 文字色**: `--cmux-text-tertiary` (white 30%) → `--cmux-text-secondary`
  (white 60%) に変更。

### Fixed — Usage Meter calibration

v0.7.0-lite.1 の Usage Meter は Anthropic /usage の実値と乖離していた:

- **`cache_read_input_tokens` を加算対象から除外** (`src-tauri/src/usage/claude.rs`):
  cache_read は Anthropic の rate-limit 計算に含まれない。
- **`max_20x` 上限校正** (`src-tauri/src/usage/tier_presets.rs`):
  5h: 220M → **150M tokens**、7d: 1.5B → **500M tokens**。
- **Codex limit 校正**: 5h: 150 → **20000 messages**、7d: 1500 → **12000 messages**。
- 上書きは `~/.claude/mycmux-usage-config.json` で可能。

### Out of scope (v0.7.2 で対応予定)

- WebGL renderer の Codex 表示プツプツ問題
- SessionManager::create の channel 差し替えロジック化
- scrollback / replay の重複表示 fix

---

## [0.7.0-lite.1] - 2026-05-13

### Added

- **Usage Meter**: TitleBar right group に Claude Code / Codex のサブスクリプション使用量メーターを追加。5 時間ローリング + 7 日ウィンドウを `CC 5h ▓▓▓░░ 45% 7d ▓▓▓▓░ 62%  CX 5h ▓▓░░░ 23%` の形式で常時表示。80% 閾値で橙、95% で赤 + pulse animation。ホバーで Popover を開き、絶対値・reset 時刻・tier 名を表示。900px / 700px の媒体クエリでコンパクト化 / 非表示。
- Rust-native の Usage 集計モジュール `src-tauri/src/usage/` と Tauri command `get_usage_summary` を新設。Node 経由の ccusage を起動せずに `~/.claude/projects/**/*.jsonl` および `~/.codex/sessions/**/*.jsonl` を直接集計。差分スキャン用のファイルキャッシュ付き。
- 上限値は `~/.claude/.credentials.json::rateLimitTier` を基に `tier_presets.rs` の推定値 (max_20x / max_5x / pro) を選択、`~/.claude/mycmux-usage-config.json` で上書き可能。

### Fixed

- **セッション復活 (Symptom A の真因)**: 同一 `session_id` の二重 `create_session` で既存 PTY が破壊されていた問題を `SessionManager::create` を idempotent 化することで解消。
- **セッション復活 (Symptom B の真因)**: `create_session` の cwd 検証経路と spawn 経路で異なるパスを参照していた問題を統一 (`resolve_launch_cwd` 結果を両者で共有) して解消。
- **セッション復活 (Symptom C の真因)**: 並列復元時の race を以下で解消 — startup autosave hold を `1400ms + 700ms × workspaces + 500ms × panes` (上限 30s) の動的式に変更、mapping refresh を 10s poll から `startup-restore-complete` window イベント駆動 + 15s フォールバックに切り替え、初回 mount delay を 1200ms に延長 (2 回目以降 650ms)。

### Changed

- `scripts/backfill-sessions.ps1` を DEPRECATED 化 (本リリースで pane config に agent_kind / cwd が完全に保存されるため、起動後の back-fill は不要)。
- 使用量メーターの推定上限値は ccusage コミュニティデータ由来。Anthropic 公式値ではない旨を `tier_presets.rs` および UI のホバー表示で明示。

---

## [0.6.2-lite.1] - 2026-05-07

### Fixed

- Synced startup restore behavior from personal v0.6.2. Every workspace with a saved Claude / Codex / claude-codex session, or a matching `~/.mycmux-lite/pane-sessions/*.txt` mapping, is now a restore target instead of only the active workspace.
- Inactive restore targets mount through a short queue after the active workspace, keeping normal startup responsive while previous sessions resume.
- `shell-starter` / session-less panes can recover `agent_kind` and `agent_session_id` from pane-session mappings. Existing distinct session IDs are not overwritten by stale mapping files.
- The workspace LRU mount cap now applies only to shell-only workspaces; restore-target workspaces are not evicted by the cap.
- Startup autosave is held briefly during restore so `data.json` is less likely to be rewritten with an intermediate session-less state.

---

## [0.6.1-lite.1] - 2026-05-07

### Fixed

- **Session-history persistence (real fix)**: synced from upstream personal v0.6.1. The v0.5.6 release advertised that every pane re-attaches to its previous Claude / Codex session on restart, but the wiring was incomplete — `onPtyMetadata` only fed `paneMetadataStore`, while `SocketListener.tsx::toConfig` was reading the un-mirrored `Pane.claudeSessionId` / `agentKind` / `agentSessionId`. Saved `data.json` always wrote `null` for those fields, so restart fell back to the launcher menu.

  Fix:
  - `workspaceListStore.ts`: new `setPaneAgentSessionFromMetadata(sessionId, payload | null)` action that finds the matching tab and mirrors onto the pane when the tab is active. `null` clears.
  - `App.tsx::onPtyMetadata`: also calls the new action so live agent session metadata is mirrored into `workspaceListStore`. Mirror only fires on truthy `claude_session_id` / `agent_session_id` so the launcher (`crsm` / `shell-starter`) doesn't accidentally clear an in-flight session. Shell return clears.
  - `App.tsx::applyAgentSessionMappings`: also pushes startup mapping cache (`~/.mycmux-lite/pane-sessions/*.txt` → `paneMetadataStore`) into `workspaceListStore`, so the very first save after restart already captures resumable session ids.
  - `SocketListener.tsx::toConfig`: 4-level fallback chain (`Pane → activeTab → paneMetadataStore[pane.sessionId] → paneMetadataStore[activeTab.sessionId] → null`).

### Notes

- Existing v0.6.0 `data.json` is not silently rewritten: panes that were saved with `null` agent session ids will appear at the launcher menu after the v0.6.1-lite.1 update. Re-launch the agent on each pane once and the next save captures the live session ids; from then on restart re-attaches automatically.
- Env-leak defenses (`stripEphemeralLaunchEnv`, `EPHEMERAL_LAUNCH_ENV_KEYS`, `lib.rs::run` `remove_var`) and `dedupeAgentSessionsInConfigs` are intentionally untouched.

---

## [0.6.0] - 2026-05-05

Stability checkpoint after the v0.5.4 - v0.5.6 series. No code changes from v0.5.6.

### Highlights since v0.5.3

- **Session-history persistence restored (v0.5.6)**: every pane re-attaches to its previous Claude / Codex session on restart.
- **Terminal renderer toggle (v0.5.5)**: Settings → Terminal renderer (WebGL). Per-OS default — macOS=ON, Windows=OFF, Linux=OFF.
- **Launcher menu canonicalized (v0.5.4)**: confirmed the 10-item layout (normal → dangerous → resume).

---

## [0.5.6] - 2026-05-05

### Fixed

- **Restore session-history persistence**: `SocketListener.tsx::toConfig` now writes the live `claudeSessionId` / `agentKind` / `agentSessionId` (with tab → pane fallback) into `data.json` instead of forcing them to `null`. Combined with the existing `applyMappingsToConfig` load path that prefers `data.json` over `~/.mycmux-lite/pane-sessions/*.txt` mapping cache, a restart re-attaches every pane to its previous Claude / Codex session — matching the v0.3.x experience that was lost in v0.4.

### Notes

- The historical reason this code path was disabled in v0.4 was a `MYCMUX_*` env-var leak that caused new panes to silently auto-resume into the previously selected agent session, skipping the launcher menu. v0.4.x already rebuilt the env-leak defenses (`std::env::remove_var()` at app startup in `lib.rs`, `sanitize_launch_env()` in `commands/terminal.rs`, and `EPHEMERAL_LAUNCH_ENV_KEYS` filtering in `SocketListener.tsx`), so re-enabling persistence here does not bring the leak back. Synced from upstream personal master v0.5.6.

---

## [0.5.5] - 2026-05-05

### Added

- Added Settings toggle **Terminal renderer (WebGL)**.
- Defaults: macOS=ON, Windows=OFF, Linux=OFF.
- Windows now defaults back to the v0.5.1-style DOM renderer to avoid the darker/heavier Windows WebView2 rendering introduced by always-on WebGL in v0.5.2.
- Renderer selection takes effect on next pane creation, not on existing live panes.

---

## [0.5.4] - 2026-05-05

### Changed

- **Launcher menu (`src-tauri/src/launcher.sh`)**: Confirm the canonical 10-item layout grouped as **normal → dangerous → resume**. The repo file already used this order since v0.4; this release ships a refreshed installer so `~/.mycmux-lite/bin/launcher.sh` matches.

  ```
  1. Claude Code        4. Claude Code (dangerous)   7. Claude Code (resume)
  2. Codex              5. Codex (dangerous)         8. Codex (resume)
  3. claude-codex       6. claude-codex (dangerous)  9. claude-codex (resume)
                                                     0. Custom...
  ```

### Notes

- No TypeScript / Rust source changes. Synced from upstream personal `master` v0.5.4.

---

## [0.5.3] - 2026-05-05

### Fixed (Windows)

- **`terminal_config.rs`**: Suppress unused-variable lint for the alacritty loader's `home` parameter on non-Linux/non-macOS targets (was already fixed in v0.5.2 binaries; this release republishes the same fix under a clean version number).

### Notes

- v0.5.2 tag now points to the Mac release commit (`f4bb193`). The Windows clippy fix that previously shipped under the v0.5.2 tag is republished here as v0.5.3 with no functional change. Auto-update users on v0.5.2 will be moved to v0.5.3.

---

## [0.5.2] - 2026-05-05

### Performance

- **macOS idle CPU pathology**: Force native window decorations on macOS to bypass tao 0.34.x's `setStyleMask:` thrash on `decorations: false`. Idle CPU drops 99.3%, RSS drops 85% (411MB → 75MB) on Apple Silicon (`sample` profile root cause).
- **Terminal rendering**: Connect xterm's WebGL addon (already in deps but never loaded) with DOM fallback on context loss. Helps both platforms; dramatic on macOS WKWebView.
- **Bundle**: Drop unused `ghostty-web` dependency.

### Added

- **macOS support**: First-class macOS build path. See README "macOS (ソースビルド)" section. Resume palette finds `crsm` automatically when built at `~/crsm/target/release/crsm`.
- **Cross-platform shortcuts**: On macOS, `Cmd+…` is treated as equivalent to `Ctrl+…`, so all Windows-authored bindings (Resume, New Workspace, etc.) fire on the native Mac modifier without remapping.
- `scripts/measure-mac.sh` — bash + osascript baseline harness for launch time, RSS, idle CPU.

### Fixed

- **`terminal_config.rs`**: macOS / Linux build failure where the alacritty loader declared `_home: &Path` (intentionally-unused arg) but referenced `home` inside a `cfg(target_os = "macos")` block.
- **`crsm` CLI lookup**: Use `std::env::consts::EXE_SUFFIX` instead of hard-coded `.exe`, so Resume finds the binary on Unix.
- **macOS window visibility**: Force `show()` from the Tauri setup hook on macOS as a temporary bridge; the frontend `reveal_main_window` flow not firing on macOS is tracked separately.

### Notes

- Synced from upstream personal `master` v0.5.2 plus the lite identity/UI variant carry-over.

---

## [0.5.1] - 2026-05-05

### Changed

- **Resume / CRSM Palette**: Ctrl+P opens quickly from the cached session list, then refreshes CRSM in the background so Claude Code / Codex sessions started outside mycmux are picked up automatically.
- **Resume / CRSM Palette**: Kept the large-history path bounded with request de-duplication, a 10 second auto-refresh cooldown, initial 1000-session loading, and the existing explicit deep load path.

### Notes

- Synced from upstream personal `master` v0.5.1. Buddy-only changes (new `src/buddy/version.ts`) are intentionally excluded — Buddy is removed in lite and BUDDY_VERSION is tracked only in master per the policy noted in v0.5.0.

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
