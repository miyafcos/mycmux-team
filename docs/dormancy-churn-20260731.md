# Dormancy churn investigation (2026-07-31)

## Scope and safety

The investigation used only the local read-only socket commands below. No pane input,
kill, restart, deploy, build, or tag operation was performed.

```powershell
python C:\Users\miyaz\cmux-for-linux-dev-master\scripts\mycmux_agent_cli.py panes --all
python C:\Users\miyaz\cmux-for-linux-dev-master\scripts\mycmux_agent_cli.py read --session <session-id> --lines 200
```

`pane.read` applies the raw PTY stream to an xterm buffer and returns logical terminal
lines. It does not expose the raw ANSI delta, so it can prove that raw bytes changed
without changing the logical screen, but cannot distinguish OSC title bytes from CSI
cursor/erase bytes.

## Measurements

### Baseline inherited from the handoff (09:35 JST)

Two samples 120 seconds apart found output advancement in 4 of 10 tabs. One hidden
Claude tab was already classified `agentStatus=idle` but advanced for the full 120
seconds. This directly demonstrated that the old `endOffset changed = activity` rule
could never reach its dormancy threshold for that tab.

### Independent read-only sampling in this session

The live app initially contained 8 Claude tabs: 2 mounted and 6 unmounted. All used
`C:\Users\miyaz\.local\bin\claude.exe` version `2.1.220.0`; all shared the same
global status line command, `node C:\Users\miyaz\.claude\statusline.mjs`.

135-second sampling (15-second cadence):

| group | tabs | `lastOutputAt` advanced | logical screen result |
|---|---:|---:|---|
| unmounted | 6 | 0 / 6 | unchanged |
| mounted | 2 | 2 / 2 | one meaningful change; one raw-only cosmetic change |

For the raw-only event (`b52d229f` suffix), `lastOutputAt` advanced by 229,795 ms at
the 60-second sample, while all 46 logical lines were byte-for-byte identical:

```text
all_same=true
changed_rows=0
history_same=true   # all logical lines except the last 24
tail_same=true      # last 24 logical lines
```

This is direct evidence that the child PTY emitted bytes which changed neither the
visible screen nor its logical history. The bytes are therefore cosmetic terminal
traffic (a redraw, cursor/erase sequence, title update, or identical text replay), not
user work or agent output.

A later 75-second sample at one-second cadence added two unmounted working Claude
tabs. Both advanced approximately every second and their full/history/tail logical
lines changed. This is meaningful agent work and confirms that unmounted sessions
cannot be assumed idle merely because their renderer is absent. An older unmounted
tab also produced one isolated event at second 59, so mounting is a correlation for
the observed idle group, not a universal cause.

A final 70-second sample of the old idle tab and an old unmounted/stale working tab
found no updates in either. The churn is therefore intermittent, not a fixed 60-second
timer. This matches the renderer lifecycle: active attach schedules resize, cache
attach performs a forced fit and frontend reattach resize, and ResizeObserver uses a
short burst of retries (`XTermWrapper.tsx`). A real PTY size change makes the child TUI
redraw. The best-supported trigger is therefore a Claude TUI redraw in response to a
mount/focus/resize lifecycle event; the exact ANSI/OSC payload remains unobserved.

## Source classification

Rust appends every successful PTY read to the raw scrollback and increments
`endOffset`; ANSI/OSC/cursor redraw bytes are not filtered
(`src-tauri/src/pty/session.rs`). Frontend xterm painting, metadata updates, ACKs, and
`pane.read` replay do not write to that backend scrollback. Therefore the churn is
child-side terminal output, with mycmux resize able to trigger it indirectly by asking
the child TUI to redraw.

The configured status line is time-varying and emits ANSI-decorated duration, cost,
quota, and version lines. It has no timer of its own: it reads one JSON object from
stdin, prints once, and exits. Claude decides when to invoke it. The status line was
present in both churning and non-churning tabs, and its cache update did not align
uniquely with the cosmetic event. It remains a plausible payload within a Claude TUI
redraw, but it is not established as the sole trigger.

Result by question:

- Raw cosmetic churn exists: **identified, high confidence**.
- Immediate source: **child TUI output into the PTY, high confidence**.
- Difference between observed idle groups: **mounted/cache-resident correlated in the
  first 135-second window; lifecycle mount/focus/resize is the strongest trigger, but
  not a universal condition**.
- Exact raw subtype (OSC title vs CSI redraw vs identical status-line replay):
  **not identified with the current read-only CLI**.
- Claude version or status-line presence as the mixed-population cause: **rejected**;
  both were common to all sampled Claude tabs.

## Adopted dormancy rule

The frontend now replays each scrollback snapshot through the existing headless xterm
path and computes SHA-256 over the complete logical terminal state. The three known
time-varying Claude status-line rows (context/cost, quota, and version/session) are
normalized before hashing; the rest of the current viewport remains in the
fingerprint. This preserves viewport-only real output while ignoring identical redraws
and known status-line clock changes. `endOffset` advancement with the same semantic
fingerprint is cosmetic and no longer resets `lastActivityAt`. A changed fingerprint,
frontend input, or foreground process-generation change resets the clock. An empty or
unparseable screen is unclassifiable and resets the clock (fail closed).

Kill/eviction remains blocked by visible or drag-source tabs, unknown process state,
real non-agent foreground work, fresh working/waiting screen state, active-screen
evidence (`esc to interrupt`, Codex `Working`, Claude orchestration, or running shell
commands), and canonical/legacy attention markers. Mounted candidates still receive
`evictCache`, never `kill`; a later sweep may kill only after they are unmounted and
all guards are rechecked. Threshold zero still exits before any sweep.

Potential actions are rechecked with a new scrollback snapshot, PTY metadata, another
final scrollback snapshot, final PTY metadata, and current frontend stores before a
kill. Immediately before `killSession`, metadata/process generation is checked again
and a final raw `endOffset` read must still equal the last semantic snapshot; any new
raw byte or frontend input aborts that sweep. This closes the prior window where
metadata could be checked against a reused scrollback snapshot.

The frontend cannot make the last observation and Rust `kill_session` atomic. A
same-process turn that starts silently in the few instructions after the final raw
offset check is a residual TOCTOU risk. Eliminating that gap requires a future Rust
compare-and-kill contract carrying expected session epoch, process generation, and
`endOffset`; Rust was read-only in this task. Within the permitted frontend boundary,
unknown metadata, process-generation changes, any intervening output/input, working
screen evidence, visibility, mounting, and attention all fail closed.
