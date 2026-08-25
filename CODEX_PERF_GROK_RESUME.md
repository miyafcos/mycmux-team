# v0.57 Codex performance work — crash recovery handoff

Worktree: `C:\Users\miyaz\cmux-for-linux-dev-master`

Read the full original contract first:

- `C:\Users\miyaz\cmux-for-linux-dev-master\CODEX_PERF_GROK_SPEC.md`

The previous Grok session was interrupted twice by mycmux app restarts. Its current uncommitted implementation remains in:

- `C:\Users\miyaz\cmux-for-linux-dev-master\src-tauri\src\livebrief\mod.rs`

Current diff size is about 481 insertions / 33 deletions. Treat it as an untrusted candidate, not as accepted work.

Your tasks:

1. Review the current diff against the original spec and current `HEAD` (`v0.56.0`).
2. Preserve all protected pre-existing dirty files listed in the original spec.
3. Keep the P0 cached-transcript-path fix and its focused tests, but remove redundant or excessive test scaffolding and unrelated refactors. Prefer the smallest correct diff.
4. Verify unchanged, append/growth, truncate, replacement, missing path, and binding-change behavior. Ensure 10 appends after initial discovery do not re-enumerate the synthetic session tree.
5. Resume and finish the required validation commands from the original spec. Do not install packages, kill/restart processes, build/deploy, commit, or push.
6. Create `C:\Users\miyaz\cmux-for-linux-dev-master\REPORT_CODEX_PERF_GROK.md`.
7. Write `C:\Users\miyaz\cmux-for-linux-dev-master\DONE_CODEX_PERF_GROK.md` last, then stop.

This change targets v0.57.0. Sol is the acceptance owner.
