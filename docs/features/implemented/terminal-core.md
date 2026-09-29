# Terminal Core

## xterm.js Setup

Each terminal pane runs an `XTermWrapper` component that manages a full xterm.js lifecycle:

```typescript
new Terminal({
  cursorBlink: activePaneId === sessionId,
  cursorStyle: "block",
  fontSize: 14,              // default; explicit prop/store overrides detected config
  fontFamily: "'...'",       // explicit prop/store, then detected config
  letterSpacing: 0,
  lineHeight: 1.35,          // default; themeStore setting
  scrollback: 5000,
  allowTransparency: true,
  smoothScrollDuration: 0,   // instant scroll
  rescaleOverlappingGlyphs: true,
  customGlyphs: true,
});
```

## Addons Loaded

| Addon | Purpose |
|-------|---------|
| `FitAddon` | Auto-resize terminal grid to container dimensions |
| `WebLinksAddon` | Make URLs in terminal output clickable |
| `WebglAddon` | GPU-accelerated rendering (falls back to DOM) |
| `SearchAddon` | In-terminal text search |
| `Unicode11Addon` | Unicode 11 character-width handling |

WebGL addon includes context loss recovery — disposes and falls back on `onContextLoss`.

## PTY Connection

- **Binary streaming**: Tauri raw binary IPC delivers `MCX1` output / `MCS1` snapshot frames, decoded by `terminalWire.ts`
- **Reader thread**: OS thread (not tokio), 4KB blocking reads
- **Writer**: `term.onData()` and `term.onBinary()` → `writeToSession()` invoke
- **Environment**: `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=ptrterminal` (legacy compatibility), `MYCMUX_TERM_PROGRAM=mycmux`

## Resize Handling

```
ResizeObserver on container
  → coalesced resize burst at 24 / 100 / 240ms (deferred during IME composition)
    → fitAddon.fit()
      → resizeSession(sessionId, term.cols, term.rows)
        → Rust: master.resize(PtySize)
```

## Process Exit

When the reader thread returns `Ok(0)` or an error:
1. Rust emits `pty-exit-{session_id}` event
2. `XTermWrapper` receives `onPtyExit()` and invokes `onExit` if supplied
3. Current `TerminalPane` supplies no `onExit` callback or Restart overlay; open a new launcher tab to start a fresh process

## Config Detection

Terminal font/colors are auto-detected from the user's native terminal config on first load. The config is cached globally; explicit font settings and the selected app theme take precedence.

See [config-detection.md](config-detection.md) for detection details.

## Scrollback

- Buffer: 5000 lines
- Smooth scroll: disabled (duration = 0)
- Viewport overflow: hidden (CSS override)

## Performance

- `memo()` wrapping prevents unnecessary re-renders
- Renderer lifecycle follows the session and launch configuration
- Config loaded once, cached globally
- Background approval scanning throttled to 300ms
- Only the active terminal tab mounts `XTermWrapper`; inactive tabs keep backend PTYs and can reuse cached terminals/scrollback on reattach
