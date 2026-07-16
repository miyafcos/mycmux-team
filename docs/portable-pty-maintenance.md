# portable-pty Vendor Maintenance

mycmux ships its own copy of `portable-pty 0.8.1` under `src-tauri/vendor/portable-pty-0.8.1/` (referenced from `Cargo.toml` via a path patch). This note explains why, and how to keep that copy current.

## Why we vendor it

- Upstream `portable-pty 0.8.x` does not expose `creation_flags()` on `CommandBuilder`, so on Windows the spawned child briefly shows a console window before mycmux suppresses it via `windows_console::suppress_spawn_flash()`. We may want to patch the vendor copy to set `CREATE_NO_WINDOW` directly at spawn time.
- Locally vendoring also lets us cherry-pick upstream fixes faster than waiting for a crates.io release.

## Sync workflow (when upstream releases a new version)

1. Pin the target upstream commit:
   ```powershell
   git -C C:\Users\miyaz\portable-pty fetch --tags
   git -C C:\Users\miyaz\portable-pty checkout v0.X.Y
   ```
   (clone `https://github.com/wez/wezterm.git` if you do not already have a local mirror; portable-pty lives in that monorepo)
2. Diff against the vendored copy:
   ```powershell
   diff -ruN src-tauri\vendor\portable-pty-0.8.1 C:\Users\miyaz\portable-pty\pty
   ```
3. Cherry-pick upstream fixes file-by-file. **Do not** wholesale-replace the vendor directory — local patches (e.g. `CREATE_NO_WINDOW` work, if added) would be lost.
4. Bump the vendor directory name (`portable-pty-0.8.2/` etc.) and update the `Cargo.toml` `[patch."https://crates.io"]` entry to point at the new path.
5. Verify both worktrees compile:
   ```powershell
   cd C:\Users\miyaz\cmux-for-linux-dev-master
   cargo check --manifest-path src-tauri\Cargo.toml
   cargo test  --manifest-path src-tauri\Cargo.toml --lib

   cd C:\Users\miyaz\cmux-for-linux-dev
   cargo check --manifest-path src-tauri\Cargo.toml
   ```
6. Smoke test PTY spawn on Windows:
   - Open a fresh pane → confirm no console-window flash (or only sub-frame)
   - `Get-Process | Where-Object Path -like '*mycmux*'` should not show stray cmd.exe / pwsh.exe descendants

## Known patch points

| File | Patch | Reason |
|------|-------|--------|
| `src/win/conpty.rs` | (TODO) Set `CREATE_NO_WINDOW` in the lpStartupInfoEx flags before `CreateProcessW` | Eliminate the spawn-flash that `suppress_spawn_flash()` mops up after the fact |

(Currently the table is mostly TODO — add patches here as we land them.)

## Why not just upgrade to a published 0.9.x?

`portable-pty` follows wezterm's release cadence and does not separately publish patch releases. The 0.8.x line is what the rest of the wezterm ecosystem (terminal emulators, shells, embedded ConPTY users) is on. Jumping major versions risks breaking the `MasterPty` / `Child` trait surface we depend on. Vendoring keeps us free to pick fixes while staying API-compatible.
