# Typed error migration design

Date: 2026-07-25

## Scope and decision

This document proposes a typed internal error model for the Rust backend. It
does not authorize implementation or dependency changes. Existing Tauri return
strings, socket response strings, frontend event names, and user-visible copy
are compatibility contracts during the migration.

The first goal is structured internal classification and source retention. It
is not a rewrite of public errors and must not make frontend code branch on new
codes until a separately approved protocol version exists.

## Current contract

The backend commonly returns `Result<T, String>` from storage, PTY, socket,
savepoint, remote/auth, usage, filesystem, and command boundaries. Many inner
operations format an underlying error directly into the string. The frontend
then displays, logs, or matches those strings, and pytest pins selected event
names and literals such as `agent-restore-downgraded`.

Therefore all existing boundary strings are initially frozen. The migration
must inventory them with snapshots before changing an internal return type.
That inventory includes:

- every `#[tauri::command]` error result;
- socket JSON error responses and the 30-second response timeout path;
- remote HTTP and WebSocket error responses;
- savepoint Python/Rust twin messages and public CLI behavior;
- restore downgrade events and persistence failure prompts;
- usage authentication and reauthentication messages;
- contract-test literals and frontend comparisons.

## Proposed internal model

Introduce an internal `AppError` with a stable category, stable code, safe
public message, operation context, and a retained source error where available.
The exact Rust representation should use the standard error traits and existing
dependencies unless a later implementation proposal proves a dependency is
needed.

Conceptually:

```text
AppError {
  category: ErrorCategory,
  code: &'static str,
  public_message: PublicMessage,
  context: ErrorContext,
  source: Option<Box<dyn Error + Send + Sync>>,
}
```

`public_message` is not generated from `Debug` or the source chain. During the
compatibility phase it renders the exact legacy string for its boundary.
`context` may hold operation names and non-secret identifiers, but it is never
serialized automatically.

## Error taxonomy

### Storage

- codes: path resolution, lock acquisition, open/read/parse, serialize,
  temporary write, sync, atomic replace, quarantine, backup recovery;
- retryability distinguishes lock/contention and transient IO from invalid
  persisted data;
- public rendering preserves the current load/save strings and recovery
  behavior.

### PTY

- codes: session not found, create lock, spawn, attach/channel replace, input,
  resize, scrollback, kill, and transport/flow failures;
- reattach-vs-spawn meaning, lock order, attach epoch, wire frames, ACK policy,
  and queue limits remain outside the error migration.

### Socket

- codes: bind, port-file publication, invalid request, emit failure, missing or
  dropped frontend response, timeout, and response serialization;
- request ID, JSON response shape, emit route, pending-request cleanup, and the
  30-second timeout remain exact contracts.

### Savepoint

- codes: storage discovery, manifest validation, transcript lookup/digest,
  bundle lifecycle, publish/finalize, join, transfer, trash, restore, and purge;
- the Rust and Python implementations retain their synchronized public text,
  manifest schema, bundle layout, and dry-run cleanup behavior.

### Remote and authentication

- codes: token load/write/rotation, unauthorized request, bind/startup, remote
  session spawn, WebSocket bridge, and remote-state load;
- public responses must not expose tokens, headers, pasted OAuth codes, shell
  environment values, or filesystem details not already in the contract;
- bind defaults and authentication behavior do not change.

### Usage

- codes: credential location, keyring operation, OAuth state/code exchange,
  provider HTTP response, response parsing, account persistence, cooldown, and
  reauthentication;
- provider response bodies and credentials are retained only in redacted or
  bounded diagnostic context, never in public messages.

## Boundary compatibility

1. Inner modules may return `AppResult<T> = Result<T, AppError>`.
2. Each existing Tauri command keeps its current `Result<T, String>` signature
   initially and calls a command-specific legacy renderer at the outermost
   boundary.
3. Socket and remote adapters map `AppError` into the exact current response
   field, status, request ID, and string.
4. Events keep their current names and payloads. In particular, typed errors do
   not replace or rename `agent-restore-downgraded`.
5. Frontend IPC functions continue to receive the same rejection values. New
   discriminated unions require a separately versioned protocol and migration
   plan.
6. A legacy string snapshot test is added before each domain conversion. The
   test must cover success, each mapped category, and source-containing errors.

This adapter-first approach allows internal source chains and classification
without changing any public API. A generic `Display` implementation is not a
valid boundary mapper because the same internal error may have different
legacy wording at different commands.

## Observability and redaction

- Log the stable code, category, operation, and source chain at the point where
  the error is handled, not at every propagation layer.
- Keep public messages safe and stable; richer diagnostics go to stderr or the
  existing diagnostic channel only.
- Redact remote tokens, OAuth access/refresh tokens, authorization headers,
  pasted codes, environment values, transcript contents, terminal output, and
  arbitrary user file contents.
- Treat paths and session/account IDs as context with explicit allow/deny rules;
  do not derive a log record by serializing the whole error context.
- Preserve current bounded/truncated provider-response logging.
- Use one correlation identifier per command or socket request when available;
  never use a secret as the correlation value.
- Cleanup and best-effort failures remain non-fatal where they are non-fatal
  today, but receive a stable diagnostic code.

## Migration sequence

1. Build a generated or reviewed inventory of public error strings, event names,
   response shapes, and frontend string comparisons; add boundary snapshots.
2. Add the internal types and legacy renderer tests without converting a domain.
3. Convert storage leaf functions first. Keep command signatures and exact
   strings through adapters; verify corrupt-data and backup recovery fixtures.
4. Convert usage and remote/auth separately, starting at leaf modules and
   explicitly testing redaction.
5. Convert savepoint leaf operations one concern per commit. Run both Rust and
   Python contract suites after every slice.
6. Convert PTY operations only after reattach, attach-epoch, and transport tests
   fully pin the existing behavior.
7. Convert socket internals last, retaining the timeout helper and response path
   unchanged.
8. After all domains use typed internals, decide separately whether a versioned
   typed frontend error envelope has enough product value to justify a public
   protocol change. Until then, keep the legacy adapters.

Each slice is one domain concern per commit and must run TypeScript, Vitest,
Rust, and pytest baselines. Any public-string, status, payload, timeout, schema,
or test-count change stops the migration for review.

## Non-goals

- No implementation or package installation in Phase 6.
- No frontend copy, event, IPC signature, socket payload, or HTTP status change.
- No `PersistentData`, savepoint manifest, transfer, or remote protocol change.
- No behavior change to PTY lifecycle, locking, backpressure, or timeouts.
- No removal of useful source context and no logging of secrets.
- No repository-wide mechanical replacement of `Result<T, String>`.
- No new public error-code API without an explicit versioning decision.
