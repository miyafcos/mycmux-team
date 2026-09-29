# Theming

Updated 2026-09-07. Details and contracts: `docs/design/theme-system.md`.

## 30 Bundled Themes

Three groups — 静かな暗色 (calm-dark), 個性の強い暗色 (vivid-dark), 明るい配色
(light, 9 themes) — defined in `themeDefinitions.ts` with Japanese names.
Default: `mayonaka` (真夜中). `completeTheme()` enforces a WCAG AA 4.5:1 floor
on muted/dim text at definition time.

## Runtime Switching

`ThemePicker` (settings → 外観, top of the tab) shows 3 recommended themes
(`RECOMMENDED_THEMES`, with use-case labels) and an expandable full list per
group. Selecting one:

1. `themeStore.setTheme(id)` — clean switch: per-key color tweaks are dropped,
   background tweaks kept, previous themeId+tweaks stored as a snapshot
2. When tweaks were discarded, a toast offers 元に戻す →
   `restoreThemeSnapshot()`
3. Components re-render; `AppShell` rebuilds `themeVars` (CSS variables ARE
   theme-driven at runtime — the static `:root` values are only first-frame
   fallbacks)
4. Persisted via `settings.theme_id` in `data.json`

## What Gets Themed

| Target | Source | Mechanism |
|--------|--------|-----------|
| xterm.js terminal | `theme.terminal.*` | `resolveTerminalTheme()` → ITheme (ANSI contrast floor pre-applied when a wallpaper disables xterm's own guard) |
| All UI chrome | `theme.chrome.*` + derived | `AppShell.themeVars` → CSS variables on the root element |
| Warning/accent text | derived | `--cmux-yellow` (status.waiting), `--cmux-accent-text` (AA-floored) |
| First frame | last theme | `localStorage["mycmux-boot-chrome"]` + inline script in `index.html` (`--cmux-boot-bg`) |

## Fine-tuning

`ThemeTweakPanel` (選んだテーマの微調整) overlays per-key colors, dark/light
tweak presets, background wallpapers, terminal font/size/line-height, and the
UI density setting (`uiDensity` — see `docs/design/typography-and-spacing.md`).

## Persistence

`data.json` `settings`: `theme_id`, `theme_tweaks`, `font_size`,
`line_height`, `font_family`, `ui_density`. Save + two hydrate sites live in
`SocketListener.tsx` (main window and child window — update both when adding
fields).
