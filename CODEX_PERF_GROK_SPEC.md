# Codex on mycmux performance remediation — Grok implementation spec

## Roles

- Implementer: Grok, working in the visible mycmux pane/tab created for this task.
- Reviewer/acceptance owner: Sol (parent session). Do not self-approve delivery.
- Worktree: `C:\Users\miyaz\cmux-for-linux-dev-master`

## Goal

Remove the recurring Codex transcript full-tree scan from the LiveBrief hot path without changing transcript correctness. If and only if measurement shows a clear memory win with no restore regression, reduce inactive xterm cache retention as the optional P1.

## Baseline evidence (2026-08-24)

- Production mycmux root PID 11996 tree: 10-second sample about 5.44 logical cores, Working Set about 8.0 GB.
- WebView2: about 2.99 logical cores; one renderer about 2.18 GB Working Set.
- 10 Codex processes: about 1.08 logical cores, about 3.61 GB Working Set.
- `C:\Users\miyaz\.codex\sessions` contains 24,451 JSONL files and about 49.7 GB.
- A recursive enumeration takes about 1.09–3.32 seconds depending on cache state.
- `C:\Users\miyaz\cmux-for-linux-dev-master\src-tauri\src\livebrief\mod.rs` currently checks whether the prior snapshot is unchanged, but when the same transcript has grown it calls `locate_transcript()` before advancing the already-known `prior.cursor.path`. Dashboard polling can therefore recurse the whole Codex tree once per growing session per poll.

## Existing dirty worktree — protected

The following pre-existing edits are owned by another task. Do not edit, format, revert, stage, or commit them:

- `C:\Users\miyaz\cmux-for-linux-dev-master\docs\agent-integration.md`
- `C:\Users\miyaz\cmux-for-linux-dev-master\scripts\mycmux_agent_cli.py`
- `C:\Users\miyaz\cmux-for-linux-dev-master\src-tauri\src\socket.rs`
- `C:\Users\miyaz\cmux-for-linux-dev-master\tests\test_agent_cli_socket_compat.py`
- `C:\Users\miyaz\cmux-for-linux-dev-master\tests\test_agent_cli_spawn_routing.py`
- `C:\Users\miyaz\cmux-for-linux-dev-master\tests\test_socket_api_contract.py`
- `C:\Users\miyaz\cmux-for-linux-dev-master\src-tauri\target-askq-final\`
- `C:\Users\miyaz\cmux-for-linux-dev-master\tests\test_mycmux_bridge.py`

Do not touch `.env`, credentials, tokens, or user session JSONL contents. Do not kill or restart running processes. Do not install packages. Do not commit or push.

## P0 required change: cached transcript path fast path

Primary file:

- `C:\Users\miyaz\cmux-for-linux-dev-master\src-tauri\src\livebrief\mod.rs`

Required behavior:

1. When a prior snapshot has a bound transcript path and the same binding still applies, use that exact path directly for metadata and `advance_transcript_with_history()`.
2. A normal append/growth of the same file must not call the recursive `locate_transcript()` path.
3. Recursive discovery remains allowed only for initial binding or a safe recovery case such as missing path, incompatible binding, or confirmed file replacement/identity mismatch that cannot be advanced safely.
4. Preserve correct behavior for unchanged files, append, truncate, replacement, missing files, Claude transcripts, Codex transcripts, service epoch, event IDs, cursor offsets, and transcript history.
5. Do not trade correctness for a forever-stale cached path. The recovery rule must be explicit and tested.

Add focused Rust tests in the existing LiveBrief test module or a narrowly-scoped adjacent module. Tests must prove at minimum:

- repeated growth/append of one cached Codex transcript performs discovery only on the initial bind;
- unchanged cached transcript remains a memory/metadata fast path;
- truncate or replacement recovers safely;
- missing cached path falls back to discovery;
- session binding change does not reuse the old path;
- semantic events and cursor advancement remain correct.

Prefer a small pure resolver/helper or injected locator closure in tests over global counters or sleeps. Avoid broad refactors.

## P0 performance proof

Create a deterministic test or micro-benchmark that uses a temporary synthetic Codex session tree with many irrelevant JSONL files and one growing target. It must report or assert that, after initial discovery, 10 successive appends do not re-enumerate the tree. Do not read the user's real session contents for the test.

Record before/after evidence in:

- `C:\Users\miyaz\cmux-for-linux-dev-master\REPORT_CODEX_PERF_GROK.md`

Include commands, timings/counters, changed files, and limitations. A correctness-only PASS is insufficient.

## P1 optional: inactive terminal cache memory

Relevant files:

- `C:\Users\miyaz\cmux-for-linux-dev-master\src\components\terminal\terminalCache.ts`
- `C:\Users\miyaz\cmux-for-linux-dev-master\tests\unit\terminalCacheEviction.test.ts`

Current `MAX_CACHED_TERMINALS` is 12. You may reduce or make this cap adaptive only if a deterministic heap/object-count proxy or repeatable process-memory measurement demonstrates a material reduction and the existing eviction/restore/input-order tests remain green. Do not change the cap on intuition alone. If evidence is inconclusive, leave P1 untouched and say so in the report.

Do not implement batch coalescing, scan scheduler changes, resize changes, launcher changes, scrollback persistence changes, process cleanup, or dormancy policy in this task.

## Required validation

Run the narrowest tests first, then:

```powershell
Set-Location -LiteralPath 'C:\Users\miyaz\cmux-for-linux-dev-master'
cargo test --manifest-path 'C:\Users\miyaz\cmux-for-linux-dev-master\src-tauri\Cargo.toml' livebrief
python 'C:\Users\miyaz\cmux-for-linux-dev-master\scripts\run_windows_tests.py'
npx tsc --noEmit
```

If P1 is changed, also run:

```powershell
npx vitest run 'C:\Users\miyaz\cmux-for-linux-dev-master\tests\unit\terminalCacheEviction.test.ts'
```

Do not claim release/live acceptance. Sol will inspect the diff, rerun gates, and decide whether to build/deploy for live measurement.

## Deliverables and stop boundary

1. Minimal source/test changes for P0, optional evidence-backed P1 only.
2. `C:\Users\miyaz\cmux-for-linux-dev-master\REPORT_CODEX_PERF_GROK.md`
3. Write `C:\Users\miyaz\cmux-for-linux-dev-master\DONE_CODEX_PERF_GROK.md` last, containing changed files, exact passed/failed commands, performance result, and remaining risks.

After writing DONE, stop. Do not commit, push, build a release, deploy, restart, close panes, or kill processes.
