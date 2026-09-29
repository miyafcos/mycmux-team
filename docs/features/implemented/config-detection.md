# Terminal Config Detection

## Overview

On startup, `terminal_config.rs` reads the user's native terminal configuration to match font family, font size, and color palette. This makes mycmux look like the user's existing terminal.

## Detection Order

```
ghostty → alacritty → kitty → Windows Terminal (Windows only) → system defaults
```

First match wins for each property. Font and colors can come from different sources:
- **Font**: First terminal with a configured font
- **Colors**: First terminal with explicit palette entries

## Config File Paths

| Terminal | Config Path | Theme Path |
|----------|-----------|------------|
| Ghostty | `<config_dir>/ghostty/config`; macOS also `~/Library/Application Support/com.mitchellh.ghostty/config` | Via `config-file` directive |
| Alacritty | `<config_dir>/alacritty/alacritty.toml` | Linux only: `~/.config/omarchy/current/theme/alacritty.toml` |
| Kitty | `<config_dir>/kitty/kitty.conf` | Inline in config |
| Windows Terminal | `%LOCALAPPDATA%/Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json` (then the `Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe` package) | `profiles.defaults.colorScheme` selects a `schemes` entry |

`<config_dir>` is `dirs::config_dir()`: `%APPDATA%` on Windows, `~/Library/Application Support` on macOS, and `$XDG_CONFIG_HOME` or `~/.config` on Linux.

## Ghostty Parser

Reads key-value pairs (`key = value`):
- `font-family` → font family name
- `font-size` → float
- `config-file` → loads included theme file (supports `?` optional prefix)
- `background`, `foreground` → hex colors
- `palette = N=#rrggbb` → ANSI color N (0-15)

## Alacritty Parser

TOML-style sections:
- `[font.normal]` → `family` key
- Root → `size` key
- `[colors.primary]` → `background`, `foreground`
- `[colors.normal]` → 8 color names (black, red, green, ...)
- `[colors.bright]` → 8 bright color names

On Linux, checks the omarchy theme file first, then the main config.

## Kitty Parser

Simple key-value:
- `font_family` → font family
- `font_size` → float
- `background`, `foreground` → hex colors
- `color0` through `color15` → ANSI colors

## Fallback Defaults

```rust
TerminalUserConfig {
  font_family: system_monospace_font(), // platform default
  font_size: 14.0, // load() fallback; TerminalUserConfig::default() uses 15.0
  colors: UserColors::default(),        // One Dark-ish palette
}
```

`system_monospace_font()` uses Cascadia Mono on Windows, Menlo on macOS, and `fc-match monospace --format=%{family}` on Linux.

## Font Size Scaling

Native terminals use physical pixels; Tauri webview uses CSS pixels. XTermWrapper applies:

```typescript
const scaled = rawSize < 12 ? Math.round(rawSize * 1.6) : rawSize;
const fontSize = Math.max(14, scaled);
```

Example: Ghostty `font-size = 9` → `Math.round(9 * 1.6) = 14` → `Math.max(14, 14) = 14px`

## Caching

Config is loaded once and cached globally in XTermWrapper:
```typescript
let cachedConfig: { theme: ITheme; fontSize: number; fontFamily: string; windowsBuildNumber: number | null } | null = null;
```

`preloadTerminalConfig()` is called at module level in `App.tsx` to start the fetch before any terminal mounts.
