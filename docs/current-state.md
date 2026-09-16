# mycmux Current State

This file is the handoff note for future Codex / Claude sessions. Verify the live checkout before relying on historical plan documents.

## Source of Truth

The production source is the `master` branch in:

`C:\Users\miyaz\cmux-for-linux-dev-master`

| Role | Location |
|---|---|
| Private source | `miyafcos/mycmux` (`origin`) |
| Public mirror | `miyafcos/mycmux-team` (`public`), `master` |
| Installed executable | `%LOCALAPPDATA%\mycmux\mycmux.exe` |
| Runtime data (Windows) | `%APPDATA%\com.miyazaki.mycmux\data.json` |
| Installed application (macOS) | `/Applications/mycmux.app` |
| Runtime data (macOS) | `~/Library/Application Support/com.miyazaki.mycmux/data.json` |
| Socket and local integration data | `C:\Users\miyaz\.mycmux` |

The former lite worktree and `release/public-lite` distribution were retired on 2026-07-23. Do not cherry-pick or port changes to lite. The public repository is updated with a history-isolated sync commit; never push the private branch history directly to `public`.

Upstream reference: `cai0baa/cmux-for-linux`.

## Current Version

The current released version is **v0.64.0** (2026-09-06 changelog; checkout audited at `6b49f3db` on 2026-09-07; confirm against `package.json`). These five version surfaces must match:

- `package.json`
- `package-lock.json` (root and `packages[""]`)
- `src-tauri\tauri.conf.json`
- `src-tauri\Cargo.toml`
- the `mycmux` entry in `src-tauri\Cargo.lock`

`tests\test_version_consistency.py` enforces this contract.

## Architecture

- Backend: Tauri v2 and Rust under `src-tauri\src`
- Frontend: React 19, Zustand, and xterm.js under `src`
- Terminal transport: binary `MCX1` / `MCS1` frames decoded by `src\lib\terminalWire.ts`
- Persistence: `src-tauri\src\db\storage.rs` atomically maintains `data.json`
- Agent integration: `scripts\mycmux_agent_cli.py` over the loopback TCP socket documented in `docs\agent-integration.md`
- Savepoints: Rust commands and `scripts\savepoint_publish.py`, `scripts\savepoint_join.py`, and `scripts\savepoint_cleanup.py` are paired implementations and must remain schema-compatible

## Load-Bearing Contracts

- Keep the three-layer ephemeral environment defense synchronized: startup cleanup in `src-tauri\src\lib.rs`, `sanitize_launch_env` in `src-tauri\src\commands\terminal.rs`, and `EPHEMERAL_LAUNCH_ENV_KEYS` in `src\components\layout\SocketListener.tsx`.
- Preserve the sync Tauri command allowlist in `tests\test_command_sync_contract.py`.
- Preserve `MCX1` / `MCS1`, FrontendFlow limits and ACK discipline, and the attach-epoch two-phase commit.
- Keep `focusController.ts` as the focus arbiter. Do not distribute direct terminal focus behavior across components.
- Preserve the `SessionManager::create` reattach-before-spawn branch for existing session IDs.
- Preserve savepoint path validation, atomic swap order, checkpoint/head/final lifecycle, and Python-Rust bundle compatibility.
- Keep all five version surfaces synchronized.

## Build and Deploy

Run the verification baseline, then build from your repository checkout:

```powershell
Set-Location "<path-to-checkout>"
npm run tauri build
```

Do not use `cargo build` as an application build; it omits the frontend bundle.

The Windows installed executable is `%LOCALAPPDATA%\mycmux\mycmux.exe`; `C:\Users\miyaz\mycmux-app\mycmux.exe` is a local mirror and may lag behind updater-managed installs. Deployment must back up the installed executable before replacement and verify that the built and installed SHA256 values match after restart.

## Release and Public Mirror

1. Update the five version surfaces and `CHANGELOG.md`.
2. Run the full verification baseline below.
3. Build release assets from the verified checkout; keep the version and supported platforms consistent across the release and updater metadata.

## Verification Baseline

Run from the repository root on Windows:

```powershell
npx tsc --noEmit
npx vitest run
python scripts/run_windows_tests.py
python -m pytest tests/
```

Do not run bare `cargo test --release` on Windows: the test harness exe lacks the Common Controls v6 manifest and dies with `STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)` before running a single test. `scripts/run_windows_tests.py` builds with `--no-run`, embeds `src-tauri/tests.manifest` via mt.exe, and executes the harness directly; CI uses the same script (made permanent 2026-08-05).

Record each command's exit status and current test totals; historical counts are not the acceptance baseline for a newer checkout.

## Working Practices

- Start with `git status --short` and keep each commit to one concern.
- Do not run workspace-wide `cargo fmt`; inspect `git diff --numstat` before every commit.
- Keep Japanese and space-containing paths unchanged and quote them in commands.
- Build only with `npm run tauri build` when an executable is required.
- Use `CHANGELOG.md` and `docs\plans\` for historical detail, but verify claims against the live code.

## Next Session

Read this file, `CLAUDE.md`, and the active task specification first. Confirm the current branch, worktree diff, installed executable, and verification baseline before changing code. Treat the environment sanitizer, terminal transport, attach epoch, focus controller, session reattach branch, and savepoint lifecycle as protected contracts.
