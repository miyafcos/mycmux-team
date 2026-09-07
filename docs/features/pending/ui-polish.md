# UI Polish & Visual Enhancements

> Implemented in v0.1.0 (`8859f29d`): notification panel; v0.1.3 (`e12ca7db`): error boundaries; v0.3.0 (`b9f5ff08`, `1fff5edf`): notification sound and light themes. See [notifications](../../../README.md#13-通知と状態検知).
> Implemented in v0.21.7 (`4d9f19a4`): overlay glass/motion. See [appearance](../../../README.md#14-見た目と設定); the dashboard remains solid.
> Session identities returned in v0.5.6 (`5620c11e`); window geometry shipped in v0.11.0 (`3093457a`). See [restore](../../../README.md#8-セッションを残す戻す) and [artifact previews](../../../README.md#10-成果物を見る直す); unmarked items remain proposals.

## Glassmorphism Effects

Frosted glass blur on sidebar and overlays for depth.

| Detail | Description |
|--------|-------------|
| cmux | `NSVisualEffectView` with blur materials on sidebar, palette, dialogs |
| Shipped | Themed glass composition and overlay `backdrop-filter`; dashboard glass remains pending |
| Caveat | WebKit in Tauri webview supports `backdrop-filter`; performance cost on Linux |
| Priority | **Low** |

## Error & Loading States

Graceful handling of PTY failures, config load errors, empty states.

| Detail | Description |
|--------|-------------|
| cmux | Error boundaries per surface, retry buttons, descriptive error messages |
| Shipped | `ErrorBoundary.tsx` wraps pane content and offers Retry |
| Partial | `TerminalPane` shows a connection-pending overlay; a skeleton is not implemented |
| Shipped | `EmptyWorkspaceState` and the React launcher provide creation/launch actions |
| Priority | **High** |

## Notification Sounds & Panel

Audio feedback for notifications plus a centralized notification panel.

| Detail | Description |
|--------|-------------|
| cmux | `UNUserNotificationCenter` with system + custom sounds, notification panel with timeline |
| Shipped | Web Audio chime in `XTermWrapper` |
| Shipped | `NotificationPanel.tsx` popover separates sessions needing an answer from unread arrivals |
| Partial | Enable/disable settings exist; user volume and custom sounds remain pending |
| Priority | **Medium** |

## Light Theme

Full light theme for daytime use and accessibility.

| Detail | Description |
|--------|-------------|
| cmux | Light theme with appropriate terminal colors |
| Shipped | 30 themes, including 9 light themes, in `themeDefinitions.ts` |
| Shipped | Runtime theme tokens and light-theme contrast contracts |
| Needs | `prefers-color-scheme: light` auto-detection |
| Priority | **Medium** |

## Sidebar Metadata

Rich workspace info in sidebar: pane count, running processes, Git branch.

| Detail | Description |
|--------|-------------|
| cmux | Tab bar shows workspace color, title, icon, dirty indicator, notification badge, Git branch |
| Shipped | Workspace color groups, pane count, Git branch, notification / work-done badges, unseen-attention ring, last-log preview — see [workspaces-and-layout.md](../implemented/workspaces-and-layout.md) |
| Needs | Workspace icon and dirty indicator |
| Priority | **Low** |

## Port Scanner

Detect and display listening ports from terminal processes.

| Detail | Description |
|--------|-------------|
| cmux | Background port monitoring, clickable port links to open in browser pane |
| Needs | Rust module scanning `/proc/net/tcp` or `ss` output periodically |
| Needs | Port list UI in pane chrome or sidebar |
| Needs | Click-to-open behavior routing to browser pane |
| Priority | **Low** |

## Markdown Viewer Pane

Render markdown files as formatted HTML in a pane.

| Detail | Description |
|--------|-------------|
| cmux | Markdown panel type using `WKWebView` with rendered HTML |
| Shipped | Markdown artifact rendering/editing through `BrowserPane.tsx`; no separate `MarkdownPane.tsx` |
| Needs | File watcher for live reload on save |
| Shipped | `type: "browser"` plus `sourceKind: "markdown"` stores artifact preview metadata |
| Priority | **Low** |

## Session Restore

Restore full workspace layout, pane positions, and running processes on app restart.

| Detail | Description |
|--------|-------------|
| cmux | Full geometry + workspace + surface persistence, process re-spawn on launch |
| Current | mycmux persists layout, window geometry, CWD, validated agent session identities and terminal snapshots; live OS processes do not survive app exit |
| Shipped | Window position/size/maximized persistence via `tauri-plugin-window-state` |
| Shipped | Pane/tab CWD saved and passed to PTY startup |
| Partial | Recent output is restored from snapshots/scrollback; exact viewport restoration is not guaranteed |
| Priority | **High** |
