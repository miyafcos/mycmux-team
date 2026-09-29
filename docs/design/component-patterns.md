# Component Patterns

## Pill Badge (`.cmux-pill`)

Capsule-shaped inline badge for counts and labels.

```css
.cmux-pill {
  background: color-mix(in srgb, var(--cmux-text) 18%, transparent);
  color: var(--cmux-text);
  border-radius: 9999px;
  padding: var(--cmux-space-1) var(--cmux-space-4);
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
```

Used for: notification counts in sidebar tabs.

## Pane Action Button (`.pane-action-btn`)

Transparent icon button that appears in pane headers.

```css
.pane-action-btn {
  background: none;
  border: none;
  color: var(--cmux-text-tertiary);  /* theme-driven; static fallback opacity 0.3 */
  cursor: pointer;
  padding: 3px;
  border-radius: var(--cmux-radius-sm); /* 4px */
  transition: color var(--cmux-motion-fast) var(--cmux-ease), background var(--cmux-motion-fast) var(--cmux-ease), transform var(--cmux-motion-fast) var(--cmux-ease);
}
.pane-action-btn:hover {
  color: var(--cmux-text);
  background: var(--cmux-hover);
}
```

Used for: split-right, split-down, close pane, close tab, add tab, search and dashboard actions.

## Tab Pattern (PaneTabBar)

Each tab in the pane header:

| State | Background | Border-bottom | Text color |
|-------|-----------|---------------|------------|
| Inactive | transparent | 2px transparent | `--cmux-text-secondary` |
| Active | `--cmux-selected` | 2px `--cmux-accent` | `--cmux-text` |

- Height: 36px, max-width: 160px, text overflow: ellipsis
- Close button (×) only shown when pane has >1 tab
- Folder icon color: accent when active, tertiary when not
- Status dot: 5px semantic waiting/working/error indicator; inactive tabs can show status too

## Sidebar Tab (TabItem)

Workspace tabs in the sidebar:

- Close button (`.tab-close-btn`): hidden by default, shown on parent hover via CSS
- Color indicator: workspace color stripe on left edge
- Metadata: notification count pill + last log line preview

```css
div:hover > .tab-close-btn {
  opacity: 1 !important;
}
```

## Terminal Pane Container

```
┌─ PaneTabBar (36px) ──────────────────────────┐
│ [icon] label  [icon] label  │ [+] [🌐] [⊞] [×] │
├──────────────────────────────────────────────┤
│                                              │
│  XTermWrapper (flex: 1)                      │
│  ├── xterm.js Terminal                       │
│  └── WebGL canvas                            │
│                                              │
│  Connection-pending overlay during startup  │
└──────────────────────────────────────────────┘
```

Focus states:
- Active pane: 2px `--cmux-accent` pseudo-element border with 0.15s transition (hidden when zoomed)
- Inactive pane: 1px transparent pseudo-element border
- Notification overlay: 2px `--notification-color` border with `notificationPulse` (2.5s); one-shot flash was removed (`a5ac2fc7`)

## Split Pane Grid (Allotment)

```css
:root {
  --sash-size: 4px !important;
}

[class*="sash"] { background: var(--cmux-bg) !important; }
[class*="sash"]::before {
  background: var(--cmux-border) !important;
  transition: background 0.15s;
}
[class*="sash"]:hover::before,
[class*="sash"][class*="active"]::before {
  background: var(--cmux-accent) !important;
}
```

The 4px sash paints the pane background with a themed divider; hover/drag uses the accent.

## Sidebar Layout

```
width: sidebarCollapsed ? 0 : sidebarWidth  // default 280px, range 200–560px
overflow: hidden
flexShrink: 0
transition: width 0.2s ease
```

Sidebar is always mounted (never unmounted) to avoid terminal remount. Width animates to 0 when collapsed.

Toggle: sidebar collapse button (visible when collapsed) or `Ctrl+B`.
