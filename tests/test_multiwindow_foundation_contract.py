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
