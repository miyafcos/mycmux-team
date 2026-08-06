from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_repo_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def assert_contains(text: str, snippet: str, source: str) -> None:
    assert snippet in text, f"Missing snippet in {source}: {snippet}"


def test_socket_api_has_frontend_response_bridge() -> None:
    socket_listener = read_repo_text("src/components/layout/SocketListener.tsx")
    socket_commands = read_repo_text("src/components/layout/socketCommands.ts")
    ipc = read_repo_text("src/lib/ipc.ts")
    socket_rs = read_repo_text("src-tauri/src/socket.rs")

    for snippet in [
        'listen<SocketRequestPayload>("socket-request"',
        "handleSocketCommand(cmd, args)",
        "await sendSocketResponse(id, result, null);",
        "await sendSocketResponse(id, null, message);",
        'case "workspace.list":',
        'case "pane.list":',
        "Unknown socket command",
    ]:
        assert_contains(socket_listener, snippet, "src/components/layout/SocketListener.tsx")

    assert_contains(ipc, 'return invoke<void>("socket_response", { id, result, error } satisfies SocketResponseArgs);', "src/lib/ipc.ts")
    assert_contains(socket_rs, 'app.emit("socket-request", &req)', "src-tauri/src/socket.rs")
    assert_contains(socket_rs, 'state.pending_requests.remove(&id);', "src-tauri/src/socket.rs")
    assert_contains(socket_rs, 'if cmd == "session.state_view"', "src-tauri/src/socket.rs")
    assert_contains(socket_rs, ".session_state_store", "src-tauri/src/socket.rs")
    assert_contains(socket_rs, ".snapshot(session_id.as_deref())", "src-tauri/src/socket.rs")

    for snippet in [
        'case "pane.spawn":',
        'case "pane.spawn_tab":',
        'case "pane.activate_tab":',
        'case "pane.restore_activation":',
        'case "pane.close_tab":',
        'case "pane.rename_tab":',
        'case "pane.move":',
    ]:
        assert_contains(socket_commands, snippet, "src/components/layout/socketCommands.ts")


def test_one_shot_tab_command_is_not_persisted() -> None:
    socket_listener = read_repo_text("src/components/layout/SocketListener.tsx")
    assert "command_argv" not in socket_listener

    to_config_start = socket_listener.index("export function toConfig(")
    to_config_end = socket_listener.index("\nlet _resolveLoaded", to_config_start)
    to_config = socket_listener[to_config_start:to_config_end]
    assert "commandArgv" not in to_config
