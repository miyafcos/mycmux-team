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
        'return invoke("claim_leader");',
        "export async function getWindowCount(): Promise<number>",
        'return invoke("get_window_count");',
        "export async function revealMainWindow(): Promise<void>",
        'return invoke("reveal_main_window");',
        "export async function quitApp(): Promise<void>",
        'return invoke("quit_app");',
    ]:
        assert_contains(ipc, snippet, "src/lib/ipc.ts")

    for command in [
        "commands::window::claim_leader",
        "commands::window::get_window_count",
        "commands::window::reveal_main_window",
        "commands::window::quit_app",
    ]:
        assert_contains(lib_rs, command, "src-tauri/src/lib.rs")


def test_window_leader_commands_have_safe_single_instance_semantics() -> None:
    window_rs = read_repo_text("src-tauri/src/commands/window.rs")
    app = read_repo_text("src/App.tsx")
    socket_listener = read_repo_text("src/components/layout/SocketListener.tsx")

    for snippet in [
        "pub fn claim_leader(state: State<'_, AppState>) -> bool",
        ".compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)",
        "pub fn get_window_count(app: AppHandle) -> usize",
        "app.webview_windows().len()",
        "pub fn reveal_main_window(app: AppHandle) -> Result<(), String>",
        "app.run_on_main_thread(move ||",
        'app_handle.get_webview_window("main")',
        "let _ = window.show();",
        "ensure_window_bounds(&window);",
        "state.session_manager.kill_all();",
        "app.exit(0);",
    ]:
        assert_contains(window_rs, snippet, "src-tauri/src/commands/window.rs")

    for snippet in [
        "const gateResult = await waitForStartupSessionGate(startupTimeoutMs);",
        "await revealMainWindow();",
        "setStartupMaskVisible(false);",
    ]:
        assert_contains(app, snippet, "src/App.tsx")

    for snippet in [
        "claimLeader()",
        "isLeader.current = gotLeadership;",
        "if (!gotLeadership) {",
        "return loadPersistentData().then(async (data) => {",
        "await sync(true);",
        "await quitApp();",
    ]:
        assert_contains(socket_listener, snippet, "src/components/layout/SocketListener.tsx")

