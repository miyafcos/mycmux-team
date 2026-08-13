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


def test_local_socket_requires_a_token_from_every_caller() -> None:
    socket_rs = read_repo_text("src-tauri/src/socket.rs")
    agent_cli = read_repo_text("scripts/mycmux_agent_cli.py")
    status_probe = read_repo_text("scripts/status_feed_probe.py")

    for snippet in [
        # Token is taken (and stripped) before anything dispatches the request.
        "let provided_token = take_request_token(&mut parsed);",
        "if !auth.authorize(provided_token.as_deref()) {",
        # A rejection is logged with the command name and whether a token was
        # present at all: the peer port is ephemeral and identifies nothing.
        "auth.note_rejection(",
        'parsed.get("cmd").and_then(Value::as_str),',
        "provided_token.is_some(),",
        'error: "unauthorized",',
        'const SOCKET_TOKEN_FILE: &str = "mycmux.token";',
        'const SOCKET_AUTH_ENV: &str = "MYCMUX_SOCKET_AUTH";',
        "crate::remote::auth::validate_token(provided, expected)",
    ]:
        assert_contains(socket_rs, snippet, "src-tauri/src/socket.rs")

    for snippet in [
        # Token discovery follows the active runtime dir so --profile
        # instances read their own token, never the production one.
        'return runtime_dir() / "mycmux.token"',
        'os.environ.get("MYCMUX_RUNTIME_DIR")',
        'payload["token"] = token',
    ]:
        assert_contains(agent_cli, snippet, "scripts/mycmux_agent_cli.py")

    for snippet in [
        'TOKEN_FILE_NAME = "mycmux.token"',
        'payload["token"] = token',
    ]:
        assert_contains(status_probe, snippet, "scripts/status_feed_probe.py")


def test_one_shot_tab_command_is_not_persisted() -> None:
    socket_listener = read_repo_text("src/components/layout/SocketListener.tsx")
    assert "command_argv" not in socket_listener

    to_config_start = socket_listener.index("export function toConfig(")
    to_config_end = socket_listener.index("\nlet _resolveLoaded", to_config_start)
    to_config = socket_listener[to_config_start:to_config_end]
    assert "commandArgv" not in to_config
