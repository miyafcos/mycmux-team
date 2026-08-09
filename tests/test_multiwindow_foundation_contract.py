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
    for permission in ["core:window:allow-show", "core:window:allow-set-focus"]:
        assert permission in permissions, (
            f"{permission} missing from capabilities/default.json"
        )


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


def test_socket_request_handler_is_main_window_only() -> None:
    socket_listener = read_repo_text(SOCKET_LISTENER)

    # The pinned literal from test_socket_api_contract.py must survive: the
    # guard is a JS early-return, NOT an emit → emit_to switch on the Rust side.
    listen_index = socket_listener.index('listen<SocketRequestPayload>("socket-request"')
    guard_index = socket_listener.rindex(MAIN_ONLY_GUARD, 0, listen_index)
    effect_index = socket_listener.rindex("useEffect(() => {", 0, listen_index)

    assert effect_index < guard_index < listen_index, (
        "The socket-request subscription must be preceded by the isMainWindow() "
        "early-return inside the same useEffect — Rust broadcasts the event to "
        "every window."
    )

    socket_rs = read_repo_text("src-tauri/src/socket.rs")
    assert_contains(socket_rs, 'app.emit("socket-request", &req)', "src-tauri/src/socket.rs")
    assert 'emit_to("main", "socket-request"' not in socket_rs


def test_quit_app_is_unreachable_from_a_child_window_close() -> None:
    socket_listener = read_repo_text(SOCKET_LISTENER)

    autosave_index = socket_listener.index("// Auto-save — only leader saves.")
    close_handler_index = socket_listener.index(
        "const unlistenCloseRequested = getCurrentWindow().onCloseRequested"
    )
    guard_index = socket_listener.index(MAIN_ONLY_GUARD, autosave_index)

    assert autosave_index < guard_index < close_handler_index, (
        "The autosave/close effect must early-return for child windows before "
        "registering onCloseRequested. Otherwise closing a torn-out window runs "
        "the quit path (kill_all + exit)."
    )

    # Every quitApp() call site in the frontend lives behind that guard.
    call_sites = [
        index
        for index in range(len(socket_listener))
        if socket_listener.startswith("await quitApp();", index)
    ]
    assert call_sites, "expected the main-window quit path to still call quitApp()"
    for index in call_sites:
        assert index > guard_index, (
            "quitApp() is reachable from code that runs in child windows"
        )

    for source in [APP, APP_SHELL]:
        assert "quitApp" not in read_repo_text(source), (
            f"{source} must not call quitApp() — the quit path stays in the "
            "main window's persistence effect"
        )


def test_persistence_engine_is_main_window_only() -> None:
    socket_listener = read_repo_text(SOCKET_LISTENER)

    claim_index = socket_listener.index("claimLeader()")
    # The load effect has to unblock `persistLoaded` before returning, so its
    # guard is a block, not the one-line early return used elsewhere.
    guard_index = socket_listener.rindex("if (!isMainWindow()) {", 0, claim_index)
    load_index = socket_listener.index("return loadPersistentData().then(async (data) => {")

    assert_contains(socket_listener, "      isLeader.current = false;", SOCKET_LISTENER)
    assert_contains(socket_listener, "      _resolveLoaded();", SOCKET_LISTENER)

    assert guard_index < claim_index < load_index, (
        "Child windows must return before claimLeader(): leadership is a "
        "one-shot compare_exchange, so a child winning the race would leave "
        "the main window with nothing loaded."
    )

    # data.json stays a main-window-only write.
    save_index = socket_listener.index("savePersistentData(buildSnapshot(")
    assert socket_listener.index("// Auto-save — only leader saves.") < save_index
    assert socket_listener.index(MAIN_ONLY_GUARD, socket_listener.index(
        "// Auto-save — only leader saves."
    )) < save_index


def test_app_level_singletons_are_main_window_only() -> None:
    app = read_repo_text(APP)

    for snippet in [
        "const isMain = isMainWindow();",
        # Dormancy sweeps kill idle agent sessions — must not double-fire.
        "useAgentDormancy(ready && isMain);",
        # Children start empty; bootstrap would spawn a stray PTY per tear-out.
        "if (isMain && listStore.workspaces.length === 0 && launchCwd) {",
        # Children reveal themselves; only main runs the startup session gate.
        "if (!isMain) {",
        "await childWindow.show();",
        # Main path preserved (also pinned by test_window_command_contract.py).
        "const gateResult = await waitForStartupSessionGate(startupTimeoutMs);",
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
    app_info = read_repo_text(APP_INFO_TAB)

    for snippet in [
        "const canCheckForUpdates = isMainWindow();",
        "{canCheckForUpdates && (",
    ]:
        assert_contains(app_info, snippet, APP_INFO_TAB)

    handler_index = app_info.index("const handleCheckUpdate")
    assert app_info.index("const canCheckForUpdates = isMainWindow();") > handler_index


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
        'invoke<AppSettings>("get_app_settings")',
    ]:
        assert_contains(ipc, snippet, "src/lib/ipc.ts")

    # The registry lives in AppState, not in a module-level static: the tests
    # (and a second app instance) must be able to build one from scratch.
    assert_contains(lib_rs, "window_registry: window_registry::WindowRegistry::new(),", "src-tauri/src/lib.rs")


def test_children_publish_fragments_and_never_write_data_json() -> None:
    """Two windows writing data.json is the double-save failure mode."""
    socket_listener = read_repo_text(SOCKET_LISTENER)

    save_sites = [
        index
        for index in range(len(socket_listener))
        if socket_listener.startswith("savePersistentData(", index)
    ]
    assert save_sites, "expected main to still write data.json"
    autosave_guard = socket_listener.index(
        MAIN_ONLY_GUARD, socket_listener.index("// Auto-save — only leader saves.")
    )
    for index in save_sites:
        assert index > autosave_guard, (
            "savePersistentData() must stay behind the main-window guard — a "
            "child window writing data.json would race main's own save"
        )

    # ... and the child's substitute is the registry.
    publish_index = socket_listener.index("await publishWindowFragment(buildWindowFragment());")
    child_guard = socket_listener.rindex("if (isMainWindow()) return;", 0, publish_index)
    child_effect = socket_listener.rindex("useEffect(() => {", 0, publish_index)
    assert child_effect < child_guard < publish_index, (
        "fragment publishing must be a child-window-only effect"
    )


def test_leader_snapshot_merges_the_other_windows_workspaces() -> None:
    """data.json losing a torn-out workspace also breaks the phone remote."""
    socket_listener = read_repo_text(SOCKET_LISTENER)

    for snippet in [
        "windowFragments = await getWindowFragments();",
        "savePersistentData(buildSnapshot(agentMappings, windowFragments))",
        "const rawConfigs = mergeWindowFragmentWorkspaces(",
    ]:
        assert_contains(socket_listener, snippet, SOCKET_LISTENER)

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
    tear_out = read_repo_text(WORKSPACE_TEAR_OUT)

    for snippet in [
        "export async function tearOutWorkspaceToNewWindow(",
        "const config = toConfig(workspace);",
        "await openWorkspaceWindow({",
        "evictTerminalCache(sessionId);",
        "focusController.clearSession(sessionId);",
        "removeWorkspace(workspaceId);",
    ]:
        assert_contains(tear_out, snippet, WORKSPACE_TEAR_OUT)

    # (the doc comment names it; what must not exist is a call)
    assert "killSession(" not in tear_out, (
        "tearing out a workspace must not kill its sessions — that is the "
        "whole point of the move protocol (AppShell's close path is the one "
        "that kills)"
    )

    # And it is reachable from the sidebar.
    tab_bar = read_repo_text(TAB_BAR)
    assert_contains(tab_bar, "新しいウィンドウで開く", TAB_BAR)
    assert_contains(tab_bar, "tearOutWorkspaceToNewWindow(workspaceId, {", TAB_BAR)


def test_child_close_merges_back_instead_of_quitting() -> None:
    socket_listener = read_repo_text(SOCKET_LISTENER)

    child_close_index = socket_listener.index(
        "const unlistenCloseRequested = getCurrentWindow().onCloseRequested",
        socket_listener.index("if (isMainWindow()) return;"),
    )
    child_close = socket_listener[child_close_index : child_close_index + 2000]

    for snippet in [
        "await publishWindowFragment(buildWindowFragment());",
        "await releaseWorkspaces(windowLabel(), workspaceIds, MAIN_WINDOW_LABEL);",
        "await getCurrentWindow().destroy();",
    ]:
        assert_contains(child_close, snippet, "child close handler")
    assert "quitApp" not in child_close, "a child close must never reach the quit path"

    # window.destroy() is not part of core:window:default.
    capability = json.loads(read_repo_text("src-tauri/capabilities/default.json"))
    assert "core:window:allow-destroy" in capability["permissions"]


def test_registry_reclaims_workspaces_from_a_destroyed_window() -> None:
    """Crash path: a child that never runs its close handler still gives back."""
    window_rs = read_repo_text(WINDOW_RS)
    registry_commands = read_repo_text(WINDOW_REGISTRY_COMMANDS_RS)
    registry = read_repo_text(WINDOW_REGISTRY_RS)

    assert_contains(window_rs, "tauri::WindowEvent::Destroyed = event", WINDOW_RS)
    assert_contains(
        window_rs,
        "crate::commands::window_registry::reclaim_destroyed_window(",
        WINDOW_RS,
    )
    for snippet in [
        "pub fn reclaim_destroyed_window(app: &AppHandle, label: &str)",
        "release_all(label, MAIN_WINDOW_LABEL)",
        "emit_to(target.as_str(), WINDOW_ADOPT_EVENT, payload)",
    ]:
        assert_contains(registry_commands, snippet, WINDOW_REGISTRY_COMMANDS_RS)

    for snippet in [
        "pub fn release_workspaces(",
        "pub fn release_all(",
        "pub fn take_pending_adoption(",
        "pub fn publish_fragment(",
    ]:
        assert_contains(registry, snippet, WINDOW_REGISTRY_RS)


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
