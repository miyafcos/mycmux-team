# v0.57.0 Codex / mycmux performance investigation and remediation report

Date: 2026-08-24  
Implementer: Grok candidate, recovered after mycmux restarts  
Reviewer: Sol  
Worktree: `C:\Users\miyaz\cmux-for-linux-dev-master`

## Verdict

Source candidate: PASS  
Release build/deploy/live acceptance: NOT RUN

The recurring LiveBrief Codex transcript search was removed from the normal append hot path. A bound live transcript now advances through its cached exact path. Recursive discovery is retained for the initial bind and recovery after a missing path, incompatible binding, truncate, replacement, or failed cursor/anchor validation.

## Cause evidence

- Production mycmux PID 11996 tree, 10-second sample before the app restart:
  - about 5.44 logical cores
  - about 8.0 GB Working Set
  - 149 processes / 1,833 threads / 35,019 handles
- WebView2 subtree:
  - about 2.99 logical cores
  - about 2.51 GB Working Set
  - one renderer about 2.18 GB Working Set
- 10 Codex processes:
  - about 1.08 logical cores
  - about 3.61 GB Working Set
  - about 7.90 GB Private Bytes
- `C:\Users\miyaz\.codex\sessions`:
  - 24,451 JSONL files
  - about 49.7 GB
  - recursive enumeration observed at about 1.09–3.32 seconds depending on cache state
- Previous `C:\Users\miyaz\cmux-for-linux-dev-master\src-tauri\src\livebrief\mod.rs` flow called `locate_transcript()` before advancing a cached transcript whenever the file grew. Dashboard LiveBrief can poll at one-second cadence, multiplying the scan by growing Codex sessions.
- Secondary load remains outside this patch: many long-lived Codex processes, six simultaneously rendered Codex panes, WebView2 renderer/GPU load, terminal cache retention, 10-second full scrollback persistence, and Codex rollout monitoring.

## Changed file

- `C:\Users\miyaz\cmux-for-linux-dev-master\src-tauri\src\livebrief\mod.rs`
  - production resolver/refresh logic
  - append, unchanged, truncate, replacement, missing path, binding change, Claude compatibility, and synthetic-tree tests

Diff at review: 478 insertions / 33 deletions. Most additions are focused tests in the existing Rust test module.

No optional terminal-cache change was made because this task did not obtain a clean, isolated memory comparison proving the correct new cap.

## Performance proof

Synthetic tree fixture:

- 400 irrelevant JSONL files plus one target
- initial discovery: 42.79 ms, 401 JSONL visits
- ten successive appends: locator call count stayed at 1; re-enumerated JSONL visits stayed at 0
- ten append/advance operations: 328.76 ms total in the debug test build

On the real 24,451-file tree, the removed work is one recursive enumeration per growing bound session per poll. No release exe was built or deployed, so production CPU after/before is still pending.

## Sol validation

PASS:

```text
git diff --check -- src-tauri/src/livebrief/mod.rs
```

PASS after embedding `C:\Users\miyaz\cmux-for-linux-dev-master\src-tauri\tests.manifest` into the already-built debug Rust test executable using Windows SDK `mt.exe`:

```text
mycmux_lib-4814ba32eb183254.exe livebrief::tests:: --nocapture
29 passed; 0 failed

mycmux_lib-4814ba32eb183254.exe
867 passed; 0 failed; 8 ignored
```

PASS:

```text
npx tsc --noEmit
npx vitest run tests/unit/livebrief.test.ts tests/unit/liveBriefStorePolling.test.ts
2 files passed; 13 tests passed
```

The direct focused `cargo test` compiled and linked but could not start without the manifest (`STATUS_ENTRYPOINT_NOT_FOUND`, `0xc0000139`), matching the documented Windows harness issue. The authoritative release wrapper was then started; its RAM gate selected `-j 2`, but free physical RAM fell from 7.6 GB to 0.49 GB during compilation. Sol stopped that self-started build to avoid another app/system failure, embedded the same manifest into the existing debug test executable, and completed the full Rust suite there.

Repo-wide `cargo fmt --check` is not an applicable scoped gate because the existing checkout has extensive unrelated rustfmt drift. `git diff --check` passed for the changed file. The candidate preserves the pre-existing file style rather than formatting unrelated code.

## Protected concurrent work

The pre-existing v0.56.0 / bridge-CAS dirty files were not edited by this task:

- `C:\Users\miyaz\cmux-for-linux-dev-master\docs\agent-integration.md`
- `C:\Users\miyaz\cmux-for-linux-dev-master\scripts\mycmux_agent_cli.py`
- `C:\Users\miyaz\cmux-for-linux-dev-master\src-tauri\src\socket.rs`
- `C:\Users\miyaz\cmux-for-linux-dev-master\tests\test_agent_cli_socket_compat.py`
- `C:\Users\miyaz\cmux-for-linux-dev-master\tests\test_agent_cli_spawn_routing.py`
- `C:\Users\miyaz\cmux-for-linux-dev-master\tests\test_socket_api_contract.py`
- `C:\Users\miyaz\cmux-for-linux-dev-master\src-tauri\target-askq-final\`
- `C:\Users\miyaz\cmux-for-linux-dev-master\tests\test_mycmux_bridge.py`

## Remaining v0.57.0 gates

1. Finish v0.56.0 update activity and recover enough free RAM.
2. Run `python C:\Users\miyaz\cmux-for-linux-dev-master\scripts\run_windows_tests.py` without interruption.
3. Build with `npm run tauri build`; do not use a cargo-only product build.
4. Deploy only after explicit approval, then restart and compare the same 1/4/8/10-Codex workload.
5. Require production evidence for mycmux, WebView2 renderer/GPU, and Codex child CPU/memory separately.
6. Address remaining independent load in later patches: inactive/dormant session lifecycle, terminal cache memory, WebView2 rendering, scrollback full-save/fsync, and launcher/monitor transcript discovery.

