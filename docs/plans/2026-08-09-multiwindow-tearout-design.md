# Multi-Window Tear-Out — Design (2026-08-09)

Companion to `2026-08-09-v1-roadmap.md` Phase 3. Produced by design-agent exploration; line numbers refer to v0.21.29 (`5cbfc11`). Re-verify before each phase.

## Verified facts

- One window declared, `decorations:false` (`src-tauri/tauri.conf.json:12-22`). No `WebviewWindow::builder` anywhere.
- Leader election is **one-shot and non-renewable**: `claim_leader` = `compare_exchange(false,true)` on `AppState.bootstrapped` (`src-tauri/src/commands/window.rs:64-70`). A second window gets `false` and loads nothing (`SocketListener.tsx:867-873`).
- **Key finding — simultaneous attach is already structurally impossible.** `create_session` takes `on_data: Channel<InvokeResponseBody>` (`commands/terminal.rs:86`); `SessionManager::create` reattaches by **replacing** the channel (`pty/manager.rs:91-112` → `session.replace_data_channel`, `pty/session.rs:820`). One session streams to exactly one webview.
- Unmount does not kill the PTY: `cacheCurrentTerminal` detaches and caches (`XTermWrapper.tsx:1882-1911`). Cross-window moves = detach/reattach, not respawn.
- `ensure_window_bounds` (`commands/window.rs:16-62`) already takes `&WebviewWindow`; only `reveal_main_window` hardcodes `"main"`.

## Four blockers a naive second window hits

1. **Capability scope**: `src-tauri/capabilities/default.json:4` is `"windows": ["main"]` — any other label gets zero permissions, every `invoke` fails. `core:webview:allow-create-webview-window` is absent, so window creation must go through a Rust command (preferred anyway; use `app.run_on_main_thread` like `reveal_main_window` at `commands/window.rs:75`).
2. **Socket API fan-out**: `app.emit("socket-request", &req)` (`socket.rs:430`) broadcasts to every window → double execution. Exactly one window must handle it.
3. **Close = quit**: `onCloseRequested` in `SocketListener.tsx:1217` ends in `quitApp()` (`commands/window.rs:86-95` → kill_all + exit).
4. **No hydration for non-leader windows**: theme/keybindings/workspaces hydrate only in the leader branch (`SocketListener.tsx:884-891`).

## Window model

Full `AppShell` per window, filtered by assignment. Reused as-is: TitleBar, WorkspaceView, TerminalPane, XTermWrapper, PaneDragOverlay, PaneTabBar, KeybindingsModal, CrsmPalette, TabBar (filtered), ToastHost.

Main-window-only singletons (add `src/lib/windowContext.ts` with `windowLabel()` / `isMainWindow()`):

| Singleton | Location | Action |
|---|---|---|
| Persistence engine (load + autosave) | `SocketListener.tsx:863-1306` | main only |
| `socket-request` handler | `SocketListener.tsx:1309-1323` | JS early-return in children (keeps the pinned `listen<SocketRequestPayload>("socket-request"` literal and Rust `app.emit` — `test_socket_api_contract.py` unaffected) |
| `onCloseRequested` → quit | `SocketListener.tsx:1217-1293` | main only; children get merge-back close handler |
| `remote-error` dialog | `AppShell.tsx:491-504` | main only |
| Startup reveal / mask gate | `App.tsx:344-382` | main only; children show() after first paint |
| `useAgentDormancy`, `preloadCrsmSessions`, savepoint refresh | `App.tsx:147`, `AppShell.tsx:372-378` | main only (dormancy must not double-fire) |
| Updater | `AppInfoTab.tsx` → `forcedAutoUpdater.ts:91` | main only |

## State sync — sharded stores + Rust WindowRegistry + leader merge

Rejected: (b) children as thin IPC views (latency-hostile for a terminal); (c) move workspace/layout SoT to Rust (XL, `workspaceLayoutStore.ts` 1,503 lines, ~32 `_updateWorkspacePanes` call sites, contract pins on store action names).

Adopted:
- Each window runs full Zustand stores holding **only its assigned workspaces**.
- New `src-tauri/src/window_registry.rs` in `AppState`:
  - `assignments: DashMap<workspace_id, window_label>`
  - `fragments: DashMap<window_label, serde_json::Value>` (each window's last published `WorkspaceConfig[]` + active selection)
  - `pending_adoptions: DashMap<window_label, Vec<WorkspaceConfig>>`
- Every window publishes its fragment on a debounced store subscription (mirror `markDirty`/`scheduleSync` at `SocketListener.tsx:1125-1139`, calling `publish_window_fragment`).
- **Main stays the sole `data.json` writer.** Leader `buildSnapshot` (`SocketListener.tsx:1005-1082`) appends all non-main fragments. Cross-process mutex (`db/storage.rs:30-50`) untouched.
- Why registry: crash safety (main re-adopts a dead child's fragment); the phone remote loads `data.json` for workspace names (`remote/mod.rs:436-444`) — **persisting only main's list would make the phone lose torn-out workspaces (single hardest requirement)**; socket routing needs workspace→window map.
- Bus: Rust emits `mycmux://window-registry-changed` (broadcast revision counter) + targeted `mycmux://window-adopt` / `mycmux://window-release` via `emit_to`.

Footguns:
- `settingsStore` persists to shared `localStorage["mycmux-settings"]` (`settingsStore.ts:42,64`) — windows are not reactive to each other. Phase 1: main-only Settings UI; Phase 4: `storage` event + `persist.rehydrate()`.
- Children need `get_app_settings`-style hydration (theme/keybindings without workspaces).

## PTY attach / focus / zoom

Move protocol (window A → B):
1. A removes the pane/tab from its store **without** `killSession` (contrast `AppShell.tsx:556-567` which kills on workspace close — move path must not go through it).
2. A calls `evictTerminalCache(sessionId)` (`XTermWrapper.tsx:109`) + `focusController.clearSession(sessionId)`.
3. B inserts serialized Pane/PaneTab, mounts XTermWrapper → `attachFrontendChannel` (`XTermWrapper.tsx:1768-1797`) → reattach branch → scrollback resync repaints. No respawn, no lost output.

Phase 3 (drag races): add `attached_window: Mutex<Option<String>>` to `PtySession`; `create_session` rejects reattach whose window label mismatches registry assignment.

Per-window for free: focusController, uiStore (activePaneId/zoomedPaneId), keydown handler, attachEpoch, termCache. `resolveNextAttentionTarget` takes the (filtered) workspace list → correct per window for free.

Needs care: `buildSnapshot` persists a single active selection (`SocketListener.tsx:1078-1080`) — keep main's as global, per-window selection goes in `WindowConfig` (Phase 4). `pty_work_done` badging (`App.tsx:259-263`) must guard "session in this window's workspaces" to avoid double-count.

## Drag protocol (three tiers)

Tauri has no cross-window pointer capture and no arbitrary-payload OS drag (`onDragDropEvent` is file-paths-only). But with `setPointerCapture` (`usePaneDragSource.ts:357`), `pointermove` keeps firing after the cursor leaves the webview, with `screenX/screenY`.

- **Tier 1 — tear-out** (Phase 3c): add `{kind:"new-window"; screenX; screenY}` to `PaneDropTarget` (`paneDragStore.ts:21-35`); in `resolveDropTargetAtPoint` (`usePaneDragSource.ts:106`) return it when the point is ≥40px outside the viewport (existing `return null` path at :132 is the hook); in `commitPaneDragDrop` (:178) branch beside `new-workspace` (:190): `moveTabToNewWorkspace`/`movePaneToNewWorkspace` then `openWorkspaceWindow({workspaceIds, x: screenX-160, y: screenY-24})`. Keep the `focusController.request("drag", …)` pin at :250. Guard: ≥40px + ≥300ms dwell + ghost outline.
- **Tier 2 — merge-back without drag** (Phase 3b): child close → merge workspaces back to main (sessions survive; modifier/setting for kill). Sidebar context menu → 「メインウィンドウに戻す」/「ウィンドウNへ移動」. Covers ~90%.
- **Tier 3 — true cross-window drop** (optional, L): source throttles `drag_hover(screenX,screenY,item)` to Rust; Rust hit-tests Win32 `WindowFromPoint`+`GetAncestor(GA_ROOT)`, maps HWND→label, converts coords per-monitor `scale_factor()`; `emit_to(target, "mycmux://external-drag-hover")`; target runs existing `resolveDropTargetAtPoint`. Risks: mixed-DPI math, occluded/minimized targets, overlay flicker. Do not attempt before Tiers 1-2 are stable.

## Lifecycle

- Single-instance guard (`lib.rs:36-48`): unchanged — one process, N windows.
- Taskbar: each window gets its own button (desired). Set app icon per window (mirror `lib.rs:348-350`).
- `Destroyed → kill_all` (`lib.rs:368-373`) is main-only — keep; children get a fragment-return handler.
- Main close busy-confirm: `countBusySessions` (`SocketListener.tsx:1141-1166`) must count across windows (ask Rust).
- Updater: main-only; before `relaunch()` force `sync(true)` incl. window layout.
- Savepoint `PUBLISH_PROGRESS_EVENT` is global emit (`commands/online_publish.rs:127,167`) → scope by initiating window label (do early).

## Persistence schema (additive, serde default)

```rust
pub struct WindowBounds { x: i32, y: i32, width: u32, height: u32, #[serde(default)] maximized: bool }
pub struct WindowConfig {
    id: String,                                   // == window label, stable
    #[serde(default)] bounds: Option<WindowBounds>,
    #[serde(default)] workspace_ids: Vec<String>,
    #[serde(default)] active_workspace_id: Option<String>,
    #[serde(default)] active_pane_id: Option<String>,
    #[serde(default)] active_tab_id: Option<String>,
}
// PersistentData: #[serde(default)] windows: Vec<WindowConfig>   (empty ⇒ all in "main")
// WorkspaceConfig: #[serde(default)] window_id: Option<String>   (redundant, self-healing)
```

Migration: zero-risk (old files → all main). Bump `schema_version` write to 2 (`commands/workspace.rs:15`), keep read default 1 (`storage.rs:152`). Load reconciliation: drop empty WindowConfigs, reassign orphans to main. Window labels deterministic reused (`mycmux-w1`, `mycmux-w2`, lowest free). `WindowConfig.bounds` is the authority; `tauri_plugin_window_state` (`lib.rs:217-224`) is a nicety — do not reorder its builder position (pinned by `test_window_command_contract.py`).

## Phases (roadmap 3a-3d)

- **3a (S)**: capability glob `["main","mycmux-w*"]`; `open_child_window` command (sync + run_on_main_thread → add to `SYNC_ALLOWLIST`); `windowContext.ts`; socket/close/persist/updater main-only guards; child boot-probe (invoke check + hard error UI). Verify: second window renders, socket commands execute once, child close doesn't quit.
- **3b (M) = minimal shippable**: WindowRegistry + commands (`open_workspace_window`, `list_app_windows`, `publish_window_fragment`, `take_pending_adoption`, `release_workspaces`, `get_window_fragments`, `get_app_settings`); sidebar context menu 「新しいウィンドウで開く」; non-leader boot path (hydrate settings + adopt via `restorePanes` verbatim); leader buildSnapshot union merge; close = merge-back; scope publish events. Risks: child crash → fragment re-adopt + startup orphan reconciliation; double-save → children never call `save_persistent_data` (unit-test it); quit staleness → bounded (500ms) fragment flush await in main's final sync.
- **3c (M)**: drag tear-out (Tier 1). Contract: keep `focusController.request("drag")` pin; stay out of savepointDragStore (`test_savepoint_drag_contract.py`).
- **3d (M)**: WindowConfig persistence + restore at startup (generalized `ensure_window_bounds` per window); cross-window busy count; settingsStore rehydration; updater flush; per-window startup reveal gate.

## Contract-test impact summary

| Test | Impact |
|---|---|
| `test_window_command_contract.py` | Extend (add new command exposure); `claim_leader` pin survives |
| `test_command_sync_contract.py` | Extend SYNC_ALLOWLIST |
| `test_socket_api_contract.py` | No change (JS early-return guard; do NOT switch emit → emit_to) |
| `test_layout_stability_contract.py` | No change (keep drag focus pin) |
| `test_savepoint_drag_contract.py` | No change |
| `test_no_restart_ui_surface_contract.py:66-75` | No change (`moveTabToNewWorkspace:`/`movePaneToNewWorkspace:` reused) |
| `test_session_restore_agent_kind.py` | No change — pinned `return Ok(());` reattach early-return (`pty/manager.rs:111`) is the mechanism this design rides on; never touch |
| `test_ipc_attach_epoch_contract.py` | No change |

## Top risks

1. data.json loses torn-out workspaces (also breaks phone remote) → union merge + fragments + orphan reconciliation.
2. Capability typo silently kills child IPC → glob + boot-probe.
3. Child close = quit → per-window handler + contract test asserting quit_app is main-only.
4. Double socket execution → single-handler guard + e2e `mycmux_agent_cli` test.
5. Attach ping-pong in drag races → `attached_window` guard (Tier 3 prerequisite).
