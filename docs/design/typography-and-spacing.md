# Typography & Spacing

## Font Stacks

### UI Text
```css
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
```
Used in: `html, body`, UI labels, buttons.

### Terminal
```
'${user_font}', monospace              — from config detection
```
Fallback chain: `'JetBrainsMono Nerd Font Mono', 'JetBrains Mono', 'Geist Mono', 'SF Mono', monospace`

### Monospace UI
```css
font-family: 'JetBrains Mono', 'Geist Mono', monospace;
```
Used in: PaneTabBar labels, restart button, URL bar.

## Type Scale

| Context | Size | Weight | Location |
|---------|------|--------|----------|
| Terminal content | User config (default 14px) | 400 / 600 bold | XTermWrapper |
| Pane tab labels | 13px | inherit | PaneTabBar |
| Pill badges | 11px | 500 | `.cmux-pill` |
| URL bar input | 12px | inherit | BrowserPane |
| Restart button | 12px | inherit | TerminalPane |

## Terminal Font Configuration

The font size goes through a scaling pipeline:

```
User's native terminal config (e.g. Ghostty font-size = 9)
  → Rust terminal_config::load()
    → JS: rawSize < 12 ? Math.round(rawSize * 1.6) : rawSize
      → Math.max(14, scaled)
        → xterm.js fontSize option
```

Reason: Native terminals use physical pixels; Tauri webview uses CSS pixels. Values below 12 are assumed to be physical pixel sizes and scaled up.

## Font Rendering

```css
-webkit-font-smoothing: antialiased;
-moz-osx-font-smoothing: grayscale;
text-rendering: optimizeLegibility;

/* Terminal-specific */
.xterm-rows {
  font-variant-ligatures: none;
  text-rendering: geometricPrecision;
  font-feature-settings: "liga" 0, "calt" 0;
}

canvas {
  image-rendering: -webkit-optimize-contrast;
}
```

Ligatures are explicitly disabled in terminal content. Canvas uses `optimize-contrast` for sharper glyphs on Linux/WebKitGTK.

## Spacing Constants (`lib/constants.ts`)

| Constant | Value | Usage |
|----------|-------|-------|
| `PANE_HEADER_HEIGHT` | 36px | PaneTabBar height |
| `TAB_BAR_HEIGHT` | 36px | Sidebar tab height |
| `SIDEBAR_WIDTH` | 200px | Sidebar width |

## xterm.js Terminal Options (current)

```typescript
{
  fontSize: <store>,       // themeStore.fontSize (10-24, slider)
  fontWeight: 500,
  fontWeightBold: 700,
  letterSpacing: 0,        // fixed; a user setting was evaluated 2026-08-11
                           // and deferred (refit + IME composition-view risk
                           // outweighs the gain; line height covers the need)
  lineHeight: <store>,     // themeStore.lineHeight (1.0-1.8, default 1.35)
  scrollback: 5000,
}
```

## UI Density (2026-08-11)

`themeStore.uiDensity` = `"compact" | "standard" | "relaxed"` (persisted as
`settings.ui_density`). `AppShell.themeVars` drives the tokens; "standard" is
byte-identical to the historical static values (guarded by
`tests/unit/uiDensity.test.ts`).

| Token | compact | standard | relaxed |
|---|---|---|---|
| `--cmux-font-size-xs/sm/md` | 11/12/13px | 11/12/13px | 12/13/15px |
| `--cmux-line-height-ui` | 1.25 | normal | 1.8 |
| `--cmux-space-*` scale | ×0.85 | ×1.0 | ×1.25 |

## Minimum Font Size Rule

Japanese-bearing text in the UI chrome must be **≥ 11px**
(`var(--cmux-font-size-xs)`). Latin/digit-only badges may use 10px; 9px is
banned everywhere (enforced by `tests/unit/uiQualityTokens.test.ts`).
Rationale: Windows renders Japanese below 11px with visibly degraded quality
(docs/plans/2026-08-04-ui-uplift-plan.md).
