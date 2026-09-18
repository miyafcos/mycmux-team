# ailog: gzip archive root for offloaded transcripts

2026-08-26. Owner: Fable (home session). Executor: Codex (gpt-5.6-terra, high).

## Background

Session transcripts (`~/.claude/projects`, `~/.codex/sessions`, …) are now
offloaded to Google Drive as verified zips and deleted locally
(`~/.claude/skills/rec-manual/scripts/session_archive.py`). The offloader now
also writes a local gzip mirror of every deleted `.jsonl` to
`~/.mycmux/ailog-archive/<kind>/<original relative path>.gz` (write-once,
immutable, ~20% of original size).

The ailog incremental index keeps rows for vanished files, so normal operation
is unaffected. But a **full rebuild** (`clear_all` + reindex) currently loses
every offloaded session. This change makes full rebuilds read the gzip archive.

## Requirement

1. New optional archive root: `~/.mycmux/ailog-archive/<kind>/**/*.jsonl.gz`,
   where `<kind>` is one of the existing source kinds (`claude`, `codex`,
   `claude-codex`, `grok`) and the path below `<kind>/` mirrors the original
   root-relative layout (e.g. `codex/2026/08/13/rollout-....jsonl.gz`
   corresponds to `~/.codex/sessions/2026/08/13/rollout-....jsonl`).
2. Archive files are parsed exactly like their plain counterparts after
   streaming gzip decompression (suggest `flate2` — check whether it is
   already in the dependency tree before adding).
3. **Skip rule (no double indexing).** For each archive file, reconstruct the
   original live path and skip the archive file when EITHER
   - the original live file currently exists on disk, OR
   - `source_file` already has a row for the original live path.
   Otherwise index it (its `source_file.path` key = the archive file path).
   Net effect: normal incremental runs ignore the archive entirely; a full
   rebuild (empty DB) picks up archived transcripts that no longer live on disk.
4. Archive files are immutable; the existing size/mtime fingerprinting must not
   re-parse unchanged archive files on every run.
5. No UI changes. No changes to pty/env layers, price.rs, or theme systems.

## Boundary

- Allowed: `src-tauri/src/ailog/**`, its tests, `src-tauri/Cargo.toml`
  (dependency only if needed), this spec file.
- Forbidden: everything else. In particular do not touch
  `sanitize_launch_env` / `EPHEMERAL_LAUNCH_ENV_KEYS` / sync-command allowlist.

## Acceptance (run all, paste outputs in the report)

```
npx tsc --noEmit
npx vitest run
python scripts/run_windows_tests.py
python -m pytest tests/
```

New Rust unit tests required:
- (a) parity: a gz-compressed fixture indexes to the same sessions/turns as the
  plain fixture;
- (b) skip-when-live-exists: archive file ignored while the original exists;
- (c) skip-when-already-indexed: archive file ignored when `source_file` has the
  original path;
- (d) full rebuild with only the archive present indexes the archived sessions.

## Process

- Work on branch `master` in `C:\Users\miyaz\cmux-for-linux-dev-master`.
- Self-review twice before reporting: pass 1 = acceptance criteria coverage;
  pass 2 = out-of-scope changes / regressions / leftovers (`git diff --numstat`
  must contain only in-boundary files; revert stray `cargo fmt` noise).
- Commit locally with a clear message. Push only after all four acceptance
  commands pass (repo rule: push default ON).
- Report: what changed (files + line counts), test outputs, self-review notes.
