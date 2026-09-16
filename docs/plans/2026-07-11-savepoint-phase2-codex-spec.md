# Codex spec: Online savepoint panel (Phase 2) — mycmux

> **履歴資料:** 本specの共有フォルダ前提は、2026-07-14のlocal-first受け渡し仕様で置き換えられました。現行仕様は `README.md` の「セーブポイント」を参照してください。

## Context (read these primary sources FIRST)
- Design doc: `docs/plans/2026-07-10-online-savepoint-plan.md` (§1.2 UX, §2 bundle schema, §7 Phase 2)
- Publisher CLI (already done, Phase 1): `scripts/savepoint_publish.py` (manifest schema ground truth)
- Sample bundle to test against (real data): `C:/Users/miyaz/.mycmux/online-dev/miyazaki_85d1dd8d/` (manifest.json / handoff.md / transcript/)
- Config file: `C:/Users/miyaz/.mycmux/savepoint.json` → `{ "online_dir": "C:/Users/miyaz/.mycmux/online-dev", "author": "miyazaki", "machine": "home-windows" }`
- Japanese UI strings (pre-authored, MUST import, do NOT add new Japanese string literals in any file you create/edit): `src/components/online/onlineStrings.ts`

## Goal (Phase 2 scope only)
A new "Online" panel in mycmux that lists savepoint bundles and lets the user join one in **summary mode**:
1. Rust (Tauri command) `list_online_savepoints`: read `online_dir` from `~/.mycmux/savepoint.json`, scan subdirectories, parse each `manifest.json`, return entries (skip corrupt/missing manifests gracefully; also skip dirs whose name starts with `.`). Include: dir path, author, machine, summary_line, cwd (tokenized), created_at, updated_at, expires_at, pinned, warnings count, claude_session_id, files_written count, handoff.md absolute path.
2. Rust command `join_savepoint_summary(bundle_dir)`:
   - Resolve target cwd: manifest `cwd` starting with `{DROPBOX}` → expand using `dropbox_root` from savepoint.json if set; if resulting dir (or a non-token absolute cwd) does not exist on disk → fall back to the user home dir.
   - Return `{ resolved_cwd, handoff_path, cwd_missing: bool }` — the FRONTEND then opens a new terminal pane in that cwd running claude with the initial prompt from `onlineStrings.joinPrompt(handoffPath)`.
   - For launching: reuse the existing mechanism mycmux uses to open a new terminal pane with a given cwd and startup command (investigate how the launcher/new-pane flow does it; do NOT invent a parallel PTY path). If passing an initial command is not cleanly supported, it is acceptable for Phase 2 to open the pane in resolved_cwd and auto-type `claude "<prompt>"` via the existing send-text/socket mechanism.
3. React `OnlinePanel` component:
   - Opens like the file-preview/browser style panels (investigate how existing non-terminal panels are registered/opened; follow the same pattern). Add a menu/command entry point consistent with existing UI (e.g. wherever file explorer / browser panes are opened from).
   - Card list: author, project name (last 1-2 segments of cwd), summary_line, "N時間前/N分前" from updated_at, badges: pinned (top of list), warnings, expiring soon (<6h).
   - Search box filtering author/cwd/summary (substring, case-insensitive). Sort: pinned first, then updated_at desc.
   - Refresh button + reload when panel becomes visible.
   - Card click → two buttons: "要約から開始" (calls join flow) and "完全再開" (disabled, tooltip via onlineStrings.joinFullDisabledHint).
   - All user-visible Japanese text via onlineStrings import. English is acceptable for anything not covered there (add English literals if needed, not Japanese).

## Boundaries (STRICT)
- May create/edit ONLY under: `src/` (frontend), `src-tauri/src/` (Rust), `tests/` (pytest contract test optional), `src/components/online/` (but do NOT edit onlineStrings.ts).
- Do NOT touch: `src-tauri/src/launcher.sh`, updater/feed scripts, `scripts/savepoint_publish.py`, existing tests, package.json deps (no new npm/cargo dependencies), CI workflows.
- Do NOT run `cargo fmt` on the workspace. No drive-by refactors. Keep diff minimal and in-style.
- Do NOT write any new Japanese string literals (mojibake risk); import from onlineStrings.ts.

## Acceptance criteria (parent will verify independently — your report must show these commands passing)
1. `npx tsc --noEmit` clean.
2. `npx vitest run` all green (add at least 1 vitest for list sorting/filter logic if it is extracted as a pure function — extract it so it is testable).
3. `cd src-tauri && cargo test` all green (add at least 1 Rust unit test for manifest parsing + {DROPBOX} cwd expansion fallback).
4. `python -m pytest tests/ -q` all green (existing suite must not regress).
5. `list_online_savepoints` works against the real sample dir `C:/Users/miyaz/.mycmux/online-dev/` (demonstrate via Rust test with a fixture dir modeled on the real manifest, not by mocking JSON inline only — read the real manifest file's field set).
6. Report: list every file created/modified with line counts, the pane-opening mechanism you reused (file+function names), and any deviation from this spec with reason.

## Judgement
Parent (Claude) decides acceptance. Report facts, do not self-declare completion.
