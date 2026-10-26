# Design Overview

## Philosophy

mycmux is a mouse-first terminal workspace for people who use AI agents without needing software engineering skills. Natural-language instructions remain central; operating the workspace should not require typing commands. Keep terminal content visible and the existing keyboard and accessibility paths usable.

**Principles:**
- **Terminal first**: The terminal viewport gets maximum space; chrome is minimal
- **Dark by default**: Default `mayonaka` is dark; the 30 shipped themes include 21 dark and 9 light themes
- **Mouse-first operations**: Use visible, named controls and familiar icons. Questions and approvals are reachable from the persistent 「あなたの番」 entry and answered through the existing question cards.
- **Keyboard and accessibility**: Preserve shortcuts, keyboard navigation, accessible names and visible focus rings alongside mouse controls.
- **Honest Japanese status**: Show short Japanese text for questions/approvals, work in progress, AI turn end, human-confirmed completion, errors and unavailable observations. Silence alone does not mean work stopped.
- **Reliable input**: Guard ordinary submissions before writing text and again before Enter. Agent acceptance requires a new matching user event for the same conversation and execution; uncertain results are shown without automatic resend.
- **Density over whitespace**: Compact headers (36px), tight spacing, monospace typography
- **Instant feel**: No loading spinners, no page transitions, no skeleton screens — just content

## Visual Identity

- **Window**: Custom title bar (no OS decorations), borderless
- **Layout**: Sidebar (280px default, resizable 200–560px, collapsible) + main content area
- **Split panes**: Allotment-based with 4px sash (themed divider at rest, accent color on hover)
- **Color accent**: Theme-driven; default `mayonaka` accent is `#60a5fa`
- **Typography**: System sans-serif for UI, user's terminal font for terminals
- **Action targets**: New primary mouse controls are at least 32px high, preferably 36px, without changing existing row density. Status text must remain readable in light/dark themes and narrow headers.

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
