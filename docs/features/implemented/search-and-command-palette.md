# Search & CRSM Palette

## Terminal Find Bar

In-terminal text search with regex support, match highlighting, and wrap-around navigation.

### Behavior
- Integrated find bar overlay within each terminal pane
- Supports regex and case-sensitive toggles
- Keyboard: `Ctrl+Shift+F` to open, `Enter`/`Shift+Enter` to navigate matches
- Matches highlighted in scrollback buffer via xterm.js search addon

### Implementation

| Layer | Where |
|-------|-------|
| Frontend | `TerminalSearchBar.tsx` overlay inside `TerminalPane` |
| xterm.js | `@xterm/addon-search` |
| Store | Per-pane state in `paneMetaStore` (query, matchIndex, matchCount) |
| Keyboard | `terminal.search` action bound in `XTermWrapper` |

---

## CRSM Palette (`Ctrl+P`)

CRSM = Claude / Codex Recent Session Manager. Global overlay listing recent agent sessions (Claude Code, Codex, claude-codex) with cwd and started_at metadata, used to **manually resume a prior session into a new pane**.

### Why Ctrl+P (and not auto-resume)

v0.4.0 で「保存済みセッション ID で自動 resume 起動を優先」する旧仕様を廃止した。理由は env 汚染事故 (`MYCMUX_RESUME=1` 等が新規ペインに伝播してエージェントモードが暴発) を根絶するため。CRSM Palette は **その代替の手動 resume 入口** として導入された。

### UI

- Width: 1200px / 2 カラムレイアウト (左: セッション一覧 / 右: 詳細サブパネル)
- 左カラムの行: agent kind (色分けバッジ) + タイトル要約 + cwd chip + 相対時刻 (started_at)
- 右カラム: 選択中セッションの詳細 (会話プレビュー / フルパス / kind / 開始時刻)
- Enter で選択 → 新規ペインを spawn し対象セッションを resume

### Implementation

| Layer | Where |
|-------|-------|
| Frontend | `src/components/CommandPalette/CrsmPalette.tsx` |
| Backend | `src-tauri/src/commands/crsm.rs` (CRSM CLI 経由でセッション一覧を取得、`CREATE_NO_WINDOW` 抑制あり) |
| Keyboard | `crsm.palette` action (defaultShortcut: `ctrl+p`) in `src/lib/keybindings.ts` |
| Dispatcher | `AppShell.tsx` で global key handler |

### 過去の Command Palette 構想との関係

旧 docs にあった「`Ctrl+Shift+P` で全アクションを fuzzy search する Command Palette」は**未実装**で計画段階のまま終わっている。`Ctrl+Shift+P` は現在キーバインドに登録されていない。CRSM Palette は機能スコープが「過去セッションの再開」に限定されており、汎用 action palette とは別物。
