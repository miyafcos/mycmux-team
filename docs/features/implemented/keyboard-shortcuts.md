# Keyboard Shortcuts

Shortcuts now use a centralized keybinding system with defaults + user overrides.

## Architecture

- Definitions and defaults: `src/lib/keybindings.ts`
- Runtime store and overrides: `src/stores/keybindingStore.ts`
- Global dispatcher: `src/components/layout/AppShell.tsx`
- Terminal-level overrides: `src/components/terminal/XTermWrapper.tsx`
- Remapping UI: `src/components/layout/KeybindingsModal.tsx`

## Default Shortcuts

Windows defaults below; macOS accepts Command in place of Control. The complete registry is `src/lib/keybindings.ts`.

| Shortcut | Action |
|----------|--------|
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+P` | Open CRSM palette (recent agent sessions) |
| `Ctrl+,` | Open keyboard shortcuts |
| `Ctrl+Shift+N` | New workspace immediately |
| `Ctrl+Shift+Alt+N` | New workspace dialog (choose layout and agents) |
| `Ctrl+Tab` | Next workspace |
| `Ctrl+Shift+Tab` | Previous workspace |
| `Ctrl+Shift+W` | Close workspace |
| `Ctrl+1..8` | Jump to workspace 1..8 |
| `Ctrl+9` | Jump to last workspace |
| `Ctrl+Alt+Arrow` | Focus adjacent pane |
| `Ctrl+Alt+D` | Split pane right |
| `Ctrl+Alt+Shift+D` | Split pane down |
| `Ctrl+Alt+W` | Close active pane |
| `Ctrl+Alt+PageDown` | Next tab in active pane (`pane.tab.next`) |
| `Ctrl+Alt+PageUp` | Previous tab in active pane (`pane.tab.prev`) |
| `Ctrl+Shift+Enter` | Toggle pane zoom |
| `Ctrl+Shift+T` | Reopen closed pane/tab |
| `Ctrl+Alt+A` | Next pane needing attention |
| `Ctrl+Alt+P` | Toggle active pane/tab pin |
| `Ctrl+Shift+K` | Open tab sweep |
| `Ctrl+Shift+G` | Open dashboard |
| `Ctrl+Shift+Left/Right` | Move between dashboard columns |
| `Ctrl+Shift+Backspace` | Close dashboard column |
| `Ctrl+Shift+P` | Pin dashboard column |
| `Ctrl+Alt+I` | Focus the pane composer |
| `Ctrl+Shift+F` | Find in terminal |
| `Shift+Enter` | Send kitty protocol `\x1b[13;2u` for Codex panes, bracketed-paste newline for other panes |

## User Remapping

- Open **Keyboard Shortcuts** with `Ctrl+,` or in Settings → Keyboard Shortcuts.
- Click **Rebind**, then press your new shortcut.
- Press `Backspace` or `Delete` while rebinding to clear an override.
- Use **Restore defaults** to clear all overrides.
- Conflicts are highlighted in the modal.

Overrides are persisted inside app settings and loaded on startup.
