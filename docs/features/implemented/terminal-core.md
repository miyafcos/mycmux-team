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

Rust records exit when the reader reaches EOF (`Ok(0)`) or an error, or when
`Child::try_wait()` observes the direct child's exit. Child polling covers
Windows ConPTY pipes that remain open after the process ends.

1. The existing monitor polls each tracked PTY on every tick (10 seconds while
   visible, 20 seconds while hidden). An atomic guard reports the exit once:
   it ingests `Lifecycle::Exited` with the PTY epoch and emits `pty-exit-{session_id}`.
2. `XTermWrapper` writes one dim notice per session start:
   `[プロセスは終了しました。このペインを閉じるか、新しいペインを開いてください]`,
   then invokes `onExit` if supplied.
3. The PTY and its last screen remain available for reattach until the user
   closes the tab. Reattach does not revive its lifecycle; only a new PTY epoch
   can do that. `is_alive` still means tracked, while `is_running` excludes exits.
4. There is no automatic restart or Restart overlay. Open a new launcher tab
   to start a fresh process.

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

## ペイン掃除

[ペイン掃除](tab-sweep.md)で、終了済みのペインや、ペインの外で動き続けているプロセスを確認できます。
