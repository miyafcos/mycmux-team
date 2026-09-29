# Colors & Design Tokens

## CSS Custom Properties (`global.css`)

```css
:root {
  --cmux-bg: #0a0a0a;
  --cmux-sidebar: #1E1E1E;
  --cmux-accent: #0A84FF;
  --cmux-accent-text: #0A84FF;  /* AA-floored variant for text-color use */
  --cmux-yellow: #f5c542;       /* warning; theme-driven (status.waiting) */
  --cmux-border: rgba(255, 255, 255, 0.1);
  --cmux-text: rgba(255, 255, 255, 0.9);
  --cmux-text-secondary: rgba(255, 255, 255, 0.6);
  --cmux-text-tertiary: rgba(255, 255, 255, 0.3);
  --cmux-line-height-ui: normal; /* density-driven (uiDensity) */
  --cmux-boot-bg: #0a0a0a;       /* first-frame ground, set by index.html */
}
```

Note: These are static fallback values. At runtime `AppShell.tsx` overrides
them from the active `ThemeDefinition` via the `themeVars` object (single
conversion point) spread on the root element. Font-size (`--cmux-font-size-*`),
`--cmux-line-height-ui`, and `--cmux-space-*` are overridden per the
`uiDensity` setting ("standard" is byte-identical to the static values).

Rules:

- Text colored with the accent must use `--cmux-accent-text` (contrast-floored
  per theme); fills/borders/outlines keep `--cmux-accent`.
- `--cmux-text-muted` and `--cmux-bg-hover` do NOT exist — use
  `--cmux-text-secondary` / `--cmux-hover`. Every `var(--cmux-*)` reference
  must be defined in `:root`; `tests/unit/tokenContract.test.ts` enforces this
  (fallback values do not exempt a missing definition).

## Opacity Scale

| Token | Opacity | Usage |
|-------|---------|-------|
| `--cmux-text` | 0.9 | Primary text, labels |
| `--cmux-text-secondary` | 0.6 | Inactive tabs, descriptions |
| `--cmux-text-tertiary` | 0.3 | Placeholders, disabled controls |
| `--cmux-border` | 0.1 | Borders, dividers |

## Semantic Color Usage

| Context | Color Source | Example |
|---------|-------------|---------|
| App background | `--cmux-bg` / `chrome.background` | `#0a0a0a` |
| Sidebar background | `--cmux-sidebar` | `#1E1E1E` |
| Pane header | `--pane-tabbar-bg`, falling back to `--cmux-surface-raised` | PaneTabBar background |
| Active indicator | `--cmux-accent` | Tab underline, focus outline |
| Notification dot | Semantic waiting / working / error colors | Pane status indicator |
| Hover states | `--cmux-hover` | Button/tab hover |
| Active tab bg | `--cmux-selected` | Selected tab in PaneTabBar |
| Pill background | `color-mix(in srgb, var(--cmux-text) 18%, transparent)` | `.cmux-pill` class |
| Focus outline | `--cmux-accent` | Active pane border (2px, except when zoomed) |
| Notification border | `--notification-color` | 2px `notificationPulse`; one-shot flash was removed (`a5ac2fc7`) |

## Workspace Colors

8 user-selected colors (`src/lib/workspaceColors.ts`):

```typescript
["#4C8DF6", "#1FA2B8", "#3EA55E", "#C9971C", "#E1703C", "#E0524E", "#D95C9C", "#8A6DE0"]
```

No automatic assignment; unknown saved colors normalize to no color.

## xterm.js Hard-coded Overrides

```css
.xterm             { padding: 0; background: transparent; }
.xterm-viewport    { overflow-y: hidden !important; background: transparent !important; }
.xterm-screen      { background: transparent; }
.xterm .xterm-screen canvas { background: transparent !important; }
```

These keep xterm backgrounds transparent so runtime theme and wallpaper composition remain visible.
