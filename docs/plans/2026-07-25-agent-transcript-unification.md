# Agent transcript unification proposal

Date: 2026-07-25

## Decision

D-11 is not implemented in the current refactor. Its test-first prerequisite cannot be met without first defining selection policies: the three existing readers do not produce equivalent results for the same multi-file fixture.

No transcript parsing or selection behavior should move into a shared module until the policy differences below are represented explicitly.

## Current policies that must remain observable

### PTY monitor

Source: `src-tauri/src/pty/monitor/transcripts.rs`.

- Claude selection filters by normalized cwd, minimum creation time, and excluded session ids.
- Claude and claude-codex directories have an ordered fallback policy.
- Codex selection reads `session_meta`, filters date directories and cwd, and honors excluded ids.
- The output is a session id used by auto-resume and pane ownership logic. A permissive fallback can attach the wrong live session.

### Savepoint publish

Source: `src-tauri/src/commands/online_publish.rs`.

- An explicit requested session id is preferred when its transcript exists.
- The fallback selects the newest transcript by filesystem metadata.
- Claude and Codex have separate locator rules and diagnostics.
- The output is a source transcript copied into a savepoint bundle.

### Savepoint join and bundle inspection

Sources: `src-tauri/src/commands/online.rs` and `src-tauri/src/commands/online_publish.rs`.

- Bundle transcript lookup operates inside an already validated bundle.
- The existing lookup uses deterministic directory-entry ordering rather than the monitor's cwd/time/exclusion policy.
- The output is a bundle-owned transcript, not a live-session identity decision.

## Why a direct equivalence test is invalid

A fixture containing two valid JSONL files is enough to make the results diverge:

- the monitor can reject the newest file because its cwd does not match or its id is reserved;
- publish can select that same file by mtime;
- bundle lookup can select a different file by deterministic name order.

Asserting one result across all three implementations would silently choose a new canonical behavior for at least one call site. That violates the no-behavior-change constraint and the monitor auto-resume safety boundary.

## Safe staged implementation

1. Add fixture-based characterization tests separately for these policies:
   - Claude: matching and wrong cwd, malformed head, excluded newest id, minimum creation time.
   - Codex: `session_meta` id/cwd, nested date directories, malformed first record, excluded id.
   - Publish: explicit id hit/miss and mtime fallback.
   - Bundle: multiple transcript names and invalid bundle entries.
2. Introduce `src-tauri/src/agent_transcript.rs` with parsing primitives only:
   - read the first JSONL record with a byte limit;
   - decode Claude cwd;
   - decode Codex `session_meta` id and cwd;
   - return typed candidate metadata without selecting a winner.
3. Keep selection in caller-owned policy functions. The monitor retains cwd/time/exclusion rules; publish retains explicit-id/mtime rules; bundle lookup retains validated bundle ordering.
4. Migrate one caller per commit and rerun its existing characterization tests plus the four repository baseline commands.
5. Consider shared selection only after a product decision explicitly defines a single policy for live detection, publishing, and bundle inspection.

## Non-goals

- No JSONL schema change.
- No savepoint manifest or bundle-layout change.
- No auto-resume fallback change.
- No public command or frontend error-string change.
