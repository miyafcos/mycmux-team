# Terminal runtime decomposition design

Date: 2026-07-25

## Scope and decision

This document proposes a staged decomposition of `XTermWrapper.tsx` and
`SocketListener.tsx`. It does not authorize implementation. The first code
change must be preceded by characterization tests and approved as a separate
refactor.

The target is smaller ownership boundaries without changing terminal data
flow, restore behavior, focus arbitration, persistence, or socket protocol.

## Current responsibilities

### XTermWrapper

`src/components/terminal/XTermWrapper.tsx` currently combines:

- terminal lifecycle: create, cache reuse, mount, detach, dispose, resize, and
  visibility updates;
- renderer management: DOM/WebGL selection, failure fallback, theme, font,
  opacity, and contrast;
- output ingestion: binary frame decoding consumers, attach-epoch gating,
  deferred-batch ordering, ACK timing, and write diagnostics;
- scrollback recovery: snapshot fetch, offset reconciliation, truncation
  recovery, raw-tail replacement, and replay into an empty terminal;
- input behavior: keyboard routing, paste, Shift+Enter selection, mouse-report
  filtering, wheel handling, and focus coordination;
- buffer export: logical-line extraction, snapshot cleanup, agent-output
  heuristics, and live-output checks;
- component UI: search state and search controls.

### SocketListener

`src/components/layout/SocketListener.tsx` currently combines:

- window leader election and leader-only bootstrap;
- persisted-data load, normalization, startup restore, autosave hold, dirty
  subscriptions, debounce, close-time flush, and save-failure prompts;
- filesystem-change event handling and file-explorer invalidation;
- socket request dispatch and frontend response emission;
- PTY metadata mirroring and terminal snapshot capture;
- agent-session mapping reconciliation, duplicate-ownership arbitration,
  suppression, fallback, and persistence normalization;
- application event listeners that bridge backend state into frontend stores.

## Proposed extraction units

### Terminal runtime

1. `terminalRenderer.ts`
   - `buildThemeFromConfig`, opacity/contrast helpers;
   - WebGL enable, dispose, failure tracking, and renderer application;
   - no React state and no PTY calls.
2. `terminalBufferExport.ts`
   - buffer-line extraction and cleanup;
   - live-output and snapshot heuristics;
   - read-only access through an explicit terminal lookup function.
3. `terminalInputRuntime.ts`
   - command/process input policy, Shift+Enter sequence, keyboard and paste
     filters, mouse-report policy, and wheel attachment;
   - focus remains delegated to `focusController`; the extraction must not
     introduce another `.xterm-helper-textarea` or `focusSessionSoon` owner.
4. `terminalScrollbackRuntime.ts`
   - scrollback snapshot fetch and offset reconciliation;
   - truncated-tail recovery and synchronization serialization;
   - returns explicit recovery outcomes; it does not own component state.
5. `terminalOutputRuntime.ts`
   - attach-epoch validation, deferred-batch queue, ordered writes, ACK calls,
     write counters, and gap-triggered recovery coordination;
   - accepts injected terminal/write/recovery ports so ordering is testable.
6. `useTerminalRuntime.ts`
   - owns create/cache/reuse/detach/dispose lifecycle and wires the modules;
   - `XTermWrapper.tsx` becomes the React view plus search UI.

### Socket and persistence runtime

1. `workspacePersistenceCodec.ts`
   - pure normalization and `Workspace` to `WorkspaceConfig` conversion;
   - ephemeral launch environment filtering;
   - no store reads inside pure functions.
2. `agentSessionArbitration.ts`
   - mapping application, duplicate winner selection, suppression, and
     conflict reporting inputs;
   - preserves current first-winner and active-tab fallback rules.
3. `useWindowLeadership.ts`
   - leader claim and leader-only bootstrap state;
   - exposes leadership state without moving persistence work into followers.
4. `useWorkspacePersistence.ts`
   - load, restore, autosave hold, dirty subscriptions, debounce, close-time
     flush, and user-visible save-failure paths;
   - consumes the codec and arbitration functions through explicit ports.
5. `useFilesystemEvents.ts`
   - filesystem change listeners and file-explorer invalidation only.
6. `useSocketCommandBridge.ts`
   - socket request mapping, command dispatch, and the exact response emission
     path expected by `src-tauri/src/socket.rs`;
   - does not change the 30-second backend timeout or request identifiers.
7. `SocketListener.tsx`
   - composition-only component that mounts the hooks in the current order.

## Contract pins required before moving code

Add behavior tests before the extraction that prove:

- terminalCache FE-N1: a mounted slot evicted from the cache is disposed at
  unmount and is never re-cached;
- attach epoch: output from an old epoch is rejected, and the epoch commits
  only after backend attach succeeds;
- deferred batches: frames are written and acknowledged in the current order,
  including a gap and concurrent scrollback synchronization;
- focus: `focusController` remains the only focus arbiter and inactive pointer
  focus retains its current exception behavior;
- wheel and scrollback: alternate-screen mouse reporting, user scroll
  position, gap recovery, truncated snapshots, and bottom-follow behavior are
  unchanged;
- buffer export: wrapped-line joining, initial-replay exclusion, maximum scan
  limits, and replacement-character rejection remain byte-for-byte stable;
- socket command response: success, error, missing handler, dropped receiver,
  and backend timeout preserve request IDs and response shape;
- leadership: only the claimed leader loads and saves; followers do neither;
- restore and persistence: startup autosave hold, mapping reconciliation,
  duplicate arbitration, active workspace/pane/tab fallback, ephemeral env
  stripping, close-time flush, and save-failure prompts remain unchanged;
- filesystem events continue to invalidate the same roots and stores.

Existing pytest source pins are part of the contract. A path-only assertion
update is allowed only in the same commit as the corresponding pure move;
assertion meaning and pinned literals must not change.

## Migration sequence

1. Add the characterization tests above without moving production code.
2. Extract pure renderer and buffer-export functions, one unit per commit.
3. Extract input helpers while keeping focus ownership and listener order.
4. Extract scrollback recovery, then output ingestion; each commit is a literal
   move plus imports and must preserve attach-epoch and ACK ordering.
5. Extract terminal lifecycle only after the lower-level modules are stable.
6. Extract persistence codec and agent-session arbitration as pure functions,
   one unit per commit.
7. Extract filesystem and socket hooks independently.
8. Extract leadership and persistence orchestration last, preserving hook mount
   order and leader-only side effects.
9. Reduce the two original components to composition facades only after every
   caller and contract pin has migrated.

Every step must run TypeScript, Vitest, Rust, and pytest baselines. A decrease
in test count or any changed public string, payload, timeout, ordering rule, or
persisted schema stops the migration.

## Non-goals

- No implementation in Phase 6.
- No terminal wire, ACK, queue-size, scrollback-size, or timeout change.
- No attach-epoch, focus, cache, renderer default, or input-policy redesign.
- No `PersistentData`, socket payload, or agent-session mapping schema change.
- No leader-election, remote authentication, bind, or save cadence change.
- No store merge or rename.
- No UI, theme, search, or notification redesign.
