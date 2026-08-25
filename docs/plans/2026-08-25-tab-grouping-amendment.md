# AMENDMENT 1 — tab grouping work order (read immediately, then continue)

## 1. This worktree contains OTHER lanes' uncommitted changes (do not touch)

`git status` already shows ~60 modified files (ailog/*, socket.rs, agent CLI, bridge tests,
`integrations/`, etc.). They belong to other in-flight work. Rules:

- NEVER run `git add -A`, `git add .`, `git add -u`, or `git commit -a`.
  Stage ONLY files you created or edited, each by explicit path.
- NEVER revert, checkout, fix, or reformat any file outside your boundary,
  even if a test failure seems related. If a pre-existing foreign change breaks a test
  you did not touch, report it as environment noise in GROK_DONE and move on.
- Your self-review boundary check changes to: list files YOU changed
  (`git status --porcelain` diff vs the baseline below) and confirm each is in the
  allowed list of the work order. The baseline foreign files are not yours to explain.

Baseline of foreign changes at 2026-08-25 15:05 (already present before you started):
all `src/components/ailog/*`, `src-tauri/src/ailog/*`, `src-tauri/src/commands/ailog.rs`,
`src-tauri/src/commands/workspace.rs`, `src-tauri/src/db/storage.rs`, `src-tauri/src/lib.rs`,
`src-tauri/src/socket.rs`, `src/lib/ailog.ts`, `src/lib/ipc.ts`, `src/stores/ailogStore.ts`,
`src/stores/useAilogJobStore.ts`, `src/hooks/useAilogAutoIndex.ts`,
`src/components/common/OverlayShell.tsx`, `docs/agent-integration.md`, `index.html`,
`scripts/mycmux_agent_cli.py`, `scripts/perf/measure-mycmux.ps1`,
`tests/test_agent_cli_*.py`, `tests/test_ailog_contract.py`, `tests/test_socket_api_contract.py`,
`tests/unit/ailog*.{ts,tsx}`, `tests/unit/crossTable.test.tsx`, `tests/unit/overlayShell.test.ts`,
`tests/unit/reworkRankings.test.tsx`, `tests/unit/sessionPresentation.test.tsx`,
`tests/unit/summaryCards.test.tsx`, `tests/unit/usageTotals.test.ts`, `tests/unit/usageView.test.tsx`,
untracked: `integrations/`, `src-tauri/src/ailog/tests/codex_attribution_tests.rs`,
`src-tauri/target-askq-final/`, `src/components/ailog/AilogOrientation.tsx`,
`src/components/ailog/HandoffTable.tsx`, `tests/test_mycmux_bridge.py`,
`tests/unit/crossTableModel.test.ts`, `tests/unit/handoffTable.test.tsx`,
and this file `AMENDMENT_tab_grouping.md`.

Note: `src-tauri/src/lib.rs` appears in the foreign list AND in your allowed edits
(command registration for the grouping mode, if needed). Edit it minimally on top of its
current working-tree content; never revert its existing modifications.

## 2. Naming rule update (overrides plan doc wording)

In the grouping AI prompt and any label constraints: Japanese is the default, but
proper nouns (project/product/tool names such as mycmux, claude, codex) may stay in
alphabet as-is. Only generic English words (fix, build, review, server...) must be
Japanese. Do not force katakana transliteration of proper nouns. New-workspace proposed
names follow the same rule.

## 3. Grouping objective update (user feedback, overrides plan doc where it conflicts)

Do NOT make the AI prompt force "one workspace per project". The user finds it more
usable when a workspace holds 1-3 projects depending on tab/pane counts (a workspace is
a place for overview, not a strict project boundary). Encode this in the grouping prompt:

- Target a comfortable workspace size (guideline: roughly 3-8 tabs per workspace).
- Small projects may share one workspace (up to ~3 projects), separated by columns,
  with a group title that names both (e.g. "国語課+雑務").
- A large project gets its own workspace.
- Plans should still differ by strategy (project / role / minimal_move), but every plan
  must respect the comfortable-size objective rather than mechanically splitting
  one-project-per-workspace.

The schema does not change (a group still targets one workspace; columns separate
projects inside it).

## 4. Everything else in the original work order and plan doc stays as-is.
