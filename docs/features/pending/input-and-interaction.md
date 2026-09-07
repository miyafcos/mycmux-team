# Input & Interaction Enhancements

> Implemented in v0.1.0 (`8859f29d`): pane zoom and custom keybindings; URL routing in v0.1.3 (`e12ca7db`). See [terminal behavior](../../../README.md#5-ターミナル) and [keybindings](../../../README.md#14-見た目と設定).
> This remains a partial backlog: copy mode, broadcast input, file drop, clipboard images, and the other unmarked proposals remain pending.

## Copy Mode

Vi-style keyboard selection for scrollback buffer navigation without mouse.

| Detail | Description |
|--------|-------------|
| cmux | `Cmd+Shift+C` enters copy mode with vi motions (h/j/k/l, w/b, /, ?) |
| Needs | xterm.js selection API, key handler state machine, visual mode indicator |
| Priority | **Medium** |

## Broadcast Input

Type once, send to all visible panes simultaneously.

| Detail | Description |
|--------|-------------|
| cmux | Toggle via `Cmd+Shift+B`, visual indicator on active panes |
| Needs | Broadcast flag in workspace store, input tee in `XTermWrapper.onData` |
| Priority | **Low** |

## Drag-and-Drop (file drop)

Drop files into terminal to paste paths. Tab drag-reorder shipped — see
[workspaces-and-layout.md](../implemented/workspaces-and-layout.md).

| Detail | Description |
|--------|-------------|
| cmux | File drop inserts escaped path |
| Needs | `onDrop` handler on `TerminalPane` (file→path) |
| Priority | **Medium** |

## Context Menus

Right-click menus for copy, paste, split, close, search, notifications.

| Detail | Description |
|--------|-------------|
| cmux | Custom right-click menu with copy/paste/split/zoom/flash actions |
| Needs | `ContextMenu.tsx` component, right-click handler on panes |
| Priority | **Medium** |

## Zoom Pane — Implemented

Temporarily maximize a single pane to fullscreen, toggle back.

| Detail | Description |
|--------|-------------|
| cmux | `Cmd+Shift+Enter` zooms pane, same shortcut unzooms |
| Shipped | `useUiStore.zoomedPaneId`, viewport layout projection, `Ctrl+Shift+Enter` (Command on macOS) |
| Priority | **High** |

## Vim Mode Badge

Visual indicator showing vim/neovim mode (NORMAL/INSERT/VISUAL) in pane chrome.

| Detail | Description |
|--------|-------------|
| cmux | Parses terminal escape sequences to detect vim mode changes |
| Needs | Escape sequence parser in `XTermWrapper`, badge in `PaneTabBar` |
| Priority | **Low** |

## Custom Keybindings — Implemented

User-configurable keyboard shortcuts with conflict detection.

| Detail | Description |
|--------|-------------|
| cmux | `KeyboardShortcutSettings` with 40+ configurable actions, JSON config |
| Shipped | `keybindings.ts`, Settings → Keyboard Shortcuts, conflict detection, overrides persisted in `data.json` |
| Priority | **Medium** |

## Clipboard Images

Paste images from clipboard into terminal (base64 or file path).

| Detail | Description |
|--------|-------------|
| cmux | Detects image clipboard content, offers paste-as-path or inline |
| Needs | Clipboard API image detection, temp file save via Rust, path insertion |
| Priority | **Low** |

## URL Detection & Routing — Implemented

Clickable URLs in terminal output, configurable open behavior.

| Detail | Description |
|--------|-------------|
| cmux | Regex URL detection with Cmd+click to open, configurable handler |
| Shipped | xterm.js `WebLinksAddon` routes HTTP(S) URLs to the OS browser; artifact links have a separate in-app preview path |
| Priority | **High** |

## Focus-Follows-Mouse

Automatically focus pane when mouse enters (optional setting).

| Detail | Description |
|--------|-------------|
| cmux | Toggle in settings, `mouseenter` event triggers pane focus |
| Needs | `onMouseEnter` handler on `TerminalPane`, setting in preferences |
| Priority | **Low** |
