# 2026-06-23 mycmux right-click selection handoff

## Status

User report after local deployment: **not fixed**.

Do not treat the current code as done. The current build passed automated probes, but Miyazaki-san still observes that right-click selection is broken in real use.

Repo:

- `C:\Users\miyaz\cmux-for-linux-dev-master`
- Branch: `master`
- Current installed process: `C:\Users\miyaz\mycmux-app\mycmux.exe`, PID `23376`, started `2026/06/23 18:04:36`
- Built/installed SHA256:
  - `C:\Users\miyaz\cmux-for-linux-dev-master\src-tauri\target\release\mycmux.exe`
  - `C:\Users\miyaz\mycmux-app\mycmux.exe`
  - `C:\Users\miyaz\AppData\Local\mycmux\mycmux.exe`
  - all equal: `FC7729CE9118E24E3DD92E8D143A01CF2E2782A838737C0C54D0C1AB113A6F82`

## User-facing symptom

Original complaint:

- Session panes feel unstable.
- Display does not feel continuously updated on demand; clicking can cause a session to start/proceed unexpectedly.
- Right-click selection still does not work.
- Old input pane stability must not regress.
- Session restore after closing the app is unreliable: wrong sessions appear in wrong panes, or some panes do not restore.

Latest user update:

- User reported that the attempted fix still appears not to work.

Interpret this as: the right-click selection fix deployed in the current worktree did not solve the real scenario. Reproduce the exact UI operation before changing more code.

## Current dirty worktree

`git status --short` currently shows:

```text
 M scripts/verify-focus-stability-cdp.mjs
 M src-tauri/src/commands/terminal.rs
 M src-tauri/src/lib.rs
 M src-tauri/src/pty/manager.rs
 M src/components/layout/SocketListener.tsx
 M src/components/terminal/XTermWrapper.tsx
 M src/components/workspace/TerminalPane.tsx
 M src/lib/ipc.ts
 M tests/test_layout_stability_contract.py
 M tests/test_session_restore_agent_kind.py
?? docs/plans/2026-06-23-single-app-public-release-handoff.md
?? docs/plans/2026-06-23-right-click-selection-not-fixed-handoff.md
```

Important: many dirty changes existed before the right-click handoff work. Do not revert them casually. They appear to be part of the broader pane/session stability work.

## What was changed in the failed attempt

### `C:\Users\miyaz\cmux-for-linux-dev-master\src\components\workspace\TerminalPane.tsx`

Intent:

- Stop treating right-click as pane activation.
- Still allow xterm's pointer/focus path briefly so right-click selection can run on inactive terminals.

Current shape:

```tsx
const isSelectionButton = event.button === 0 || event.button === 2;
...
allowInactiveTerminalPointerFocus(tab.sessionId);
if (event.button === 2) {
  pendingPaneClickActivationRef.current = null;
  return;
}
```

This removed the earlier behavior where right-click called:

```tsx
activatePane({ focusTerminal: false });
```

### `C:\Users\miyaz\cmux-for-linux-dev-master\src\components\terminal\XTermWrapper.tsx`

Intent:

- Keep xterm `rightClickSelectsWord: true`.
- Add `contextmenu` listener after xterm handles right-click selection so the selection is copied.
- Preserve selection-copy listener across cached terminal remounts.

Current right-click copy addition:

```tsx
const copySelectedText = (): void => {
  const selectedText = currentTerm.getSelection();
  if (!selectedText) return;
  ...
  copyTextToClipboard(selectedText, restoreSelectionFocus);
};

const flushContextMenuSelectionCopy = () => {
  if (copyTimer !== null) {
    window.clearTimeout(copyTimer);
  }
  copyTimer = window.setTimeout(() => {
    copyTimer = null;
    selectionDirty = false;
    copySelectedText();
  }, 0);
};

termElement?.addEventListener("contextmenu", flushContextMenuSelectionCopy);
```

### `C:\Users\miyaz\cmux-for-linux-dev-master\scripts\verify-focus-stability-cdp.mjs`

Intent:

- Assert right-click on inactive pane does not switch the active pane.
- Stabilize initial active pane before assertions.
- Re-read pane geometry before scripted clicks to avoid stale coordinates.

Relevant current assertion:

```js
current = await assertActivePane(cdp, firstActive.paneId, "right pointerdown inactive pane preserves active pane");
```

### `C:\Users\miyaz\cmux-for-linux-dev-master\tests\test_layout_stability_contract.py`

Intent:

- Lock in that right-click is not pane activation.
- Lock in `rightClickSelectsWord: true`.
- Lock in contextmenu selection copy listener.

## Verification already run

These commands passed:

```powershell
cmd /c npx.cmd tsc --noEmit
```

Direct Python invocation of selected layout contract functions passed:

```powershell
@'
import importlib.util
from pathlib import Path
path = Path('tests/test_layout_stability_contract.py')
spec = importlib.util.spec_from_file_location('layout_contract', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.test_selection_copy_listener_survives_cached_terminal_remounts()
module.test_terminal_toolbar_actions_restore_xterm_focus()
module.test_terminal_wheel_input_does_not_steal_keyboard_focus()
module.test_terminal_batches_keep_backend_flowing_while_layout_is_unwritable()
print('direct layout contract checks passed')
'@ | python -
```

`pytest` did not run because this environment lacks pytest:

```text
C:\Users\miyaz\AppData\Local\Programs\Python\Python310\python.exe: No module named pytest
```

Release build passed:

```powershell
cmd /c npm.cmd run tauri build
```

CDP focus stability check passed after script adjustment:

```powershell
cmd /c node scripts\verify-focus-stability-cdp.mjs --name mycmux --port 9223 --allow-text --setup-if-needed
```

Result:

```json
{
  "name": "mycmux",
  "port": 9223,
  "result": "PASS",
  "panes": 7,
  "textProbe": {
    "skipped": false,
    "eventCount": 2
  }
}
```

A one-off CDP probe also passed for right-click word selection on the active pane:

```json
{
  "result": "PASS",
  "clickedTextSample": "  Launch:",
  "helperValue": "Launch:",
  "selectionRectCount": 1
}
```

Do not over-trust this. It clicked a visible text sample in the active pane and verified xterm produced a selection. It did not prove Miyazaki-san's failing operation.

## Why the automated proof is insufficient

Likely uncovered scenarios:

1. User may mean right-drag range selection, not right-click word selection.
   - xterm `rightClickSelectsWord` is word selection, not right-drag range selection.
   - Normal range selection should be left-drag.

2. User may be selecting inside an inactive or cached/restored pane.
   - The one-off probe verified active pane text.
   - The full CDP script asserted right-click does not switch active pane, but did not assert actual selection in inactive pane after right-click.

3. User may expect the native context menu to remain usable.
   - The current `contextmenu` listener does not call `preventDefault`, but copying selection immediately after contextmenu may still interact badly with WebView native menu timing.

4. User may be selecting in a "past input pane" or restored session whose terminal instance came from cache.
   - `registerSelectionCopyListener(cached.term, sessionId)` is present, but the real failure may be cache/restore specific.

5. User may be trying to select prompt/input text in an agent UI where mouse reporting is enabled.
   - `XTermWrapper.tsx` strips non-wheel terminal mouse input sequences before sending to PTY, but xterm mouse modes can still affect selection behavior.

6. User may be testing a pane restored from app restart.
   - Current right-click probes did not close/reopen mycmux and then test selection in restored panes.

## Next recommended investigation

Start by reproducing the exact operation in the live app, not by adding another speculative fix.

Concrete next checks:

1. Add a focused CDP probe for **inactive pane right-click actual selection**.
   - Choose an inactive pane with visible text.
   - Right-click a word.
   - Assert `.xterm-selection div` exists in that inactive pane.
   - Assert helper textarea value or `term.getSelection()` is non-empty if accessible.
   - Assert active pane did not change.

2. Add a probe for **cached/restored pane selection**.
   - Switch tabs/workspaces so a terminal is detached/reattached from cache.
   - Right-click visible text in that reattached pane.
   - Verify selection layer and clipboard behavior.

3. Add a probe for **restart restore then selection**.
   - Start mycmux with CDP.
   - Capture pane/session IDs and visible text.
   - Stop/restart mycmux.
   - Verify restored panes match expected session IDs.
   - Right-click select in each restored pane.

4. Manually inspect whether the failing operation is:
   - right-click word select,
   - right-drag range select,
   - right-click context menu selection/copy,
   - left-drag range select,
   - selection in inactive pane,
   - selection in restored/cached pane.

5. If the failure is right-drag range selection:
   - Do not try to force this through `rightClickSelectsWord`.
   - Decide whether the product should support right-drag as a custom behavior, or document/use left-drag for range selection.

6. If the failure is context menu timing:
   - Temporarily remove the added `contextmenu` copy listener and test whether selection appears.
   - If selection works without copy listener, re-add copy on a later timeout or on explicit copy shortcut only.

## Files to inspect first

- `C:\Users\miyaz\cmux-for-linux-dev-master\src\components\workspace\TerminalPane.tsx`
- `C:\Users\miyaz\cmux-for-linux-dev-master\src\components\terminal\XTermWrapper.tsx`
- `C:\Users\miyaz\cmux-for-linux-dev-master\scripts\verify-focus-stability-cdp.mjs`
- `C:\Users\miyaz\cmux-for-linux-dev-master\tests\test_layout_stability_contract.py`
- `C:\Users\miyaz\cmux-for-linux-dev-master\src\components\layout\SocketListener.tsx`
- `C:\Users\miyaz\cmux-for-linux-dev-master\src-tauri\src\commands\terminal.rs`
- `C:\Users\miyaz\cmux-for-linux-dev-master\src-tauri\src\pty\manager.rs`

## Do not do

- Do not claim right-click selection is fixed based only on current CDP PASS.
- Do not revert the dirty pane/session stability changes without reading them.
- Do not commit only the right-click change blindly; `XTermWrapper.tsx` includes broader session/scrollback work in the same dirty file.
- Do not ignore installed app drift. Always compare built exe and installed exe hashes after deployment.

## Known deployment recipe used

```powershell
cmd /c npm.cmd run tauri build
```

Then:

- Stop `mycmux`.
- Backup existing exe with `.bak.<timestamp>`.
- Copy built exe to:
  - `C:\Users\miyaz\mycmux-app\mycmux.exe`
  - `C:\Users\miyaz\AppData\Local\mycmux\mycmux.exe`
- Start `C:\Users\miyaz\mycmux-app\mycmux.exe` with WebView2 CDP enabled:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9223 --remote-allow-origins=*'
Start-Process -FilePath 'C:\Users\miyaz\mycmux-app\mycmux.exe' -WindowStyle Hidden
```

## Current best hypothesis

The failed attempt probably fixed only the easy case: active-pane right-click word selection. The user is likely hitting one of:

- inactive pane selection,
- restored/cached pane selection,
- right-drag/range selection expectation,
- native context menu timing,
- focus mismatch between `activePaneId`, DOM focus, and xterm helper textarea after restore.

The next agent should prove which one before patching.

## 2026-06-23 continuation update: inactive right-click reproduced and patched locally

### New reproduction

- Live CDP probe against the installed app reproduced the missing case before patching.
- Active pane right-click word selection produced `windowSelection` text.
- Inactive pane right-click word selection produced no selection: `windowSelection` was empty, `.xterm-selection div` count was `0`, and focus stayed on the previously active terminal.
- Root cause: `allowInactiveTerminalPointerFocus(tab.sessionId)` allowed the xterm focus guard to tolerate pointer focus, but `TerminalPane.tsx` never actually focused the inactive terminal helper textarea before xterm handled the right-click. `focusTerminalSoon(term, sessionId)` also intentionally refuses non-active sessions, so inactive selection needed pane-side DOM focus.

### Local patch added

- `C:\Users\miyaz\cmux-for-linux-dev-master\src\components\workspace\TerminalPane.tsx`
  - Adds `focusTerminalElement(event.currentTarget);` immediately after `allowInactiveTerminalPointerFocus(tab.sessionId);` in `handlePanePointerDownCapture`.
  - Right-click still does not activate the pane; it only gives the target xterm enough DOM focus for selection.
- `C:\Users\miyaz\cmux-for-linux-dev-master\scripts\verify-focus-stability-cdp.mjs`
  - Adds `rightClickPaneWord(...)` to right-click an actual visible terminal word in an inactive pane.
  - Asserts selection text is non-empty and the active pane does not change.
- `C:\Users\miyaz\cmux-for-linux-dev-master\tests\test_layout_stability_contract.py`
  - Adds the new focus call to the layout/focus contract snippets.

### Verification completed before deployment

```powershell
cmd /c npx.cmd tsc --noEmit
python -m pytest tests\test_layout_stability_contract.py -q
cmd /c npm.cmd run tauri build
```

Results:

- TypeScript: PASS
- `tests\test_layout_stability_contract.py`: `15 passed in 0.14s`
- Release build: PASS, built `C:\Users\miyaz\cmux-for-linux-dev-master\src-tauri\target\release\mycmux.exe`

### Current deployment state

Do not stop or restart mycmux until Miyazaki-san says it is OK. Miyazaki-san reported they are currently using mycmux.

Current hash check after build:

- Built exe: `C:\Users\miyaz\cmux-for-linux-dev-master\src-tauri\target\release\mycmux.exe` = `EC5E5FD8789442EF89F424791C5DF619F83B3DBBE4625F6067FDA53607161F90`
- Installed app copy: `C:\Users\miyaz\mycmux-app\mycmux.exe` = `FC7729CE9118E24E3DD92E8D143A01CF2E2782A838737C0C54D0C1AB113A6F82`
- Installed LocalAppData copy: `C:\Users\miyaz\AppData\Local\mycmux\mycmux.exe` = `FC7729CE9118E24E3DD92E8D143A01CF2E2782A838737C0C54D0C1AB113A6F82`

The running process observed after the interrupted deploy attempt:

- `C:\Users\miyaz\AppData\Local\mycmux\mycmux.exe`, PID `25448`, started `2026/06/23 19:00:44`
- Its file hash matches the old installed hash above, not the rebuilt exe.

### Next safe step when user is ready

1. Stop mycmux.
2. Back up both installed exe copies with `.bak.<timestamp>`.
3. Copy the rebuilt exe to both installed paths.
4. Start mycmux with WebView2 CDP enabled.
5. Run `node scripts\verify-focus-stability-cdp.mjs --name mycmux --port 9223 --setup-if-needed --allow-text` and confirm the new inactive right-click word selection assertion passes.

### Do not do

- Do not run the CDP mouse-click probe while Miyazaki-san is actively using mycmux; it dispatches real UI mouse events.
- Do not claim the installed app is fixed yet. The repo is patched and built, but the installed exe still has the old hash.