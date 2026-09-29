# Design Overview

## Philosophy

mycmux is a dark-first, keyboard-centric terminal workspace. The UI should feel like a native terminal emulator that happens to have workspace management — not a web app pretending to be one.

**Principles:**
- **Terminal first**: The terminal viewport gets maximum space; chrome is minimal
- **Dark by default**: Default `mayonaka` is dark; the 30 shipped themes include 21 dark and 9 light themes
- **Keyboard native**: Every action reachable by keyboard; mouse is optional
- **Density over whitespace**: Compact headers (36px), tight spacing, monospace typography
- **Instant feel**: No loading spinners, no page transitions, no skeleton screens — just content

## Visual Identity

- **Window**: Custom title bar (no OS decorations), borderless
- **Layout**: Sidebar (280px default, resizable 200–560px, collapsible) + main content area
- **Split panes**: Allotment-based with 4px sash (themed divider at rest, accent color on hover)
- **Color accent**: Theme-driven; default `mayonaka` accent is `#60a5fa`
- **Typography**: System sans-serif for UI, user's terminal font for terminals

## Color Architecture

Two color layers per theme:

| Layer | Purpose | Example fields |
|-------|---------|----------------|
| `terminal` | xterm.js colors | background, foreground, cursor, 16 ANSI colors |
| `chrome` | UI wrapper colors | background, surface, border, text, textMuted, accent |

Bundled themes separate the chrome canvas from the terminal surface; runtime glass composition depends on the wallpaper and opacity settings.

## Layout Anatomy

```
┌──────────────────────────────────────────────────┐
│ TitleBar (36px) — drag region, workspace name     │
├─────────┬────────────────────────────────────────┤
│ Sidebar │ PaneTabBar (36px) — tabs + split/close │
│ (280px) │ ────────────────────────────────────── │
│         │ Terminal content (flex: 1)              │
│ Tab     │                                         │
│ Tab     │ ──────────── 4px sash ──────────────── │
│ Tab     │                                         │
│         │ PaneTabBar                              │
│ + New   │ Terminal content                        │
├─────────┴────────────────────────────────────────┤
```
