# crsm-core (vendored)

`src-tauri/crates/crsm-core` is a copy of the `crsm-core` crate from the crsm
repository, not a crates.io dependency. mycmux builds the session index itself
instead of shelling out to a `crsm` binary: on macOS the GUI app starts from
launchd's minimal `PATH` and never found one, so "続きから" and ⌘P were empty on
that machine no matter where the CLI was installed.

| | |
|---|---|
| Upstream | `https://github.com/miyafcos/crsm` (working copy: `C:\Users\miyaz\crsm`) |
| Crate | `crates/crsm-core` |
| Commit | `b5f5be2` ("fix(list): hide headless exec and handoff sessions from the default list") |
| Imported | 2026-09-17 |
| Licence | MIT (declared in the crate manifest), authored by 宮崎 詠富 — the same author as mycmux |

## Local modifications

`src/**` and `tests/**` are byte-identical to upstream except for `src/sessions.rs`,
which carries three changes. `Cargo.toml` is rewritten (see below).

1. **`spawn_background_refresh` is behind the `spawn-refresh` feature (off by
   default).** Upstream re-executes `std::env::current_exe()` with
   `list --refresh --all --limit 1`. Inside mycmux `current_exe()` is the app, so
   a stale cache would relaunch mycmux. With the feature off the function is an
   empty stand-in and `src-tauri/src/commands/crsm.rs` runs the rescan in-process
   on the blocking pool.
2. **`unset_std_handle_inheritance` is gated on that feature too** (it only ever
   served the spawn path; leaving it ungated is a dead-code warning on Windows).
3. **`CACHE_FRESH_TTL_SECS` is `pub`** so the host applies the same 60-second
   threshold as upstream when deciding to rescan.

`Cargo.toml` changes, both forced by the move out of crsm's workspace:

- `edition` / `license` / `version` were `*.workspace = true`; mycmux has no
  workspace table, so they are spelled out (`2021` / `MIT` / `0.1.0`).
- The `=x.y.z` dependency pins were relaxed to caret ranges at the same minimum
  versions. This crate now shares `src-tauri/Cargo.lock`, where holding the exact
  pins would build a second chrono, serde_json and thiserror next to the ones the
  app already links.

## Updating

1. Pull the new commit in the crsm working copy and note its SHA.
2. Copy `Cargo.toml`, `src/**` and `tests/**` over this directory.
3. Re-apply the three `sessions.rs` edits and the `Cargo.toml` rewrite above
   (`git diff` against the previous vendored tree shows them).
4. Update the commit and date in the table.
5. `cargo check --lib` and `cargo test --lib` in `src-tauri`, plus
   `cargo test --manifest-path crates/crsm-core/Cargo.toml` for this crate's own
   smoke tests, then check the launcher's 続きから list and ⌘P by hand.

The standalone `--manifest-path` run in step 5 writes `target/` and `Cargo.lock`
here, neither of which the repository's `.gitignore` covers yet. Delete them
before releasing: `build-personal.ps1` aborts on any untracked file. Building
from `src-tauri` does not leave them — that goes to `src-tauri/target`.

Do not edit the vendored sources for mycmux-only behaviour: fix it upstream and
re-import, or the next update silently reverts it.
