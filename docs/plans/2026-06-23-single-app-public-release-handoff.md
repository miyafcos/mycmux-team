# mycmux single-app public release handoff

Date: 2026-06-23

## Purpose

mycmux は master と lite の 2 アプリ管理が運用負荷になっている。今後は、現行 lite を段階的に閉じ、master を唯一の本体アプリに寄せる方針で整理する。

思想は次の通り。

- private repo と public lite repo を分ける理由は薄くなっている。
- 本体は master 由来の mycmux に一本化する。
- Claude Buddy / Codex Pet / キャラ機能は本体に同梱しない。各ユーザーがあとから追加できる機能、またはローカル拡張として分離する。
- ただし、現在の master は初期公開できる品質にまだ届いていない。特にユーザー観測では、ペインの左クリック選択がまだ安定していない。

この文書は、次担当者が「今すぐ lite を消す」のではなく、公開可能な単一アプリへ安全に移すための前提条件を固定するための引継ぎである。

## Current Facts

### Repositories and branches

| Item | master / full app | lite app |
| --- | --- | --- |
| Worktree | `C:\Users\miyaz\cmux-for-linux-dev-master` | `C:\Users\miyaz\cmux-for-linux-dev` |
| Branch | `master` | `release/public-lite` |
| Source remote | `https://github.com/miyafcos/mycmux.git` | `https://github.com/miyafcos/mycmux.git` |
| Public remote | `https://github.com/miyafcos/mycmux-team.git` | `https://github.com/miyafcos/mycmux-team.git` |
| Current tag at HEAD | `v0.8.43` | `v0.8.43-lite.1` |
| Current HEAD | `d4c6782 fix: restore pane click activation` | `d71374c fix: restore pane click activation` |

Both worktrees were clean when this handoff was written. `git status --short` only reported inaccessible pytest cache warning directories.

### Installed apps

| App | Installed executable | ProductVersion | Last write |
| --- | --- | --- | --- |
| mycmux | `C:\Users\miyaz\AppData\Local\mycmux\mycmux.exe` | `0.8.43` | `2026-06-22 18:34:36` |
| mycmux-lite | `C:\Users\miyaz\AppData\Local\mycmux-lite\mycmux-lite.exe` | `0.8.43-lite.1` | `2026-06-22 18:34:20` |
| legacy full copy | `C:\Users\miyaz\mycmux-app\mycmux.exe` | `0.8.43` | `2026-06-22 18:34:36` |
| legacy lite copy | `C:\Users\miyaz\mycmux-lite-app\mycmux-lite.exe` | `0.8.43-lite.1` | `2026-06-22 18:34:20` |

`mycmux.exe` was running at the time of inspection. `mycmux-lite.exe` was not running.

### Packaging identity

master:

- `package.json`: `name = mycmux`, `private = true`, `version = 0.8.43`
- `src-tauri\tauri.conf.json`: `productName = mycmux`, `identifier = com.miyazaki.mycmux`
- updater endpoint: `https://github.com/miyafcos/mycmux-team/releases/download/mycmux-personal-updater/latest.json`

lite:

- `package.json`: `name = mycmux-lite`, `private = false`, `version = 0.8.43-lite.1`
- `src-tauri\tauri.conf.json`: `productName = mycmux-lite`, `identifier = com.miyazaki.mycmux-lite`
- updater endpoint: `https://github.com/miyafcos/mycmux-team/releases/latest/download/latest.json`
- WiX version is numeric: `0.8.43.1`

The current README still describes the old two-edition model and says the public distribution target is `miyafcos/mycmux-team`. That document must be rewritten before any single-app public release.

## Release Readiness Judgment

Do not treat master as public-release-ready yet.

The latest automated focus/click verification from the previous repair cycle passed, and both apps were released as `v0.8.43` / `v0.8.43-lite.1`. However, the user has since observed that master still has a left-click pane selection problem. That user-observed problem is a release blocker until reproduced, fixed, and verified on the installed app.

The important distinction:

- Stability work improved the app enough that focus no longer appears to collapse constantly.
- The remaining issue is not proven to be the same root cause.
- Public consolidation work should not start by deleting lite. First make master's pane selection, mouse wheel behavior, input routing, and session loading reliable.

## Non-Negotiable Preconditions

### 1. Master must pass interaction stability gates

Before master becomes the only public app, verify these manually and with automation where possible.

- Left-clicking a pane selects that pane every time.
- The active pane highlight stays attached to the intended pane.
- Mouse wheel scrolling does not activate another conversation/session by accident.
- Text input is delivered only to the active pane.
- Input does not stop accepting characters midway through a session.
- Session list and session contents load without requiring zoom, resize, or other layout movement.
- Latest session content is visible after restore without forcing a repaint by hand.
- Startup restore and resume behavior remain stable after cold start.

Suggested commands from the current repo:

```powershell
cd C:\Users\miyaz\cmux-for-linux-dev-master
py -3 -m pytest tests\test_layout_stability_contract.py tests\test_session_restore_agent_kind.py tests\test_session_restore_cwd.py tests\test_session_restore_race.py -q
cmd /c npm run build
cmd /c npx.cmd tsc --noEmit
cmd /c npm run tauri build
node scripts\verify-focus-stability-cdp.mjs --name master --port 9229 --allow-text --setup-if-needed
```

After build, verify the installed exe, not only the build output:

- ProductVersion is the intended version.
- Built exe and installed exe hashes match.
- The installed `C:\Users\miyaz\AppData\Local\mycmux\mycmux.exe` passes the same manual smoke test.

### 2. Public-readiness audit must finish before repo exposure

The master repo is currently private and has personal-function code paths. Before making it canonical/public, audit at least:

- Hard-coded local paths under `C:\Users\miyaz`.
- Personal logs, examples, screenshots, and docs.
- `.env`, credentials, updater signing material, tokens, private release feed assumptions.
- `README.md`, `docs\current-state.md`, `docs\DEPLOY.md`, and GitHub Actions text that still assumes private master plus public lite.
- GitHub issue, release, and workflow history that may expose private operational details.

No secret should be copied into public docs or release assets.

### 3. Buddy / character features must be separated by contract, not by hiding UI

Current master has Buddy code across several layers:

- Frontend: `C:\Users\miyaz\cmux-for-linux-dev-master\src\buddy`
- Theme and settings: `src\global.css`, `src\stores\settingsStore.ts`, `src\components\theme\themeDefinitions.ts`, `src\components\layout\AppShell.tsx`
- Rust module: `C:\Users\miyaz\cmux-for-linux-dev-master\src-tauri\src\buddy`
- Rust command registration: `C:\Users\miyaz\cmux-for-linux-dev-master\src-tauri\src\lib.rs`
- Local runtime files: `C:\Users\miyaz\.claude-buddy`
- Helper script: `C:\Users\miyaz\cmux-for-linux-dev-master\scripts\buddy-export-png.mjs`

Therefore, the split must not be a CSS hide or feature flag only. The target should be:

- Core app has no bundled character/persona assets.
- Core app exposes a small, stable extension surface.
- A user can install or point to a local character pack.
- Character pack data lives outside the app bundle.
- Core remains usable when no character pack exists.
- Failure in a character extension cannot block terminal startup, session restore, input routing, or pane focus.

Possible extension contract:

- Local directory: `%APPDATA%\mycmux\extensions\characters\{id}`
- Manifest: `character.json`
- Optional assets: images, spritesheets, Live2D model files, prompt/profile text.
- Core APIs: list packs, load selected pack, save selected pack, emit non-critical activity events.
- No direct access to arbitrary shell commands unless explicitly granted later.

### 4. Updater and app identity must be decided before migration

There are two separate app identities now:

- `com.miyazaki.mycmux`
- `com.miyazaki.mycmux-lite`

There are also two updater feeds:

- personal feed under `mycmux-personal-updater`
- lite feed under latest release `latest.json`

Before retiring lite, decide whether existing lite users should:

- stay on the final lite release with no forced migration,
- receive a final lite update that points them to the new mycmux installer,
- or receive a true in-app migration path.

Do not change identifiers or updater endpoints casually. A wrong move can strand installed users on an old feed or install two incompatible apps side by side without a clear migration story.

### 5. Lite must be frozen before deletion

"Delete lite" should mean a staged deprecation, not immediate removal.

Recommended order:

1. Declare lite feature-frozen.
2. Ship a final lite build with a visible deprecation note if needed.
3. Keep the public repo/releases available during a rollback window.
4. Confirm new master/public app can be installed and used by the intended users.
5. Archive or stop updating lite only after rollback is no longer needed.

Do not delete GitHub releases, updater feeds, or local worktrees as part of the first migration pass.

## Proposed Migration Plan

### Phase 0: Freeze and reproduce

Goal: stop widening the problem.

- Freeze feature work unrelated to interaction stability and public readiness.
- Reproduce the master left-click pane selection bug on the installed app.
- Add or update a verification script only after the manual symptom is understood.
- Confirm whether the lite behavior differs because of code, build identity, or runtime data.

Exit condition:

- Root cause of master click-selection bug is known.
- Fix is verified against installed `mycmux.exe`.

### Phase 1: Public audit of master

Goal: know what blocks making master the canonical public source.

- Audit docs, workflows, scripts, screenshots, and release assets.
- Remove or rewrite private-only operational notes.
- Confirm license and third-party asset obligations.
- Decide whether `package.json private` should change only after the audit passes.

Exit condition:

- A list of public-blocking files is closed.
- No secrets or private-only data are in the public candidate.

### Phase 2: Character extension boundary

Goal: remove bundled character features from core without breaking personal usage.

- Define a minimal extension manifest.
- Move character/persona assets out of the app bundle.
- Convert Buddy runtime reads/writes to an optional local extension path.
- Keep terminal, session, and layout startup independent from character extension load.
- Provide a local personal extension pack outside the public core if Miyazaki-san still wants the current behavior.

Exit condition:

- Core starts cleanly without a character pack.
- Adding a local pack restores character functionality.
- Pack failure logs an error but does not affect terminal use.

### Phase 3: Release and updater consolidation

Goal: one public release path.

- Decide canonical GitHub repo name.
- Rewrite README and docs for single-app distribution.
- Update release workflow so it no longer depends on the old private master plus public lite split.
- Replace `MYCMUX_TEAM_RELEASE_TOKEN` mirror dependency with the final public release flow.
- Decide installer naming and artifact naming.

Exit condition:

- A tag on the canonical repo builds the expected installer and updater JSON.
- Existing app update behavior is intentionally handled.

### Phase 4: Lite deprecation

Goal: retire lite safely.

- Publish final lite status note.
- Keep release assets available.
- Stop cherry-picking master fixes into lite unless they are critical.
- Archive or lock the lite branch only after the migration window.

Exit condition:

- Users have a clear path to the new app.
- There is no hidden dependency on the lite worktree or updater feed.

## Initial Public Release Blockers

These must be resolved before calling the single-app version an initial public release.

1. Master left-click pane selection can fail or become unresponsive.
2. Mouse wheel and active pane selection must be proven independent.
3. Session content loading still needs proof that it does not depend on zoom/resize/repaint side effects.
4. Text input lockup reports need a current reproduction attempt and a root-cause note.
5. README still documents master/lite split and public lite distribution.
6. `docs\current-state.md` is stale and still references older v0.4.0 state.
7. Buddy/character code is bundled into master and registered in core startup.
8. Master release workflow can fail at the personal updater mirror step if `MYCMUX_TEAM_RELEASE_TOKEN` is not configured.
9. Public/private repo ownership and release feed ownership are not yet simplified.

## What The Next Assignee Should Do First

1. Work only in `C:\Users\miyaz\cmux-for-linux-dev-master` until the master interaction bugs are resolved.
2. Reproduce the remaining left-click pane selection issue on installed `C:\Users\miyaz\AppData\Local\mycmux\mycmux.exe`.
3. Map the event path for pane activation, wheel handling, focus routing, and xterm input.
4. Fix and verify the interaction bug before touching repo consolidation.
5. Then audit Buddy/character separation points and draft the extension manifest.
6. Only after that, rewrite README/release docs and decide the public repo/updater move.

## Non-Goals For The First Pass

- Do not delete `C:\Users\miyaz\cmux-for-linux-dev`.
- Do not remove or rewrite historical GitHub releases.
- Do not force-push public history.
- Do not merge all Buddy/character behavior into public core.
- Do not change Tauri identifiers or updater endpoints without a rollback plan.
- Do not claim master is stable based only on build success.

## Open Questions

- Should the canonical public repo be `miyafcos/mycmux`, `miyafcos/mycmux-team`, or a new repo?
- Should existing `mycmux-lite` users receive a final migration notice build?
- Does Miyazaki-san want the current Buddy implementation preserved as a private local extension pack?
- Should the extension surface support only local packs first, or also remote pack download later?
- Should public mycmux keep file sidebar, path jump, theme/background, and remote access all enabled by default?

## Completion Definition

The consolidation is complete only when:

- There is one maintained app and one maintained release path.
- The public repo contains no private-only data or bundled personal character assets.
- Character functionality is optional and externally addable.
- The installed app passes interaction stability checks.
- Lite is either archived or explicitly frozen with a clear user-facing migration note.
