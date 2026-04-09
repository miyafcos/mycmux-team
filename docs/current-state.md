# mycmux Current State

This file is the handoff note for future Codex / Claude sessions.

## Source of Truth

- Running local app: `C:\Users\miyaz\mycmux-app\mycmux.exe`
- Active source repo: `C:\Users\miyaz\cmux-for-linux-dev`
- Runtime data: `C:\Users\miyaz\.mycmux`
- Git remote (origin): `https://github.com/miyafcos/mycmux.git`

## Current Version

- Product version: `0.2.0`
- This version is intended to match the currently used local build.

## Recent Included Work

- Remote Terminal dashboard via WebSocket
- Monitoring existing sessions from iPhone / browser
- `Shift+Enter` fix for Kitty-style handling
- New themes: Berry Cream, Ocean Mist, Matcha Latte

## Build and Deploy

From `C:\Users\miyaz\cmux-for-linux-dev`:

```powershell
cmd /c npm run build
cargo check --manifest-path "C:\Users\miyaz\cmux-for-linux-dev\src-tauri\Cargo.toml"
powershell -ExecutionPolicy Bypass -File "C:\Users\miyaz\cmux-for-linux-dev\deploy-update.ps1"
```

## Naming Policy

- Public name: `mycmux`
- Current package/app version: `0.2.0`
- Legacy names `ptrterminal` / `ptrcode` may still appear in older docs, old build artifacts, and migration cleanup code.

## High-Change Areas

- `src-tauri/src/remote/**`
- `src-tauri/src/pty/monitor.rs`
- `src/components/terminal/XTermWrapper.tsx`
- `src/components/theme/themeDefinitions.ts`

## Verification Baseline

- Frontend: `cmd /c npm run build`
- Rust: `cargo check`

## Recommended Prompt for the Next Session

Use `C:\Users\miyaz\cmux-for-linux-dev` as the source of truth for mycmux.
The currently running local mycmux is the latest correct version.
Read `C:\Users\miyaz\cmux-for-linux-dev\docs\current-state.md` first, then inspect uncommitted changes and continue development without reverting existing work.
