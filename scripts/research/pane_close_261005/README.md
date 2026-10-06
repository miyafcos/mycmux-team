# S5 pane-close acceptance, 2026-10-05

This bounded replay copies the S4 fixture, counter, CDP client, hidden desktop
host and UI actions. Original source hashes are recorded in the S5 evidence
folder. The host validates the S5 lease, fresh `s5...` profile, binary hash,
CDP port 9380-9389, launch RAM and periodic RAM/lease checks. It stops only
owned PID/birth-time pairs. Tokens are used only for own-profile authentication.

Before/after use the same script and repetitions, with the specified v0.83.0
release copy and the cloud-built branch-head executable respectively:

```powershell
python -X utf8 C:\Users\miyaz\.claude\dispatch\261005-shared\heavy_lock.py acquire --seat s5 --what "S5 isolated native replay" --minutes 30
python -X utf8 scripts\research\pane_close_261005\replay.py --profile s5beforeA --port 9380 --exe <release-copy> --sha256 <release-sha> --repetitions 3
python -X utf8 scripts\research\pane_close_261005\replay.py --profile s5afterA --port 9380 --exe <cloud-exe> --sha256 <cloud-sha> --repetitions 3 --faults
python -X utf8 C:\Users\miyaz\.claude\dispatch\261005-shared\heavy_lock.py release --seat s5
```

Run one host at a time and release the lease in `finally` after the host stops.
An existing profile is never deleted or overwritten: use a new suffix.

The baseline intentionally reproduces product failures. Metadata declaring
the counter busy is an explicit fixture. Kill rejection/delay/deadline tests
intercept only the owned counter's command, then restore the original API.
UI events and screenshots use CDP; real hardware input is never generated.
Counts, monotonic output PID/SEQ samples, layout snapshots, faults, screenshots,
binary hashes and host shutdown/memory evidence stay under the S5 evidence
folder. Actual coding-agent detection, OS focus/snap and other lanes are outside
this acceptance. Unit tests additionally check cache, metadata and exact undo
counts under rejection, cancellation, overlapping closes and late results.

`validate.py` acquires the shared lease, runs tsc, all Vitest tests with one
worker and all pytest tests without bytecode/cache creation sequentially,
records exact commands and full logs, then releases the lease in `finally`.
It performs no Rust compilation or dependency installation. On this Windows
host, prepend the existing Git `usr/bin` directory before `bin` to the process
PATH so shell fixtures use the actual Git Bash, preserve their explicit MSYSTEM
fixtures, and avoid the unavailable WSL launcher. The `bin/bash.exe` shim injects
MSYSTEM=MINGW64 even when a fixture asks for an empty value.
The extended after replay covers both launcher and terminal targets across
singleton, multiple-pane and multiple-tab layouts, plus six explicit telemetry
confirmation-policy fixtures. Counter cancellation/refusal samples require
four observations with one PID and three increasing output sequences.
