"""Phase 3a multi-window foundation contract.

Design: docs/plans/2026-08-09-multiwindow-tearout-design.md ("Phase 3a (S)").

The foundation is a set of *negative* guarantees: a second window boots the
same bundle, so every app-wide singleton has to be gated on `isMainWindow()`.
The three that cause visible damage when they regress:

1. capability glob — a label outside `mycmux-w*` gets zero permissions and the
   whole child window is inert,
2. `socket-request` — Rust broadcasts it (`app.emit`), so an unguarded child
   would execute every socket command a second time,
3. close → `quitApp()` — a child close must not kill every PTY in the process.
"""

from __future__ import annotations

import json
import re
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]

SOCKET_LISTENER = "src/components/layout/SocketListener.tsx"
APP_SHELL = "src/components/layout/AppShell.tsx"
APP = "src/App.tsx"
WINDOW_CONTEXT = "src/lib/windowContext.ts"
APP_INFO_TAB = "src/components/settings/tabs/AppInfoTab.tsx"
MULTIWINDOW_DEV = "src/lib/multiWindowDev.ts"
WINDOW_RS = "src-tauri/src/commands/window.rs"
# Phase 3b
WINDOW_REGISTRY_RS = "src-tauri/src/window_registry.rs"
WINDOW_REGISTRY_COMMANDS_RS = "src-tauri/src/commands/window_registry.rs"
WORKSPACE_RESTORE = "src/lib/workspaceRestore.ts"
WORKSPACE_TEAR_OUT = "src/lib/workspaceTearOut.ts"
WINDOW_FRAGMENTS = "src/lib/windowFragments.ts"
TAB_BAR = "src/components/layout/TabBar.tsx"

MAIN_ONLY_GUARD = "if (!isMainWindow()) return;"


def read_repo_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def assert_contains(text: str, snippet: str, source: str) -> None:
    assert snippet in text, f"Missing snippet in {source}: {snippet}"


def test_capability_covers_child_window_labels() -> None:
    capability = json.loads(read_repo_text("src-tauri/capabilities/default.json"))

    assert capability["windows"] == ["main", "mycmux-w*"], (
        "Child windows are labelled mycmux-w<n> (commands::window::next_child_window_label). "
        "Without the glob they get zero permissions and every invoke from them fails."
    )

    permissions = capability["permissions"]
    # Children reveal themselves after first paint (App.tsx) — neither
    # allow-show nor allow-set-focus is part of core:window:default.
    # allow-set-size is how a detached window snaps to a screen edge; without
    # it the call is refused by the ACL and the window silently only moves.
    # allow-hide is what macOS's close button does to the main window; without
    # it the window refuses to close at all (measured on a Mac, 2026-09-17).
    for permission in [
        "core:window:allow-show",
        "core:window:allow-hide",
        "core:window:allow-set-focus",
        "core:window:allow-destroy",
        "core:window:allow-set-position",
        "core:window:allow-set-size",
    ]:
        assert permission in permissions, (
            f"{permission} missing from capabilities/default.json"
        )


def test_mac_child_chrome_matches_main_without_changing_windows() -> None:
    """分離窓も Mac の標準枠を使い、独自タイトルバーと重ねる。"""
    text = read_repo_text(WINDOW_RS)
    child = text[text.index("pub fn spawn_child_window("):text.index("pub fn open_child_window(")]
    assert '.decorations(cfg!(target_os = "macos"))' in child
    assert re.search(
        r'#\[cfg\(target_os = "macos"\)\]\s*\{\s*builder = builder\s*'
        r'\.title_bar_style\(tauri::TitleBarStyle::Overlay\)\s*'
        r'\.hidden_title\(true\);\s*\}', child,
    )
    main = json.loads(read_repo_text("src-tauri/tauri.macos.conf.json"))["app"]["windows"][0]
    assert main["decorations"] is True
    assert main["titleBarStyle"] == "Overlay"
    assert main["hiddenTitle"] is True
    assert ".set_decorations(" not in child


def test_window_context_helper_exists() -> None:
    window_context = read_repo_text(WINDOW_CONTEXT)

    for snippet in [
        'export const MAIN_WINDOW_LABEL = "main";',
        'export const CHILD_WINDOW_LABEL_PREFIX = "mycmux-w";',
        "export function windowLabel(): string",
        "export function isMainWindow(): boolean",
        "cachedLabel = getCurrentWindow().label;",
    ]:
        assert_contains(window_context, snippet, WINDOW_CONTEXT)

    # The Rust and JS prefixes must not drift apart.
    window_rs = read_repo_text(WINDOW_RS)
    assert_contains(window_rs, 'pub const CHILD_WINDOW_LABEL_PREFIX: &str = "mycmux-w";', WINDOW_RS)


def test_socket_request_handler_is_role_owner_only() -> None:
    """A broadcast socket command must execute in exactly one role owner."""
    text = read_repo_text(SOCKET_LISTENER)
    subscriptions = list(re.finditer(r'listen<SocketRequestPayload>\("socket-request"', text))
    assert len(subscriptions) == 1
    start = subscriptions[0].start()
    end = text.index('return () => {', start)
    handler = text[start:end]
    guard = handler.index("if (!isLeader.current) return;")
    dispatch = handler.index("handleSocketCommand(cmd, args)")
    assert "await " not in handler[guard:dispatch].replace("const result = await ", "")
    socket_rs = read_repo_text("src-tauri/src/socket.rs")
    assert 'app.emit("socket-request", &req)' in socket_rs
    assert 'emit_to("main", "socket-request"' not in socket_rs


def test_quit_app_is_unreachable_from_a_child_window_close() -> None:
    """No frontend close path may globally quit while a peer survives."""
    for source in [SOCKET_LISTENER, APP, APP_SHELL]:
        assert "quitApp" not in read_repo_text(source), source
    window_rs = read_repo_text(WINDOW_RS)
    quit_start = window_rs.index("pub fn quit_app(")
    quit_body = window_rs[quit_start:window_rs.index("#[cfg(test)]", quit_start)]
    guard = quit_body.index("if !app.webview_windows().is_empty()")
    refusal = quit_body.index("return Err(", guard)
    calls = [match.start() for match in re.finditer(r"app\.exit\(0\)", window_rs)]
    assert len(calls) == 1
    assert quit_start + guard < quit_start + refusal < calls[0]
    assert "kill_all" not in quit_body
    lifecycle = window_rs[window_rs.index("pub fn handle_app_run_event("):quit_start]
    event = lifecycle.index("tauri::RunEvent::ExitRequested")
    assert "ExitRequested { code, api, .. }" in lifecycle
    # Pin the complete veto branch: programmatic exit/restart must bypass it.
    veto = re.search(
        r"if code\.is_none\(\) && live_windows != 0\s*\{\s*"
        r"api\.prevent_exit\(\);\s*return;\s*\}", lifecycle,
    )
    assert veto is not None, "Only a non-programmatic exit with live peers may be vetoed"
    assert lifecycle.count("api.prevent_exit()") == 1
    assert "tauri::RunEvent::Exit => (0, Some(0))" in lifecycle
    assert lifecycle.count("begin_shutdown(") == 1
    live = veto.start()
    prevent = lifecycle.index("api.prevent_exit();")
    latch = lifecycle.index("begin_shutdown(live_windows, code)")
    assert "if !state.window_registry.begin_shutdown(live_windows, code) { return; }" in lifecycle
    registry = read_repo_text("src-tauri/src/window_registry.rs")
    shutdown = registry[registry.index("pub fn begin_shutdown("):registry.index("pub fn rescue_target(")]
    assert "(code.is_some() || live_windows == 0) && self.shutdown_started" in shutdown
    assert ".compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok()" in shutdown
    assert "programmatic_exit_and_updater_restart_clean_up_with_live_windows_once" in registry
    assert "for code in [0, i32::MAX]" in registry
    assert "assert!(registry.begin_shutdown(2, Some(code)))" in registry
    assert "assert!(!registry.begin_shutdown(2, Some(code)))" in registry
    kills = [match.start() for match in re.finditer(r"\.kill_all\(", lifecycle)]
    assert len(kills) == 2
    assert all(event < live < prevent < latch < kill for kill in kills)
    assert latch < lifecycle.index("flush_all_scrollbacks") < kills[0]
    assert latch < lifecycle.index("revoke_all()")
    lib_rs = read_repo_text("src-tauri/src/lib.rs")
    assert "kill_all()" not in lib_rs
    assert ".run(commands::window::handle_app_run_event)" in lib_rs


def test_startup_restore_stays_main_and_persistence_role_is_transferable() -> None:
    """Do not restore startup data before acquiring the role; never restore it in peers."""
    text = read_repo_text(SOCKET_LISTENER)
    boot = text.index("// Load on mount")
    identity_guard = text.index("if (!isMainWindow()) {", boot)
    claim = text.index("claimLeader()", identity_guard)
    peer_branch = text[identity_guard:claim]
    assert "hydrateChildWindow()" in peer_branch
    assert "_resolveLoaded();" in peer_branch
    assert "return;" in peer_branch
    owner_set = text.index("isLeader.current = gotLeadership;", claim)
    reject = text.index("if (!gotLeadership) {", owner_set)
    load = text.index("return loadPersistentData().then(async (envelope) => {", reject)
    assert boot < identity_guard < claim < owner_set < reject < load
    assert "_resolveLoaded();" in text[reject:load]
    assert "return;" in text[reject:load]
    loads = [match.start() for match in re.finditer(r"loadPersistentData\(", text)]
    assert loads == [load + len("return ")]
    retry = text.index("const claim = () => {")
    hydrated = text.index("await persistLoaded;", retry)
    reclaim = text.index("await claimLeader();", hydrated)
    assert retry < hydrated < reclaim
    assert "listen(WINDOW_REGISTRY_CHANGED_EVENT, claim)" in text
    hydration = text[text.index("async function hydrateChildWindow()"):text.index("function buildWindowFragment(")]
    assert "publishPersistentSchemaAfterHydration(settings.schema_version" in hydration
    assert "loadPersistentData" not in hydration


def test_app_level_singletons_follow_role_without_changing_startup_identity() -> None:
    app = read_repo_text(APP)

    for snippet in [
        "const isMain = isMainWindow();",
        # Dormancy sweeps kill idle agent sessions — must not double-fire.
        "useAgentDormancy(ready && hasRole);",
        "connectDispatchWatchdog();",
        # Children start empty; bootstrap would spawn a stray PTY per tear-out.
        "if (isMain && listStore.workspaces.length === 0 && launchCwd) {",
        # Children reveal themselves; only main runs the startup session gate.
        "if (!isMain) {",
        "await childWindow.show();",
        # Main starts the gate before reveal but does not block on it.
        "const gateCompletion = waitForStartupSessionGate(startupTimeoutMs);",
        "await revealMainWindow();",
    ]:
        assert_contains(app, snippet, APP)

    child_branch_index = app.index("if (!isMain) {")
    assert child_branch_index < app.index("await revealMainWindow();"), (
        "the child reveal branch must short-circuit before revealMainWindow()"
    )


def test_child_boot_probe_reports_capability_failures() -> None:
    app = read_repo_text(APP)

    for snippet in [
        "getTerminalConfig()",
        "setChildProbeError(",
        "if (childProbeError) {",
        '"[multiwindow] child window IPC probe failed"',
    ]:
        assert_contains(app, snippet, APP)

    # Rust safety net: a permission-less child cannot show itself either.
    window_rs = read_repo_text(WINDOW_RS)
    assert_contains(window_rs, "fn schedule_child_window_reveal_fallback(", WINDOW_RS)


def test_shell_level_singletons_are_main_window_only() -> None:
    app_shell = read_repo_text(APP_SHELL)

    for anchor in [
        "preloadCrsmSessions();",
        "void useOnlineSavepointStore.getState().refresh();",
        'listen<string>("remote-error"',
    ]:
        anchor_index = app_shell.index(anchor)
        guard_index = app_shell.rindex(MAIN_ONLY_GUARD, 0, anchor_index)
        effect_index = app_shell.rindex("useEffect(() => {", 0, anchor_index)
        assert effect_index < guard_index < anchor_index, (
            f"{anchor} must be guarded by isMainWindow() inside its own useEffect"
        )


def test_updater_ui_is_main_window_only() -> None:
    """Updater ownership reacts to takeover, with test profiles still disabled."""
    source = read_repo_text(APP_INFO_TAB)
    subscribe = source.index("const hasRole = useWindowRole();")
    gate = source.index("const canCheckForUpdates = hasRole && testProfile === null;")
    button = source.index("{canCheckForUpdates && (")
    assert subscribe < gate < button
    handler = source.index("const handleCheckUpdate")
    guard = source.index("if (!hasWindowRole() || testProfile !== null) return;", handler)
    run = source.index("await runUpdateCheck", handler)
    assert handler < guard < run
    context = read_repo_text(WINDOW_CONTEXT)
    assert "useSyncExternalStore(subscribeWindowRole, hasWindowRole" in context


def test_window_registry_commands_are_exposed() -> None:
    """Phase 3b: the tear-out plumbing has to be reachable from both sides."""
    lib_rs = read_repo_text("src-tauri/src/lib.rs")
    ipc = read_repo_text("src/lib/ipc.ts")

    for command in [
        "commands::window_registry::open_workspace_window",
        "commands::window_registry::publish_window_fragment",
        "commands::window_registry::take_pending_adoption",
        "commands::window_registry::release_workspaces",
        "commands::window_registry::get_window_fragments",
        "commands::window_registry::get_app_settings",
    ]:
        assert_contains(lib_rs, command, "src-tauri/src/lib.rs")

    for snippet in [
        'invoke<string>("open_workspace_window", {',
        'invoke<void>("publish_window_fragment", { fragment })',
        'invoke<WorkspaceConfig[]>("take_pending_adoption", { label })',
        'invoke<number>("release_workspaces", { fromLabel, workspaceIds, toLabel })',
        'invoke<WindowFragment[]>("get_window_fragments")',
        'invoke<AppSettings & { schema_version: number }>("get_app_settings")',
    ]:
        assert_contains(ipc, snippet, "src/lib/ipc.ts")

    # The registry lives in AppState, not in a module-level static: the tests
    # (and a second app instance) must be able to build one from scratch.
    assert_contains(lib_rs, "window_registry: window_registry::WindowRegistry::new(),", "src-tauri/src/lib.rs")


def test_all_windows_publish_fragments_and_only_role_owner_writes_data_json() -> None:
    """Two windows writing data.json is the double-save failure mode.

    Every write needs a fresh role guard AFTER the last await. Counting an
    entry guard, or checking the schema alone, does not prove exclusivity.
    """
    text = read_repo_text(SOCKET_LISTENER)
    # Four mandatory Compiler API checks live in persistenceRoleGuardAst.test.ts.
    publish = text.index("await publishWindowFragment(buildWindowFragment());")
    end = text.index("return listenForDetachedDock();", publish)
    assert "persistLoaded.then" in text[publish:end]
    assert "useWorkspaceLayoutStore.subscribe(markDirty)" in text[publish:end]


def test_leader_snapshot_merges_the_other_windows_workspaces() -> None:
    """data.json losing a torn-out workspace also breaks the phone remote."""
    merge = read_repo_text(WINDOW_FRAGMENTS)
    for snippet in [
        "export function mergeWindowFragmentWorkspaces(",
        # Own *published* fragment is redundant with the live store, but a
        # pending one is the only holder of a workspace mid-move: dropping it
        # would take that workspace out of data.json until the adopt lands.
        "if (fragment.window_label === ownLabel && !fragment.pending) continue;",
        "if (!workspace?.id || seen.has(workspace.id)) continue;",
    ]:
        assert_contains(merge, snippet, WINDOW_FRAGMENTS)


def test_adoption_reuses_the_startup_restore_code() -> None:
    """A forked restore is how a moved workspace comes back respawned."""
    restore = read_repo_text(WORKSPACE_RESTORE)
    socket_listener = read_repo_text(SOCKET_LISTENER)

    for snippet in [
        "export function restoreWorkspaceConfigs(",
        "layoutStore.restorePanes(",
        "listStore.createWorkspace(",
        "export function filterAlreadyRestoredConfigs(",
    ]:
        assert_contains(restore, snippet, WORKSPACE_RESTORE)

    # Both the startup path and the adoption path call the same helper.
    assert socket_listener.count("restoreWorkspaceConfigs(") >= 2, (
        "startup restore and adoption must share restoreWorkspaceConfigs()"
    )
    for snippet in [
        "function adoptWorkspaceConfigs(configs: WorkspaceConfig[]): string[] {",
        "const adopted = await takePendingAdoption(windowLabel());",
        "listen<WindowAdoptPayload>(WINDOW_ADOPT_EVENT",
    ]:
        assert_contains(socket_listener, snippet, SOCKET_LISTENER)

    # The child boots from settings, never from data.json.
    hydrate_index = socket_listener.index("async function hydrateChildWindow(): Promise<void> {")
    hydrate_body = socket_listener[hydrate_index : socket_listener.index("\n}\n", hydrate_index)]
    assert "getAppSettings()" in hydrate_body
    assert "loadPersistentData" not in hydrate_body


def test_tear_out_moves_sessions_instead_of_killing_them() -> None:
    """The move protocol: detach + reattach, never respawn."""
    # Runtime tear-out/session preservation: browserTabTransfer and detachedPane tests.
    # And it is reachable from the sidebar.
    tab_bar = read_repo_text(TAB_BAR)
    assert_contains(tab_bar, "新しいウィンドウで開く", TAB_BAR)
    assert_contains(tab_bar, "tearOutWorkspaceToNewWindow(workspaceId, {", TAB_BAR)


def test_close_helper_does_not_pull_foreign_workspaces_or_close_dock_peers() -> None:
    # Runtime close/order coverage is in peerWindowClose and detachedPaneReturn.
    # These exhaustive API prohibitions still need structural coverage.
    text = read_repo_text(SOCKET_LISTENER)
    helper_start = text.index("export async function closeWindowWorkspacesAndDestroy()")
    helper_end = text.index("export async function discardWindowWorkspacesAndClose", helper_start)
    helper = text[helper_start:helper_end]
    assert "releaseWorkspaces" not in helper and "getWindowFragments" not in helper
    transfer_start = text.index("export async function transferWindowWorkspacesAndClose(")
    transfer = text[transfer_start:helper_start]
    assert "killSession(" not in transfer
    dock = read_repo_text("src/stores/detachedDockStore.ts")
    assert "await emitTo(payload.label, DETACHED_DOCK_REQUEST_EVENT" in dock
    assert ".close()" not in dock


def test_registry_reclaims_workspaces_from_a_destroyed_window() -> None:
    """Crash rescue preserves sessions; explicit-close intent bypasses it."""
    commands = read_repo_text(WINDOW_REGISTRY_COMMANDS_RS)
    start = commands.index("pub fn handle_window_destroyed(")
    end = commands.index("pub fn reclaim_destroyed_window(", start)
    handler = commands[start:end]
    assert handler.index("take_close_intent(label)") < handler.index("forget_window(label)") < handler.index("} else {") < handler.index("reclaim_destroyed_window(app, label)")
    crash = commands[end:]
    assert "app.webview_windows()" in crash
    assert "rescue_target(label, &live)" in crash
    assert "release_all(label, &target)" in crash
    assert "MAIN_WINDOW_LABEL" not in crash
    assert "kill_all" not in crash and "kill_session" not in crash
    assert "emit_to(target.as_str(), WINDOW_ADOPT_EVENT, payload)" in commands
    lib_rs = read_repo_text("src-tauri/src/lib.rs")
    event = lib_rs.index(".on_window_event(|window, event|")
    assert lib_rs.index("handle_window_destroyed(window.app_handle(), window.label())", event) > event
    assert "reclaim_destroyed_window(" not in read_repo_text(WINDOW_RS)
    registry = read_repo_text(WINDOW_REGISTRY_RS)
    for snippet in ["pub fn release_workspaces(", "pub fn release_all(", "pub fn take_pending_adoption(", "pub fn publish_fragment("]:
        assert snippet in registry


def test_savepoint_publish_progress_is_scoped_to_one_window() -> None:
    online_publish = read_repo_text("src-tauri/src/commands/online_publish.rs")

    assert_contains(
        online_publish,
        "match window_label.as_deref() {",
        "src-tauri/src/commands/online_publish.rs",
    )
    assert_contains(
        online_publish,
        "let _ = app.emit_to(label, PUBLISH_PROGRESS_EVENT, payload);",
        "src-tauri/src/commands/online_publish.rs",
    )
    # The CLI/socket callers have no window and keep the broadcast.
    assert_contains(
        online_publish,
        "let _ = app.emit(PUBLISH_PROGRESS_EVENT, payload);",
        "src-tauri/src/commands/online_publish.rs",
    )
    assert_contains(read_repo_text("src/lib/ipc.ts"), "windowLabel: windowLabel(),", "src/lib/ipc.ts")


def test_child_window_dev_entry_point_is_dev_only() -> None:
    dev_hook = read_repo_text(MULTIWINDOW_DEV)

    for snippet in [
        "export function installChildWindowDevHook(): void",
        "if (!import.meta.env.DEV) return;",
        "window.__mycmuxOpenChildWindow = async",
    ]:
        assert_contains(dev_hook, snippet, MULTIWINDOW_DEV)

    guard_index = dev_hook.index("if (!import.meta.env.DEV) return;")
    assert guard_index < dev_hook.index("window.__mycmuxOpenChildWindow = async"), (
        "the dev hook must not be installed in production builds"
    )


def test_close_intent_serializes_with_incoming_drag_handoffs() -> None:
    registry = read_repo_text(WINDOW_REGISTRY_RS)
    start = registry.index("pub fn release_to_open_window(")
    end = registry.index("pub fn release_workspaces(", start)
    body = registry[start:end]
    assert body.index("self.closing.lock()") < body.index("closing.contains(to_label)") < body.index("self.release_workspaces(") < body.index("drop(closing)")
    commands = read_repo_text(WINDOW_REGISTRY_COMMANDS_RS)
    start = commands.index("pub fn release_workspaces(")
    assert commands.index("app.get_window(&to_label).is_none()", start) < commands.index("release_to_open_window", start)
    # Frontend adoption-before-victim-enumeration is exercised by peerWindowClose.
