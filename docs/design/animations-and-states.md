# Animations & States

## Keyframe Animations

### Historical Pane Flash (`@keyframes paneFlash`)

Removed on 2026-04-10 (`a5ac2fc7`), together with its shortcut/API. The values below document the former behavior; current notifications use `notificationPulse` (2.5s).

```css
@keyframes paneFlash {
  0%   { opacity: 0; }
  15%  { opacity: 1; }
  40%  { opacity: 0.3; }
  65%  { opacity: 1; }
  100% { opacity: 0; }
}
```

- Duration: 0.9 seconds
- Easing: `ease-out`
- Applied to: absolute-positioned overlay div with 3px accent border
- Trigger: `Ctrl+Shift+H` or programmatic `triggerFlash(sessionId)`
- Cleanup: `setTimeout(900ms)` removes pane from `flashingPaneIds` set

## Transitions

| Element | Property | Duration | Easing |
|---------|----------|----------|--------|
| Pane action button | color, background, transform | 120ms | `--cmux-ease` |
| Pane focus border | border-color, border-width | 0.15s | default |
| Sidebar width | width | 0.2s | ease |
| Split sash hover | background | 0.15s | default |
| Tab background | background | 120ms | `--cmux-ease` |

## Interactive States

### Pane Action Buttons

| State | color | background |
|-------|-------|-----------|
| Rest | `--cmux-text-tertiary` (theme-driven; static fallback 0.3) | none |
| Hover | `--cmux-text` (theme-driven; static fallback 0.9) | `--cmux-hover` |
| Active | (inherits hover) | (inherits hover) |

### Terminal Pane

| State | Visual |
|-------|--------|
| Inactive | 1px transparent pseudo-element border |
| Active (focused) | 2px `--cmux-accent` pseudo-element border (hidden when zoomed) |
| Has notification | Themed 1px PaneTabBar bottom border; inactive panes pulse a 2px `--notification-color` border |
| Flashing (historical) | One-shot `paneFlash` removed; see historical section above |
| Process exited | PTY exit event; current `TerminalPane` has no Restart overlay |

### Sidebar Tab

| State | Visual |
|-------|--------|
| Inactive | Close button hidden (opacity: 0) |
| Hover | Close button appears (opacity: 1) |
| Active | Highlighted background (varies by component) |

### PaneTabBar Tab

| State | Visual |
|-------|--------|
| Inactive tab | Transparent bg, muted text, transparent bottom border |
| Active tab | `--cmux-selected` background, full text, accent bottom border |
| Notification | Semantic waiting/working/error dot (5px), including inactive tabs |

### Split Sash

| State | Visual |
|-------|--------|
| Rest | 4px sash with pane-background fill and themed divider |
| Hover | `--cmux-accent` colored bar |

## Disabled/Loading

Disabled controls, pane error boundaries with Retry, and a connection-pending overlay are implemented; a PTY loading skeleton remains pending.
The app renders `--cmux-boot-bg` (fallback `#0a0a0a`) until `ready` is true (see `App.tsx`).

## Motion Preferences

`prefers-reduced-motion` is implemented in `global.css` (0.01ms animation/transition duration, one iteration) plus component rules. See [accessibility-and-motion.md](../features/pending/accessibility-and-motion.md) for remaining accessibility work.
