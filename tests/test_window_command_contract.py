from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_repo_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def assert_contains(text: str, snippet: str, source: str) -> None:
    assert snippet in text, f"Missing snippet in {source}: {snippet}"


def test_window_leader_commands_are_exposed_to_frontend() -> None:
    ipc = read_repo_text("src/lib/ipc.ts")
    lib_rs = read_repo_text("src-tauri/src/lib.rs")

    for snippet in [
        "export async function claimLeader(): Promise<boolean>",
        'return invoke<boolean>("claim_leader");',
        "export async function revealMainWindow(): Promise<void>",
        'return invoke<void>("reveal_main_window");',
        "export async function quitApp(): Promise<void>",
        'return invoke<void>("quit_app");',
        # Multi-window Phase 3a
        "export async function openChildWindow(",
        'return invoke<string>("open_child_window", {',
    ]:
        assert_contains(ipc, snippet, "src/lib/ipc.ts")

    for command in [
        "commands::window::claim_leader",
        "commands::window::reveal_main_window",
        "commands::window::open_child_window",
        "commands::window::quit_app",
    ]:
        assert_contains(lib_rs, command, "src-tauri/src/lib.rs")

    # get_window_count was removed with the dead-code sweep (no frontend caller
    # since the file-explorer sidebar went away). Keep it gone on both sides so
    # it cannot creep back in unwired.
    assert "getWindowCount" not in ipc
    assert "get_window_count" not in lib_rs


def test_window_state_plugin_preserves_hidden_startup_contract() -> None:
    lib_rs = read_repo_text("src-tauri/src/lib.rs")

    for snippet in [
        "tauri_plugin_window_state::Builder::default()",
        "tauri_plugin_window_state::StateFlags::all()",
        "& !tauri_plugin_window_state::StateFlags::VISIBLE",
    ]:
        assert_contains(lib_rs, snippet, "src-tauri/src/lib.rs")

    assert lib_rs.index("tauri_plugin_window_state::Builder::default()") < lib_rs.index(
        ".manage(state)"
    )


def test_window_leader_commands_have_safe_single_instance_semantics() -> None:
    window_rs = read_repo_text("src-tauri/src/commands/window.rs")
    app = read_repo_text("src/App.tsx")
    socket_listener = read_repo_text("src/components/layout/SocketListener.tsx")

    for snippet in [
        "pub fn claim_leader(window: tauri::Window, state: State<'_, AppState>) -> bool",
        "state.window_registry.claim_leader(window.label())",
        "pub fn reveal_main_window(app: AppHandle) -> Result<(), String>",
        "app.run_on_main_thread(move ||",
        'app_handle.get_webview_window("main")',
        "let _ = window.show();",
        "ensure_window_bounds(&window);",
        "state.session_manager.kill_all();",
        "app.exit(0);",
        # Multi-window Phase 3a: child windows are built on the main thread
        # (same pattern as reveal_main_window) and boot hidden.
        "pub fn open_child_window(",
        "pub fn next_child_window_label(existing: &[String]) -> String",
        "tauri::WebviewWindowBuilder::new(",
        ".decorations(false)",
        ".visible(false)",
        ".min_inner_size(CHILD_WINDOW_MIN_WIDTH, CHILD_WINDOW_MIN_HEIGHT)",
    ]:
        assert_contains(window_rs, snippet, "src-tauri/src/commands/window.rs")

    for snippet in [
        "const gateCompletion = waitForStartupSessionGate(startupTimeoutMs);",
        "await revealMainWindow();",
        "setStartupMaskVisible(false);",
        "void gateCompletion.then((gateResult) => {",
    ]:
        assert_contains(app, snippet, "src/App.tsx")

    assert app.index("const gateCompletion = waitForStartupSessionGate(startupTimeoutMs);") < app.index(
        "await revealMainWindow();"
    ) < app.index("void gateCompletion.then((gateResult) => {")

    for snippet in [
        "claimLeader()",
        "isLeader.current = gotLeadership;",
        "if (!gotLeadership) {",
        "return loadPersistentData().then(async (envelope) => {",
        "await sync(true);",
        "await closeWindowWorkspacesAndDestroy();",
    ]:
        assert_contains(socket_listener, snippet, "src/components/layout/SocketListener.tsx")


def test_close_requested_blocks_quit_when_forced_workspace_save_fails() -> None:
    socket_listener = read_repo_text("src/components/layout/SocketListener.tsx")
    close_handler = socket_listener.split(
        "const unlistenCloseRequested =",
        1,
    )[1].split("    });", 1)[0]

    for snippet in [
        "const sync = async (force = false): Promise<boolean> => {",
        "return false;",
        "const promptAfterFinalSaveFailure = async (): Promise<\"retry\" | \"quit-anyway\"> => {",
        "okLabel: \"Retry\",",
        "cancelLabel: \"Quit anyway\",",
        "let shouldQuitAfterSave = false;",
        "const saved = await sync(true);",
        "if (saved) {",
        "choice = await promptAfterFinalSaveFailure();",
        "if (choice === \"quit-anyway\") {",
        "if (shouldQuitAfterSave) {",
        "await closeWindowWorkspacesAndDestroy();",
    ]:
        assert_contains(socket_listener, snippet, "src/components/layout/SocketListener.tsx")

    assert close_handler.index("const saved = await sync(true);") < close_handler.index("await closeWindowWorkspacesAndDestroy();")
    assert "finally {\n        await quitApp();\n      }" not in close_handler


def test_window_commands_never_take_a_webview_window_argument() -> None:
    """A web pane attaches a second webview (its own label) to the window that
    shows it, and from then on that window is no longer a `WebviewWindow`:
    Tauri rejects every command declared with a `tauri::WebviewWindow` argument
    with "current webview is not a WebviewWindow", and `get_webview_window`
    answers None for it. In practice a detached web pane window could neither
    be closed nor docked back (2026-09-14). Commands must take `tauri::Window`
    and look peers up with `get_window`.
    """
    import re

    # An attribute, optional `//` comment lines, then the fn signature.
    command_re = re.compile(
        r"#\[tauri::command[^\]]*\]\s*(?://[^\n]*\n\s*)*pub\s+(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)",
        re.S,
    )
    for relative in [
        "src-tauri/src/commands/window.rs",
        "src-tauri/src/commands/window_registry.rs",
        "src-tauri/src/commands/webpane.rs",
    ]:
        source = read_repo_text(relative)
        for name, params in command_re.findall(source):
            assert "WebviewWindow" not in params, (
                f"{relative}: command {name} takes a tauri::WebviewWindow argument; "
                "it fails once a web pane is attached to the calling window"
            )

    registry = read_repo_text("src-tauri/src/commands/window_registry.rs")
    start = registry.index("pub fn release_workspaces(")
    body = registry[start:registry.index("pub fn get_window_fragments", start)]
    assert "app.get_webview_window(" not in body, "release_workspaces must not refuse a receiver that hosts a web pane"
    assert "app.get_window(&to_label).is_none()" in body
